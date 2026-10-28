// Shared by the setup commands: asking on the terminal.

import { type Ask } from '../../../setup/install.ts';
import { askOnTerminal, type Invocation, terminalOf } from '../../shared.ts';

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
