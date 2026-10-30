// Tests for src/setup/install.ts: install: the machine's marks, the mailmap and the git name.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { test } from 'node:test';
import { shareGuardMeasure, shareSelfTest, at, makeSandbox, makeTempDir } from '../../repo/helpers.ts';
import { addOwnMark, countMarkKinds, filledLines, fillMarks, hasMarks, install, machineStateFile, machineUserNames, migrateMarks, paths, uninstall, type UserNameProbe, writeFileAtomic } from '../../../src/setup/install.ts';
import { autoLogins, loadMarkKinds, loadMarks, makeRedactor, useRealHome } from '../../../src/rules/privacy.ts';
import { PLATFORM, installIn, rowsOf, assertRows, findingsOf } from './helpers.ts';

shareGuardMeasure();
shareSelfTest();

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
  assert.match(listed.stdout, /^ {2}added {8}~\/\.config\/yokoten\/private-marks: git name, git email, private\n {14}remote host from this machine \(the values are not shown\)$/m);
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

test("install: the mailmap never takes an email from the real home's marks (#1145)", () => {
  const sandbox = makeSandbox();
  const real = makeTempDir('yokoten-real-');
  mkdirSync(join(real, '.config', 'yokoten'), { recursive: true });
  writeFileSync(join(real, '.config', 'yokoten', 'private-marks'), `someone${at}real-mail.dev\n`);
  // The sandbox home has a marks file with no mark in it: checking falls back to the real home.
  mkdirSync(join(sandbox.home, '.config', 'yokoten'), { recursive: true });
  writeFileSync(join(sandbox.home, '.config', 'yokoten', 'private-marks'), '# no marks yet\n');
  const restore = useRealHome(() => real);
  try {
    assert.ok(loadMarks(sandbox.env).includes(`someone${at}real-mail.dev`), 'the check reads the real home');
    installIn(sandbox);
    const mailmap = readFileSync(join(sandbox.home, '.config', 'yokoten', 'mailmap'), 'utf8');
    assert.ok(!mailmap.includes('real-mail'), 'the mailmap holds an email from the real home');
    assert.ok(!/^owner /m.test(mailmap), 'the mailmap has a line for an email nobody wrote here');
  } finally {
    restore();
  }
});

test("install names git's global mailmap.file as a setting it asks for, and a no leaves it unset (#985)", async () => {
  const sandbox = makeSandbox();
  sandbox.git('config', 'user.email', `jane${at}personal-mail.dev`);
  const result = installIn(sandbox);
  assert.ok(result.ok, findingsOf(result, sandbox.home));
  assertRows(result, sandbox.home, 'wrote file ~/.config/yokoten/mailmap', 'skipped setting mailmap.file');
  assert.match((await sandbox.call(['install', '--list'])).stdout, /^ {2}skipped {6}the git setting mailmap\.file: install changes your git config only\n {14}when you say yes$/m);
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
  assert.match(listed.stdout, /^ {2}added {8}~\/\.config\/yokoten\/private-marks: git name from this machine \(the\n {14}values are not shown\)$/m);
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
