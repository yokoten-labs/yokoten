// Tests for src/setup/install.ts: install and uninstall: the skills, the agents and the settings.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { rowsText, shareGuardMeasure, shareSelfTest, makeSandbox } from '../../repo/helpers.ts';
import { hasHook } from '../../../src/agents/hooks-file.ts';
import { isMachineSetUp, paths } from '../../../src/setup/install.ts';
import { installIn, uninstallIn, assertRows, findingsOf } from './helpers.ts';

shareGuardMeasure();
shareSelfTest();

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
  assert.deepEqual([result.status, result.stdout, result.stderr], [1, '', 'yokoten install · unknown option --dry-run\n\n  install     skills, agents and user-level hooks for this machine\n\nNext: `yokoten install --help`\n']);
  assert.deepEqual(readdirSync(sandbox.home, { recursive: true }).sort(), homeBefore, 'install --dry-run writes nothing');
  // A real child, for the entry: the exit code and output through bin/yokoten.ts.
  result = sandbox.run(['install', '--list']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^ {2}kept {9}agent reviewer \(yours, not yokoten's\)$/m);
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
  assert.match(result.stdout, /^ {2}wrote {8}skill yokoten in ~\/\.claude\/skills$/m);
  assert.match(result.stdout, /^ {2}linked {7}skill yokoten in ~\/\.agents\/skills$/m);
  // The shared folder holds one link to Claude Code's copy, so Muse, which reads both
  // folders, sees the entry skill once and warns about none (#557).
  assert.equal(readlinkSync(join(shared, 'skills', 'yokoten')), join(claude, 'skills', 'yokoten'));
  // The entry names where the rest live.
  assert.match(readFileSync(join(claude, 'skills', 'yokoten', 'SKILL.md'), 'utf8'), /kit\/user\/skills\/<name>\/SKILL\.md/);
  assert.match(result.stdout, /^ {2}kept {9}skill rca in ~\/\.agents\/skills \(yours, not yokoten's\)$/m);
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
  const skillsLine = async () => rowsText((await sandbox.call(['doctor', '--all'])).stdout).split('\n').find((l) => / skills/.test(l)) ?? '';
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
  assert.match(result.stdout, /^ {2}removed {6}skill yokoten in ~\/\.claude\/skills$/m);
  assert.ok(!result.stdout.includes(sandbox.home), 'output shows the home path');
  // The shared link is removed, never followed: only the user's own skill is left there.
  assert.deepEqual(readdirSync(join(sandbox.home, '.agents', 'skills')), ['rca']);
  // Only what was there is named: a kit skill install never wrote is no change.
  for (const name of before.filter((n) => n !== 'yokoten' && n !== 'rca')) assert.doesNotMatch(result.stdout, new RegExp(`skill ${name} in`));
  assert.match(result.stdout, /^ {2}kept {9}skill rca in ~\/\.agents\/skills \(yours, not yokoten's\)$/m);
  assert.match(result.stdout, /^ {2}removed {6}agent worker$/m);
  assert.match(result.stdout, /^ {2}removed {6}Claude Code hooks in ~\/\.claude\/settings\.json: SessionStart doctor$/m);
  assert.match(result.stdout, /^ {2}removed {6}the runtime ~\/\.local\/share\/yokoten$/m);
  assert.match(result.stdout, /^ {2}removed {6}~\/\.config\/yokoten\/private-marks$/m);
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
