// Tests for src/commands/tidy/put-away.ts. Saving and moving a whole repo is in tidy.test.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeTempDir } from '../../repo/helpers.ts';
import { deleteTrash, longPath, makeTrashFolder, moveFolder, readTrash, safeName, TRASH_KEEP_MS, trashStamp } from '../../../src/commands/tidy/put-away.ts';

const NOW = Date.parse('2026-10-26T09:05:07.123Z');

test('put-away: the trash folder is named by UTC time; names stay short and safe on every system (#1055)', () => {
  assert.equal(trashStamp(NOW), '2026-10-26T090507Z');
  assert.equal(safeName('feature/issue-12'), 'feature-issue-12');
  assert.equal(safeName('..\\..\\x'), 'x');
  assert.equal(safeName('...'), 'item');
  assert.equal(safeName('n'.repeat(300)).length, 40);
});

test('put-away: Windows reads a long path with its \\\\?\\ prefix; short paths and other systems stay as they are (#1055)', () => {
  const deep = `C:\\Users\\a\\${'d'.repeat(250)}`;
  const share = `\\\\server\\share\\${'s'.repeat(250)}`;
  const cases: [string, NodeJS.Platform, string][] = [
    [deep, 'win32', `\\\\?\\${deep}`],
    [share, 'win32', `\\\\?\\UNC\\server\\share\\${'s'.repeat(250)}`],
    [`\\\\?\\${deep}`, 'win32', `\\\\?\\${deep}`],
    ['C:\\Users\\a\\short', 'win32', 'C:\\Users\\a\\short'],
    [`/home/a/${'d'.repeat(250)}`, 'linux', `/home/a/${'d'.repeat(250)}`],
  ];
  for (const [path, platform, want] of cases) assert.equal(longPath(path, platform), want);
});

test('put-away: a move across drives copies, checks, then removes; links stay links (#1055)', () => {
  const base = makeTempDir('yokoten-move-');
  const from = join(base, 'desk');
  mkdirSync(join(from, 'sub'), { recursive: true });
  writeFileSync(join(from, 'sub', 'file'), 'work\n');
  symlinkSync('/nowhere', join(from, 'link'));
  const crossDrive = () => {
    throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
  };
  moveFolder(from, join(base, 'trash', 'desk'), 'linux', crossDrive);
  assert.equal(existsSync(from), false);
  assert.equal(readFileSync(join(base, 'trash', 'desk', 'sub', 'file'), 'utf8'), 'work\n');
  assert.ok(lstatSync(join(base, 'trash', 'desk', 'link')).isSymbolicLink());
  assert.equal(readlinkSync(join(base, 'trash', 'desk', 'link')), '/nowhere');
  // The positive control: a target that is there already is refused, and the source stays.
  mkdirSync(join(base, 'again'));
  mkdirSync(join(base, 'taken'));
  assert.throws(() => moveFolder(join(base, 'again'), join(base, 'taken'), 'linux'), /is there already/);
  assert.ok(existsSync(join(base, 'again')));
  // Any other rename error is not a cross-drive move: nothing is copied.
  const denied = () => {
    throw Object.assign(new Error('denied'), { code: 'EACCES' });
  };
  assert.throws(() => moveFolder(join(base, 'again'), join(base, 'elsewhere'), 'linux', denied), /denied/);
  assert.deepEqual([existsSync(join(base, 'again')), existsSync(join(base, 'elsewhere'))], [true, false]);
});

test('put-away: a trash folder per run, never one made twice, and never a trash that is a link (#1055)', () => {
  const base = makeTempDir('yokoten-trash-');
  const trash = join(base, 'trash');
  assert.equal(makeTrashFolder(trash, NOW), join(trash, '2026-10-26T090507Z'));
  assert.equal(makeTrashFolder(trash, NOW), join(trash, '2026-10-26T090507Z-2'));
  const real = join(base, 'real');
  mkdirSync(real);
  symlinkSync(real, join(base, 'linked'));
  assert.throws(() => makeTrashFolder(join(base, 'linked'), NOW), /link or not a folder/);
});

test('put-away: only a real folder directly in the trash, with an old index, is deleted (#1055)', () => {
  const base = makeTempDir('yokoten-empty-');
  const trash = join(base, 'trash');
  const put = (name: string, created: number) => {
    mkdirSync(join(trash, name), { recursive: true });
    writeFileSync(join(trash, name, 'index.json'), JSON.stringify({ created: new Date(created).toISOString() }));
  };
  put('old', NOW - TRASH_KEEP_MS - 1);
  put('new', NOW - TRASH_KEEP_MS + 60_000);
  const found = readTrash(trash, NOW);
  assert.deepEqual(found.map((folder) => [folder.path.slice(trash.length + 1), folder.isOld]), [['new', false], ['old', true]]);
  // The positive control: a folder outside the trash, though old, is refused.
  const stray = join(base, 'stray');
  mkdirSync(stray);
  assert.deepEqual(deleteTrash(trash, [{ path: stray, created: 0, size: 0, isOld: true }, ...found], 'linux'), [join(trash, 'old')]);
  assert.deepEqual([existsSync(stray), existsSync(join(trash, 'new')), existsSync(join(trash, 'old'))], [true, true, false]);
  assert.deepEqual(readTrash(join(base, 'none'), NOW), []);
});
