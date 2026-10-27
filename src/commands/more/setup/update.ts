// `yokoten trust` and `update`: keep what init wrote, and bring the core rules up to date.
// Each screen is a pure function of the command's result (#1115); nothing reads printed text back.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { type LineChange, PROJECT_HEADING, trust, type TrustResult, undoTrust, updateCoreRules, type UpdateResult } from '../../../setup/init.ts';
import { count, fail, failure, type Invocation, nextLine, parse, print, requireRoot, row, screen, show, spaced, summaryLine, terminalOf, title, underRow, usage, wrap } from '../../shared.ts';
import { section } from '../../../rules/text/screen.ts';

/** Why `yokoten trust` writes only for a person at a terminal (#661), and the command they type. */
export const TRUST_NEEDS_A_PERSON = {
  what: 'a person runs this at a terminal, since it changes the trust in your own agent settings; nothing was written',
  next: 'yokoten trust',
};

export function runTrust(invocation: Invocation): number {
  const options = parse('trust', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  // A person turns the guard on (#661): a pipe, a hook or CI has nobody to decide, and an
  // agent that ran the command would change the trust in its user's own settings.
  if (!terminalOf(invocation).isPerson) return fail(invocation, TRUST_NEEDS_A_PERSON.what, TRUST_NEEDS_A_PERSON.next);
  const dir = resolve(invocation.cwd, options.positional[0] ?? '.');
  if (!existsSync(dir)) return fail(invocation, `${options.positional[0]} does not exist, so nothing was written`, 'yokoten trust');
  const root = requireRoot(invocation, dir);
  if (!root) return 1;
  const isUndo = options.flags.has('--undo');
  const done = isUndo ? undoTrust(root, invocation.env) : trust(root, invocation.env);
  print(invocation, trustScreen(done, isUndo), done.ok ? invocation.stdout : invocation.stderr);
  return done.ok ? 0 : 1;
}

/** `a`, `a and b`, `a, b and c`. */
const listOf = (names: readonly string[]): string => (names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/**
 * The one screen `yokoten trust` shows, from its result (#1027, #1040): what changed in each
 * agent, what is left and how to fix it, the user's own choices, then the way back, only when
 * something was written. A title never says the guard now runs when nothing changed.
 */
export function trustScreen(result: TrustResult, isUndo: boolean): string[] {
  if (!result.hasAgents) {
    return title('trust', isUndo ? 'nothing to undo: `yokoten trust` wrote nothing for this folder' : "no agent installed here runs yokoten's hooks in this project, so there is nothing to turn on");
  }
  const agents = (state: 'added' | 'kept' | 'removed') => result.changes.filter((change) => change.state === state).map((change) => change.agent ?? change.path);
  const [added, already, removed] = [agents('added'), agents('kept'), agents('removed')];
  const summary = isUndo
    ? removed.length ? `the guard is off again in ${listOf(removed)}` : 'nothing was undone'
    : added.length ? `the guard now runs in ${listOf(added)}` : already.length && !result.problems.length ? `already on in ${listOf(already)}; nothing changed` : result.ok ? 'nothing changed; the trust stays as you set it' : 'the guard is not on yet';
  const rows = [
    ...added.flatMap((name) => row('done', `${name}: this folder is trusted now`)),
    ...already.flatMap((name) => row('ok', `${name}: this folder is already trusted`)),
    ...removed.flatMap((name) => row('done', `${name}: this folder is no longer trusted`)),
  ];
  // A problem or a note is never folded away (R5 of #1027, #1040).
  const problems = spaced(result.problems.map((problem) => fixedRow('MISSING', problem.what, problem.fix)));
  const notes = spaced(result.notes.map((note) => fixedRow('note', note.what, note.fix)));
  const way = added.length ? wrap('', 'Undo: `yokoten trust --undo`') : removed.length ? wrap('', 'To turn it on again: `yokoten trust`') : result.ok ? [] : nextLine('yokoten doctor');
  return screen(title('trust', summary), rows, problems, notes, way);
}

/** A row, and its fix under it on a `Fix:` line of its own, one line for each command or setting. */
const fixedRow = (mark: 'MISSING' | 'note', what: string, fix: string): string[] => [...row(mark, what), ...(fix === '' ? [] : fix.split('\n').flatMap((line) => underRow(`Fix: \`${line}\``, false)))];

export function runUpdate(invocation: Invocation): number {
  // Its own command, not an init flag: init promises to add only, never to overwrite (#120).
  const options = parse('update', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  const dir = resolve(invocation.cwd, options.positional[0] ?? '.');
  if (!existsSync(dir)) return fail(invocation, `${options.positional[0]} does not exist, so there is nothing to update`, 'yokoten update');
  const root = requireRoot(invocation, dir);
  if (!root) return 1;
  const result = updateCoreRules(root, { write: options.flags.has('--write') }, invocation.env);
  if (result.problem) return fail(invocation, result.problem.what, result.problem.fix || undefined);
  // --all shows every line that differs, for the person who reads it before --write.
  show(invocation, options.flags.has('--all') ? updateAllScreen(result) : updateScreen(result));
  return 0;
}

/** The core rule a changed line belongs to, from the rules table; null for any other line. */
const ruleOf = (change: LineChange): string | null => /^\| (\d+) \|/.exec(change.line.trim())?.[1] ?? null;

/**
 * The default screen of `yokoten update` (issue #1027), from its result: how many core rules
 * changed, one row per rule, and the note that the project's own part stays. A refusal is a
 * failure with its fix as the Next line (R5).
 */
export function updateScreen(result: UpdateResult): string[] {
  if (result.problem) return failure('update', result.problem.what, result.problem.fix || undefined);
  if (result.state === 'up to date') return title('update', 'the core rules are up to date, nothing changed');
  if (result.state === 'written') {
    return screen(
      title('update', "the core rules in AGENTS.md are this version's now"),
      spaced([row('done', `AGENTS.md: the core rules (${result.summary})`), ...(result.backup === undefined ? [] : [row('note', `the file before it is kept as ${result.backup}; delete it once the new AGENTS.md reads right`)])]),
    );
  }
  const added = new Set(result.changes.filter((change) => change.kind === 'added').map(ruleOf).filter((rule) => rule !== null));
  const removed = new Set(result.changes.filter((change) => change.kind === 'removed').map(ruleOf).filter((rule) => rule !== null));
  const rules = [...new Set([...added, ...removed])].sort((a, b) => Number(a) - Number(b));
  if (!rules.length) {
    return screen(title('update', 'the core rules changed upstream'), row('note', 'the change is outside the rules table'), nextLine('yokoten update --write'));
  }
  const rows = rules.flatMap((rule) => row('next', `rule ${rule}: ${added.has(rule) && removed.has(rule) ? 'wording changed' : added.has(rule) ? 'new' : 'removed'}`));
  return screen(
    title('update', `${count(rules.length, 'core rule')} changed upstream`),
    rows,
    summaryLine('Your "This project" part stays as it is.'),
    nextLine('yokoten update --write'),
  );
}

/** `yokoten update --all`: every line of the core rules that differs, then the command that writes them. */
export function updateAllScreen(result: UpdateResult): string[] {
  if (result.state !== 'preview') return updateScreen(result);
  const lines = spaced(result.changes.map((change) => wrap(`  ${change.kind === 'added' ? '+' : '-'} `, change.line.trim() ? change.line.trim() : '(a blank line)')));
  return screen(
    title('update', `the core rules differ from yokoten ${result.version}'s: ${result.summary}`),
    section('Lines', lines),
    summaryLine(`A line marked - is replaced: an older kit wrote it, or someone edited it. Move any rule of your own under "${PROJECT_HEADING}" first; that part stays as it is.`),
    nextLine('yokoten update --write'),
  );
}
