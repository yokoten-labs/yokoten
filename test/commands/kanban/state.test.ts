// Tests for src/commands/kanban/state.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { makeSandbox, runChild } from '../../repo/helpers.ts';
import { sessionId } from '../../../src/commands/kanban/agents.ts';
import { EMPTY_DESK } from '../../../src/commands/kanban/feed/read/desk.ts';
import { boardDataBody } from '../../../src/commands/kanban/server.ts';
import { actionsOf, collectState, pullsOf, renderStateText, sessionStateOf, stateOf, type StateSources } from '../../../src/commands/kanban/state.ts';
import type { KanbanState } from '../../../src/commands/kanban/page/browser/types.ts';
import { type AgentView, type BoardData, vendorOf } from '../../../src/commands/kanban/view.ts';
import type { HealthRun } from '../../../src/commands/more/check.ts';
import type { BoardPull } from '../../../src/host/github/index.ts';
import { registerDesk } from '../../../src/run/hook.ts';

const NOW = Date.parse('2026-10-26T12:00:00Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60000).toISOString();
const view = (fields: Partial<AgentView>): AgentView => ({ key: '~/w', name: 'w', nickname: '', isMain: false, vendor: vendorOf('claude'), model: 'opus', effort: '', role: '', dot: 'idle', task: '', title: '', ref: null, doing: '', checks: '', age: '', updated: '', started: '', branch: '', ...fields });
const board = (agents: AgentView[]): BoardData => ({ repo: '~/r', repoName: 'r', repoUrl: '', agents, needs: [], pulls: [], merged: [], worktrees: [], desk: EMPTY_DESK, updated: '' });
const NO_GITHUB: StateSources = { remote: null, pulls: 'no remote', runs: [], defaultBranch: 'main' };
const run = (fields: Partial<HealthRun>): HealthRun => ({ id: 1, workflow: 'CI', event: 'push', branch: 'main', status: 'completed', conclusion: 'success', createdAt: ago(60), startedAt: ago(60), updatedAt: ago(55), url: '', ...fields });
const pull = (fields: Partial<BoardPull>): BoardPull => ({ number: 1, title: 't', branch: 'b', url: 'https://example.com/pull/1', stage: 'open', checks: 'pass', tier: 'A', review: 'none', isApprovedOnHead: false, mergedAt: '', ...fields });

// Record 0044: the page groups sessions in four states. The agent's own word wins; then
// output in the last 15 minutes is working, and anything quieter is stuck, with its minutes.
test('kanban state: the four session groups, by a table of times', () => {
  const rows: [Partial<AgentView>, string, number | undefined][] = [
    [{ dot: 'done', updated: ago(600) }, 'done', undefined],
    [{ dot: 'waiting', updated: ago(600) }, 'waiting', undefined],
    [{ dot: 'working', updated: ago(1) }, 'working', undefined],
    [{ dot: 'idle', updated: ago(14) }, 'working', undefined],
    [{ dot: 'idle', updated: ago(15) }, 'stuck', 15],
    [{ dot: 'failing', updated: ago(40) }, 'stuck', 40],
    [{ dot: 'idle', updated: ago(90), isLive: true }, 'working', undefined],
    [{ dot: 'idle', updated: '' }, 'stuck', undefined],
  ];
  for (const [fields, state, minutes] of rows) {
    const found = sessionStateOf({ dot: 'idle', updated: '', ...fields }, NOW);
    assert.equal(found.state, state, JSON.stringify(fields));
    assert.equal(found.stuckMinutes, minutes, JSON.stringify(fields));
  }
});

// The snapshot carries each session once, with its group, task, fence and evidence.
test('kanban state: sessions from the board, with the id a hash of the path', () => {
  const agents = [
    view({ key: '~/a', dot: 'working', updated: ago(2), task: 'issue 12 fix it', title: 'fix it', ref: { kind: 'issue', number: 12 }, checks: 'passing' }),
    view({ key: '~/b', dot: 'waiting', doing: 'the merge order', task: 'write docs' }),
    view({ key: '~/c', dot: 'idle', updated: ago(30), branch: 'feat', checks: 'failing' }),
    view({ key: '~/d', dot: 'done' }),
  ];
  const state = stateOf(board(agents), { ...NO_GITHUB, pulls: [pull({ number: 9, branch: 'feat', tier: 'B' })] }, new Set(['~/a']), NOW);
  assert.deepEqual(state.sessions.map((one) => one.state), ['working', 'waiting', 'stuck', 'done']);
  assert.equal(state.sessions[0].id, sessionId('~/a'));
  assert.match(state.sessions[0].id, /^[0-9a-f]{16}$/);
  assert.equal(state.sessions[0].id.includes('~'), false, 'the id is a hash, not the path');
  assert.notEqual(sessionId('~/a'), sessionId('~/b'));
  assert.deepEqual(state.sessions[0].task, { kind: 'issue', number: 12, title: 'fix it' });
  assert.deepEqual(state.sessions[1].task, { kind: 'text', title: 'write docs' });
  assert.equal(state.sessions[1].waitingFor, 'the merge order');
  assert.equal(state.sessions[2].stuckMinutes, 30);
  assert.equal(state.sessions[2].pull, 9, 'the open pull request on its branch');
  assert.deepEqual(state.sessions.map((one) => one.evidence.fence), ['system', 'guard', 'guard', 'guard'], 'only a desk has the system fence');
  assert.deepEqual(state.sessions.map((one) => one.evidence.commitCheck), ['pass', 'none', 'fail', 'none']);
  assert.deepEqual(state.sessions[0].evidence.platforms.map((one) => one.state), ['none', 'none', 'none'], 'nothing proven yet');
  assert.deepEqual(state.sessions[0].cost, { tokens: 0, usd: 0 });
  assert.deepEqual(state.problems, []);
  assert.deepEqual(stateOf(board([]), NO_GITHUB, new Set(), NOW).problems, ['no remote'], 'what could not be read is a problem');
  assert.equal(state.repo, null, 'no GitHub remote');
  assert.equal(state.readAt, '2026-10-26T12:00:00.000Z');
});

// Only what waits on the owner, and what merged lately. Tier B and C are the bot's.
test('kanban state: the pull requests that wait on you, and why the rest cannot merge', () => {
  const rows = [
    pull({ number: 1 }),
    pull({ number: 2, checks: 'fail' }),
    pull({ number: 3, tier: 'B' }),
    pull({ number: 4, tier: '' }),
    pull({ number: 5, isApprovedOnHead: true }),
    pull({ number: 6, stage: 'merged', mergedAt: ago(60) }),
    pull({ number: 7, stage: 'merged', mergedAt: ago(60 * 48) }),
    pull({ number: 8, stage: 'closed' }),
  ];
  const shown = pullsOf(rows, NOW);
  assert.deepEqual(shown.map((one) => [one.number, one.waitsOnYou, one.notReadyBecause]), [
    [1, true, []],
    [2, false, ['checks failing']],
    [4, true, []],
    [5, false, []],
    [6, false, []],
  ]);
  assert.equal(shown.at(-1)?.mergedAt, ago(60));
});

// The Actions part reuses the ci-health summary: main's state, long waits, and flaky workflows.
test('kanban state: Actions health from the ci-health summary', () => {
  assert.deepEqual(actionsOf([], 'main', NOW), { main: { state: 'unknown' }, queuedOver15Min: [], flaky: [] });
  assert.equal(actionsOf([run({})], 'main', NOW).main.state, 'pass');
  assert.equal(actionsOf([run({ id: 2, status: 'in_progress', conclusion: '' }), run({})], 'main', NOW).main.state, 'running');
  assert.equal(actionsOf([run({ id: 2, status: 'queued', conclusion: '' }), run({ conclusion: 'failure' })], 'main', NOW).main.state, 'fail', 'a queued rerun keeps main red');
  const failing = actionsOf([
    run({ id: 4, conclusion: 'failure', createdAt: ago(10), url: 'https://example.com/run/4' }),
    run({ id: 3, conclusion: 'failure', createdAt: ago(20) }),
    run({ id: 2, conclusion: 'success', createdAt: ago(30) }),
    run({ id: 1, conclusion: 'failure', createdAt: ago(40) }),
    run({ id: 5, workflow: 'Lint', createdAt: ago(5) }),
    run({ id: 6, branch: 'feat', conclusion: 'failure' }),
  ], 'main', NOW);
  assert.deepEqual(failing.main, { state: 'fail', failingSince: ago(20), run: 'https://example.com/run/4' }, 'since the first failure in a row');
  assert.deepEqual(failing.flaky, [{ name: 'CI', passFailLast10: 'FPFF', url: 'https://example.com/run/4' }], 'newest last; a branch is not main');
  const queued = actionsOf([run({ id: 7, status: 'queued', conclusion: '', createdAt: ago(20), url: 'u' }), run({ id: 8, status: 'queued', conclusion: '', createdAt: ago(5) })], 'main', NOW);
  assert.deepEqual(queued.queuedOver15Min, [{ name: 'CI', minutes: 20, url: 'u' }]);
  // A positive control for the main filter: the same failures on another default branch pass.
  assert.equal(actionsOf([run({ conclusion: 'failure' })], 'trunk', NOW).main.state, 'unknown');
});

// `kanban --text` prints the same snapshot, grouped as the page groups it.
test('kanban state: --text prints the groups, the pull requests and Actions', () => {
  const state = stateOf(board([view({ dot: 'idle', updated: ago(20), task: 'issue 3 a', title: 'a', ref: { kind: 'issue', number: 3 } }), view({ dot: 'working', updated: ago(1), task: 'b' })]), { ...NO_GITHUB, pulls: [pull({ number: 4 })] }, new Set(), NOW);
  const text = renderStateText(state).join('\n');
  assert.match(text, /^yokoten kanban: this repo \(preview: read only\)\n\nStuck:\n- Claude \(opus\): issue #3 a, no output for 20 min\n\nWorking:\n- Claude \(opus\): b\n\nPull requests:\n- #4 t: waits on you\n\nActions: main unknown$/);
  assert.match(renderStateText(stateOf(board([]), NO_GITHUB, new Set(), NOW)).join('\n'), /Sessions:\n- none yet\./);
});

// The JSON is masked at the server boundary: a home path, an email, a token and a mark never leave.
test('kanban state: a desk is fenced by the system, and private words never reach /api/state', () => {
  const sandbox = makeSandbox();
  const home = dirname(sandbox.repo);
  const env = { ...sandbox.env, HOME: home };
  assert.equal(sandbox.git('commit', '-q', '--allow-empty', '-m', 'start').status, 0);
  const desk = join(home, 'desk');
  assert.equal(runChild('git', ['clone', '-q', sandbox.repo, desk]).status, 0);
  assert.equal(registerDesk(sandbox.repo, desk), '');
  const email = ['someone', 'personal-mail.com'].join('@');
  const token = `${'gh'}p_${'a1B2c3D4e5'.repeat(4).slice(0, 36)}`;
  const mark = 'zebracorn';
  mkdirSync(join(home, '.config', 'yokoten'), { recursive: true });
  writeFileSync(join(home, '.config', 'yokoten', 'private-marks'), `${mark}\n`);
  writeFileSync(join(sandbox.repo, '.yokoten-agent.json'), JSON.stringify({ name: 'w', vendor: 'claude', task: `PR #5 read ${home}/task`, state: 'waiting', doing: `mail ${email} about ${mark} with ${token}` }));
  writeFileSync(join(desk, '.yokoten-agent.json'), JSON.stringify({ name: 'd', vendor: 'claude', task: 'issue 8' }));
  const state = collectState(sandbox.repo, env, NO_GITHUB);
  assert.deepEqual(state.sessions.map((one) => one.evidence.fence), ['guard', 'system']);
  const text = boardDataBody(env, sandbox.repo, state);
  for (const secret of [home, email, token, mark]) assert.equal(text.includes(secret), false, 'a private value never reaches /api/state');
  const shown = JSON.parse(text) as KanbanState;
  assert.match(shown.sessions[0].waitingFor ?? '', /<email>.*<mark>.*<secret>/);
  // A positive control: the status file the state was read from holds them.
  assert.ok(readFileSync(join(sandbox.repo, '.yokoten-agent.json'), 'utf8').includes(email));
});
