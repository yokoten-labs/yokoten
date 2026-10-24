// Tests for src/commands/setup.ts.

import '../repo/home.ts';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { test } from 'node:test';
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
  assert.match(first.stdout, /^yokoten is not installed on this machine yet/m);
  assert.match(first.stdout, /^This project has no yokoten rules yet/m);
  assert.match(first.stdout, /^Setup is done\. Here is where this project is now:$/m);
  assert.match(first.stdout, /the road: stage 1 of 5/);
  assert.ok(existsSync(join(sandbox.repo, 'AGENTS.md')), 'the rules are in the project');
  assert.ok(existsSync(join(sandbox.repo, 'yokoten.json')), 'init wrote yokoten.json');
  assert.ok(existsSync(join(sandbox.home, '.local', 'share', 'yokoten', 'bin', 'yokoten.mjs')), 'install wrote the runtime');
  // The second run does only what is left: the road and nothing to install or add.
  const again = await sandbox.call([]);
  assert.doesNotMatch(again.stdout, /not installed on this machine yet/);
  assert.doesNotMatch(again.stdout, /no yokoten rules yet/);
  assert.doesNotMatch(again.stdout, /Setup is done/);
  assert.match(again.stdout, /the road: stage 1 of 5/);
});

test('start: a shell that is not UTC ends on the line for that shell (#932)', async () => {
  const sandbox = makeSandbox();
  const result = await sandbox.call([], { extra: { TZ: 'America/New_York', SHELL: '/bin/zsh' } });
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

/** What one run of the fake `claude` saw: its words, and the per-process git config. */
interface FakeCall {
  args: string;
  count: string;
  key: string;
  value: string;
}

const FAKE_CLAUDE = [
  '#!/bin/sh',
  '{',
  '  echo "CALL $*"',
  '  echo "COUNT ${GIT_CONFIG_COUNT:-}"',
  '  echo "KEY ${GIT_CONFIG_KEY_0:-}"',
  '  echo "VALUE ${GIT_CONFIG_VALUE_0:-}"',
  '} >> "$FAKE_CLAUDE_LOG"',
  'echo "ran: $*"',
].join('\n');

/** Puts a fake `claude` first on PATH, and gives back the extra env and a reader of its log. */
function fakeClaude(sandbox: ReturnType<typeof makeSandbox>, isFailing = false) {
  const bin = join(sandbox.home, 'fake-bin');
  mkdirSync(bin, { recursive: true });
  const file = join(bin, 'claude');
  writeFileSync(file, `${FAKE_CLAUDE}\nexit ${isFailing ? 1 : 0}\n`);
  chmodSync(file, 0o755);
  const log = join(sandbox.home, 'claude.log');
  const extra = { PATH: `${bin}:${process.env.PATH}`, FAKE_CLAUDE_LOG: log };
  const calls = (): FakeCall[] => {
    if (!existsSync(log)) return [];
    const lines = readFileSync(log, 'utf8').split('\n');
    const found: FakeCall[] = [];
    for (let at = 0; at + 3 < lines.length; at += 4) {
      found.push({ args: lines[at].replace(/^CALL /, ''), count: lines[at + 1].replace(/^COUNT /, ''), key: lines[at + 2].replace(/^KEY /, ''), value: lines[at + 3].replace(/^VALUE /, '') });
    }
    return found;
  };
  return { extra, calls };
}

/** The sandbox home with the plugin on, and the marketplace recorded the way given. */
function withPlugin(sandbox: ReturnType<typeof makeSandbox>, source: unknown) {
  const claude = join(sandbox.home, '.claude');
  mkdirSync(join(claude, 'plugins'), { recursive: true });
  writeFileSync(join(claude, 'settings.json'), JSON.stringify({ enabledPlugins: { 'yokoten-beta@yokoten': true } }));
  writeFileSync(join(claude, 'plugins', 'known_marketplaces.json'), JSON.stringify({ yokoten: { source } }));
}

const HTTPS_GIT = { count: '1', key: 'url.https://github.com/.insteadOf', value: 'git@github.com:' };

test('upgrade: a github marketplace moves to HTTPS, then the two updates carry the override', () => {
  const sandbox = makeSandbox();
  withPlugin(sandbox, { source: 'github', repo: 'yokoten-labs/yokoten' });
  const fake = fakeClaude(sandbox);
  const result = sandbox.run(['upgrade'], { extra: fake.extra });
  assert.equal(result.status, 0, result.stderr);
  const calls = fake.calls();
  assert.deepEqual(calls.map((call) => call.args), [
    'plugin marketplace remove yokoten',
    'plugin marketplace add https://github.com/yokoten-labs/yokoten.git',
    'plugin install yokoten-beta@yokoten',
    'plugin marketplace update yokoten',
    'plugin update yokoten-beta@yokoten',
  ]);
  // Only the two update calls tell git to use HTTPS: the moves need it not.
  for (const call of calls.slice(0, 3)) assert.notEqual(call.key, HTTPS_GIT.key, `${call.args} carries no override`);
  for (const call of calls.slice(3)) assert.deepEqual({ count: call.count, key: call.key, value: call.value }, HTTPS_GIT, `${call.args} carries the override`);
  assert.match(result.stdout, /^ok {6}removed the marketplace yokoten$/m);
  assert.match(result.stdout, /^Restart Claude Code to load it: a session that is already running keeps the old copy until it restarts\.$/m);
});

test('upgrade: an HTTPS marketplace is not moved, and only the two updates run', () => {
  const sandbox = makeSandbox();
  withPlugin(sandbox, { source: 'git', url: 'https://github.com/yokoten-labs/yokoten.git' });
  const fake = fakeClaude(sandbox);
  const result = sandbox.run(['upgrade'], { extra: fake.extra });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fake.calls().map((call) => call.args), ['plugin marketplace update yokoten', 'plugin update yokoten-beta@yokoten']);
  assert.doesNotMatch(result.stdout, /removed the marketplace/);
});

test('upgrade: without the plugin it names npx and runs nothing', () => {
  const sandbox = makeSandbox();
  const fake = fakeClaude(sandbox);
  const result = sandbox.run(['upgrade'], { extra: fake.extra });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^To get the newest yokoten, run: npx yokoten@latest$/m);
  assert.deepEqual(fake.calls(), []);
});

test('upgrade: a failing step stops the rest and gives the command to run by hand', () => {
  const sandbox = makeSandbox();
  withPlugin(sandbox, { source: 'git', url: 'https://github.com/yokoten-labs/yokoten.git' });
  const fake = fakeClaude(sandbox, true);
  const result = sandbox.run(['upgrade'], { extra: fake.extra });
  assert.equal(result.status, 1);
  assert.equal(fake.calls().length, 1, 'the second step waits for the first');
  assert.match(result.stderr, /^failed {2}updated the marketplace yokoten$/m);
  assert.match(result.stderr, /^To see the whole message, run this by hand: claude plugin marketplace update yokoten$/m);
});

test('help: upgrade is in the Start group', async () => {
  const help = (await makeSandbox().call(['help'])).stdout;
  const start = help.slice(help.indexOf('Start:'), help.indexOf('Every day:'));
  assert.match(start, /^ {2}upgrade +yokoten itself, to the newest version$/m);
});
