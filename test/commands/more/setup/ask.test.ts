// Tests for src/commands/more/setup/ask.ts.

import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { askWhenTerminal, isAtTerminal } from '../../../../src/commands/more/setup/ask.ts';
import type { Invocation } from '../../../../src/commands/shared.ts';

const piped = { stdin: { fd: null, stream: { isTTY: false } }, stdout: { isTTY: false } } as unknown as Invocation;

test('ask: in a pipe nobody is at the terminal and nothing is asked', () => {
  assert.equal(isAtTerminal(piped), false);
  assert.equal(askWhenTerminal(piped), undefined);
});
