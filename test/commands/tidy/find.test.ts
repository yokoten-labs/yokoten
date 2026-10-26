// Tests for src/commands/tidy/find.ts. The scan of a whole repo is in tidy.test.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeSandbox, makeTempDir } from '../../repo/helpers.ts';
import { folderSize, isInside, readProcessFolders, scanTidy, tidyStateDir } from '../../../src/commands/tidy/find.ts';

test('find: the trash lives in yokoten\'s own state folder on each system; a relative value is ignored (#1055)', () => {
  const cases: [Record<string, string>, NodeJS.Platform, string][] = [
    [{ HOME: '/home/a' }, 'linux', '/home/a/.local/state/yokoten'],
    [{ HOME: '/home/a', XDG_STATE_HOME: '/srv/state' }, 'linux', '/srv/state/yokoten'],
    [{ HOME: '/home/a', XDG_STATE_HOME: 'state' }, 'linux', '/home/a/.local/state/yokoten'],
    [{ HOME: '/Users/a' }, 'darwin', '/Users/a/.local/state/yokoten'],
    [{ HOME: '/home/a', LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, 'win32', 'C:\\Users\\a\\AppData\\Local\\yokoten'],
    [{ HOME: '/home/a', LOCALAPPDATA: 'D:\\very\\long\\path\\that\\goes\\on' }, 'win32', 'D:\\very\\long\\path\\that\\goes\\on\\yokoten'],
  ];
  for (const [env, platform, want] of cases) assert.equal(tidyStateDir(env, platform), want, JSON.stringify(env));
  // The positive control: no home at all is an error, never a folder in the current one.
  assert.throws(() => tidyStateDir({}, 'linux'));
});

test('find: inside means the folder or below it, never a sibling with the same start (#1055)', () => {
  assert.equal(isInside('/a/desk', '/a/desk'), true);
  assert.equal(isInside('/a/desk/src/x', '/a/desk'), true);
  assert.equal(isInside('/a/desk-2', '/a/desk'), false);
  assert.equal(isInside('/a', '/a/desk'), false);
});

test('find: a folder\'s size counts its files and never follows a link out (#1055)', () => {
  const folder = makeTempDir('yokoten-size-');
  const outside = makeTempDir('yokoten-big-');
  writeFileSync(join(outside, 'big'), 'x'.repeat(100_000));
  mkdirSync(join(folder, 'sub'));
  writeFileSync(join(folder, 'sub', 'file'), 'x'.repeat(5000));
  symlinkSync(outside, join(folder, 'link'));
  const size = folderSize(folder);
  assert.ok(size >= 5000 && size < 100_000, String(size));
  assert.equal(folderSize(join(folder, 'missing')), 0);
});

test('find: a program\'s working folder is seen on Linux; other systems read none (#1055)', { skip: process.platform !== 'linux' && 'reads /proc' }, async () => {
  const desk = realpathSync(makeTempDir('yokoten-busy-'));
  const child = spawn('sleep', ['30'], { cwd: desk, stdio: 'ignore' });
  try {
    await new Promise((resolve) => child.once('spawn', resolve));
    assert.ok(readProcessFolders('linux').includes(desk), 'the sleeping program is in the desk');
    assert.deepEqual(readProcessFolders('darwin'), []);
  } finally {
    child.kill();
  }
});

test('find: a repo with no commit and no branch finds nothing and does not fail (#1055)', () => {
  const sandbox = makeSandbox();
  const scan = scanTidy({ root: sandbox.repo, cwd: sandbox.repo, env: sandbox.env, platform: 'linux', now: Date.now() });
  assert.deepEqual([scan.base, scan.items, scan.remote], ['', [], []]);
});
