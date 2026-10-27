// Tests for src/commands/more/setup/upgrade.ts.

import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { claudeCommand } from '../../../../src/commands/more/setup/upgrade.ts';
import { makeSandbox } from '../../../repo/helpers.ts';

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

test('help: upgrade is in the help --all list', async () => {
  const start = (await makeSandbox().call(['help', '--all'])).stdout;
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
