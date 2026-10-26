// Tests for src/commands/desk/brief.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { briefText, readIssue, readTaskWord, taskName, textTask } from '../../../src/commands/desk/brief.ts';

test('desk brief: a number is an issue, words are a task, anything else is neither (#1054)', () => {
  assert.deepEqual(readTaskWord('14'), { number: 14 });
  assert.deepEqual(readTaskWord('#14'), { number: 14 });
  assert.deepEqual(readTaskWord('fix the typo'), { text: 'fix the typo' });
  assert.equal(readTaskWord('..'), null);
  assert.equal(taskName('Fix the README typo, please!'), 'fix-the-readme-typo-please');
  assert.equal(taskName('a'.repeat(40)), 'a'.repeat(30));
  assert.equal(taskName('!!!'), 'task');
  assert.deepEqual(textTask('fix the typo'), { kind: 'text', title: 'fix the typo', body: '', name: 'fix-the-typo' });
});

test('desk brief: the issue through gh; no gh login is one line that says what to do (#1054)', () => {
  const asked: string[] = [];
  const good = readIssue(14, (file, args) => {
    asked.push([file, ...args].join(' '));
    return { status: 0, stdout: JSON.stringify({ number: 14, title: 'fix the greeting', body: 'Say hello.' }), stderr: '' };
  }, '/repo');
  assert.deepEqual(asked, ['gh issue view 14 --json number,title,body']);
  assert.deepEqual(good, { kind: 'issue', number: 14, title: 'fix the greeting', body: 'Say hello.', name: '14' });
  const bad = readIssue(14, () => ({ status: 1, stdout: '', stderr: 'gh auth login' }), '/repo');
  assert.deepEqual(bad, { problem: 'can\'t read issue #14 with gh. Run `gh auth login`, or give the task in quotes: yokoten desk "fix the typo".' });
  assert.deepEqual(readIssue(14, () => ({ status: 0, stdout: 'not json', stderr: '' }), '/repo'), { problem: 'gh gave no issue #14.' });
});

test('desk brief: the task, then how to work: commit as you go, never push; a resume adds what was done (#1054, #1056)', () => {
  const task = { kind: 'issue' as const, number: 14, title: 'fix the greeting', body: 'Say hello.', name: '14' };
  const brief = briefText(task, 'desk/14');
  assert.match(brief, /^Issue #14: fix the greeting\n\nSay hello\.\n\n## How to work in this desk\n/);
  assert.match(brief, /on the branch desk\/14/);
  assert.match(brief, /Commit each small step/);
  assert.match(brief, /Never push and never open a pull request/);
  assert.doesNotMatch(brief, /Done so far/);
  assert.match(briefText(task, 'desk/14', ['abc1234 fix: say hello']), /## Done so far \(you stopped; go on from here\)\n\n- abc1234 fix: say hello\n$/);
  assert.match(briefText(textTask('fix the typo'), 'desk/fix-the-typo'), /^Task: fix the typo\n\n## How/);
});
