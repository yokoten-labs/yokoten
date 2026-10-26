// Tests for src/commands/merge/conflicts/order.ts (#912).

import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { listPullRequests, mergeOrder, nextPick } from '../../../../src/commands/merge/conflicts/order.ts';
import type { Change, Collision, ConflictMap } from '../../../../src/commands/merge/conflicts/types.ts';
import { makeSandbox } from '../../../repo/helpers.ts';

/** One open change, with only what a test needs set. */
function change(id: string, extra: Partial<Change> = {}): Change {
  const name = id.startsWith('pr:') ? `PR #${id.slice(3)}` : `branch ${id.slice(7)}`;
  return { id, label: name, branch: id.replace(/^(pr|branch):/, ''), head: '01234567', draft: false, files: [], moves: [], mainConflicts: [], ...extra };
}

const pair = (a: string, b: string, files = ['src/a.ts']): Collision => ({ first: a, second: b, files });

/** A map with no leases and no hot paths, which the order never reads. */
function mapOf(changes: Change[], collisions: Collision[] = []): ConflictMap {
  return { version: 1, builtAt: '2026-10-24T00:00:00Z', main: '01234567', changes, collisions, leased: {}, hot: [] };
}

const ids = (map: ConflictMap) => mergeOrder(map).map((pick) => pick.id);

test('a structural change goes first, alone, then a free one, then the colliding ones', () => {
  const map = mapOf([change('pr:1'), change('pr:2'), change('pr:3', { moves: ['src/old.ts'] }), change('pr:4')], [pair('pr:1', 'pr:4')]);
  assert.deepEqual(ids(map), ['pr:3', 'pr:2', 'pr:1', 'pr:4']);
  assert.match(mergeOrder(map)[0].why, /moves or deletes 1 file/);
});

test('the change that more others collide with goes first', () => {
  const map = mapOf([change('pr:1'), change('pr:2'), change('pr:3'), change('pr:4')], [pair('pr:1', 'pr:2'), pair('pr:1', 'pr:3'), pair('pr:2', 'pr:3'), pair('pr:3', 'pr:4')]);
  // pr:3 collides with three, pr:1 and pr:2 with two (pr:1 is older), pr:4 with one.
  assert.deepEqual(ids(map), ['pr:3', 'pr:1', 'pr:2', 'pr:4']);
});

test('two changes that collide with as many go oldest first, and the map list is the age', () => {
  const map = mapOf([change('pr:8'), change('pr:2')], [pair('pr:8', 'pr:2')]);
  assert.deepEqual(ids(map), ['pr:8', 'pr:2']);
  assert.match(mergeOrder(map)[0].why, /oldest at that count/);
});

test('a draft is never ordered and never picked', () => {
  const map = mapOf([change('pr:1', { draft: true }), change('pr:2'), change('pr:3', { draft: true })]);
  assert.deepEqual(ids(map), ['pr:2']);
  assert.deepEqual(nextPick(mapOf([change('pr:1', { draft: true })])), null);
  assert.equal(nextPick(mapOf([])), null);
});

test('a change that conflicts with main waits behind the free ones, with a plain reason', () => {
  const map = mapOf([change('pr:1', { mainConflicts: ['src/a.ts', 'src/b.ts'] }), change('pr:2')]);
  assert.deepEqual(ids(map), ['pr:2', 'pr:1']);
  const blocked = mergeOrder(map)[1];
  assert.match(blocked.why, /conflicts with main in 2 files now, so it needs a rebuild/);
});

test('a change that moves and also conflicts with main still goes first, alone', () => {
  const map = mapOf([change('pr:1'), change('pr:2', { moves: ['src/old.ts'], mainConflicts: ['src/a.ts'] })], [pair('pr:1', 'pr:2')]);
  assert.deepEqual(ids(map), ['pr:2', 'pr:1']);
});

test('every reason is one plain line with no full stop at the end', () => {
  const map = mapOf([change('pr:1'), change('pr:2'), change('pr:3', { moves: ['src/old.ts'] }), change('pr:4')], [pair('pr:1', 'pr:4')]);
  for (const pick of mergeOrder(map)) {
    assert.ok(pick.why.length > 0);
    assert.ok(!pick.why.includes('\n'));
    assert.ok(!pick.why.endsWith('.'));
  }
});

test('listPullRequests keeps the merge order and leaves out local branches', () => {
  const map = mapOf([change('branch:older'), change('pr:5'), change('pr:7')], [pair('pr:5', 'pr:7')]);
  assert.deepEqual(ids(map), ['branch:older', 'pr:5', 'pr:7']);
  assert.deepEqual(listPullRequests(map), [5, 7]);
});

