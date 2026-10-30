// Tests for src/commands/more/setup/install.ts.

import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeSandbox } from '../../../repo/helpers.ts';
import { screenProblems } from '../../../repo/docs/screen-rules.ts';
import { guardedAgents, installScreen, listScreen, uninstallScreen } from '../../../../src/commands/more/setup/install.ts';
import { type Change, type Place, type SetupResult } from '../../../../src/setup/files.ts';
import { finding } from '../../../../src/rules/text/message.ts';

/** Every line of a screen fits an 80-column terminal (R1). */
const fit = (text: string): void => {
  for (const line of text.trimEnd().split('\n')) assert.ok(line.length <= 80, `${line.length}: ${line}`);
};

// A home folder for each system, as the screen is drawn for it.
const HOMES: Record<'linux' | 'win32' | 'darwin', string> = { linux: '/home/someone', win32: 'C:\\Users\\someone', darwin: '/Users/someone' };
const sep = (platform: keyof typeof HOMES) => (platform === 'win32' ? '\\' : '/');
const under = (platform: keyof typeof HOMES, ...parts: string[]) => [HOMES[platform], ...parts].join(sep(platform));

/** A first install's result on `platform`: Claude Code and Codex guarded, the rest not installed. */
function freshInstall(platform: keyof typeof HOMES): SetupResult {
  const launchers = platform === 'win32' ? ['yokoten.cmd', 'yokoten.ps1'] : ['yokoten'];
  const changes: Change[] = [
    { state: 'wrote', kind: 'runtime', path: under(platform, '.local', 'share', 'yokoten') },
    { state: 'wrote', kind: 'skill', path: under(platform, '.claude', 'skills', 'yokoten') },
    { state: 'linked', kind: 'skill', path: under(platform, '.agents', 'skills', 'yokoten') },
    { state: 'wrote', kind: 'agent', path: under(platform, '.claude', 'agents', 'worker.md') },
    { state: 'added', kind: 'hook', path: under(platform, '.claude', 'settings.json'), agent: 'Claude Code', note: 'SessionStart doctor' },
    { state: 'added', kind: 'hook', path: under(platform, '.claude', 'settings.json'), agent: 'Claude Code', note: 'command guard' },
    { state: 'added', kind: 'hook', path: under(platform, '.codex', 'hooks.json'), agent: 'Codex CLI', note: 'command guard' },
    { state: 'skipped', kind: 'hook', path: under(platform, '.gemini'), agent: 'Gemini CLI', note: 'not installed here' },
    { state: 'skipped', kind: 'hook', path: under(platform, '.grok'), agent: 'Grok CLI', note: 'not installed here' },
    { state: 'wrote', kind: 'file', path: under(platform, '.config', 'yokoten', 'private-marks') },
    { state: 'skipped', kind: 'setting', path: 'mailmap.file' },
    ...launchers.map((name): Change => ({ state: 'wrote', kind: 'launcher', path: under(platform, '.local', 'bin', name) })),
  ];
  const notes = [finding('mailmap', 'hide your email in git logs: not on yet', 'run `git config --global mailmap.file ~/.config/yokoten/mailmap`')];
  return { ok: true, changes, problems: [], notes };
}

const place = (platform: keyof typeof HOMES, more: Partial<Place> = {}): Place => ({ platform, home: HOMES[platform], hasProjectRules: false, launcherOnPath: true, ...more });

/** The screen's problems by the rules, and every line under 80 columns. */
function keepsRules(lines: string[], isFailure = false): string {
  const text = lines.join('\n');
  assert.deepEqual(screenProblems({ text, isFailure }), [], text);
  fit(text);
  return text;
}

test('installScreen: a first install on each system, its rows from the result (#1115)', () => {
  for (const platform of ['linux', 'win32', 'darwin'] as const) {
    const text = keepsRules(installScreen(freshInstall(platform), place(platform)));
    assert.match(text, /^yokoten install · this computer is set up$/m, platform);
    assert.match(text, /^ {2}ok {11}guard {7}on for Claude Code, Codex CLI$/m, platform);
    assert.match(text, /^ {2}ok {11}skills {6}yokoten$/m, platform);
    assert.match(text, /^ {2}note {9}other AIs {3}2 not installed here; run install again later$/m, platform);
    assert.match(text, /^Next: `yokoten init`$/m, platform);
    assert.doesNotMatch(text, /PATH/, `${platform}: the launcher's folder is on the PATH`);
  }
  assert.match(installScreen(freshInstall('linux'), place('linux', { hasProjectRules: true })).join('\n'), /^Next: `yokoten doctor`$/m, 'a project with rules goes on to doctor');
  assert.deepEqual(guardedAgents(freshInstall('linux')), ['Claude Code', 'Codex CLI']);
});

test('installScreen: the PATH step is said for the system the screen is for (#1038)', () => {
  const linux = keepsRules(installScreen(freshInstall('linux'), place('linux', { launcherOnPath: false })));
  assert.match(linux, /^ {2}note {9}command {5}~\/\.local\/bin is not on your PATH yet$/m);
  assert.match(linux, /^ {27}`export PATH="\$HOME\/\.local\/bin:\$PATH"`$/m);
  const windows = keepsRules(installScreen(freshInstall('win32'), place('win32', { launcherOnPath: false })));
  assert.match(windows, /^ {2}note {9}command {5}~\\\.local\\bin is not on your PATH yet$/m);
  assert.match(windows, /"Edit environment variables for\s+your account"/);
  assert.doesNotMatch(windows, /export PATH/, 'Windows has no shell profile line');
  // A profile that already adds the folder: a new shell finds the launcher.
  const added = freshInstall('linux');
  added.changes.push({ state: 'added', kind: 'profile', path: under('linux', '.bashrc'), note: 'open a new shell' });
  assert.match(keepsRules(installScreen(added, place('linux', { launcherOnPath: false }))), /^ {2}note {9}command {5}~\/\.bashrc adds ~\/\.local\/bin to your PATH$/m);
});

