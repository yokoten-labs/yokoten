// Tests for src/setup/doctor/checks.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { test } from 'node:test';
import { shareGuardMeasure, shareSelfTest } from '../../repo/helpers.ts';
import { makeSandbox, makeTempDir, ROOT } from '../../repo/helpers.ts';
import { DEFAULTS } from '../../../src/rules/config.ts';
import { cleanOlderInstall, hookRunsYokoten, launcherDir, PROFILE_LINE, setUpLauncher } from '../../../src/setup/install.ts';
import { sealManaged, writeManaged } from '../../../src/setup/files.ts';
import { doctor, doubleInstallCheck, editedKitCheck, launcherCheck, machineChecks, pluginAgeCheck, privacyNotes, releaseChannel, userAgentHooks } from '../../../src/setup/doctor/index.ts';
import { deskFenceCheck, FENCE_PROGRAMS, mergeTimeZones } from '../../../src/setup/doctor/checks.ts';
import { road, ROAD } from '../../../src/setup/road.ts';

/** A screen with each wrapped row on one line again: the rows wrap at 80 columns under their text (#1115). */
const flat = (text: string): string => text.replace(/\n {14}/g, ' ');

shareGuardMeasure();
shareSelfTest();

// #522: install fills the git name, so the marks are in place. One run gives one answer.
test('install then doctor: the private-marks lines agree, in full doctor and a session (#522)', async () => {
  const sandbox = makeSandbox();
  const name = ['Kit', 'Sample'].join(' ');
  sandbox.git('config', 'user.name', name);
  const installed = await sandbox.call(['install', '--list']);
  assert.equal(installed.status, 0, installed.stderr);
  const marksLines = (text: string) => text.split('\n').filter((line) => /private.marks?|private marks/.test(line));
  const said = [installed.stdout, installed.stderr];
  const full = await sandbox.call(['doctor', '--all']);
  said.push(full.stdout, full.stderr);
  const lines = marksLines(full.stdout);
  assert.ok(lines.some((line) => /^ +ok +private-marks$/.test(line)), lines.join('\n'));
  assert.match(lines.join('\n'), /^ +note +private-mark-kinds: optional: add your city or your domains too/m);
  for (const line of [...lines, ...marksLines(installed.stdout)]) assert.doesNotMatch(line, /MISSING|missing|may lack|already has what/, line);
  const session = await sandbox.call(['doctor', '--session']);
  said.push(session.stdout, session.stderr);
  assert.deepEqual(marksLines(session.stdout), [], 'a session says nothing about marks that are in place');
  const json = JSON.parse((await sandbox.call(['doctor', '--json'])).stdout) as { findings: { id: string }[] };
  assert.ok(!json.findings.some((found) => found.id === 'private-marks'), 'no private-marks finding');
  assert.ok(!said.some((text) => /kit|sample/i.test(text)), 'no output holds the name');
  // The positive control: a file with no marks is missing, in both. A shared name is never added.
  sandbox.git('config', 'user.name', 'Test');
  writeFileSync(join(sandbox.home, '.config/yokoten/private-marks'), '# only a comment\n');
  assert.match(flat((await sandbox.call(['doctor', '--all'])).stdout), /^ +MISSING +private-marks: ~\/\.config\/yokoten\/private-marks is missing or has no marks Type your name[^\n]* Fix: `(npx )?yokoten marks add`/m);
  assert.match((await sandbox.call(['doctor', '--session'])).stdout, /private-marks is missing or has no marks/);
});

test('doctor: names a newer kit copy that waits behind an edit (#477)', async () => {
  const sandbox = makeSandbox();
  assert.equal((await sandbox.call(['install', '--list'])).status, 0);
  const skill = join(sandbox.home, '.claude', 'skills', 'yokoten', 'SKILL.md');
  const installed = readFileSync(skill, 'utf8');
  // An edit on the copy install wrote: the kit has nothing newer, so doctor stays quiet.
  writeFileSync(skill, `${installed}\nAsk the owner before a release.\n`);
  assert.equal(editedKitCheck(sandbox.env), null);
  // An edit on an older kit copy: the newer copy waits, and doctor names how to compare.
  const older = sealManaged(installed.replace('hand a task to a worker', 'hand a task to a helper'));
  writeFileSync(skill, `${older}\nAsk the owner before a release.\n`);
  const found = editedKitCheck(sandbox.env);
  assert.equal(found?.id, 'edited-kit');
  assert.match(found?.what ?? '', /^a newer kit copy is waiting for the skill yokoten \(~\/\.claude\/skills\/yokoten\/SKILL\.md\) you edited/);
  assert.match(found?.fix ?? '', /diff ~\/\.claude\/skills\/yokoten\/SKILL\.md .*kit\/user\/entry\/SKILL\.md/);
  const full = doctor(sandbox.repo, { env: sandbox.env, config: DEFAULTS, gh: () => { throw new Error('no network in this test'); } });
  // The line words the command as this machine runs it, so only its start is compared.
  assert.ok(flat(full.lines.join('\n')).includes(`  note        edited-kit: ${found?.what}; `), full.lines.join('\n'));
  assert.match((await sandbox.call(['doctor', '--session'])).stdout, /a newer kit copy is waiting for the skill yokoten/);
});

test('doctor: the plugin, when on, stands in for install', async () => {
  const sandbox = makeSandbox();
  const check = (name: string) => machineChecks(sandbox.env).find((found) => found.name === name);
  const skills = ROAD.filter((step) => step.key === 'skills');
  assert.equal(check('session-doctor')?.ok, false);
  assert.equal(`${check('session-doctor')?.finding.what}; ${check('session-doctor')?.finding.fix}`, 'sessions do not start with doctor; run `yokoten install`, or install the Claude Code plugin');
  assert.equal(check('runtime')?.ok, false);
  assert.equal(check('runtime')?.finding.what, 'no runtime installed');
  mkdirSync(join(sandbox.home, '.claude'));
  const settings = (enabledPlugins: unknown) => writeFileSync(join(sandbox.home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins }));
  settings({ 'yokoten@yokoten': false });
  assert.equal(check('session-doctor')?.ok, false, 'off is off');
  settings({ 'yokoten@yokoten': true });
  assert.equal(check('session-doctor')?.ok, true);
  assert.equal(check('runtime')?.ok, true);
  assert.deepEqual(road(sandbox.repo, sandbox.env, skills).map((step) => step.found), [true], 'the plugin brings the skills');
  assert.equal(doubleInstallCheck(sandbox.repo, sandbox.env), null, 'no install pieces, no note');
  writeFileSync(join(sandbox.home, '.claude', 'settings.json'), 'not json');
  assert.equal(check('session-doctor')?.ok, false, 'a broken settings file enables nothing');
});

