// `yokoten tidy` (record 0043, issue #1055): one of the three commands up front. Alone it
// lists what is old, grouped by what the person can do, and writes nothing. `--local` saves
// each old thing, then moves it into the trash (put-away.ts). `--empty` deletes trash over
// 7 days old, after one question. Branches on the remote are only listed: tidy never
// deletes on GitHub.

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { askLine, count, fail, type Invocation, moreLine, nextLine, parse, print, printJson, requireRoot, row, say, screen, spaced, terminalOf, title, usage } from '../shared.ts';
import { section } from '../../rules/text/screen.ts';
import { scanTidy, sizeOf, tidyStateDir, type TidyItem, type TidyScan } from './find.ts';
import { archiveItems, deleteTrash, makeTrashFolder, moveItem, readTrash, safeName, type TrashFolder, type TrashIndex, writeTrashIndex } from './put-away.ts';

/** Bytes as a person reads them: `0 B`, `12 KB`, `3.4 MB`. */
export function formatSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 || value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

const isToPutAway = (item: TidyItem): boolean => item.judged.verdict === 'old' || item.judged.verdict === 'keep-first';

/** The short word in an item's label column: what kind of thing it is. */
const kindWord = (item: TidyItem): string => (item.kind === 'log' ? 'logs' : item.kind);

/** What one row says about an item: its name and place, why, and its size. A long name wraps in the text, not the label. */
function itemText(item: TidyItem): string {
  const size = item.kind === 'branch' ? (item.commits ? `${count(item.commits, 'commit')} not in the main branch` : 'no commit of its own') : formatSize(item.size);
  const place = item.kind === 'branch' ? item.name : `${item.name} at ${item.path}`;
  return `${place}: ${item.judged.why}; ${size}.`;
}

const rows = (items: TidyItem[], mark: Parameters<typeof row>[0]): string[] => spaced(items.map((item) => row(mark, itemText(item), kindWord(item))));

/** The trash part of a screen: what is there, and what `--empty` would delete. */
function trashBlock(trash: TrashFolder[]): string[] {
  if (!trash.length) return [];
  const old = trash.filter((folder) => folder.isOld);
  return section('Trash', spaced([
    row('ok', `${count(trash.length, 'folder')}, ${formatSize(trash.reduce((sum, folder) => sum + folder.size, 0))}. Each stays 7 days.`, 'trash'),
    ...(old.length ? [row('note', `${count(old.length, 'folder')} over 7 days old, ${formatSize(old.reduce((sum, folder) => sum + folder.size, 0))}: \`yokoten tidy --empty\` deletes them.`, 'old trash')] : []),
  ]));
}

/** Bare `yokoten tidy`: the list, in groups by what the person can do. A pure function of the scan and the trash. */
export function listScreen(scan: TidyScan, trash: TrashFolder[]): string[] {
  const old = scan.items.filter((item) => item.judged.verdict === 'old');
  const first = scan.items.filter((item) => item.judged.verdict === 'keep-first');
  const inUse = scan.items.filter((item) => item.judged.verdict === 'in-use');
  const kept = scan.items.filter((item) => item.judged.verdict === 'keep');
  const ready = old.length + first.length;
  const size = sizeOf([...old, ...first]);
  return screen(
    title('tidy', ready ? `${ready} to put away${size ? `, ${formatSize(size)}` : ''}; nothing was changed` : 'nothing to put away; nothing was changed'),
    section('Can put away', rows(old, 'next')),
    section('Can put away with a saved copy', rows(first, 'note')),
    section('In use, never touched', rows(inUse, 'skipped')),
    section('On the remote, only listed', spaced(scan.remote.map((branch) => row('skipped', `${branch.name}: ${branch.why}.`, 'branch')))),
    trashBlock(trash),
    kept.length ? row('ok', `${count(kept.length, 'more thing')} still in work: tidy leaves them.`, 'in work') : [],
    ready ? moreLine('`--local` saves each one (a bundle and a patch), then moves it into the trash.') : [],
    ready ? nextLine('yokoten tidy --local') : [],
  );
}

/** Whether an item still reads as it did when it was saved: same verdict, same commit, same changes. */
function isUnchanged(before: TidyItem, fresh: TidyScan): boolean {
  const now = fresh.items.find((item) => item.kind === before.kind && item.path === before.path && item.branch === before.branch);
  return now !== undefined && isToPutAway(now) && now.head === before.head && now.facts.isDirty === before.facts.isDirty && now.facts.unpushed === before.facts.unpushed;
}

