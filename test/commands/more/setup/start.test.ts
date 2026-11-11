// Tests for src/commands/more/setup/start.ts.

import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { previewLines, SET_UP_QUESTION, startScreen, type StartParts } from '../../../../src/commands/more/setup/start.ts';
import { type DoctorReport } from '../../../../src/setup/doctor/index.ts';
import { type Change, type SetupResult } from '../../../../src/setup/files.ts';
import { finding } from '../../../../src/rules/text/message.ts';
import { screenProblems, underMark } from '../../../repo/docs/screen-rules.ts';
import { VERSION } from '../../../../src/setup/files.ts';
import { setupNote } from '../../../../src/setup/init.ts';
import { commitCommand } from '../../../../src/commands/more/setup/init.ts';
import { makeSandbox } from '../../../repo/helpers.ts';

test('start: bare yokoten installs, adds the rules, then shows the road (#548)', async () => {
  const sandbox = makeSandbox();
  const first = await sandbox.call([]);
  // One screen (#1027): the title says it set up and the stage, one row per step, one Next line, then More.
  assert.match(first.stdout, new RegExp(`^yokoten ${VERSION.replaceAll('.', '\\.')} · set up; stage 1 of 5, safety net$`, 'm'));
  assert.match(first.stdout, /^ {2}ok {11}guard on for .+ on this computer$/m);
  assert.match(first.stdout, /^ {2}ok {11}\d+ files written in this project, none of yours changed$/m);
  assert.equal(first.stdout.match(/^Next: /gm)?.length, 1, 'one Next line');
  // The commit command as the product builds it for this system (one source: commitCommand).
  assert.ok(first.stdout.includes(`Next: \`${commitCommand(process.platform)}\`\nMore: `), first.stdout);
  assert.ok(first.stdout.split('\n').every((line) => line.length <= 80), 'every line fits 80 columns');
  assert.ok(existsSync(join(sandbox.repo, 'AGENTS.md')), 'the rules are in the project');
  assert.ok(existsSync(join(sandbox.repo, 'yokoten.json')), 'init wrote yokoten.json');
  assert.ok(existsSync(join(sandbox.home, '.local', 'share', 'yokoten', 'bin', 'yokoten.mjs')), 'install wrote the runtime');
  // The second run does only what is left: the road and nothing to install or add.
  const again = await sandbox.call([]);
  assert.doesNotMatch(again.stdout, /this computer is set up/);
  assert.doesNotMatch(again.stdout, /this project is set up/);
  assert.match(again.stdout, /^yokoten doctor · stage 1 of 5, safety net$/m);
  assert.doesNotMatch(again.stdout, /^Next: `git add -A/, 'nothing new to commit');
});

test('start: a shell that is not UTC gets doctor\'s full report line for that shell (#932)', async () => {
  const sandbox = makeSandbox();
  const result = await sandbox.call(['doctor', '--all'], { extra: { TZ: 'America/New_York', SHELL: '/bin/zsh' } });
  const said = result.stdout.split('\n\n').find((block) => /time zone is not UTC/.test(block)) ?? '';
  assert.match(said, /^ {2}note {9}shell: your shell's time zone is not UTC, so each commit would\n/);
  assert.match(said, /`export TZ=UTC`/);
  assert.match(said, /~\/\.zshrc/);
  assert.equal(result.stdout.match(/time zone is not UTC/g)?.length, 1, 'said once');
});

test('start: outside a git repo it writes nothing and names git first (#548)', async () => {
  const sandbox = makeSandbox();
  const outside = join(sandbox.home, 'outside');
  mkdirSync(outside);
  // The test's temp folder sits inside a checkout here, so git is told to stop walking at it.
  const result = await sandbox.call([], { cwd: outside, extra: { GIT_CEILING_DIRECTORIES: dirname(outside) } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /this folder is not in a git repo/);
  assert.match(result.stderr, /git init/);
  assert.deepEqual(existsSync(join(outside, 'AGENTS.md')), false);
});

test('start: with no full home path it says so plainly and writes nothing (#548)', async () => {
  const sandbox = makeSandbox();
  // A relative HOME is the case install already answers with a normal failure: bare `yokoten` must too.
  const result = await sandbox.call([], { extra: { HOME: 'relative-home' } });
  assert.equal(result.status, 1);
  // One failure (#1115): the title says what is wrong, the Next line what to do.
  assert.match(result.stderr, /^yokoten · no home folder found \(HOME is empty or not a full path\), so nothing\n/);
  assert.match(result.stderr, /\n\nNext: set HOME to your home folder's full path, then run `yokoten` again\.\n$/);
  assert.doesNotMatch(result.stderr, /undefined/, 'no command has no name, never "undefined"');
  assert.deepEqual([existsSync(join(sandbox.repo, 'AGENTS.md')), existsSync(join(sandbox.repo, 'yokoten.json'))], [false, false], 'nothing was written');
});

test('start: help still prints the command list (#548)', async () => {
  const sandbox = makeSandbox();
  const result = await sandbox.call(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: yokoten <command> \[options\]/);
  assert.match(result.stdout, /Start here: run `yokoten` in your project/);
});

test('install: the preview says what changes and how to undo it (#1027)', async () => {
  const sandbox = makeSandbox();
  const lines = previewLines(sandbox.env, true, true);
  assert.match(lines.join('\n'), /^yokoten \d+\.\d+\.\d+ · first run: here is what changes$/m);
  assert.match(lines.join('\n'), /^ {2}computer +guard on for Claude Code, 7 skills$/m);
  assert.match(lines.join('\n'), /^ {2}project +AGENTS\.md, the commit check, CI and the templates$/m);
  assert.match(lines.join('\n'), /^Undo: `yokoten uninstall`$/m);
  for (const line of lines) assert.ok(line.length <= 80, line);
});

// ---- The first run's screen, from its parts (#1115): install's and init's results and doctor's report ----

/** A doctor report at stage 1: two steps done, one next, one to do. */
const REPORT: DoctorReport = {
  version: VERSION, channel: 'stable', ok: true, selfTest: { ok: true, failed: [], ran: true, skipped: [] }, repo: true, stage: 1,
  stages: ['safety net', 'issues and pull requests', 'release', 'a team of agents', 'going public'],
  next: { id: 'tests', what: 'no workflow runs the tests', why: 'it matters', fix: '`yokoten init` adds it' }, findings: [],
  steps: [{ id: 'rules', stage: 1, mark: 'done' }, { id: 'tool-hook', stage: 1, mark: 'done' }, { id: 'tests', stage: 1, mark: 'next' }, { id: 'templates', stage: 2, mark: 'to do' }],
  notes: [],
};

/** Install's result: the guard on for Claude Code and Codex CLI. */
const INSTALLED: SetupResult = {
  ok: true,
  changes: [
    { state: 'wrote', kind: 'runtime', path: '~/.local/share/yokoten' },
    { state: 'added', kind: 'hook', path: '~/.claude/settings.json', agent: 'Claude Code', note: 'command guard' },
    { state: 'added', kind: 'hook', path: '~/.codex/hooks.json', agent: 'Codex CLI', note: 'command guard' },
  ],
  problems: [],
  notes: [],
};

/** Init's result: three project files and the git setting, which is not a file. */
const ADDED: SetupResult = {
  ok: true,
  changes: (['AGENTS.md', 'yokoten.json', '.github/workflows/yokoten.yml'].map((path): Change => ({ state: 'wrote', kind: 'file', path }))).concat({ state: 'wrote', kind: 'git-hook', path: 'core.hooksPath' }),
  problems: [],
  notes: [],
};

const placeFor = (platform: NodeJS.Platform): StartParts['place'] => ({ platform, home: '~', hasProjectRules: false, launcherOnPath: true });

test('start: the first run\'s screen says what each part did, then the road, then the commit (#1115)', () => {
  const lines = startScreen({ install: INSTALLED, init: ADDED, report: REPORT, place: placeFor('linux') });
  assert.deepEqual(lines.slice(0, 4), [`yokoten ${VERSION} · set up; stage 1 of 5, safety net`, '', '  ok           guard on for Claude Code, Codex CLI on this computer', '  ok           3 files written in this project, none of yours changed']);
  assert.equal(lines.filter((line) => line.startsWith('Next: ')).length, 1, 'one Next line');
  assert.ok(lines.includes('Next: `git add -A && git commit -m "chore: add yokoten"`'), lines.join('\n'));
  assert.match(lines.at(-1) ?? '', /^More: /);
  assert.equal(lines.filter((line, at) => line === '' && lines[at - 1] === '').length, 0, 'never two blank lines');
  assert.deepEqual(screenProblems({ text: lines.join('\n') }), []);
  // Windows PowerShell 5 has no `&&`: the commit command there uses `;` (#1038).
  assert.ok(startScreen({ install: INSTALLED, init: ADDED, report: REPORT, place: placeFor('win32') }).includes('Next: `git add -A; git commit -m "chore: add yokoten"`'));
});

test('start: a sandbox init wrote or kept gets one row after the files row (#1360)', () => {
  const sandbox: Change = { state: 'added', kind: 'setting', path: '.claude/settings.json', agent: 'Claude Code', isSandbox: true, note: 'the Claude Code sandbox in .claude/settings.json' };
  const lines = startScreen({ install: INSTALLED, init: { ...ADDED, changes: [...ADDED.changes, sandbox] }, report: REPORT, place: placeFor('linux') });
  assert.deepEqual(lines.slice(2, 5), ['  ok           guard on for Claude Code, Codex CLI on this computer', '  ok           4 files written in this project, none of yours changed', '  ok           sandbox on for Claude Code in this project']);
  // A kept sandbox counts too, and an agent is named once.
  const kept: Change[] = [{ ...sandbox, state: 'kept' }, { ...sandbox, state: 'kept', agent: 'Codex', path: '.codex/config.toml' }];
  const text = startScreen({ init: { ...ADDED, changes: [...ADDED.changes, ...kept] }, report: REPORT, place: placeFor('linux') }).join('\n');
  assert.match(text, /^ {2}ok {11}sandbox on for Claude Code, Codex in this project$/m);
});

test('start: a sandbox of yours that differs gets no row, a same one does (#1360)', () => {
  const same: Change = { state: 'kept', kind: 'setting', path: '.claude/settings.json', agent: 'Claude Code', isSandbox: true };
  const yours: Change = { state: 'kept', kind: 'setting', path: '.codex/config.toml', agent: 'Codex', isSandbox: true, yours: true };
  const text = startScreen({ init: { ...ADDED, changes: [...ADDED.changes, same, yours] }, report: REPORT, place: placeFor('linux') }).join('\n');
  assert.match(text, /^ {2}ok {11}sandbox on for Claude Code in this project$/m);
  assert.equal(startScreen({ init: { ...ADDED, changes: [...ADDED.changes, yours] }, report: REPORT, place: placeFor('linux') }).some((line) => line.includes('sandbox on')), false);
});

test('start: a written sandbox and a skipped one show the ok row and the problem (#1360)', () => {
  const written: Change = { state: 'added', kind: 'setting', path: '.claude/settings.json', agent: 'Claude Code', isSandbox: true };
  const skipped: SetupResult = { ...ADDED, ok: false, changes: [...ADDED.changes, written], problems: [setupNote('sandbox', "skipped the Grok sandbox: can't read .grok/sandbox.toml; make it readable", 'yokoten init')] };
  const text = startScreen({ init: skipped, report: REPORT, place: placeFor('linux') }).join('\n');
  assert.match(text, /^ {2}ok {11}sandbox on for Claude Code in this project$/m);
  // The problem text wraps at 80 columns, so the match stops before the wrap.
  assert.match(text, /^ {2}MISSING {6}skipped the Grok sandbox: can't read \.grok\/sandbox\.toml; make it$/m);
});

test('start: no sandbox change means no sandbox row (#1360)', () => {
  const lines = startScreen({ install: INSTALLED, init: ADDED, report: REPORT, place: placeFor('linux') });
  assert.equal(lines.some((line) => line.includes('sandbox on')), false, lines.join('\n'));
  // A setting that is not a sandbox, even with an agent, is no sandbox row.
  const tz: Change = { state: 'kept', kind: 'setting', path: '.claude/settings.json', agent: 'Claude Code', yours: true };
  assert.equal(startScreen({ init: { ...ADDED, changes: [...ADDED.changes, tz] }, report: REPORT, place: placeFor('linux') }).some((line) => line.includes('sandbox on')), false);
});

test('start: an install that failed keeps its problem with the Fix line, and the title says partly (#1027, #1115)', () => {
  const failed: SetupResult = {
    ...INSTALLED,
    ok: false,
    changes: INSTALLED.changes.filter((change) => change.agent !== 'Codex CLI'),
    problems: [finding('codex-user-hook', '~/.codex/hooks.json is not valid JSON', 'run `yokoten install` again', { why: 'the guard is not on for Codex CLI until it is valid JSON' })],
  };
  const lines = startScreen({ install: failed, init: ADDED, report: REPORT, place: placeFor('linux') });
  const text = lines.join('\n');
  assert.match(lines[0] ?? '', / · partly set up; stage 1 of 5/);
  assert.match(text, /^ {2}ok {11}guard on for Claude Code on this computer$/m, 'the guard it did turn on');
  assert.match(text, /^ {2}MISSING {6}~\/\.codex\/hooks\.json is not valid JSON$/m);
  assert.match(text, underMark(/^ {COL}Fix: `yokoten install`$/m));
  assert.deepEqual(screenProblems({ text, isFailure: true }), []);
  // Only install ran: no commit to make, so doctor's own Next stays.
  const alone = startScreen({ install: INSTALLED, report: REPORT, place: placeFor('linux') });
  assert.ok(alone.includes('Next: `yokoten init`'), alone.join('\n'));
});

test('start: the preview and its question keep the screen rules (#1027, #1115)', () => {
  const lines = previewLines(makeSandbox().env, true, true);
  assert.deepEqual(screenProblems({ text: lines.join('\n') }), []);
  assert.equal(lines.filter((line) => line === '').length, 3, 'the title, the two groups and the way back, a blank line between');
  assert.equal(SET_UP_QUESTION, 'Set up yokoten here? [Y/n]');
});