// #904: the plugin stands in for install's guard while it is on, and install then writes
// none. Turn the plugin off, and the machine has no guard at all: doctor says so as a
// failure with one fix, and install again writes install's own guard. The owner decided
// both on 2026-10-24.
test('doctor: a guard that left with the plugin fails, and install brings it back (#904)', async () => {
  const sandbox = makeSandbox();
  const file = join(sandbox.home, '.claude', 'settings.json');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ enabledPlugins: { 'yokoten@yokoten': true } }));
  const hasGuard = (): boolean => {
    const hooks = JSON.parse(readFileSync(file, 'utf8')).hooks;
    return Array.isArray(hooks?.PreToolUse) && hooks.PreToolUse.length > 0;
  };
  const guardLine = async (): Promise<string | undefined> => (await sandbox.call(['doctor', '--all'])).stdout.split('\n').find((line) => line.includes('user-guard'));
  // The plugin is on: install writes no guard of its own, and the plugin's guard counts.
  assert.equal((await sandbox.call(['install', '--list'])).status, 0);
  assert.ok(!hasGuard(), 'install wrote no guard beside the plugin');
  assert.match(String(await guardLine()), /^ {2}ok {10}user-guard$/);
  // The plugin goes away: no guard is left, and that is a failure with one fix.
  writeFileSync(file, JSON.stringify({ enabledPlugins: { 'yokoten@yokoten': false } }));
  const failed = await sandbox.call(['doctor', '--all']);
  assert.match(failed.stdout, /^ {2}MISSING {5}user-guard: no guard for Claude Code$/m);
  assert.match(failed.stdout, /^ {14}Fix: `(npx )?yokoten install`$/m, 'its fix, said once under the rows it fixes');
  assert.equal(failed.status, 1, 'a machine with no guard fails doctor');
  const json = JSON.parse((await sandbox.call(['doctor', '--json'])).stdout) as { ok: boolean; findings: { id: string; what: string }[] };
  assert.ok(!json.ok);
  assert.ok(json.findings.some((found) => found.id === 'user-guard' && found.what === 'no guard for Claude Code'), 'the guard fails the run, as a finding');
  assert.match((await sandbox.call(['doctor', '--session'])).stdout, /no guard for Claude Code/, 'a session hears it too');
  // Install again writes install's own guard, and doctor passes.
  assert.equal((await sandbox.call(['install', '--list'])).status, 0);
  assert.ok(hasGuard(), 'install wrote its own guard');
  assert.match(String(await guardLine()), /^ {2}ok {10}user-guard$/);
});

// #1100: a user who updated yokoten but not the install keeps a guard on Bash alone, so a
// worker's Write or Edit meets no guard in a session with no project hook. Doctor says it in
// one line per guard, with the one fix; install moves only yokoten's own entry.
test('doctor: a user guard older than this yokoten is one line, and install fixes it (#1100)', async () => {
  const sandbox = makeSandbox();
  mkdirSync(join(sandbox.home, '.grok'));
  assert.equal((await sandbox.call(['install', '--list'])).status, 0);
  const files = [join(sandbox.home, '.claude', 'settings.json'), join(sandbox.home, '.grok', 'hooks', 'yokoten.json')];
  const mine = { matcher: 'Bash', hooks: [{ type: 'command', command: 'my-own-hook' }] };
  for (const file of files) {
    const settings = JSON.parse(readFileSync(file, 'utf8'));
    settings.hooks.PreToolUse[0].matcher = 'Bash';
    settings.hooks.PreToolUse.push(mine);
    writeFileSync(file, JSON.stringify(settings));
  }
  const lines = async () => flat((await sandbox.call(['doctor', '--all'])).stdout).split('\n').filter((line) => /user-guard|grok-user-hook/.test(line));
  assert.deepEqual(await lines(), [
    '  MISSING     user-guard: the guard for Claude Code is out of date: it skips Edit, Write, MultiEdit, NotebookEdit Fix: `npx yokoten install`',
    '  note        grok-user-hook: the command guard in ~/.grok/hooks/yokoten.json is out of date; `npx yokoten install` updates it',
  ]);
  assert.equal((await sandbox.call(['install', '--list'])).status, 0);
  assert.deepEqual(await lines(), ['  ok          user-guard', '  ok          grok-user-hook']);
  for (const file of files) assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).hooks.PreToolUse.at(-1), mine, "the user's own hook stays as it was");
});

test('doctor: names the release channel this machine runs (#632)', async () => {
  const sandbox = makeSandbox();
  const version: string = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  mkdirSync(join(sandbox.home, '.claude'), { recursive: true });
  const settings = (enabledPlugins: unknown) => writeFileSync(join(sandbox.home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins }));
  settings({ 'yokoten@yokoten': true });
  assert.equal(releaseChannel(sandbox.repo, sandbox.env), 'stable');
  // The channel reaches the first line and the JSON.
  settings({ 'yokoten-beta@yokoten': true });
  assert.equal((await sandbox.call(['doctor', '--all'])).stdout.split('\n').find((line) => line.includes(`yokoten ${version}`)), `  ok          yokoten ${version} (beta): self-test ok`);
  assert.equal(JSON.parse((await sandbox.call(['doctor', '--json'])).stdout).channel, 'beta');
  settings({ 'yokoten-dev@yokoten': true });
  assert.equal(releaseChannel(sandbox.repo, sandbox.env), 'dev');
  // Another name does not count, and no plugin means the released package.
  settings({ 'yokoten-other@yokoten': true });
  assert.equal(releaseChannel(sandbox.repo, sandbox.env), 'stable');
  // yokoten's own checkout runs Dev, unless a plugin says otherwise.
  assert.equal(releaseChannel(ROOT, sandbox.env), 'dev');
  settings({ 'yokoten@yokoten': true });
  assert.equal(releaseChannel(ROOT, sandbox.env), 'stable');
});

