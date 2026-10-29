// Tests for src/commands/more/setup/upgrade.ts.

import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { claudeCommand, upgradeScreen } from '../../../../src/commands/more/setup/upgrade.ts';
import { screenProblems, underMark } from '../../../repo/docs/screen-rules.ts';
import { makeSandbox, writeNodeProgram } from '../../../repo/helpers.ts';

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

// The fake claude, in Node so it runs on every system (writeNodeProgram): it logs each call's
// words and the git config entries it was given, and fails a call that starts with FAKE_CLAUDE_FAIL.
const FAKE_CLAUDE = `const fs = process.getBuiltinModule('node:fs');
const env = process.env;
const count = env.GIT_CONFIG_COUNT ?? '';
const last = Number(count || 0) - 1;
fs.appendFileSync(env.FAKE_CLAUDE_LOG, \`CALL \${args.join(' ')}\\nCOUNT \${count}\\nKEY \${env['GIT_CONFIG_KEY_' + last] ?? ''}\\nVALUE \${env['GIT_CONFIG_VALUE_' + last] ?? ''}\\nFIRST \${env.GIT_CONFIG_KEY_0 ?? ''}\\n\`);
process.stdout.write(\`ran: \${args.join(' ')}\\n\`);
if (args.join(' ').startsWith(env.FAKE_CLAUDE_FAIL ?? 'none')) process.exit(1);`;

/** Puts a fake `claude` first on PATH, and gives back the extra env and a reader of its log. */
function fakeClaude(sandbox: ReturnType<typeof makeSandbox>, failsOn = 'none') {
  const bin = join(sandbox.home, 'fake-bin');
  const log = join(sandbox.home, 'claude.log');
  const extra = { ...writeNodeProgram(bin, 'claude', FAKE_CLAUDE, process.platform, process.env), FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_FAIL: failsOn };
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
    assert.match(result.stdout, /^yokoten upgrade · the yokoten plugin is up to date \(beta channel\)$/m);
    assert.match(result.stdout, /^ {2}ok {10}the plugin yokoten-beta@yokoten: updated$/m);
    assert.match(result.stdout, /^Next: restart Claude Code; a session already running keeps the old copy$/m);
  }
});

test('upgrade: without the plugin it names npx and runs nothing', async () => {
  const sandbox = makeSandbox();
  const fake = fakeClaude(sandbox);
  const result = await sandbox.call(['upgrade'], { extra: fake.extra });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^yokoten upgrade · yokoten is not a Claude Code plugin here, so nothing changed$/m);
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
  // One screen on stderr (#1115): a MISSING row, what Claude Code said, and the command on its Fix line.
  assert.match(result.stderr, /^yokoten upgrade · the yokoten plugin was not updated, it is as it was$/m);
  assert.match(result.stderr, /^ {2}MISSING {5}the marketplace yokoten: not updated$/m);
  assert.match(result.stderr, underMark(/^ {COL}Claude Code said: ran: plugin marketplace update yokoten$/m));
  assert.match(result.stderr, underMark(/^ {COL}Fix: `claude plugin marketplace update yokoten`$/m));
  assert.doesNotMatch(result.stderr, /yokoten upgrade: /, 'no old sentence form');
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
    assert.match(result.stderr, /^yokoten upgrade · GIT_CONFIG_COUNT is not a small number, so nothing ran\n\nNext: unset it or make it a small number, then run `yokoten upgrade`\.\n$/, count);
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
    assert.match(result.stderr, /^yokoten upgrade · the marketplace name in your settings is not a plain name, so\n/, name);
    assert.match(result.stderr, /^Next: `claude plugin update yokoten-beta@/m, name);
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

test('upgrade: each screen keeps the screen rules, built from its result (#1115)', () => {
  const plugin = { id: 'yokoten-beta@yokoten', marketplace: 'yokoten', channel: 'beta' };
  const cases: [string, Parameters<typeof upgradeScreen>[0]][] = [
    ['not a plugin', { ok: true, plugin: null, steps: [], next: 'npx yokoten@latest' }],
    ['ok', { ok: true, plugin, steps: [{ label: 'the marketplace yokoten', ok: true }, { label: 'the plugin yokoten-beta@yokoten', ok: true }], next: 'restart Claude Code' }],
    ['failed step', { ok: false, plugin, steps: [{ label: 'the marketplace yokoten', ok: true }, { label: 'the plugin yokoten-beta@yokoten', ok: false, said: 'Error: could not reach github.com' }], next: 'claude plugin update yokoten-beta@yokoten' }],
    ['refused', { ok: false, plugin, steps: [], refused: 'GIT_CONFIG_COUNT is not a small number, so nothing ran', next: 'unset GIT_CONFIG_COUNT, then run `yokoten upgrade` again' }],
  ];
  for (const [name, result] of cases) assert.deepEqual(screenProblems({ text: upgradeScreen(result).join('\n'), isFailure: !result.ok }), [], name);
  // The failed step's Fix line is the item's last line.
  assert.equal(upgradeScreen(cases[2]![1]).at(-1), '              Fix: `claude plugin update yokoten-beta@yokoten`');
});
