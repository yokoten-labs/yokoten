// The three rules against damage outside the project (#969): no root for agents, no wipe
// of home or system folders, no disk commands. Each refusal keeps the four-line message.

import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkCommand } from '../../../../src/rules/guards/index.ts';
import { checkDamage } from '../../../../src/rules/guards/commands/no-wipe.ts';
import { climbsPastDrive, fromGitBash, gitBashDrive, isHostPaths, pathsFor } from '../../../../src/platform/paths.ts';
import { formatRefusal } from '../../../../src/rules/message.ts';
import { TEST_HOME } from '../../../repo/home.ts';
import { allowed, blocked, refusedAs } from '../../../../test/repo/helpers.ts';

const withHome = { HOME: TEST_HOME };

test('guard: an agent never gets root (#969)', () => {
  for (const command of ['sudo', 'sudo -n true', 'sudo -i', 'sudo -u root true', 'sudo git status', 'doas true', 'su root', 'su - root', 'pkexec true', 'runas /user:admin cmd', 'runas cmd', 'Start-Process -Verb RunAs cmd', 'Start-Process pwsh -Verb RunAs', 'Start-Process -Verb:RunAs cmd', 'Start-Process -Verb=RunAs cmd', 'env sudo true', 'nice sudo true', 'xargs sudo true', 'find . -exec sudo true \\;']) {
    refusedAs(command, 'no-root');
  }
  for (const command of ['git commit -m "no sudo"', 'echo sudo', 'grep sudo README.md', 'cat sudo.md', 'npm run sudo', 'git sudo-x', 'sudoers.txt', 'cat /etc/sudoers', 'Start-Process -Verb Open cmd']) {
    allowed(command);
  }
  // `/var` reads on each system as that system reads it. On Windows Git Bash keeps it for
  // itself and the guard can't place it, so the checkout rule answers first, and says why (#1015).
  for (const platform of ['linux', 'darwin'] as const) {
    assert.equal(checkCommand('sudo rm -rf /var', { cwd: process.cwd(), env: {}, place: { platform, tmp: '/tmp' } })?.id, 'no-root', platform);
  }
  const onWindows = checkCommand('sudo rm -rf /var', { cwd: 'C:\\work\\app', env: {}, place: { platform: 'win32', tmp: 'C:\\tmp' } });
  assert.equal(onWindows?.id, 'delete-checkout');
  assert.match(onWindows?.what ?? '', /can't tell where this path is/);
  const finding = checkCommand('sudo -n true', { cwd: process.cwd(), env: {} });
  assert.match(finding?.what ?? '', /root/);
  assert.match(finding?.fix ?? '', /tell the owner/);
});

test('guard: no wipe of the home folder or a top-level system folder (#969)', () => {
  for (const command of [
    'rm -rf ~', 'rm -rf ~/', 'rm -rf ~/*', 'rm -rf ~',
    'rm -rf $HOME', 'rm -rf ${HOME}', 'rm -rf "$HOME"', 'rm -rf $HOME/*', 'rm -rf $HOME/',
    // A path with a piece the guard cannot read is refused too.
    'rm -rf $(pwd)', 'rm -rf $DIR/x', 'rm -rf ~/*/x', 'rm -rf /*/*', 'rm -rf ~user', 'rm -rf ~root/x',
    // Every top-level folder belongs to the system, both on macOS and on Linux (#969).
    'rm -rf /System', 'rm -rf /Library', 'rm -rf /Applications', 'rm -rf /private', 'rm -rf /dev',
    'rm -rf /opt', 'rm -rf /srv', 'rm -rf /root', 'rm -rf /lib', 'rm -rf /sbin', 'rm -rf /Library/Developer',
    'Remove-Item -Recurse -Force $env:USERPROFILE', 'Remove-Item -Recurse ~', 'Remove-Item -r %USERPROFILE%',
    'rd /s /q ~', 'rd /s ~',
    // cmd's `del` and `erase` with `/s` delete files in every subfolder.
    'del /s /q %USERPROFILE%\\*', 'del /s /q C:/Users', 'del /s /q C:\\Users', 'erase /s /q %USERPROFILE%',
    'rmdir ~', 'rmdir /etc',
    'chmod -R 777 /', 'chmod -R 777 ~', 'chmod -R a+x /etc', 'chown -R root /etc', 'chown -R root:root /var',
  ]) refusedAs(command, 'wipe-home-or-system');
  // The root rule answers before the wipe rule.
  assert.equal(checkCommand('sudo rm -rf ~', { cwd: process.cwd(), env: {} })?.id, 'no-root');
  // A find that deletes, started at the home folder: with HOME known, the wipe rule answers; without it, remove-git does.
  assert.equal(checkCommand('find ~ -delete', { cwd: process.cwd(), env: withHome })?.id, 'wipe-home-or-system');
  assert.ok(checkCommand('find ~ -delete', { cwd: process.cwd(), env: {} }));
  // A find's own option before the start folder must not hide it: `-L`, `-P`, `-D` and `-O`
  // name no folder, and the start folder follows them (#969). An exact rule may answer first,
  // so the wipe rule is asked on its own here.
  for (const words of [
    ['find', '-L', '~', '-delete'],
    ['find', '-P', '~', '-delete'],
    ['find', '-H', '/', '-delete'],
    ['find', '-O3', '~', '-delete'],
    ['find', '-D', 'search', '~', '-delete'],
    ['find', '~', '-exec', 'rm', '-rf', '{}', '+'],
    ['find', '~', '-execdir', 'rm', '-rf', '{}', '+'],
    ['find', '~', '-ok', 'rm', '{}', ';'],
  ]) {
    assert.equal(checkDamage(words, process.cwd(), withHome)?.id, 'wipe-home-or-system', `should refuse: ${words.join(' ')}`);
  }
  for (const command of [
    'find -L ~ -delete', 'find -P ~ -delete', 'find -H / -delete', 'find -O3 ~ -delete', 'find -D search ~ -delete',
    'find ~ -exec rm -rf {} +', 'find ~ -exec rm -rf {} \\;', 'find ~ -execdir rm -rf {} +',
  ]) blocked(command, withHome);
  for (const command of [
    // A deeper folder, inside the home or out of it, stays allowed. A temp folder is no system folder.
    `rm -rf ${join(TEST_HOME, 'project', 'tmp-build')}`,
    'rm -rf dist/*', 'rm -rf src/a/..', 'rm -rf /tmp/x', 'rm -rf /tmp',
    'Remove-Item -Force ./out.txt', 'rd /s /q C:\\tmp\\x',
    // No wipe at all: a plain file, no recursion, or a folder only one level down in a temp folder.
    'rm notes.txt', 'rm -f ~', 'chmod +x bin/x', 'chmod -R 755 ./src', 'chown -R . ./src',
    'del notes.txt', 'erase /s /q ./out', 'find -L /tmp/build -delete',
  ]) allowed(command);
  // The home folder, written out, by text and by real path.
  assert.equal(checkCommand(`rm -rf ${TEST_HOME}`, { cwd: process.cwd(), env: withHome })?.id, 'wipe-home-or-system');
  assert.equal(checkCommand(`rm -rf ${TEST_HOME}/*`, { cwd: process.cwd(), env: withHome })?.id, 'wipe-home-or-system');
});

test('guard: a project one or two folders below the root is the project (#969)', () => {
  // A container keeps the project at /app, /src or /workspace, so its own folders are no
  // system folder. The folder the command runs in stays refused, and so does the system.
  const at = (cwd: string, command: string) => checkCommand(command, { cwd, env: withHome });
  for (const command of ['rm -rf node_modules', 'rm -rf dist', 'rm -rf coverage/*', 'rm -rf ./build', 'rm -rf /app/dist', 'chmod -R 755 ./src']) {
    assert.equal(at('/app', command), null, `should allow at /app: ${command}`);
  }
  assert.equal(at('/workspace', 'rm -rf ./build'), null);
  assert.equal(at('/src', 'chmod -R 755 ./src'), null);
  // `/opt` holds projects too: homebrew and app folders are no system folder from inside one.
  assert.equal(at('/opt/app', 'rm -rf dist'), null);
  for (const [cwd, command] of [
    ['/app', '/'],
    ['/app', '/app'],
    ['/app', '/usr'],
    ['/app', '/opt'],
    ['/', '/usr'],
    ['/usr', '/usr/lib'],
  ]) {
    assert.equal(checkDamage(['rm', '-rf', command], cwd, withHome)?.id, 'wipe-home-or-system', `should refuse at ${cwd}: rm -rf ${command}`);
  }
  assert.match(checkDamage(['rm', '-rf', '/app'], '/app', withHome)?.what ?? '', /this command runs in/);
  // At `/app`, a wipe of `/` is a wipe of the whole checkout too, and that rule answers first.
  assert.equal(at('/app', 'rm -rf /')?.id, 'delete-checkout');
});

test('guard: on Windows, the home folder and the system folders are no place to wipe (#999)', () => {
  // The platform is passed in, so Linux CI checks the Windows reading too.
  const home = { HOME: 'C:\\Users\\agent' };
  const project = 'C:\\Users\\agent\\project';
  const wipeAt = (cwd: string, target: string, env = home) => checkDamage(['rm', '-rf', target], cwd, env, 'win32')?.id ?? null;
  for (const target of [
    '~', '~/', '~\\', '~/*', '$HOME', '..', '../*',
    'C:\\Users\\agent', 'C:\\Users\\agent\\', 'c:/users/AGENT', 'C:/Users/agent/*', '/c/Users/agent', 'C:\\Users\\agent\\project\\..',
    // The other system folders on a drive, and what sits one level in them.
    'C:\\Users', 'C:\\Users\\other', 'C:\\Windows', 'C:\\Windows\\System32', 'C:\\Program Files', 'C:\\Program Files (x86)',
    'C:\\Program Files\\Git', 'C:\\ProgramData', 'D:\\', 'C:\\*', '/c/',
  ]) assert.equal(wipeAt(project, target), 'wipe-home-or-system', `should refuse on win32: rm -rf ${target}`);
  // A home folder written the Git Bash way is the same folder.
  assert.equal(wipeAt(project, 'C:\\Users\\agent', { HOME: '/c/Users/agent' }), 'wipe-home-or-system');
  assert.equal(wipeAt(project, '~', { HOME: '/c/Users/agent' }), 'wipe-home-or-system');
  // The folder the command runs in stays refused, in any of its forms.
  assert.match(checkDamage(['rm', '-rf', '.'], project, home, 'win32')?.what ?? '', /this command runs in/);
  assert.match(checkDamage(['rm', '-rf', '/c/users/agent/PROJECT'], project, home, 'win32')?.what ?? '', /this command runs in/);
  // Work inside a project stays allowed, by any form of its path.
  for (const target of ['dist', '.\\dist', 'node_modules', 'coverage/*', 'C:\\Users\\agent\\project\\dist', '/c/Users/agent/project/dist', 'c:/USERS/agent/project/build', 'C:\\Users\\agent\\other-project', 'C:\\tmp\\x', 'D:\\work\\app']) {
    assert.equal(wipeAt(project, target), null, `should allow on win32: rm -rf ${target}`);
  }
  // A POSIX-style path in Git Bash keeps its POSIX reading: the project at /app is the project.
  for (const target of ['dist', '/app/dist', '/tmp/x']) assert.equal(wipeAt('/app', target), null, `should allow on win32 at /app: rm -rf ${target}`);
  for (const target of ['/', '/usr', '/app']) assert.equal(wipeAt('/app', target), 'wipe-home-or-system', `should refuse on win32 at /app: rm -rf ${target}`);
  // Positive control: the same home folder is refused by every program the rule reads.
  for (const words of [['rd', '/s', '/q', 'C:\\Users\\agent'], ['Remove-Item', '-Recurse', '~'], ['find', '~', '-delete'], ['chmod', '-R', '777', '/c/Users/agent']]) {
    assert.equal(checkDamage(words, project, home, 'win32')?.id, 'wipe-home-or-system', `should refuse on win32: ${words.join(' ')}`);
  }
});

test('guard: no disk commands (#969)', () => {
  for (const command of [
    'mkfs.ext4 /dev/sda1', 'mkfs /dev/sdb', 'mkfs.vfat /dev/sdc',
    'wipefs /dev/sda', 'fdisk /dev/sdb', 'sfdisk /dev/sdc', 'cfdisk /dev/sdd',
    'parted /dev/sda print', 'format C:', 'diskpart',
    // The Mac's own disk command, and the other ways to a disk (#969).
    'diskutil eraseDisk JHFS+ x disk0', 'diskutil apfs deleteContainer disk1', 'diskutil list',
    'hdparm --security-erase x /dev/sda', 'gpt destroy /dev/sda', 'sgdisk --zap-all /dev/sda',
    'nvme format /dev/nvme0n1', 'blkdiscard /dev/sda', 'shred -n 1 /dev/sda',
    'dd if=/dev/zero of=/dev/sda', 'dd of=/dev/sda1', 'dd if=a of=/dev/disk/by-id/x',
    'echo hi > /dev/sda', 'echo hi > /dev/sdb', 'cat x >> /dev/disk0', 'true >| /dev/sdc',
  ]) refusedAs(command, 'disk-command');
  for (const command of [
    'echo hi > /dev/null', 'echo hi > /dev/tty', 'echo hi > /dev/stdout', 'echo hi > /dev/stderr',
    'git status 2>/dev/null', 'true 2>&1', 'dd if=a of=/dev/null', 'dd if=/dev/sda of=/dev/stdout',
    'shred notes.txt', 'shred /dev/null', 'git hash-object -w -t tree /dev/null', 'npm run format', 'clang-format src.ts', 'node script of=/dev/sda',
  ]) allowed(command);
});

test('guard: the refusal keeps its four lines (#969)', () => {
  const text = formatRefusal(checkCommand('rm -rf ~', { cwd: process.cwd(), env: withHome })!);
  const lines = text.split('\n');
  assert.equal(lines.length, 5);
  assert.match(lines[0], /^yokoten stopped this: .* \[wipe-home-or-system\]$/);
  assert.match(lines[2], /^  Why       /);
  assert.match(lines[3], /^  Instead   /);
  assert.match(lines[4], /^  More      https:/);
});

test('guard: a wipe run through cmd /c is read as the same wipe (#1015)', () => {
  for (const command of ['cmd /c del /s /q C:\\\\Users', 'cmd /c "del /s /q C:\\Users"', 'cmd //c "rd /s /q %USERPROFILE%"', 'cmd.exe /c rd /s /q %USERPROFILE%', 'CMD /C rd /s ~']) {
    refusedAs(command, 'wipe-home-or-system');
  }
  for (const command of ['cmd /c dir', 'cmd /c del /q build\\out.log', 'cmd //c echo hi']) allowed(command);
});

// ---- src/platform/paths.ts (#1015) ----
//
// The wipe guard is the first user of the Git Bash reading. test/ is at its 7-entry cap, so the
// platform helpers are tested here (architecture.test.ts NO_TEST_FILE says so).

const WIN_TMP = 'C:\\Users\\agent\\AppData\\Local\\Temp';

test('fromGitBash: on Windows a Git Bash path is the Windows one; elsewhere it stays as written (#1015)', () => {
  const cases: [string, string | null][] = [
    ['/c/Users/x/AGENTS.md', 'C:\\Users\\x\\AGENTS.md'],
    ['/C/Users/x', 'C:\\Users\\x'],
    ['/d', 'D:\\'],
    ['/c/', 'C:\\'],
    ['/c/../d/x', 'D:\\x'],
    ['/dev/../c/x', 'C:\\x'],
    ['/tmp', WIN_TMP],
    ['/tmp/repo/a', `${WIN_TMP}/repo/a`],
    ['/dev/null', '/dev/null'],
    ['/dev/stderr', '/dev/stderr'],
    // Folders Git Bash keeps for itself, and its root: the guard can't place them.
    ['/usr/x', null],
    ['/etc', null],
    ['/', null],
    ['/cx/y', null],
    ['/tmpx', null],
    ['/tmp/..', null],
    ['/dev/../usr', null],
    // Not a Git Bash full path: unchanged.
    ['//server/share/x', '//server/share/x'],
    ['src/a.ts', 'src/a.ts'],
    ['C:/x', 'C:/x'],
    ['C:\\x', 'C:\\x'],
  ];
  for (const [path, windows] of cases) {
    assert.equal(fromGitBash(path, 'win32', WIN_TMP), windows, `win32: ${path}`);
    for (const platform of ['linux', 'darwin'] as const) assert.equal(fromGitBash(path, platform, '/var/tmp'), path, `${platform}: ${path}`);
  }
  assert.equal(gitBashDrive('/c/x/y'), 'C:\\x\\y');
  assert.equal(gitBashDrive('/usr/x'), null);
});

test('climbsPastDrive: a relative path that climbs past C:\\ is unsure on Windows only (#1015)', () => {
  const folder = 'C:\\Users\\agent\\proj';
  const cases: [string, boolean][] = [
    ['src/a.ts', false],
    ['../x', false],
    ['../../../x', false], // C:\x
    ['../../../../c/x', true], // bash: /c/x, Node: C:\c\x
    ['a/../../../../../x', true],
    ['./a/./b', false],
  ];
  for (const [path, climbs] of cases) {
    assert.equal(climbsPastDrive(folder, path, 'win32'), climbs, `win32: ${path}`);
    assert.equal(climbsPastDrive('/home/agent/proj', path, 'linux'), false, `linux: ${path}`);
  }
});

test('pathsFor: Windows paths read as Windows reads them on any machine (#1015)', () => {
  assert.equal(pathsFor('win32').isAbsolute('C:\\x'), true);
  assert.equal(pathsFor('linux').isAbsolute('C:\\x'), false);
  assert.equal(isHostPaths(process.platform), true);
});
