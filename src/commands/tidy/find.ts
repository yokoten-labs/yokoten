// `yokoten tidy` reads what is on this machine (issue #1055): the local branches, the linked
// worktrees, the desk clones and the logs of gone desks, with the facts stale.ts judges.
// It only reads. Git runs with GIT_OPTIONAL_LOCKS=0, so `git status` does not even refresh
// the index: a bare `tidy` leaves every file byte for byte as it was. GitHub is not asked;
// the remote branches git already knows are only listed.

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathsFor } from '../../platform/paths.ts';
import type { Env } from '../../rules/config.ts';
import { homeIn } from '../../rules/privacy.ts';
import { AGENT_STATUS_FILE, DESK_FILE, DESK_LIST_FILE } from '../../run/hook.ts';
import { judgeStale, type StaleFacts, type StaleJudgment, type StaleKind } from './stale.ts';

/** One thing tidy found, with its facts and its judgment. */
export interface TidyItem {
  kind: StaleKind;
  /** The branch name, or the folder's name. */
  name: string;
  /** The folder, or for a branch the repo root. */
  path: string;
  /** The branch it holds, or ''. */
  branch: string;
  /** The commit it points at, or ''. */
  head: string;
  /** A worktree's own folder in the git folder, `.git/worktrees/<name>`, or ''. */
  adminDir: string;
  /** A desk's state folder, `<desk>.state`, when there is one, or ''. */
  stateDir: string;
  /** Bytes on disk; for a branch, 0. */
  size: number;
  /** For a branch: its commits not in the main branch. */
  commits: number;
  facts: StaleFacts;
  judged: StaleJudgment;
}

/** A branch on the remote that is merged: tidy names it and never deletes it. */
export interface RemoteBranch {
  name: string;
  why: string;
}

export interface TidyScan {
  root: string;
  /** The main branch as git names it (`origin/main`, `main`), or '' when there is none. */
  base: string;
  items: TidyItem[];
  remote: RemoteBranch[];
}

const READ_TIMEOUT_MS = 30_000;
/** A folder's size stops counting here, so a huge tree can't hang the screen. */
const SIZE_ENTRY_LIMIT = 200_000;

