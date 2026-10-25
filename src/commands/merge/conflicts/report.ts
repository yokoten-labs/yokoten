// What `yokoten conflicts` says (#909): the plain-words summary a person reads, and the
// map itself with --json. map.ts reads git and writes the cache; this file only chooses
// words. The answer comes first: the next pick and its reason. Then one block per thing,
// each a heading and its lines, a blank line between (owner 2026-10-24). The order is a
// first look, not the merge order (#912): it names a pair, then says which of the two goes
// first, which is all a beginner needs before one merge.

import { formatFinding } from '../../../rules/message.ts';
import { count, type Invocation, nextLine, parse, print, printJson, requireRoot, row, title, usage, wrap } from '../../shared.ts';
import { beforeChange, buildMap, openChanges, writeMap } from './map.ts';
import { mergeOrder } from './order.ts';
import { rebuildPrompt } from './rebuild.ts';
import type { Change, ConflictMap } from './types.ts';

/** The most labels one line names before it counts the rest. */
const MAX_LABELS = 6;
/** The most paths one line names before it counts the rest. */
const MAX_PATHS = 3;

const one = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

/** Some paths, or the first few and a count: a line stays short on a big map. */
export function pathsText(paths: string[]): string {
  const first = paths.slice(0, MAX_PATHS);
  const rest = paths.length - first.length;
  return rest > 0 ? `${first.join(', ')}, and ${rest} more` : first.join(', ');
}

/** Some labels, or the first few and a count. */
export function labelsText(changes: Change[]): string {
  const first = changes.slice(0, MAX_LABELS);
  const rest = changes.length - first.length;
  const names = first.map((change) => change.label).join(', ');
  return rest > 0 ? `${names}, and ${rest} more` : names;
}

/** The open changes that collide with main now. */
export const collideWithMain = (map: ConflictMap): Change[] => map.changes.filter((change) => (change.mainConflicts?.length ?? 0) > 0);

/** The two changes of a collision, in the map's order. */
function pairOf(map: ConflictMap, a: string, b: string): [Change, Change] | null {
  const left = map.changes.find((change) => change.id === a);
  const right = map.changes.find((change) => change.id === b);
  return left && right ? [left, right] : null;
}

/**
 * Which of a conflicting pair goes first: the one that touches fewer files, then the
 * smaller one. A pair that conflicts is merged one way round, and the other change follows.
 */
export function firstOf(a: Change, b: Change): Change {
  if (a.files.length !== b.files.length) return a.files.length < b.files.length ? a : b;
  return beforeChange(a, b) ? a : b;
}

/**
 * The changes that move a file another open change also touches: a rename or a delete of a
 * file on main, so a split that deletes the old file counts. A draft is listed, not ordered.
 */
export function movers(map: ConflictMap): { change: Change; others: Change[] }[] {
  const found: { change: Change; others: Change[] }[] = [];
  for (const change of map.changes) {
    if (!change.moves.length) continue;
    const moved = new Set(change.moves);
    const others = map.changes.filter((other) => other.id !== change.id && other.files.some((path) => moved.has(path)));
    if (others.length) found.push({ change, others });
  }
  return found.sort((a, b) => b.others.length - a.others.length);
}

/**
 * The screen for `yokoten conflicts` (#1027): the counts, one row per colliding pair with
 * the file under it and which goes first, one row for the rest, then the command to type.
 * A beginner reads it top to bottom; an agent reads the same words.
 */
