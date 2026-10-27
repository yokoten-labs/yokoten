// The kanban area's one door to the rest of yokoten (issue #1091). Every other kanban file
// imports only kanban files, src/platform/ and node: modules; what they need from outside
// comes through here, under a kanban name and a kanban shape. Each outside module imported
// below is a line on KANBAN_PORTS (test/repo/architecture.test.ts): when the code behind a
// port is replaced, its import and its line go, so that list is the replacement to-do list.
// Nothing is re-exported: a port is a function or a type written here.

import { ghIn, ghLaterIn, readBoardPulls, readBoardPullsLater, repoOf, repoPageOf, unread } from '../../host/github/index.ts';
import { parseRefusal } from '../../rules/text/message.ts';
import { hideHome, homeOf, loadMarks, makeRedactor } from '../../rules/privacy.ts';
import { commonGitDir, DESK_LIST_FILE, readStatusText } from '../../run/hook.ts';
import { terminalText } from '../../run/learn.ts';
import { HOME_DIR, VERSION } from '../../setup/files.ts';
import { machineMarks, machineUserNames } from '../../setup/install.ts';
import { readOriginUrl } from '../../setup/plan.ts';
import { EMPTY_SCHEDULE, planSchedule, scheduleIssueOf, summarizeSchedule } from '../more/advice/schedule.ts';
import { actionsRunPage, actionsRunsQuery, healthReadFailed, readActionsRuns, readDefaultBranch, summarizeActionsHealth } from '../more/check.ts';
import { count, field, moreLine, parse, print, requireRoot, row, title, usage } from '../shared.ts';

// ---- Shapes ----

/** The environment a kanban read runs with. */
export type KanbanEnv = Record<string, string | undefined>;

/** Where a command writes: the process's stream, or a test's. */
export type RunOutput = NodeJS.WritableStream & { isTTY?: boolean; fd?: number };

/** Where a command reads its standard input from. Never spread or copy it: `stream` is made only when read. */
export interface RunInput {
  fd: number | null;
  text: string | null;
  readonly stream: NodeJS.ReadableStream & { isTTY?: boolean };
}

/** One run of `yokoten kanban`, as plain data: bin/main.ts makes it, a test makes its own. */
export interface CommandRun {
  command: string | undefined;
  args: string[];
  env: KanbanEnv;
  cwd: string;
  stdout: RunOutput;
  stderr: RunOutput;
  stdin: RunInput;
  script: string;
  platform?: NodeJS.Platform;
}

/** The command line, read by the options the command's help lists. */
export interface ParsedWords {
  flags: Set<string>;
  values: Record<string, string>;
  positional: string[];
}

/** The state word a text row starts with. */
export type RowState = 'ok' | 'done' | 'next' | 'to do' | 'MISSING' | 'note' | "can't check" | 'skipped';

/** Runs gh with these words and answers its output; throws when gh fails. */
export type GhCall = (args: string[]) => string;

/** gh that may answer later; `signal` stops a call nobody waits for any more. */
export type GhCallLater = (args: string[], signal?: AbortSignal) => string | Promise<string>;

/** One pull request on the board. */
export interface PullRow {
  number: number;
  title: string;
  branch: string;
  url: string;
  stage: 'merged' | 'closed' | 'draft' | 'open';
  /** A fail wins over running. */
  checks: 'pass' | 'fail' | 'running' | 'none';
  /** The tier from its labels, or '' when it has none. */
  tier: '' | 'A' | 'B' | 'C';
  review: 'approved' | 'changes' | 'waiting' | 'none';
  /** True when an Approve is on the head commit. */
  isApprovedOnHead: boolean;
  /** When it merged, as gh gives it, or ''. */
  mergedAt: string;
}

/** One GitHub Actions run, with GitHub's own ISO times. */
export interface ActionsRun {
  id: number;
  workflow: string;
  event: string;
  branch: string;
  status: string;
  conclusion: string;
  createdAt: string;
  startedAt: string;
  updatedAt: string;
  url: string;
}

/** What the board takes from the Actions health summary of one branch. */
export interface BranchHealth {
  /** The ids of the runs that count as failing the branch. */
  failedIds: number[];
  /** The workflows that both passed and failed, by branch. */
  unstable: { workflow: string; branch: string }[];
}

/** A refusal by its parts: the rule id, its title, why, the safe way, and the docs link. */
export interface RefusalParts {
  id: string;
  title: string;
  why: string;
  fix: string;
  docs: string;
}

/** One open issue, as the schedule needs it. */
export interface ScheduleInput {
  number: number;
  title: string;
  dependsOn?: readonly number[];
  labels?: readonly string[];
  milestone?: string | null;
}

/** The schedule as issue numbers: ready now, the whole order, cycles, the blocked, and the longest chain. */
export interface ScheduleNumbers {
  ready: number[];
  order: number[];
  cycles: number[][];
  blocked: number[];
  criticalPath: number[];
}

/** The machine now, and why another agent cannot start, or null when one can. */
export interface MachineRoom {
  running: number;
  freeMemoryMb: number;
  hold: 'slots' | 'memory' | null;
}

// ---- The command line and text ----

