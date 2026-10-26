// When the AI exits (issue #1054, #1056): save what it left, run the check and the tests in
// the fence, and show the evidence on one screen. Three endings: clean (nothing left to
// push: the desk is archived, then moved aside), unpushed work (kept; `--pr` opens the pull
// request), failed (kept; `yokoten desk <n>` goes on). Nothing is pushed without `--pr`.
// The tests and the save run inside the fence: they run code the AI wrote. git reads and
// the bundle run outside, through deskGit: no hook, no fsmonitor, and git's folder pinned
// to the desk's own locked .git, so a config the AI planted elsewhere never counts. The
// push goes from the project's own checkout.

import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { count, field, nextLine, row, SCREEN_WIDTH, title } from '../shared.ts';
import type { DeskTask } from './brief.ts';
import { type Ran, type Run } from './clone.ts';
import { briefFile, type DeskRecord, recordFile } from './list.ts';

/** Runs a command in the desk's fence and gives its output, or why the fence can't start. */
export type Fenced = (command: string[]) => Promise<Ran | { fail: string }>;

/** What proves the desk's work. */
export interface Evidence {
  check: 'pass' | 'fail' | 'none';
  test: 'pass' | 'fail' | 'none';
  /** The last lines of what failed, for the screen, under the check's and the tests' rows. */
  tail: { check: string[]; test: string[] };
  /** Commits since the base, newest first: `<sha> <subject>`. */
  commits: string[];
  /** Files changed and not committed. */
  dirty: number;
  /** HEAD is not the commit last pushed. */
  unpushed: boolean;
  head: string;
}

export type Ending = 'clean' | 'unpushed' | 'failed';

/** Failed when a check failed; unpushed when there is work the remote doesn't have; else clean. */
export const endingOf = (e: Evidence): Ending => (e.check === 'fail' || e.test === 'fail' ? 'failed' : e.dirty > 0 || (e.commits.length > 0 && e.unpushed) ? 'unpushed' : 'clean');

const lines = (text: string): string[] => text.split('\n').map((line) => line.trimEnd()).filter(Boolean);

/** What lstat says a path is: a real file, a real folder, something else (a link), or not there. */
function kindOf(path: string): 'file' | 'folder' | 'other' | 'none' {
  try {
    const stat = lstatSync(path);
    return stat.isFile() ? 'file' : stat.isDirectory() ? 'folder' : 'other';
  } catch {
    return 'none';
  }
}

/**
 * Why git must not run in the desk outside the fence, or null. The AI can write all of .git
 * but its config, hooks and mark. A `commondir` or `gitdir` there, or a `.git` that is a
 * link or a file, sends git to a config the AI wrote, whose filter or hook would run as the
 * person. A `config.worktree` is a second config. Any of these: refused, nothing runs.
 */
export function deskGitProblem(desk: string): string | null {
  const git = join(desk, '.git');
  if (kindOf(git) !== 'folder') return `${git} is not a real folder`;
  if (kindOf(join(git, 'config')) !== 'file') return `${join(git, 'config')} is not a real file`;
  for (const part of ['commondir', 'gitdir', 'config.worktree']) {
    if (kindOf(join(git, part)) !== 'none') return `${join(git, part)} is there: it would point git at a config the desk wrote`;
  }
  return null;
}

/** The words for a refused desk: one line, and the desk is kept as it is. */
export const refusedLine = (problem: string): string => `git does not run in this desk outside the fence: ${problem}. The desk is kept; look at it by hand`;

/**
 * Run git in the desk, outside the fence, only when deskGitProblem finds nothing. git's
 * folder is pinned to the desk's own .git (GIT_DIR, GIT_COMMON_DIR), so a `commondir`
 * planted after the look still never counts; fsmonitor is off.
 */
export function deskGit(run: Run, desk: string, args: string[]): Ran {
  const problem = deskGitProblem(desk);
  if (problem) return { status: 1, stdout: '', stderr: refusedLine(problem) };
  const git = join(desk, '.git');
  return run('git', ['-c', 'core.fsmonitor=false', ...args], desk, { GIT_DIR: git, GIT_COMMON_DIR: git, GIT_WORK_TREE: desk });
}

/** The commits since `base`, newest first. */
export function commitsSince(run: Run, desk: string, base: string): string[] {
  const read = deskGit(run, desk, ['log', '--format=%h %s', `${base}..HEAD`]);
  return read.status === 0 ? lines(read.stdout) : [];
}