/** Git's output, or null when it fails. Read-only: optional locks are off. */
export function readGit(cwd: string, args: string[], env: Env): string | null {
  try {
    return execFileSync('git', args, { cwd, env: { ...env, GIT_OPTIONAL_LOCKS: '0' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: READ_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
}

/** Yokoten's own state folder for tidy: XDG_STATE_HOME or ~/.local/state, or %LOCALAPPDATA% on Windows. */
export function tidyStateDir(env: Env, platform: NodeJS.Platform): string {
  // The system's own path rules, so Linux CI tests the Windows case (record 0040). A relative
  // value is ignored: it would land in the folder the command runs in.
  const paths = pathsFor(platform);
  const [name, fallback] = platform === 'win32' ? [env.LOCALAPPDATA, ['AppData', 'Local']] : [env.XDG_STATE_HOME, ['.local', 'state']];
  return paths.join(name && paths.isAbsolute(name) ? name : paths.join(homeIn(env), ...fallback), 'yokoten');
}

/** Whether `path` is `folder` or inside it. */
export function isInside(path: string, folder: string): boolean {
  const way = relative(folder, path);
  return way === '' || (!way.startsWith('..') && !isAbsolute(way));
}

/** The real path, or the path as it is when it can't be read. */
const realOrSame = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

/** The working folder of every process this user can see (Linux /proc); empty elsewhere. */
export function readProcessFolders(platform: NodeJS.Platform): string[] {
  if (platform !== 'linux') return [];
  const folders: string[] = [];
  let pids: string[] = [];
  try {
    pids = readdirSync('/proc').filter((name) => /^\d+$/.test(name));
  } catch {
    return [];
  }
  for (const pid of pids) {
    try {
      folders.push(readlinkSync(`/proc/${pid}/cwd`));
    } catch {
      // Another user's process, or one that just ended.
    }
  }
  return folders;
}

/**
 * Bytes of the files in a folder, links not followed, up to SIZE_ENTRY_LIMIT entries; 0 when it
 * can't be read. Folders themselves count 0: their size differs by file system (4 KB on ext4).
 */
export function folderSize(path: string): number {
  let total = 0;
  let seen = 0;
  const stack = [path];
  while (stack.length && seen < SIZE_ENTRY_LIMIT) {
    const current = stack.pop() as string;
    let entry;
    try {
      entry = lstatSync(current);
    } catch {
      continue;
    }
    seen++;
    if (!entry.isDirectory()) {
      if (entry.isFile()) total += entry.size;
      continue;
    }
    try {
      for (const name of readdirSync(current)) stack.push(join(current, name));
    } catch {
      // A folder it can't read counts as empty.
    }
  }
  return total;
}

/** The newest change time among `paths`, and inside `deep` up to three levels down; null when none exists. */
function lastWriteOf(paths: string[], deep: string[] = []): number | null {
  let newest: number | null = null;
  const note = (path: string) => {
    try {
      const time = lstatSync(path).mtimeMs;
      if (newest === null || time > newest) newest = time;
    } catch {
      // Not there: no write to count.
    }
  };
  paths.forEach(note);
  const walk = (folder: string, depth: number) => {
    note(folder);
    if (depth === 0) return;
    try {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(folder, entry.name), depth - 1);
        else note(join(folder, entry.name));
      }
    } catch {
      // Not a folder it can read.
    }
  };
  deep.forEach((folder) => walk(folder, 3));
  return newest;
}

/** The main branch: the remote's HEAD, else a local main or master. */
function findBase(root: string, env: Env): string {
  const remoteHead = readGit(root, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'], env)?.trim();
  if (remoteHead) return remoteHead;
  for (const name of ['main', 'master']) if (readGit(root, ['rev-parse', '-q', '--verify', `refs/heads/${name}`], env) !== null) return name;
  return '';
}

/** Whether `commit` is in `base`, asked in `repo`. */
const isInBase = (repo: string, commit: string, base: string, env: Env): boolean => base !== '' && commit !== '' && readGit(repo, ['merge-base', '--is-ancestor', commit, base], env) !== null;

/** Commits of `commit` on no remote and not in `base`. */
function countUnpushed(repo: string, commit: string, base: string, env: Env): number {
  if (!commit) return 0;
  const text = readGit(repo, ['rev-list', '--count', commit, '--not', '--remotes', ...(base ? [base] : [])], env);
  return text === null ? 0 : Number(text.trim()) || 0;
}

/** Whether a checkout has changes not committed or files not tracked. Unknown counts as dirty. */
const isCheckoutDirty = (folder: string, env: Env): boolean => {
  const text = readGit(folder, ['status', '--porcelain', '--untracked-files=normal'], env);
  return text === null || text.trim() !== '';
};

/** A git folder holds a lock: git is working in it. */
const hasGitLock = (gitDir: string): boolean => ['index.lock', 'HEAD.lock'].some((name) => existsSync(join(gitDir, name)));

interface LocalBranch {
  name: string;
  head: string;
  isGone: boolean;
}

function readBranches(root: string, env: Env): LocalBranch[] {
  const text = readGit(root, ['for-each-ref', '--format=%(refname:short)%00%(objectname)%00%(upstream:track)', 'refs/heads'], env) ?? '';
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name = '', head = '', track = ''] = line.split('\0');
      return { name, head, isGone: track === '[gone]' };
    });
}

interface WorktreeRecord {
  path: string;
  head: string;
  branch: string;
  isLocked: boolean;
}