export function summaryLines(map: ConflictMap, notes: string[] = []): string[] {
  if (!map.changes.length) return [...title('conflicts', 'no open change to compare with main'), '', ...row('to do', 'push a branch or open a pull request, then run `yokoten conflicts` again')];
  const withMain = collideWithMain(map);
  const order = mergeOrder(map);
  const rank = new Map(order.map((pick, index) => [pick.id, index]));
  const pairs: { pair: [Change, Change]; files: string[]; first: Change; second: Change }[] = [];
  for (const collision of map.collisions) {
    const pair = pairOf(map, collision.first, collision.second);
    if (!pair) continue;
    const [left, right] = pair;
    const leftRank = rank.get(left.id) ?? Infinity;
    const rightRank = rank.get(right.id) ?? Infinity;
    const first = leftRank === rightRank ? firstOf(left, right) : leftRank < rightRank ? left : right;
    pairs.push({ pair, files: collision.files, first, second: first === left ? right : left });
  }
  // The title counts the changes in a collision, as the owner's screen does: two changes
  // that collide are one row, and the row says which of them goes first.
  const colliding = new Set(pairs.flatMap(({ pair }) => pair.map((change) => change.id)));
  const summary = withMain.length || pairs.length ? `${count(map.changes.length, 'open change')}, ${colliding.size} collide` : `${count(map.changes.length, 'open change')}, none collide`;
  const lines = [...title('conflicts', summary), ''];
  for (const { files, first, second } of pairs) {
    const why = order.find((pick) => pick.id === first.id)?.why;
    lines.push(...row('next', `${first.label} ⇄ ${second.label}`));
    lines.push(...wrap(' '.repeat(26), `${pathsText(files)}. Merge ${first.label} first${why ? `: ${why}` : ''}.`));
  }
  for (const change of withMain) {
    lines.push(...row('note', `${change.label} collides with main: ${pathsText(change.mainConflicts ?? [])}`));
  }
  const rest = map.changes.length - colliding.size - withMain.filter((change) => !colliding.has(change.id)).length;
  if (rest > 0) lines.push(...row('ok', `${count(rest, 'change')} ${rest === 1 ? 'touches' : 'touch'} no shared file`));
  else if (!pairs.length && !withMain.length) lines.push(...row('ok', 'no open change touches a file main or another open change touches'));
  const moving = movers(map);
  for (const { change, others } of moving) {
    lines.push(...row('note', `${change.label} moves ${one(change.moves.length, 'file')} that ${one(others.length, 'other change')} ${others.length === 1 ? 'touches' : 'touch'}; merge it in alone, before them`));
  }
  if (map.hot.length) lines.push(...row('note', `${count(map.hot.length, 'file')} ${map.hot.length === 1 ? 'is' : 'are'} hot: ${pathsText(map.hot)}`));
  const drafts = map.changes.filter((change) => change.draft && (change.mainConflicts?.length || map.collisions.some((collision) => collision.first === change.id || collision.second === change.id)));
  for (const draft of drafts) lines.push(...row('note', `${draft.label} is a draft, so it is listed here, but not ordered`));
  for (const note of notes) lines.push(...row('note', note));
  lines.push('', ...nextLine('yokoten train --next'));
  return lines;
}

/** Build one change in a fresh worktree instead of merging it (#913), as a prompt to hand over. */
function rebuild(map: ConflictMap, word: string, invocation: Invocation): number {
  const change = map.changes.find((held) => held.id === word || held.branch === word);
  if (!change) {
    print(invocation, [`yokoten conflicts: no open change ${word}. Run \`yokoten conflicts\` to see the ${one(map.changes.length, 'change')} this map holds.`], invocation.stderr);
    return 1;
  }
  let prompt: string;
  try {
    prompt = rebuildPrompt(map, change.id);
  } catch (err) {
    print(invocation, [`yokoten conflicts: ${err instanceof Error ? err.message : String(err)}`], invocation.stderr);
    return 1;
  }
  print(invocation, prompt.split('\n'));
  return 0;
}

/** `yokoten conflicts`: build the map, keep it for the guard, and say what it holds. */
export async function runConflicts(invocation: Invocation): Promise<number> {
  const options = parse('conflicts', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  const json = options.flags.has('--json');
  const root = requireRoot(invocation, invocation.cwd, (missing) => ({ command: 'conflicts', ok: false, error: formatFinding(missing) }));
  if (root === null) return 1;
  const opened = await openChanges(root, invocation.env);
  const built = buildMap(root, invocation.env, { listed: opened.listed });
  if (typeof built === 'string') {
    // With --json the answer is data, and a failure is data too: stdout holds the error alone.
    if (json) printJson(invocation, { command: 'conflicts', ok: false, error: built });
    print(invocation, [`yokoten conflicts: ${built}.`], invocation.stderr);
    return 1;
  }
  const { map, notes } = built;
  // The guard reads this file and never runs git (record 0013), so a map kept now is cheap
  // for every tool call that follows. A map that can't be kept is a note: the answer stands.
  // Kept before --rebuild too: the rebuild prompt is read from the same map the guard holds.
  const notKept = writeMap(root, invocation.env, map);
  const word = options.values['--rebuild'];
  if (word !== undefined) return rebuild(map, word, invocation);
  const allNotes = [...opened.notes, ...notes, ...(notKept === null ? [] : [notKept])];
  if (json) {
    printJson(invocation, map);
    for (const note of allNotes) print(invocation, [`note: ${note}`], invocation.stderr);
  } else {
    // The notes share the last block with the drafts, so the answer is one screen, not a
    // heading followed by lines on another stream.
    print(invocation, summaryLines(map, allNotes));
  }
  return 0;
}