/** `yokoten tidy --local`: save everything first; when a save fails, move nothing. */
function putAway(invocation: Invocation, root: string, trash: string, platform: NodeJS.Platform): number {
  const { env, cwd } = invocation;
  const now = Date.now();
  const targets = scanTidy({ root, cwd, env, platform, now }).items.filter(isToPutAway);
  if (!targets.length) {
    print(invocation, tidyScreen({ kind: 'local', folder: null, moves: [] }));
    return 0;
  }
  let folder: string;
  try {
    folder = makeTrashFolder(trash, now);
  } catch (err) {
    return fail(invocation, `the trash folder can't be made, so nothing was moved: ${(err as Error).message.split('\n')[0]}`, 'check that folder, then run `yokoten tidy --local` again');
  }
  const saved = archiveItems(targets, folder, env);
  if ('failed' in saved) {
    rmSync(folder, { recursive: true, force: true });
    return fail(invocation, `saving ${saved.failed.name} failed, so nothing was moved: ${saved.error}`, 'yokoten tidy');
  }
  const index: TrashIndex = { version: 1, created: new Date(now).toISOString(), repo: root, items: saved.entries };
  try {
    writeTrashIndex(folder, index);
  } catch (err) {
    rmSync(folder, { recursive: true, force: true });
    return fail(invocation, `index.json can't be written, so nothing was moved: ${(err as Error).message.split('\n')[0]}`, 'check the trash folder, then run `yokoten tidy --local` again');
  }
  // A thing may have changed while it was saved: an agent started, or committed. It stays.
  const fresh = scanTidy({ root, cwd, env, platform, now: Date.now() });
  const moves: TidyMove[] = [];
  let problem = '';
  for (const [position, item] of targets.entries()) {
    const entry = saved.entries[position];
    if (problem || !isUnchanged(item, fresh)) {
      moves.push({ item, outcome: problem ? 'after-failure' : 'changed' });
      continue;
    }
    try {
      moveItem(item, entry, `${String(position + 1).padStart(2, '0')}-${safeName(item.name)}`, folder, root, env, platform);
      moves.push({ item, outcome: 'moved' });
    } catch (err) {
      problem = (err as Error).message.split('\n')[0] ?? 'the move failed';
      moves.push({ item, outcome: 'failed', problem });
    }
  }
  writeTrashIndex(folder, index);
  print(invocation, tidyScreen({ kind: 'local', folder, moves }));
  return problem ? 1 : 0;
}

/** What happened to one thing `--local` set out to put away. */
export interface TidyMove {
  item: TidyItem;
  /** Moved into the trash; changed while it was saved, so it stays; left because a move before it failed; or its own move failed. */
  outcome: 'moved' | 'changed' | 'after-failure' | 'failed';
  /** Why its move failed, for 'failed'. */
  problem?: string;
}

/**
 * What `tidy --local` or `tidy --empty` did, as data (plan D1): the screen is built from it.
 * `--local`: the trash folder it made (null when there was nothing to put away) and each move.
 * `--empty`: the trash folder, everything in it, and the folders deleted (undefined while the
 * question waits, or when nothing old is there).
 */
export type TidyResult = { kind: 'local'; folder: string | null; moves: TidyMove[] } | EmptyResult;

/** What `tidy --empty` found and did: the trash folder, everything in it, and the folders deleted. */
export interface EmptyResult {
  kind: 'empty';
  trash: string;
  folders: TrashFolder[];
  /** The folders deleted; undefined while the question waits, or when the answer was no. */
  deleted?: string[];
}

/** One move as its row: put away, left as it is, or not moved and why. */
function moveRow({ item, outcome, problem }: TidyMove): string[] {
  if (outcome === 'moved') return row('done', `${itemText(item)} Put away.`, kindWord(item));
  if (outcome === 'failed') return row('MISSING', `${item.name}: not moved, ${problem ?? 'the move failed'}`, kindWord(item));
  return row('skipped', `${item.name}: ${outcome === 'after-failure' ? 'not moved, a move before it failed.' : 'it changed while tidy saved it, so it stays.'}`, kindWord(item));
}

/** The size of trash folders, as a person reads it. */
const trashSize = (folders: readonly TrashFolder[]): string => formatSize(folders.reduce((sum, folder) => sum + folder.size, 0));

/**
 * The screen of `tidy --local` or `tidy --empty`, a pure function of the result. For
 * `--empty` with old trash and nothing deleted yet, it is what the question is asked under.
 */
