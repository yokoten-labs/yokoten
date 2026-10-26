// The kanban's one snapshot (record 0044, architecture 3.1): `collectState()` builds the
// KanbanState that `GET /api/state` serves and `kanban --text` prints. It reads the status
// files and the session logs on this machine, and takes what GitHub said from the caller,
// so the server never waits for gh. Read only: nothing here starts, stops or changes work.

import { type BoardPull } from '../../host/github/index.ts';
import { type Env } from '../../rules/config.ts';
import { hideHome } from '../../rules/privacy.ts';
import { VERSION } from '../../setup/files.ts';
import { type HealthRun, summarizeActionsHealth } from '../more/check.ts';
import { readBoardDesks, sessionId } from './agents.ts';
import { totalOf, type UsageCell } from './feed/read/usage.ts';
import type { KanbanActions, KanbanCost, KanbanPull, KanbanSession, KanbanState } from './types.ts';
import { type AgentView, type BoardData, collectBoardWith, pullView } from './view.ts';

/** A session with no output for this long is stuck: the same 15 minutes as a live seat (#698). */
export const STUCK_AFTER_MS = 15 * 60 * 1000;
/** A run that waits this long for a runner is listed under Actions. */
const QUEUED_TOO_LONG_MS = 15 * 60 * 1000;
/** Merged pull requests newer than this are listed. */
const MERGED_WINDOW_MS = 36 * 60 * 60 * 1000;
/** The run states GitHub uses before a run starts. */
const QUEUED_STATES = new Set(['queued', 'waiting', 'pending', 'requested']);

/** What GitHub said, read by the caller: each list, or why it could not be read. */
export interface StateSources {
  /** `owner/name`, or null without a GitHub remote. */
  remote: string | null;
  pulls: BoardPull[] | string;
  /** The latest Actions runs, newest first. */
  runs: HealthRun[] | string;
  /** The branch merges land on. */
  defaultBranch: string;
}

/** The four groups: done and waiting are the agent's own word; otherwise output in the last 15 minutes is working. */
export function sessionStateOf(view: Pick<AgentView, 'dot' | 'isLive' | 'updated'>, now: number): Pick<KanbanSession, 'state' | 'stuckMinutes'> {
  if (view.dot === 'done') return { state: 'done' };
  if (view.dot === 'waiting') return { state: 'waiting' };
  const then = Date.parse(view.updated);
  const quiet = Number.isNaN(then) ? Infinity : now - then;
  if (view.isLive || quiet < STUCK_AFTER_MS) return { state: 'working' };
  return Number.isFinite(quiet) ? { state: 'stuck', stuckMinutes: Math.floor(quiet / 60000) } : { state: 'stuck' };
}

/** The tokens and the dollars of some usage rows. The dollars are null when any row has no price. */
function costOf(cells: UsageCell[]): { tokens: number; usd: number | null } {
  const total = totalOf(cells);
  return { tokens: total.input + total.cached + total.output, usd: total.usd };
}

/** One session as the page shows it. A desk runs inside the system fence; any other folder has only the guard. */
function sessionOf(view: AgentView, cells: UsageCell[], desks: Set<string>, open: BoardPull[], now: number): KanbanSession {
  const pull = view.ref?.kind === 'pr' ? view.ref.number : open.find((row) => view.branch && row.branch === view.branch)?.number;
  return {
    id: sessionId(view.key),
    agent: view.vendor.name,
    model: view.model,
    task: view.ref ? { kind: view.ref.kind, number: view.ref.number, title: view.title || view.task } : { kind: 'text', title: view.task },
    ...sessionStateOf(view, now),
    ...(view.dot === 'waiting' ? { waitingFor: view.doing || 'an answer from you' } : {}),
    startedAt: view.started,
    updatedAt: view.updated,
    evidence: {
      fence: desks.has(view.key) ? 'system' : 'guard',
      commitCheck: view.checks === 'passing' ? 'pass' : view.checks === 'failing' ? 'fail' : 'none',
      // The status file names no platform yet: all three at none, and the page says "not proven".
      platforms: [{ name: 'Linux', state: 'none' }, { name: 'Windows', state: 'none' }, { name: 'macOS', state: 'none' }],
    },
    cost: costOf(cells.filter((cell) => cell.agent === view.name)),
    ...(pull ? { pull } : {}),
  };
}

