// Tests for src/commands/desk/list.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeTempDir } from '../../repo/helpers.ts';
import { ago, type DeskRecord, deskListOf, isAlive, listScreen, readRecord, readRecords, stateNow, writeRecord } from '../../../src/commands/desk/list.ts';

const NOW = new Date('2026-10-26T12:00:00Z');
const record = (name: string, state: DeskRecord['state'], pid = 7): DeskRecord => ({
  name, task: { kind: 'issue', number: Number(name), title: `task ${name}` }, agent: 'claude-code', branch: `desk/${name}`, base: 'abc', pid,
  startedAt: '2026-10-26T10:00:00Z', activeAt: '2026-10-26T11:00:00Z', state,
});

test('desk records: written whole, read back by name; a broken file is skipped (#1056)', () => {
  const home = makeTempDir();
  writeRecord(home, record('2', 'kept'));
  writeRecord(home, record('10', 'working'));
  writeFileSync(join(home, 'broken.json'), '{');
  assert.deepEqual(readRecords(home).map((one) => one.name), ['2', '10']);
  assert.equal(readRecord(home, '10')?.state, 'working');
  assert.equal(readRecord(home, 'broken'), null);
  assert.ok(!readdirSync(home).some((file) => file.endsWith('.new')));
  assert.deepEqual(readRecords(join(home, 'none')), []);
});

test('desk records: a working or stalled desk whose process is gone stopped mid-task (#1056)', () => {
  const dead = () => false;
  assert.equal(stateNow(record('1', 'working'), dead), 'stopped');
  assert.equal(stateNow(record('1', 'stalled'), dead), 'stopped');
  assert.equal(stateNow(record('1', 'stalled'), () => true), 'stalled');
  assert.equal(stateNow(record('1', 'kept'), dead), 'kept');
  assert.equal(isAlive(process.pid), true);
  assert.equal(ago('2026-10-26T11:30:00Z', NOW), '30 min');
  assert.equal(ago('2026-10-26T09:00:00Z', NOW), '3 h');
  assert.equal(ago('2026-10-20T12:00:00Z', NOW), '6 days');
});

test('desk list: none is one next step; a stopped desk is named first, with what it did (#1054, #1056)', () => {
  assert.deepEqual(listScreen(deskListOf([], () => true, () => []), NOW), ['yokoten desk · no desks yet', '', 'A desk gives one task to one AI, in its own fenced clone.', '', 'Next: `yokoten desk <issue>`']);
  const screen = listScreen(deskListOf([record('3', 'kept'), record('4', 'working')], (pid) => pid !== 7, (one) => (one.name === '4' ? ['f00 fix: half'] : [])), NOW).join('\n');
  assert.match(screen, /^yokoten desk · 2 desks, 1 stopped mid-task\n/);
  assert.match(screen.replace(/\s+/g, ' '), /ok desk 3 ended, work kept · claude-code · task 3 · no commits yet/);
  assert.match(screen.replace(/\s+/g, ' '), /note desk 4 stopped 1 h ago · claude-code · task 4 · 1 commit, last: f00 fix: half/);
  assert.match(screen, /Next: `yokoten desk 4`$/);
  const kept = listScreen(deskListOf([record('3', 'kept')], () => true, () => []), NOW);
  assert.equal(kept.at(-1), 'Next: `yokoten desk 3 --pr`');
  for (const line of screen.split('\n')) assert.ok(line.length <= 80, line);
});

test('desk list: the screen is built from the same facts --json prints, with no process id or base (#1115)', () => {
  const list = deskListOf([record('3', 'kept'), { ...record('4', 'working'), pushed: 'abc1234' }], (pid) => pid !== 7, () => ['f00 fix: half']);
  assert.deepEqual(list.desks.map((desk) => [desk.name, desk.state, desk.commits]), [['3', 'kept', ['f00 fix: half']], ['4', 'stopped', ['f00 fix: half']]]);
  assert.ok(list.desks.every((desk) => !('pid' in desk) && !('base' in desk)));
  assert.equal(list.desks[1]?.pushed, 'abc1234');
  assert.deepEqual(listScreen(list, NOW), listScreen(JSON.parse(JSON.stringify(list)), NOW), 'the data alone makes the screen');
});
