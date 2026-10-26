// A stalled desk (issue #1056, the watchdog of issue #747 made part of the desk): the AI is
// alive but has made no output, tool call or commit for STALL_MINUTES. Its output lands in
// its session log in the desk's state folder, a tool call in the board's status file, a
// commit in git's log. Waiting on CI is not a stall: the status file then says `waiting`,
// or the last tool call watches a run.

import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Quiet this long, alive, and the desk is stalled. The pipeline's watchdog used 25. */
export const STALL_MINUTES = 20;

/** How often a running desk looks. */
export const LOOK_EVERY_MS = 60_000;

const mtime = (path: string): number => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
};

/** The newest change under `folder`, a few levels down and at most `limit` entries: session logs. */
function newestUnder(folder: string, depth = 4, limit = { left: 5000 }): number {
  let newest = 0;
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (limit.left-- <= 0) break;
    const path = join(folder, name);
    try {
      // A link is not followed: the AI writes this folder.
      const entry = lstatSync(path);
      newest = Math.max(newest, entry.mtimeMs);
      if (entry.isDirectory() && depth > 0) newest = Math.max(newest, newestUnder(path, depth - 1, limit));
    } catch {
      // Gone while read: the next look counts it.
    }
  }
  return newest;
}

/** When the desk last showed work: the status file, git's log and index, and the state folder. */
export function lastActivity(desk: string, state: string): number {
  return Math.max(mtime(join(desk, '.yokoten-agent.json')), mtime(join(desk, '.git', 'logs', 'HEAD')), mtime(join(desk, '.git', 'index')), newestUnder(state));
}

/** A tool call that waits on CI: the AI watches a run, so quiet is not a stall. */
const WAITS_ON_CI = /\bgh\s+(run\s+watch|pr\s+checks)\b|\bwaiting\b.*\b(ci|checks?|run)\b/i;

/** Whether the board's status file says the AI waits (on CI, or on the person). */
export function isWaiting(desk: string): boolean {
  try {
    const status = JSON.parse(readFileSync(join(desk, '.yokoten-agent.json'), 'utf8')) as { state?: unknown; doing?: unknown };
    return status.state === 'waiting' || (typeof status.doing === 'string' && WAITS_ON_CI.test(status.doing));
  } catch {
    return false;
  }
}

/** Stalled: quiet for STALL_MINUTES and not waiting. */
export const isStalled = (activeAt: number, now: number, waiting: boolean, minutes = STALL_MINUTES): boolean => !waiting && now - activeAt >= minutes * 60_000;

/** What the watcher does each look: the newest activity, whether it waits, and the time. */
export interface Look {
  activity: () => number;
  waiting: () => boolean;
  now: () => number;
  /** Called when the desk turns stalled, or works again. */
  onChange: (state: 'working' | 'stalled', activeAt: number) => void;
}

/** Look now and then while the AI runs. Returns the function that stops it. */
export function watchDesk(look: Look, every = LOOK_EVERY_MS): () => void {
  let state: 'working' | 'stalled' = 'working';
  const tick = () => {
    const activeAt = look.activity();
    const next = isStalled(activeAt, look.now(), look.waiting()) ? 'stalled' : 'working';
    if (next !== state) look.onChange(next, activeAt);
    state = next;
  };
  const timer = setInterval(tick, every);
  timer.unref();
  return () => clearInterval(timer);
}
