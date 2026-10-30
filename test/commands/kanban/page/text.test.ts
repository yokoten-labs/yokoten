// Tests for src/commands/kanban/page/text.ts: the one renderer of `kanban --text`, from a KanbanState.

import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EMPTY_DESK } from '../../../../src/commands/kanban/feed/read/desk.ts';
import { renderBoardScreen } from '../../../../src/commands/kanban/page/text.ts';
import type { KanbanSession, KanbanState } from '../../../../src/commands/kanban/page/browser/types.ts';
import { healthReadFailed } from '../../../../src/commands/more/check.ts';
import { stateOf, type StateSources } from '../../../../src/commands/kanban/state.ts';
import { type AgentView, type BoardData } from '../../../../src/commands/kanban/view.ts';
import { screenProblems } from '../../../repo/docs/screen-rules.ts';

const NOW = Date.parse('2026-10-26T12:00:00Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60000).toISOString();
const board = (agents: AgentView[]): BoardData => ({ repo: '~/r', repoName: 'r', repoUrl: '', agents, needs: [], pulls: [], merged: [], worktrees: [], desk: EMPTY_DESK, updated: '' });
const NO_GITHUB: StateSources = { remote: null, pulls: 'no remote', runs: [], defaultBranch: 'main' };
const EMPTY: KanbanState = stateOf(board([]), { ...NO_GITHUB, pulls: [], runs: [] }, new Set(), NOW);
const session = (fields: Partial<KanbanSession>): KanbanSession => ({
  id: 'a', agent: 'Claude', model: 'opus', task: { kind: 'text', title: 'a task' }, state: 'working', startedAt: ago(30), updatedAt: ago(1),
  evidence: { fence: 'guard', commitCheck: 'none', platforms: [] }, cost: { tokens: 0, usd: null }, ...fields,
});

/** Every line of a screen is fine for the screen rules. */
const assertScreen = (lines: string[]) => assert.deepEqual(screenProblems({ text: `${lines.join('\n')}\n` }), [], lines.join('\n'));

test('kanban text: sessions in every group, pull requests and Actions, from the state', () => {
  const state: KanbanState = {
    ...EMPTY,
    repo: { name: 'repo', url: 'https://example.com/octo/repo' },
    sessions: [
      session({ id: '1', state: 'stuck', stuckMinutes: 20, task: { kind: 'issue', number: 3, title: 'a' } }),
      session({ id: '2', state: 'waiting', agent: 'Grok', model: '', waitingFor: 'an answer from you' }),
      session({ id: '3', task: { kind: 'text', title: 'b' } }),
      session({ id: '4', state: 'done', task: { kind: 'pr', number: 9, title: 'shipped' } }),
    ],
    pulls: [
      { number: 4, title: 't', url: '', author: '', waitsOnYou: true, notReadyBecause: [], checks: 'pass' },
      { number: 5, title: 'draft work', url: '', author: '', waitsOnYou: false, notReadyBecause: ['still a draft'], checks: 'none' },
      { number: 6, title: 'old', url: '', author: '', waitsOnYou: false, notReadyBecause: [], checks: 'pass', mergedAt: ago(60) },
    ],
    actions: { main: { state: 'fail', failingSince: ago(60) }, queuedOver15Min: [{ name: 'CI', minutes: 20, url: '' }], flaky: [{ name: 'Lint', passFailLast10: 'PFPF', url: '' }] },
  };
  const lines = renderBoardScreen(state);
  assert.equal(lines[0], 'yokoten kanban · repo: 4 sessions, 3 pull requests, read only');
  assert.deepEqual(lines.filter((line) => /^[A-Z][^:]*:$/.test(line)), ['Stuck:', 'Waiting for you:', 'Working:', 'Done:', 'Pull requests:', 'Actions:']);
  const text = lines.join('\n');
  assert.match(text, /MISSING\s+Claude\s+issue #3 a \(opus\), no output for 20 min/);
  assert.match(text, /next\s+Grok\s+a task, waits for an answer from you/);
  assert.match(text, /ok\s+Claude\s+PR #9 shipped \(opus\)/);
  assert.match(text, /next\s+PR #4\s+t: waits on you/);
  assert.match(text, /to do\s+PR #5\s+draft work: still a draft/);
  assert.match(text, /MISSING\s+main\s+failing since 2026-10-26 11:00 UTC/);
  assert.match(text, /to do\s+CI\s+waits for a runner, 20 min/);
  assert.match(text, /note\s+Lint\s+flaky: PFPF/);
  assert.equal(lines.at(-1), 'More: `yokoten kanban` opens the live page');
  assertScreen(lines);
});

test('kanban text: an empty board says how to start a session and that nothing waits', () => {
  const lines = renderBoardScreen(EMPTY, 'http://repo.localhost:4815/');
  assert.equal(lines[0], 'yokoten kanban · this repo: 0 sessions, 0 pull requests, read only');
  const text = lines.join('\n');
  assert.match(text, /Sessions:\n {2}none yet\. Start one with `yokoten desk`/);
  assert.match(text, /Pull requests:\n {2}none waits on you\./);
  assert.match(text, /Actions:\n {2}note\s+main\s+not read/);
  assert.doesNotMatch(text, /Not read:/);
  assert.equal(lines.at(-1), 'More: the live page at http://repo.localhost:4815/');
  assertScreen(lines);
});

test('kanban text: gh signed out says the cause once, with one Fix line (#1115)', () => {
  const signedOut = { stderr: 'To get started with GitHub CLI, please run:  gh auth login\n' };
  const state = { ...EMPTY, problems: [healthReadFailed(signedOut, 'pull requests'), healthReadFailed(signedOut, 'Actions runs')] };
  const lines = renderBoardScreen(state);
  assert.equal(lines.filter((line) => line.includes('Fix: `gh auth login`')).length, 1);
  assert.ok(lines.includes('Not read:'));
  assertScreen(lines);
});

test('kanban text: a long group folds, but stuck and waiting sessions are never folded', () => {
  const many = (state: KanbanSession['state']) => Array.from({ length: 7 }, (_, index) => session({ id: `${state}${index}`, state, task: { kind: 'text', title: `${state} ${index}` } }));
  const text = renderBoardScreen({ ...EMPTY, sessions: [...many('working'), ...many('stuck'), ...many('waiting')] }).join('\n');
  assert.match(text, /to do\s+2 more rows, all of them with `yokoten kanban --json`/);
  assert.equal(text.match(/stuck \d/g)?.length, 7);
  assert.equal(text.match(/waiting \d/g)?.length, 7);
});

// #603: agents write the status files, so --text never sends their control codes to the terminal.
test('kanban text: control and bidi characters in agent text show escaped', () => {
  const text = renderBoardScreen({ ...EMPTY, sessions: [session({ agent: 'bad\u001b]0;owned\u0007', task: { kind: 'text', title: 'x‮y' } })] }).join('\n');
  assert.ok(!/[\u001b\u0007‮]/.test(text), 'no raw control or bidi character');
  assert.match(text, /bad\\u001b/, 'the code shows as text');
});

test('kanban text: no line says the old name', () => {
  assert.doesNotMatch(renderBoardScreen(EMPTY).join('\n'), /yokoten board/);
});

// #1268: a name is never cut; one too long for the label field takes its own line, whole.
test('kanban text: a long agent name stands whole on its own line, and every text starts in one column', () => {
  const lines = renderBoardScreen({ ...EMPTY, sessions: [session({ id: '1', agent: 'Claude Code' }), session({ id: '2', agent: 'GitHub Copilot CLI' })] });
  assert.ok(lines.some((line) => /^ {2}note\s{9}Claude {6}a task/.test(line)), lines.join('\n'));
  const at = lines.findIndex((line) => /^ {2}note\s{9}GitHub Copilot CLI$/.test(line));
  assert.ok(at >= 0, lines.join('\n'));
  assert.match(lines[at + 1] ?? '', /^ {27}a task/, 'the text starts in the row text column, under the name');
  assert.ok(!lines.join('\n').includes('…'), 'no name is cut');
  assertScreen(lines);
});

// Known-bad input: the label-alone line is the only exception; a row whose text truly starts in
// another column is still caught.
test('screen rules: a label alone on its line starts no column, but a second text column is caught (#1268)', () => {
  const alone = ['Working:', '  note         Claude      a task', '', '  note         GitHub Copilot CLI', '                           a task'].join('\n');
  assert.deepEqual(screenProblems({ text: alone }), []);
  const mixed = ['Working:', '  note         Claude      a task', '  note         GitHub Copilot CLI a task', '               more of it'].join('\n');
  assert.ok(screenProblems({ text: mixed }).some((problem) => problem.includes('[label-columns]')), 'a second text column is caught');
  // From review: a row with its own text is not exempt just because a deeper line follows it.
  const deeper = ['Working:', '  note         Claude      a task', '  trash       empty', '                    and more'].join('\n');
  assert.ok(screenProblems({ text: deeper }).some((problem) => problem.includes('[label-columns]')), 'a label with text and a deeper line is still a second column');
});