/** Why an open pull request cannot merge yet, in the page's words. */
const NOT_READY: Record<string, string> = {
  building: 'still a draft',
  failed: 'checks failing',
  running: 'checks running',
  unchecked: 'no checks yet',
  changes: 'changes requested',
};

/**
 * The pull requests for the owner: open ones that are the owner's to decide (tier A, or no
 * tier), and the ones merged lately. One waits on you at your step: tier A at the Approve,
 * no tier when it is ready to merge.
 */
export function pullsOf(rows: BoardPull[], now: number): KanbanPull[] {
  const open = rows
    .filter((row) => (row.stage === 'open' || row.stage === 'draft') && (row.tier === 'A' || row.tier === ''))
    .map((row): KanbanPull => {
      const view = pullView(row);
      const waitsOnYou = row.tier === 'A' ? view.status === 'approve' : view.status === 'ready';
      return { number: row.number, title: row.title, url: view.url, author: '', waitsOnYou, notReadyBecause: NOT_READY[view.status] ? [NOT_READY[view.status]] : [], checks: row.checks };
    });
  const merged = rows
    .filter((row) => row.stage === 'merged' && now - Date.parse(row.mergedAt) < MERGED_WINDOW_MS)
    .map((row): KanbanPull => ({ number: row.number, title: row.title, url: pullView(row).url, author: '', waitsOnYou: false, notReadyBecause: [], checks: row.checks, mergedAt: row.mergedAt }));
  return [...open, ...merged];
}

/** Actions with nothing read. */
export const NO_ACTIONS: KanbanActions = { main: { state: 'unknown' }, queuedOver15Min: [], flaky: [] };

/**
 * The health of Actions, from the same summary as `yokoten ci-health`. Main fails when the
 * latest finished run of any workflow on it failed, since the first failure in a row; a run
 * still going makes it running only when nothing failed. Flaky is a
 * workflow that both passed and failed on main, with its last ten results.
 */
export function actionsOf(runs: HealthRun[], defaultBranch: string, now: number): KanbanActions {
  const health = summarizeActionsHealth(runs, [], defaultBranch);
  const failed = new Set(health.mainFailures.map((run) => run.id));
  const onMain = runs.filter((run) => run.branch === defaultBranch);
  // Each workflow's completed runs on main, newest first: a queued rerun keeps main red until it passes.
  const byWorkflow = new Map<string, HealthRun[]>();
  for (const run of onMain.filter((one) => one.status === 'completed')) byWorkflow.set(run.workflow, [...(byWorkflow.get(run.workflow) ?? []), run]);
  const latest = [...byWorkflow.values()].map((list) => list[0]);
  let main: KanbanActions['main'] = { state: 'unknown' };
  const failing = latest.filter((run) => failed.has(run.id));
  if (failing.length) {
    let since = '';
    for (const run of failing) {
      const list = byWorkflow.get(run.workflow) ?? [];
      const stop = list.findIndex((one) => !failed.has(one.id));
      const streak = stop < 0 ? list : list.slice(0, stop);
      const first = streak[streak.length - 1]?.createdAt ?? '';
      if (first && (!since || first < since)) since = first;
    }
    main = { state: 'fail', ...(since ? { failingSince: since } : {}), ...(failing[0].url ? { run: failing[0].url } : {}) };
  } else if (onMain.some((run) => run.status !== 'completed')) main = { state: 'running' };
  else if (latest.length) main = { state: 'pass' };
  const queuedOver15Min = runs
    .filter((run) => QUEUED_STATES.has(run.status) && now - Date.parse(run.createdAt) >= QUEUED_TOO_LONG_MS)
    .map((run) => ({ name: run.workflow, minutes: Math.floor((now - Date.parse(run.createdAt)) / 60000), url: run.url }));
  const flaky = health.unstable
    .filter((group) => group.branch === defaultBranch)
    .map((group) => {
      const results = (byWorkflow.get(group.workflow) ?? []).filter((run) => (run.conclusion === 'success' || failed.has(run.id))).slice(0, 10);
      return { name: group.workflow, passFailLast10: results.map((run) => (run.conclusion === 'success' ? 'P' : 'F')).reverse().join(''), url: results[0]?.url ?? '' };
    });
  return { main, queuedOver15Min, flaky };
}

