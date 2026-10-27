// Tests for src/setup/install.ts.

import '../repo/home.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  delimiter,
  dirname,
  join,
  relative,
  sep,
} from 'node:path';
import { test } from 'node:test';
import { shareGuardMeasure, shareSelfTest } from '../repo/helpers.ts';
import {
  at,
  COMMENTED,
  commentedGemini,
  doctorHandAdd,
  makeSandbox,
  makeTempDir,
  onToolCall,
  ROOT,
} from '../repo/helpers.ts';
import { hasHook } from '../../src/agents/hooks-file.ts';
import { RENAME_WAITS_MS, renameRetrying } from '../../src/platform/disk.ts';
import { copyRuntime, isEditedManaged, isSameOrInside, sealManaged, type SetupResult, writeManaged } from '../../src/setup/files.ts';
import { addOwnMark, cleanOlderInstall, countMarkKinds, filledLines, fillMarks, hasMarks, install, isMachineSetUp, isOnPath, launcherText, machineStateFile, machineUserNames, migrateMarks, paths, PROFILE_LINE, setUpLauncher, shellProfile, type Steps, uninstall, USER_CLI, type UserNameProbe, writeFileAtomic } from '../../src/setup/install.ts';
import { autoLogins, loadMarkKinds, makeRedactor } from '../../src/rules/privacy.ts';

shareGuardMeasure();
shareSelfTest();

/** The system these tests run on, passed down as a runner passes it. */
const PLATFORM = process.platform;

/** install for a sandbox in this process, as `yokoten install` runs it in a pipe: nobody to ask. */
const installIn = (sandbox: { env: NodeJS.ProcessEnv; repo: string }, more: Parameters<typeof install>[1] = {}): SetupResult => install(sandbox.env, { cwd: sandbox.repo, platform: PLATFORM, ...more });

/** uninstall for a sandbox in this process. */
const uninstallIn = (sandbox: { env: NodeJS.ProcessEnv }): SetupResult => uninstall(sandbox.env, { platform: PLATFORM });

/**
 * A result's changes as short rows a test reads in one look: the state, the kind, the path
 * with the home as ~ and / between folders, then `yours` and the agent when it has them.
 */
function rowsOf(result: SetupResult, home: string): string[] {
  return result.changes.map((change) => [change.state, change.kind, change.path.split(home).join('~').split(sep).join('/'), ...(change.yours ? ['yours'] : []), ...(change.agent ? [change.agent] : [])].join(' '));
}

/** Assert that `result` holds each row, as rowsOf writes it. */
function assertRows(result: SetupResult, home: string, ...rows: string[]): void {
  const have = rowsOf(result, home);
  for (const row of rows) assert.ok(have.includes(row), `no change "${row}" in:\n${have.join('\n')}`);
}

/** The text of a result's notes and problems, home as ~, for a test that looks for one. */
const findingsOf = (result: SetupResult, home: string): string => [...result.notes, ...result.problems].map((f) => `${f.id}: ${f.what}; ${f.why}; ${f.fix}`.split(home).join('~').split(sep).join('/')).join('\n');

const BAD_USER_SETTINGS: [content: string, reason: (file: string) => string][] = [
  ['{ not json', (file) => `${file} is not valid JSON`],
  ['{"hooks": "x"}\n', (file) => `${file} has an unexpected shape (hooks should be an object)`],
  ['[]', (file) => `${file} has an unexpected shape (the file should be a JSON object)`],
  // A deep shape in the second event install adds: checked before the first is written.
  ['{"hooks":{"PreToolUse":[{"hooks":5}]}}', (file) => `${file} has an unexpected shape (hooks.PreToolUse[0].hooks should be a list of objects)`],
];

