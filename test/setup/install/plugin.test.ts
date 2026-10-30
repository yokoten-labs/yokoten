// Tests for src/setup/install.ts: install with the plugin on, CLAUDE_CONFIG_DIR, and kept skill files.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { rowsText, shareGuardMeasure, shareSelfTest, makeSandbox, ROOT } from '../../repo/helpers.ts';
import { sealManaged } from '../../../src/setup/files.ts';
import { cleanOlderInstall, paths } from '../../../src/setup/install.ts';
import { installIn, uninstallIn, assertRows, findingsOf } from './helpers.ts';

shareGuardMeasure();
shareSelfTest();

test('install: the plugin replaces the global skills and agents (#904)', async () => {
  const sandbox = makeSandbox();
  const claude = join(sandbox.home, '.claude');
  mkdirSync(join(claude, 'skills', 'dispatch'), { recursive: true });
  mkdirSync(join(claude, 'agents'), { recursive: true });
  mkdirSync(join(sandbox.home, '.agents', 'skills', 'dispatch'), { recursive: true });
  const skill = readFileSync(join(ROOT, 'kit/user/skills/dispatch/SKILL.md'), 'utf8');
  const agent = readFileSync(join(ROOT, 'kit/user/agents/worker.md'), 'utf8');
  writeFileSync(join(claude, 'skills', 'dispatch', 'SKILL.md'), skill);
  writeFileSync(join(sandbox.home, '.agents', 'skills', 'dispatch', 'SKILL.md'), skill);
  writeFileSync(join(claude, 'agents', 'worker.md'), agent);
  mkdirSync(join(claude, 'skills', 'mine'), { recursive: true });
  writeFileSync(join(claude, 'skills', 'mine', 'SKILL.md'), 'my own skill\n');
  writeFileSync(join(claude, 'settings.json'), JSON.stringify({ enabledPlugins: { 'yokoten@yokoten': true } }));
  const result = installIn(sandbox);
  assert.ok(result.ok, findingsOf(result, sandbox.home));
  assertRows(result, sandbox.home, 'removed skill ~/.claude/skills/dispatch', 'removed skill ~/.agents/skills/dispatch', 'removed agent ~/.claude/agents/worker.md');
  assert.ok(!existsSync(join(claude, 'skills', 'dispatch')));
  assert.ok(!existsSync(join(sandbox.home, '.agents', 'skills', 'dispatch')));
  assert.ok(!existsSync(join(claude, 'agents', 'worker.md')));
  assert.ok(!existsSync(join(claude, 'skills', 'yokoten')), 'no entry skill beside the plugin');
  assert.equal(readFileSync(join(claude, 'skills', 'mine', 'SKILL.md'), 'utf8'), 'my own skill\n');
  assert.equal(JSON.parse(readFileSync(join(claude, 'settings.json'), 'utf8')).hooks, undefined, 'the plugin brings the hooks');
  assert.deepEqual(result.changes.find((change) => change.kind === 'runtime'), { state: 'skipped', kind: 'runtime', path: paths(sandbox.env).runtime, note: 'the yokoten plugin brings its own' });
  assert.deepEqual(result.changes.filter((change) => change.kind === 'skill').map((change) => change.state), ['removed', 'removed'], 'a skill that was never there is not named');
  assert.doesNotMatch(rowsText((await sandbox.call(['doctor', '--all'])).stdout), /plugin-and-install/, 'nothing is left for the plugin to duplicate');
});