/** Today's cost per agent: its sessions, tokens and dollars. No plan is read yet, so `onPlan` is false. */
function costsOf(cells: UsageCell[], now: number): KanbanCost[] {
  const today = new Date(now).toISOString().slice(0, 10);
  const byVendor = new Map<string, UsageCell[]>();
  for (const cell of cells.filter((one) => one.day === today)) byVendor.set(cell.vendor, [...(byVendor.get(cell.vendor) ?? []), cell]);
  return [...byVendor].map(([agent, list]) => ({ agent, sessions: new Set(list.map((cell) => cell.agent)).size, ...costOf(list), onPlan: false }));
}

/** The snapshot from the board's data and what GitHub said. Pure, so the tests drive it with a clock. */
export function stateOf(board: BoardData, sources: StateSources, desks: Set<string>, now: number): KanbanState {
  const rows = typeof sources.pulls === 'string' ? [] : sources.pulls;
  const open = rows.filter((row) => row.stage === 'open' || row.stage === 'draft');
  const cells = board.usage?.cells ?? [];
  const problems = [sources.pulls, sources.runs, board.worktrees].filter((one): one is string => typeof one === 'string');
  return {
    version: VERSION,
    readAt: new Date(now).toISOString(),
    repo: board.repoUrl ? { name: board.repoName, url: board.repoUrl } : null,
    sessions: board.agents.map((view) => sessionOf(view, cells, desks, open, now)),
    pulls: pullsOf(rows, now),
    actions: typeof sources.runs === 'string' ? NO_ACTIONS : actionsOf(sources.runs, sources.defaultBranch, now),
    usage: { quotas: [], costs: costsOf(cells, now) },
    problems: [...new Set(problems)],
  };
}

/** The kanban's snapshot of this repo now. GitHub's lists come from the caller. */
export function collectState(root: string, env: Env, sources: StateSources, now: number = Date.now()): KanbanState {
  const board = collectBoardWith(root, env, sources.remote, sources.pulls, now);
  const desks = new Set(readBoardDesks(root).map((desk) => hideHome(desk.path, env)));
  return stateOf(board, sources, desks, now);
}

/** The groups `--text` prints, in the page's order. */
const GROUPS: [KanbanSession['state'], string][] = [
  ['stuck', 'Stuck'],
  ['waiting', 'Waiting for you'],
  ['working', 'Working'],
  ['done', 'Done'],
];

/** `kanban --text`: the same snapshot as the page, as plain lines. */
export function renderStateText(state: KanbanState): string[] {
  const lines = [`yokoten kanban: ${state.repo?.name ?? 'this repo'} (preview: read only)`, ''];
  for (const [group, heading] of GROUPS) {
    const sessions = state.sessions.filter((session) => session.state === group);
    if (!sessions.length) continue;
    lines.push(`${heading}:`);
    for (const session of sessions) {
      const task = session.task.number ? `${session.task.kind === 'pr' ? 'PR' : 'issue'} #${session.task.number} ${session.task.title}` : session.task.title || 'no task';
      const extra = session.stuckMinutes !== undefined ? `, no output for ${session.stuckMinutes} min` : session.waitingFor ? `, waits for ${session.waitingFor}` : '';
      lines.push(`- ${session.agent}${session.model ? ` (${session.model})` : ''}: ${task}${extra}`);
    }
    lines.push('');
  }
  if (!state.sessions.length) lines.push('Sessions:', '- none yet. Start one with `yokoten desk`: it shows here by itself.', '');
  lines.push('Pull requests:');
  if (!state.pulls.length) lines.push('- none waits on you.');
  for (const pull of state.pulls) {
    const said = pull.mergedAt ? 'merged' : pull.waitsOnYou ? 'waits on you' : pull.notReadyBecause.join(', ') || 'open';
    lines.push(`- #${pull.number} ${pull.title}: ${said}`);
  }
  const main = state.actions.main;
  lines.push('', `Actions: main ${main.state}${main.failingSince ? ` since ${main.failingSince}` : ''}`);
  for (const run of state.actions.queuedOver15Min) lines.push(`- ${run.name} waits for a runner, ${run.minutes} min`);
  for (const run of state.actions.flaky) lines.push(`- ${run.name} is flaky: ${run.passFailLast10}`);
  if (state.problems.length) lines.push('', 'Not read:', ...state.problems.map((problem) => `- ${problem}`));
  return lines;
}