test('doctor: the plugin and install both on is a note that says to uninstall (#300)', async () => {
  const sandbox = makeSandbox();
  assert.equal((await sandbox.call(['install', '--list'])).status, 0);
  const file = join(sandbox.home, '.claude', 'settings.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), enabledPlugins: { 'yokoten@yokoten': true } }));
  const double = doubleInstallCheck(sandbox.repo, sandbox.env);
  assert.equal(double?.id, 'machine-runtime');
  const noGh = () => { throw new Error('no network in this test'); };
  const fullLines = doctor(sandbox.repo, { env: sandbox.env, config: DEFAULTS, gh: noGh }).lines;
  assert.ok(flat(fullLines.join('\n')).includes(`  note        plugin-and-install: ${double?.what}; ${double?.fix}`.replaceAll(sandbox.home, '~')), 'full doctor prints the note');
  assert.match(`${double?.what}; ${double?.fix}`.replaceAll(sandbox.home, '~'), /^the yokoten plugin is on, and `yokoten install` put these here too: the SessionStart doctor and the command guard in ~\/\.claude\/settings\.json; the skills in ~\/\.claude\/skills and ~\/\.agents\/skills; the agents in ~\/\.claude\/agents; ~\/\.local\/share\/yokoten; remove the home copy with `yokoten uninstall`/);
  // A session start takes the copies back instead of naming them (#935).
  const session = (await sandbox.call(['doctor', '--session'])).stdout;
  assert.match(session, /^yokoten: cleaned \d+ files an older install left; the plugin brings them now$/m);
  assert.doesNotMatch(session, /plugin is on, and/);
  // An older runtime from install, with the plugin on: remove it, never install again.
  mkdirSync(join(sandbox.home, '.local/share/yokoten'), { recursive: true });
  writeFileSync(join(sandbox.home, '.local/share/yokoten/VERSION'), '0.0.1\n');
  const runtime = machineChecks(sandbox.env).find((found) => found.name === 'runtime');
  assert.equal(runtime?.ok, false);
  assert.match(`${runtime?.finding.what}; ${runtime?.finding.fix}`, /^the installed runtime is 0\.0\.1, this yokoten is \S+; remove it with `yokoten uninstall`; the plugin brings its own$/);
  // After uninstall the note is gone, and the plugin stands in for everything.
  assert.equal((await sandbox.call(['uninstall'])).status, 0);
  const after = (await sandbox.call(['doctor', '--all'])).stdout;
  assert.doesNotMatch(after, /plugin-and-install/);
  assert.match(after, /ok {10}runtime/);
  assert.match(after, /ok {10}session-doctor/);
});

test('doctor: a skills-only copy alone is a note that names the duplicate (#540)', async () => {
  const sandbox = makeSandbox();
  const settings = join(sandbox.home, '.claude', 'settings.json');
  mkdirSync(dirname(settings), { recursive: true });
  writeFileSync(settings, JSON.stringify({ enabledPlugins: { 'yokoten@yokoten': true } }));
  const skill = readFileSync(join(ROOT, 'kit/user/skills/inspect/SKILL.md'), 'utf8');
  const copy = join(sandbox.home, '.agents/skills/inspect/SKILL.md');
  mkdirSync(dirname(copy), { recursive: true });
  writeFileSync(copy, skill);
  const double = doubleInstallCheck(sandbox.repo, sandbox.env);
  assert.equal(`${double?.what}; ${double?.fix}`.replaceAll(sandbox.home, '~'), 'the yokoten plugin is on, and a skills-only copy is here too: the skills in ~/.agents/skills; remove the home copy with `yokoten uninstall`; the plugin brings its own');
  // The session's own line counts the one file, in the singular.
  const session = (await sandbox.call(['doctor', '--session'])).stdout;
  assert.match(session, /^yokoten: cleaned 1 file an older install left; the plugin brings them now$/m);
  assert.ok(!existsSync(copy), 'the session takes the skills-only copy back');
});

test('doctor --session: with the plugin on, takes back what an older install left (#935)', async () => {
  const sandbox = makeSandbox();
  const claude = join(sandbox.home, '.claude');
  assert.equal((await sandbox.call(['install', '--list'])).status, 0);
  // v0.1.0's install put every skill and agent in the global folders.
  const skills = readdirSync(join(ROOT, 'kit/user/skills'));
  for (const name of skills) {
    const text = readFileSync(join(ROOT, 'kit/user/skills', name, 'SKILL.md'), 'utf8');
    writeManaged(join(claude, 'skills', name, 'SKILL.md'), text);
    writeManaged(join(sandbox.home, '.agents', 'skills', name, 'SKILL.md'), text);
  }
  for (const file of readdirSync(join(ROOT, 'kit/user/agents'))) {
    writeManaged(join(claude, 'agents', file), readFileSync(join(ROOT, 'kit/user/agents', file), 'utf8'));
  }
  // The user's edit to a skill stays, and so does their own hook.
  const edited = join(claude, 'skills', 'dispatch', 'SKILL.md');
  writeFileSync(edited, `${readFileSync(edited, 'utf8')}\nAsk the owner first.\n`);
  const settingsFile = join(claude, 'settings.json');
  const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
  settings.enabledPlugins = { 'yokoten@yokoten': true };
  settings.hooks.PreToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-own-hook' }] });
  writeFileSync(settingsFile, JSON.stringify(settings));
  // The older install's PATH line in the shell profile: a session names it and never edits it (#983).
  const profile = join(sandbox.home, '.bashrc');
  const profileText = `export EDITOR=vi\n${PROFILE_LINE}\n`;
  writeFileSync(profile, profileText);

  // A note wraps under its own text (#1099): read each note as one line.
  const session = (await sandbox.call(['doctor', '--session'])).stdout.replace(/\n {9}/g, ' ');
  assert.match(session, /^yokoten: cleaned \d+ files an older install left; the plugin brings them now$/m);
  assert.equal(readFileSync(profile, 'utf8'), profileText, 'a session never edits a shell profile');
  assert.match(session, /^yokoten: ~\/\.bashrc still has the PATH line an older install added; delete the line that ends with "# added by yokoten"$/m);
  assert.match(session, /^yokoten: kept your edit to skill dispatch: an older install left it$/m);
  assert.match(readFileSync(edited, 'utf8'), /Ask the owner first/, 'the edited copy stays');
  for (const name of skills.filter((name) => name !== 'dispatch')) {
    assert.ok(!existsSync(join(claude, 'skills', name)), `~/.claude/skills/${name} is gone`);
    assert.ok(!existsSync(join(sandbox.home, '.agents', 'skills', name)), `~/.agents/skills/${name} is gone`);
  }
  assert.ok(!existsSync(join(claude, 'agents', 'worker.md')), 'the agents are gone');
  assert.ok(!existsSync(join(sandbox.home, '.local/share/yokoten')), 'the runtime is gone');
  assert.ok(!existsSync(join(launcherDir(sandbox.home), 'yokoten')), 'the launcher is gone');
  const after = readFileSync(settingsFile, 'utf8');
  assert.doesNotMatch(after, /share\/yokoten/, 'no hook points at the removed runtime');
  assert.match(after, /my-own-hook/, "the user's own hook stays");
  // It runs once: the next start finds nothing and says nothing.
  const again = (await sandbox.call(['doctor', '--session'])).stdout;
  assert.doesNotMatch(again, /cleaned|older install/, 'a second start is quiet');
});

// #935: the runtime install kept because it was the running copy goes at the next start,
// since the plugin runs there. Another tool's hook still needs it, so it stays then.
test('doctor --session: another agent tool keeps the runtime and the launcher (#935)', async () => {
  const sandbox = makeSandbox();
  assert.equal((await sandbox.call(['install', '--list'])).status, 0);
  const settingsFile = join(sandbox.home, '.claude', 'settings.json');
  writeFileSync(settingsFile, JSON.stringify({ ...JSON.parse(readFileSync(settingsFile, 'utf8')), enabledPlugins: { 'yokoten@yokoten': true } }));
  mkdirSync(join(sandbox.home, '.codex'), { recursive: true });
  assert.ok(cleanOlderInstall(sandbox.env, { platform: 'linux' }).files > 0, 'the skills and agents are cleaned');
  assert.ok(existsSync(join(sandbox.home, '.local/share/yokoten', 'bin', 'yokoten.mjs')), 'the runtime stays for Codex');
  assert.ok(existsSync(join(launcherDir(sandbox.home), 'yokoten')), 'the launcher stays with the runtime');
  assert.ok(!existsSync(join(sandbox.home, '.claude/skills/yokoten')), 'the skills still go');
});

// A hook left after yokoten's own are taken out is the user's. A command that runs yokoten
// keeps the runtime; a name that only looks like it does not (the install test of #904
// takes the look-alike through install, and lets the runtime go).
test("doctor --session: a user's own hook that runs the runtime keeps it (#935)", async () => {
  const sandbox = makeSandbox();
  const settingsFile = join(sandbox.home, '.claude', 'settings.json');
  mkdirSync(dirname(settingsFile), { recursive: true });
  const hook = (command: string) => writeFileSync(settingsFile, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] } }));
  for (const command of ['node "$HOME/.local/share/yokoten/bin/yokoten.mjs" check', '"$HOME/.local/bin/yokoten" check', 'yokoten check', '$(yokoten check)', 'echo hi;yokoten check']) {
    hook(command);
    assert.equal(hookRunsYokoten(sandbox.env), true, command);
  }
  hook('my-yokoten check; node ~/.local/share/yokoten-old/run.mjs');
  assert.equal(hookRunsYokoten(sandbox.env), false, 'a look-alike runs no yokoten');
  // The session's cleanup asks the same question before it takes the runtime.
  assert.equal((await sandbox.call(['install', '--list'])).status, 0);
  const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
  settings.enabledPlugins = { 'yokoten@yokoten': true };
  settings.hooks.Stop = [{ hooks: [{ type: 'command', command: 'yokoten check' }] }];
  writeFileSync(settingsFile, JSON.stringify(settings));
  cleanOlderInstall(sandbox.env, { platform: 'linux' });
  assert.ok(existsSync(join(sandbox.home, '.local/share/yokoten', 'bin', 'yokoten.mjs')), 'the runtime stays while the hook runs it');
  assert.ok(existsSync(join(launcherDir(sandbox.home), 'yokoten')), 'the launcher stays with it');
});

