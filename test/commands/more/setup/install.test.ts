// Tests for src/commands/more/setup/install.ts.

import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeSandbox } from '../../../repo/helpers.ts';


/** Every line of a screen fits an 80-column terminal (R1). */
const fit = (text: string): void => {
  for (const line of text.trimEnd().split('\n')) assert.ok(line.length <= 80, `${line.length}: ${line}`);
};

test('install: one screen by default, and --list keeps every file (#1027)', async () => {
  const sandbox = makeSandbox();
  const result = await sandbox.call(['install']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^yokoten install · this computer is set up$/m);
  assert.match(result.stdout, /^ {2}ok +guard +on for Claude Code$/m);
  assert.match(result.stdout, /^ {2}can't check +other AIs +\d+ not installed here/m);
  assert.match(result.stdout, /^Next: `yokoten init`$/m);
  assert.match(result.stdout, /^More: `yokoten install --list` names every file$/m);
  fit(result.stdout);
  // The full listing is still there, behind the flag.
  const list = await sandbox.call(['install', '--list']);
  assert.match(list.stdout, /skill yokoten in ~[\\/]\.claude[\\/]skills$/m);
  assert.match(list.stdout, /^skipped Codex CLI: /m);
});

test('uninstall: one screen of counts, then how to install again (#1027)', async () => {
  const sandbox = makeSandbox();
  await sandbox.call(['install', '--list']);
  const result = await sandbox.call(['uninstall']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^yokoten uninstall · removed what install wrote$/m);
  assert.match(result.stdout, /^ {2}ok +removed +1 skill, 3 agents, 2 hooks$/m);
  assert.match(result.stdout, /^To install again: `yokoten install`$/m);
  assert.doesNotMatch(result.stdout, /removed skill /, 'per-file lines are behind --list');
  fit(result.stdout);
  const again = await sandbox.call(['uninstall']);
  assert.match(again.stdout, /^yokoten uninstall · nothing to remove: yokoten is not installed on this computer$/m);
});