// #988: Claude Code reads its user folder from CLAUDE_CONFIG_DIR. Install, uninstall and a
// session's cleanup all use that folder; ~/.claude is never made. The positive control: the
// old install wrote the hooks to ~/.claude/settings.json, which Claude Code never read.
test('install: with CLAUDE_CONFIG_DIR, every Claude Code file goes there, never ~/.claude (#988)', async () => {
  const sandbox = makeSandbox();
  const config = join(sandbox.home, 'claude-elsewhere');
  const extra = { CLAUDE_CONFIG_DIR: config };
  const result = await sandbox.call(['install', '--list'], { extra });
  assert.equal(result.status, 0, result.stderr);
  const settingsFile = join(config, 'settings.json');
  const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
  assert.ok(settings.hooks.SessionStart && settings.hooks.PreToolUse, 'the hooks are where Claude Code reads them');
  assert.ok(existsSync(join(config, 'skills', 'yokoten', 'SKILL.md')), 'the entry skill');
  assert.ok(existsSync(join(config, 'agents', 'worker.md')), 'the agents');
  assert.ok(!existsSync(join(sandbox.home, '.claude')), '~/.claude is not made');
  assert.match(rowsText((await sandbox.call(['doctor', '--all'], { extra })).stdout), /ok +session-doctor/, 'doctor reads the same folder');
  // A session with the plugin on takes back what install left, in the same folder.
  settings.enabledPlugins = { 'yokoten@yokoten': true };
  writeFileSync(settingsFile, JSON.stringify(settings));
  const cleaned = cleanOlderInstall({ ...sandbox.env, ...extra }, { platform: 'linux' });
  assert.ok(cleaned.files > 0, 'it found the older files');
  assert.ok(!existsSync(join(config, 'agents', 'worker.md')));
  assert.equal(JSON.parse(readFileSync(settingsFile, 'utf8')).hooks, undefined, 'the hooks went from CLAUDE_CONFIG_DIR');
  assert.ok(!existsSync(join(sandbox.home, '.claude')));
  // Uninstall reads the same folder, and leaves the user's settings file.
  assert.equal((await sandbox.call(['uninstall', '--list'], { extra })).status, 0);
  assert.ok(existsSync(settingsFile));
  assert.ok(!existsSync(join(sandbox.home, '.claude')));
});

// #904: the upgrade from v0.1.0. An older install added the Claude Code hooks; with the
// plugin on, install takes them back with the runtime they point at, so the guard runs once
// and no hook is left asking for a runtime that is gone.
test('install: with the plugin on, the hooks an older install added go too (#904)', async () => {
  const sandbox = makeSandbox();
  assert.equal((await sandbox.call(['install', '--list'])).status, 0);
  const settingsFile = join(sandbox.home, '.claude', 'settings.json');
  const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
  assert.ok(settings.hooks?.PreToolUse, 'the older install added the guard');
  settings.hooks.PreToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-own-hook' }] });
  settings.enabledPlugins = { 'yokoten@yokoten': true };
  writeFileSync(settingsFile, JSON.stringify(settings));
  const result = installIn(sandbox);
  assert.ok(result.ok, findingsOf(result, sandbox.home));
  assert.deepEqual(result.changes.find((change) => change.kind === 'hook'), { state: 'removed', kind: 'hook', path: '~/.claude/settings.json', agent: 'Claude Code', note: 'the yokoten plugin brings them' });
  const after = readFileSync(settingsFile, 'utf8');
  assert.doesNotMatch(after, /share\/yokoten/, 'no hook points at the removed runtime');
  assert.match(after, /my-own-hook/, "the user's own hook stays");
});

test('install: with the plugin on, a hooks shape it cannot walk fails the run and says so (#904)', async () => {
  const sandbox = makeSandbox();
  const settingsFile = join(sandbox.home, '.claude', 'settings.json');
  mkdirSync(join(sandbox.home, '.claude'), { recursive: true });
  writeFileSync(settingsFile, JSON.stringify({ enabledPlugins: { 'yokoten@yokoten': true }, hooks: { PreToolUse: [{ hooks: 5 }] } }));
  const result = installIn(sandbox);
  assert.equal(result.ok, false);
  assert.match(findingsOf(result, sandbox.home), /^user-guard: ~\/\.claude\/settings\.json is not JSON, or its hooks have an unexpected shape;/m);
  assert.notEqual((await sandbox.call(['install'])).status, 0);
});

test('install: with the plugin on, a hooks file it cannot walk keeps the runtime its hooks run (#904)', async () => {
  const sandbox = makeSandbox();
  assert.equal((await sandbox.call(['install', '--list'])).status, 0);
  const settingsFile = join(sandbox.home, '.claude', 'settings.json');
  const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
  settings.enabledPlugins = { 'yokoten@yokoten': true };
  settings.hooks.PreToolUse.push({ hooks: 5 });
  writeFileSync(settingsFile, JSON.stringify(settings));
  assert.notEqual((await sandbox.call(['install', '--list'])).status, 0);
  assert.ok(existsSync(join(sandbox.home, '.local/share/yokoten', 'bin', 'yokoten.mjs')), 'the old hooks still run the runtime, so it stays');
});