test('doctor --session: without the plugin, an install stays as it is (#935)', async () => {
  const sandbox = makeSandbox();
  assert.equal((await sandbox.call(['install', '--list'])).status, 0);
  const settingsFile = join(sandbox.home, '.claude', 'settings.json');
  const before = readFileSync(settingsFile, 'utf8');
  assert.deepEqual(cleanOlderInstall(sandbox.env, { platform: 'linux' }), { files: 0, edits: [], profiles: [] });
  assert.ok(existsSync(join(sandbox.home, '.claude/skills/yokoten/SKILL.md')), 'the entry skill stays');
  assert.ok(existsSync(join(sandbox.home, '.local/share/yokoten', 'bin', 'yokoten.mjs')), 'the runtime stays');
  assert.ok(existsSync(join(launcherDir(sandbox.home), 'yokoten')), 'the launcher stays');
  assert.equal(readFileSync(settingsFile, 'utf8'), before, 'the hooks stay');
});

// #540: each place a copy sits gets its own fix. One table: what is here, then the whole note.
test('doctor: a home install and a project copy each get their own fix (#540)', async () => {
  const kitSkill = (name: string) => readFileSync(join(ROOT, 'kit/user/skills', name, 'SKILL.md'), 'utf8');
  const cases: { name: string; setUp: (sandbox: ReturnType<typeof makeSandbox>) => Promise<void>; note: string }[] = [
    {
      name: 'a home install and two project copies',
      setUp: async (sandbox) => {
        assert.equal((await sandbox.call(['install', '--list'])).status, 0);
        sandbox.write('.agents/skills/dispatch/SKILL.md', kitSkill('dispatch'));
        sandbox.write('.claude/skills/rca/SKILL.md', kitSkill('rca'));
      },
      note: 'the yokoten plugin is on, and `yokoten install` put these here too: the SessionStart doctor and the command guard in ~/.claude/settings.json; the skills in ~/.claude/skills and ~/.agents/skills; the agents in ~/.claude/agents; ~/.local/share/yokoten; `npx skills add` put a copy in this project too: `.agents/skills/dispatch` and `.claude/skills/rca`; remove the home copy with `yokoten uninstall` and delete `.agents/skills/dispatch` and `.claude/skills/rca`; the plugin brings its own',
    },
    {
      // The runtime is not a skill copy, so nothing at home is called one.
      name: 'a runtime-only home and a project copy',
      setUp: async (sandbox) => {
        mkdirSync(join(sandbox.home, '.local/share/yokoten'), { recursive: true });
        sandbox.write('.agents/skills/rca/SKILL.md', kitSkill('rca'));
      },
      note: 'the yokoten plugin is on, and `yokoten install` put these here too: ~/.local/share/yokoten; `npx skills add` put a copy in this project too: `.agents/skills/rca`; delete `.agents/skills/rca`; the plugin brings its own',
    },
    {
      name: 'a project skills-only copy',
      setUp: async (sandbox) => {
        sandbox.write('.agents/skills/rca/SKILL.md', kitSkill('rca'));
      },
      note: 'the yokoten plugin is on, and `npx skills add` put a copy in this project too: `.agents/skills/rca`; delete `.agents/skills/rca`; the plugin brings its own',
    },
  ];
  for (const { name, setUp, note } of cases) {
    const sandbox = makeSandbox();
    await setUp(sandbox);
    const file = join(sandbox.home, '.claude', 'settings.json');
    mkdirSync(dirname(file), { recursive: true });
    const settings = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    writeFileSync(file, JSON.stringify({ ...settings, enabledPlugins: { 'yokoten@yokoten': true } }));
    const found = doubleInstallCheck(sandbox.repo, sandbox.env);
    // The screen shows the home folder as ~.
    assert.equal(`${found?.what}; ${found?.fix}`.replaceAll(sandbox.home, '~'), note, name);
    assert.doesNotMatch(found?.fix ?? '', /delete `\.agents\/skills`(?!\/)|delete `\.claude\/skills`(?!\/)/, `${name}: the fix never names a whole skills folder`);
  }
});