function readWorktrees(root: string, env: Env): WorktreeRecord[] {
  const text = readGit(root, ['worktree', 'list', '--porcelain', '-z'], env) ?? '';
  return text
    .split('\0\0')
    .map((record) => record.split('\0'))
    .filter((fields) => fields.some((field) => field.startsWith('worktree ')))
    .map((fields) => {
      const value = (key: string) => fields.find((field) => field.startsWith(`${key} `))?.slice(key.length + 1) ?? '';
      return { path: value('worktree'), head: value('HEAD'), branch: value('branch').replace(/^refs\/heads\//, ''), isLocked: fields.some((field) => field === 'locked' || field.startsWith('locked ')) };
    });
}

/** `.git/worktrees/<name>` for each worktree path, read from each folder's `gitdir` file. */
function readAdminDirs(common: string): Map<string, string> {
  const admins = new Map<string, string>();
  const folder = join(common, 'worktrees');
  let names: string[] = [];
  try {
    names = readdirSync(folder);
  } catch {
    return admins;
  }
  for (const name of names) {
    try {
      const gitFile = readFileSync(join(folder, name, 'gitdir'), 'utf8').trim();
      admins.set(realOrSame(dirname(resolve(join(folder, name), gitFile))), join(folder, name));
    } catch {
      // Not a worktree folder git made.
    }
  }
  return admins;
}

/** The desk clones of this repo: on the list in its git folder, and in `../<repo>-desks/`. */
function readDeskPaths(root: string, common: string): string[] {
  const paths: string[] = [];
  try {
    paths.push(...readFileSync(join(common, DESK_LIST_FILE), 'utf8').split('\n').map((line) => line.trim()).filter(Boolean));
  } catch {
    // No desk was ever listed.
  }
  const desks = join(dirname(root), `${basename(root)}-desks`);
  try {
    for (const name of readdirSync(desks)) if (!name.endsWith('.state')) paths.push(join(desks, name));
  } catch {
    // No desks folder.
  }
  return [...new Set(paths.map((path) => resolve(path)))].filter((path) => existsSync(join(path, '.git', DESK_FILE)) || !existsSync(path));
}

interface Context {
  root: string;
  cwd: string;
  env: Env;
  now: number;
  base: string;
  processFolders: string[];
}

const make = (kind: StaleKind, fields: Partial<TidyItem> & { name: string; path: string }, facts: Omit<StaleFacts, 'kind'>, now: number): TidyItem => {
  const all: StaleFacts = { kind, ...facts };
  return { branch: '', head: '', adminDir: '', stateDir: '', size: 0, commits: 0, ...fields, kind, facts: all, judged: judgeStale(all, now) };
};

const hasProcessIn = (context: Context, folder: string): boolean => {
  const real = realOrSame(folder);
  return context.processFolders.some((path) => isInside(path, real));
};

function branchItems(context: Context, branches: LocalBranch[], checkedOut: Set<string>, common: string): TidyItem[] {
  const { root, env, base, now } = context;
  const localBase = base.replace(/^origin\//, '');
  return branches
    .filter((branch) => branch.name !== localBase && !checkedOut.has(branch.name))
    .map((branch) => {
      const commitsText = base ? readGit(root, ['rev-list', '--count', `${base}..${branch.head}`], env) : null;
      return make('branch', { name: branch.name, path: root, branch: branch.name, head: branch.head, commits: Number(commitsText?.trim()) || 0 }, {
        isHere: false, hasProcess: false, isLocked: existsSync(join(common, 'refs', 'heads', `${branch.name}.lock`)), lastWrite: lastWriteOf([join(common, 'logs', 'refs', 'heads', ...branch.name.split('/'))]), isMerged: isInBase(root, branch.head, base, env), isUpstreamGone: branch.isGone, isGone: false, unpushed: countUnpushed(root, branch.head, base, env), isDirty: false,
      }, now);
    });
}

function worktreeItems(context: Context, trees: WorktreeRecord[], branches: LocalBranch[], common: string): TidyItem[] {
  const { root, cwd, env, base, now } = context;
  const admins = readAdminDirs(common);
  const gone = new Set(branches.filter((branch) => branch.isGone).map((branch) => branch.name));
  return trees.slice(1).map((tree) => {
    const isMissing = !existsSync(tree.path);
    const adminDir = admins.get(realOrSame(tree.path)) ?? admins.get(resolve(tree.path)) ?? '';
    const isHere = !isMissing && isInside(realOrSame(cwd), realOrSame(tree.path));
    return make('worktree', { name: basename(tree.path), path: tree.path, branch: tree.branch, head: tree.head, adminDir, size: isMissing ? 0 : folderSize(tree.path) }, {
      isHere,
      hasProcess: !isMissing && hasProcessIn(context, tree.path),
      isLocked: tree.isLocked || (adminDir !== '' && hasGitLock(adminDir)),
      lastWrite: lastWriteOf([join(tree.path, AGENT_STATUS_FILE), ...(adminDir ? [join(adminDir, 'index'), join(adminDir, 'HEAD'), join(adminDir, 'logs', 'HEAD')] : [])]),
      isMerged: isInBase(root, tree.head, base, env),
      isUpstreamGone: tree.branch !== '' && gone.has(tree.branch),
      isGone: isMissing,
      unpushed: isMissing ? 0 : countUnpushed(root, tree.head, base, env),
      isDirty: !isMissing && isCheckoutDirty(tree.path, env),
    }, now);
  });
}

function deskItems(context: Context, deskPaths: string[]): TidyItem[] {
  const { root, cwd, env, base, now } = context;
  return deskPaths
    .filter((desk) => existsSync(desk))
    .map((desk) => {
      const head = readGit(desk, ['rev-parse', '-q', '--verify', 'HEAD'], env)?.trim() ?? '';
      const branch = readGit(desk, ['symbolic-ref', '-q', '--short', 'HEAD'], env)?.trim() ?? '';
      const track = branch ? readGit(desk, ['for-each-ref', '--format=%(upstream:track)', `refs/heads/${branch}`], env)?.trim() : '';
      const stateDir = existsSync(`${desk}.state`) ? `${desk}.state` : '';
      const isMerged = isInBase(root, head, base, env);
      return make('desk', { name: basename(desk), path: desk, branch, head, stateDir, size: folderSize(desk) + (stateDir ? folderSize(stateDir) : 0) }, {
        isHere: isInside(realOrSame(cwd), realOrSame(desk)),
        hasProcess: hasProcessIn(context, desk) || (stateDir !== '' && hasProcessIn(context, stateDir)),
        isLocked: hasGitLock(join(desk, '.git')),
        lastWrite: lastWriteOf([join(desk, AGENT_STATUS_FILE), join(desk, '.git', 'index'), join(desk, '.git', 'HEAD'), join(desk, '.git', 'logs', 'HEAD')], stateDir ? [stateDir] : []),
        isMerged,
        isUpstreamGone: track === '[gone]',
        isGone: false,
        unpushed: isMerged ? 0 : countUnpushed(desk, head, '', env),
        isDirty: isCheckoutDirty(desk, env),
      }, now);
    });
}

/** `<desk>.state` folders whose desk is gone, beside every desk tidy knows. */
function logItems(context: Context, deskPaths: string[]): TidyItem[] {
  const folders = new Set(deskPaths.map((desk) => dirname(desk)));
  const found: TidyItem[] = [];
  for (const folder of folders) {
    let names: string[] = [];
    try {
      names = readdirSync(folder);
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(folder, name);
      if (!name.endsWith('.state') || existsSync(path.slice(0, -'.state'.length))) continue;
      try {
        if (!lstatSync(path).isDirectory()) continue;
      } catch {
        continue;
      }
      found.push(make('log', { name, path, size: folderSize(path) }, {
        isHere: isInside(realOrSame(context.cwd), realOrSame(path)), hasProcess: hasProcessIn(context, path), isLocked: false, lastWrite: lastWriteOf([], [path]), isMerged: false, isUpstreamGone: false, isGone: true, unpushed: 0, isDirty: false,
      }, context.now));
    }
  }
  return found;
}

/** Remote branches git knows that are merged into the main branch: listed only. */
function remoteItems(root: string, base: string, env: Env): RemoteBranch[] {
  if (!base) return [];
  const text = readGit(root, ['for-each-ref', '--merged', base, '--format=%(refname:short)', 'refs/remotes'], env) ?? '';
  return text
    .split('\n')
    .filter((name) => name && name !== base && !name.endsWith('/HEAD') && name.includes('/'))
    .map((name) => ({ name, why: `merged into ${base}; delete it on the remote if you want` }));
}

/** Everything tidy can put away in the repo at `root`, judged at `now`. Reads only. */
export function scanTidy({ root, cwd, env, platform, now }: { root: string; cwd: string; env: Env; platform: NodeJS.Platform; now: number }): TidyScan {
  const commonText = readGit(root, ['rev-parse', '--git-common-dir'], env)?.trim() ?? '.git';
  const common = resolve(root, commonText);
  const base = findBase(root, env);
  const context: Context = { root, cwd, env, now, base, processFolders: readProcessFolders(platform) };
  const branches = readBranches(root, env);
  const trees = readWorktrees(root, env);
  const checkedOut = new Set(trees.map((tree) => tree.branch).filter(Boolean));
  const deskPaths = readDeskPaths(root, common);
  const items = [...branchItems(context, branches, checkedOut, common), ...worktreeItems(context, trees, branches, common), ...deskItems(context, deskPaths), ...logItems(context, deskPaths)];
  return { root, base, items, remote: remoteItems(root, base, env) };
}

/** The scan's size of what can be put away, in bytes. */
export const sizeOf = (items: TidyItem[]): number => items.reduce((sum, item) => sum + item.size, 0);
