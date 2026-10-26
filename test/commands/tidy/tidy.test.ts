// Tests for src/commands/tidy/tidy.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { test } from 'node:test';
import { makeSandbox } from '../../repo/helpers.ts';
import { TIDY_NOT_READY } from '../../../src/commands/tidy/tidy.ts';

test('tidy: says it is not ready, exits 0 and writes nothing; an unknown word is a usage error (#1054)', async () => {
  const sandbox = makeSandbox();
  sandbox.git('commit', '-q', '--allow-empty', '-m', 'start');
  const before = () => [sandbox.git('status', '--porcelain', '--ignored').stdout, readdirSync(sandbox.home, { recursive: true }).sort()];
  const start = before();
  const result = await sandbox.call(['tidy']);
  assert.deepEqual([result.status, result.stdout, result.stderr], [0, `${TIDY_NOT_READY}\n`, '']);
  assert.deepEqual(before(), start, 'tidy writes nothing');
  // The positive control: what it does not take is refused, as every command does.
  const bad = await sandbox.call(['tidy', '--everything']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /^yokoten tidy: unknown option --everything/);
});
