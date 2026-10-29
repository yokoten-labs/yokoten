// Tests for src/setup/install.ts: install: the files it writes, the stop log and the managed mark.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { shareGuardMeasure, shareSelfTest, makeSandbox, makeTempDir } from '../../repo/helpers.ts';
import { isEditedManaged, sealManaged, writeManaged } from '../../../src/setup/files.ts';
import { uninstallIn, assertRows, findingsOf } from './helpers.ts';

shareGuardMeasure();
shareSelfTest();

test('uninstall: removes the stop log (#621)', async () => {
  const sandbox = makeSandbox();
  const log = join(sandbox.home, '.config', 'yokoten', 'stops.jsonl');
  mkdirSync(dirname(log), { recursive: true });
  writeFileSync(log, '{"time":"2026-10-23T00:00:00.000Z","vendor":"codex","role":"lead","rule":"release","answer":"refused"}\n');
  writeFileSync(join(sandbox.home, '.config', 'yokoten', 'keys.json'), '{}\n');
  const result = uninstallIn(sandbox);
  assert.ok(result.ok, findingsOf(result, sandbox.home));
  assert.ok(!existsSync(log));
  assertRows(result, sandbox.home, 'removed file ~/.config/yokoten/stops.jsonl', 'kept file ~/.config/yokoten yours');
  const again = uninstallIn(sandbox);
  assert.ok(!again.changes.some((change) => change.path === log), 'a second run has no stop log to name');
});

// #848: a line of the user's own that names the mark must not hide it, and CRLF alone is no edit.
const MANAGED_SKILL = `---
name: dispatch
description: Hand one task to a worker.
---
<!-- managed by yokoten; \`yokoten install\` updates this file, and keeps your edits -->

# Dispatch

Hand one task to a worker.
`;

/** The sealed skill with `above` before its mark and `below` after its first paragraph. */
const editedSkill = (above: string, below: string): string =>
  sealManaged(MANAGED_SKILL)
    .replace('<!-- managed by yokoten', `${above}\n<!-- managed by yokoten`)
    .replace('Hand one task to a worker.\n', `Hand one task to a worker.\n${below}\n`);

test('files: a line above the mark that says "managed by yokoten" does not hide the mark (#848)', () => {
  const sealed = sealManaged(MANAGED_SKILL);
  assert.match(sealed, / sha256=[0-9a-f]{64}/, 'the mark records a hash');
  // The user writes a description above the mark and a rule below it: both are their edit.
  const mine = editedSkill('This file is managed by yokoten, with my own rule.', 'Ask the owner before a release.');
  assert.equal(isEditedManaged(mine), true, 'the hash in the real mark is found');
  const path = join(makeTempDir(), 'SKILL.md');
  writeFileSync(path, mine);
  assert.equal(writeManaged(path, MANAGED_SKILL), 'kept (your edit)');
  assert.equal(readFileSync(path, 'utf8'), mine, 'their edit stays');
});

test('files: a markdown heading that names the mark is the user\'s, not yokoten\'s (#848)', () => {
  const path = join(makeTempDir(), 'SKILL.md');
  const mine = '# This skill is managed by yokoten, and I wrote it\n';
  writeFileSync(path, mine);
  assert.equal(writeManaged(path, MANAGED_SKILL), 'kept (yours)');
  assert.equal(readFileSync(path, 'utf8'), mine);
});

test('files: a file that only mentions the mark in its own words is the user\'s', () => {
  const path = join(makeTempDir(), 'notes.md');
  const mine = 'This file is managed by yokoten, in a sentence of my own.\n';
  writeFileSync(path, mine);
  assert.equal(writeManaged(path, MANAGED_SKILL), 'kept (yours)');
  assert.equal(readFileSync(path, 'utf8'), mine);
});

test('files: a managed file whose only change is CRLF line ends is yokoten\'s copy (#456)', () => {
  const sealed = sealManaged(MANAGED_SKILL);
  const windows = sealed.replace(/\n/g, '\r\n');
  assert.equal(isEditedManaged(windows), false, 'CRLF is not an edit');
  const path = join(makeTempDir(), 'SKILL.md');
  writeFileSync(path, windows);
  assert.equal(writeManaged(path, MANAGED_SKILL), 'updated');
  assert.equal(readFileSync(path, 'utf8'), sealed);
});

test('files: sealing the same text twice is stable, and a $ in the mark stays a $', () => {
  const once = sealManaged(MANAGED_SKILL);
  assert.equal(sealManaged(once), once);
  const withDollar = MANAGED_SKILL.replace('updates this file', 'updates this $file');
  assert.match(sealManaged(withDollar), /updates this \$file/, 'a $ does not read as a replacement pattern');
});

// #984, a hard line: every write install makes to an agent's config file merges, and keeps the
// user's own keys. The control plants a key of the user's in each kind of file, then runs
// install twice and uninstall; each key is still there, as the user wrote it.
