// The board's waiting list (#603, #693): open issues and hold-ups in the status files.
// It is read only: no request an agent can make clears a row. The old page's types live
// here too, until that page goes (#1057).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Gh, type GhLater } from '../../../../host/github/index.ts';
import { ageText, BOARD_AGENT_FILE, parseBoardAgent, type BoardRole, type BoardWorktree } from '../../agents.ts';
import { EMPTY_SCHEDULE, planSchedule, scheduleIssueOf, type SchedulePlan, type ScheduleSummary, summarizeSchedule } from '../../../more/advice/schedule.ts';
import { dependsOf } from './desk.ts';
import { type AgentView, type BoardData, BOARD_ISSUE_LIMIT, type PullView } from '../../view.ts';

/** The board's limits: how many agents run at once, how many of one model, and the memory a start keeps free. */
export interface BoardLimits {
  maxAgents: number;
  byModel: Record<string, number>;
  /** Free memory the machine keeps for itself before another agent starts, in MB (#709). */
  memoryFloorMb: number;
}

/** One agent the board started. Its output stays while it runs and after it stops. */
export interface BoardRun {
  name: string;
  issue: string;
  vendor: string;
  model: string;
  worktree: string;
  pid: number | null;
  /** Running, or stopped by the owner or its time limit. A start that fails never joins the list. */
  status: 'running' | 'stopped';
  /** Who ended a stopped run: the owner, or the time limit (#711). */
  stoppedBy?: 'owner' | 'time limit';
  startedAt: string;
  stoppedAt: string;
  exitCode: number | null;
  /** The latest output lines, oldest first, at most BOARD_OUTPUT_LINES. */
  output: string[];
}

/** One open issue to start an agent on: its number, title, link, and what it waits for. */
export interface BoardIssue {
  number: number;
  title: string;
  url: string;
  /** When it was opened, or ''. */
  createdAt: string;
  /** When it last changed, or ''. */
  updatedAt: string;
  /** Issue numbers on a "Depends on" line. The timeline shows them on the row. */
  dependsOn: number[];
  /** The issue's labels, for the schedule's priority (#709). Missing when a reader has none. */
  labels?: string[];
  /** The issue's milestone title, or '' (#709). P1 when it has one. */
  milestone?: string;
}

/** One hold-up an agent reports in its status file: a guard stop or a question. */
export interface BoardAttention {
  name: string;
  vendor: string;
  role: BoardRole;
  worktree: string;
  updated: string;
  /** A guard stop that needs a decision, or a question for the owner. */
  kind: 'guard' | 'question';
  why: string;
  /** Where the owner acts, http(s) only. */
  link: string;
}

/** One row of the waiting list: what waits, who waits, how long, why, and where to act. */
export interface BoardWaiting {
  /** An Approve on the host, a guard stop, or an agent's question. */
  kind: 'approve' | 'guard' | 'question';
  agent: string;
  role: BoardRole;
  /** How long the row has shown, counted from `latchedAt`, never from a rewrite. */
  wait: string;
  why: string;
  link: string;
  /**
   * When the row first showed, as ISO time. Kept on latched agent rows only, so the
   * wait counts from the first sight; never served over /data or shown as text.
   */
  latchedAt?: string;
}

/** The gh query for the open issues. It reads one past the board's limit, so a cut-off list is known. */
function boardIssueQuery(repo: string): string[] {
  return ['issue', 'list', '--repo', repo, '--state', 'open', '--limit', String(BOARD_ISSUE_LIMIT + 1), '--json', 'number,title,url,body,createdAt,updatedAt,labels,milestone'];
}

/** The open issues, gh's order, or why gh cannot read them. */
export function readBoardIssues(gh: Gh, repo: string): BoardIssue[] | string {
  let text: string;
  try {
    text = gh(boardIssueQuery(repo));
  } catch {
    return 'gh could not list the open issues: run it again';
  }
  return boardIssuesOf(text);
}

