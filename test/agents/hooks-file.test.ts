// Tests for src/agents/hooks-file.ts.

import '../repo/home.ts';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeTempDir } from '../repo/helpers.ts';
import { addHook, BACKUP_SUFFIX, hasOnlyOurHooks, removeHook, writeSafely, writeTarget } from '../../src/agents/hooks-file.ts';

const OUR_GUARD = 'node "/x/.local/share/yokoten/bin/yokoten.mjs" hook --commands-only';
const USER_HOOK = 'npx yokoten hook --agent claude-code';

test('writeSafely: a symlinked settings file stays a link, and the file it points at gets the text (#984)', () => {
  const dir = makeTempDir();
  mkdirSync(join(dir, 'dotfiles'));
  const real = join(dir, 'dotfiles', 'settings.json');
  writeFileSync(real, '{"model":"x"}\n');
  const link = join(dir, 'settings.json');
  symlinkSync(join('dotfiles', 'settings.json'), link);
  writeSafely(link, '{"model":"y"}\n');
  assert.ok(lstatSync(link).isSymbolicLink(), 'the link is still a link');
  assert.equal(readlinkSync(link), join('dotfiles', 'settings.json'));
  assert.equal(readFileSync(real, 'utf8'), '{"model":"y"}\n');
  // The copy sits next to the real file, not next to the link.
  assert.equal(readFileSync(`${real}${BACKUP_SUFFIX}`, 'utf8'), '{"model":"x"}\n');
  assert.ok(!existsSync(`${link}${BACKUP_SUFFIX}`));
  // A dangling link is followed too: the file is made where it points.
  const dangling = join(dir, 'gone.json');
  symlinkSync(join('dotfiles', 'new.json'), dangling);
  assert.equal(writeTarget(dangling), join(writeTarget(join(dir, 'dotfiles')), 'new.json'));
  writeSafely(dangling, '{}\n');
  assert.ok(lstatSync(dangling).isSymbolicLink());
  assert.equal(readFileSync(join(dir, 'dotfiles', 'new.json'), 'utf8'), '{}\n');
});

test('writeSafely: positive control, a plain write over a link replaces the link (#984)', () => {
  // What the old code did: write the text to a temp file and rename it over the path.
  const dir = makeTempDir();
  writeFileSync(join(dir, 'real.json'), '{}\n');
  symlinkSync('real.json', join(dir, 'link.json'));
  writeFileSync(join(dir, 'temp'), '{"a":1}\n');
  renameSync(join(dir, 'temp'), join(dir, 'link.json'));
  assert.ok(!lstatSync(join(dir, 'link.json')).isSymbolicLink(), 'without writeTarget the link is lost');
});

test('writeSafely: the first change keeps one copy, and a later change never overwrites it (#984)', () => {
  const dir = makeTempDir();
  const file = join(dir, 'config.toml');
  writeFileSync(file, 'model = "mine"\n');
  writeSafely(file, 'model = "mine"\nsandbox = "a"\n');
  assert.equal(readFileSync(`${file}${BACKUP_SUFFIX}`, 'utf8'), 'model = "mine"\n');
  writeSafely(file, 'model = "mine"\nsandbox = "b"\n');
  assert.equal(readFileSync(`${file}${BACKUP_SUFFIX}`, 'utf8'), 'model = "mine"\n', 'the copy holds the version from before yokoten');
  assert.equal(readFileSync(file, 'utf8'), 'model = "mine"\nsandbox = "b"\n');
  // A new file has nothing to keep, and a file that is only yokoten's needs no copy.
  const fresh = join(dir, 'fresh.json');
  writeSafely(fresh, '{}\n');
  writeSafely(fresh, '{"a":1}\n', { isOurs: () => true });
  assert.ok(!existsSync(`${fresh}${BACKUP_SUFFIX}`));
  assert.deepEqual(readdirSync(dir).sort(), ['config.toml', `config.toml${BACKUP_SUFFIX}`, 'fresh.json']);
});

