// Tests for src/setup/install.ts: install: the runtime copy and the launcher.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, relative, sep } from 'node:path';
import { test } from 'node:test';
import { rowsText, shareGuardMeasure, shareSelfTest, makeSandbox, makeTempDir } from '../../repo/helpers.ts';
import { RENAME_WAITS_MS, renameRetrying } from '../../../src/platform/disk.ts';
import { copyRuntime, isSameOrInside, sealManaged } from '../../../src/setup/files.ts';
import { isOnPath, launcherText, PROFILE_LINE, setUpLauncher, shellProfile, type Steps, USER_CLI } from '../../../src/setup/install.ts';
import { installIn, uninstallIn, assertRows, findingsOf } from './helpers.ts';

shareGuardMeasure();
shareSelfTest();

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
  assert.match(rowsText(doctor.stdout), /\n {2}note {9}lesson incident-138: test\/api\.test\.js: a test calls a server on this machine and does not set NO_PROXY; /);
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
  assert.match(screen.stdout, /^ {2}note {9}command {5}~\/\.local\/bin is not on your PATH yet$/m);
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
