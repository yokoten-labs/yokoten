// Tests for src/commands/tidy/stale.ts: the case table (issue #1055).

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IN_USE_MS, judgeStale, LOG_AGE_MS, QUIET_MS, type StaleFacts, type StaleVerdict } from '../../../src/commands/tidy/stale.ts';

const NOW = Date.parse('2026-10-26T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const quiet: StaleFacts = { kind: 'branch', isHere: false, hasProcess: false, isLocked: false, lastWrite: NOW - 2 * DAY, isMerged: false, isUpstreamGone: false, isGone: false, unpushed: 0, isDirty: false };

// One row a case: what is true, and the verdict. The in-use rows come first, as in the rule.
const CASES: [string, Partial<StaleFacts>, StaleVerdict, RegExp][] = [
  ['the checkout tidy runs in, merged', { kind: 'worktree', isHere: true, isMerged: true }, 'in-use', /tidy runs inside it/],
  ['a desk with a program in it, its branch gone', { kind: 'desk', hasProcess: true, isUpstreamGone: true }, 'in-use', /a program is running/],
  ['a worktree git keeps a lock on, its folder gone', { kind: 'worktree', isLocked: true, isGone: true }, 'in-use', /lock/],
  ['a merged desk written to 5 minutes ago', { kind: 'desk', isMerged: true, lastWrite: NOW - 5 * 60_000 }, 'in-use', /changed 5 min ago/],
  ['a gone desk\'s logs written to 14 minutes ago', { kind: 'log', isGone: true, lastWrite: NOW - IN_USE_MS + 60_000 }, 'in-use', /14 min ago/],
  ['a merged branch, quiet for two days', { isMerged: true }, 'old', /^merged into the main branch, and no change for a day$/],
  ['a merged branch made 2 hours ago: a new branch starts at main too', { isMerged: true, lastWrite: NOW - 2 * 60 * 60_000 }, 'keep', /still in work/],
  ['a branch whose remote branch is gone', { isUpstreamGone: true }, 'old', /^its branch on the remote is gone$/],
  ['a squash-merged branch: remote gone, its commits on no remote', { isUpstreamGone: true, unpushed: 3 }, 'keep-first', /gone, but 3 commits on no remote$/],
  ['an unmerged branch nobody touched for a year', { lastWrite: NOW - 365 * DAY, unpushed: 4 }, 'keep', /still in work/],
  ['a branch with no reflog, merged', { isMerged: true, lastWrite: null }, 'old', /merged/],
  ['a worktree git lists whose folder is gone', { kind: 'worktree', isGone: true }, 'old', /folder is gone/],
  ['a merged worktree with changes not committed', { kind: 'worktree', isMerged: true, isDirty: true }, 'keep-first', /but changes not committed$/],
  ['a gone worktree branch, 1 commit and changes only here', { kind: 'worktree', isUpstreamGone: true, unpushed: 1, isDirty: true }, 'keep-first', /1 commit on no remote and changes not committed$/],
  ['an open worktree with changes', { kind: 'worktree', isDirty: true }, 'keep', /still in work/],
  ['a merged desk, clean, quiet just over a day', { kind: 'desk', isMerged: true, lastWrite: NOW - QUIET_MS - 1 }, 'old', /merged/],
  ['a merged desk, clean, 20 hours quiet', { kind: 'desk', isMerged: true, lastWrite: NOW - 20 * 60 * 60_000 }, 'keep', /still in work/],
  ['a desk with unpushed work and no sign', { kind: 'desk', unpushed: 2 }, 'keep', /still in work/],
  ['the logs of a gone desk', { kind: 'log', isGone: true }, 'old', /^its desk is gone$/],
  ['logs 30 days quiet, their desk still there', { kind: 'log', lastWrite: NOW - LOG_AGE_MS }, 'old', /30 days/],
  ['logs 29 days quiet, their desk still there', { kind: 'log', lastWrite: NOW - LOG_AGE_MS + DAY }, 'keep', /still in work/],
  ['a log is never "merged"', { kind: 'log', isMerged: true }, 'keep', /still in work/],
];

test('stale: each case of the table gets its verdict, and the why says the sign (#1055)', () => {
  for (const [name, facts, verdict, why] of CASES) {
    const judged = judgeStale({ ...quiet, ...facts }, NOW);
    assert.equal(judged.verdict, verdict, name);
    assert.match(judged.why, why, name);
  }
});

test('stale: in use wins over every sign of old, and "still in work" over age (#1055)', () => {
  // The positive control of the order: all signs of old at once, and one sign of use.
  const everything: Partial<StaleFacts> = { kind: 'desk', isMerged: true, isUpstreamGone: true, isGone: true, lastWrite: NOW - 400 * DAY };
  for (const use of [{ isHere: true }, { hasProcess: true }, { isLocked: true }, { lastWrite: NOW }]) {
    assert.equal(judgeStale({ ...quiet, ...everything, ...use }, NOW).verdict, 'in-use', JSON.stringify(use));
  }
  assert.equal(judgeStale({ ...quiet, ...everything }, NOW).verdict, 'old');
});