test('install: skills, agents and hooks once, the user\'s own files untouched', async () => {
  const sandbox = makeSandbox();
  const claude = join(sandbox.home, '.claude');
  const shared = join(sandbox.home, '.agents');
  mkdirSync(join(claude, 'agents'), { recursive: true });
  writeFileSync(join(claude, 'agents', 'reviewer.md'), 'my own reviewer\n');
  // The user's own skill in the shared folder, with a kit skill's name.
  mkdirSync(join(shared, 'skills', 'rca'), { recursive: true });
  writeFileSync(join(shared, 'skills', 'rca', 'SKILL.md'), 'my own rca\n');
  writeFileSync(join(claude, 'settings.json'), JSON.stringify({ model: 'x', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'other' }] }] } }));
  // An unknown option is refused, and nothing is written (#203).
  const homeBefore = readdirSync(sandbox.home, { recursive: true }).sort();
  let result: { status: number | null; stdout: string; stderr: string } = await sandbox.call(['install', '--dry-run']);
  assert.deepEqual([result.status, result.stdout, result.stderr], [1, '', 'note: yokoten install moved to yokoten. It runs as before this time.\n\nyokoten install · unknown option --dry-run\n\n  install     skills, agents and user-level hooks for this machine\n\nNext: `yokoten install --help`\n']);
  assert.deepEqual(readdirSync(sandbox.home, { recursive: true }).sort(), homeBefore, 'install --dry-run writes nothing');
  // A real child, for the entry: the exit code and output through bin/yokoten.ts.
  result = sandbox.run(['install', '--list']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^ {2}kept {8}agent reviewer \(yours, not yokoten's\)$/m);
  assert.equal(readFileSync(join(claude, 'agents', 'reviewer.md'), 'utf8'), 'my own reviewer\n');
  // One entry skill: Claude Code's folder, and the shared one other agents read (#904).
  const kitSkills = readdirSync(join(sandbox.home, '.local/share/yokoten/kit/user/skills'));
  assert.ok(kitSkills.includes('release'), 'the release skill (#34)');
  // The release skill leaves the tag to the owner: the tag command it gives is stopped for an agent.
  const releaseSkill = readFileSync(join(sandbox.home, '.local/share/yokoten/kit/user/skills/release/SKILL.md'), 'utf8');
  const tagLine = releaseSkill.match(/`(git tag [^`]+)`/);
  assert.ok(tagLine);
  // A real child: the guard's exit code 2 comes from the entry point.
  assert.equal(sandbox.run(['hook'], { input: JSON.stringify({ cwd: sandbox.repo, tool_input: { command: tagLine[1].replaceAll('X.Y.Z', '1.2.3') } }) }).status, 2);
  for (const name of kitSkills) {
    if (name === 'yokoten' || name === 'rca') continue;
    assert.ok(!existsSync(join(claude, 'skills', name)), `no global copy of ${name}`);
    assert.ok(!existsSync(join(shared, 'skills', name)), `no shared copy of ${name}`);
  }
  assert.ok(existsSync(join(claude, 'skills', 'yokoten', 'SKILL.md')), '~/.claude/skills/yokoten');
  assert.ok(existsSync(join(shared, 'skills', 'yokoten', 'SKILL.md')), '~/.agents/skills/yokoten');
  assert.match(result.stdout, /^ {2}wrote {7}skill yokoten in ~\/\.claude\/skills$/m);
  assert.match(result.stdout, /^ {2}linked {6}skill yokoten in ~\/\.agents\/skills$/m);
  // The shared folder holds one link to Claude Code's copy, so Muse, which reads both
  // folders, sees the entry skill once and warns about none (#557).
  assert.equal(readlinkSync(join(shared, 'skills', 'yokoten')), join(claude, 'skills', 'yokoten'));
  // The entry names where the rest live.
  assert.match(readFileSync(join(claude, 'skills', 'yokoten', 'SKILL.md'), 'utf8'), /kit\/user\/skills\/<name>\/SKILL\.md/);
  assert.match(result.stdout, /^ {2}kept {8}skill rca in ~\/\.agents\/skills \(yours, not yokoten's\)$/m);
  assert.equal(readFileSync(join(shared, 'skills', 'rca', 'SKILL.md'), 'utf8'), 'my own rca\n');
  assert.ok(!existsSync(join(shared, 'agents')), 'agents stay Claude-only');
  const marks = join(sandbox.home, '.config/yokoten/private-marks');
  assert.equal(statSync(marks).mode & 0o777, 0o600);
  // The git display name is no mark: a common name would flag every file holding the word.
  assert.ok(!readFileSync(marks, 'utf8').includes('Jane Example'));
  assertRows(installIn(sandbox), sandbox.home, 'kept skill ~/.claude/skills/yokoten', 'kept skill ~/.agents/skills/yokoten', 'kept skill ~/.agents/skills/rca yours');
  const settings = JSON.parse(readFileSync(join(claude, 'settings.json'), 'utf8'));
  assert.equal(settings.model, 'x');
  assert.equal(settings.hooks.SessionStart.length, 1);
  assert.equal(settings.hooks.PreToolUse.length, 2);
  assert.equal(settings.hooks.Stop, undefined, "the stop check reads files, so it is per project, from init (#92)");
  // The installed copy runs on its own.
  const doctor = spawnSync('node', [join(sandbox.home, '.local/share/yokoten/bin/yokoten.ts'), 'doctor', '--session'], { cwd: sandbox.repo, env: sandbox.env, encoding: 'utf8' });
  assert.equal(doctor.status, 0, doctor.stderr);
  assert.match(doctor.stdout, /private-marks is missing or has no marks/);
  // The home folder names the machine's user; it never shows (#25).
  for (const out of [result.stdout, doctor.stdout]) assert.ok(!out.includes(sandbox.home), 'output shows the home path');
  assert.match(doctor.stdout, /~\/\.config\/yokoten\/private-marks/);
  // The skills check wants the one entry skill in both folders, and names what is missing.
  // Skills are a step on the road, stage 4.
  const skillsLine = async () => (await sandbox.call(['doctor', '--all'])).stdout.split('\n').find((l) => / skills/.test(l)) ?? '';
  assert.match(await skillsLine(), /^\s+done\s+skills$/);
  rmSync(join(shared, 'skills', 'yokoten'), { recursive: true });
  assert.match(await skillsLine(), /^\s+(next|to do)\s+skills: the yokoten skills are not in ~\/\.agents\/skills \(yokoten\); run `npx yokoten install`, or install the Claude Code plugin$/);
});

test('isMachineSetUp: false before install, true after, false when the runtime is gone (#548)', async () => {
  const sandbox = makeSandbox();
  assert.equal(isMachineSetUp(sandbox.env), false, 'a fresh machine is not set up');
  assert.equal((await sandbox.call(['install', '--list'])).status, 0);
  assert.equal(isMachineSetUp(sandbox.env), true, 'install set the machine up');
  // The runtime the user hooks run is the one piece that must be there.
  rmSync(join(paths(sandbox.env).runtime, 'bin'), { recursive: true });
  assert.equal(isMachineSetUp(sandbox.env), false, 'no runtime, no working hooks');
});

test('uninstall: takes back what install wrote, keeps the user\'s own files and settings (#300)', async () => {
  const sandbox = makeSandbox();
  const claude = join(sandbox.home, '.claude');
  mkdirSync(join(claude, 'skills', 'mine'), { recursive: true });
  writeFileSync(join(claude, 'skills', 'mine', 'SKILL.md'), 'my own skill\n');
  // The user's own skill with a kit skill's name, and a file of theirs next to a managed one.
  mkdirSync(join(sandbox.home, '.agents', 'skills', 'rca'), { recursive: true });
  writeFileSync(join(sandbox.home, '.agents', 'skills', 'rca', 'SKILL.md'), 'my own rca\n');
  const own = { model: 'x', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'other' }] }] } };
  writeFileSync(join(claude, 'settings.json'), JSON.stringify(own));
  assert.equal((await sandbox.call(['install', '--list'])).status, 0);
  writeFileSync(join(claude, 'skills', 'yokoten', 'notes.txt'), 'mine\n');
  const before = readdirSync(join(sandbox.home, '.local/share/yokoten/kit/user/skills'));

  // A real child, for the entry.
  const result = sandbox.run(['uninstall', '--list']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^ {2}removed {5}skill yokoten in ~\/\.claude\/skills$/m);
  assert.ok(!result.stdout.includes(sandbox.home), 'output shows the home path');
  // The shared link is removed, never followed: only the user's own skill is left there.
  assert.deepEqual(readdirSync(join(sandbox.home, '.agents', 'skills')), ['rca']);
  // Only what was there is named: a kit skill install never wrote is no change.
  for (const name of before.filter((n) => n !== 'yokoten' && n !== 'rca')) assert.doesNotMatch(result.stdout, new RegExp(`skill ${name} in`));
  assert.match(result.stdout, /^ {2}kept {8}skill rca in ~\/\.agents\/skills \(yours, not yokoten's\)$/m);
  assert.match(result.stdout, /^ {2}removed {5}agent worker$/m);
  assert.match(result.stdout, /^ {2}removed {5}Claude Code hooks in ~\/\.claude\/settings\.json: SessionStart doctor$/m);
  assert.match(result.stdout, /^ {2}removed {5}the runtime ~\/\.local\/share\/yokoten$/m);
  assert.match(result.stdout, /^ {2}removed {5}~\/\.config\/yokoten\/private-marks$/m);
  // No file with the managed mark is left anywhere in the home.
  const left = readdirSync(sandbox.home, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
  assert.deepEqual(left.filter((entry) => readFileSync(join(entry.parentPath, entry.name), 'utf8').includes('managed by yokoten')).map((entry) => entry.name), []);
  assert.ok(!existsSync(join(sandbox.home, '.local/share/yokoten')));
  assert.equal(readFileSync(join(claude, 'skills', 'mine', 'SKILL.md'), 'utf8'), 'my own skill\n');
  assert.equal(readFileSync(join(sandbox.home, '.agents', 'skills', 'rca', 'SKILL.md'), 'utf8'), 'my own rca\n');
  assert.equal(readFileSync(join(claude, 'skills', 'yokoten', 'notes.txt'), 'utf8'), 'mine\n');
  assert.ok(!existsSync(join(sandbox.home, '.config/yokoten')), 'the header-only marks went with install');
  assert.deepEqual(JSON.parse(readFileSync(join(claude, 'settings.json'), 'utf8')), own);

  // A second run finds nothing to remove and changes nothing.
  const homeBefore = readdirSync(sandbox.home, { recursive: true }).sort();
  const again = uninstallIn(sandbox);
  assert.ok(again.ok);
  assert.deepEqual(again.changes.filter((change) => change.state === 'removed'), []);
  assert.deepEqual(readdirSync(sandbox.home, { recursive: true }).sort(), homeBefore);

  // A settings file that is not JSON is left as it is, and the result says so: uninstall exits 1.
  writeFileSync(join(claude, 'settings.json'), 'not json');
  const broken = uninstallIn(sandbox);
  assert.equal(broken.ok, false);
  assert.match(findingsOf(broken, sandbox.home), /^user-guard: ~\/\.claude\/settings\.json is not JSON, so the Claude Code hooks are still in it;/m);
  assert.equal((await sandbox.call(['uninstall'])).status, 1);
  assert.equal(readFileSync(join(claude, 'settings.json'), 'utf8'), 'not json');
});

// #984: install never breaks or loses the user's settings file.
test('install: a symlinked ~/.claude/settings.json stays a link, through install and uninstall (#984)', async () => {
  const sandbox = makeSandbox();
  const dotfiles = join(sandbox.home, 'dotfiles');
  mkdirSync(dotfiles, { recursive: true });
  mkdirSync(join(sandbox.home, '.claude'));
  const real = join(dotfiles, 'claude-settings.json');
  const link = join(sandbox.home, '.claude', 'settings.json');
  writeFileSync(real, '{"model":"x"}\n');
  symlinkSync(real, link);
  assert.equal((await sandbox.call(['install', '--list'])).status, 0);
  assert.ok(lstatSync(link).isSymbolicLink(), 'install keeps the link');
  assert.ok(hasHook(real, 'PreToolUse', 'hook'), 'the hooks went into the file the link points at');
  assert.equal((await sandbox.call(['uninstall', '--list'])).status, 0);
  assert.ok(lstatSync(link).isSymbolicLink(), 'uninstall keeps the link');
  assert.deepEqual(JSON.parse(readFileSync(real, 'utf8')), { model: 'x' });
  // A linked file that only holds yokoten's hooks is emptied, not unlinked: the link is the user's.
  writeFileSync(real, '{}\n');
  assert.equal((await sandbox.call(['install', '--list'])).status, 0);
  assert.equal((await sandbox.call(['uninstall', '--list'])).status, 0);
  assert.ok(lstatSync(link).isSymbolicLink(), 'uninstall keeps a link to a file it emptied');
  assert.deepEqual(JSON.parse(readFileSync(real, 'utf8')), {});
});

test('install: the first change to the user\'s settings keeps one .before-yokoten copy, never overwritten (#984)', async () => {
  const sandbox = makeSandbox();
  const file = join(sandbox.home, '.claude', 'settings.json');
  mkdirSync(dirname(file));
  writeFileSync(file, '{"model":"x"}\n');
  assert.equal((await sandbox.call(['install', '--list'])).status, 0);
  assert.equal(readFileSync(`${file}.before-yokoten`, 'utf8'), '{"model":"x"}\n');
  // The user changes the file, and install changes it again: the copy still holds the first version.
  const settings = JSON.parse(readFileSync(file, 'utf8'));
  settings.model = 'y';
  settings.hooks.SessionStart[0].hooks[0].command += ' ';
  writeFileSync(file, JSON.stringify(settings));
  assert.equal((await sandbox.call(['install', '--list'])).status, 0);
  assert.equal(readFileSync(`${file}.before-yokoten`, 'utf8'), '{"model":"x"}\n', 'the copy is never overwritten');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).model, 'y');
  // A home with no settings file before install gets no copy: install made the file.
  const empty = makeSandbox();
  assert.equal((await empty.call(['install', '--list'])).status, 0);
  assert.ok(!existsSync(join(empty.home, '.claude', 'settings.json.before-yokoten')));
});

test("install and uninstall: a user's own npx yokoten hook stays (#984)", async () => {
  const sandbox = makeSandbox();
  const file = join(sandbox.home, '.claude', 'settings.json');
  mkdirSync(dirname(file));
  const own = { matcher: 'Bash', hooks: [{ type: 'command', command: 'npx yokoten hook --agent claude-code' }] };
  const doctor = { hooks: [{ type: 'command', command: 'npx --yes yokoten doctor --session' }] };
  writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [own], SessionStart: [doctor] } }));
  assert.equal((await sandbox.call(['install', '--list'])).status, 0);
  let hooks = JSON.parse(readFileSync(file, 'utf8')).hooks;
  assert.deepEqual(hooks.PreToolUse[0], own, 'install keeps the user\'s guard');
  assert.deepEqual(hooks.SessionStart[0], doctor, 'install keeps the user\'s doctor');
  assert.equal(hooks.PreToolUse.length, 2, 'and adds its own beside it');
  assert.equal((await sandbox.call(['uninstall', '--list'])).status, 0);
  hooks = JSON.parse(readFileSync(file, 'utf8')).hooks;
  assert.deepEqual(hooks, { PreToolUse: [own], SessionStart: [doctor] }, 'uninstall takes out only yokoten\'s own hooks');
});

// #904: with the Claude Code plugin on, install writes no global skill or agent, and takes
// back the copies it wrote before. A file of the user's stays.
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
  assert.doesNotMatch((await sandbox.call(['doctor', '--all'])).stdout, /plugin-and-install/, 'nothing is left for the plugin to duplicate');
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
  assert.match((await sandbox.call(['doctor', '--all'], { extra })).stdout, /ok +session-doctor/, 'doctor reads the same folder');
  // A session with the plugin on takes back what install left, in the same folder.
  settings.enabledPlugins = { 'yokoten@yokoten': true };
  writeFileSync(settingsFile, JSON.stringify(settings));
  const cleaned = cleanOlderInstall({ ...sandbox.env, ...extra });
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
  assert.match((await sandbox.call(['install'])).stdout, /^ {2}note {8}kept {8}your own edits stay; the newest copies are in the kit$/m);

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
    assert.match(result.stdout, /^ {2}kept {8}the runtime ~\/\.local\/share\/yokoten: the copy running now$/m);
    assert.ok(!result.stdout.includes(sandbox.home), 'output shows the home path');
    assert.ok(existsSync(installed), 'the installed copy is still there');
  }
});

test('install: the session doctor and the command guard for Codex and Gemini CLI, safe twice (#211)', async () => {
  const sandbox = makeSandbox();
  const codexFile = join(sandbox.home, '.codex', 'hooks.json');
  const geminiFile = join(sandbox.home, '.gemini', 'settings.json');
  // No ~/.codex or ~/.gemini: install makes neither, and says so.
  const skipped = installIn(sandbox);
  assert.ok(skipped.ok, findingsOf(skipped, sandbox.home));
  assertRows(skipped, sandbox.home, 'skipped hook ~/.codex Codex CLI', 'skipped hook ~/.gemini Gemini CLI');
  assert.ok(!existsSync(dirname(codexFile)), 'no ~/.codex made');
  assert.ok(!existsSync(dirname(geminiFile)), 'no ~/.gemini made');
  const mine = (event: string) => ({ [event]: [{ matcher: 'read_file', hooks: [{ type: 'command', command: 'mine' }] }] });
  mkdirSync(dirname(codexFile));
  mkdirSync(dirname(geminiFile));
  writeFileSync(codexFile, JSON.stringify({ description: 'ours', hooks: mine('PreToolUse') }));
  writeFileSync(geminiFile, JSON.stringify({ theme: 'x', hooks: mine('BeforeTool') }));
  const cli = '"$HOME/.local/share/yokoten/bin/yokoten.mjs"';
  const line = 'yokoten: the runtime at ~/.local/share/yokoten is missing; run the install again';
  const atStart = (args: string) => `[ -f ${cli} ] 2>/dev/null || { echo '${line}'; exit 0; }; node ${cli} ${args}`;
  const onCall = (args: string) => onToolCall(`[ -f ${cli} ] 2>/dev/null || { echo '${line}' >&2; exit 1; }; `, cli, args);
  const hooksOf = (result: SetupResult) => result.changes.filter((change) => change.kind === 'hook' && (change.agent === 'Codex CLI' || change.agent === 'Gemini CLI')).map((change) => [change.state, change.agent, change.note, change.path]);
  const both = (state: string) => [[state, 'Codex CLI', 'SessionStart doctor', '~/.codex/hooks.json'], [state, 'Codex CLI', 'command guard', '~/.codex/hooks.json'], [state, 'Gemini CLI', 'SessionStart doctor', '~/.gemini/settings.json'], [state, 'Gemini CLI', 'command guard', '~/.gemini/settings.json']];
  assert.deepEqual(hooksOf(installIn(sandbox)), both('added'));
  assert.deepEqual(hooksOf(installIn(sandbox)), both('kept'));
  const codex = JSON.parse(readFileSync(codexFile, 'utf8'));
  assert.equal(codex.description, 'ours');
  assert.deepEqual(codex.hooks.SessionStart, [{ hooks: [{ type: 'command', command: atStart('doctor --session --agent codex') }] }]);
  assert.deepEqual(codex.hooks.PreToolUse, [...mine('PreToolUse').PreToolUse, { hooks: [{ type: 'command', command: onCall('hook --agent codex --commands-only') }], matcher: 'Bash|apply_patch' }]);
  const gemini = JSON.parse(readFileSync(geminiFile, 'utf8'));
  assert.equal(gemini.theme, 'x');
  assert.deepEqual(gemini.hooks.SessionStart, [{ hooks: [{ type: 'command', command: atStart('doctor --session --agent gemini').replace(`echo '${line}'`, `echo '{"hookSpecificOutput":{"additionalContext":"${line}"}}'`), name: 'yokoten-session' }] }]);
  assert.deepEqual(gemini.hooks.BeforeTool, [...mine('BeforeTool').BeforeTool, { hooks: [{ type: 'command', command: onCall('hook --agent gemini --commands-only'), name: 'yokoten-guard' }], matcher: 'run_shell_command|write_file|replace' }]);
  // The command guard stops a tag push in any repo, adopted or not.
  const shell = (text: string, input: object) => spawnSync(text, { shell: '/bin/sh', cwd: sandbox.repo, env: sandbox.env, input: JSON.stringify(input), encoding: 'utf8' });
  const push = { session_id: 's1', cwd: sandbox.repo, hook_event_name: 'PreToolUse', tool_input: { command: 'git push --tags' } };
  assert.equal(shell(codex.hooks.PreToolUse[1].hooks[0].command, { ...push, tool_name: 'Bash' }).status, 2, 'Codex');
  assert.equal(shell(gemini.hooks.BeforeTool[1].hooks[0].command, { ...push, hook_event_name: 'BeforeTool', tool_name: 'run_shell_command' }).status, 2, 'Gemini CLI');
});

// #342: agy and Copilot CLI also read user-level hooks, outside any project. The positive
// control is doctor's note before install, and the guard refusing a tag push through the
// command install wrote.
test('install: the user-level command guard for Antigravity CLI and Copilot CLI, safe twice (#342)', async () => {
  const sandbox = makeSandbox();
  const agyFile = join(sandbox.home, '.gemini', 'config', 'hooks.json');
  const copilotFile = join(sandbox.home, '.copilot', 'hooks', 'yokoten.json');
  mkdirSync(dirname(agyFile), { recursive: true });
  mkdirSync(dirname(copilotFile), { recursive: true });
  writeFileSync(agyFile, JSON.stringify({ lint: { PreToolUse: [{ matcher: 'run_command', hooks: [{ command: './lint.sh' }] }] } }));
  writeFileSync(copilotFile, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'mine' }] }] } }));
  const before = await sandbox.call(['doctor', '--all']);
  assert.match(before.stdout, /note {4}antigravity-user-hook: no command guard in ~\/\.gemini\/config\/hooks\.json; `yokoten install` adds it/);
  assert.match(before.stdout, /note {4}copilot-user-hook: no command guard in ~\/\.copilot\/hooks\/yokoten\.json; `yokoten install` adds it/);
  assertRows(installIn(sandbox), sandbox.home, 'added hook ~/.gemini/config/hooks.json Antigravity CLI', 'added hook ~/.copilot/hooks/yokoten.json Copilot CLI');
  assertRows(installIn(sandbox), sandbox.home, 'kept hook ~/.gemini/config/hooks.json Antigravity CLI', 'kept hook ~/.copilot/hooks/yokoten.json Copilot CLI');
  for (const id of ['antigravity-user-hook', 'copilot-user-hook']) assert.match((await sandbox.call(['doctor', '--all'])).stdout, new RegExp(`^  ok {6}${id}$`, 'm'));
  const saved = JSON.parse(readFileSync(agyFile, 'utf8'));
  assert.ok(saved.lint, "another entry stays");
  assert.equal(saved.yokoten.PreToolUse[0].matcher, 'run_command|write_to_file|replace_file_content|multi_replace_file_content');
  const copilot = JSON.parse(readFileSync(copilotFile, 'utf8'));
  assert.equal(copilot.hooks.PreToolUse[0].hooks[0].command, 'mine', "the user's hook stays");
  assert.equal(copilot.hooks.PreToolUse[1].matcher, 'Bash|Edit|Write|MultiEdit|NotebookEdit');
  // A real run through the shell install wrote: a tag push is refused in each shape.
  const shell = (text: string, input: object) => spawnSync(text, { shell: '/bin/sh', cwd: sandbox.repo, env: sandbox.env, input: JSON.stringify(input), encoding: 'utf8' });
  const agyPush = { toolCall: { name: 'run_command', args: { CommandLine: 'git push --tags', Cwd: sandbox.repo } }, workspacePaths: [sandbox.repo] };
  const agy = shell(saved.yokoten.PreToolUse[0].hooks[0].command, agyPush);
  assert.equal(agy.status, 0, 'agy reads the decision, not the exit code');
  assert.match(JSON.parse(agy.stdout).reason, /git push --tags pushes tags/);
  const copilotPush = { session_id: 's1', cwd: sandbox.repo, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push --tags' } };
  const cp = shell(copilot.hooks.PreToolUse[1].hooks[0].command, copilotPush);
  assert.equal(cp.status, 2);
  assert.match(cp.stderr, /git push --tags pushes tags/);
  // uninstall takes the guard out and leaves the user's own entries.
  const removed = uninstallIn(sandbox);
  assert.ok(removed.ok, findingsOf(removed, sandbox.home));
  assertRows(removed, sandbox.home, 'removed hook ~/.gemini/config/hooks.json Antigravity CLI', 'removed hook ~/.copilot/hooks/yokoten.json Copilot CLI');
  assert.deepEqual(JSON.parse(readFileSync(agyFile, 'utf8')), { lint: { PreToolUse: [{ matcher: 'run_command', hooks: [{ command: './lint.sh' }] }] } });
  assert.deepEqual(JSON.parse(readFileSync(copilotFile, 'utf8')), { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'mine' }] }] } });
});

// #904: uninstall takes back every tool's user hook, and the files and folders install
// made for them. A hook of the user's stays, and so does a file install never touched.
test('uninstall: takes back the user hooks of Codex, Gemini CLI, Grok CLI, Muse Code and OpenCode (#904)', async () => {
  const sandbox = makeSandbox();
  const codexFile = join(sandbox.home, '.codex', 'hooks.json');
  const geminiFile = join(sandbox.home, '.gemini', 'settings.json');
  const grokFile = join(sandbox.home, '.grok', 'hooks', 'yokoten.json');
  const museFile = join(sandbox.home, '.config', 'muse', 'settings.json');
  const openCodeFile = join(sandbox.home, '.config', 'opencode', 'plugins', 'yokoten.ts');
  for (const file of [codexFile, geminiFile, grokFile, museFile, openCodeFile]) mkdirSync(dirname(file), { recursive: true });
  // A hook of the user's in Codex's file, which stays.
  const mine = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'mine' }] }] } };
  writeFileSync(codexFile, JSON.stringify(mine));
  assert.equal((await sandbox.call(['install', '--list'])).status, 0);
  for (const file of [grokFile, museFile, openCodeFile]) assert.ok(existsSync(file), `install wrote ${file}`);
  const result = uninstallIn(sandbox);
  assert.ok(result.ok, findingsOf(result, sandbox.home));
  assertRows(result, sandbox.home, 'removed hook ~/.codex/hooks.json Codex CLI', 'removed hook ~/.gemini/settings.json Gemini CLI', 'removed hook ~/.grok/hooks/yokoten.json Grok CLI', 'removed hook ~/.config/muse/settings.json Muse Code', 'removed hook ~/.config/opencode/plugins/yokoten.ts OpenCode');
  assert.deepEqual(JSON.parse(readFileSync(codexFile, 'utf8')), mine, 'the user\'s own hook stays');
  for (const file of [geminiFile, grokFile, museFile, openCodeFile]) assert.ok(!existsSync(file), `${file} is gone`);
});

// #248: a hooks file that won't parse, or where a key yokoten edits has the wrong type, is
// named and skipped, byte for byte as it was; the other CLI still gets its hooks, and install
// fails. A parse error asks for valid JSON; a wrong shape names the key instead.
test('install: an unreadable Codex or Gemini CLI hooks file is skipped, the rest goes on, and install exits 1 (#248)', async () => {
  const agents = [
    { name: 'Codex', cli: 'Codex CLI', file: '.codex/hooks.json', id: 'codex-user-hook', guard: 'PreToolUse' },
    { name: 'Gemini CLI', cli: 'Gemini CLI', file: '.gemini/settings.json', id: 'gemini-user-hook', guard: 'BeforeTool' },
  ];
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const [bad, good] of [agents, [...agents].reverse()]) {
    const shown = `~/${bad.file}`;
    const cases: [content: string, skip: string, doctor: string][] = [
      ['{ not json', `${shown} is not valid JSON`, `can't read ${shown}; make it valid JSON`],
      ...(
        [
          ['{"hooks": "x"}\n', '`hooks` should be an object'],
          ['{"hooks": []}', '`hooks` should be an object'],
          ['[]', 'the file should be a JSON object'],
          ['{"hooks": {"SessionStart": "x"}}', '`hooks.SessionStart` should be a list of objects'],
          // Deep shapes, once a crash: a number for a group's hooks, a null handler. The bad
          // guard event leaves the file whole, though the doctor hook comes first.
          [`{"hooks":{"${bad.guard}":[{"hooks":5}]}}`, `\`hooks.${bad.guard}[0].hooks\` should be a list of objects`],
          ['{"hooks":{"SessionStart":[{"hooks":[null]}]}}', '`hooks.SessionStart[0].hooks` should be a list of objects'],
        ] as const
      ).map(([content, hint]): [string, string, string] => [content, `${shown} has an unexpected shape (${hint.replaceAll('`', '')})`, `${shown} has an unexpected shape; ${hint}; fix it`]),
    ];
    for (const [content, skip, doctor] of cases) {
      const sandbox = makeSandbox();
      const badPath = join(sandbox.home, bad.file);
      const goodPath = join(sandbox.home, good.file);
      mkdirSync(dirname(badPath));
      mkdirSync(dirname(goodPath));
      writeFileSync(badPath, content);
      const result = installIn(sandbox);
      const what = `${bad.name}, ${JSON.stringify(content)}`;
      assert.equal(result.ok, false, what);
      assert.deepEqual(result.problems.map((problem) => [problem.id, problem.what]), [[bad.id, skip]], what);
      assertRows(result, sandbox.home, `skipped hook ${shown} ${bad.cli}`);
      assert.ok(!result.changes.some((change) => change.agent === bad.cli && change.state !== 'skipped'), `${what}: no hook of ${bad.cli} is named as written`);
      assert.equal(readFileSync(badPath, 'utf8'), content, `${what}: the file changed`);
      // Every other step still ran: the other CLI, Claude Code's hooks, and the marks file.
      assertRows(result, sandbox.home, `added hook ~/${good.file} ${good.cli}`, 'added hook ~/.claude/settings.json Claude Code', 'wrote file ~/.config/yokoten/private-marks');
      assert.ok(hasHook(goodPath, 'SessionStart', 'doctor'), `${what}: no ${good.name} hooks`);
      // Doctor names the same problem. A doctor call walks the sandbox like a whole install,
      // so it runs once per file pair, for the parse error where the wording differs most;
      // an unexpected shape names the same place and hint on install's own print (#943).
      if (content === '{ not json') {
        // The entry exits 1, and its screen shows no home path.
        const run = await sandbox.call(['install']);
        assert.equal(run.status, 1, what);
        assert.ok(!run.output.includes(sandbox.home), `${what}: the home path is shown`);
        assert.match((await sandbox.call(['doctor', '--all'])).stdout, new RegExp(`^  note {4}${bad.id}: ${escape(doctor)}`, 'm'), what);
      }
    }
  }
});