test('writeSafely: a failed rename leaves the old bytes and no temp file (#984)', () => {
  const dir = makeTempDir();
  const file = join(dir, 'settings.json');
  const old = '{ "model": "x" }\n';
  writeFileSync(file, old);
  const failing = (() => {
    throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  }) as typeof renameSync;
  assert.throws(() => writeSafely(file, '{}\n', { rename: failing }), /disk full/);
  assert.equal(readFileSync(file, 'utf8'), old);
  assert.deepEqual(readdirSync(dir).sort(), ['settings.json', `settings.json${BACKUP_SUFFIX}`], 'no temp file is left');
  // Positive control: the same rename, when it works, does write the new text.
  writeSafely(file, '{}\n', { rename: renameSync });
  assert.equal(readFileSync(file, 'utf8'), '{}\n');
});

test('writeSafely: the file keeps its mode (#984)', { skip: process.platform === 'win32' }, () => {
  const dir = makeTempDir();
  const file = join(dir, 'config.toml');
  writeFileSync(file, 'a = 1\n');
  chmodSync(file, 0o600);
  writeSafely(file, 'a = 2\n');
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('hasOnlyOurHooks: hooks that run yokoten by path, and nothing else (#984)', () => {
  const ours = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: OUR_GUARD }] }] } };
  assert.ok(hasOnlyOurHooks(JSON.stringify(ours)));
  assert.ok(hasOnlyOurHooks(JSON.stringify({ ...ours, env: { TZ: 'UTC' } })));
  // Positive controls: anything of the user's makes the file worth a copy.
  assert.ok(!hasOnlyOurHooks(JSON.stringify({ ...ours, model: 'x' })));
  assert.ok(!hasOnlyOurHooks(JSON.stringify({ ...ours, env: { TZ: 'UTC', HTTP_PROXY: 'y' } })));
  assert.ok(!hasOnlyOurHooks(JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: USER_HOOK }] }] } })));
  assert.ok(!hasOnlyOurHooks('not json'));
});

test("addHook and removeHook: a user's own npx yokoten hook stays (#984)", () => {
  const dir = makeTempDir();
  const file = join(dir, 'settings.json');
  const userGroup = { matcher: 'Bash', hooks: [{ type: 'command', command: USER_HOOK }] };
  writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [userGroup] } }));
  assert.equal(addHook(file, 'PreToolUse', 'Bash', OUR_GUARD), 'added', 'the user hook is not taken as yokoten\'s own');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).hooks.PreToolUse, [userGroup, { matcher: 'Bash', hooks: [{ type: 'command', command: OUR_GUARD }] }]);
  // An older path of yokoten's own hook is still updated in place.
  const newer = OUR_GUARD.replace('/x/', '/y/');
  assert.equal(addHook(file, 'PreToolUse', 'Bash', newer), 'updated');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).hooks.PreToolUse[1].hooks[0].command, newer);
  assert.equal(removeHook(file, 'PreToolUse', 'hook'), 'removed');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { hooks: { PreToolUse: [userGroup] } }, 'only yokoten\'s hook went');
  assert.equal(removeHook(file, 'PreToolUse', 'hook'), 'not there');
  // Positive control: the same removal does take out yokoten's own hook, which runs a yokoten file by path.
  writeFileSync(join(dir, 'ours.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: OUR_GUARD }] }] } }));
  assert.equal(removeHook(join(dir, 'ours.json'), 'PreToolUse', 'hook'), 'removed');
  assert.ok(!existsSync(join(dir, 'ours.json')), 'a file with only yokoten\'s hook goes');
  assert.equal(readFileSync(`${file}${BACKUP_SUFFIX}`, 'utf8'), JSON.stringify({ hooks: { PreToolUse: [userGroup] } }), 'the user\'s file from before yokoten is kept');
});
