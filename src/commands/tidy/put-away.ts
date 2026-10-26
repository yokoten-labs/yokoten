// `yokoten tidy --local` and `--empty` (issue #1055): save, then move aside, then delete late.
// Deleting is the danger, so each step has a way back:
//
// 1. Save: a git bundle of each branch (a desk: of all its refs), and a patch of the changes
//    not committed, untracked files too. The patch is made with a copy of the index, so the
//    checkout's own index is never written. Every bundle is verified. One failure stops it all.
// 2. Move: only when every save worked. Each folder is renamed into
//    `<state>/trash/<UTC time>/items/`; across drives it is copied, checked, then removed.
//    A branch is a ref, not a folder: its ref is removed only if it still points where it
//    did, and its bundle brings it back. index.json says where each thing came from and how
//    to bring it back.
// 3. Delete: `--empty` removes a trash folder only when its index.json is over 7 days old.

import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import type { Env } from '../../rules/config.ts';
import { DESK_LIST_FILE } from '../../run/hook.ts';
import { folderSize, isInside, readGit, type TidyItem } from './find.ts';

/** Trash older than this is what `--empty` deletes. */
export const TRASH_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** Git's empty tree: the base of a patch in a checkout with no commit yet. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const WRITE_TIMEOUT_MS = 120_000;

/** One thing in a trash folder's index.json. */
export interface TrashEntry {
  kind: TidyItem['kind'];
  name: string;
  /** Where it was. */
  from: string;
  why: string;
  branch: string;
  head: string;
  /** The saved copies, relative to the trash folder; '' when there is none. */
  bundle: string;
  patch: string;
  /** Each folder moved, from where to where (relative to the trash folder). */
  moves: { from: string; to: string }[];
  /** How to bring it back, as commands or steps. */
  restore: string[];
  isMoved: boolean;
}

export interface TrashIndex {
  version: 1;
  /** When it was put away, UTC. `--empty` counts the 7 days from here. */
  created: string;
  repo: string;
  items: TrashEntry[];
}

/** The trash folder's name for `now`: `2026-10-26T101500Z`, UTC, sorted by time. */
export const trashStamp = (now: number): string => new Date(now).toISOString().replace(/[:-]/g, '').replace(/^(\d{4})(\d{2})(\d{2})/, '$1-$2-$3').replace(/\.\d+Z$/, 'Z');

/** A name safe for a file on every system, and short, so a long path stays short in the trash. */
export const safeName = (name: string): string => name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 40) || 'item';

/**
 * A path Windows reads past 260 characters: `\\?\C:\...` or `\\?\UNC\server\share\...`.
 * Other systems, and short or prefixed paths, stay as they are.
 */
export function longPath(path: string, platform: NodeJS.Platform): string {
  if (platform !== 'win32' || path.length < 248 || path.startsWith('\\\\?\\')) return path;
  if (path.startsWith('\\\\')) return `\\\\?\\UNC\\${path.slice(2)}`;
  return `\\\\?\\${path}`;
}

/** Git, or a thrown error with git's first line of stderr. */
function runGit(cwd: string, args: string[], env: Env, extra: Env = {}): string {
  try {
    return execFileSync('git', args, { cwd, env: { ...env, ...extra }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: WRITE_TIMEOUT_MS, maxBuffer: 512 * 1024 * 1024 });
  } catch (err) {
    const said = String((err as { stderr?: unknown }).stderr ?? '').trim().split('\n')[0] || (err as Error).message.split('\n')[0];
    throw new Error(`git ${args[0]} failed: ${said}`);
  }
}

/** A new, empty trash folder for this run, `<trash>/<stamp>`. Refuses a trash that is a link. */
export function makeTrashFolder(trash: string, now: number): string {
  mkdirSync(trash, { recursive: true });
  if (!lstatSync(trash).isDirectory()) throw new Error(`${trash} is a link or not a folder`);
  const stamp = trashStamp(now);
  for (let n = 1; ; n++) {
    const folder = join(trash, n === 1 ? stamp : `${stamp}-${n}`);
    try {
      mkdirSync(folder);
      return folder;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || n > 99) throw err;
    }
  }
}