test('install: a commented ~/.gemini/settings.json is left as it was and gets the hooks to add by hand; with them, it is ok (#258)', async () => {
  const sandbox = makeSandbox();
  const file = join(sandbox.home, '.gemini', 'settings.json');
  mkdirSync(dirname(file));
  const before = commentedGemini('{}');
  writeFileSync(file, before);
  const result = installIn(sandbox);
  assert.equal(result.ok, false);
  // The problem says why, and the Fix is doctor's screen, which shows the hooks to add by hand.
  assert.deepEqual(result.problems.map((problem) => [problem.what, problem.fix]), [[COMMENTED('~/.gemini/settings.json').replace(/; add this.*$/, ''), 'run `yokoten doctor --all`, then add the hooks it shows by hand']]);
  assert.equal(readFileSync(file, 'utf8'), before, 'the file changed');
  const add = doctorHandAdd((await sandbox.call(['doctor', '--all'])).stdout, 'gemini-user-hook', '~/.gemini/settings.json');
  assert.deepEqual(Object.keys(add), ['SessionStart', 'BeforeTool']);
  assert.deepEqual(
    Object.values(add).map((groups) => (groups as { hooks: { name: string }[] }[]).map((g) => g.hooks[0].name)),
    [['yokoten-session'], ['yokoten-guard']],
  );
  // The rest still ran.
  assertRows(result, sandbox.home, 'added hook ~/.claude/settings.json Claude Code');

  // Added by hand, comments and all: install finds them the same and leaves the file.
  const after = commentedGemini(JSON.stringify(add, null, 2));
  writeFileSync(file, after);
  const again = installIn(sandbox);
  assert.ok(again.ok, findingsOf(again, sandbox.home));
  assert.deepEqual(again.changes.filter((change) => change.agent === 'Gemini CLI').map((change) => [change.state, change.note]), [['kept', 'SessionStart doctor'], ['kept', 'command guard']]);
  assert.equal(readFileSync(file, 'utf8'), after, 'the file changed');
  assert.match((await sandbox.call(['doctor', '--all'])).stdout, /^ {2}ok {6}gemini-user-hook$/m);
});

