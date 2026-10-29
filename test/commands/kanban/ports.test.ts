// Tests for src/commands/kanban/ports.ts: the ports that do more than pass a call on keep
// the answer the old code gave. tsc checks that each kanban shape fits the old one.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RowMark } from '../../../src/rules/text/screen.ts';
import { type ActionsRun, branchHealth, emptySchedule, hideHomeIn, privateMask, refusalOf, type RowState, scheduleOfIssues } from '../../../src/commands/kanban/ports.ts';
import { makeTempDir } from '../../repo/helpers.ts';
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

// #1237: the board shows desk paths and agent streams through these two; a users-folder name that is not HOME goes too.
test('privateMask and hideHomeIn: the user name in any users-folder path is hidden, whatever HOME is (#1237)', () => {
  const home = makeTempDir('yokoten-kanban-mask-');
  const env = { HOME: home };
  const text = 'desk at C:\\Users\\alice\\wt and /mnt/c/Users/alice/wt';
  const shown = 'desk at C:\\Users\\<user>\\wt and /mnt/c/Users/<user>/wt';
  assert.equal(privateMask(env, home)(text), shown);
  assert.equal(hideHomeIn(text, env), shown);
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

// tsc checks both ways: a RowState is a layout RowMark and a RowMark is a RowState, so the port cannot drift from the layout.
test('RowState: the port keeps its own name for the layout\'s row marks', () => {
  const marks: RowMark[] = ['ok', 'done', 'next', 'to do', 'MISSING', 'note', "can't check", 'skipped'];
  const states: RowState[] = marks;
  const back: RowMark[] = states;
  assert.deepEqual(back, marks);
});