test('the map is built again before the next pick, so a change may collide with nothing then', () => {
  const before = mapOf([change('pr:1'), change('pr:2'), change('pr:3')], [pair('pr:1', 'pr:2'), pair('pr:2', 'pr:3')]);
  assert.deepEqual(ids(before), ['pr:2', 'pr:1', 'pr:3']);
  // pr:2 is merged; the map is built again without it, and the two left collide with nothing.
  const after = mapOf([change('pr:1'), change('pr:3')]);
  assert.deepEqual(ids(after), ['pr:1', 'pr:3']);
});

test('train --next prints the next pick in one line and merges nothing', () => {
  const sandbox = makeSandbox();
  const map = mapOf([change('pr:12'), change('pr:9', { moves: ['src/old.ts'] })]);
  sandbox.write('.git/yokoten/conflicts.json', JSON.stringify({ ...map, builtAt: new Date().toISOString() }));
  const result = sandbox.run(['train', '--next']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim().split('\n').length, 1);
  assert.match(result.stdout, /next is PR #9: it moves or deletes 1 file, so it goes first and alone/);
});

test('train --next refuses plainly when the map is missing', () => {
  const sandbox = makeSandbox();
  const result = sandbox.run(['train', '--next']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no conflict map at yokoten\/conflicts\.json in this clone; run `yokoten conflicts` first/);
});

test('train refuses a map more than an hour old: it names changes that merged since', () => {
  const sandbox = makeSandbox();
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  sandbox.write('.git/yokoten/conflicts.json', JSON.stringify({ ...mapOf([change('pr:12')]), builtAt: old }));
  const result = sandbox.run(['train', '--next']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /more than an hour old; run `yokoten conflicts` again/);
});

/** A gh on PATH that logs each call and answers none, so any read or merge shows in the log. */
function loggingGh(sandbox: ReturnType<typeof makeSandbox>): { extra: Record<string, string>; calls: () => string[] } {
  const bin = join(sandbox.home, 'bin');
  const log = join(sandbox.home, 'gh.log');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node\nimport('node:fs').then(({ appendFileSync }) => { appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n'); process.exit(1); });\n`, { mode: 0o755 });
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
  return { extra: { PATH: `${bin}${delimiter}${process.env.PATH}` }, calls };
}

// #1042: a bare command only reads. Bare train prints the plan and merges nothing.
test('bare train prints the plan with its order, says nothing merged, and calls no gh', async () => {
  const sandbox = makeSandbox();
  const map = mapOf([change('pr:12'), change('pr:9', { moves: ['src/old.ts'] }), change('branch:local'), change('pr:5')], [pair('pr:12', 'pr:5')]);
  sandbox.write('.git/yokoten/conflicts.json', JSON.stringify({ ...map, builtAt: new Date().toISOString() }));
  const gh = loggingGh(sandbox);
  const result = await sandbox.call(['train'], { extra: gh.extra });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^yokoten train · the plan for 3 pull requests; nothing merged\n/);
  assert.match(result.stdout, /next {8}PR #9: it moves or deletes 1 file/);
  assert.match(result.stdout, /Order: #9 → #12 → #5/);
  assert.match(result.stdout, /Merge: name them in this order, as in `yokoten train 9 12`/);
  assert.doesNotMatch(result.stdout, /branch local|merged \d/);
  assert.deepEqual(gh.calls(), [], 'a bare train makes no gh call, so no merge call');
});

test('bare train folds a long queue so the plan fits one screen', async () => {
  const sandbox = makeSandbox();
  const changes = Array.from({ length: 30 }, (_, index) => change(`pr:${index + 1}`));
  sandbox.write('.git/yokoten/conflicts.json', JSON.stringify({ ...mapOf(changes), builtAt: new Date().toISOString() }));
  const result = await sandbox.call(['train']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /22 more pull requests, in the order below/);
  assert.ok(result.stdout.split('\n').length <= 24, result.stdout);
  for (const line of result.stdout.split('\n')) assert.ok(line.length <= 80, `over 80: ${line}`);
});

test('train with no numbers merges nothing even with a bot set up: the bare command never merges', async () => {
  const sandbox = makeSandbox();
  sandbox.write('.git/yokoten/conflicts.json', JSON.stringify({ ...mapOf([change('pr:7')]), builtAt: new Date().toISOString() }));
  const gh = loggingGh(sandbox);
  const result = await sandbox.call(['train', '--wait', '60'], { extra: { ...gh.extra, YOKOTEN_BOT_APP_ID: '1' } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /nothing merged/);
  assert.doesNotMatch(result.stdout, /merged \d+ of/);
  assert.deepEqual(gh.calls(), []);
});
