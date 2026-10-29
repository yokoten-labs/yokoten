// `yokoten kanban --text` (#601, #603, #1027, #1115): the kanban's snapshot as one screen of
// text, for a terminal or an agent. It renders the KanbanState the page reads from
// GET /api/state, so the text and the page say the same things. The screen is built only
// with the layout helpers of ports.ts.

import { utcText } from '../../../rules/text/screen.ts';
import { counted, moreLines, rowLines, type RowState, screenLines, terminalSafe, titleLines, wrapLines } from '../ports.ts';
import { notReadLines } from '../state.ts';
import type { KanbanActions, KanbanPull, KanbanSession, KanbanState } from './browser/types.ts';

/** The groups, in the page's order. Stuck and waiting need you, so they are never folded. */
const GROUPS: { state: KanbanSession['state']; heading: string; mark: RowState; cap: number }[] = [
  { state: 'stuck', heading: 'Stuck:', mark: 'MISSING', cap: Infinity },
  { state: 'waiting', heading: 'Waiting for you:', mark: 'next', cap: Infinity },
  { state: 'working', heading: 'Working:', mark: 'note', cap: 5 },
  { state: 'done', heading: 'Done:', mark: 'ok', cap: 5 },
];

/** What a row says when its group is cut short: where all of them are. */
const foldRow = (more: number): string[] => rowLines('to do', `${counted(more, 'more row')}, all of them with \`yokoten kanban --json\``);

/**
 * The agent as a label that fits the label field (10 characters): `Claude Code` is `Claude`, a
 * longer name is cut with an ellipsis. `--json` and the page have the full name.
 */
const agentLabel = (agent: string): string => {
  const short = agent.replace(/ Code$/, '') || 'unknown';
  return short.length > 10 ? `${short.slice(0, 9)}…` : short;
};

/** One session as a row: the agent, then its task, model and why it needs you. */
function sessionRow(session: KanbanSession, mark: RowState): string[] {
  const task = session.task.number ? `${session.task.kind === 'pr' ? 'PR' : 'issue'} #${session.task.number} ${session.task.title}` : session.task.title || 'no task';
  const extra = session.stuckMinutes !== undefined ? `, no output for ${session.stuckMinutes} min` : session.waitingFor ? `, waits for ${session.waitingFor}` : '';
  return rowLines(mark, `${task}${session.model ? ` (${session.model})` : ''}${extra}`, agentLabel(session.agent));
}

/** The session blocks: one per group that has sessions, or one line saying how to start one. */
function sessionBlocks(sessions: KanbanSession[]): string[][] {
  if (!sessions.length) return [['Sessions:', ...wrapLines('  ', 'none yet. Start one with `yokoten desk`: it shows here by itself.')]];
  const blocks: string[][] = [];
  for (const group of GROUPS) {
    const inGroup = sessions.filter((session) => session.state === group.state);
    if (!inGroup.length) continue;
    const shown = inGroup.slice(0, group.cap);
    blocks.push([group.heading, ...shown.flatMap((session) => sessionRow(session, group.mark)), ...(inGroup.length > shown.length ? foldRow(inGroup.length - shown.length) : [])]);
  }
  return blocks;
}

/** One pull request as a row: waits on you, merged, or why it cannot merge yet. */
function pullRow(pull: KanbanPull): string[] {
  const said = pull.mergedAt ? 'merged' : pull.waitsOnYou ? 'waits on you' : pull.notReadyBecause.join(', ') || 'open';
  const mark: RowState = pull.mergedAt ? 'ok' : pull.waitsOnYou ? 'next' : 'to do';
  return rowLines(mark, `${pull.title}: ${said}`, `PR #${pull.number}`);
}

/** The Actions rows: how main is, then each run that waits too long and each flaky workflow. */
function actionRows(actions: KanbanActions): string[] {
  const main = actions.main;
  const rows: Record<KanbanActions['main']['state'], [RowState, string]> = {
    pass: ['ok', 'passing'],
    fail: ['MISSING', `failing${main.failingSince ? ` since ${utcText(main.failingSince)}` : ''}`],
    running: ['note', 'running'],
    unknown: ['note', 'not read'],
  };
  const [mark, text] = rows[main.state];
  return [
    ...rowLines(mark, text, 'main'),
    ...actions.queuedOver15Min.flatMap((run) => rowLines('to do', `waits for a runner, ${run.minutes} min`, run.name)),
    ...actions.flaky.flatMap((run) => rowLines('note', `flaky: ${run.passFailLast10}`, run.name)),
  ];
}

/**
 * The default screen of `kanban --text`: a title with the counts, the sessions by group,
 * the pull requests and Actions, what could not be read, and the live page last. A person
 * and an agent read the same text; `--json` has every row. Sessions are written by agents,
 * so control and bidi characters show escaped.
 */
export function renderBoardScreen(state: KanbanState, livePage?: string): string[] {
  const pulls = state.pulls.length ? state.pulls.flatMap(pullRow) : wrapLines('  ', 'none waits on you.');
  return screenLines(
    titleLines('kanban', `${state.repo?.name ?? 'this repo'}: ${counted(state.sessions.length, 'session')}, ${counted(state.pulls.length, 'pull request')}, read only`),
    ...sessionBlocks(state.sessions),
    ['Pull requests:', ...pulls],
    ['Actions:', ...actionRows(state.actions)],
    ...(state.problems.length ? [['Not read:', ...notReadLines(state.problems)]] : []),
    moreLines(livePage === undefined ? '`yokoten kanban` opens the live page' : `the live page at ${livePage}`),
  ).map(terminalSafe);
}
