// Tests for src/setup/doctor/lessons.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { coreRulesCheck, coreRulesControl, formatLessonChecks, selfTest } from '../../../src/setup/doctor/index.ts';

test('a lesson that finds ten places with one reason says it once, with three places and +7 more (#946)', () => {
  const findings = Array.from({ length: 10 }, (_, i) => ({
    id: 'incident-138',
    what: `test/place-${i}.test.ts: a test calls a server on this machine and does not set NO_PROXY`,
    why: 'a proxy can answer for the server the test means to reach',
    fix: 'set NO_PROXY and no_proxy to 127.0.0.1,localhost while the test runs, then put the old values back',
  }));
  const lines = formatLessonChecks([{ id: 'incident-138', mark: 'note', findings }]);
  assert.deepEqual(lines, [
    '  note    lesson incident-138: a test calls a server on this machine and does not set NO_PROXY: test/place-0.test.ts, test/place-1.test.ts, test/place-2.test.ts, +7 more (`yokoten doctor --json`); set NO_PROXY and no_proxy to 127.0.0.1,localhost while the test runs, then put the old values back',
  ]);
  // A different reason, or a finding with no place, keeps its own line.
  assert.equal(formatLessonChecks([{ id: 'incident-1', mark: 'note', findings: [findings[0]!, { ...findings[1]!, what: 'test/other.ts: another reason' }] }]).length, 2);
  assert.equal(formatLessonChecks([{ id: 'incident-1', mark: 'note', findings: [{ ...findings[0]!, what: 'no place here' }] }]).length, 1);
});


test('self-test: the core-rules control passes the real check and fails a broken one (#170)', () => {
  assert.deepEqual(coreRulesControl(), []);
  assert.ok(!selfTest().some((name) => name.startsWith('core rules')));
  const always = (mark: 'ok' | 'MISSING' | 'note') => (root: string) => ({ mark, finding: { ...coreRulesCheck(root)!.finding } });
  assert.deepEqual(coreRulesControl(always('ok')), ['core rules check (edited by hand)', 'core rules check (newer kit)'], 'a check that passes everything');
  assert.deepEqual(coreRulesControl(always('MISSING')), ['core rules check (newer kit)'], 'a check that calls a newer kit MISSING');
  assert.deepEqual(coreRulesControl(always('note')), ['core rules check (edited by hand)'], 'a check that only gives notes');
  // A compare that never sees a version: the newer kit looks hand-edited, so MISSING.
  const noVersion = (root: string) => {
    const result = coreRulesCheck(root)!;
    return result.mark === 'note' ? { mark: 'MISSING' as const, finding: result.finding } : result;
  };
  assert.deepEqual(coreRulesControl(noVersion), ['core rules check (newer kit)']);
});
