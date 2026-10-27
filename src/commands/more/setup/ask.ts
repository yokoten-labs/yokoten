// Shared by the setup commands: asking on the terminal, and the rows that name what is left for the person.

import { type Ask } from '../../../setup/install.ts';
import { MARK_COLUMN, ROW_INDENT, ROW_TEXT_COLUMN } from '../../../rules/text/screen.ts';
import { askOnTerminal, type Invocation, row, spaced, terminalOf } from '../../shared.ts';

// The question writer lives in shared.ts (issue #1115); it is named here too for older importers.
export { askOnTerminal } from '../../shared.ts';

/**
 * Whether someone is at the terminal. Trust has no question, so this is what makes its
 * write the person's decision rather than a pipe's (#661).
 */
export const isAtTerminal = (invocation: Invocation): boolean => terminalOf(invocation).isPerson;

/**
 * The terminal to ask on, or undefined in a pipe, a hook or CI (#433): an asked question
 * with nobody there would stop the command.
 */
export const askWhenTerminal = (invocation: Invocation): Ask | undefined => {
  const { stdin, stdout } = invocation;
  return terminalOf(invocation).canAsk && stdin.fd !== null ? askOnTerminal(stdout, stdin.fd) : undefined;
};

/** Where a labelled row's text starts, so a wrapped line lines up under it. */
export const ROW_TEXT_INDENT = ' '.repeat(ROW_TEXT_COLUMN);

/** Where the text of a row with no label starts: a line to paste stands there whole. */
const UNDER_MARK = ' '.repeat(ROW_INDENT + MARK_COLUMN);

/** A line that leaves a step for the person: the commit check not on yet, or a line to add by hand (#1027 review). */
export const NEEDS_HAND = /core\.hooksPath|not on yet|by hand/;

/** A step left for the person, as a MISSING row; a line to paste stays whole on its own line, so it copies as one (#1027 review). */
export function handRow(problem: string): string[] {
  const at = /^(.*?Add this line[^:]*:) (.+)$/.exec(problem.replace(/^kept /, ''));
  if (!at) return row('MISSING', problem.replace(/^kept /, ''));
  return [...row('MISSING', at[1]), `${UNDER_MARK}${at[2]}`];
}

/** Why a line is a problem: a step that failed, or one left for the person; never one that found nothing to do. */
const isProblem = (line: string): boolean =>
  /^(couldn't|kept the Claude Code hooks)/.test(line) || NEEDS_HAND.test(line) || (/^skipped /.test(line) && !/ not found|the global git setting|"notNow"/.test(line));

/** The rest of a report, for a command whose full list sits behind --list. */
export function remaining(lines: string[], { isProblemsOnly = false } = {}): string[] {
  const notes = lines.filter((line) => /^skipped the global git setting mailmap\.file/.test(line) || /^your edits stay/.test(line));
  const problems = lines.filter(isProblem);
  // Each row is one item: a blank line goes between them once one wraps (#1115).
  const items: string[][] = [];
  for (const note of notes) {
    if (isProblemsOnly) continue;
    if (/^your edits stay/.test(note)) {
      items.push(row('note', 'your own edits stay; the newest copies are in the kit', 'kept'));
      continue;
    }
    const fix = /`(git config[^`]+)`/.exec(note)?.[1];
    // The command stays whole on a line of its own, so it fits 80 columns and copies as one.
    items.push([...row('note', 'hide your email in git logs: not on yet', 'email'), ...(fix ? [`${ROW_TEXT_INDENT}to turn it on:`, `${UNDER_MARK}\`${fix}\``] : [])]);
  }
  for (const problem of problems) items.push(handRow(problem));
  return spaced(items);
}

