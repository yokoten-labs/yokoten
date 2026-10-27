// Tests for src/commands/more/setup/ask.ts.

import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { askWhenTerminal, handRow, isAtTerminal, remaining } from '../../../../src/commands/more/setup/ask.ts';
import type { Invocation } from '../../../../src/commands/shared.ts';

const piped = { stdin: { fd: null, stream: { isTTY: false } }, stdout: { isTTY: false } } as unknown as Invocation;

test('ask: in a pipe nobody is at the terminal and nothing is asked', () => {
  assert.equal(isAtTerminal(piped), false);
  assert.equal(askWhenTerminal(piped), undefined);
});

test('ask: a line to paste stays whole on its own line, and a plain step is one row', () => {
  const rows = handRow('kept the file. Add this line to it: export X=1');
  assert.ok(rows.some((line) => line.endsWith('export X=1') && !line.includes('Add this line')));
  assert.equal(handRow('core.hooksPath is not on yet').length, 1);
});

test('ask: the rest of a report lists the steps left for the person and nothing else', () => {
  assert.deepEqual(remaining(['wrote a file', 'removed b']), []);
  assert.equal(remaining(['skipped the commit check: core.hooksPath is not on yet']).length > 0, true);
});
