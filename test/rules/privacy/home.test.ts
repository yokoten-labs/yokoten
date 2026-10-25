// Tests for src/rules/privacy/home.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { configHomeIn, configHomeOf, configHomeShown, envFolder, folderIn, folderOf, gluedHomes, homeIn, homeOf, NO_HOME, realHomeRead, useRealHome, withHome } from '../../../src/rules/privacy/home.ts';

// #988: a tool's config folder moves with its variable. A relative value is ignored, as the
// XDG spec says, so nothing lands in the folder the command runs in.
test('home: a config folder variable counts when it is a full path; a relative one is ignored (#988)', () => {
  const home = '/tmp/yokoten-home';
  assert.equal(folderOf({ HOME: home, CLAUDE_CONFIG_DIR: '/tmp/claude-elsewhere' }, 'CLAUDE_CONFIG_DIR', '.claude'), '/tmp/claude-elsewhere');
  assert.equal(folderOf({ HOME: home, CLAUDE_CONFIG_DIR: 'relative/claude' }, 'CLAUDE_CONFIG_DIR', '.claude'), join(home, '.claude'));
  assert.equal(folderOf({ HOME: home }, 'CLAUDE_CONFIG_DIR', '.claude'), join(home, '.claude'));
  assert.equal(folderOf({ CODEX_HOME: '/tmp/codex' }, 'CODEX_HOME', '.codex'), '/tmp/codex', 'a full path needs no home');
  assert.equal(folderOf({}, 'CODEX_HOME', '.codex'), null);
  assert.throws(() => folderIn({ CODEX_HOME: 'relative' }, 'CODEX_HOME', '.codex'), new Error(NO_HOME));
  assert.equal(envFolder({ XDG_CONFIG_HOME: '' }, 'XDG_CONFIG_HOME'), null);
  // The positive control: the old `env.XDG_CONFIG_HOME || ...` took the relative value.
  assert.equal(configHomeOf({ HOME: home, XDG_CONFIG_HOME: 'xdg' }), join(home, '.config'));
  assert.equal(configHomeIn({ HOME: home, XDG_CONFIG_HOME: '/tmp/xdg' }), '/tmp/xdg');
  assert.equal(configHomeShown({ HOME: home, XDG_CONFIG_HOME: 'xdg' }, 'muse/settings.json'), '~/.config/muse/settings.json');
  assert.equal(configHomeShown({ HOME: home, XDG_CONFIG_HOME: '/tmp/xdg' }, 'muse/settings.json'), '$XDG_CONFIG_HOME/muse/settings.json');
});

// #1017: bash drops the backslashes of an unquoted Windows path. Only a drive path with two
// or more folders under the drive has a glued form, so `C:` alone never matches.
test('home: the forms of a Windows home that bash ran together (#1017)', () => {
  const cases: [string | undefined, string[]][] = [
    ['C:\\Users\\sample', ['C:Userssample', 'Userssample']],
    ['c:/Users/sample/', ['c:Userssample', 'Userssample']],
    ['D:\\home\\agent\\work', ['D:homeagentwork', 'homeagentwork']],
    ['C:\\Users', []],
    ['C:\\', []],
    ['C:', []],
    ['/home/sample', []],
    ['/c/Users/sample', []],
    ['', []],
    [undefined, []],
  ];
  for (const [home, glued] of cases) assert.deepEqual(gluedHomes(home).map((form) => form.glued), glued, String(home));
  assert.deepEqual(gluedHomes('C:/Users/sample').map((form) => form.path), ['C:\\Users\\sample', '\\Users\\sample'], 'each form names the path it stands for');
});

test('home: an absolute HOME is the home folder; a relative one is none (#392)', () => {
  assert.equal(homeOf({ HOME: '/tmp/yokoten-home' }), '/tmp/yokoten-home');
  assert.equal(homeOf({ HOME: 'relative/home' }), null);
  assert.equal(homeOf({}), null);
});

test('home: homeIn throws NO_HOME when there is no full home folder', () => {
  assert.throws(() => homeIn({}), new Error(NO_HOME));
  assert.throws(() => homeIn({ HOME: 'not/full' }), new Error(NO_HOME));
  assert.equal(homeIn({ HOME: '/tmp/yokoten-home' }), '/tmp/yokoten-home');
});

test('home: withHome fills a missing home from the system, and keeps a full one (#356)', () => {
  assert.deepEqual(withHome({}, () => '/tmp/yokoten-system'), { HOME: '/tmp/yokoten-system' });
  assert.deepEqual(withHome({ HOME: 'relative' }, () => '/tmp/yokoten-system'), { HOME: '/tmp/yokoten-system' });
  assert.deepEqual(withHome({ HOME: '/tmp/yokoten-mine' }, () => '/tmp/yokoten-system'), { HOME: '/tmp/yokoten-mine' });
  // The positive control: a system that can tell no home leaves the env as it was.
  assert.deepEqual(withHome({}, () => ''), {});
});

test('home: useRealHome points the real-home read at a stand-in, and puts it back', () => {
  const before = realHomeRead();
  const restore = useRealHome(() => '/tmp/yokoten-real');
  try {
    assert.equal(realHomeRead()(), '/tmp/yokoten-real');
  } finally {
    restore();
  }
  assert.equal(realHomeRead(), before);
});