test("install: with the plugin on, a user's own hook that runs yokoten keeps the runtime (#904)", async () => {
  for (const command of ['"$HOME/.local/bin/yokoten" check', 'yokoten check', '$(yokoten check)', 'echo hi;yokoten check', 'yokoten|tee out']) {
    const sandbox = makeSandbox();
    assert.equal((await sandbox.call(['install', '--list'])).status, 0);
    const settingsFile = join(sandbox.home, '.claude', 'settings.json');
    const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
    settings.enabledPlugins = { 'yokoten@yokoten': true };
    settings.hooks.Stop = [{ hooks: [{ type: 'command', command }] }];
    writeFileSync(settingsFile, JSON.stringify(settings));
    assert.equal((await sandbox.call(['install', '--list'])).status, 0);
    assert.ok(existsSync(join(sandbox.home, '.local/share/yokoten', 'bin', 'yokoten.mjs')), `the runtime stays while ${command} runs it`);
  }
});

test('install: with the plugin on, a hook that only looks like yokoten lets the runtime go (#904)', async () => {
  const sandbox = makeSandbox();
  assert.equal((await sandbox.call(['install', '--list'])).status, 0);
  const settingsFile = join(sandbox.home, '.claude', 'settings.json');
  const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
  settings.enabledPlugins = { 'yokoten@yokoten': true };
  settings.hooks.Stop = [{ hooks: [{ type: 'command', command: 'my-yokoten check; node ~/.local/share/yokoten-old/run.mjs' }] }];
  writeFileSync(settingsFile, JSON.stringify(settings));
  assert.equal((await sandbox.call(['install', '--list'])).status, 0);
  assert.ok(!existsSync(join(sandbox.home, '.local/share/yokoten')), 'nothing runs the runtime, so it goes');
});

test("install: a user's own link under a skill's name in ~/.agents stays (#904)", async () => {
  const sandbox = makeSandbox();
  const mine = join(sandbox.home, 'my-skills');
  mkdirSync(mine, { recursive: true });
  mkdirSync(join(sandbox.home, '.agents', 'skills'), { recursive: true });
  symlinkSync(mine, join(sandbox.home, '.agents', 'skills', 'dispatch'), 'dir');
  assert.equal((await sandbox.call(['install', '--list'])).status, 0);
  assert.equal(readlinkSync(join(sandbox.home, '.agents', 'skills', 'dispatch')), mine, 'the link is the user\'s, so it stays');
});

// #904: install names what it wrote, and uninstall leaves the home folder as it was.
test('install names each file and settings key it wrote, and uninstall restores the home folder (#904)', async () => {
  const sandbox = makeSandbox();
  const home = (): string[] => readdirSync(sandbox.home, { recursive: true, withFileTypes: true }).map((entry) => `${relative(sandbox.home, join(entry.parentPath, entry.name))}${entry.isDirectory() ? '/' : ''}`).sort();
  const before = home();
  const result = installIn(sandbox);
  assert.ok(result.ok, findingsOf(result, sandbox.home));
  assertRows(result, sandbox.home, 'wrote skill ~/.claude/skills/yokoten', 'added hook ~/.claude/settings.json Claude Code', 'wrote file ~/.config/yokoten/private-marks', 'wrote runtime ~/.local/share/yokoten');
  assert.deepEqual(result.changes.filter((change) => change.kind === 'hook' && change.agent === 'Claude Code').map((change) => change.note), ['SessionStart doctor', 'command guard']);
  const uninstalled = await sandbox.call(['uninstall', '--list']);
  assert.equal(uninstalled.status, 0, uninstalled.stderr);
  assert.deepEqual(home(), before, 'the home folder is as it was before install');
});