test('install: Gemini CLI allows comments but not trailing commas, and Codex allows neither (#258)', async () => {
  for (const [dir, file, cli, content] of [
    ['.gemini', 'settings.json', 'Gemini CLI', '{ // c\n  "theme": "dark",\n}\n'],
    ['.codex', 'hooks.json', 'Codex CLI', '{ // c\n  "hooks": {}\n}\n'],
  ]) {
    const sandbox = makeSandbox();
    mkdirSync(join(sandbox.home, dir));
    writeFileSync(join(sandbox.home, dir, file), content);
    const result = installIn(sandbox);
    assert.equal(result.ok, false, cli);
    assert.deepEqual(result.problems.map((problem) => problem.what), [`~/${dir}/${file} is not valid JSON`], cli);
    assert.equal(readFileSync(join(sandbox.home, dir, file), 'utf8'), content, cli);
  }
});

test('install: an unreadable ~/.claude/settings.json is skipped, the rest goes on, and install exits 1 (#254)', async () => {
  for (const [content, reason] of BAD_USER_SETTINGS) {
    const sandbox = makeSandbox();
    const file = join(sandbox.home, '.claude', 'settings.json');
    for (const dir of ['.claude', '.codex', '.gemini']) mkdirSync(join(sandbox.home, dir));
    writeFileSync(file, content);
    const result = installIn(sandbox);
    const what = JSON.stringify(content);
    assert.equal(result.ok, false, what);
    assert.deepEqual(result.problems.map((problem) => problem.what), [reason('~/.claude/settings.json')], what);
    assert.deepEqual(rowsOf(result, sandbox.home).filter((row) => row.endsWith('Claude Code')), ['skipped hook ~/.claude/settings.json Claude Code'], what);
    assert.equal(readFileSync(file, 'utf8'), content, `${what}: the file changed`);
    // Every other step still ran: the Codex and Gemini CLI hooks, and the marks file.
    assertRows(result, sandbox.home, 'added hook ~/.codex/hooks.json Codex CLI', 'added hook ~/.gemini/settings.json Gemini CLI', 'wrote file ~/.config/yokoten/private-marks');
    // Doctor names the same problem, never that the hook is missing, and doesn't crash.
    const doctor = await sandbox.call(['doctor', '--all']);
    const said = content.startsWith('{ not') ? "can't read ~/.claude/settings.json" : '~/.claude/settings.json has an unexpected shape';
    assert.ok(doctor.stdout.split('\n').some((line) => line.startsWith(`  MISSING session-doctor: ${said}`)), `${what}: ${doctor.stdout}${doctor.stderr}`);
    assert.doesNotMatch(doctor.stderr, /SyntaxError|TypeError|at /, what);
    assert.equal(readFileSync(file, 'utf8'), content, `${what}: doctor changed the file`);
  }
});

// #254: only the keys install edits are checked. Another event, or an `env` install never
// touches, is the user's: install adds its hooks and keeps the key as it was.
test('install: keys in ~/.claude/settings.json that install does not edit are kept and the hooks added (#254)', async () => {
  for (const [content, key, value] of [
    ['{"hooks":{"Notification":"x"}}', 'Notification', 'x'],
    ['{"env":"x"}', 'env', 'x'],
  ] as const) {
    const sandbox = makeSandbox();
    const file = join(sandbox.home, '.claude', 'settings.json');
    mkdirSync(dirname(file));
    writeFileSync(file, content);
    const result = await sandbox.call(['install', '--list']);
    assert.equal(result.status, 0, `${content}: ${result.stdout}${result.stderr}`);
    const settings = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(key === 'env' ? settings.env : settings.hooks.Notification, value, content);
    assert.ok(hasHook(file, 'SessionStart', 'doctor'), `${content}: no doctor hook`);
    assert.ok(hasHook(file, 'PreToolUse', 'hook'), `${content}: no guard`);
    assert.match((await sandbox.call(['doctor', '--all'])).stdout, /^  ok {6}session-doctor$/m, content);
  }
});

// #248 review: yokoten checks only the keys it edits. Other keys under `hooks`, such as
// Gemini CLI's `hooks.disabled` list, are the user's: install adds its hooks and keeps them.
test('install: other keys under hooks, such as Gemini CLI hooks.disabled, are kept and the hooks added (#248)', async () => {
  for (const [dir, file, guard] of [['.gemini', 'settings.json', 'BeforeTool'], ['.codex', 'hooks.json', 'PreToolUse']]) {
    const sandbox = makeSandbox();
    const path = join(sandbox.home, dir, file);
    mkdirSync(dirname(path));
    writeFileSync(path, '{"hooks":{"disabled":["x"],"Other":5}}');
    const result = await sandbox.call(['install', '--list']);
    assert.equal(result.status, 0, `${dir}: ${result.stdout}${result.stderr}`);
    const settings = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(settings.hooks.disabled, ['x'], dir);
    assert.equal(settings.hooks.Other, 5, dir);
    assert.ok(hasHook(path, 'SessionStart', 'doctor'), `${dir}: no doctor hook`);
    assert.ok(hasHook(path, guard, 'hook'), `${dir}: no guard`);
    assert.match((await sandbox.call(['doctor', '--all'])).stdout, new RegExp(`^  ok {6}${dir.slice(1)}-user-hook$`, 'm'), dir);
  }
});

test('install: a copy that fails half way leaves the old copy working (#204)', () => {
  const sandbox = makeSandbox();
  const dest = join(sandbox.home, '.local', 'share', 'yokoten');
  assert.equal(copyRuntime(dest, { withKit: true }), 'wrote');
  writeFileSync(join(dest, 'VERSION'), 'old\n');
  let calls = 0;
  const failing = ((source: string, target: string, options: object) => {
    if (++calls === 2) throw new Error('disk full');
    cpSync(source, target, options);
  }) as typeof cpSync;
  assert.throws(() => copyRuntime(dest, { withKit: true, copy: failing }), /disk full/);
  assert.equal(readFileSync(join(dest, 'VERSION'), 'utf8'), 'old\n', 'the old copy is in place');
  assert.deepEqual(readdirSync(dirname(dest)), ['yokoten'], 'no half copy is left next to it');
  const doctor = spawnSync('node', [join(dest, 'bin', 'yokoten.ts'), 'doctor', '--session'], { cwd: sandbox.repo, env: sandbox.env, encoding: 'utf8' });
  assert.equal(doctor.status, 0, doctor.stderr);
  // A good copy then takes its place.
  assert.equal(copyRuntime(dest, { withKit: true }), 'wrote');
  assert.notEqual(readFileSync(join(dest, 'VERSION'), 'utf8'), 'old\n');
  assert.deepEqual(readdirSync(dirname(dest)), ['yokoten']);
});

// #77: a project's .yokoten/ copy is what a teammate without yokoten installed runs. With
// no lessons in it, its doctor ran none and said nothing. Positive control: a test with the
// incident-138 mistake must get the lesson's note from the copy's own doctor.
test('install: a project copy carries the kit lessons, and doctor from it runs them (#77)', async () => {
  const sandbox = makeSandbox();
  const dest = join(sandbox.repo, '.yokoten');
  assert.equal(copyRuntime(dest), 'wrote');
  assert.ok(existsSync(join(dest, 'kit', 'lessons', 'README.md')), 'the lessons table');
  assert.ok(!existsSync(join(dest, 'kit', 'user')), 'only the project parts of the kit');
  sandbox.write('test/api.test.js', "await fetch('http://127.0.0.1:8080/health');\n");
  const doctor = spawnSync('node', [join(dest, 'bin', 'yokoten.ts'), 'doctor', '--all'], { cwd: sandbox.repo, env: sandbox.env, encoding: 'utf8' });
  assert.match(doctor.stdout, /\n {2}note {4}lesson incident-138: test\/api\.test\.js: a test calls a server on this machine and does not set NO_PROXY; /);
});

// A temp folder left beside the copy, in a repo root, is one `git add -A` away from a commit (#204).
test('install: a rename that fails leaves the old copy and no temp folder (#204)', () => {
  const sandbox = makeSandbox();
  const dest = join(sandbox.home, '.local', 'share', 'yokoten');
  assert.equal(copyRuntime(dest, { withKit: true }), 'wrote');
  writeFileSync(join(dest, 'VERSION'), 'old\n');
  const failing = (() => {
    throw new Error('busy');
  }) as typeof renameSync;
  assert.throws(() => copyRuntime(dest, { withKit: true, rename: failing }), /busy/);
  assert.equal(readFileSync(join(dest, 'VERSION'), 'utf8'), 'old\n', 'the old copy is in place');
  assert.deepEqual(readdirSync(dirname(dest)), ['yokoten'], 'no temp folder is left next to it');
});

test('install: temp folders that an earlier crash left are removed, and only those (#204)', () => {
  const sandbox = makeSandbox();
  const parent = join(sandbox.home, '.local', 'share');
  const kept = ['.yokoten-newer', '.other-new-abc123', 'notes'];
  for (const name of ['.yokoten-new-abc123', '.yokoten-old-def456', ...kept]) mkdirSync(join(parent, name), { recursive: true });
  assert.equal(copyRuntime(join(parent, 'yokoten'), { withKit: true }), 'wrote');
  assert.deepEqual(readdirSync(parent).sort(), [...kept, 'yokoten'].sort());
});

// #1109: Node's loader names the running copy by its long name, and a Windows runner's temp
// folder is `C:\Users\RUNNER~1\...`. Read as written, a copy into the running src/ looked
// outside it, and init copied src/ into itself until the path was too long (30 minutes).
test('copy runtime: one folder by two spellings is the same folder, so a copy into its own src/ is seen (#1109)', () => {
  const long = join(sep, 'users', 'runneradmin', 'clone');
  const short = join(sep, 'users', 'RUNNER~1', 'clone');
  const read = (path: string) => path.replace(short, long);
  assert.equal(isSameOrInside(join(short, 'src', 'project'), join(long, 'src'), read), true);
  assert.equal(isSameOrInside(join(short, 'project'), join(long, 'src'), read), false, 'next to src/ is not inside it');
  assert.equal(isSameOrInside(join(short, 'src', 'project'), join(long, 'src'), (path) => path), false, 'the bug: read as written, the two spellings never meet');
  // The reader yokoten uses reads the disk: a folder reached through a link is the same folder.
  const sandbox = makeSandbox();
  const real = join(sandbox.home, 'real');
  mkdirSync(join(real, 'src'), { recursive: true });
  symlinkSync(real, join(sandbox.home, 'link'), 'junction');
  assert.equal(isSameOrInside(join(sandbox.home, 'link', 'src', 'project'), join(real, 'src')), true);
});

// #1109: where Defender scans the temp folder, init's last rename failed with EPERM about
// once in 70 runs, because the scanner still held a file it had just written.
test('rename: on Windows a busy file is tried again after each wait; anything else fails at once (#1109)', () => {
  const busy = (code: string) => Object.assign(new Error(code), { code });
  const tries = (failures: string[], platform: NodeJS.Platform) => {
    const waits: number[] = [];
    let calls = 0;
    const rename = () => {
      const code = failures[calls++];
      if (code) throw busy(code);
    };
    let error: unknown;
    try {
      renameRetrying('a', 'b', platform, { rename, wait: (ms) => waits.push(ms) });
    } catch (caught) {
      error = caught;
    }
    return { calls, waits, code: (error as NodeJS.ErrnoException | undefined)?.code };
  };
  assert.deepEqual(tries(['EPERM', 'EBUSY', 'EACCES'], 'win32'), { calls: 4, waits: [10, 20, 50], code: undefined });
  assert.deepEqual(tries(['ENOENT'], 'win32'), { calls: 1, waits: [], code: 'ENOENT' }, 'a missing file is not busy');
  assert.deepEqual(tries(['EPERM'], 'linux'), { calls: 1, waits: [], code: 'EPERM' }, 'other systems rename at once');
  const always = tries(Array(20).fill('EPERM'), 'win32');
  assert.deepEqual([always.calls, always.waits, always.code], [RENAME_WAITS_MS.length + 1, RENAME_WAITS_MS, 'EPERM'], 'after the last wait the error stands');
});

