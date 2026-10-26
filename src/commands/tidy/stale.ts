// What `yokoten tidy` may put away (issue #1055): pure rules, no disk and no git. find.ts
// reads the facts; this file says, for one thing and the time now, which of four it is.
// The order is the safety: "in use" wins over everything, then "still in work", and only
// then "old". A thing is old only on a clear sign: its branch is merged or gone on the
// remote, its folder is gone, or (for a log) its desk is gone. Age alone never makes a
// branch, worktree or desk old: an unmerged branch nobody touched for a month may be the
// one piece of work its owner cares about.
//
// The rules live here, not in src/rules/, because src/rules/ holds 7 entries, the cap.

/** What tidy looks at: a local branch, a linked worktree, a desk clone, or a gone desk's logs. */
export type StaleKind = 'branch' | 'worktree' | 'desk' | 'log';

/** The facts about one thing, as find.ts reads them. */
export interface StaleFacts {
  kind: StaleKind;
  /** Tidy runs inside it, or it is the branch checked out or the main branch. */
  isHere: boolean;
  /** A program has its working folder inside it. */
  hasProcess: boolean;
  /** Git holds a lock in it, or `git worktree lock` keeps it. */
  isLocked: boolean;
  /** The last write tidy can see (its status file, git folder, logs), in ms; null when none. */
  lastWrite: number | null;
  /** Its commit is in the main branch. */
  isMerged: boolean;
  /** Its branch was pushed, and the remote branch is gone now (a merged pull request deletes it). */
  isUpstreamGone: boolean;
  /** Its folder is gone: a worktree git still lists, or the desk of a log. */
  isGone: boolean;
  /** Commits on no remote and not in the main branch. */
  unpushed: number;
  /** Changes not committed, or files git does not track yet. */
  isDirty: boolean;
}

/**
 * old: put away, nothing is lost. keep-first: put away only with a saved copy, because some
 * work is found nowhere else. in-use: never touched. keep: still in work, not listed.
 */
export type StaleVerdict = 'old' | 'keep-first' | 'in-use' | 'keep';

export interface StaleJudgment {
  verdict: StaleVerdict;
  /** Why, as a reader can check it: one clause, no full stop. */
  why: string;
}

/** A thing written to within this time is in use (design 3, step 6). */
export const IN_USE_MS = 15 * 60 * 1000;
/** A merged branch, worktree or desk is old only after this long with no change: a new one starts at the main branch too. */
export const QUIET_MS = 24 * 60 * 60 * 1000;
/** A log is old after this long with no write, even when its desk is gone. */
export const LOG_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const minutes = (ms: number): string => `${Math.max(0, Math.round(ms / 60_000))} min`;
const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`;

/** Why it is old, or '' when there is no clear sign. */
function oldSign(facts: StaleFacts, age: number | null): string {
  const isQuiet = age === null || age >= QUIET_MS;
  switch (facts.kind) {
    case 'log':
      if (facts.isGone) return 'its desk is gone';
      return age !== null && age >= LOG_AGE_MS ? 'no write for 30 days' : '';
    default:
      if (facts.isGone) return 'its folder is gone; git still lists it';
      if (facts.isUpstreamGone) return 'its branch on the remote is gone';
      return facts.isMerged && isQuiet ? 'merged into the main branch, and no change for a day' : '';
  }
}

/** Which of the four `facts` is at `now`: the first rule that holds, in the order of the table in stale.test.ts. */
export function judgeStale(facts: StaleFacts, now: number): StaleJudgment {
  if (facts.isHere) return { verdict: 'in-use', why: facts.kind === 'branch' ? 'it is checked out, or it is the main branch' : 'tidy runs inside it' };
  if (facts.hasProcess) return { verdict: 'in-use', why: 'a program is running in it' };
  if (facts.isLocked) return { verdict: 'in-use', why: 'git keeps a lock on it' };
  const age = facts.lastWrite === null ? null : now - facts.lastWrite;
  if (age !== null && age < IN_USE_MS) return { verdict: 'in-use', why: `it changed ${minutes(age)} ago` };
  const sign = oldSign(facts, age);
  if (!sign) return { verdict: 'keep', why: 'still in work' };
  const only = [facts.unpushed > 0 ? `${plural(facts.unpushed, 'commit')} on no remote` : '', facts.isDirty ? 'changes not committed' : ''].filter(Boolean);
  if (only.length) return { verdict: 'keep-first', why: `${sign}, but ${only.join(' and ')}` };
  return { verdict: 'old', why: sign };
}