export function tidyScreen(result: TidyResult): string[] {
  if (result.kind === 'local') {
    if (result.folder === null) return title('tidy --local', 'nothing to put away; nothing was changed');
    const moved = result.moves.filter((move) => move.outcome === 'moved').length;
    // A failed move stops the rest: the title says so, so 0 put away never reads as done.
    const isStopped = result.moves.some((move) => move.outcome === 'failed');
    return screen(title('tidy --local', `put away ${count(moved, 'thing')} in ${result.folder}${isStopped ? '; a move failed, so the rest stayed' : ''}`), spaced(result.moves.map(moveRow)), moreLine('index.json there says how to bring each one back. It stays 7 days.'), nextLine('yokoten tidy'));
  }
  const old = result.folders.filter((folder) => folder.isOld);
  if (!old.length) return screen(title('tidy --empty', 'nothing in the trash is over 7 days old; nothing was deleted'), trashBlock(result.folders));
  return screen(
    title('tidy --empty', `${count(old.length, 'trash folder')} over 7 days old, ${trashSize(old)}`),
    spaced(old.map((folder) => row('next', `${folder.path.slice(result.trash.length + 1)}: ${formatSize(folder.size)}, put away ${new Date(folder.created).toISOString().slice(0, 10)}.`, 'trash'))),
    result.deleted ? deletedRow(result) : [],
  );
}

/** The answer's row under the question of `--empty`: what was deleted, or that nothing was. */
export function deletedRow(result: EmptyResult): string[] {
  if (result.deleted === undefined) return row('ok', 'nothing was deleted.', 'trash');
  return row('done', `deleted ${count(result.deleted.length, 'folder')}, ${trashSize(result.folders.filter((folder) => folder.isOld))}.`, 'trash');
}

/** One line from the terminal, or '' at its end. */
async function readAnswer(invocation: Invocation): Promise<string> {
  const lines = createInterface({ input: invocation.stdin.stream, terminal: false });
  for await (const line of lines) {
    lines.close();
    return line;
  }
  return '';
}

/** `yokoten tidy --empty`: delete trash over 7 days old, after one question. */
async function emptyTrash(invocation: Invocation, trash: string, platform: NodeJS.Platform, isYes: boolean): Promise<number> {
  const folders = readTrash(trash, Date.now());
  const old = folders.filter((folder) => folder.isOld);
  const result: EmptyResult = { kind: 'empty', trash, folders };
  if (!old.length) {
    print(invocation, tidyScreen(result));
    return 0;
  }
  const size = trashSize(old);
  const done = (): EmptyResult => ({ ...result, deleted: deleteTrash(trash, old, platform) });
  if (isYes) {
    print(invocation, tidyScreen(done()));
    return 0;
  }
  print(invocation, tidyScreen(result));
  if (!terminalOf(invocation).isPerson) return fail(invocation, '--empty asks before it deletes, and there is no terminal to ask in. Nothing was deleted', 'run it in a terminal, or add `--yes`');
  say(invocation, `${askLine(`Delete ${count(old.length, 'folder')} (${size}) for good?`)} `, invocation.stdout);
  const answer = (await readAnswer(invocation)).trim().toLowerCase();
  // Only an explicit yes deletes: Enter alone does not, whatever the question's default looks like.
  print(invocation, deletedRow(answer === 'y' || answer === 'yes' ? done() : result));
  return 0;
}

export async function runTidy(invocation: Invocation): Promise<number> {
  const options = parse('tidy', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  const isLocal = options.flags.has('--local');
  const isEmpty = options.flags.has('--empty');
  const isYes = options.flags.has('--yes');
  if (isLocal && isEmpty) return usage(invocation, '--local and --empty run one at a time');
  if (isYes && !isEmpty) return usage(invocation, '--yes goes with --empty');
  if (options.flags.has('--json') && (isLocal || isEmpty)) return usage(invocation, '--json lists what is old: yokoten tidy --json');
  const platform = invocation.platform ?? 'linux';
  const trash = join(tidyStateDir(invocation.env, platform), 'trash');
  if (isEmpty) return emptyTrash(invocation, trash, platform, isYes);
  const root = requireRoot(invocation, invocation.cwd);
  if (!root) return 1;
  if (isLocal) return putAway(invocation, root, trash, platform);
  const scan = scanTidy({ root, cwd: invocation.cwd, env: invocation.env, platform, now: Date.now() });
  const folders = readTrash(trash, Date.now());
  if (options.flags.has('--json')) printJson(invocation, { ...scan, trash: folders });
  else print(invocation, listScreen(scan, folders));
  return 0;
}
