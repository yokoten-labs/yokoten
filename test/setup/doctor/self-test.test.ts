// Tests for src/setup/doctor/self-test.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { unsavedNotes } from '../../../src/setup/advice/unsaved.ts';
import { guardControl, isShellControlCaught, isUnsavedControlCaught, NO_TEMP, noTempLine, openCodeControl, sandboxControl, selfTest, selfTestRun } from '../../../src/setup/doctor/index.ts';

test('self-test: the sandbox control passes the real checks and fails broken ones (#589)', () => {
  assert.deepEqual(sandboxControl(), []);
  assert.ok(!selfTest().some((name) => name.toLowerCase().includes('sandbox')));
  const passAll = () => null;
  assert.deepEqual(sandboxControl(passAll, passAll, passAll, passAll), ['Claude Code sandbox check', 'Codex sandbox check', 'Gemini CLI sandbox check', 'Grok sandbox check'], 'checks that pass everything');
  const failAll = () => ({ what: 'broken', fix: 'fix it' });
  assert.deepEqual(sandboxControl(failAll, failAll, failAll, failAll), ['sandbox check (a good set passes)'], 'checks that fail everything');
});

test('doctor self-test: the unsaved-work check must name every kind, and a broken one is caught (#365)', () => {
  assert.equal(isUnsavedControlCaught(), true);
  assert.equal(isUnsavedControlCaught(() => []), false, 'a check that finds nothing');
  const deletesWhenUnsure: Parameters<typeof isUnsavedControlCaught>[0] = (facts, options) =>
    unsavedNotes(facts, options).map((f) => (f.id === 'stale-index-lock' ? { ...f, fix: 'delete it' } : f));
  assert.equal(isUnsavedControlCaught(deletesWhenUnsure), false, "a check that says to delete a lock it can't judge");
  assert.ok(!selfTest().includes('unsaved work check'));
});

test('self-test: a shell write from the plugin agent yokoten:worker is caught, and the lead passes (#402)', () => {
  assert.ok(isShellControlCaught());
  assert.ok(!selfTest().includes('lead-only shell guard'));
});

test('self-test: a control with no temp folder says it could not set up, and a failing check is still BROKEN (#1108)', () => {
  const full = () => { throw new Error('ENOSPC: no space left on device'); };
  // No temp folder: the control did not run, which is not a check that failed.
  assert.deepEqual(guardControl(full), [NO_TEMP]);
  assert.deepEqual(openCodeControl(full), [NO_TEMP]);
  const run = selfTestRun(full);
  assert.deepEqual(run.unset, ['user guard check', 'OpenCode plugin note']);
  assert.ok(!run.failed.some((name) => /user guard|OpenCode/.test(name)), 'no BROKEN name for a control that did not run');
  // A real temp folder with a check that passes everything: still a failure.
  assert.deepEqual(guardControl(undefined, () => []), ['user guard check']);
  assert.deepEqual(openCodeControl(undefined, () => null), ['OpenCode plugin note']);
  // Positive control: the real checks pass with a real temp folder.
  assert.deepEqual(guardControl(), []);
  assert.deepEqual(openCodeControl(), []);
  assert.deepEqual(selfTestRun().unset, []);
});

test('self-test: the no-temp line names the controls and the fix, with home shown as ~ (#1108)', () => {
  const cases: [NodeJS.Platform, string, string | null, string][] = [
    ['linux', '/home/a/tmp', '/home/a', '(~/tmp)'],
    ['linux', '/tmp', '/home/a', '(/tmp)'],
    ['linux', '/home/ab/tmp', '/home/a', '(/home/ab/tmp)'],
    ['darwin', '/Users/a/tmp', '/Users/a', '(~/tmp)'],
    ['win32', 'C:\\Users\\a\\AppData\\Local\\Temp', 'C:\\Users\\a', '(~\\AppData\\Local\\Temp)'],
    ['linux', '/tmp', null, '(/tmp)'],
  ];
  for (const [platform, temp, home, shown] of cases) {
    const line = noTempLine(['user guard check'], temp, home, platform);
    assert.ok(line.includes(shown), `${platform} ${temp}: ${line}`);
    assert.ok(line.includes('free space in the temp folder'), line);
    assert.ok(!line.includes('BROKEN'), line);
  }
});

