// Tests for src/commands/desk/desk.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { test } from 'node:test';
import { makeSandbox } from '../../repo/helpers.ts';
import { DESK_NOT_READY } from '../../../src/commands/desk/desk.ts';

test('desk: bare desk says it is not ready, exits 0 and writes nothing; with words it is the fenced desk (#1054)', async () => {
  const sandbox = makeSandbox();
  sandbox.git('commit', '-q', '--allow-empty', '-m', 'start');
  const before = () => [sandbox.git('status', '--porcelain', '--ignored').stdout, readdirSync(sandbox.home, { recursive: true }).sort()];
  const start = before();
  const bare = await sandbox.call(['desk']);
  assert.deepEqual([bare.status, bare.stdout, bare.stderr], [0, `${DESK_NOT_READY}\n`, '']);
  assert.deepEqual(before(), start, 'bare desk writes nothing');
  // The positive control: with words, the fenced desk of #637 runs and names what is missing.
  const words = await sandbox.call(['desk', 'claude-code', sandbox.repo]);
  assert.equal(words.status, 1);
  assert.match(words.stderr, /name the agent, the folder and the command/);
});
