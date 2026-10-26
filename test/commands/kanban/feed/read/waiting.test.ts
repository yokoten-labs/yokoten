// Tests for src/commands/kanban/feed/read/waiting.ts.

import '../../../../repo/home.ts';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeTempDir } from '../../../../repo/helpers.ts';
import { type BoardWaiting, collectBoardWaiting, readBoardAttention, readBoardIssues, scheduleOf } from '../../../../../src/commands/kanban/feed/read/waiting.ts';
import { EMPTY_DESK } from '../../../../../src/commands/kanban/feed/read/desk.ts';
import { type AgentView, vendorOf } from '../../../../../src/commands/kanban/view.ts';
import type { Gh } from '../../../../../src/host/github/index.ts';

const agent = (fields: Partial<AgentView>): AgentView => ({ key: '', name: 'a', nickname: '', isMain: false, vendor: vendorOf(''), model: '', effort: '', role: '', dot: 'idle', task: '', title: '', ref: null, doing: '', checks: '', age: '', updated: '', started: '', branch: '', ...fields });

// #603: the open issues as rows, or why gh cannot read them.
test('board waiting: the open issues', () => {
  const gh: Gh = () => JSON.stringify([{ number: 603, title: 'board agents', url: 'https://example.com/i/603', body: 'Depends on #601.', createdAt: '2026-10-22T10:00:00Z', updatedAt: '2026-10-22T11:00:00Z', labels: [{ name: 'privacy' }, { name: 'tier A' }, 'odd'], milestone: { title: 'First release' } }, { number: 'x' }, null]);
  assert.deepEqual(readBoardIssues(gh, 'octo/demo'), [{ number: 603, title: 'board agents', url: 'https://example.com/i/603', createdAt: '2026-10-22T10:00:00Z', updatedAt: '2026-10-22T11:00:00Z', dependsOn: [601], labels: ['privacy', 'tier A'], milestone: 'First release' }]);
  assert.equal(readBoardIssues(() => { throw new Error('no net'); }, 'octo/demo'), 'gh could not list the open issues: run it again');
  assert.equal(readBoardIssues(() => 'oops', 'octo/demo'), 'gh gave no open issue list: run it again');
});

// #603: the attention comes from the status files; a missing, broken, or quiet file is skipped.
test('board waiting: the attention in the status files', () => {
  const folder = makeTempDir();
  const trees = [{ path: folder, branch: 'main' }];
  assert.deepEqual(readBoardAttention(trees), [], 'no file, no hold-up');
  writeFileSync(join(folder, '.yokoten-agent.json'), '{oops');
  assert.deepEqual(readBoardAttention(trees), [], 'a broken file is skipped');
  writeFileSync(join(folder, '.yokoten-agent.json'), JSON.stringify({ name: 'w', role: 'reviewer', updated: '2026-10-22T10:00:00Z', doing: 'fine' }));
  assert.deepEqual(readBoardAttention(trees), [], 'a quiet file is skipped');
  writeFileSync(join(folder, '.yokoten-agent.json'), JSON.stringify({ name: 'w', role: 'reviewer', updated: '2026-10-22T10:00:00Z', blocked: 'the guard stopped it\nsecond line', question: 'which one?', link: 'javascript:alert(1)' }));
  assert.deepEqual(readBoardAttention(trees), [
    { name: 'w', vendor: '', role: 'reviewer', worktree: '', updated: '2026-10-22T10:00:00Z', kind: 'guard', why: 'the guard stopped it', link: '' },
    { name: 'w', vendor: '', role: 'reviewer', worktree: '', updated: '2026-10-22T10:00:00Z', kind: 'question', why: 'which one?', link: '' },
  ], 'one line each, and no odd link');
});

// #603: the waiting list latches an agent row while the agent is here, and drops it
// when it leaves; Approve rows follow the pulls.
test('board waiting: the waiting list latches while the agent is here', () => {
  const board = { repo: 'r', repoName: 'r', repoUrl: '', desk: EMPTY_DESK, agents: [agent({ key: 'p', name: 'w', role: 'engineer', updated: '2026-10-22T10:00:00Z', branch: 'main' })], needs: [], pulls: [], merged: [], worktrees: [{ path: 'p', branch: 'main' }], updated: '' };
  const held = [{ name: 'w', vendor: '', role: 'engineer' as const, worktree: 'p', updated: '2026-10-22T10:00:00Z', kind: 'guard' as const, why: 'the guard stopped it', link: '' }];
  const seen: BoardWaiting[] = [];
  assert.deepEqual(collectBoardWaiting(board, held, [], seen).map((row) => row.kind), ['guard']);
  assert.deepEqual(collectBoardWaiting(board, [], [], seen).map((row) => row.kind), ['guard'], 'a quiet file clears nothing');
  assert.deepEqual(collectBoardWaiting({ ...board, agents: [] }, [], [], seen), [], 'leaving clears it');
});

// #603 re-inspection (LOW): a waiting row counted from the agent's last write, so a
// rewrite reset the wait. The wait counts from when the row first showed instead.
test('board waiting: the wait counts from when the row first showed', () => {
  const board = { repo: 'r', repoName: 'r', repoUrl: '', desk: EMPTY_DESK, agents: [agent({ key: 'p', name: 'w', role: 'engineer', updated: '2026-10-22T10:00:00Z', branch: 'main' })], needs: [], pulls: [], merged: [], worktrees: [{ path: 'p', branch: 'main' }], updated: '' };
  const seen: BoardWaiting[] = [];
  const at = Date.parse('2026-10-22T10:00:00Z');
  const held = (updated: string) => [{ name: 'w', vendor: '', role: 'engineer' as const, worktree: 'p', updated, kind: 'guard' as const, why: 'the guard stopped it', link: '' }];
  assert.deepEqual(collectBoardWaiting(board, held('2026-10-22T10:00:00Z'), [], seen, at).map((row) => row.wait), ['just now'], 'first seen');
  // The agent rewrites every minute; ten minutes later the wait is ten minutes.
  const later = collectBoardWaiting(board, held('2026-10-22T10:09:00Z'), [], seen, at + 10 * 60 * 1000);
  assert.deepEqual(later.map((row) => row.wait), ['10 min ago'], 'the rewrite resets nothing');
});

// #709: a list longer than the board's limit is cut off, so a missing dependency could
// look closed. A list at the limit may be complete, so it plans.
test('board waiting: only a cut-off issue list plans nothing', () => {
  assert.deepEqual(scheduleOf('reading GitHub…'), { ready: [], order: [], cycles: [], blocked: [], criticalPath: [] });
  const atLimit = Array.from({ length: 30 }, (_, at) => ({ number: at + 1, title: `${at + 1}`, url: '', createdAt: '', updatedAt: '', dependsOn: at ? [at] : [] }));
  assert.deepEqual(scheduleOf(atLimit).order, Array.from({ length: 30 }, (_, at) => at + 1), 'a complete list at the limit plans every issue');
  const cutOff = [...atLimit, { number: 31, title: '31', url: '', createdAt: '', updatedAt: '', dependsOn: [] }];
  assert.deepEqual(scheduleOf(cutOff), { ready: [], order: [], cycles: [], blocked: [], criticalPath: [] }, 'one issue past the limit proves the list was cut');
});
