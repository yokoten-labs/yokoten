// Tests for src/agents/desk/fence/seatbelt.ts: the profile sandbox-exec gets. This machine may
// not be a Mac, so the profile is checked as text here; start.test.ts checks the contract
// for real when it runs on macOS.

import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DeskPlan } from '../../../../src/agents/desk/desk.ts';
import { fencedPath, parentFolders, SEATBELT, sbplString, seatbeltProfile, shownFolders } from '../../../../src/agents/desk/fence/seatbelt.ts';
import { makeTempDir } from '../../../repo/helpers.ts';

const PLAN: DeskPlan = {
  desk: '/Users/someone/projects/desk',
  state: ['/Users/someone/projects/desk.state/codex'],
  readable: ['/opt/homebrew'],
  hidden: ['/Users', '/Volumes', '/Users/someone/projects'],
  locked: ['/Users/someone/projects/desk/.git/config', '/Users/someone/projects/desk/.git/hooks'],
  hosts: ['api.example.com'],
  env: { YOKOTEN_ROLE: 'worker', TZ: 'UTC' },
  command: ['codex', 'exec', 'hello'],
  isOwnSandboxOff: false,
};


test('sbplString: quotes and backslashes escaped; a line break refused', () => {
  assert.equal(sbplString('/a "b"\\c'), '"/a \\"b\\"\\\\c"');
  assert.throws(() => sbplString('/a\n(allow default)'), /line break/);
});

