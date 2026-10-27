// What `yokoten desk` knows of each desk (issue #1054, #1056): one record file per desk, in
// the desks' folder next to the desks, `<name>.json`, with its brief `<name>.brief.md`. The
// fence hides that folder, so the AI can't change what the desk says about it. Bare
// `yokoten desk` reads the records and writes nothing.

import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { count, nextLine, row, screen, spaced, title, wrap } from '../shared.ts';
import type { DeskTask } from './brief.ts';

/** One desk, as its record says. Times are UTC ISO. */
export interface DeskRecord {
  name: string;
  task: Pick<DeskTask, 'kind' | 'title'> & { number?: number };
  agent: string;
  branch: string;
  /** The commit the branch started from. */
  base: string;
  /** The desk command's process while the AI runs. */
  pid: number;
  startedAt: string;
  /** The last sign of work: output, a tool call or a commit. */
  activeAt: string;
  /** working: the AI runs. stalled: it runs, but has done nothing for a while. stopped: it ended mid-task. */
  state: 'working' | 'stalled' | 'stopped' | 'kept' | 'done';
  /** The commit last pushed, when --pr pushed one. */
  pushed?: string;
}

export const recordFile = (home: string, name: string): string => join(home, `${name}.json`);
export const briefFile = (home: string, name: string): string => join(home, `${name}.brief.md`);

/** The record of one desk, or null. A file that is not one is left as it is. */
export function readRecord(home: string, name: string): DeskRecord | null {
  try {
    const record = JSON.parse(readFileSync(recordFile(home, name), 'utf8')) as DeskRecord;
    return typeof record.name === 'string' && typeof record.branch === 'string' ? record : null;
  } catch {
    return null;
  }
}

/** Write a record whole: a new file, then a rename, so a reader never sees half of one. */
export function writeRecord(home: string, record: DeskRecord): void {
  const file = recordFile(home, record.name);
  writeFileSync(`${file}.new`, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(`${file}.new`, file);
}

/** Every desk's record, by name. */
export function readRecords(home: string): DeskRecord[] {
  if (!existsSync(home)) return [];
  return readdirSync(home)
    .filter((file) => file.endsWith('.json'))
    .map((file) => readRecord(home, file.slice(0, -'.json'.length)))
    .filter((record): record is DeskRecord => record !== null)
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
}

/** Whether a process is alive. A test passes its own. */
export type IsAlive = (pid: number) => boolean;
export const isAlive: IsAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** The state now: a working or stalled desk whose process is gone stopped mid-task. */
export const stateNow = (record: DeskRecord, alive: IsAlive): DeskRecord['state'] =>
  (record.state === 'working' || record.state === 'stalled') && !alive(record.pid) ? 'stopped' : record.state;

/** "5 min", "3 h", "2 days": how long ago. */
export function ago(iso: string, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h`;
  return `${Math.round(minutes / 1440)} days`;
}

/** What a desk did: its commits since the base, newest first, one line each. */
export type CommitsOf = (record: DeskRecord) => string[];

/** One desk as the list shows it, and as `--json` gives it: its record, the state now, and what it did. */
export interface DeskView extends Omit<DeskRecord, 'pid' | 'base'> {
  /** The commits since the base, newest first: `<sha> <subject>`. */
  commits: string[];
}

/** Everything the bare `yokoten desk` screen is built from. */
export interface DeskListResult {
  desks: DeskView[];
}

/** The facts of the list: each record with the state now (a gone process stopped mid-task) and its commits. */
export function deskListOf(records: DeskRecord[], alive: IsAlive, commitsOf: CommitsOf): DeskListResult {
  return {
    desks: records.map((record) => ({
      name: record.name,
      task: record.task,
      agent: record.agent,
      branch: record.branch,
      startedAt: record.startedAt,
      activeAt: record.activeAt,
      state: stateNow(record, alive),
      ...(record.pushed === undefined ? {} : { pushed: record.pushed }),
      commits: commitsOf(record),
    })),
  };
}

/** One desk as rows: its state, the task, and what it did. */
export function deskRows(desk: DeskView, now: Date): string[] {
  const { state } = desk;
  const mark = state === 'stopped' || state === 'stalled' ? 'note' : state === 'working' ? 'next' : 'ok';
  const when = state === 'working' ? `working ${ago(desk.startedAt, now)}` : state === 'stalled' ? `stalled: quiet ${ago(desk.activeAt, now)}` : state === 'stopped' ? `stopped ${ago(desk.activeAt, now)} ago` : state === 'kept' ? 'ended, work kept' : 'done';
  const did = desk.commits.length ? `${count(desk.commits.length, 'commit')}, last: ${desk.commits[0]}` : 'no commits yet';
  return row(mark, `${when} · ${desk.agent} · ${desk.task.title} · ${did}`, `desk ${desk.name}`);
}

/** The bare `yokoten desk` screen, a pure function of the list. */
export function listScreen({ desks }: DeskListResult, now: Date): string[] {
  // What a desk is, in one line, so a newcomer knows what the command makes (#1115).
  if (!desks.length) return screen(title('desk', 'no desks yet'), wrap('', 'A desk gives one task to one AI, in its own fenced clone.'), nextLine('yokoten desk <issue>'));
  const stopped = desks.filter((desk) => desk.state === 'stopped');
  const next = stopped[0] ?? desks.find((desk) => desk.state === 'kept');
  return screen(
    title('desk', `${count(desks.length, 'desk')}${stopped.length ? `, ${stopped.length} stopped mid-task` : ''}`),
    spaced(desks.map((desk) => deskRows(desk, now))),
    nextLine(next === undefined ? 'yokoten desk <issue>' : next === stopped[0] ? `yokoten desk ${next.name}` : `yokoten desk ${next.name} --pr`),
  );
}
