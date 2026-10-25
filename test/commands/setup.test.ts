// Tests for src/commands/setup.ts.

import '../repo/home.ts';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { test } from 'node:test';
import { claudeCommand, previewLines, updateScreen } from '../../src/commands/setup.ts';
import { VERSION } from '../../src/setup/files.ts';
import { makeSandbox } from '../repo/helpers.ts';

test('update: a folder that does not exist is said plainly (#208)', () => {
  const sandbox = makeSandbox();
  // update's entry, through the real binary.
  const result = sandbox.run(['update', 'typo']);
  assert.deepEqual([result.status, result.stdout, result.stderr], [1, '', 'yokoten update: typo does not exist; nothing to update.\n']);
  assert.ok(!existsSync(join(sandbox.repo, 'typo')));
});

test('start: bare yokoten installs, adds the rules, then shows the road (#548)', async () => {
  const sandbox = makeSandbox();
  const first = await sandbox.call([]);
  // The first run says what it wrote on this computer and here, then doctor's screen (#1027).
  assert.match(first.stdout, new RegExp(`^yokoten ${VERSION.replaceAll('.', '\\.')} · first run$`, 'm'));
  assert.match(first.stdout, /^yokoten init · this project is set up$/m);
  assert.match(first.stdout, /^yokoten doctor · stage 1 of 5, safety net$/m);
  assert.match(first.stdout, /^Next: `git add -A && git commit -m "chore: add yokoten"`$/m);
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

test('start: a shell that is not UTC ends doctor\'s full report on the line for that shell (#932)', async () => {
  const sandbox = makeSandbox();
  const result = await sandbox.call(['doctor', '--all'], { extra: { TZ: 'America/New_York', SHELL: '/bin/zsh' } });
  const last = result.stdout.trimEnd().split('\n').at(-1) ?? '';
  assert.match(last, /^yokoten: your shell's time zone is not UTC, so each commit would carry it\./);
  assert.match(last, /`export TZ=UTC`/);
  assert.match(last, /~\/\.zshrc/);
  assert.equal(result.stdout.match(/time zone is not UTC/g)?.length, 1, 'said once');
});

test('start: outside a git repo it writes nothing and names git first (#548)', async () => {
  const sandbox = makeSandbox();
  const outside = join(sandbox.home, 'outside');
  mkdirSync(outside);
  // The test's temp folder sits inside a checkout here, so git is told to stop walking at it.
  const result = await sandbox.call([], { cwd: outside, extra: { GIT_CEILING_DIRECTORIES: dirname(outside) } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /is not inside a git repo/);
  assert.match(result.stderr, /git init/);
  assert.deepEqual(existsSync(join(outside, 'AGENTS.md')), false);
});

test('start: with no full home path it says so plainly and writes nothing (#548)', async () => {
  const sandbox = makeSandbox();
  // A relative HOME is the case install already answers with a normal failure: bare `yokoten` must too.
  const result = await sandbox.call([], { extra: { HOME: 'relative-home' } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^yokoten finds no home folder \(HOME is empty or not a full path\), so it has no place outside the repo\. Set HOME to your home folder's full path and run `yokoten` again\.$/m);
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

// ---- upgrade (#950): a fake `claude` first on PATH writes its arguments and the git
// variables it got. The real `claude` is never run. ----

/** What one run of the fake `claude` saw: its words, and the last per-process git config entry. */
interface FakeCall {
  args: string;
  count: string;
  key: string;
  value: string;
  /** The first entry, which is the user's own when they set one. */
  first: string;
}

const FAKE_CLAUDE = [
  '#!/bin/sh',
  '{',
  '  echo "CALL $*"',
  '  echo "COUNT ${GIT_CONFIG_COUNT:-}"',
  '  last=$(( ${GIT_CONFIG_COUNT:-0} - 1 ))',
  '  echo "KEY $(printenv "GIT_CONFIG_KEY_$last")"',
  '  echo "VALUE $(printenv "GIT_CONFIG_VALUE_$last")"',
  '  echo "FIRST ${GIT_CONFIG_KEY_0:-}"',
  '} >> "$FAKE_CLAUDE_LOG"',
  'echo "ran: $*"',
  // A call that starts with FAKE_CLAUDE_FAIL fails.
  'case "$*" in "${FAKE_CLAUDE_FAIL:-none}"*) exit 1 ;; esac',
].join('\n');

/** Puts a fake `claude` first on PATH, and gives back the extra env and a reader of its log. */
function fakeClaude(sandbox: ReturnType<typeof makeSandbox>, failsOn = 'none') {
  const bin = join(sandbox.home, 'fake-bin');
  mkdirSync(bin, { recursive: true });
  const file = join(bin, 'claude');
  writeFileSync(file, `${FAKE_CLAUDE}\nexit 0\n`);
  chmodSync(file, 0o755);
  const log = join(sandbox.home, 'claude.log');
  const extra = { PATH: `${bin}:${process.env.PATH}`, FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_FAIL: failsOn };
  const calls = (): FakeCall[] => {
    if (!existsSync(log)) return [];
    const lines = readFileSync(log, 'utf8').split('\n');
    const found: FakeCall[] = [];
    for (let at = 0; at + 4 < lines.length; at += 5) {
      const after = (offset: number) => lines[at + offset].replace(/^[A-Z]+ ?/, '');
      found.push({ args: after(0), count: after(1), key: after(2), value: after(3), first: after(4) });
    }
    return found;
  };
  return { extra, calls };
}

/** The sandbox home with the plugin on under `id`, and the marketplace recorded the way given. */
function withPlugin(sandbox: ReturnType<typeof makeSandbox>, source: unknown, id = 'yokoten-beta@yokoten') {
  const claude = join(sandbox.home, '.claude');
  mkdirSync(join(claude, 'plugins'), { recursive: true });
  writeFileSync(join(claude, 'settings.json'), JSON.stringify({ enabledPlugins: { [id]: true } }));
  writeFileSync(join(claude, 'plugins', 'known_marketplaces.json'), JSON.stringify({ yokoten: { source } }));
}

// The sandbox sets two git entries of its own (test/repo/helpers.ts), so the override is the third.
const HTTPS_GIT = { count: '3', key: 'url.https://github.com/.insteadOf', value: 'git@github.com:' };
const SSH_SOURCE = { source: 'github', repo: 'yokoten-labs/yokoten' };
const HTTPS_SOURCE = { source: 'git', url: 'https://github.com/yokoten-labs/yokoten.git' };

test('upgrade: the two updates carry the HTTPS override, and nothing is removed or added', async () => {
  for (const source of [SSH_SOURCE, HTTPS_SOURCE]) {
    const sandbox = makeSandbox();
    withPlugin(sandbox, source);
    const fake = fakeClaude(sandbox);
    const result = await sandbox.call(['upgrade'], { extra: fake.extra });
    assert.equal(result.status, 0, result.stderr);
    const calls = fake.calls();
    // A remove would leave no marketplace when the next clone fails, so there is none.
    assert.deepEqual(calls.map((call) => call.args), ['plugin marketplace update yokoten', 'plugin update yokoten-beta@yokoten'], JSON.stringify(source));
    for (const call of calls) assert.deepEqual({ count: call.count, key: call.key, value: call.value }, HTTPS_GIT, `${call.args} carries the override`);
    assert.match(result.stdout, /^Next: `restart Claude Code to use it`$/m);
  }
});

test('upgrade: without the plugin it names npx and runs nothing', async () => {
  const sandbox = makeSandbox();
  const fake = fakeClaude(sandbox);
  const result = await sandbox.call(['upgrade'], { extra: fake.extra });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Next: `npx yokoten@latest`$/m);
  assert.deepEqual(fake.calls(), []);
});

test('upgrade: a failing step stops the rest and gives the command to run by hand', async () => {
  const sandbox = makeSandbox();
  withPlugin(sandbox, HTTPS_SOURCE);
  const fake = fakeClaude(sandbox, 'plugin');
  const result = await sandbox.call(['upgrade'], { extra: fake.extra });
  assert.equal(result.status, 1);
  assert.equal(fake.calls().length, 1, 'the second step waits for the first');
  assert.match(result.stderr, /^failed {2}updated the marketplace yokoten$/m);
  assert.match(result.stderr, /^To see the whole message, run this by hand: claude plugin marketplace update yokoten$/m);
});

test('upgrade: a git config the user set the same way is kept, and the override comes after it', async () => {
  const sandbox = makeSandbox();
  withPlugin(sandbox, HTTPS_SOURCE);
  const fake = fakeClaude(sandbox);
  const own = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.proxy', GIT_CONFIG_VALUE_0: 'http://proxy.example.com:8080' };
  const result = await sandbox.call(['upgrade'], { extra: { ...fake.extra, ...own } });
  assert.equal(result.status, 0, result.stderr);
  for (const call of fake.calls()) {
    assert.deepEqual({ count: call.count, key: call.key, value: call.value, first: call.first }, { ...HTTPS_GIT, count: '2', first: 'http.proxy' }, call.args);
  }
});

test('upgrade: a GIT_CONFIG_COUNT that is set but not a small number runs nothing', async () => {
  for (const count of ['abc', '1.5', '+2', '-1', '2 ', '1000', '9007199254740993']) {
    const sandbox = makeSandbox();
    withPlugin(sandbox, HTTPS_SOURCE);
    const fake = fakeClaude(sandbox);
    const result = await sandbox.call(['upgrade'], { extra: { ...fake.extra, GIT_CONFIG_COUNT: count } });
    assert.equal(result.status, 1, count);
    assert.deepEqual(fake.calls(), [], `${count}: no call`);
    assert.match(result.stderr, /GIT_CONFIG_COUNT is set, but not to a small number/, count);
  }
});

test('upgrade: a marketplace name that is not plain runs nothing, so it never reaches a shell line', async () => {
  for (const name of ['x&calc', 'x%PATH%', 'a b', 'x"y']) {
    const sandbox = makeSandbox();
    withPlugin(sandbox, HTTPS_SOURCE, `yokoten-beta@${name}`);
    const fake = fakeClaude(sandbox);
    const result = await sandbox.call(['upgrade'], { extra: fake.extra });
    assert.equal(result.status, 1, name);
    assert.deepEqual(fake.calls(), [], `${name}: no call`);
    assert.match(result.stderr, /the marketplace name in your settings is not a plain name/, name);
  }
});

// ---- One screen per command (#1027) ----

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

test('install: the preview says what changes and how to undo it (#1027)', async () => {
  const sandbox = makeSandbox();
  const lines = previewLines(sandbox.env, true, true);
  assert.match(lines.join('\n'), /^yokoten \d+\.\d+\.\d+ · first run: here is what changes$/m);
  assert.match(lines.join('\n'), /^ {2}computer +guard on for Claude Code, 7 skills$/m);
  assert.match(lines.join('\n'), /^ {2}project +AGENTS\.md, the commit check, CI and the templates$/m);
  assert.match(lines.join('\n'), /^Undo: `yokoten uninstall`$/m);
  for (const line of lines) assert.ok(line.length <= 80, line);
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
  assert.match(again.stdout, /^yokoten uninstall · nothing to remove, nothing changed$/m);
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

test('help: upgrade is in the Start group', async () => {
  const help = (await makeSandbox().call(['help'])).stdout;
  const start = help.slice(help.indexOf('Start:'), help.indexOf('Every day:'));
  assert.match(start, /^ {2}upgrade +yokoten itself, to the newest version$/m);
});

test('upgrade on Windows (#1002): finds claude.exe, or claude.cmd, on the PATH', () => {
  const sandbox = makeSandbox();
  const folder = (name: string, ...files: string[]) => {
    const dir = join(sandbox.home, name);
    mkdirSync(dir, { recursive: true });
    for (const file of files) writeFileSync(join(dir, file), '');
    return dir;
  };
  const exeOnly = folder('native', 'claude.exe');
  const cmdOnly = folder('npm', 'claude.cmd');
  const empty = folder('empty');
  // The native installer: only claude.exe, which runs without the shell.
  assert.deepEqual(claudeCommand({ PATH: `${empty};${exeOnly}` }, 'win32'), { file: join(exeOnly, 'claude.exe'), shell: false });
  // An npm install: only claude.cmd, which the shell finds by its name.
  assert.deepEqual(claudeCommand({ PATH: `${empty};${cmdOnly}` }, 'win32'), { file: 'claude.cmd', shell: true });
  // Both in one folder: .exe first.
  assert.equal(claudeCommand({ Path: folder('both', 'claude.cmd', 'claude.exe') }, 'win32').shell, false);
  // Positive control: neither found falls back to the shell; Linux never uses it.
  assert.deepEqual(claudeCommand({ PATH: empty }, 'win32'), { file: 'claude.cmd', shell: true });
  assert.deepEqual(claudeCommand({ PATH: exeOnly }, 'linux'), { file: 'claude', shell: false });
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