// #477: install keeps a managed file the user edited, and still updates a file they did not.
test('install: a managed skill you edited is kept; an untouched copy updates from the kit (#477)', async () => {
  const sandbox = makeSandbox();
  const skill = join(sandbox.home, '.claude', 'skills', 'yokoten', 'SKILL.md');
  assert.equal((await sandbox.call(['install', '--list'])).status, 0);
  const installed = readFileSync(skill, 'utf8');
  assert.match(installed, /managed by yokoten.* sha256=[0-9a-f]{64}/, 'the mark records what install wrote');

  // The user adds a rule of their own to a file install manages.
  const mine = `${installed}\nAsk the owner before a release.\n`;
  writeFileSync(skill, mine);
  let result = installIn(sandbox);
  assert.deepEqual(result.changes.find((change) => change.path === dirname(skill)), { state: 'kept', kind: 'skill', path: dirname(skill), yours: true, note: 'your edit' });
  assert.equal(readFileSync(skill, 'utf8'), mine, 'their edit stays');
  assert.match((await sandbox.call(['install'])).stdout, /^ {2}note {9}kept {8}your own edits stay; the newest copies are in the kit$/m);

  // A copy yokoten wrote from an older kit, which the user did not touch, is replaced.
  writeFileSync(skill, sealManaged(installed.replace('hand a task to a worker', 'hand a task to a helper')));
  assertRows(installIn(sandbox), sandbox.home, 'updated skill ~/.claude/skills/yokoten');
  assert.equal(readFileSync(skill, 'utf8'), installed, 'the new copy is in place');

  // A copy from an older yokoten has no hash: install replaces it once, then it has one.
  writeFileSync(skill, installed.replace(/;? sha256=[0-9a-f]{64}/, ''));
  assertRows(installIn(sandbox), sandbox.home, 'updated skill ~/.claude/skills/yokoten');
  assert.equal(readFileSync(skill, 'utf8'), installed);

  // uninstall keeps the edit too: it is the user's.
  writeFileSync(skill, mine);
  result = uninstallIn(sandbox);
  assertRows(result, sandbox.home, 'kept skill ~/.claude/skills/yokoten yours');
  assert.match(readFileSync(skill, 'utf8'), /Ask the owner before a release\./);
});

test('uninstall: a skill file that only mentions the mark in a sentence stays (#848)', async () => {
  const sandbox = makeSandbox();
  const skill = join(sandbox.home, '.claude', 'skills', 'dispatch', 'SKILL.md');
  const mine = 'This file is managed by yokoten, in a sentence of my own.\n';
  mkdirSync(dirname(skill), { recursive: true });
  writeFileSync(skill, mine);
  assertRows(uninstallIn(sandbox), sandbox.home, 'kept skill ~/.claude/skills/dispatch yours');
  assert.equal(readFileSync(skill, 'utf8'), mine, 'the user\'s own file stays');
});

// A shared skill folder with the user's own files in it stays a real folder: replacing it
// with a link would throw their files away (#557). Install only syncs the skill file, and
// uninstall keeps the folder.
test('install: a shared skill folder with your own files in it stays real', async () => {
  const sandbox = makeSandbox();
  const shared = join(sandbox.home, '.agents', 'skills', 'yokoten');
  assert.equal((await sandbox.call(['install', '--list'])).status, 0);
  assert.ok(lstatSync(shared).isSymbolicLink(), 'first install links it');
  // The user's own file next to a managed copy: the folder goes back to real files.
  const managed = readFileSync(join(sandbox.home, '.claude', 'skills', 'yokoten', 'SKILL.md'), 'utf8');
  rmSync(shared);
  mkdirSync(shared, { recursive: true });
  writeFileSync(join(shared, 'SKILL.md'), managed);
  writeFileSync(join(shared, 'notes.txt'), 'mine\n');
  assertRows(installIn(sandbox), sandbox.home, 'kept skill ~/.agents/skills/yokoten');
  assert.ok(!lstatSync(shared).isSymbolicLink(), 'still a real folder');
  assert.equal(readFileSync(join(shared, 'SKILL.md'), 'utf8'), managed);
  assert.equal(readFileSync(join(shared, 'notes.txt'), 'utf8'), 'mine\n');
  const uninstalled = await sandbox.call(['uninstall', '--list']);
  assert.equal(uninstalled.status, 0, uninstalled.stderr);
  assert.equal(readFileSync(join(shared, 'notes.txt'), 'utf8'), 'mine\n', 'uninstall keeps the user file');
  assert.ok(!existsSync(join(shared, 'SKILL.md')), 'but takes the managed file');
});

// The guide says: run install again to update, and init again to refresh .yokoten/. Run
// from the copy it would replace, that copy was deleted (#204).
test('install: run from the installed copy, it keeps that copy, and the next run works (#204)', async () => {
  const sandbox = makeSandbox();
  assert.equal((await sandbox.call(['install', '--list'])).status, 0);
  const installed = join(sandbox.home, '.local/share/yokoten/bin/yokoten.ts');
  for (let run = 0; run < 2; run++) {
    const result = spawnSync('node', [installed, 'install', '--list'], { cwd: sandbox.repo, env: sandbox.env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^ {2}kept {9}the runtime ~\/\.local\/share\/yokoten: the copy running now$/m);
    assert.ok(!result.stdout.includes(sandbox.home), 'output shows the home path');
    assert.ok(existsSync(installed), 'the installed copy is still there');
  }
});