/** A bundle of `refs` from `repo` at `file`, verified. */
function saveBundle(repo: string, file: string, refs: string[], env: Env): void {
  runGit(repo, ['bundle', 'create', file, ...refs], env);
  runGit(repo, ['bundle', 'verify', '-q', file], env);
}

/** The changes in the checkout at `folder` against HEAD, untracked files too, as a binary patch; '' when none. */
function savePatch(folder: string, gitIndex: string, file: string, head: string, env: Env): boolean {
  const copy = `${file}.index`;
  if (existsSync(gitIndex)) copyFileSync(gitIndex, copy);
  try {
    runGit(folder, ['add', '-A'], env, { GIT_INDEX_FILE: copy });
    const patch = runGit(folder, ['diff', '--cached', '--binary', head || EMPTY_TREE], env, { GIT_INDEX_FILE: copy });
    if (!patch) return false;
    writeFileSync(file, patch, { flag: 'wx' });
    return true;
  } finally {
    rmSync(copy, { force: true });
  }
}

/**
 * Save every item into `<folder>/archive/`, before anything moves. Returns the entries for
 * index.json, or the item that failed and why. A failure leaves only the trash folder.
 */
export function archiveItems(items: TidyItem[], folder: string, env: Env): { entries: TrashEntry[] } | { failed: TidyItem; error: string } {
  const entries: TrashEntry[] = [];
  for (const [index, item] of items.entries()) {
    const slug = `${String(index + 1).padStart(2, '0')}-${safeName(item.name)}`;
    const saved = join(folder, 'archive', slug);
    const entry: TrashEntry = { kind: item.kind, name: item.name, from: item.path, why: item.judged.why, branch: item.branch, head: item.head, bundle: '', patch: '', moves: [], restore: [], isMoved: false };
    try {
      mkdirSync(saved, { recursive: true });
      const bundle = join(saved, 'branch.bundle');
      if (item.kind === 'branch') {
        saveBundle(item.path, bundle, [`refs/heads/${item.branch}`], env);
        entry.restore.push(`git fetch <trash>/${relative(folder, bundle)} ${item.branch}:${item.branch}`);
      } else if ((item.kind === 'worktree' && !item.facts.isGone) || item.kind === 'desk') {
        if (item.head) saveBundle(item.path, bundle, item.kind === 'desk' ? ['--all'] : [item.branch ? `refs/heads/${item.branch}` : 'HEAD'], env);
        const patch = join(saved, 'changes.patch');
        const gitIndex = resolve(item.path, runGit(item.path, ['rev-parse', '--git-path', 'index'], env).trim());
        if (savePatch(item.path, gitIndex, patch, item.head, env)) entry.patch = relative(folder, patch);
      }
      if (existsSync(bundle)) entry.bundle = relative(folder, bundle);
    } catch (err) {
      return { failed: item, error: (err as Error).message.split('\n')[0] ?? 'the save failed' };
    }
    entries.push(entry);
  }
  return { entries };
}

/** File count and bytes of a tree, links not followed: the check after a copy. */
function treeShape(path: string): string {
  let files = 0;
  let bytes = 0;
  const stack = [path];
  while (stack.length) {
    const current = stack.pop() as string;
    const entry = lstatSync(current);
    files++;
    if (entry.isDirectory()) for (const name of readdirSync(current)) stack.push(join(current, name));
    else if (!entry.isSymbolicLink()) bytes += entry.size;
  }
  return `${files}/${bytes}`;
}

/**
 * Move a folder: a rename, or across drives (EXDEV) a copy, a check that the copy has the
 * same files and bytes, then the removal of the old one. `rename` is the system's, or a test's.
 */
