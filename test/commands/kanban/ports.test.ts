// Tests for src/commands/kanban/ports.ts: the ports that do more than pass a call on keep
// the answer the old code gave. tsc checks that each kanban shape fits the old one.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type ActionsRun, branchHealth, emptySchedule, refusalOf, scheduleOfIssues } from '../../../src/commands/kanban/ports.ts';
import { summarizeActionsHealth } from '../../../src/commands/more/check.ts';

const run = (fields: Partial<ActionsRun>): ActionsRun => ({ id: 1, workflow: 'CI', event: 'push', branch: 'main', status: 'completed', conclusion: 'success', createdAt: '2026-10-26T10:00:00Z', startedAt: '2026-10-26T10:00:00Z', updatedAt: '2026-10-26T10:05:00Z', url: '', ...fields });

test('branchHealth: the failing runs and the unstable workflows are the ci-health summary\'s (#1091)', () => {
  const runs = [
    run({ id: 4, conclusion: 'failure', createdAt: '2026-10-26T12:00:00Z' }),
    run({ id: 3, conclusion: 'success', createdAt: '2026-10-26T11:00:00Z' }),
    run({ id: 2, workflow: 'Lint', conclusion: 'success' }),
    run({ id: 1, branch: 'topic', conclusion: 'failure' }),
  ];
  const summary = summarizeActionsHealth(runs, [], 'main');
  const health = branchHealth(runs, 'main');
  assert.deepEqual(health.failedIds, summary.mainFailures.map((one) => one.id));
  assert.deepEqual(health.unstable, summary.unstable.map(({ workflow, branch }) => ({ workflow, branch })));
  assert.deepEqual(health.failedIds, [4], 'the planted failure on main is found');
  assert.deepEqual(health.unstable, [{ workflow: 'CI', branch: 'main' }], 'a workflow that passed and failed on main is unstable');
});

test('scheduleOfIssues: issues come back as numbers, a dependency first; emptySchedule is a new one each time (#1091)', () => {
  const schedule = scheduleOfIssues([
    { number: 2, title: 'second', dependsOn: [1] },
    { number: 1, title: 'first' },
  ]);
  assert.deepEqual(schedule, { ready: [1], order: [1, 2], cycles: [], blocked: [], criticalPath: [1, 2] });
  assert.notStrictEqual(emptySchedule(), emptySchedule());
  assert.deepEqual(emptySchedule(), { ready: [], order: [], cycles: [], blocked: [], criticalPath: [] }, 'the empty schedule has nothing in it');
});

test('refusalOf: a printed refusal comes back by its parts, and other text gives null (#1091)', () => {
  const text = ['yokoten stopped this: a push [no-push]', '', '  Why       A push skips review.', '  Instead   Ask the lead.', '  More      https://example.com/docs'].join('\n');
  assert.deepEqual(refusalOf(text), { id: 'no-push', title: 'yokoten stopped this: a push [no-push]', why: 'A push skips review.', fix: 'Ask the lead.', docs: 'https://example.com/docs' });
  assert.equal(refusalOf('nothing to see'), null);
});
