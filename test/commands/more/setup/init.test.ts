// Tests for src/commands/more/setup/init.ts.

import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectScreen } from '../../../../src/commands/more/setup/init.ts';
import { makeSandbox } from '../../../repo/helpers.ts';

test('init: a second run says nothing changed, in one title line', () => {
  assert.match(projectScreen(['kept AGENTS.md'], true).join('\n'), /already set up here, nothing changed/);
});

test('init: the project screen counts the files written and keeps the yours', () => {
  const screen = projectScreen(['wrote AGENTS.md', 'wrote yokoten.json', 'kept CODEOWNERS'], true).join('\n');
  assert.match(screen, /2 files written, 1 of yours kept/);
  assert.match(screen, /^Next: /m);
});

test('init: in a project it writes the rules and shows one Next line', async () => {
  const sandbox = makeSandbox();
  const result = await sandbox.call(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.match(/^Next: /gm)?.length, 1);
});
