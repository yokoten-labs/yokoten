// The three rules against damage outside the project (#969): no root for agents, no wipe
// of home or system folders, no disk commands. Each refusal keeps the four-line message.

import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkCommand } from '../../../../src/rules/guards/index.ts';
import { formatRefusal } from '../../../../src/rules/message.ts';
import { TEST_HOME } from '../../../repo/home.ts';
import { allowed, refusedAs } from '../../../../test/repo/helpers.ts';

const withHome = { HOME: TEST_HOME };

test('guard: an agent never gets root (#969)', () => {
  for (const command of ['sudo', 'sudo -n true', 'sudo -i', 'sudo -u root true', 'sudo rm -rf /var', 'sudo git status', 'doas true', 'su root', 'su - root', 'pkexec true', 'runas /user:admin cmd', 'runas cmd', 'Start-Process -Verb RunAs cmd', 'Start-Process pwsh -Verb RunAs', 'env sudo true', 'nice sudo true', 'xargs sudo true', 'find . -exec sudo true \\;']) {
    refusedAs(command, 'no-root');
  }
  for (const command of ['git commit -m "no sudo"', 'echo sudo', 'grep sudo README.md', 'cat sudo.md', 'npm run sudo', 'git sudo-x', 'sudoers.txt', 'cat /etc/sudoers']) {
    allowed(command);
  }
  const finding = checkCommand('sudo -n true', { cwd: process.cwd(), env: {} });
  assert.match(finding?.what ?? '', /root/);
  assert.match(finding?.fix ?? '', /tell the owner/);
});

test('guard: no wipe of the home folder or a top-level system folder (#969)', () => {
  for (const command of [
    'rm -rf ~', 'rm -rf ~/', 'rm -rf ~/*', 'rm -rf ~',
    'rm -rf $HOME', 'rm -rf ${HOME}', 'rm -rf "$HOME"', 'rm -rf $HOME/*', 'rm -rf $HOME/',
    // A path with a piece the guard cannot read is refused too.
    'rm -rf $(pwd)', 'rm -rf $DIR/x', 'rm -rf ~/*/x', 'rm -rf /*/*',
    'Remove-Item -Recurse -Force $env:USERPROFILE', 'Remove-Item -Recurse ~', 'Remove-Item -r %USERPROFILE%',
    'rd /s /q ~', 'rd /s ~',
    'rmdir ~', 'rmdir /etc',
    'chmod -R 777 /', 'chmod -R 777 ~', 'chmod -R a+x /etc', 'chown -R root /etc', 'chown -R root:root /var',
  ]) refusedAs(command, 'wipe-home-or-system');
  // The root rule answers before the wipe rule.
  assert.equal(checkCommand('sudo rm -rf ~', { cwd: process.cwd(), env: {} })?.id, 'no-root');
  // A find that deletes, started at the home folder: with HOME known, the wipe rule answers; without it, remove-git does.
  assert.equal(checkCommand('find ~ -delete', { cwd: process.cwd(), env: withHome })?.id, 'wipe-home-or-system');
  assert.ok(checkCommand('find ~ -delete', { cwd: process.cwd(), env: {} }));
  for (const command of [
    // A deeper folder, inside the home or out of it, stays allowed.
    `rm -rf ${join(TEST_HOME, 'project', 'tmp-build')}`,
    'rm -rf dist/*', 'rm -rf src/a/..',
    'Remove-Item -Force ./out.txt', 'rd /s /q C:\\tmp\\x',
    // No wipe at all: a plain file, or no recursion.
    'rm notes.txt', 'rm -f ~', 'chmod +x bin/x', 'chmod -R 755 ./src', 'chown -R . ./src',
  ]) allowed(command);
  // The home folder, written out, by text and by real path.
  assert.equal(checkCommand(`rm -rf ${TEST_HOME}`, { cwd: process.cwd(), env: withHome })?.id, 'wipe-home-or-system');
  assert.equal(checkCommand(`rm -rf ${TEST_HOME}/*`, { cwd: process.cwd(), env: withHome })?.id, 'wipe-home-or-system');
});

test('guard: no disk commands (#969)', () => {
  for (const command of [
    'mkfs.ext4 /dev/sda1', 'mkfs /dev/sdb', 'mkfs.vfat /dev/sdc',
    'wipefs /dev/sda', 'fdisk /dev/sdb', 'sfdisk /dev/sdc', 'cfdisk /dev/sdd',
    'parted /dev/sda print', 'format C:', 'diskpart',
    'dd if=/dev/zero of=/dev/sda', 'dd of=/dev/sda1', 'dd if=a of=/dev/disk/by-id/x',
    'echo hi > /dev/sda', 'echo hi > /dev/sdb', 'cat x >> /dev/disk0', 'true >| /dev/sdc',
  ]) refusedAs(command, 'disk-command');
  for (const command of [
    'echo hi > /dev/null', 'echo hi > /dev/tty', 'echo hi > /dev/stdout', 'echo hi > /dev/stderr',
    'git status 2>/dev/null', 'true 2>&1', 'dd if=a of=/dev/null', 'dd if=/dev/sda of=/dev/stdout',
    'git hash-object -w -t tree /dev/null', 'npm run format', 'clang-format src.ts', 'node script of=/dev/sda',
  ]) allowed(command);
});

test('guard: the refusal keeps its four lines (#969)', () => {
  const text = formatRefusal(checkCommand('rm -rf ~', { cwd: process.cwd(), env: withHome })!);
  const lines = text.split('\n');
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^yokoten stopped this: .* \[wipe-home-or-system\]$/);
  assert.match(lines[1], /^Why: /);
  assert.match(lines[2], /^Do instead: /);
  assert.match(lines[3], /^More: https:/);
});