// #211: Codex's and Gemini CLI's user hooks, only once the CLI's folder exists; a note
// that never changes the exit code, and ok after `install`.
test('doctor: notes the Codex and Gemini CLI user hooks when that CLI is used (#211)', async () => {
  for (const [agent, dir, file] of [['codex', '.codex', 'hooks.json'], ['gemini', '.gemini', 'settings.json']]) {
    const sandbox = makeSandbox();
    const name = `${agent}-user-hook`;
    const hookOf = () => userAgentHooks(sandbox.env).find((found) => found.name === name);
    assert.equal(hookOf(), undefined, `${agent}: no ~/${dir}, no line`);
    // Codex alone goes through the command: the exit code and the JSON are the same for both.
    const before = agent === 'codex' ? await sandbox.call(['doctor', '--json']) : null;
    mkdirSync(join(sandbox.home, dir));
    const noted = hookOf();
    assert.equal(noted?.ok, false);
    assert.equal(`${noted?.finding.what}; ${noted?.finding.fix}`, `no session-start doctor and no command guard in ~/${dir}/${file}; \`yokoten install\` adds them`);
    if (before) {
      const after = await sandbox.call(['doctor', '--json']);
      assert.equal(after.status, before.status, `${agent}: a note never changes the exit code`);
      const json = JSON.parse(after.stdout);
      assert.ok(json.notes.some((n: { id: string }) => n.id === name), `${agent}: a note in --json, under its own id`);
      assert.ok(!json.notes.some((n: { id: string; what: string }) => n.id === `${agent}-hook` && n.what.includes(`~/${dir}`)), `${agent}: not under the project rule's id`);
      assert.ok(!json.findings.some((n: { id: string }) => n.id === name), `${agent}: not a finding`);
    }
    // The folder exists by now, so install writes the hooks.
    assert.equal((await sandbox.call(['install', '--list'])).status, 0);
    assert.equal(hookOf()?.ok, true, `${agent}: ok after install`);
    const explain = (await sandbox.call(['explain', `${agent}-hook`])).stdout.replace(/\s+/g, ' ');
    assert.match(explain, /tool-call guard and stop check/);
    assert.match(explain, agent === 'codex' ? /a Stop hook/ : /an AfterAgent hook/);
    assert.doesNotMatch(explain, new RegExp(`~/${dir}`), `${agent}-hook is about the project only`);
    const explainUser = (await sandbox.call(['explain', name])).stdout;
    assert.match(explainUser, /session-start doctor and command guard/);
    assert.match(explainUser, new RegExp(`~/${dir}/${file}`));
  }
});

// #211 review: doctor compares each user hook with what install writes, so one missing,
// an old one, or a file it can't read each says so; a ~/.codex that is a file is no folder.
test('doctor: a missing, out-of-date or unreadable Codex or Gemini CLI user hook (#211)', async () => {
  for (const [agent, dir, file, guardEvent] of [['codex', '.codex', 'hooks.json', 'PreToolUse'], ['gemini', '.gemini', 'settings.json', 'BeforeTool']]) {
    const sandbox = makeSandbox();
    const name = `${agent}-user-hook`;
    const path = join(sandbox.home, dir, file);
    const noteOf = () => {
      const found = userAgentHooks(sandbox.env).find((hook) => hook.name === name);
      return found ? `${found.ok ? 'ok' : 'note'} ${found.finding.what}; ${found.finding.fix}` : null;
    };
    mkdirSync(join(sandbox.home, dir));
    assert.equal((await sandbox.call(['install', '--list'])).status, 0);
    const written = readFileSync(path, 'utf8');
    type Hooks = { hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]> };
    const edit = (change: (s: Hooks) => void) => {
      const settings: Hooks = JSON.parse(written);
      change(settings);
      writeFileSync(path, JSON.stringify(settings));
    };
    // Only the guard missing: its exact line, and "it".
    edit((s) => delete s.hooks[guardEvent]);
    assert.equal(noteOf(), `note no command guard in ~/${dir}/${file}; \`yokoten install\` adds it`);
    // The doctor hook from an older runtime path: out of date, not ok.
    edit((s) => {
      const hook = s.hooks.SessionStart[0].hooks[0];
      hook.command = hook.command.replace('.local/share/yokoten', '.yokoten');
    });
    assert.equal(noteOf(), `note the session-start doctor in ~/${dir}/${file} is out of date; \`yokoten install\` updates it`);
    // The guard on another matcher: out of date too.
    edit((s) => {
      s.hooks[guardEvent][0].matcher = 'other';
    });
    assert.equal(noteOf(), `note the command guard in ~/${dir}/${file} is out of date; \`yokoten install\` updates it`);
    assert.match((await sandbox.call(['install', '--list'])).stdout, /^ {2}updated +.*: command guard$/m);
    assert.match(noteOf() ?? '', /^ok /);
    // A file that won't parse: can't read it, never "missing".
    writeFileSync(path, '{ not json');
    assert.equal(noteOf(), `note can't read ~/${dir}/${file}; make it valid JSON, then run \`yokoten install\``);
    // A ~/.codex that is a file: not a folder, so doctor says nothing and install skips it.
    rmSync(join(sandbox.home, dir), { recursive: true });
    writeFileSync(join(sandbox.home, dir), 'a file');
    assert.equal(noteOf(), null);
    const install = await sandbox.call(['install', '--list']);
    assert.equal(install.status, 0, install.stderr);
    assert.match(install.stdout, new RegExp(`^ {2}skipped +.* in ~/\\${dir}: not installed here$`, 'm'));
    assert.equal(readFileSync(join(sandbox.home, dir), 'utf8'), 'a file');
  }
});

