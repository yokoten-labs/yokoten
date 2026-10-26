// Tests for src/commands/desk/stall.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeTempDir } from '../../repo/helpers.ts';
import { isStalled, isWaiting, lastActivity, STALL_MINUTES, watchDesk } from '../../../src/commands/desk/stall.ts';

const MINUTE = 60_000;

test('desk stall: quiet for STALL_MINUTES and alive is a stall; waiting on CI is not (#1056)', () => {
  const now = Date.parse('2026-10-26T12:00:00Z');
  assert.equal(isStalled(now - STALL_MINUTES * MINUTE, now, false), true);
  assert.equal(isStalled(now - (STALL_MINUTES - 1) * MINUTE, now, false), false);
  assert.equal(isStalled(now - 90 * MINUTE, now, true), false, 'waiting is not a stall');
  const desk = makeTempDir();
  assert.equal(isWaiting(desk), false);
  writeFileSync(join(desk, '.yokoten-agent.json'), JSON.stringify({ state: 'working', doing: 'gh run watch 123' }));
  assert.equal(isWaiting(desk), true);
  writeFileSync(join(desk, '.yokoten-agent.json'), JSON.stringify({ state: 'waiting' }));
  assert.equal(isWaiting(desk), true);
  // The positive control: plain work is not waiting.
  writeFileSync(join(desk, '.yokoten-agent.json'), JSON.stringify({ state: 'working', doing: 'npm test' }));
  assert.equal(isWaiting(desk), false);
});

test('desk stall: the newest of the status file, git and the session logs is the last activity (#1056)', () => {
  const desk = makeTempDir();
  const state = `${desk}.state`;
  mkdirSync(join(desk, '.git', 'logs'), { recursive: true });
  mkdirSync(join(state, 'claude-code', 'projects'), { recursive: true });
  const at = (path: string, iso: string) => {
    writeFileSync(path, 'x');
    utimesSync(path, new Date(iso), new Date(iso));
  };
  at(join(desk, '.git', 'logs', 'HEAD'), '2026-10-26T10:00:00Z');
  at(join(desk, '.yokoten-agent.json'), '2026-10-26T10:05:00Z');
  // The folders themselves are old: only what is in them counts.
  const oldFolders = () => {
    for (const folder of [join(state, 'claude-code', 'projects'), join(state, 'claude-code')]) utimesSync(folder, new Date('2026-10-26T09:00:00Z'), new Date('2026-10-26T09:00:00Z'));
  };
  oldFolders();
  assert.equal(lastActivity(desk, state), Date.parse('2026-10-26T10:05:00Z'));
  at(join(state, 'claude-code', 'projects', 'session.jsonl'), '2026-10-26T11:00:00Z');
  oldFolders();
  assert.equal(lastActivity(desk, state), Date.parse('2026-10-26T11:00:00Z'), 'output in a session log counts');
});

test('desk stall: the watcher says once when the desk stalls, and once when it works again (#1056)', async () => {
  let now = 0;
  let activity = 0;
  const changes: string[] = [];
  const stop = watchDesk({ activity: () => activity, waiting: () => false, now: () => now, onChange: (state) => changes.push(state) }, 5);
  const wait = () => new Promise((resolve) => setTimeout(resolve, 20));
  await wait();
  now = 30 * MINUTE;
  await wait();
  await wait();
  activity = now;
  await wait();
  stop();
  now = 90 * MINUTE;
  await wait();
  assert.deepEqual(changes, ['stalled', 'working']);
});