/** readBoardIssues without blocking (#688); `signal` stops the call. */
export async function readBoardIssuesLater(gh: GhLater, repo: string, signal?: AbortSignal): Promise<BoardIssue[] | string> {
  let text: string;
  try {
    text = await gh(boardIssueQuery(repo), signal);
  } catch {
    return 'gh could not list the open issues: run it again';
  }
  return boardIssuesOf(text);
}

/** The open issues in gh's answer, or why it is no list. */
function boardIssuesOf(text: string): BoardIssue[] | string {
  let rows: unknown;
  try {
    rows = JSON.parse(text || '[]');
  } catch {
    return 'gh gave no open issue list: run it again';
  }
  if (!Array.isArray(rows)) return 'gh gave no open issue list: run it again';
  return rows.flatMap((row) => {
    if (typeof row !== 'object' || row === null) return [];
    const fields = row as Record<string, unknown>;
    const number = fields.number;
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) return [];
    const body = typeof fields.body === 'string' ? fields.body : '';
    const labels = Array.isArray(fields.labels)
      ? fields.labels.flatMap((label) => (typeof label === 'object' && label !== null && typeof (label as Record<string, unknown>).name === 'string' ? [(label as { name: string }).name] : []))
      : [];
    const milestone = typeof fields.milestone === 'object' && fields.milestone !== null && typeof (fields.milestone as Record<string, unknown>).title === 'string'
      ? (fields.milestone as { title: string }).title
      : '';
    return [{
      number,
      title: typeof fields.title === 'string' ? fields.title : '',
      url: typeof fields.url === 'string' ? fields.url : '',
      createdAt: typeof fields.createdAt === 'string' ? fields.createdAt : '',
      updatedAt: typeof fields.updatedAt === 'string' ? fields.updatedAt : '',
      dependsOn: dependsOf(body),
      labels,
      milestone,
    }];
  });
}

/** Plain text of a status field, or '' when it is missing or not text. */
function fieldText(fields: Record<string, unknown>, name: string): string {
  const value: unknown = fields[name];
  return typeof value === 'string' ? value : '';
}

/** The link when it is http(s), else ''. Anything else stays plain text, never a link. */
function boardLink(url: string): string {
  const clean = url.trim().toLowerCase();
  return clean.startsWith('http://') || clean.startsWith('https://') ? url.trim() : '';
}

/**
 * The hold-ups the status files name: `blocked` (a guard stop that needs a decision) or
 * `question` (one line the agent asks the owner), with `link` for where to act. A file
 * that is missing, broken, or names neither is skipped.
 */
export function readBoardAttention(trees: BoardWorktree[]): BoardAttention[] {
  const found: BoardAttention[] = [];
  for (const tree of trees) {
    let text: string;
    try {
      text = readFileSync(join(tree.path, BOARD_AGENT_FILE), 'utf8');
    } catch {
      continue;
    }
    const agent = parseBoardAgent(text, tree.path);
    if (!agent) continue;
    let status: unknown;
    try {
      status = JSON.parse(text);
    } catch {
      continue;
    }
    const fields = status as Record<string, unknown>;
    const link = boardLink(fieldText(fields, 'link'));
    for (const kind of ['guard', 'question'] as const) {
      const why = fieldText(fields, kind === 'guard' ? 'blocked' : 'question').split('\n')[0].trim().slice(0, 140);
      if (!why) continue;
      found.push({ name: agent.name, vendor: agent.vendor, role: agent.role, worktree: agent.worktree, updated: agent.updated, kind, why, link });
    }
  }
  return found;
}

/**
 * True when the pull request waits for the owner: tier A with green checks and no
 * Approve. The page reads the same rows from `status`: `approve` is tier A, open and
 * green without an Approve, and `changes` is the same with changes asked.
 */
function isWaitingPull(pull: PullView): boolean {
  return pull.status === 'approve' || pull.status === 'changes';
}

