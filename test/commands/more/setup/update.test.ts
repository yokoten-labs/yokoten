// Tests for src/commands/more/setup/update.ts.

import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { updateScreen } from '../../../../src/commands/more/setup/update.ts';
import { VERSION } from '../../../../src/setup/files.ts';
import { makeSandbox } from '../../../repo/helpers.ts';


/** Every line of a screen fits an 80-column terminal (R1). */
const fit = (text: string): void => {
  for (const line of text.trimEnd().split('\n')) assert.ok(line.length <= 80, `${line.length}: ${line}`);
};

test('update: a folder that does not exist is said plainly (#208)', () => {
  const sandbox = makeSandbox();
  // update's entry, through the real binary.
  const result = sandbox.run(['update', 'typo']);
  assert.deepEqual([result.status, result.stdout, result.stderr], [1, '', 'note: yokoten update moved to yokoten. It runs as before this time.\n\nyokoten update: typo does not exist; nothing to update.\n']);
  assert.ok(!existsSync(join(sandbox.repo, 'typo')));
});

test('trust: one screen names each agent, then the way back (#1027)', async () => {
  const sandbox = makeSandbox();
  mkdirSync(join(sandbox.home, '.codex'), { recursive: true });
  await sandbox.call(['init', '--no-ci']);
  const done = await sandbox.call(['trust'], { isTTY: true, extra: { NO_COLOR: '1' } });
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /^yokoten trust · the guard now runs in 1 agent here$/m);
  assert.match(done.stdout, /^ {2}ok +Codex +this folder is trusted$/m);
  assert.match(done.stdout, /^Undo: `yokoten trust --undo`$/m);
  fit(done.stdout);
});

// #1027: one screen for update: how many core rules changed, one row per rule, the way back next.
test('update: one screen per core rule change (#1027)', () => {
  const lines = [
    `the core rules in AGENTS.md differ from yokoten ${VERSION}'s: 2 line(s) added, 1 removed`,
    '',
    '+ | 9 | Nothing reaches main without a pull request | x |',
    '- | 4 | A fix task changes code | x |',
    '+ | 4 | A fix task changes code and tests | x |',
    '- | 12 | An old rule | x |',
    '',
    'A line marked - is replaced.',
    'Move any rule of your own under "This project" first. That part stays as it is.',
    'Nothing was written. Run `yokoten update --write` to write it.',
  ];
  const screen = updateScreen({ ok: true, lines, isWrite: false });
  assert.equal(screen[0], 'yokoten update · 3 core rules changed upstream');
  assert.ok(screen.some((line) => /^  next\s+rule 4\s+wording changed$/.test(line)), 'a changed rule');
  assert.ok(screen.some((line) => /^  next\s+rule 9\s+new$/.test(line)), 'a new rule');
  assert.ok(screen.some((line) => /^  next\s+rule 12\s+removed$/.test(line)), 'a removed rule');
  assert.ok(screen.includes('  Your "This project" part stays as it is.'));
  assert.equal(screen.at(-1), 'Next: `yokoten update --write`');
  assert.deepEqual(updateScreen({ ok: true, lines: [`the core rules in AGENTS.md are up to date with yokoten ${VERSION}; nothing to change`], isWrite: false }), ['yokoten update · the core rules are up to date, nothing changed']);
  assert.equal(updateScreen({ ok: false, lines: ['no AGENTS.md here; nothing was written. Run `yokoten init` to add one'], isWrite: false })[1], '');
  for (const one of [
    updateScreen({ ok: true, lines, isWrite: false }),
    updateScreen({ ok: false, lines: ['no AGENTS.md here; nothing was written. Run `yokoten init` to add one, then run `yokoten update` again after that.'], isWrite: false }),
    updateScreen({ ok: true, lines: [`replaced the core rules in AGENTS.md with yokoten ${VERSION}'s: 1 line(s) added, 0 removed. "This project" and below are unchanged. The old file is kept as AGENTS.backup.md; delete it once the new AGENTS.md reads right`], isWrite: true }),
  ]) for (const line of one) assert.ok(line.length <= 80, `over 80: ${line}`);
});

