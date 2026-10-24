// What `yokoten conflicts` says (#909): the plain-words summary a person reads, and the
// map itself with --json. map.ts reads git and writes the cache; this file only chooses
// words. The answer comes first: the next pick and its reason. Then one block per thing,
// each a heading and its lines, a blank line between (owner 2026-10-24). The order is a
// first look, not the merge order (#912): it names a pair, then says which of the two goes
// first, which is all a beginner needs before one merge.

import { formatFinding } from '../../../rules/message.ts';
import { type Invocation, parse, print, printJson, requireRoot, usage } from '../../shared.ts';
import { beforeChange, buildMap, openChanges, writeMap } from './map.ts';
import { mergeOrder } from './order.ts';
import { rebuildPrompt } from './rebuild.ts';
import type { Change, Collision, ConflictMap } from './types.ts';

/** The most labels one line names before it counts the rest. */
const MAX_LABELS = 6;
/** The most lines one block shows before it counts the rest. */
const MAX_LINES = 3;
/** The most paths one line names before it counts the rest. */
const MAX_PATHS = 3;

const one = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

/** The last line of a long block: how many lines it keeps back, and the command that shows them. */
const moreLine = (count: number): string => `+${count} more: \`yokoten conflicts --json\``;

/**
 * One block: a short heading, its lines indented under it, and a count when it holds more
 * than three. An empty block says nothing, so a quiet map has no empty heading.
 */
function block(heading: string, lines: string[]): string[] {
  if (!lines.length) return [];
  const shown = lines.slice(0, MAX_LINES);
  const kept = [heading, ...shown.map((line) => `  ${line}`)];
  if (lines.length > MAX_LINES) kept.push(`  ${moreLine(lines.length - MAX_LINES)}`);
  return kept;
}

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
 * The summary: the next pick first, then one block for what goes first, one for the pairs
 * that collide, one for the hot files, and last the drafts and the map's own notes. Plain
 * words, one idea a line, and the same facts as before, only grouped (owner 2026-10-24).
 */
export function summaryLines(map: ConflictMap, notes: string[] = []): string[] {
  if (!map.changes.length) return ['No open change is here to compare with main.', 'Push a branch or open a pull request, then run `yokoten conflicts` again.'];
  const withMain = collideWithMain(map);
  // The merge order (#912) decides which of a pair goes first, so every line agrees with it.
  // A draft has no place in it, so the other change of its pair goes first.
  const order = mergeOrder(map);
  const rank = new Map(order.map((pick, index) => [pick.id, index]));
  const next = order[0] && map.changes.find((change) => change.id === order[0]?.id);
  const key = next && (withMain.length || map.collisions.length)
    ? `Merge next: ${next.label}, because ${order[0]?.why}.`
    : withMain.length || map.collisions.length
      ? 'No change can merge next: every one that collides is a draft.'
      : 'No open change collides with main, or with another open change.';
  const lines: string[] = [key];
  const add = (part: string[]): void => {
    if (part.length) lines.push('', ...part);
  };

  const moving = movers(map);
  add(block('What goes first', moving.map(({ change, others }) =>
    `${change.label} moves ${one(change.moves.length, 'file')} that ${one(others.length, 'other change')} ${others.length === 1 ? 'touches' : 'touch'}. It goes in alone, before them.`)));

  const pairLines: string[] = [];
  if (withMain.length) pairLines.push(`${one(withMain.length, 'change')} ${withMain.length === 1 ? 'collides' : 'collide'} with main: ${labelsText(withMain)}.`);
  const pairs: { collision: Collision; pair: [Change, Change] }[] = [];
  for (const collision of map.collisions) {
    const pair = pairOf(map, collision.first, collision.second);
    if (pair) pairs.push({ collision, pair });
  }
  for (const { collision, pair } of pairs) {
    const [left, right] = pair;
    const leftRank = rank.get(left.id) ?? Infinity;
    const rightRank = rank.get(right.id) ?? Infinity;
    const first = leftRank === rightRank ? firstOf(left, right) : leftRank < rightRank ? left : right;
    const second = first === left ? right : left;
    pairLines.push(`${first.label} and ${second.label} both change ${pathsText(collision.files)}. Merge ${first.label} first, then ${second.label}.`);
  }
  add(block('Pairs that collide', pairLines));

  if (map.hot.length) {
    const names = map.hot.slice(0, MAX_PATHS).join(', ');
    const rest = map.hot.length - MAX_PATHS;
    const hot = ['Hot files', `  ${one(map.hot.length, 'file')} ${map.hot.length === 1 ? 'is' : 'are'} hot: three or more open changes touch them, or an open change moves them.`, `  ${names}`];
    if (rest > 0) hot.push(`  ${moreLine(rest)}`);
    add(hot);
  }

  const drafts = map.changes.filter((change) => change.draft && (change.mainConflicts?.length || map.collisions.some((collision) => collision.first === change.id || collision.second === change.id)));
  const last: string[] = [];
  if (drafts.length) {
    last.push(drafts.length === 1
      ? `${drafts[0]?.label ?? 'A draft'} is a draft, so it is listed here, but not ordered.`
      : `${labelsText(drafts)} are drafts, so they are listed here, but not ordered.`);
  }
  for (const note of notes) last.push(`note: ${note}`);
  const heading = drafts.length && notes.length ? 'Drafts and notes' : drafts.length ? 'Drafts' : 'Notes';
  // The last block is never shortened: --json has the drafts but not the map's own notes,
  // so a count here would point at a command that cannot show what it hid.
  if (last.length) add([heading, ...last.map((line) => `  ${line}`)]);
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