// #198: a plugin older than this yokoten is a note, in full doctor and in a session. A fake
// install in the fake HOME, laid out as Claude Code keeps it; the real one is never read.
test('doctor: notes an installed plugin older than this yokoten (#198)', async () => {
  const sandbox = makeSandbox();
  const version: string = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  const plugins = join(sandbox.home, '.claude', 'plugins');
  const folder = join(plugins, 'cache', 'yokoten', 'yokoten', 'abc123');
  mkdirSync(folder, { recursive: true });
  const enable = (on: boolean) => writeFileSync(join(sandbox.home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'yokoten@yokoten': on } }));
  const install = (entry: object) => writeFileSync(join(plugins, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'yokoten@yokoten': [{ scope: 'user', installPath: folder, version: 'abc123', ...entry }] } }));
  const pluginVersion = (v: string) => writeFileSync(join(folder, 'package.json'), JSON.stringify({ name: 'yokoten', version: v }));
  const age = () => pluginAgeCheck(sandbox.repo, sandbox.env);
  const olderNote = /the yokoten plugin is older than this yokoten/;

  // Positive control: an old plugin is noted, with the one command, and doctor does not fail on it.
  enable(true);
  install({ gitCommitSha: 'abc123' });
  pluginVersion('0.0.1');
  const lines = flat((await sandbox.call(['doctor', '--all'])).stdout).split('\n');
  const line = `  note        plugin: the yokoten plugin is older than this yokoten (0.0.1 < ${version}); update it: \`claude plugin update yokoten@yokoten\`; the next tool call runs the updated guard; a session which still has the old hook command needs one restart`;
  assert.ok(lines.includes(line), lines.join('\n'));
  assert.ok(!lines.some((l) => l.includes('MISSING plugin')));
  assert.match((await sandbox.call(['doctor', '--session'])).stdout, olderNote);
  const json = JSON.parse((await sandbox.call(['doctor', '--json'])).stdout);
  const jsonNote = json.notes.find((n: { what: string }) => olderNote.test(n.what));
  assert.ok(jsonNote, 'a note in JSON');
  assert.equal(jsonNote.id, 'plugin-version', 'its own rule, so `yokoten explain` tells the right thing');
  assert.match(jsonNote.docs, /#the-claude-code-plugin$/);
  assert.match((await sandbox.call(['explain', jsonNote.id])).stdout, /plugin is not older than the yokoten/);
  assert.ok(!json.findings.some((f: { what: string }) => olderNote.test(f.what)), 'not a finding');

  assert.match(age()?.what ?? '', olderNote, 'the same note, from the check itself');

  // The same version, or a newer one: nothing.
  pluginVersion(version);
  assert.equal(age(), null);
  pluginVersion('9999.0.0');
  assert.equal(age(), null);
  // Off in the settings: the plugin does not run, so its age does not matter.
  pluginVersion('0.0.1');
  enable(false);
  assert.equal(age(), null);
  enable(true);
  // A project install for another project is not this one's.
  install({ scope: 'project', projectPath: join(sandbox.home, 'elsewhere') });
  assert.equal(age(), null);
  // No install file, or an odd one: no note, no crash.
  for (const text of [null, 'not json', '{"plugins": []}', '{"plugins": {"yokoten@yokoten": "odd"}}', '{"plugins": {"yokoten@yokoten": [null, 7]}}']) {
    rmSync(join(plugins, 'installed_plugins.json'), { force: true });
    if (text !== null) writeFileSync(join(plugins, 'installed_plugins.json'), text);
    assert.equal(age(), null, String(text));
  }
  install({ gitCommitSha: 'abc123' });
  rmSync(join(folder, 'package.json'));
  assert.equal(age(), null, 'outside a yokoten checkout, a commit alone tells nothing');
});

test('doctor: in a yokoten checkout, a plugin commit behind the default branch is a note (#198)', () => {
  const sandbox = makeSandbox();
  sandbox.write('package.json', JSON.stringify({ name: 'yokoten', version: '0.0.1' }));
  sandbox.write('bin/yokoten.ts', '');
  sandbox.git('add', '.');
  sandbox.git('commit', '-q', '-m', 'feat: one');
  const first = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  const plugins = join(sandbox.home, '.claude', 'plugins');
  mkdirSync(plugins, { recursive: true });
  writeFileSync(join(sandbox.home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'yokoten@yokoten': true } }));
  // No installPath and no package.json: only the commit can tell.
  const install = (sha: string) => writeFileSync(join(plugins, 'installed_plugins.json'), JSON.stringify({ plugins: { 'yokoten@yokoten': [{ scope: 'user', version: sha.slice(0, 12), gitCommitSha: sha }] } }));
  const olderNote = /the yokoten plugin is older than this yokoten \(([0-9a-f]{12}) < ([0-9a-f]{12})\)/;
  const age = () => pluginAgeCheck(sandbox.repo, sandbox.env);
  const commit = (name: string) => {
    sandbox.write(`${name}.md`, `${name}\n`);
    sandbox.git('add', '.');
    sandbox.git('commit', '-q', '-m', `feat: ${name}`);
    return sandbox.git('rev-parse', 'HEAD').stdout.trim();
  };
  install(first);
  assert.equal(age(), null, 'the plugin is main');
  // The plugin is main's tip and doctor runs on a feature branch ahead of main: up to date,
  // though HEAD descends from it. An update could not help, so nothing.
  sandbox.git('checkout', '-q', '-b', 'feature');
  commit('two');
  assert.equal(age(), null, 'the plugin is main, HEAD is ahead');
  // Positive control: main moves on, so the plugin is one commit behind it, on any branch.
  sandbox.git('checkout', '-q', 'main');
  const tip = commit('three');
  sandbox.git('checkout', '-q', 'feature');
  assert.deepEqual(age()?.what.match(olderNote)?.slice(1), [first.slice(0, 12), tip.slice(0, 12)]);
  // A commit this repo doesn't know: can't tell, so nothing.
  install('0'.repeat(40));
  assert.equal(age(), null);
  // No origin/HEAD, origin/main or main: no default branch to compare with, so nothing.
  install(first);
  sandbox.git('branch', '-q', '-m', 'main', 'trunk');
  assert.equal(age(), null, 'no main ref');
});