/** The files changed and not committed, or the reason git was refused. */
export function dirtyFiles(run: Run, desk: string): string[] | { problem: string } {
  const read = deskGit(run, desk, ['status', '--porcelain']);
  if (read.status !== 0) return { problem: lines(read.stderr)[0] ?? `git status: exit ${read.status}` };
  return lines(read.stdout);
}

/** Commit what the AI left, inside the fence, so the commit check runs. 'nothing' when there was none. */
export async function saveWork(fenced: Fenced, run: Run, desk: string, task: Pick<DeskTask, 'kind' | 'title'> & { number?: number }): Promise<'saved' | 'nothing' | { problem: string }> {
  const dirty = dirtyFiles(run, desk);
  if (!Array.isArray(dirty)) return dirty;
  if (!dirty.length) return 'nothing';
  const about = task.number === undefined ? 'the task' : `#${task.number}`;
  for (const command of [['git', 'add', '-A'], ['git', 'commit', '-q', '-m', `chore(desk): save work in progress on ${about}`]]) {
    const ran = await fenced(command);
    if ('fail' in ran) return { problem: ran.fail };
    if (ran.status !== 0) return { problem: `the work was not saved: ${lines(`${ran.stderr}\n${ran.stdout}`).slice(-1)[0] ?? `exit ${ran.status}`}` };
  }
  return 'saved';
}