test('seatbeltProfile: starts from deny default and allows only what the contract needs', () => {
  const scratch = '/private/var/folders/x/scratch';
  const profile = seatbeltProfile(PLAN, 49152, scratch);
  const rules = profile.split('\n').filter((line) => line.startsWith('('));
  assert.equal(rules[1], '(deny default)');
  assert.ok(!profile.includes('(allow default)'));
  // 3. Reads: the shown paths, the desk, its state and the scratch folder; no home, no shared temp.
  const reads = rules.find((line) => line.startsWith('(allow file-read* ')) ?? '';
  for (const path of ['/opt/homebrew', PLAN.desk, ...PLAN.state, scratch]) assert.ok(reads.includes(`(subpath "${path}")`), path);
  for (const path of ['/Users"', '/Users/someone"', '/private/tmp"', '/private/var/folders"']) assert.ok(!reads.includes(`(subpath "${path}`), `${path} is not readable`);
  // Parent folders get their own metadata only, never a subpath.
  const metadata = rules.find((line) => line.startsWith('(allow file-read-metadata')) ?? '';
  assert.ok(metadata.includes('(literal "/Users/someone/projects")') && !metadata.includes('subpath'));
  // 1 and 2. Writes only in the desk, its state and the scratch folder; the locks denied last.
  assert.ok(profile.includes(`(allow file-write* (subpath "${PLAN.desk}") (subpath "/Users/someone/projects/desk.state/codex") (subpath "${scratch}"))`));
  assert.ok(rules.indexOf(rules.find((line) => line.startsWith('(deny file-write*')) ?? '') > rules.findIndex((line) => line.startsWith('(allow file-write* (subpath')));
  assert.ok(profile.includes('(deny file-write* (subpath "/Users/someone/projects/desk/.git/config") (subpath "/Users/someone/projects/desk/.git/hooks"))'));
  // 5. No network but the proxy port.
  assert.deepEqual(rules.filter((line) => line.includes('network')), ['(allow network-outbound (remote ip "localhost:49152"))']);
  // No door out: open, osascript, Launch Services, Apple events, and only listed Mach services.
  assert.ok(profile.includes('(deny process-exec (literal "/usr/bin/open") (literal "/usr/bin/osascript"))'));
  assert.ok(profile.includes('(deny lsopen)') && profile.includes('(deny appleevent-send)'));
  assert.ok(!/\(allow mach-lookup\)|global-name "com\.apple\.coreservices/.test(profile), 'no open Mach lookup, no Launch Services');
});

test('seatbeltProfile: dyld may list the root folder and use /dev/dtracehelper, nothing more', () => {
  const profile = seatbeltProfile(PLAN, 3128, '/private/var/folders/xy/scratch');
  assert.match(profile, /^\(allow file-read-data \(literal "\/"\)\)$/m);
  assert.match(profile, /\(allow file-ioctl [^\n]*\(literal "\/dev\/dtracehelper"\)/);
  assert.match(profile, /\(allow file-write\* [^\n]*\(literal "\/dev\/dtracehelper"\)/);
  // The root's entries only: no subpath read of / or of a hidden folder.
  assert.doesNotMatch(profile, /\(subpath "\/"\)/);
  assert.doesNotMatch(profile, /file-read[^\n]*\(subpath "\/Users"\)/);
});

test('seatbeltProfile: git may look for its config in a hidden home, and finds nothing', () => {
  const profile = seatbeltProfile({ ...PLAN, env: { ...PLAN.env, HOME: '/Users/someone' } }, 3128, '/private/var/folders/xy/scratch');
  const reads = profile.split('\n').find((line) => line.startsWith('(allow file-read* ')) ?? '';
  assert.ok(reads.includes('(subpath "/Users/someone/.gitconfig")') && reads.includes('(subpath "/Users/someone/.config/git")'));
  assert.ok(!reads.includes('(subpath "/Users/someone")') && !reads.includes('(subpath "/Users/someone/.config")'));
});

test('parentFolders: each parent once, up to the root', () => {
  assert.deepEqual(parentFolders(['/a/b/c', '/a/d']), ['/', '/a', '/a/b']);
});

test('seatbeltProfile: a port that is not a port is refused', () => {
  assert.throws(() => seatbeltProfile(PLAN, 0, '/tmp/x'), /not a port/);
});

test('SEATBELT.fence: sandbox-exec with the written profile, the proxy names and a private TMPDIR', () => {
  const scratch = makeTempDir('seatbelt-');
  const fenced = SEATBELT.fence(PLAN, 49152, scratch);
  assert.equal(fenced.file, '/usr/bin/sandbox-exec');
  assert.deepEqual(fenced.args, ['-f', join(scratch, 'desk.sb'), ...PLAN.command]);
  assert.equal(readFileSync(join(scratch, 'desk.sb'), 'utf8'), seatbeltProfile(PLAN, 49152, scratch));
  assert.equal(fenced.env.HTTPS_PROXY, 'http://127.0.0.1:49152');
  assert.equal(fenced.env.TMPDIR, join(scratch, 'tmp'));
  assert.equal(SEATBELT.proxyAddress(scratch), 0);
});

// fencedPath (#1181): a pretend file system, so each case names its links. A path not in
// LINKS is its own real path; null means it can't be resolved.
const LINKS: Record<string, string | null> = {
  '/Users/someone/bin': '/Users/someone/dotfiles/bin',
  '/opt/homebrew/link-to-hidden': '/Users/someone/dotfiles/bin',
  '/Users/someone/project/node_modules/.bin': '/Users/someone/project/node_modules/.bin',
  '/a/link-to-shown': '/a/b/bin',
  '/shown-link': '/a/b',
  '/missing': null,
};
const pretend = (path: string) => (Object.hasOwn(LINKS, path) ? LINKS[path] : path);
const SHOWN = ['/usr', '/opt', '/a/b', '/shown-link'];

test('fencedPath: real paths inside a shown folder, in order, once; the rest dropped', () => {
  const cases: [string, string, string][] = [
    // Positive controls: shown folders pass as they are, in their order.
    ['system folders stay', '/usr/bin:/opt/homebrew/bin', '/usr/bin:/opt/homebrew/bin'],
    ['order is kept', '/opt/homebrew/bin:/usr/bin', '/opt/homebrew/bin:/usr/bin'],
    ['a shown folder itself stays', '/a/b', '/a/b'],
    ['a link into a shown folder becomes its real path', '/a/link-to-shown:/usr/bin', '/a/b/bin:/usr/bin'],
    // The bug: a link into the hidden home, first on PATH.
    ['a link into a hidden folder is dropped', '/Users/someone/bin:/opt/homebrew/bin', '/opt/homebrew/bin'],
    ['a link inside a shown folder that points out is dropped', '/opt/homebrew/link-to-hidden:/usr/bin', '/usr/bin'],
    ['a hidden folder is dropped', '/Users/someone/project/node_modules/.bin:/usr/bin', '/usr/bin'],
    ['a folder only sharing a prefix is dropped', '/a/bc/bin:/a/b/bin', '/a/b/bin'],
    ['a shown folder given by a link counts by its real path', '/a/b/x', '/a/b/x'],
    ['an entry that is not there is dropped', '/missing:/usr/bin', '/usr/bin'],
    ['relative and empty entries are dropped', 'bin::./x:/usr/bin', '/usr/bin'],
    ['a repeat is dropped, the first kept', '/usr/bin:/a/link-to-shown:/usr/bin:/a/b/bin', '/usr/bin:/a/b/bin'],
    ['nothing shown leaves PATH empty', '/Users/someone/bin', ''],
  ];
  for (const [name, path, want] of cases) assert.equal(fencedPath(path, SHOWN, pretend), want, name);
});

test('fencedPath: on the real file system, a link into a hidden folder goes and a link into a shown one stays', () => {
  const root = makeTempDir('fenced-path-');
  for (const folder of ['shown/bin', 'shownc/bin', 'hidden/bin']) mkdirSync(join(root, folder), { recursive: true });
  symlinkSync(join(root, 'hidden', 'bin'), join(root, 'to-hidden'));
  symlinkSync(join(root, 'shown', 'bin'), join(root, 'to-shown'));
  const path = ['to-hidden', 'shownc/bin', 'to-shown', 'shown/bin', 'gone'].map((part) => join(root, part)).join(':');
  // The temp folder may itself sit behind a link (/var on macOS), so the answer is by real path.
  const real = fencedPath(join(root, 'shown'), [join(root, 'shown')]);
  assert.equal(fencedPath(path, [join(root, 'shown')]), join(real, 'bin'));
});

test('SEATBELT.fence: the agent gets the fenced PATH; no PATH stays no PATH', () => {
  const scratch = makeTempDir('seatbelt-');
  assert.equal(SEATBELT.fence({ ...PLAN, env: { ...PLAN.env, PATH: '/usr/bin:/Users/someone/missing-bin' } }, 49152, scratch).env.PATH, fencedPath('/usr/bin', shownFolders(PLAN, scratch)));
  assert.ok(!('PATH' in SEATBELT.fence(PLAN, 49152, scratch).env));
});

test("SEATBELT.fence: TMPDIR, TEMP and TMP are the desk's writable scratch folder, never the caller's (#1172)", () => {
  const scratch = makeTempDir('seatbelt-');
  const fenced = SEATBELT.fence({ ...PLAN, env: { ...PLAN.env, TMPDIR: '/tmp/claude', TEMP: '/tmp/claude', TMP: '/tmp/claude' } }, 49152, scratch);
  const work = join(scratch, 'tmp');
  assert.deepEqual([fenced.env.TMPDIR, fenced.env.TEMP, fenced.env.TMP], [work, work, work]);
  // The scratch folder is writable in the profile.
  assert.match(readFileSync(join(scratch, 'desk.sb'), 'utf8'), new RegExp(`\\(allow file-write\\* [^\\n]*\\(subpath "${scratch.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}"\\)`));
});
