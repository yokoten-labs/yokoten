// Tests for src/commands/more/setup/update.ts.

import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { TRUST_NEEDS_A_PERSON, trustScreen, updateAllScreen, updateScreen } from '../../../../src/commands/more/setup/update.ts';
import { failure } from '../../../../src/rules/text/screen.ts';
import { VERSION } from '../../../../src/setup/files.ts';
import type { TrustResult, UpdateResult } from '../../../../src/setup/init.ts';
import { screenProblems } from '../../../repo/docs/screen-rules.ts';
import { makeSandbox } from '../../../repo/helpers.ts';

/** A screen's lines as one text, checked against the screen rules: none may break (#1115). */
function checked(lines: string[], isFailure = false): string {
  const text = `${lines.join('\n')}\n`;
  assert.deepEqual(screenProblems({ text, isFailure }), [], text);
  return text;
}

/** A preview of three core rules changed upstream, as `updateCoreRules` returns it. */
const PREVIEW: UpdateResult = {
  ok: true,
  state: 'preview',
  version: VERSION,
  summary: '3 lines added, 2 removed',
  changes: [
    { kind: 'added', line: '| 9 | Nothing reaches main without a pull request | x |' },
    { kind: 'removed', line: '| 4 | A fix task changes code | x |' },
    { kind: 'added', line: '| 4 | A fix task changes code and tests | x |' },
    { kind: 'removed', line: '| 12 | An old rule | x |' },
    { kind: 'added', line: '' },
  ],
};

test('update: a folder that does not exist is a failure with one Next line (#208)', () => {
  const sandbox = makeSandbox();
  // update's entry, through the real binary.
  const result = sandbox.run(['update', 'typo']);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^yokoten update · typo does not exist, so there is nothing to update\n\nNext: `yokoten update`\n$/m);
  assert.ok(!existsSync(join(sandbox.repo, 'typo')));
});

// #1027: one screen for update: how many core rules changed, one row per rule, the way back next.
test('update: one row per core rule that changed, from the result (#1027)', () => {
  const text = checked(updateScreen(PREVIEW));
  assert.match(text, /^yokoten update · 3 core rules changed upstream$/m);
  assert.match(text, /^ {2}next {8}rule 4: wording changed$/m, 'a changed rule');
  assert.match(text, /^ {2}next {8}rule 9: new$/m, 'a new rule');
  assert.match(text, /^ {2}next {8}rule 12: removed$/m, 'a removed rule');
  assert.match(text, /^Your "This project" part stays as it is\.$/m);
  assert.match(text, /Next: `yokoten update --write`\n$/);
  assert.deepEqual(updateScreen({ ...PREVIEW, state: 'up to date', changes: [] }), ['yokoten update · the core rules are up to date, nothing changed']);
});

test('update --write: the rules are this version\'s, and the backup is named', () => {
  const text = checked(updateScreen({ ...PREVIEW, state: 'written', backup: 'AGENTS.md.before-yokoten' }));
  assert.match(text, /^yokoten update · the core rules in AGENTS\.md are this version's now$/m);
  assert.match(text, /^ {2}note {8}the file before it is kept as AGENTS\.md\.before-yokoten;/m);
});

test('update: a refusal is a failure whose last line is the command to run (R5)', () => {
  const refused: UpdateResult = { ...PREVIEW, ok: false, state: 'no rules', changes: [], problem: { id: 'update', what: 'there is no AGENTS.md here, so nothing changed', why: '', fix: 'yokoten init' } };
  const text = checked(updateScreen(refused), true);
  assert.equal(text, 'yokoten update · there is no AGENTS.md here, so nothing changed\n\nNext: `yokoten init`\n');
});

test('update --all: every line that differs, wrapped under its mark, then the command that writes it', () => {
  const text = checked(updateAllScreen(PREVIEW));
  assert.match(text, /^Lines:\n {2}\+ \| 9 \| Nothing reaches main/m);
  assert.match(text, /^ {2}\+ \(a blank line\)$/m);
  assert.match(text, /Next: `yokoten update --write`\n$/);
  // Up to date, --all says the same one line as update.
  assert.deepEqual(updateAllScreen({ ...PREVIEW, state: 'up to date', changes: [] }), updateScreen({ ...PREVIEW, state: 'up to date', changes: [] }));
});

test('trust: one screen names each agent, then the way back (#1027)', async () => {
  const sandbox = makeSandbox();
  mkdirSync(join(sandbox.home, '.codex'), { recursive: true });
  await sandbox.call(['init', '--no-ci']);
  const done = await sandbox.call(['trust'], { isTTY: true, extra: { NO_COLOR: '1' } });
  assert.equal(done.status, 0, done.stderr);
  const text = checked(done.stdout.replace(/^note: .*\n\n/, '').trimEnd().split('\n'));
  assert.match(text, /^yokoten trust · the guard now runs in Codex$/m);
  assert.match(text, /^ {2}done {8}Codex: this folder is trusted now$/m);
  assert.match(text, /^Undo: `yokoten trust --undo`$/m);
  // Again: nothing changed, so the title says so, and there is no way back to show (#1040).
  const again = await sandbox.call(['trust'], { isTTY: true, extra: { NO_COLOR: '1' } });
  assert.match(again.stdout, /^yokoten trust · already on in Codex; nothing changed$/m);
  assert.doesNotMatch(again.stdout, /Undo:/);
});

test('trust screen: a store yokoten won\'t rewrite names the exact setting on a line of its own (#1040)', () => {
  const result: TrustResult = {
    ok: false,
    hasAgents: true,
    changes: [{ state: 'kept', kind: 'agent', path: '~/.codex/config.toml', agent: 'Codex', note: 'the trust in Codex' }],
    problems: [{ id: 'trust', what: "Copilot CLI: ~/.copilot/config.json holds the trust in a shape yokoten won't rewrite, so the guard stays off; add this there by hand", why: '', fix: 'trustedFolders = ["~/work/demo"]' }],
    notes: [],
  };
  const text = checked(trustScreen(result, false), true);
  assert.match(text, /^yokoten trust · the guard is not on yet$/m, 'never "now runs" when nothing was written');
  assert.match(text, /^ {14}Fix: `trustedFolders = \["~\/work\/demo"\]`$/m);
  assert.doesNotMatch(text, /Undo:/);
});

test('trust: not at a terminal it writes nothing, and the failure names the command a person runs (#661)', async () => {
  const sandbox = makeSandbox();
  const result = await sandbox.call(['trust']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^yokoten trust · a person runs this at a terminal/m);
  assert.match(result.stderr, /\n\nNext: open a terminal yourself and type `yokoten trust` there\n$/);
  checked(failure('trust', TRUST_NEEDS_A_PERSON.what, TRUST_NEEDS_A_PERSON.next), true);
});