/** The agent in the worktree on the pull's branch, or null when no agent is there. */
function pullAgent(board: BoardData, branch: string): AgentView | null {
  if (typeof board.worktrees === 'string' || !branch) return null;
  const path = board.worktrees.find((tree) => tree.branch === branch)?.path;
  if (!path) return null;
  return board.agents.find((agent) => agent.key === path) ?? null;
}

/**
 * The waiting list: tier A pull requests that need the Approve, and the agents' guard
 * stops and questions. Tier A rows are live from the pull requests. Agent rows latch:
 * once a hold-up shows, it stays while the agent is here, even when its file stops
 * naming it. Only leaving (removing the file) clears a file row, and only stopping
 * clears a run's own row. `seen` keeps the latched rows; the answer copies them, so
 * callers never move the latch.
 */
export function collectBoardWaiting(board: BoardData, attention: BoardAttention[], runs: BoardRun[], seen: BoardWaiting[], now: number = Date.now()): BoardWaiting[] {
  const live: BoardWaiting[] = [];
  if (typeof board.pulls !== 'string') {
    for (const pull of board.pulls.filter(isWaitingPull)) {
      const agent = pullAgent(board, pull.branch);
      live.push({
        kind: 'approve',
        agent: agent?.name ?? '',
        role: agent?.role ?? '',
        wait: agent?.age ?? '',
        why: `tier A, checks pass, needs the owner go-ahead: #${pull.number} ${pull.title}`.slice(0, 140),
        link: pull.url,
      });
    }
  }
  const fresh: BoardWaiting[] = attention.map((held) => ({ kind: held.kind, agent: held.name, role: held.role, wait: ageText(held.updated, now), why: held.why, link: held.link }));
  for (const run of runs.filter((one) => one.status === 'running')) {
    const stop = run.output.filter((line) => /guard stopped/i.test(line)).at(-1);
    if (!stop) continue;
    if (fresh.some((row) => row.agent === run.name && row.kind === 'guard')) continue;
    if (seen.some((row) => row.agent === run.name && row.kind === 'guard')) continue;
    fresh.push({ kind: 'guard', agent: run.name, role: '', wait: ageText(run.startedAt, now), why: stop.slice(0, 140), link: '' });
  }
  for (const row of fresh) {
    const old = seen.find((kept) => kept.agent === row.agent && kept.kind === row.kind);
    if (old) {
      old.role = row.role;
      old.why = row.why;
      old.link = row.link;
    } else seen.push({ ...row, latchedAt: new Date(now).toISOString() });
  }
  // The wait counts from when the row first showed, so a rewrite never resets it.
  for (const row of seen) {
    if (row.latchedAt) row.wait = ageText(row.latchedAt, now);
  }
  const here = new Set([...board.agents.map((agent) => agent.name), ...runs.filter((run) => run.status === 'running').map((run) => run.name)]);
  for (let at = seen.length - 1; at >= 0; at -= 1) {
    if (!here.has(seen[at].agent)) seen.splice(at, 1);
  }
  return [...live, ...seen.map((row) => ({ ...row }))];
}

/**
 * The dependency plan of the open issues, or null when they cannot be read or were
 * actually cut off. The read asks for one issue past the limit, so a list longer than
 * the limit is the only proof that issues are missing (#693).
 */
export function planOf(issues: BoardIssue[] | string): SchedulePlan | null {
  if (typeof issues === 'string' || issues.length > BOARD_ISSUE_LIMIT) return null;
  return planSchedule(issues.map(scheduleIssueOf));
}

/** The schedule of the open issues, or an empty one when they cannot be read or were cut off. */
export function scheduleOf(issues: BoardIssue[] | string): ScheduleSummary {
  const plan = planOf(issues);
  return plan ? summarizeSchedule(plan) : { ...EMPTY_SCHEDULE };
}