/** The project's test command, from package.json, or null when it has none. */
export function testCommand(desk: string): string[] | null {
  try {
    const scripts = (JSON.parse(readFileSync(join(desk, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> }).scripts;
    return typeof scripts?.test === 'string' ? ['npm', 'test'] : null;
  } catch {
    return null;
  }
}

/** Run the check (`check`) and the tests in the fence, and read what the desk did. */
export async function gatherEvidence(fenced: Fenced, run: Run, desk: string, record: DeskRecord, check: string[]): Promise<Evidence> {
  const tail: Evidence['tail'] = { check: [], test: [] };
  const judge = async (command: string[] | null, into: string[]): Promise<'pass' | 'fail' | 'none'> => {
    if (!command) return 'none';
    const ran = await fenced(command);
    if (!('fail' in ran) && ran.status === 0) return 'pass';
    into.push(...('fail' in ran ? [ran.fail] : lines(`${ran.stdout}\n${ran.stderr}`).slice(-5)));
    return 'fail';
  };
  const checked = await judge(check, tail.check);
  const tested = await judge(testCommand(desk), tail.test);
  const head = deskGit(run, desk, ['rev-parse', 'HEAD']).stdout.trim();
  const dirty = dirtyFiles(run, desk);
  // A refused read counts as work not committed: the desk is kept, never moved or called clean.
  return { check: checked, test: tested, tail, commits: commitsSince(run, desk, record.base), dirty: Array.isArray(dirty) ? dirty.length : 1, unpushed: head !== record.pushed, head };
}

/** A line cut to fit under a row's text. */
const fit = (line: string, indent: number): string => (line.length + indent > SCREEN_WIDTH ? `${line.slice(0, SCREEN_WIDTH - indent - 1)}…` : line);

/** The last lines of what failed, under its row's text. */
const under = (tail: string[]): string[] => tail.slice(-5).map((line) => `${' '.repeat(26)}${fit(line, 26)}`);

const RESULT = { pass: 'passed', fail: 'failed', none: 'none here' } as const;

/** The one screen for an ending. `shown` is the desk's folder as the person sees it. */
export function endingScreen(name: string, ending: Ending, e: Evidence, shown: string, extra: string[] = []): string[] {
  const summary = ending === 'clean' ? `desk ${name} is clean: nothing left to push` : ending === 'unpushed' ? `desk ${name} has work that is not pushed` : `desk ${name} failed its checks`;
  const work = e.commits.length ? `${count(e.commits.length, 'commit')}, last: ${e.commits[0]?.replace(/^\S+ /, '')}` : 'no commits';
  return [
    ...title('desk', summary),
    '',
    ...row(e.check === 'fail' ? 'MISSING' : e.check === 'pass' ? 'ok' : 'skipped', RESULT[e.check], 'check'),
    ...under(e.tail.check),
    ...row(e.test === 'fail' ? 'MISSING' : e.test === 'pass' ? 'ok' : 'skipped', RESULT[e.test], 'tests'),
    ...under(e.tail.test),
    ...row(ending === 'unpushed' ? 'next' : 'ok', `${work}${e.dirty ? `; ${count(e.dirty, 'file')} not committed` : ''}${ending === 'unpushed' ? '; not pushed' : ''}`, 'work'),
    ...extra,
    ...(ending === 'clean' ? [] : field('kept', shown)),
    '',
    ...nextLine(ending === 'unpushed' ? `yokoten desk ${name} --pr` : ending === 'failed' ? `yokoten desk ${name}` : 'yokoten desk'),
  ];
}

/**
 * Archive a clean desk, then move it aside (the small helper until `yokoten tidy` lands):
 * a git bundle of every branch, then the clone, its state folder, record and brief into
 * `<home>/trash/<UTC date>/`, with an index.json that says where each came from. Nothing is
 * deleted. When the bundle fails, nothing moves.
 */
export function moveAside(run: Run, home: string, name: string, now: Date): { to: string } | { problem: string } {
  const desk = join(home, name);
  const trash = join(home, 'trash', now.toISOString().slice(0, 10));
  mkdirSync(trash, { recursive: true });
  const bundle = join(trash, `${name}.bundle`);
  const made = deskGit(run, desk, ['bundle', 'create', '-q', bundle, '--all']);
  if (made.status !== 0 || !existsSync(bundle)) return { problem: `the desk was kept: its bundle could not be made (${lines(made.stderr)[0] ?? `exit ${made.status}`})` };
  const to = join(trash, name);
  if (existsSync(to)) return { problem: `the desk was kept: ${to} is already there` };
  const moved: { from: string; to: string }[] = [];
  for (const [from, target] of [[desk, to], [`${desk}.state`, `${to}.state`], [recordFile(home, name), `${to}.json`], [briefFile(home, name), `${to}.brief.md`]] as const) {
    if (!existsSync(from)) continue;
    renameSync(from, target);
    moved.push({ from, to: target });
  }
  const index = join(trash, 'index.json');
  let entries: unknown[] = [];
  try {
    entries = JSON.parse(readFileSync(index, 'utf8')) as unknown[];
  } catch {
    // The first desk moved today makes the index.
  }
  entries.push({ reason: 'desk finished clean', at: now.toISOString(), bundle, moved });
  writeFileSync(index, `${JSON.stringify(entries, null, 2)}\n`);
  return { to };
}

/** How the pull request is opened: as the bot when it is set up, else with the person's own login. */
export interface PullRequestRun {
  run: Run;
  /** The project's main checkout: the push goes from there, with its own hooks. */
  root: string;
  desk: string;
  record: DeskRecord;
  /** The words that run a command as the bot (`node yokoten.ts bot --`), or null for the person's own login. */
  bot: string[] | null;
  evidence: Evidence;
}

/** Push the desk's branch and open its pull request. The URL, or one line that says why not. */
export function openPullRequest({ run, root, desk, record, bot, evidence }: PullRequestRun): { url: string } | { problem: string } {
  const as = (file: string, args: string[]) => (bot ? run(bot[0] ?? '', [...bot.slice(1), file, ...args], root) : run(file, args, root));
  // The project's checkout takes the desk's commits, then pushes them: the desk's own hooks never run outside the fence.
  const refused = deskGitProblem(desk);
  if (refused) return { problem: refusedLine(refused) };
  const fetched = run('git', ['fetch', '-q', desk, record.branch], root);
  if (fetched.status !== 0) return { problem: `git fetch from the desk failed: ${lines(fetched.stderr)[0] ?? `exit ${fetched.status}`}` };
  const pushed = as('git', ['push', '-q', 'origin', `${evidence.head}:refs/heads/${record.branch}`]);
  if (pushed.status !== 0) return { problem: `git push failed: ${lines(pushed.stderr)[0] ?? `exit ${pushed.status}`}` };
  const body = [
    ...(record.task.number === undefined ? [] : [`Closes #${record.task.number}`, '']),
    `Made in a yokoten desk by ${record.agent}. Check: ${RESULT[evidence.check]}; tests: ${RESULT[evidence.test]}.`,
    '',
    ...evidence.commits.map((commit) => `- ${commit}`),
  ].join('\n');
  const opened = as('gh', ['pr', 'create', '--head', record.branch, '--title', record.task.title, '--body', body]);
  if (opened.status !== 0) return { problem: `the branch is pushed, but gh pr create failed: ${lines(opened.stderr)[0] ?? `exit ${opened.status}`}` };
  return { url: lines(opened.stdout).slice(-1)[0] ?? '' };
}

/** The desk's folder as the person sees it: relative to where they are. */
export const shownPath = (cwd: string, path: string): string => relative(cwd, path) || path;
