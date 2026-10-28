// Tests for src/commands/more/setup/init.ts.

import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { commitCommand, initListScreen, initScreen, planScreen } from '../../../../src/commands/more/setup/init.ts';
import { init } from '../../../../src/setup/init.ts';
import { setUpPlanning } from '../../../../src/setup/plan.ts';
import { screenProblems } from '../../../repo/docs/screen-rules.ts';
import { fakeGh, makeSandbox } from '../../../repo/helpers.ts';

const LINUX = { platform: 'linux' } as const;

/** A screen's lines as one text, checked against the screen rules: none may break (#1115). */
function checked(lines: string[], isFailure = false): string {
  const text = `${lines.join('\n')}\n`;
  assert.deepEqual(screenProblems({ text, isFailure }), [], text);
  return text;
}

test('init screen: a fresh project names each group it wrote, the file count, and one Next line', () => {
  const sandbox = makeSandbox();
  const done = init(sandbox.repo, sandbox.env, () => '');
  const text = checked(initScreen(done, LINUX));
  assert.match(text, /^yokoten init · this project is set up$/m);
  for (const group of ['rules: AGENTS.md, the commit check', 'CI: 4 workflows, Dependabot', 'GitHub: issue and PR templates, CODEOWNERS, a security policy', 'agents: guard for Claude Code (7 more ready)']) {
    assert.match(text, new RegExp(`^ {2}done {8}${group.replace(/[()]/g, '\\$&')}$`, 'm'), group);
  }
  assert.match(text, /^\d+ files written, none of yours changed$/m);
  assert.equal(text.match(/^Next: /gm)?.length, 1);
  assert.match(text, /^Next: `git add -A && git commit -m "chore: add yokoten"`$/m);
  // Positive control: on Windows the same screen ends with a command PowerShell runs (#1038).
  assert.match(checked(initScreen(done, { platform: 'win32' })), /^Next: `git add -A; git commit -m "chore: add yokoten"`$/m);
  assert.equal(commitCommand('darwin'), commitCommand('linux'));
});

test('init screen: run again it says nothing changed, and shows its notes, never folded (#1040)', () => {
  const sandbox = makeSandbox();
  mkdirSync(join(sandbox.home, '.codex'));
  init(sandbox.repo, sandbox.env, () => '');
  const again = init(sandbox.repo, sandbox.env, () => '');
  const text = checked(initScreen(again, LINUX));
  assert.match(text, /^yokoten init · already set up here, nothing changed$/m);
  assert.match(text, /^ {2}note {8}yokoten's guard is off in Codex until a person turns it on\n {14}Fix: `yokoten trust`$/m, 'the trust note keeps its command');
  assert.doesNotMatch(text, /^Next: /m, 'nothing to commit');
});

test('init screen: a partly new project counts what it added and what was there; a kept file of yours is a note', () => {
  const sandbox = makeSandbox();
  sandbox.write('AGENTS.md', '# ours\n\n## This project\n\nours\n');
  sandbox.write('CHANGELOG.md', '# ours\n');
  sandbox.write('.claude/settings.json', JSON.stringify({ env: { TZ: 'Europe/Paris' } }));
  const done = init(sandbox.repo, sandbox.env, () => '');
  const text = checked(initScreen(done, LINUX));
  assert.match(text, /^\d+ files added, 2 files already there$/m, 'AGENTS.md and CHANGELOG.md');
  assert.match(text, /^ {2}note {8}your TZ in \.claude\/settings\.json; yokoten wants UTC/m);
  assert.doesNotMatch(text, /Europe\/Paris/, 'the value is not shown');
});

test('init --list: every change under the heading of its group, then the notes', () => {
  const sandbox = makeSandbox();
  const done = init(sandbox.repo, sandbox.env, () => '');
  const text = checked(initListScreen(done, LINUX));
  for (const heading of ['The rules:', 'CI:', 'GitHub:', 'The agents:', 'Other files:']) assert.match(text, new RegExp(`^${heading}$`, 'm'), heading);
  assert.match(text, /^The rules:\n {2}updated the commit check, run from \.githooks$/m, 'the commit check leads (#654)');
  assert.match(text, /^ {2}wrote \.github\/CODEOWNERS /m);
  assert.match(text, /^ {2}added the Codex tool-call hook in \.codex\/hooks\.json$/m);
});

test('init --github: the plan is a section of rows, and the command that does it', () => {
  const sandbox = makeSandbox();
  const done = init(sandbox.repo, sandbox.env, () => '');
  const plan = setUpPlanning(fakeGh(['bug'], []).gh, 'https://github.com/me/repo.git', { apply: false, removeDefaults: false });
  const text = checked(initScreen({ ...done, plan }, LINUX));
  assert.match(text, /^On GitHub, me\/repo:$/m);
  assert.match(text, /^ {2}to do {7}make milestone "First release"$/m);
  assert.match(text, /^ {2}To do these on GitHub: `yokoten init --github --yes`$/m);
  // Skipped: one note with the reason and the fix, on its own line.
  const skipped = planScreen(setUpPlanning(() => '', '', { apply: false, removeDefaults: false }));
  assert.match(skipped.join('\n'), /^ {2}note {8}GitHub was not read: there is no origin remote yet;/);
  assert.match(skipped.join('\n'), /Fix: `yokoten init --github --yes`$/);
});

test('init screen: a step left for the person is a MISSING row with its fix; the title says partly set up', () => {
  const sandbox = makeSandbox();
  const done = init(sandbox.repo, sandbox.env, () => '');
  const left = { ...done, problems: [{ id: 'hooks-path', what: 'husky is not set up in this clone yet, so the commit check is not on yet', why: '', fix: 'npm install' }] };
  const text = checked(initScreen(left, LINUX));
  assert.match(text, /^yokoten init · this project is partly set up$/m);
  assert.match(text, /^ {2}MISSING {5}husky is not set up in this clone yet, so the commit check is not\n {14}on yet\n {14}Fix: `npm install`$/m);
});

test('init: a folder that does not exist is a failure with one Next line, and nothing is written (#205)', async () => {
  const sandbox = makeSandbox();
  const result = await sandbox.call(['init', 'typo']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^yokoten init · typo does not exist, so nothing was written\n\nNext: `git init typo`$/m);
});

test('init: in a project it writes the rules and shows one Next line', () => {
  const sandbox = makeSandbox();
  // init's entry, through the real binary.
  const result = sandbox.run(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.match(/^Next: /gm)?.length, 1);
});

test('init --github --yes: a skip changed nothing on GitHub, so it fails, after the screen of the files', async () => {
  const sandbox = makeSandbox();
  writeFileSync(join(sandbox.repo, 'notes.txt'), 'x\n');
  const result = await sandbox.call(['init', '--github', '--yes']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^yokoten init · this project is set up$/m);
  assert.match(result.stderr, /^yokoten init · --github --yes changed nothing on GitHub; the project files are\n {15}as shown above\n\nNext: `yokoten init --github --yes`$/m);
});