export function moveFolder(from: string, to: string, platform: NodeJS.Platform, rename: (from: string, to: string) => void = renameSync): void {
  const source = longPath(from, platform);
  const target = longPath(to, platform);
  mkdirSync(dirname(target), { recursive: true });
  if (existsSync(target)) throw new Error(`${to} is there already`);
  try {
    rename(source, target);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
  }
  cpSync(source, target, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false, preserveTimestamps: true });
  if (treeShape(source) !== treeShape(target)) {
    rmSync(target, { recursive: true, force: true });
    throw new Error(`the copy of ${from} did not match, so it stays where it is`);
  }
  rmSync(source, { recursive: true });
}

/** Take a desk off the list in the repo's git folder, so the board stops showing it. */
function unlistDesk(root: string, desk: string, env: Env): void {
  const common = readGit(root, ['rev-parse', '--git-common-dir'], env)?.trim();
  if (!common) return;
  const list = join(resolve(root, common), DESK_LIST_FILE);
  let text: string;
  try {
    text = readFileSync(list, 'utf8');
  } catch {
    return;
  }
  const kept = text.split('\n').filter((line) => line.trim() && resolve(line.trim()) !== resolve(desk));
  writeFileSync(list, kept.length ? `${kept.join('\n')}\n` : '');
}

/** Move one saved item into `<folder>/items/<slug>/`. Fills `entry.moves` as it goes. */
export function moveItem(item: TidyItem, entry: TrashEntry, slug: string, folder: string, root: string, env: Env, platform: NodeJS.Platform): void {
  const place = join(folder, 'items', slug);
  const move = (from: string, name: string) => {
    if (!from || !existsSync(from)) return;
    const to = join(place, name);
    moveFolder(from, to, platform);
    entry.moves.push({ from, to: relative(folder, to) });
    entry.restore.push(`move <trash>/${relative(folder, to)} back to ${from}`);
  };
  if (item.kind === 'branch') runGit(root, ['update-ref', '-d', `refs/heads/${item.branch}`, item.head], env);
  else if (item.kind === 'worktree') {
    move(item.path, 'tree');
    move(item.adminDir, 'admin');
  } else if (item.kind === 'desk') {
    move(item.path, 'desk');
    move(item.stateDir, 'desk.state');
    unlistDesk(root, item.path, env);
  } else move(item.path, 'log');
  if (entry.patch) entry.restore.push(`git apply --index <trash>/${entry.patch}, in the checkout brought back`);
  entry.isMoved = true;
}

/** Write index.json in the trash folder. */
export function writeTrashIndex(folder: string, index: TrashIndex): void {
  writeFileSync(join(folder, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
}

/** One folder in the trash, from its index.json. */
export interface TrashFolder {
  path: string;
  created: number;
  size: number;
  isOld: boolean;
}

/**
 * The folders in the trash that tidy made: real folders (no links) whose index.json has a
 * `created` time. A folder with no readable index is never counted, so never deleted.
 */
export function readTrash(trash: string, now: number): TrashFolder[] {
  try {
    if (!lstatSync(trash).isDirectory()) return [];
  } catch {
    return [];
  }
  const found: TrashFolder[] = [];
  for (const name of readdirSync(trash).sort()) {
    const path = join(trash, name);
    try {
      if (!lstatSync(path).isDirectory()) continue;
      const index = JSON.parse(readFileSync(join(path, 'index.json'), 'utf8')) as Partial<TrashIndex>;
      const created = Date.parse(String(index.created));
      if (Number.isNaN(created)) continue;
      found.push({ path, created, size: folderSize(path), isOld: now - created > TRASH_KEEP_MS });
    } catch {
      // Not a folder tidy made: left alone.
    }
  }
  return found;
}

/** Delete trash folders, each checked again: a real folder, directly inside the trash. */
export function deleteTrash(trash: string, folders: TrashFolder[], platform: NodeJS.Platform): string[] {
  const deleted: string[] = [];
  for (const folder of folders) {
    if (!folder.isOld || dirname(folder.path) !== trash || !isInside(folder.path, trash)) continue;
    if (!lstatSync(folder.path).isDirectory()) continue;
    rmSync(longPath(folder.path, platform), { recursive: true });
    deleted.push(folder.path);
  }
  return deleted;
}
