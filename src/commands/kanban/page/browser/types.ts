// The shapes the kanban page reads (record 0044, issue #1054): `GET /api/state` answers one
// KanbanState. The page imports them with `import type`, so it never loads core code, and a
// change on either side is a tsc error on the other. Types only: no code runs from here.
// Field names are product words: the page shows them as they are.

/** One snapshot of the team, for `GET /api/state`. The page reads it every 15 seconds. */
export interface KanbanState {
  /** The core's version; the page warns when its own differs. */
  version: string;
  /** When it was read, as a UTC ISO time. */
  readAt: string;
  repo: { name: string; url: string } | null;
  sessions: KanbanSession[];
  /** Only the pull requests that wait on you, and the ones merged lately. */
  pulls: KanbanPull[];
  actions: KanbanActions;
  /** Quota and cost, added up per agent. */
  usage: KanbanUsage;
  /** What could not be read, one plain sentence each; the page shows them as a banner. */
  problems: string[];
}

/** One AI session. Its live output is `GET /api/sessions/<id>/stream`. */
export interface KanbanSession {
  /** A hash of the desk's path: never the path itself. */
  id: string;
  /** 'Claude Code' | 'Codex' | 'Muse Code' | 'OpenCode' | … */
  agent: string;
  model: string;
  task: { kind: 'issue' | 'pr' | 'text'; number?: number; title: string };
  state: 'working' | 'stuck' | 'waiting' | 'done';
  /** When state is stuck: the minutes with no output. */
  stuckMinutes?: number;
  /** When state is waiting: what it waits for, in one sentence. */
  waitingFor?: string;
  startedAt: string;
  updatedAt: string;
  evidence: KanbanEvidence;
  /** `usd` is null when there is no price table: the page says so, and never guesses. */
  cost: { tokens: number; usd: number | null };
  /** The pull request it opened. */
  pull?: number;
}

/** What proves a session's work. All three platforms at none: the page says "not proven". */
export interface KanbanEvidence {
  /** system = a system sandbox (sandbox-runtime); guard = only yokoten's guard: the page says "fenced by the guard, not the system". */
  fence: 'system' | 'guard';
  commitCheck: 'pass' | 'fail' | 'none';
  platforms: { name: 'Linux' | 'Windows' | 'macOS'; state: 'pass' | 'fail' | 'running' | 'none' }[];
}

export interface KanbanPull {
  number: number;
  title: string;
  url: string;
  author: string;
  waitsOnYou: boolean;
  /** Why it cannot merge yet: 'CI failing on Windows' … */
  notReadyBecause: string[];
  checks: 'pass' | 'fail' | 'running' | 'none';
  mergedAt?: string;
}

/** The health of GitHub Actions, read-only. */
export interface KanbanActions {
  main: { state: 'pass' | 'fail' | 'running' | 'unknown'; failingSince?: string; run?: string };
  queuedOver15Min: { name: string; minutes: number; url: string }[];
  /** `passFailLast10` is the last ten results as letters, newest last: 'PFPPFP…'. */
  flaky: { name: string; passFailLast10: string; url: string }[];
}

/**
 * Quota and cost, read from the agents' own logs on this computer; nothing is sent anywhere.
 * Only what can be read is shown: Claude's 5-hour and weekly windows, and for the rest the
 * tokens and the price table's dollars.
 */
export interface KanbanUsage {
  quotas: KanbanQuota[];
  /** One row per agent, today, all its sessions. */
  costs: KanbanCost[];
}

/** One quota window of one agent's plan, such as Claude's 5-hour window. */
export interface KanbanQuota {
  agent: string;
  /** The plan, when its log names it: 'Max'. */
  plan?: string;
  window: '5-hour' | 'weekly';
  /** 0 to 100. */
  usedPercent: number;
  /** When the window resets, as a UTC ISO time. */
  resetsAt: string;
}

/** One agent's cost today. `usd` is null on a plan or with no price table; `onPlan` tells which. */
export interface KanbanCost {
  agent: string;
  sessions: number;
  tokens: number;
  usd: number | null;
  onPlan: boolean;
}