// #208, #433: a clone install puts a launcher in ~/.local/bin, and with no terminal it edits no shell file.
test('install: writes the launcher, and with no terminal prints the PATH line and edits no profile (#433)', async () => {
  const sandbox = makeSandbox();
  // macOS opens a login bash, which reads ~/.bash_profile (#983).
  const bashProfile = process.platform === 'darwin' ? '.bash_profile' : '.bashrc';
  let result = installIn({ ...sandbox, env: { ...sandbox.env, SHELL: '/bin/bash' } });
  assert.ok(result.ok, findingsOf(result, sandbox.home));
  assertRows(result, sandbox.home, 'wrote launcher ~/.local/bin/yokoten');
  assert.match(findingsOf(result, sandbox.home), new RegExp(`^machine-runtime: ~/\\.local/bin is not on your PATH; .*; add this line to ~/\\${bashProfile}, then open a new shell: `, 'm'));
  assert.ok(!findingsOf(result, sandbox.home).includes('alias yokoten'));
  // The screen says it once, for this system, and edits nothing.
  const screen = await sandbox.call(['install'], { extra: { SHELL: '/bin/bash' } });
  assert.match(screen.stdout, /^ {2}note {8}command {5}~\/\.local\/bin is not on your PATH yet$/m);
  for (const file of ['.bashrc', '.bash_profile', '.zshrc', '.profile']) assert.ok(!existsSync(join(sandbox.home, file)), `${file} was written`);
  // The launcher runs the installed copy, with every argument as it was given.
  const launcher = join(sandbox.home, '.local/bin/yokoten');
  assert.equal(statSync(launcher).mode & 0o111, 0o111, 'the launcher can be run');
  const help = spawnSync(launcher, ['install', '--help'], { cwd: sandbox.repo, env: sandbox.env, encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /install/);
  // ~/.local/bin on the PATH: no PATH line, and nothing more to do.
  result = installIn({ ...sandbox, env: { ...sandbox.env, SHELL: '/bin/bash', PATH: `${join(sandbox.home, '.local/bin')}:${process.env.PATH}` } });
  assertRows(result, sandbox.home, 'kept launcher ~/.local/bin/yokoten');
  assert.ok(!findingsOf(result, sandbox.home).includes('PATH'), findingsOf(result, sandbox.home));
  // A yokoten on the PATH that runs the installed copy another way: no alias line either.
  const bin = join(sandbox.home, 'bin');
  mkdirSync(bin);
  symlinkSync(join(sandbox.home, '.local/share/yokoten/bin/yokoten.ts'), join(bin, 'yokoten'));
  result = installIn({ ...sandbox, env: { ...sandbox.env, PATH: `${bin}:${process.env.PATH}` } });
  assert.ok(result.ok);
  assert.ok(!findingsOf(result, sandbox.home).includes('alias yokoten'), findingsOf(result, sandbox.home));
});

/** A home with a fake runtime whose bin/yokoten.mjs prints its arguments, and a PATH without ~/.local/bin. */
function launcherHome() {
  const home = makeTempDir('yokoten-launcher-');
  const runtime = join(home, '.local', 'share', 'yokoten');
  mkdirSync(join(runtime, 'bin'), { recursive: true });
  writeFileSync(join(runtime, 'bin', 'yokoten.mjs'), 'console.log(JSON.stringify(process.argv.slice(2)));\n');
  const env = { HOME: home, PATH: dirname(process.execPath), SHELL: '/usr/bin/zsh' };
  const asked: string[] = [];
  const answer = (reply: string | null) => (question: string) => {
    asked.push(question);
    return reply;
  };
  return { home, runtime, env, asked, answer, profile: join(home, '.zshrc'), launcher: join(home, '.local', 'bin', 'yokoten') };
}

test('launcher: runs the installed runtime with each argument kept whole (#433)', () => {
  const { home, runtime, env, launcher } = launcherHome();
  setUpLauncher(env, runtime, home);
  assert.equal(readFileSync(launcher, 'utf8'), sealManaged(launcherText(runtime, 'linux')));
  assert.match(readFileSync(launcher, 'utf8'), /^#!\/bin\/sh\n# managed by yokoten/);
  const run = spawnSync(launcher, ['doctor', 'two words', '$HOME'], { env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), ['doctor', 'two words', '$HOME']);
  // A runtime path with a quote and a dollar sign still works.
  assert.match(launcherText("/home/o'neil/$x/yokoten", 'linux'), /exec node '\/home\/o'\\''neil\/\$x\/yokoten\/bin\/yokoten\.mjs' "\$@"\n$/);
});

test('launcher: runs the .mjs entry the hooks run, and a launcher from an older install is rewritten (#433, #440)', () => {
  const { home, runtime, env, launcher } = launcherHome();
  // The hooks run USER_CLI; the launcher runs the same file in the runtime.
  assert.equal(USER_CLI, `"$HOME/${relative(home, join(runtime, 'bin', 'yokoten.mjs')).split(sep).join('/')}"`);
  assert.ok(launcherText(runtime, 'linux').includes(join(runtime, 'bin', 'yokoten.mjs')));
  // An older install wrote a launcher that ran yokoten.ts.
  const old = launcherText(runtime, 'linux').replace('yokoten.mjs', 'yokoten.ts');
  mkdirSync(dirname(launcher), { recursive: true });
  writeFileSync(launcher, old);
  // It still counts as ours on the PATH, so doctor does not ask for it again.
  assert.ok(isOnPath({ PATH: dirname(launcher) }, runtime, 'linux'));
  const steps = setUpLauncher(env, runtime, home, { platform: 'linux' });
  assert.deepEqual(steps.changes[0], { state: 'updated', kind: 'launcher', path: launcher });
  assert.equal(readFileSync(launcher, 'utf8'), sealManaged(launcherText(runtime, 'linux')));
});

/** The note a launcher step gives when ~/.local/bin is not on the PATH, by its fix. */
const pathNote = (steps: Steps): string | undefined => steps.notes.find((note) => / is not on your PATH$/.test(note.what))?.fix;

test('launcher: asks once before it adds the PATH line, and only with a terminal (#433)', () => {
  // Yes: one marked line at the end of the profile, the user's lines kept.
  let home = launcherHome();
  writeFileSync(home.profile, 'export EDITOR=vi');
  let steps = setUpLauncher(home.env, home.runtime, home.home, { ask: home.answer(''), platform: 'linux' });
  assert.deepEqual(home.asked, ['Add ~/.local/bin to your PATH in ~/.zshrc? [Y/n]']);
  assert.equal(readFileSync(home.profile, 'utf8'), `export EDITOR=vi\n${PROFILE_LINE}\n`);
  assert.deepEqual(steps.changes.at(-1), { state: 'added', kind: 'profile', path: home.profile, note: 'open a new shell, then run `yokoten`' });
  // A second run finds the line: it neither asks nor adds.
  steps = setUpLauncher(home.env, home.runtime, home.home, { ask: home.answer('y'), platform: 'linux' });
  assert.equal(home.asked.length, 1);
  assert.equal(readFileSync(home.profile, 'utf8'), `export EDITOR=vi\n${PROFILE_LINE}\n`);
  assert.deepEqual([steps.changes.at(-1)?.state, steps.changes.at(-1)?.kind], ['kept', 'profile']);

  // No: the profile stays as it was, and a note gives the line.
  home = launcherHome();
  steps = setUpLauncher(home.env, home.runtime, home.home, { ask: home.answer('n'), platform: 'linux' });
  assert.equal(home.asked.length, 1);
  assert.ok(!existsSync(home.profile));
  assert.equal(pathNote(steps), `add this line to ${home.profile}, then open a new shell: ${PROFILE_LINE}`);
  // End of input counts as no.
  setUpLauncher(home.env, home.runtime, home.home, { ask: home.answer(null), platform: 'linux' });
  assert.ok(!existsSync(home.profile));

  // No terminal: nothing is asked and nothing is edited.
  home = launcherHome();
  steps = setUpLauncher(home.env, home.runtime, home.home, { platform: 'linux' });
  assert.ok(!existsSync(home.profile));
  assert.match(pathNote(steps) ?? '', /^add this line to .*\.zshrc/);
  // A shell yokoten does not know: no profile is guessed.
  home = launcherHome();
  steps = setUpLauncher({ ...home.env, SHELL: '/usr/bin/fish' }, home.runtime, home.home, { ask: home.answer('y'), platform: 'linux' });
  assert.deepEqual(home.asked, []);
  assert.match(pathNote(steps) ?? '', /^add this line to your shell profile, then open a new shell/);
  // ~/.local/bin already on the PATH: nothing to ask, nothing to note.
  home = launcherHome();
  steps = setUpLauncher({ ...home.env, PATH: `${join(home.home, '.local', 'bin')}${delimiter}${home.env.PATH}` }, home.runtime, home.home, { ask: home.answer('y'), platform: 'linux' });
  assert.deepEqual([home.asked, steps], [[], { changes: [{ state: 'wrote', kind: 'launcher', path: home.launcher }], problems: [], notes: [] }]);
  assert.ok(!existsSync(home.profile));
});

test("launcher: a yokoten in ~/.local/bin that isn't ours is kept and named (#433)", () => {
  const { home, runtime, env, asked, answer, launcher, profile } = launcherHome();
  mkdirSync(dirname(launcher), { recursive: true });
  writeFileSync(launcher, '#!/bin/sh\necho mine\n');
  const steps = setUpLauncher(env, runtime, home, { ask: answer('y'), platform: 'linux' });
  assert.equal(readFileSync(launcher, 'utf8'), '#!/bin/sh\necho mine\n');
  assert.deepEqual(steps.changes[0], { state: 'kept', kind: 'launcher', path: launcher, yours: true, note: "it is not yokoten's launcher, so install left it as it is" });
  assert.match(steps.notes[0]?.fix ?? '', /alias yokoten=/);
  assert.deepEqual(asked, []);
  assert.ok(!existsSync(profile));
});

test('launcher: Windows gets yokoten.cmd and yokoten.ps1, and steps for the PATH, never an edit (#433, #1038)', () => {
  const { home, runtime, env, asked, answer } = launcherHome();
  assert.equal(launcherText('C:\\Users\\o\\.local\\share\\yokoten', 'win32').split('\r\n').slice(0, 2).join('\n'), '@echo off\nrem managed by yokoten: `yokoten uninstall` removes this file.');
  assert.match(launcherText('C:\\Users\\o\\.local\\share\\yokoten', 'win32'), /\r\nnode "C:\\Users\\o\\.local\\share\\yokoten[\\/]bin[\\/]yokoten\.mjs" %\*\r\n$/);
  // PowerShell finds a .ps1 of its own: it runs the same entry, its path in single quotes (#1038).
  const ps1 = launcherText("C:\\Users\\o'n\\.local\\share\\yokoten", 'win32', 'yokoten.ps1');
  assert.match(ps1, /^# managed by yokoten: `yokoten uninstall` removes this file\.\r\n/);
  assert.match(ps1, /\r\n& node 'C:\\Users\\o''n\\\.local\\share\\yokoten[\\/]bin[\\/]yokoten\.mjs' @args\r\nexit \$LASTEXITCODE\r\n$/);
  const steps = setUpLauncher(env, runtime, home, { ask: answer('y'), platform: 'win32' });
  const bin = join(home, '.local', 'bin');
  assert.equal(readFileSync(join(bin, 'yokoten.cmd'), 'utf8'), sealManaged(launcherText(runtime, 'win32')));
  assert.equal(readFileSync(join(bin, 'yokoten.ps1'), 'utf8'), sealManaged(launcherText(runtime, 'win32', 'yokoten.ps1')));
  assert.deepEqual(steps.changes.map((change) => [change.state, change.kind, change.path]), [['wrote', 'launcher', join(bin, 'yokoten.cmd')], ['wrote', 'launcher', join(bin, 'yokoten.ps1')]]);
  assert.ok(!existsSync(join(bin, 'yokoten')));
  assert.deepEqual(asked, []);
  assert.match(pathNote(steps) ?? '', /Edit environment variables for your account/);
  for (const name of ['.bashrc', '.zshrc']) assert.ok(!existsSync(join(home, name)));
  // A PowerShell launcher on the PATH counts as ours too.
  assert.ok(isOnPath({ PATH: bin }, runtime, 'win32'));
});

test('uninstall: removes the launcher and the marked PATH line, and keeps the rest of the profile (#433)', async () => {
  const sandbox = makeSandbox();
  assert.equal((await sandbox.call(['install', '--list'])).status, 0);
  const launcher = join(sandbox.home, '.local/bin/yokoten');
  assert.ok(existsSync(launcher));
  writeFileSync(join(sandbox.home, '.bashrc'), `export EDITOR=vi\n${PROFILE_LINE}\nalias ll='ls -l'\n`);
  writeFileSync(join(sandbox.home, '.zshrc'), `${PROFILE_LINE}\n`);
  const result = uninstallIn(sandbox);
  assert.ok(result.ok, findingsOf(result, sandbox.home));
  assertRows(result, sandbox.home, 'removed launcher ~/.local/bin/yokoten', 'removed profile ~/.bashrc', 'removed profile ~/.zshrc');
  assert.ok(!existsSync(launcher));
  assert.equal(readFileSync(join(sandbox.home, '.bashrc'), 'utf8'), "export EDITOR=vi\nalias ll='ls -l'\n");
  assert.equal(readFileSync(join(sandbox.home, '.zshrc'), 'utf8'), '');
  // A launcher of the user's own is kept.
  mkdirSync(dirname(launcher), { recursive: true });
  writeFileSync(launcher, '#!/bin/sh\necho mine\n');
  const again = uninstallIn(sandbox);
  assertRows(again, sandbox.home, 'kept launcher ~/.local/bin/yokoten yours');
  assert.ok(!again.changes.some((change) => change.kind === 'profile'), 'no PATH line is left to take');
  assert.equal(readFileSync(launcher, 'utf8'), '#!/bin/sh\necho mine\n');
});

test('uninstall: a symlinked profile stays a link, and the file it names loses the line (#983)', async () => {
  const sandbox = makeSandbox();
  assert.equal((await sandbox.call(['install', '--list'])).status, 0);
  // A dotfile manager keeps the real file elsewhere and links it into the home folder.
  const real = join(sandbox.home, 'dotfiles', 'bashrc');
  mkdirSync(dirname(real), { recursive: true });
  writeFileSync(real, `export EDITOR=vi\n${PROFILE_LINE}\n`);
  const link = join(sandbox.home, '.bashrc');
  symlinkSync(real, link);
  assertRows(uninstallIn(sandbox), sandbox.home, 'removed profile ~/.bashrc');
  assert.ok(lstatSync(link).isSymbolicLink(), 'the profile is still a link');
  assert.equal(readlinkSync(link), real);
  assert.equal(readFileSync(real, 'utf8'), 'export EDITOR=vi\n');
  // Positive control: the file it names is a plain file, so the edit went through the link.
  assert.ok(!lstatSync(real).isSymbolicLink());
});

test('launcher: on macOS, bash reads ~/.bash_profile, so the PATH line goes there (#983)', () => {
  assert.equal(shellProfile({ SHELL: '/bin/bash' }, '/h', 'darwin'), join('/h', '.bash_profile'));
  assert.equal(shellProfile({ SHELL: '/bin/bash' }, '/h', 'linux'), join('/h', '.bashrc'));
  assert.equal(shellProfile({ SHELL: '/bin/zsh' }, '/h', 'darwin'), join('/h', '.zshrc'));
  assert.equal(shellProfile({ SHELL: '/usr/bin/fish' }, '/h', 'darwin'), null);
});

test("install: adds the machine's marks and a git mailmap, and never prints a value (#390)", async () => {
  const sandbox = makeSandbox();
  const email = `jane${at}personal-mail.dev`;
  sandbox.git('config', 'user.name', 'Jane Example');
  sandbox.git('config', 'user.email', email);
  sandbox.git('remote', 'add', 'origin', 'https://build.private-host.dev/jane/app.git');
  sandbox.write('README.md', 'Hello.\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'docs: hello');
  const marks = join(sandbox.home, '.config', 'yokoten', 'private-marks');
  const listed = await sandbox.call(['install', '--list']);
  assert.equal(listed.status, 0, listed.stderr);
  for (const value of ['Jane', 'personal-mail', 'private-host']) assert.ok(!(listed.stdout + listed.stderr).includes(value), 'install printed a value');
  let result = installIn(sandbox);
  for (const value of ['Jane', 'personal-mail', 'private-host']) assert.ok(!JSON.stringify(result).includes(value), 'the result holds a value');
  // The first run added the kinds; the result names the kinds, never a value.
  assert.match(listed.stdout, /^ {2}added {7}~\/\.config\/yokoten\/private-marks: git name, git email, private\n {14}remote host from this machine \(the values are not shown\)$/m);
  assert.deepEqual(result.notes.filter((note) => note.id === 'private-marks').map((note) => [note.what, note.fix, note.why]), [["optional: add your city or your domains too; yokoten can't find them on its own", 'run `yokoten marks add` and type one; it is not shown', 'for example: your city, a company domain, a server name']]);
  assert.match(readFileSync(marks, 'utf8'), /^# for example: your city, a company domain, a server name$/m);
  // No terminal: the mailmap file is written, but git's own config is not changed (#985).
  assert.deepEqual(result.changes.find((change) => change.kind === 'setting'), { state: 'skipped', kind: 'setting', path: 'mailmap.file', note: 'install changes your git config only when you say yes' });
  assert.ok(result.notes.some((note) => note.fix === 'run `git config --global mailmap.file ~/.config/yokoten/mailmap`'), findingsOf(result, sandbox.home));
  assert.equal(sandbox.git('config', '--global', '--get', 'mailmap.file').stdout, '');
  assert.match(readFileSync(join(sandbox.home, '.config', 'yokoten', 'mailmap'), 'utf8'), /^owner <owner@noreply\.invalid> <jane@personal-mail\.dev>$/m);
  assert.match(readFileSync(marks, 'utf8'), /# added by yokoten from this machine: git name\nJane Example\n# added by yokoten from this machine: git email\njane@personal-mail\.dev\n# added by yokoten from this machine: private remote host\nbuild\.private-host\.dev\n$/);
  assert.equal(statSync(marks).mode & 0o777, 0o600);
  // A yes at the terminal sets it, and git prints the placeholder at the source.
  const asked: string[] = [];
  const done = install(sandbox.env, { cwd: sandbox.repo, ask: (question) => (asked.push(question), 'y'), platform: 'linux' });
  assert.ok(asked.includes('Hide your email in git logs that agents read? [Y/n]'), asked.join('\n'));
  assert.deepEqual(done.changes.find((change) => change.kind === 'setting'), { state: 'added', kind: 'setting', path: 'mailmap.file', note: 'git log and git show print your emails as a placeholder' });
  assert.equal(sandbox.git('config', '--global', '--get', 'mailmap.file').stdout, '~/.config/yokoten/mailmap\n');
  assert.match(sandbox.git('log', '-1').stdout, /^Author: owner <owner@noreply\.invalid>$/m);
  // A second run appends nothing. It still asks: the city and the domains are not in the file yet.
  const before = readFileSync(marks, 'utf8');
  result = installIn(sandbox);
  assert.deepEqual(rowsOf(result, sandbox.home).filter((row) => row.includes('private-marks')), ['kept file ~/.config/yokoten/private-marks'], 'the file is named once');
  assert.ok(result.notes.some((note) => note.what.startsWith('optional: add your city or your domains too')), findingsOf(result, sandbox.home));
  assertRows(result, sandbox.home, 'kept file ~/.config/yokoten/mailmap', 'kept setting mailmap.file');
  assert.equal(readFileSync(marks, 'utf8'), before);
  // The user's own mailmap.file stays.
  sandbox.git('config', '--global', 'mailmap.file', '/elsewhere/mailmap');
  result = installIn(sandbox);
  assertRows(result, sandbox.home, 'kept setting mailmap.file yours');
  assert.match(findingsOf(result, sandbox.home), /^mailmap: your own git mailmap\.file setting stays; .*; add the lines of ~\/\.config\/yokoten\/mailmap to that file$/m);
  assert.equal(sandbox.git('config', '--global', '--get', 'mailmap.file').stdout, '/elsewhere/mailmap\n');
});

test("install names git's global mailmap.file as a setting it asks for, and a no leaves it unset (#985)", async () => {
  const sandbox = makeSandbox();
  sandbox.git('config', 'user.email', `jane${at}personal-mail.dev`);
  const result = installIn(sandbox);
  assert.ok(result.ok, findingsOf(result, sandbox.home));
  assertRows(result, sandbox.home, 'wrote file ~/.config/yokoten/mailmap', 'skipped setting mailmap.file');
  assert.match((await sandbox.call(['install', '--list'])).stdout, /^ {2}skipped {5}the git setting mailmap\.file: install changes your git config only\n {14}when you say yes$/m);
  // Positive control: the old install set it here, with nobody asked.
  assert.equal(sandbox.git('config', '--global', '--get', 'mailmap.file').stdout, '');
  // A no at the terminal: nothing set, and the line gives the command.
  const done = install(sandbox.env, { cwd: sandbox.repo, ask: (question) => (question.startsWith("Set git's global mailmap.file") ? 'n' : null), platform: 'linux' });
  assertRows(done, sandbox.home, 'skipped setting mailmap.file');
  assert.ok(done.notes.some((note) => note.fix === 'run `git config --global mailmap.file ~/.config/yokoten/mailmap`'), findingsOf(done, sandbox.home));
  assert.equal(sandbox.git('config', '--global', '--get', 'mailmap.file').stdout, '');
  // Once it is set, install asks nothing and keeps the setting.
  sandbox.git('config', '--global', 'mailmap.file', '~/.config/yokoten/mailmap');
  const again = install(sandbox.env, { cwd: sandbox.repo, ask: () => { throw new Error('install asked again'); }, platform: 'linux' });
  assertRows(again, sandbox.home, 'kept setting mailmap.file');
});

test('uninstall keeps a folder and a git config file that were there before install, even when empty (#985)', async () => {
  const sandbox = makeSandbox();
  // The user's own empty folders and git config, from before yokoten.
  const theirs = [join(sandbox.home, '.config'), join(sandbox.home, '.local', 'bin'), join(sandbox.home, '.claude'), join(sandbox.home, '.agents')];
  for (const dir of theirs) mkdirSync(dir, { recursive: true });
  const gitConfig = join(sandbox.home, '.gitconfig');
  writeFileSync(gitConfig, '');
  const done = install(sandbox.env, { cwd: sandbox.repo, ask: () => 'y', platform: 'linux' });
  assert.ok(done.ok, findingsOf(done, sandbox.home));
  // install made ~/.local/share and ~/.config/yokoten, and wrote down only those.
  const record = JSON.parse(readFileSync(machineStateFile(sandbox.env), 'utf8')).installCreated as string[];
  assert.ok(record.includes(join(sandbox.home, '.local', 'share')), record.join('\n'));
  for (const path of [...theirs, gitConfig]) assert.ok(!record.includes(path), `${path} was there before install`);
  // A second install keeps the record: it finds its own folders, not the user's.
  install(sandbox.env, { cwd: sandbox.repo, ask: () => 'y', platform: 'linux' });
  assert.deepEqual(JSON.parse(readFileSync(machineStateFile(sandbox.env), 'utf8')).installCreated, record);
  const result = await sandbox.call(['uninstall', '--list']);
  assert.equal(result.status, 0, result.stderr);
  // Positive control: the old uninstall removed each of these.
  for (const dir of theirs) assert.ok(existsSync(dir), `${dir} was the user's, so it stays`);
  assert.ok(existsSync(gitConfig), 'the git config file was the user\'s, so it stays');
  assert.ok(!existsSync(join(sandbox.home, '.local', 'share')), 'the folder install made goes');
  assert.ok(!existsSync(join(sandbox.home, '.config', 'yokoten')), 'machine.json and its folder go');
});

test('uninstall takes the empty git config file install made (#985)', async () => {
  const sandbox = makeSandbox();
  const gitConfig = join(sandbox.home, '.gitconfig');
  assert.ok(!existsSync(gitConfig));
  install(sandbox.env, { cwd: sandbox.repo, ask: () => 'y', platform: 'linux' });
  assert.ok(existsSync(gitConfig), 'git made the file when install set mailmap.file');
  assert.equal((await sandbox.call(['uninstall', '--list'])).status, 0);
  assert.ok(!existsSync(gitConfig));
});

test('install: the mark example follows an empty file, and a later run that does not ask leaves it out (#525)', async () => {
  const sandbox = makeSandbox();
  const marks = join(sandbox.home, '.config', 'yokoten', 'private-marks');
  const example = 'for example: your city, a company domain, a server name';
  // The sandbox git name is a shared account, and its email is a public noreply: no mark is added.
  let result = installIn(sandbox);
  assert.deepEqual(result.notes.filter((note) => note.id === 'private-marks').map((note) => [note.what.split(sandbox.home).join('~').split(sep).join('/'), note.fix, note.why]), [['~/.config/yokoten/private-marks has no marks yet', 'run `yokoten marks add` and type your name, your city or a domain; it is not shown', example]]);
  assert.match(readFileSync(marks, 'utf8'), /^# for example: your city, a company domain, a server name$/m);
  // A city and a domain are the kinds install asked for. The next run does not ask.
  writeFileSync(marks, `${readFileSync(marks, 'utf8')}mycity\nexample.com\n`);
  result = installIn(sandbox);
  assert.deepEqual(result.notes.filter((note) => note.id === 'private-marks'), [], 'no offer once the file has a city and a domain');
  assert.ok(!JSON.stringify(result).includes('mycity'), 'the result holds a mark');
});

test('install: an existing mailmap keeps its lines and gets only the missing ones; a privacy step never stops install (#390)', async () => {
  const sandbox = makeSandbox();
  sandbox.git('config', 'user.email', `jane${at}personal-mail.dev`);
  const mailmap = join(sandbox.home, '.config', 'yokoten', 'mailmap');
  mkdirSync(dirname(mailmap), { recursive: true });
  const own = `Me <me${at}example.com> <old${at}example.com>\n`;
  writeFileSync(mailmap, own);
  let result = installIn(sandbox);
  assert.ok(result.ok, findingsOf(result, sandbox.home));
  assert.equal(readFileSync(mailmap, 'utf8'), `${own}owner <owner@noreply.invalid> <jane${at}personal-mail.dev>\n`);
  assertRows(result, sandbox.home, 'added file ~/.config/yokoten/mailmap', 'skipped setting mailmap.file');
  // A marks path that is a folder: install says what it skipped, and goes on.
  const broken = join(sandbox.home, 'marks-folder');
  mkdirSync(broken);
  result = installIn({ ...sandbox, env: { ...sandbox.env, YOKOTEN_PRIVATE_MARKS: broken } });
  assert.match(findingsOf(result, sandbox.home), /^machine-runtime: install skipped the marks from this machine: /m);
  assert.match(findingsOf(result, sandbox.home), /^machine-runtime: install skipped the git mailmap: /m);
  assert.ok(result.changes.some((change) => change.kind === 'skill'), 'the rest of install ran');
});

// ---- The machine's user names (#404) ----

const USERS_NOW = new Date('2026-10-20T08:30:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

/** A fake machine for machineUserNames: its account name, its home, its folders and files, and a clock. */
function fakeUsers(username: string, home: string, folders: Record<string, string[]> = {}, { scanMs = 1, isReadOnly = false } = {}) {
  const files = new Map<string, string>();
  const listed: string[] = [];
  let clock = USERS_NOW.getTime();
  const probe: UserNameProbe & { files: Map<string, string>; listed: string[]; at(time: Date): void } = {
    files,
    listed,
    at: (time) => void (clock = time.getTime()),
    username: () => username,
    systemHome: () => home,
    listFolders(path) {
      listed.push(path);
      // Each read of a folder takes scanMs on the fake clock.
      clock += scanMs;
      return folders[path] ?? null;
    },
    readText: (path) => files.get(path) ?? null,
    writeText(path, text) {
      if (isReadOnly) throw new Error('read-only');
      files.set(path, text);
    },
    now: () => new Date(clock),
  };
  return probe;
}

const WSL_ENV = { HOME: '/home/jdoe', WSL_DISTRO_NAME: '<distro>' };

test('machineUserNames: the Linux and Windows user names, though no git or forge list has them (#404)', () => {
  const probe = fakeUsers('jdoe', '/home/jdoe', { '/mnt': ['c', 'd', 'wslg'], '/mnt/c/Users': ['Public', 'Default', 'defaultuser0', 'TEMP', 'JaneD', 'old.migrated', 'postgres', 'sshd', 'UpdatusUser', 'WsiAccount'] });
  const names = machineUserNames(WSL_ENV, probe);
  // No Windows folder is named jdoe, so every person folder counts: privacy first.
  assert.deepEqual(names, ['jdoe', 'JaneD']);
  const redact = makeRedactor({ owners: names }, { HOME: '/home/jdoe' });
  const text = ['/home/jdoe/x', '/mnt/c/Users/janed/y', 'C:\\Users\\JaneD\\z', '"C:\\\\Users\\\\JaneD"', 'C:%5CUsers%5CJaneD%5Cx', 'jdoe and JaneD', 'jdoes and janedoe stay'].join('\n');
  assert.equal(redact(text), ['~/x', '/mnt/c/Users/<owner>/y', 'C:\\Users\\<owner>\\z', '"C:\\\\Users\\\\<owner>"', 'C:%5CUsers%5C<owner>%5Cx', '<owner> and <owner>', 'jdoes and janedoe stay'].join('\n'));
});

test('machineUserNames: a Windows folder named like the Linux user is taken alone (#404)', () => {
  const probe = fakeUsers('jdoe', '/home/jdoe', { '/mnt': ['c'], '/mnt/c/Users': ['JDoe', 'Partner'] });
  assert.deepEqual(machineUserNames(WSL_ENV, probe), ['jdoe']);
});

test('machineUserNames: read once and kept 30 days in machine.json, its other keys kept (#404)', () => {
  const probe = fakeUsers('jdoe', '/home/jdoe', { '/mnt': ['c'], '/mnt/c/Users': ['JaneD'] });
  const file = machineStateFile(WSL_ENV);
  probe.files.set(file, JSON.stringify({ hostDisk: { free: 1, size: 2, readAt: USERS_NOW.toISOString(), distro: '<distro>', version: 2 } }));
  assert.deepEqual(machineUserNames(WSL_ENV, probe), ['jdoe', 'JaneD']);
  const state = JSON.parse(probe.files.get(file) ?? '{}');
  assert.deepEqual(state.hostDisk.size, 2, 'the host disk reading is kept');
  assert.deepEqual(state.windowsUsers.names, ['JaneD']);
  // A new process (a new probe) reads the file, not the drives.
  const next = fakeUsers('jdoe', '/home/jdoe', { '/mnt': ['c'], '/mnt/c/Users': ['JaneD', 'Partner'] });
  next.files.set(file, probe.files.get(file) ?? '');
  next.at(new Date(USERS_NOW.getTime() + 29 * DAY_MS));
  assert.deepEqual(machineUserNames(WSL_ENV, next), ['jdoe', 'JaneD']);
  assert.deepEqual(next.listed, []);
  // After 30 days the drives are read again.
  const late = fakeUsers('jdoe', '/home/jdoe', { '/mnt': ['c'], '/mnt/c/Users': ['JaneD', 'Partner'] });
  late.files.set(file, probe.files.get(file) ?? '');
  late.at(new Date(USERS_NOW.getTime() + 31 * DAY_MS));
  assert.deepEqual(machineUserNames(WSL_ENV, late), ['jdoe', 'JaneD', 'Partner']);
});

test('machineUserNames: kept names are filtered on read; a slow drive is not read again (#404)', () => {
  const file = machineStateFile(WSL_ENV);
  const old = new Date(USERS_NOW.getTime() - 60 * DAY_MS).toISOString();
  const probe = fakeUsers('jdoe', '/home/jdoe', { '/mnt': ['c'], '/mnt/c/Users': ['Other'] });
  probe.files.set(file, JSON.stringify({ windowsUsers: { names: ['JaneD', 'Public', 'defaultuser100001'], readAt: old, scanMs: 900 } }));
  assert.deepEqual(machineUserNames(WSL_ENV, probe), ['jdoe', 'JaneD']);
  assert.deepEqual(probe.listed, [], 'the last read took 900 ms, so the old names stay');
});

test('machineUserNames: a cache that cannot be written keeps the names for this process (#404)', () => {
  const probe = fakeUsers('jdoe', '/home/jdoe', { '/mnt': ['c'], '/mnt/c/Users': ['JaneD'] }, { isReadOnly: true });
  assert.deepEqual(machineUserNames(WSL_ENV, probe), ['jdoe', 'JaneD']);
  probe.listed.length = 0;
  assert.deepEqual(machineUserNames(WSL_ENV, probe), ['jdoe', 'JaneD']);
  assert.deepEqual(probe.listed, []);
});

test('machineUserNames: USERPROFILE gives the Windows name; a macOS home gives its name; shared names stay out (#404)', () => {
  const probe = fakeUsers('runner', '/root', { '/mnt': ['c'] });
  assert.deepEqual(machineUserNames({ HOME: '/home/jd', WSL_INTEROP: '/run/x', USERPROFILE: 'C:\\Users\\JaneD' }, probe), ['JaneD']);
  assert.deepEqual(probe.listed, [], 'the drives are not read');
  assert.deepEqual(machineUserNames({ HOME: '/Users/jdoe' }, fakeUsers('jdoe', '/Users/jdoe')), ['jdoe']);
  assert.deepEqual(machineUserNames({ HOME: '/tmp/tmp.AbCd' }, probe), [], 'a home outside a users folder names nobody');
  for (const shared of ['dev', 'test', 'app', 'build', 'vagrant', 'gitpod', 'ec2-user', 'jenkins', 'codespace', 'temp']) {
    assert.deepEqual(machineUserNames({ HOME: `/home/${shared}`, USER: shared }, fakeUsers(shared, `/home/${shared}`)), [], shared);
  }
  // Ordinary words stay readable.
  const redact = makeRedactor({ owners: machineUserNames({ HOME: '/home/dev', USER: 'test' }, fakeUsers('app', '/home/build')) }, {});
  assert.equal(redact('run the dev build, test the app as root'), 'run the dev build, test the app as root');
});

test('writeFileAtomic: the whole file or nothing, and no temp file left (#404)', () => {
  const dir = makeTempDir('yokoten-atomic-');
  try {
    const file = join(dir, 'sub', 'machine.json');
    writeFileAtomic(file, '{}\n');
    writeFileAtomic(file, '{"a":1}\n');
    assert.equal(readFileSync(file, 'utf8'), '{"a":1}\n');
    assert.deepEqual(readdirSync(join(dir, 'sub')), ['machine.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('install and uninstall: with no absolute home they refuse and write nothing (#404)', () => {
  const result = install({ HOME: '' });
  assert.equal(result.ok, false);
  assert.deepEqual(result.changes, [], 'nothing is named: nothing was written');
  assert.match(result.problems[0]?.what ?? '', /no home folder/);
  assert.equal(install({ HOME: 'relative/home' }).ok, false);
  assert.equal(install({}).ok, false, 'no HOME: the system home is the CLI entry\'s fallback, not install\'s (#356)');
  const removed = uninstall({ HOME: '' }, { platform: PLATFORM });
  assert.equal(removed.ok, false);
  assert.match(removed.problems[0]?.fix ?? '', /run `yokoten uninstall` again/);
  assert.equal(uninstall({}, { platform: PLATFORM }).ok, false, 'no HOME: uninstall does not fall back to the system home (#356)');
  assert.throws(() => paths({ HOME: '' }), /no home folder/);
  assert.equal(existsSync('relative') || existsSync('.local'), false, 'nothing lands in the folder the test runs in');
});

test('migrateMarks: an old block is split by kind; a value it cannot place stays strict (#410)', () => {
  const old = `# mine\nmycity\n# added by yokoten from this machine\nocto-jdoe\njane${at}personal-mail.dev\nnas\nbuild.private-host.dev\nbox\n\n# later\nmyserver\n`;
  assert.equal(migrateMarks('# mine\nmycity\n', { logins: [], hosts: [] }), null);
  assert.equal(
    migrateMarks(old, { logins: ['Octo-Jdoe'], hosts: ['nas'] }),
    `# mine\nmycity\n# added by yokoten from this machine: forge login\nocto-jdoe\n# added by yokoten from this machine: git email\njane${at}personal-mail.dev\n# added by yokoten from this machine: private remote host\nnas\nbuild.private-host.dev\n# your own marks\nbox\n# later\nmyserver\n`,
  );
  // With no login known, a bare name is never taken for one.
  assert.ok(!migrateMarks(old, { logins: [], hosts: [] })?.includes('forge login'));
});

test('fillMarks: rewrites an old block in a fake home, by the gh login on file, and keeps mode 600 (#410)', () => {
  const home = makeTempDir('yokoten-');
  const env = { HOME: home };
  const marks = join(home, '.config', 'yokoten', 'private-marks');
  mkdirSync(dirname(marks), { recursive: true });
  writeFileSync(marks, '# added by yokoten from this machine\nocto-jdoe\nnas\n', { mode: 0o600 });
  mkdirSync(join(home, '.config', 'gh'), { recursive: true });
  writeFileSync(join(home, '.config', 'gh', 'hosts.yml'), 'github.com:\n    user: octo-jdoe\n    git_protocol: https\n');
  // Before the rewrite, the old block gives no login: a bare name is strict.
  assert.deepEqual(autoLogins(loadMarkKinds(env)), []);
  assert.deepEqual(fillMarks(env, []), []);
  assert.equal(readFileSync(marks, 'utf8'), '# added by yokoten from this machine: forge login\nocto-jdoe\n# your own marks\nnas\n');
  assert.equal(statSync(marks).mode & 0o777, 0o600);
  assert.deepEqual(autoLogins(loadMarkKinds(env)), ['octo-jdoe']);
  assert.equal(countMarkKinds(env).get('by hand'), 1, 'the block yokoten could not tell is the owner\'s');
  assert.deepEqual(readdirSync(dirname(marks)), ['private-marks'], 'no temp file is left');
  // A second run changes nothing.
  fillMarks(env, []);
  assert.equal(readFileSync(marks, 'utf8'), '# added by yokoten from this machine: forge login\nocto-jdoe\n# your own marks\nnas\n');
});

// ---- The git name as a mark (#434) ----
//
// Samples are built from pieces, so this file passes its own privacy check.
const SAMPLE_NAME = ['Ann', 'Sample'].join(' ');
const SAMPLE_LOGIN = ['octo', 'sample'].join('-');
const GIT_NAME_BLOCK = `# added by yokoten from this machine: git name\n${SAMPLE_NAME}\n`;

/** How many lines of the text are `value`, case aside. */
const linesOf = (text: string, value: string) => text.split('\n').filter((line) => line.trim().toLowerCase() === value.toLowerCase()).length;

test('install: adds the git name as a mark of its own, never prints it, and not twice (#434)', async () => {
  const sandbox = makeSandbox();
  sandbox.git('config', 'user.name', SAMPLE_NAME);
  const marks = join(sandbox.home, '.config', 'yokoten', 'private-marks');
  const said: string[] = [];
  let listed = await sandbox.call(['install', '--list']);
  said.push(listed.stdout, listed.stderr);
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /^ {2}added {7}~\/\.config\/yokoten\/private-marks: git name from this machine \(the\n {14}values are not shown\)$/m);
  assert.doesNotMatch(listed.stdout, /add your real name/, 'no nudge to add the name by hand');
  assert.match(readFileSync(marks, 'utf8'), new RegExp(`${GIT_NAME_BLOCK}$`));
  assert.deepEqual(loadMarkKinds({ HOME: sandbox.home }).filter((mark) => mark.kind === 'git name').map((mark) => mark.value), [SAMPLE_NAME.toLowerCase()]);
  // A second run adds nothing, and says so.
  const result = installIn(sandbox);
  said.push(JSON.stringify(result));
  assert.deepEqual(rowsOf(result, sandbox.home).filter((row) => row.includes('private-marks')), ['kept file ~/.config/yokoten/private-marks']);
  assert.equal(linesOf(readFileSync(marks, 'utf8'), SAMPLE_NAME), 1);
  assert.ok(!said.some((text) => /ann|sample/i.test(text)), 'no output holds the name');
});

test('install: a git name that equals the forge login is not added twice (#434)', async () => {
  const sandbox = makeSandbox();
  sandbox.git('config', 'user.name', SAMPLE_LOGIN.toUpperCase());
  const marks = join(sandbox.home, '.config', 'yokoten', 'private-marks');
  mkdirSync(dirname(marks), { recursive: true });
  writeFileSync(marks, `# added by yokoten from this machine: forge login\n${SAMPLE_LOGIN}\n`, { mode: 0o600 });
  const result = await sandbox.call(['install', '--list']);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /added your git name/);
  assert.equal(readFileSync(marks, 'utf8'), `# added by yokoten from this machine: forge login\n${SAMPLE_LOGIN}\n`);
  assert.ok(!(result.stdout + result.stderr).toLowerCase().includes(SAMPLE_LOGIN));
});

test('fillMarks: the git name with no name set, one word, a shared name, a name already there, and a login found now (#434)', () => {
  const home = makeTempDir('yokoten-');
  const env = { HOME: home };
  const marks = join(home, '.config', 'yokoten', 'private-marks');
  // No git name: nothing is added, and no file is made.
  assert.deepEqual(fillMarks(env, []), []);
  assert.ok(!existsSync(marks));
  // A shared account name, or one under 3 letters, names nobody.
  assert.deepEqual(fillMarks(env, [{ kind: 'git name', value: 'Test' }, { kind: 'git name', value: 'Al' }]), []);
  // An address, or a placeholder from a tutorial, names nobody either.
  const placeholders = ['Your Name', 'John  Doe', 'jane doe', 'User', 'name', 'Admin', `ann${'@'}sample-mail.dev`];
  assert.deepEqual(fillMarks(env, placeholders.map((value) => ({ kind: 'git name' as const, value }))), []);
  // One word is a name too.
  assert.deepEqual(fillMarks(env, [{ kind: 'git name', value: 'Annsample' }]), ['git name']);
  assert.equal(readFileSync(marks, 'utf8').endsWith('# added by yokoten from this machine: git name\nAnnsample\n'), true);
  // A name the file has already, as the owner wrote it, is not added again.
  writeFileSync(marks, `${readFileSync(marks, 'utf8')}# mine\n${SAMPLE_NAME.toLowerCase()}\n`);
  assert.deepEqual(fillMarks(env, [{ kind: 'git name', value: SAMPLE_NAME }]), []);
  // A login found in the same run covers a git name that equals it: the login's mark is added.
  assert.deepEqual(fillMarks(env, [{ kind: 'git name', value: SAMPLE_LOGIN }, { kind: 'forge login', value: SAMPLE_LOGIN }]), ['forge login']);
  assert.equal(linesOf(readFileSync(marks, 'utf8'), SAMPLE_LOGIN), 1);
  // The positive control: a new name is still added.
  assert.deepEqual(fillMarks(env, [{ kind: 'git name', value: 'Bo Example' }]), ['git name']);
});

test('hasMarks: any mark counts, the ones yokoten found too; a comment or no file does not (#522)', () => {
  const home = makeTempDir('yokoten-');
  const env = { HOME: home };
  const marks = join(home, '.config', 'yokoten', 'private-marks');
  assert.equal(hasMarks(env), false, 'no file');
  mkdirSync(dirname(marks), { recursive: true });
  writeFileSync(marks, '# only a comment\n\n');
  assert.equal(hasMarks(env), false, 'no mark');
  writeFileSync(marks, `# added by yokoten from this machine: git name\n${SAMPLE_NAME}\n`);
  assert.equal(hasMarks(env), true, 'a mark install found');
});

test('filledLines: the git name has a line of its own, with no value; the other kinds keep theirs (#434)', () => {
  assert.deepEqual(filledLines(['git name', 'git email'], '~/m'), ['added your git name to the private marks (not shown)', 'added to ~/m from this machine: git email (the values are not shown)']);
  assert.deepEqual(filledLines(['git name'], '~/m'), ['added your git name to the private marks (not shown)']);
  assert.deepEqual(filledLines([], '~/m'), [], 'nothing added: the private-marks check gives the state, once (#522)');
});

test('fillMarks and addOwnMark: a mark only in the setting\'s file still goes into the default file (#656)', () => {
  const home = makeTempDir('yokoten-');
  const extra = join(home, 'extra-marks');
  writeFileSync(extra, `jane${at}personal-mail.dev\nquietharbor\n`);
  const env = { HOME: home, YOKOTEN_PRIVATE_MARKS: extra };
  const own = join(home, '.config', 'yokoten', 'private-marks');
  assert.deepEqual(fillMarks(env, [{ kind: 'git email', value: `jane${at}personal-mail.dev` }]), ['git email']);
  assert.equal(addOwnMark(env, 'QuietHarbor'), true);
  const text = readFileSync(own, 'utf8');
  assert.ok(text.includes(`jane${at}personal-mail.dev\n`) && text.endsWith('QuietHarbor\n'), 'both are in the default file');
  assert.equal(addOwnMark(env, 'quietharbor'), false, 'once there, it is known');
  assert.equal(readFileSync(extra, 'utf8'), `jane${at}personal-mail.dev\nquietharbor\n`, 'the setting\'s file is never written');
});

// #621: uninstall removes the stop log, and keeps the rest of ~/.config/yokoten.
test('uninstall: removes the stop log (#621)', async () => {
  const sandbox = makeSandbox();
  const log = join(sandbox.home, '.config', 'yokoten', 'stops.jsonl');
  mkdirSync(dirname(log), { recursive: true });
  writeFileSync(log, '{"time":"2026-10-23T00:00:00.000Z","vendor":"codex","role":"lead","rule":"release","answer":"refused"}\n');
  writeFileSync(join(sandbox.home, '.config', 'yokoten', 'keys.json'), '{}\n');
  const result = uninstallIn(sandbox);
  assert.ok(result.ok, findingsOf(result, sandbox.home));
  assert.ok(!existsSync(log));
  assertRows(result, sandbox.home, 'removed file ~/.config/yokoten/stops.jsonl', 'kept file ~/.config/yokoten yours');
  const again = uninstallIn(sandbox);
  assert.ok(!again.changes.some((change) => change.path === log), 'a second run has no stop log to name');
});

// #848: a line of the user's own that names the mark must not hide it, and CRLF alone is no edit.
const MANAGED_SKILL = `---
name: dispatch
description: Hand one task to a worker.
---
<!-- managed by yokoten; \`yokoten install\` updates this file, and keeps your edits -->

# Dispatch

Hand one task to a worker.
`;

/** The sealed skill with `above` before its mark and `below` after its first paragraph. */
const editedSkill = (above: string, below: string): string =>
  sealManaged(MANAGED_SKILL)
    .replace('<!-- managed by yokoten', `${above}\n<!-- managed by yokoten`)
    .replace('Hand one task to a worker.\n', `Hand one task to a worker.\n${below}\n`);

test('files: a line above the mark that says "managed by yokoten" does not hide the mark (#848)', () => {
  const sealed = sealManaged(MANAGED_SKILL);
  assert.match(sealed, / sha256=[0-9a-f]{64}/, 'the mark records a hash');
  // The user writes a description above the mark and a rule below it: both are their edit.
  const mine = editedSkill('This file is managed by yokoten, with my own rule.', 'Ask the owner before a release.');
  assert.equal(isEditedManaged(mine), true, 'the hash in the real mark is found');
  const path = join(makeTempDir(), 'SKILL.md');
  writeFileSync(path, mine);
  assert.equal(writeManaged(path, MANAGED_SKILL), 'kept (your edit)');
  assert.equal(readFileSync(path, 'utf8'), mine, 'their edit stays');
});

test('files: a markdown heading that names the mark is the user\'s, not yokoten\'s (#848)', () => {
  const path = join(makeTempDir(), 'SKILL.md');
  const mine = '# This skill is managed by yokoten, and I wrote it\n';
  writeFileSync(path, mine);
  assert.equal(writeManaged(path, MANAGED_SKILL), 'kept (yours)');
  assert.equal(readFileSync(path, 'utf8'), mine);
});

test('files: a file that only mentions the mark in its own words is the user\'s', () => {
  const path = join(makeTempDir(), 'notes.md');
  const mine = 'This file is managed by yokoten, in a sentence of my own.\n';
  writeFileSync(path, mine);
  assert.equal(writeManaged(path, MANAGED_SKILL), 'kept (yours)');
  assert.equal(readFileSync(path, 'utf8'), mine);
});

test('files: a managed file whose only change is CRLF line ends is yokoten\'s copy (#456)', () => {
  const sealed = sealManaged(MANAGED_SKILL);
  const windows = sealed.replace(/\n/g, '\r\n');
  assert.equal(isEditedManaged(windows), false, 'CRLF is not an edit');
  const path = join(makeTempDir(), 'SKILL.md');
  writeFileSync(path, windows);
  assert.equal(writeManaged(path, MANAGED_SKILL), 'updated');
  assert.equal(readFileSync(path, 'utf8'), sealed);
});

test('files: sealing the same text twice is stable, and a $ in the mark stays a $', () => {
  const once = sealManaged(MANAGED_SKILL);
  assert.equal(sealManaged(once), once);
  const withDollar = MANAGED_SKILL.replace('updates this file', 'updates this $file');
  assert.match(sealManaged(withDollar), /updates this \$file/, 'a $ does not read as a replacement pattern');
});

