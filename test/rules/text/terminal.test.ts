// Tests for src/rules/text/terminal.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shownValue, terminalText } from '../../../src/rules/text/terminal.ts';

test('terminalText: ESC, DEL, C1 and bidi controls show as \\uXXXX; tab and newline stay', () => {
  assert.equal(terminalText('a\u001b[2Jb\u007f\u009bc‮d\te\nf'), 'a\\u001b[2Jb\\u007f\\u009bc\\u202ed\te\nf');
});

test('shownValue: a plain word as typed, any other quoted and escaped (#1115)', () => {
  assert.equal(shownValue('octo/demo'), 'octo/demo');
  assert.equal(shownValue('v1.2-rc_3'), 'v1.2-rc_3');
  assert.equal(shownValue('bad\u001b[2J\nnext'), '"bad\\u001b[2J\\nnext"');
  assert.equal(shownValue('two words'), '"two words"');
});