export const parseWords = (name: string, words: string[]): ParsedWords | string => parse(name, words);
export const printLines = (run: CommandRun, lines: string[], stream?: RunOutput): void => print(run, lines, stream);
export const usageError = (run: CommandRun, error: string): number => usage(run, error);
/** The project root above `dir`, or null after saying why there is none. */
export const projectRoot = (run: CommandRun, dir: string): string | null => requireRoot(run, dir);
export const titleLines = (command: string, summary: string): string[] => title(command, summary);
export const rowLines = (state: RowState, text: string, label?: string): string[] => row(state, text, label);
export const fieldLines = (label: string, text: string): string[] => field(label, text);
export const moreLines = (text: string): string[] => moreLine(text);
/** "1 file", "3 files". */
export const counted = (n: number, one: string, many?: string): string => count(n, one, many);
/** Text with control and bidi characters escaped, safe to print on a terminal. */
export const terminalSafe = (text: string): string => terminalText(text);

// ---- yokoten itself ----

/** The folder yokoten runs from. */
export const yokotenHome = (): string => HOME_DIR;
export const yokotenVersion = (): string => VERSION;

// ---- Git and desks ----

/** The git folder all worktrees of `folder` share, or null. */
export const sharedGitDir = (folder: string): string | null => commonGitDir(folder);
/** The file name, in the shared git folder, of the desk list. */
export const deskListFile = (): string => DESK_LIST_FILE;
/** A status file's text, or null when it cannot be read safely. */
export const readStatusFile = (path: string): string | null => readStatusText(path);
export const originUrl = (root: string, env: KanbanEnv): string => readOriginUrl(root, env);

// ---- Privacy ----

/** HOME when it is an absolute path, else null. */
export const homeFolderOf = (env: KanbanEnv): string | null => homeOf(env);
/** `text` with the home folder written as ~. */
export const hideHomeIn = (text: string, env: KanbanEnv): string => hideHome(text, env);

/**
 * The masks of `yokoten redact` for this machine: secrets, private email addresses, the home
 * folder, the private marks and the machine's own names. Throws when the marks can't be read.
 */
export function privateMask(env: KanbanEnv, root: string): (text: string) => string {
  const found = machineMarks(env, { cwd: root });
  return makeRedactor(
    {
      marks: loadMarks(env),
      owners: [...found.filter((mark) => mark.kind === 'git name' || mark.kind === 'git email').map((mark) => mark.value), ...machineUserNames(env)],
      hosts: found.filter((mark) => mark.kind === 'private remote host').map((mark) => mark.value),
    },
    env,
  );
}

/** A refusal's parts from the text yokoten printed, or null when it holds none. */
export const refusalOf = (text: string): RefusalParts | null => parseRefusal(text);

// ---- GitHub ----

export const ghRunner = (cwd: string, env: KanbanEnv, timeout?: number): GhCall => ghIn(cwd, env, timeout);
export const ghRunnerLater = (cwd: string, env: KanbanEnv, timeout?: number): GhCallLater => ghLaterIn(cwd, env, timeout);
/** "owner/name" from a GitHub remote URL, or null. */
export const repoNameOf = (remote: string): string | null => repoOf(remote);
export const repoPage = (repo: string): string => repoPageOf(repo);
/** The board's pull requests, or why they could not be read. */
export const readPulls = (gh: GhCall, repo: string): PullRow[] | string => readBoardPulls(gh, repo);
export const readPullsLater = (gh: GhCallLater, repo: string, signal?: AbortSignal): Promise<PullRow[] | string> => readBoardPullsLater(gh, repo, signal);

// ---- Actions ----

/** The repo's default branch, or `main` when gh can't say. */
export const defaultBranchOf = (gh: GhCall, repo: string): string => readDefaultBranch(gh, repo);
export const readRuns = (gh: GhCall, repo: string, max?: number): ActionsRun[] | string => readActionsRuns(gh, repo, max);
/** The gh words that read one page of Actions runs. */
export const runsQuery = (repo: string, page?: number): string[] => actionsRunsQuery(repo, page);
export const runsPage = (text: string): { runs: ActionsRun[]; rows: number } | string => actionsRunPage(text);
/** Why a read of `what` failed, as one sentence. */
export const readFailedText = (err: unknown, what: string): string => healthReadFailed(err, what);
/** Why gh failed, in yokoten's words, from what gh printed: such as "gh is not signed in". */
export const ghFailureCause = (said: string): string => unread({ stderr: said }).unread;

/** The failing runs and the unstable workflows, from the same summary as `yokoten ci-health`. */
export function branchHealth(runs: ActionsRun[], defaultBranch: string): BranchHealth {
  const health = summarizeActionsHealth(runs, [], defaultBranch);
  return { failedIds: health.mainFailures.map((run) => run.id), unstable: health.unstable.map(({ workflow, branch }) => ({ workflow, branch })) };
}

// ---- The schedule ----

/** The schedule of these open issues. */
export const scheduleOfIssues = (issues: readonly ScheduleInput[]): ScheduleNumbers => summarizeSchedule(planSchedule(issues.map(scheduleIssueOf)));
/** A schedule with nothing in it. */
export const emptySchedule = (): ScheduleNumbers => ({ ...EMPTY_SCHEDULE });