test('installScreen: nothing changed, a problem, and no home folder (#1115)', () => {
  const again = freshInstall('linux');
  again.changes = again.changes.map((change) => ({ ...change, state: change.state === 'skipped' ? 'skipped' : 'kept' }));
  assert.deepEqual(installScreen(again, place('linux')), ['yokoten install · already set up here, nothing changed', '', 'More: `yokoten install --list` names every file']);
  const partly = freshInstall('linux');
  partly.ok = false;
  partly.problems.push(finding('codex-user-hook', `${under('linux', '.codex', 'hooks.json')} is not valid JSON`, 'run `yokoten install` again', { why: 'the guard is not on for Codex CLI until it is' }));
  const text = keepsRules(installScreen(partly, place('linux', { launcherOnPath: false })), true);
  assert.match(text, /^yokoten install · this computer is partly set up$/m);
  assert.match(text, /^ {2}MISSING {6}guard {7}~\/\.codex\/hooks\.json is not valid JSON\n {27}The guard is not on for Codex CLI until it is\.\n {27}Fix: `yokoten install`$/m);
  const noHome: SetupResult = { ok: false, changes: [], problems: [finding('machine-runtime', 'no home folder', "set HOME to your home folder's full path, then run `yokoten install` again")], notes: [] };
  keepsRules(installScreen(noHome, place('linux', { home: null })), true);
});

test('uninstallScreen: counts of what went, and a second run with nothing to remove (#1027)', () => {
  const removed: SetupResult = {
    ok: true,
    changes: [
      { state: 'removed', kind: 'skill', path: '/home/someone/.claude/skills/yokoten' },
      { state: 'removed', kind: 'skill', path: '/home/someone/.agents/skills/yokoten' },
      { state: 'removed', kind: 'agent', path: '/home/someone/.claude/agents/worker.md' },
      { state: 'removed', kind: 'hook', path: '/home/someone/.claude/settings.json', agent: 'Claude Code', note: 'command guard' },
      { state: 'kept', kind: 'file', path: '/home/someone/.config/yokoten', yours: true, note: 'your keys and private marks' },
    ],
    problems: [],
    notes: [],
  };
  const text = keepsRules(uninstallScreen(removed));
  assert.match(text, /^ {2}ok {11}removed {5}1 skill, 1 agent, 1 hook$/m);
  assert.match(text, /^To install again: `yokoten install`$/m);
  assert.deepEqual(uninstallScreen({ ok: true, changes: [], problems: [], notes: [] }), ['yokoten uninstall · nothing to remove: yokoten is not installed on this computer']);
  const stuck = { ...removed, ok: false, problems: [finding('user-guard', '~/.claude/settings.json is not JSON, so the Claude Code hooks are still in it', 'run `yokoten uninstall` again', { why: 'uninstall never rewrites a file it cannot read' })] };
  assert.match(keepsRules(uninstallScreen(stuck), true), /^Next: `yokoten uninstall`$/m);
});

test('listScreen: every change as a row, its state the mark (#1115)', () => {
  const text = keepsRules(listScreen('install', freshInstall('linux'), place('linux')));
  assert.match(text, /^yokoten install · this computer is set up$/m);
  assert.match(text, /^ {2}wrote {8}skill yokoten in ~\/\.claude\/skills$/m);
  assert.match(text, /^ {2}linked {7}skill yokoten in ~\/\.agents\/skills$/m);
  assert.match(text, /^ {2}skipped {6}Gemini CLI hooks in ~\/\.gemini: not installed here$/m);
});

test('install and uninstall: the entry prints one screen, --list every file (#1027)', async () => {
  const sandbox = makeSandbox();
  // A real child, for the entry: the exit code and output through bin/yokoten.ts.
  const result = sandbox.run(['install']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^yokoten install · this computer is set up$/m);
  assert.match(result.stdout, /^ {2}ok +guard +on for Claude Code$/m);
  assert.match(result.stdout, /^ {2}note +other AIs +\d+ not installed here/m);
  assert.match(result.stdout, /^Next: `yokoten init`$/m);
  fit(result.stdout);
  const list = await sandbox.call(['install', '--list']);
  assert.match(list.stdout, /^ {2}kept {9}skill yokoten in ~[\\/]\.claude[\\/]skills$/m);
  assert.match(list.stdout, /^ {2}skipped {6}Codex CLI hooks in ~[\\/]\.codex: not installed here$/m);
  const removed = await sandbox.call(['uninstall']);
  assert.equal(removed.status, 0, removed.stderr);
  assert.match(removed.stdout, /^yokoten uninstall · removed what install wrote$/m);
  assert.match(removed.stdout, /^ {2}ok +removed +1 skill, 3 agents, 2 hooks$/m);
  assert.doesNotMatch(removed.stdout, /skill yokoten in/, 'per-file rows are behind --list');
  fit(removed.stdout);
  const again = await sandbox.call(['uninstall']);
  assert.match(again.stdout, /^yokoten uninstall · nothing to remove: yokoten is not installed on this computer$/m);
});