// #760, #775: merge commits whose time is not UTC are counted in the last 200 commits on the
// default branch, and the command the note prints shows the same commits. The history is one
// `git fast-import`: 216 commits on main, an old merge at #16 outside the window, and a new
// one at #216; and a branch whose merge is UTC.
test('mergeTimeZones: counts merge commits not in UTC, and prints one command that shows the same commits (#760, #775)', () => {
  const sandbox = makeSandbox();
  const when = Date.UTC(2026, 8, 1) / 1000;
  const stream: string[] = [];
  let mark = 0;
  const commit = (ref: string, message: string, zone: string, parents: { from?: number; merge?: number } = {}) => {
    mark += 1;
    const who = `A <a@example.com> ${when} ${zone}`;
    stream.push(`commit ${ref}`, `mark :${mark}`, `author ${who}`, `committer ${who}`, `data ${Buffer.byteLength(message)}`, message);
    if (parents.from) stream.push(`from :${parents.from}`);
    if (parents.merge) stream.push(`merge :${parents.merge}`);
    stream.push('');
    return mark;
  };
  const history = (ref: string, plain: number, zone: string, tip = 0) => {
    for (let i = 0; i < plain; i++) tip = commit(ref, `plain ${i}`, '+0000', tip ? { from: tip } : {});
    const topic = commit('refs/heads/topic', 'on topic', '+0000', { from: tip });
    return commit(ref, `merge ${zone}`, zone, { from: tip, merge: topic });
  };
  const old = history('refs/heads/main', 15, '+0900');
  const recent = history('refs/heads/main', 199, '+0900', old);
  history('refs/heads/utc', 1, '+0000');
  const marksFile = join(sandbox.home, 'marks');
  execFileSync('git', ['fast-import', '--quiet', `--export-marks=${marksFile}`], { cwd: sandbox.repo, env: sandbox.env, input: stream.join('\n') });
  const shas = new Map(readFileSync(marksFile, 'utf8').trim().split('\n').map((line) => line.split(' ') as [string, string]));
  const sha = (of: number) => shas.get(`:${of}`) ?? '';

  // Positive control: the merge in the window is counted, and the zone itself is not printed.
  const found = mergeTimeZones(sandbox.repo, sandbox.env);
  assert.equal(found?.id, 'time-zone');
  assert.equal(found?.what, '1 merge commit(s) among the last 200 commits on the default branch carry an author or committer time zone other than UTC');
  assert.match(found?.fix ?? '', /^see them with `git log /);
  assert.doesNotMatch(`${found?.what} ${found?.fix}`, /\+0900/, 'the time zone value is never printed');
  // Full doctor prints it as one note line, and nowhere the zone.
  const full = doctor(sandbox.repo, { env: sandbox.env, config: DEFAULTS, gh: () => { throw new Error('no network in this test'); } });
  assert.ok(flat(full.lines.join('\n')).split('\n').includes(`  note        time-zone: ${found?.what}; ${found?.fix}`), full.lines.join('\n'));
  assert.ok(!JSON.stringify(full).includes('+0900'), 'the time zone value is never printed');
  // The printed command shows exactly that one merge, not the older one outside the window.
  const command = /`(git log[^`]+)`/.exec(found?.fix ?? '')?.[1];
  assert.ok(command, found?.fix);
  if (process.platform !== 'win32') {
    const shown = execFileSync('sh', ['-c', command], { cwd: sandbox.repo, env: sandbox.env, encoding: 'utf8' }).trim();
    assert.equal(shown.split('\n').length, 1, shown);
    assert.match(shown, new RegExp(`^${sha(recent).slice(0, 7)}`), 'the newer merge is shown');
    assert.doesNotMatch(shown, new RegExp(sha(old).slice(0, 7)), 'the older merge is outside the window');
  }

  // All UTC: no note at all.
  execFileSync('git', ['update-ref', 'refs/heads/main', 'refs/heads/utc'], { cwd: sandbox.repo, env: sandbox.env });
  assert.equal(mergeTimeZones(sandbox.repo, sandbox.env), null);
});

test('privacyNotes: the mailmap, and the kinds of mark yokoten cannot find; never a value (#390)', () => {
  const home = makeTempDir('yokoten-privacy-');
  const env = { HOME: home, GIT_CONFIG_GLOBAL: join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  const notes = () => privacyNotes(env, null).map((note) => `${note.name}: ${note.finding.what}; ${note.finding.fix}`);
  // No marks at all: the private-marks check says so, and no offer adds a second answer (#522).
  assert.deepEqual(notes(), ['mailmap: git log and git show print your name and email as they are; run `yokoten install`; it writes ~/.config/yokoten/mailmap and sets `git config --global mailmap.file ~/.config/yokoten/mailmap`, so git prints a private address in place of your email']);
  execFileSync('git', ['config', '--global', 'mailmap.file', '~/.config/yokoten/mailmap'], { env: { ...process.env, ...env } });
  mkdirSync(join(home, '.config', 'yokoten'), { recursive: true });
  // Only the name install found: the other kinds are an optional offer. The name is not asked for (#434).
  writeFileSync(join(home, '.config', 'yokoten', 'private-marks'), '# added by yokoten from this machine: git name\nJane Example\n');
  assert.deepEqual(notes(), ["private-mark-kinds: optional: add your city or your domains too; yokoten can't find them on its own; run `yokoten marks add` and type one; it is not shown"]);
  writeFileSync(join(home, '.config', 'yokoten', 'private-marks'), 'Jane Example\nFakeville\njanex.dev\n');
  assert.deepEqual(notes(), []);
  execFileSync('git', ['config', '--global', 'mailmap.file', '/elsewhere/mailmap'], { env: { ...process.env, ...env } });
  assert.deepEqual(notes(), ['mailmap: git uses your own mailmap file, not ~/.config/yokoten/mailmap; add the lines of ~/.config/yokoten/mailmap to your file']);
  // Another agent on this machine: its output is not filtered, and the note says how to opt in.
  mkdirSync(join(home, '.codex'));
  assert.equal(notes()[0], 'private-output: only Claude Code hides your details in command output; other agents show it as it is; to stop those commands there instead, set "privacy": { "output": "stop" } in yokoten.json');
  assert.equal(privacyNotes(env, null, 'stop').length, 1, 'with "stop", only the mailmap note is left');
  rmSync(home, { recursive: true, force: true });
});

// #433: install's runtime is here, but no `yokoten` on the PATH runs it, so a message that
// says `yokoten init` names a command the shell can't find.
test('doctor: a note when no yokoten on the PATH runs the installed copy (#433)', () => {
  const home = makeTempDir('yokoten-launcher-');
  const runtime = join(home, '.local', 'share', 'yokoten');
  const env = { HOME: home, PATH: dirname(process.execPath) };
  // No runtime installed: install's own checks say so, not this note.
  assert.equal(launcherCheck(env, 'linux'), null);
  mkdirSync(join(runtime, 'bin'), { recursive: true });
  writeFileSync(join(runtime, 'bin', 'yokoten.ts'), '\n');
  const note = launcherCheck(env, 'linux');
  assert.equal(note?.what, 'the yokoten launcher is not on your PATH, so a bare yokoten command is not found');
  // No launcher yet: the one fix is install, run the way that works now. No line says to type the runtime's path (#500).
  assert.match(note?.fix ?? '', /^run \`npx yokoten install\`; it puts a launcher in .*\.local[\\/]bin/);
  // The launcher in ~/.local/bin, with that folder on the PATH: no note.
  setUpLauncher(env, runtime, home, { platform: 'linux' });
  const off = launcherCheck(env, 'linux');
  assert.notEqual(off, null, 'a launcher off the PATH still gets the note');
  // The launcher is there: the fix is the one line for the PATH, and says npx works meanwhile.
  assert.match(off?.fix ?? '', /^add this line to your shell profile .* then open a new terminal: export PATH=.*; until then, \`npx yokoten\` runs yokoten$/);
  assert.doesNotMatch(`${off?.what} ${off?.fix} ${off?.why}`, /yokoten\.ts/);
  assert.equal(launcherCheck({ ...env, PATH: `${launcherDir(home)}:${env.PATH}` }, 'linux'), null);
  // The platform is an argument (record 0040): the Windows launcher gets the Windows fix, on any system.
  setUpLauncher(env, runtime, home, { platform: 'win32' });
  assert.match(launcherCheck(env, 'win32')?.fix ?? '', /^add .*\.local[\\/]bin to the Path for your account/);
  // With the plugin on, its own commands are used: no note.
  mkdirSync(join(home, '.claude'));
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'yokoten@yokoten': true } }));
  assert.equal(launcherCheck(env, 'linux'), null);
});

// #500: after a fresh install, every line that names a command uses one way to run yokoten.
test('doctor: with the launcher off the PATH, every command in the text is `npx yokoten`; on the PATH, `yokoten` (#500)', () => {
  const home = makeTempDir('yokoten-one-way-');
  const root = join(home, 'repo');
  mkdirSync(root);
  execFileSync('git', ['init', '-q', root]);
  const runtime = join(home, '.local', 'share', 'yokoten');
  mkdirSync(join(runtime, 'bin'), { recursive: true });
  writeFileSync(join(runtime, 'bin', 'yokoten.ts'), '\n');
  const gitDir = dirname(execFileSync(process.platform === 'win32' ? 'where' : 'which', ['git'], { encoding: 'utf8' }).trim().split('\n')[0]);
  const env = { HOME: home, PATH: [dirname(process.execPath), gitDir].join(delimiter), YOKOTEN_TEMP_DIRS: '' };
  setUpLauncher(env, runtime, home);
  const run = (e: Record<string, string>, session = false) => doctor(root, { env: e, config: DEFAULTS, session, gh: () => { throw new Error('no network'); } });
  for (const session of [false, true]) {
    const text = JSON.stringify(run(env, session));
    assert.doesNotMatch(text, /`yokoten[ `]/, 'no bare yokoten command while the launcher is off the PATH');
    assert.match(text, /`npx yokoten init`/);
    assert.doesNotMatch(text, /node [^"]*yokoten\.ts install/);
  }
  const full = flat(run(env).lines.join('\n'));
  assert.match(full, /note +command: the yokoten launcher is not on your PATH.*until then, `npx yokoten` runs yokoten/);
  // The launcher is on the PATH: the messages stay as written, and there is no note.
  const onPath = run({ ...env, PATH: `${launcherDir(home)}${delimiter}${env.PATH}` }).lines.join('\n');
  assert.match(onPath, /`yokoten init`/);
  assert.doesNotMatch(onPath, /npx yokoten|launcher is not on your PATH/);
  // Run by npx with nothing installed: `npx yokoten` too.
  const bare = makeTempDir('yokoten-npx-');
  const viaNpx = doctor(root, { env: { HOME: bare, npm_command: 'exec', PATH: env.PATH, YOKOTEN_TEMP_DIRS: '' }, config: DEFAULTS, gh: () => { throw new Error('no network'); } });
  assert.match(viaNpx.lines.join('\n'), /`npx yokoten init`/);
});

// #1097: the desk fence needs bwrap, rg and socat on Linux; doctor says which are missing, and never installs.
test('deskFenceCheck: on Linux, each missing fence program is named with the command that installs it (#1097)', () => {
  const env = { PATH: '/usr/bin:/usr/local/bin' };
  const onDisk = (names: string[]) => (path: string) => names.some((name) => path === `/usr/bin/${name}`);
  const cases: [string, string[], RegExp | null][] = [
    ['all there', ['bwrap', 'rg', 'socat'], null],
    ['rg missing', ['bwrap', 'socat'], /^the desk fence can't start: rg is not installed$/],
    ['socat missing', ['bwrap', 'rg'], /^the desk fence can't start: socat is not installed$/],
    ['both missing', ['bwrap'], /^the desk fence can't start: rg and socat are not installed$/],
  ];
  for (const [name, present, what] of cases) {
    const found = deskFenceCheck(env, 'linux', onDisk(present));
    assert.equal(found?.ok, what === null, name);
    if (what) assert.match(found?.finding.what ?? '', what, name);
  }
  const missing = deskFenceCheck(env, 'linux', onDisk([]));
  assert.equal(missing?.finding.fix, 'run `sudo apt install bubblewrap ripgrep socat` on Debian or Ubuntu, or install bubblewrap, ripgrep and socat with your system\'s package manager');
  assert.deepEqual(Object.keys(FENCE_PROGRAMS), ['bwrap', 'rg', 'socat']);
  // macOS and Windows start the fence their own way: no row.
  for (const platform of ['darwin', 'win32'] as const) assert.equal(deskFenceCheck(env, platform, onDisk([])), null, platform);
});

// The whole-doctor control needs a POSIX PATH: on Windows the list is Path and its folders are not
// POSIX-absolute, so a Linux check cannot read it there (listed in scripts/time/windows-known.txt).
test('deskFenceCheck in full doctor: a note with the install command, never a failure (#1097)', () => {
  const onDisk = (present: string[]) => (path: string) => present.some((name) => path.endsWith(`/${name}`));
  const sandbox = makeSandbox();
  const noGh = () => { throw new Error('no network in this test'); };
  const full = doctor(sandbox.repo, { env: sandbox.env, config: DEFAULTS, gh: noGh, platform: 'linux', isFile: onDisk([]) });
  const fine = doctor(sandbox.repo, { env: sandbox.env, config: DEFAULTS, gh: noGh, platform: 'linux', isFile: () => true });
  assert.ok(flat(full.lines.join('\n')).includes("  note        desk-fence: the desk fence can't start: bwrap, rg and socat are not installed; run `sudo apt install"), full.lines.join('\n'));
  assert.equal(full.ok, fine.ok, 'a note never fails doctor');
  assert.ok(full.report.notes?.some((found) => found.id === 'desk-fence'));
  assert.ok(!fine.report.notes?.some((found) => found.id === 'desk-fence'));
});
