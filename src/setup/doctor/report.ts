import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Config, type Env } from '../../rules/config.ts';
import { type Finding, finding, findingRow, fixCommand, fixText, formatFindingMarks, formatNote, leadingCommand, place, sentence } from '../../rules/text/message.ts';
import { moreLine, nextLine, row, type RowMark, screen, SCREEN_ROWS, section, spaced, title, underRow, wrap } from '../../rules/text/screen.ts';
import { hideHome, homeOf, isUtcTimeZone, timeZoneFix } from '../../rules/privacy.ts';
import { guardLine } from '../../host/light.ts';
import { check } from '../../run/check.ts';
import { countNotes, waitingLine } from '../../run/learn.ts';
import { type Gh, type GhLater, readServer, type ServerSettings, type Unread } from '../../host/github/index.ts';
import { type Host, hostOf, isNoAdapter, noAdapter } from '../../host/hosts.ts';
import { readUnsaved, unsavedNotes } from '../advice/unsaved.ts';
import { VERSION } from '../files.ts';
import { hookCliPath, isSelf, withGitReads, workflowNotes } from '../init.ts';
import { gitConfig } from '../../run/check.ts';
import { fillMarks, marksState, UNREADABLE_MARKS, UNREADABLE_MARKS_FIX, filledLines, trySafely, machineMarks, paths } from '../install.ts';
import { type Mark, missingPaths, readDefaultBranchFiles, road, ROAD, ROAD_SERVER_IDS, type ServerCheck, serverChecks, type ServerRead, STAGES, stepFinding, stepText, uncheckedText, walk } from '../road.ts';
import { hasUserSettings } from '../../agents/runtimes/claude-code.ts';
import { agentHooks, allowedMarkCount, commandWording, conflictNote, coreRulesCheck, deskFenceCheck, doubleInstallCheck, editedKitCheck, launcherCheck, machineChecks, mergeTimeZones, museClaudeRules, pluginAgeCheck, privacyNotes, releaseChannel, userAgentHooks, type Practice } from './checks.ts';
import { findStateFile, type LessonCheck, lessonChecks, lessonRows, readState, saveState, seenAfter, sessionLessonNote, stageFileFor, STATE_FILE } from './lessons.ts';
import { agentTempDirCheck, diskSpaceChecks, leftoverTempCheck, nodeSecurityCheck, type MachineProbe, REAL_MACHINE } from './machine.ts';
import { pluginSourceNote } from '../advice/marketplace.ts';
import { makeTempDir, type MakeTemp, noTempLine, SELF_TEST } from './self-test.ts';
import { hostPathPlace } from '../../platform/paths.ts';

/** "1 step", "3 steps": a count with its noun in the right number (as `count` in src/commands/shared.ts). */
const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** What doctor can't read on the server yet, and the owner sets once per repo. */
const OWNER_STEPS = ['the bot: a GitHub App (or collaborator) with write access; CODEOWNERS sends CI changes to you'];

/** The settings to check by hand when doctor can't read the server. */
const BY_HAND = [
  'main: a ruleset with pull request required, the CI check required, code owner review, no force push, no deletion; squash merge only, delete branch on merge',
  'tags: a ruleset on v* so only you create, move or delete a release tag',
  'release: in Settings, Environments, create release, add yourself as a required reviewer, and add a Tag rule named v*',
  'security: in Settings, Advanced Security, turn on private vulnerability reporting, secret scanning with push protection, and Dependabot alerts',
];

/**
 * What a board needs that the host's API can't set (#156). Listed only when a board is
 * linked, and never a failure: the board is optional.
 */
const BOARD_BY_HAND = [
  'views: a Board view grouped by Status (and a Table or Roadmap view by milestone, if you like)',
  'workflow "Auto-add to project": on, for this repo\'s issues and pull requests',
  'workflow "Item closed": sets Status to Done',
  'workflow "Pull request merged": sets Status to Done',
];

/** The by-hand steps for each board linked to the repo; none when there is no board or it can't be read. */
export function listBoardSteps(server: ServerRead): string[] {
  if (!server || 'unread' in server || !Array.isArray(server.boards)) return [];
  return server.boards.flatMap((board) => BOARD_BY_HAND.map((step) => `board "${board.title}": ${step}`));
}

/**
 * How long full doctor waits for the GitHub reads, all of them together: they run at once, and
 * a read still out past it makes its server steps say they can't check, and why (#561, #1039).
 */
export const SERVER_TIMEOUT_MS = 5000;

/** Why the server can't be read in a repo with no origin remote; the road shows it once (#502). */
const NO_REMOTE = 'there is no origin remote yet';
const NO_REMOTE_FIX = 'make the repo on your code host, add it as origin with `git remote add origin <url>`, and push; then run `yokoten doctor` again';

/** The server settings of the origin's host, or why they can't be read. A host with no adapter is read without the network (#504). */
function readOrigin(host: Host, gh: Gh): ServerSettings | Unread {
  if (host.kind === 'none') return { unread: NO_REMOTE, fix: NO_REMOTE_FIX };
  if (host.kind === 'github') return readServer(gh, host.repo);
  // Gitea is read by the command, which can wait for the network (#505).
  if (host.kind === 'gitea') return { unread: 'the Gitea settings were not read', fix: 'run `yokoten doctor`' };
  return noAdapter(host);
}

/**
 * In yokoten's own repo only, a note when lessons from other projects wait in the inbox
 * (#392). Elsewhere nothing: the inbox is for whoever works on yokoten. One readdir and
 * the package.json read, no child process, so the session start stays fast.
 */
export function upstreamNote(root: string, env: Env): Finding | null {
  if (!isSelf(root)) return null;
  const line = waitingLine(countNotes(env));
  return line ? finding('upstream-inbox', line, 'open an issue for each, then remove its note with `yokoten learn --upstream --done <id>`') : null;
}

/** What a project with CI off leaves unchecked (#377): said once, in full doctor, so the trade-off stays visible. */
export const NO_CI_GAPS = 'CI is off ("notNow" names `ci`), so nothing on the server checks pull requests, issue titles or the workflows, no code scanning such as CodeQL runs, and a commit made with the hook off reaches main unchecked';

/**
 * The note for a project that keeps CI off (#377), or null when "notNow" does not name
 * `ci`. Its fix says what to run by hand instead. From stage 5, or when full doctor read
 * that the repo is public, it also says how to end the choice.
 */
export function noCiNote(notNow: Record<string, string>, stage: number | null, server: ServerRead): Finding | null {
  if (!Object.hasOwn(notNow, 'ci')) return null;
  const isPublic = server !== undefined && !('unread' in server) && server.isPrivate === false;
  const end = 'remove "ci" from "notNow" in yokoten.json, then run `yokoten init` to add the workflows';
  if (isPublic) return finding('no-ci', NO_CI_GAPS, `this repo is public now, and Actions cost no minutes on a public repo: ${end}`);
  const byHand = 'before each merge, run `yokoten check --pr <number>` and the tests';
  return finding('no-ci', NO_CI_GAPS, stage === null || stage >= 5 ? `${byHand}; when the repo goes public, ${end}` : byHand);
}

/** At most this many notes about unsaved work in a session; full doctor lists them all. */
const SESSION_UNSAVED_LIMIT = 3;

/** What the agent does with the unsaved-work lines. */
export const UNSAVED_OFFER = 'Tell the user what is only on this machine, and offer to run the command that saves it.';

/** How long a session may spend on the unsaved-work read: a session must not wait on a cold disk. Full doctor has no limit. */
export const SESSION_UNSAVED_BUDGET = 1000;

/** The line when the session's read ran out of time. */
export const STOPPED_EARLY = 'yokoten: doctor stopped early; `yokoten doctor` lists all.';

/**
 * What a session hears about work only on this machine (#365): only what is at risk, a
 * few lines at most, read within the time budget. `clock` is for a test.
 */
export function sessionUnsaved(root: string, env: Env, clock?: () => number): { lines: string[]; notes: Finding[]; commonDir: string | null } {
  const facts = readUnsaved(root, { env, budget: { ms: SESSION_UNSAVED_BUDGET, ...(clock ? { clock } : {}) } });
  // The git folder it read on the way, so the session's lesson note asks git no more (#339).
  const commonDir = facts?.commonDir || null;
  const notes = facts ? unsavedNotes(facts, { home: env.HOME, session: true }) : [];
  const stopped = facts?.isPartial ? [STOPPED_EARLY] : [];
  if (!notes.length) return { lines: stopped, notes, commonDir };
  const more = notes.length - SESSION_UNSAVED_LIMIT;
  const lines = notes.slice(0, SESSION_UNSAVED_LIMIT).map((f) => `yokoten: ${stepText(f)}.`);
  if (more > 0) lines.push(`yokoten: ${more} more like this; \`yokoten doctor\` lists them all.`);
  return { lines: [...lines, ...stopped, UNSAVED_OFFER], notes, commonDir };
}

// A compaction start (#405). The agent keeps a summary of what it heard, so hearing the
// same notes again after each compaction is noise. Each session keeps what it was told in
// a small file, by the agent's session id; a compaction start then says only what is new.

/** How the agent says a session started. `source` "compact" is a start after a compaction. */
export interface SessionStart {
  sessionId: string;
  source: string;
  /** The model the session runs, when the runtime says (#685), else ''. */
  model?: string;
}

/** A session's file is removed after this many days. */
const SESSION_FILE_DAYS = 7;

/** The folder of the per-session files. Throws NO_HOME with no home folder. */
export const sessionsDir = (env: Env): string => join(paths(env).config, 'sessions');

/**
 * The blocks to print at this start. A compaction start drops the blocks this session
 * was already told; any other start prints all, as before. Every start adds what it
 * prints to the session's file. With no session, or a file that can't be read or
 * written, it prints all.
 */
export function blocksToSay(env: Env, start: SessionStart | null, blocks: string[][], now = Date.now()): string[][] {
  if (!start) return blocks;
  try {
    const dir = sessionsDir(env);
    const file = join(dir, `${start.sessionId}.json`);
    const isCompact = start.source === 'compact';
    let said: string[] = [];
    if (isCompact) {
      try {
        const saved = JSON.parse(readFileSync(file, 'utf8'));
        if (Array.isArray(saved?.said)) said = saved.said.filter((text: unknown) => typeof text === 'string');
      } catch {
        // no file yet: the first start was before this version, so say all
      }
    } else removeOldSessionFiles(dir, now);
    const isSaid = new Set(said);
    const fresh = blocks.filter((block) => !isSaid.has(block.join('\n')));
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, `${JSON.stringify({ said: [...said, ...fresh.map((block) => block.join('\n'))] })}\n`);
    return fresh;
  } catch {
    return blocks;
  }
}

/** Removes the session files not written to for SESSION_FILE_DAYS. A file that can't be removed stays. */
function removeOldSessionFiles(dir: string, now: number): void {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    try {
      if (now - statSync(join(dir, name)).mtimeMs > SESSION_FILE_DAYS * 86_400_000) rmSync(join(dir, name));
    } catch {
      // gone already, or not ours to remove
    }
  }
}

/** What a session hears when the road is done, as far as yokoten can check. */
export const ROAD_DONE = 'yokoten: every step yokoten can check is done, or marked not now.';

/** The last line of the road's block at a session start: what the agent does with the step. */
export const OFFER = 'Tell the user in plain words, one step at a time, and offer to do it (as-is, lighter, or not now with a reason).';

/**
 * Added to that line when doctor runs from the Claude Code plugin's hook: there is no
 * `yokoten` command on the PATH, so the agent runs the plugin's commands.
 */
export const PLUGIN_COMMANDS = 'In this session, yokoten runs as /yokoten:init, /yokoten:doctor and /yokoten:update.';

/**
 * One step in the JSON map: its mark, how it is judged and why it matters (the road step's
 * own text, so a reader can show it for a done step too, #1203), its outside standard, and
 * the reason for "not now".
 */
export interface StepState {
  id: string;
  stage: number;
  mark: Mark;
  /** Always set by doctor; optional so a hand-built report for a screen test may leave it out. */
  how?: string;
  why?: string;
  standard?: string;
  reason?: string;
}

/**
 * What `doctor --json` prints. `findings` is everything to do, each with what, why and
 * fix; `notes` never fail doctor. `ok` is false only for a problem (#208): the self-test,
 * core rules that are behind, a tree finding or a machine check. A road step not taken
 * yet is to do, not a problem, so it never makes `ok` false. A session (`--session`) gets the next step, the
 * private-marks finding, a behind `core-rules` finding and, in yokoten's own repo, the
 * `upstream-inbox` note only, as its lines do.
 */
export interface DoctorReport {
  version: string;
  /** The release channel this machine runs: stable, beta or dev (#632). */
  channel: string;
  ok: boolean;
  /**
   * `ok` means no check failed. `ran` is false when a control found no temp folder and did
   * not run (#1108): `skipped` names it, `reason` says why, and `ok` stays true.
   */
  selfTest: { ok: boolean; failed: string[]; ran: boolean; skipped: string[]; reason?: string };
  /** False outside a git repo: then there is no road to walk. */
  repo: boolean;
  stage: number | null;
  stages: string[];
  next: Finding | null;
  findings: Finding[];
  steps?: StepState[];
  notes?: Finding[];
  server?: { id: string; mark: ServerCheck['mark'] }[];
  /** The kit's lessons, run against this project (#147). Their findings are in `notes`. */
  lessons?: { id: string; mark: LessonCheck['mark']; reason?: string; isNew?: boolean }[];
  /** What the screens show past these fields; `--json` leaves it out (`reportJson`). */
  view?: DoctorView;
}

/** What doctor says when HOME is empty or not a full path, and the system names no home either (#404). */
export const NO_HOME_NOTE = "no home folder found; yokoten can't read or keep its settings (set HOME to your home folder's full path)";

/**
 * The report, and whether doctor found no problem. Each git answer is kept for the run
 * (`withGitReads`, #408). `lines` and `blocks` are the screens built from the report, for a
 * caller that reads text: the full map, or a session's blocks.
 */
export const doctor = (root: string | null, options: Parameters<typeof doctorRun>[1]): { ok: boolean; report: DoctorReport; lines: string[]; blocks?: string[][] } => {
  // The system is read once, here or by the caller, and passed down (record 0040).
  const platform = options.platform ?? hostPathPlace().platform;
  const run = withGitReads(() => doctorRun(root, { ...options, platform }));
  const reword = commandWording(options.env, platform);
  const { ok, report: worded } = reword ? rewordStrings(run, reword) : run;
  // The screens wrap their text once, so the home folder is ~ before they do: a long path
  // shown as ~ later would leave a line cut short (core rule 11).
  const report = worded.view ? { ...worded, view: { ...rewordStrings(worded.view, (text) => hideHome(text, options.env)), ...(reword ? { npx: true } : {}) } } : worded;
  if (!options.session || !root) return { ok, report, lines: fullLines(report) };
  const blocks = sessionBlocks(report, { isPlugin: Boolean(options.env.CLAUDE_PLUGIN_ROOT) });
  return { ok, report, lines: blocks.flat(), blocks };
};

/** `value` with `reword` applied to every string in it (plain arrays and objects only). */
function rewordStrings<T>(value: T, reword: (text: string) => string): T {
  if (typeof value === 'string') return reword(value) as T;
  if (Array.isArray(value)) return value.map((item) => rewordStrings(item, reword)) as T;
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewordStrings(item, reword)])) as T;
  }
  return value;
}

/**
 * Why one stage that a jump passed does not hold the road back: what its steps are, by mark
 * (#514). A step already done and a step yokoten can't check yet get their own words, so the
 * line says which reason applies instead of joining both with "or".
 */
function stageJumpText(marks: Mark[]): string {
  const countOf = (mark: Mark) => marks.filter((each) => each === mark).length;
  const done = countOf('done');
  if (done === marks.length) return 'its steps were already in place';
  const unchecked = countOf("can't check");
  const later = countOf('not now');
  const parts: string[] = [];
  if (done) parts.push(`${done} of its steps ${done === 1 ? 'was' : 'were'} already in place`);
  if (unchecked) parts.push(`${unchecked} can't be checked yet`);
  if (later) parts.push(`${later} ${later === 1 ? 'is' : 'are'} marked not now`);
  return parts.join(', ').replace(/, ([^,]*)$/, ' and $1');
}

/**
 * What one guard call costs on this machine (#461): wall time and CPU time, from one real
 * run of the guard on a trivial command. The project's own copy when it has one, else the
 * copy that runs doctor. A report line, never a failure; null when there is nothing to run
 * or the machine can't measure. Full doctor only: a session must start fast.
 */
export function guardCostCheck(root: string, probe: MachineProbe, env: Env): Practice | null {
  if (!probe.measureGuard) return null;
  const own = join(root, hookCliPath(root));
  const cli = existsSync(own) ? own : fileURLToPath(new URL('../../../bin/yokoten.mjs', import.meta.url));
  const cost = probe.measureGuard(cli, root, env);
  return cost ? { name: 'guard', ok: true, finding: finding('guard-cost', '', ''), detail: guardLine(cost) } : null;
}

/**
 * One line of a session note, wrapped once at 80 columns (#1099). A `yokoten: ` line goes
 * on under its own text, so each note reads as one item; any other line wraps at the edge.
 */
export const noteLines = (line: string): string[] => (line.startsWith('yokoten: ') ? wrap('yokoten: ', line.slice('yokoten: '.length)) : wrap('', line));

/**
 * The road's block at a session start (#1099): the stage, then the next step and why as
 * aligned rows, then what the agent does with it, last. A step whose fix starts with a
 * command gets that command on a `Fix` row of its own, under the why (#1115).
 */
const roadLines = (stage: number, next: Finding, offer: string): string[] => {
  const command = leadingCommand(next.fix);
  return spaced([
    [`yokoten: stage ${stage} of ${STAGES.length}, ${STAGES[stage - 1]}`],
    findingRow('Next', `${sentence(command ? next.what : stepText(next))}.`),
    findingRow('Why', `${sentence(next.why)}.`),
    ...(command ? [findingRow('Fix', fixText(command))] : []),
    wrap('', offer),
  ]);
};

// ---- What the screens show, as data (plan 6.4, #1115) ----
//
// doctorRun reads and computes; it returns the report and nothing printed. The report's
// `view` holds what the screens show past the JSON fields, and `reportJson` leaves it out,
// so `--json` keeps its shape. fullLines, shortLines and sessionBlocks are pure functions of
// the report, built only with src/rules/text/screen.ts.

/** One row of the full map: its mark, the check's name (empty when its text says it all), what it found, and the fix. */
export interface CheckRow {
  mark: RowMark;
  name: string;
  what?: string;
  /** A fix that starts with a command goes on a `Fix` line under a problem row (#1115). */
  fix?: string;
}

/** How much a session note matters (#930): security first, then work only on this machine, then setup, then the rest. */
export type NoteRank = 0 | 1 | 2 | 3;
const SECURITY: NoteRank = 0;
const ONLY_HERE: NoteRank = 1;
const SETUP: NoteRank = 2;
const OTHER: NoteRank = 3;

/** A note a session start may say: a finding, or `yokoten: ` sentences, one item each. */
export type SessionNote = { rank: NoteRank; finding: Finding } | { rank: NoteRank; lines: string[] };

/** The full map's parts, each a list of rows. */
export interface FullView {
  /** The version that runs, and its self-test. */
  version: CheckRow;
  /** The stages a jump passed since the last full doctor (#514), one sentence each. */
  jumps: string[];
  /** The rows of each stage, in the order of STAGES. */
  stages: CheckRow[][];
  project: CheckRow[];
  unsaved: CheckRow[];
  machine: CheckRow[];
  server: CheckRow[];
  /** The shell's time zone, when it is not UTC (#932). */
  timeZone?: CheckRow;
}

/** What the screens show past the JSON fields. `--json` leaves it out (`reportJson`). */
export interface DoctorView {
  /** True when the text says `npx yokoten`: no launcher on the PATH runs yokoten (#500). */
  npx?: boolean;
  /** Sentences that come before everything: a broken self-test, no temp folder. */
  lead: string[];
  /** A session's notes, before the cap (#930). */
  session?: SessionNote[];
  /** The full map, for full doctor. */
  full?: FullView;
}

/** A yokoten command as this machine runs it: `yokoten <words>`, or `npx yokoten <words>` (#500). */
const commandOf = (report: DoctorReport, words: string): string => `${report.view?.npx ? 'npx ' : ''}yokoten ${words}`;

/** The report as `--json` prints it: every field but the screens' `view`. */
export function reportJson(report: DoctorReport): Omit<DoctorReport, 'view'> {
  const json = { ...report };
  delete json.view;
  return json;
}

/** The most blocks a session start says (#930): where the project is with the next step, the most important note, and how many more. */
export const SESSION_BLOCKS_MOST = 3;

/** What a session start knows that the report does not: whether the Claude Code plugin's hook runs it. */
export interface SessionPlace {
  isPlugin: boolean;
}

/** A session note as its block of lines. */
const noteBlock = (note: SessionNote): string[] => ('finding' in note ? formatNote(note.finding) : note.lines.flatMap(noteLines));

/**
 * The blocks a session start says (#405, #930), from the report: a broken self-test first,
 * then the road (where the project is, the one next step), then the notes by rank. At most
 * SESSION_BLOCKS_MOST blocks past the self-test: the security notes share one block and always
 * show; when more notes wait, the most important ones show and one line counts the rest. The words of each block are the ones agents read.
 */
export function sessionBlocks(report: DoctorReport, { isPlugin }: SessionPlace): string[][] {
  const lead = (report.view?.lead ?? []).map(noteLines);
  const road = report.stage !== null && report.next ? roadLines(report.stage, report.next, isPlugin ? `${OFFER} ${PLUGIN_COMMANDS}` : OFFER) : noteLines(ROAD_DONE);
  // A stable sort: notes of one rank keep the order doctor read them in.
  const sorted = (report.view?.session ?? []).map((note, at) => ({ note, at })).sort((a, b) => a.note.rank - b.note.rank || a.at - b.at).map(({ note }) => note);
  // Security notes are never folded into the count: they share one block, so the cap holds and each one is said.
  const security = sorted.filter((note) => note.rank === SECURITY).flatMap(noteBlock);
  const notes = [...(security.length ? [security] : []), ...sorted.filter((note) => note.rank !== SECURITY).map(noteBlock)];
  const room = SESSION_BLOCKS_MOST - 1;
  if (notes.length <= room) return [...lead, road, ...notes];
  const shown = notes.slice(0, room - 1);
  const more = notes.length - shown.length;
  return [...lead, road, ...shown, noteLines(`yokoten: ${count(more, 'more note')}; \`${commandOf(report, 'doctor --all')}\` lists ${more === 1 ? 'it' : 'them'}.`)];
}

/** A problem row: its mark says it needs a hand. Only these rows put their command on a Fix line. */
const isProblemMark = (mark: RowMark): boolean => mark === 'MISSING' || mark === "can't check";

/** The command a problem row puts on its Fix line, or null: a row that is no problem, or a fix that is a sentence. */
const fixOf = (check: CheckRow) => (check.fix && isProblemMark(check.mark) ? fixCommand(check.fix) : null);

/**
 * One row of the full map. A problem whose fix starts with a command ends with
 * `Fix: \`<command>\`` on a line of its own, under the last row that command fixes, so a
 * screen says each fix once (#1115): `lastFixed` maps each command to that row. Any other
 * row keeps its fix in its text, as before.
 */
function checkRowLines(check: CheckRow, lastFixed: ReadonlyMap<string, CheckRow>): string[] {
  const head = check.name && check.what ? `${check.name}: ${check.what}` : check.name || (check.what ?? '');
  if (!check.fix) return row(check.mark, head);
  const command = fixOf(check);
  if (!command) return row(check.mark, `${head}; ${check.fix}`);
  return [
    ...row(check.mark, head),
    ...(command.then ? underRow(`${sentence(command.then)}${/[.!?]$/.test(command.then) ? '' : '.'}`, false) : []),
    ...(lastFixed.get(command.command) === check ? underRow(`Fix: \`${command.command}\``, false) : []),
  ];
}

/** Rows under a heading, a blank line between them when one wraps. Empty with no rows. */
const checkSection = (heading: string, checks: readonly CheckRow[], lastFixed: ReadonlyMap<string, CheckRow>): string[] => section(heading, spaced(checks.map((check) => checkRowLines(check, lastFixed))));

/** The one-line summary of where the project is: the stage, or that the road is done. */
export const doctorSummary = (report: DoctorReport): string =>
  report.stage === null ? `all ${STAGES.length} stages done` : `stage ${report.stage} of ${STAGES.length}, ${STAGES[report.stage - 1]}`;

/** The problems of the report: findings that are not road steps. They fail doctor, so a screen never folds them. */
const problemsOf = (report: DoctorReport): Finding[] => {
  const stepIds = new Set((report.steps ?? []).map((step) => step.id));
  return report.findings.filter((one) => !stepIds.has(one.id) && (report.next === null || one !== report.next));
};

/** The command to type next: the first problem's, else the next step's; null when nothing is left. */
export function doctorNext(report: DoctorReport): string | null {
  for (const problem of problemsOf(report)) {
    const command = fixCommand(problem.fix);
    if (command) return command.command;
  }
  return report.next ? nextCommand(report.next) : null;
}

/**
 * `yokoten doctor --all`, the whole map, from the report: the title, the version, each stage
 * with its steps, then the project, the work only on this machine, the machine and the server,
 * each a section of rows (#1027, #1115). Every row starts its text in one column.
 */
export function fullLines(report: DoctorReport): string[] {
  const lead = (report.view?.lead ?? []).map(noteLines);
  const full = report.view?.full;
  if (!report.repo || !full) return screen(...lead);
  // Each command's Fix line goes under the last problem row it fixes, in screen order.
  const lastFixed = new Map<string, CheckRow>();
  for (const check of [full.version, ...full.stages.flat(), ...full.project, ...full.unsaved, ...full.machine, ...full.server, ...(full.timeZone ? [full.timeZone] : [])]) {
    const command = fixOf(check);
    if (command) lastFixed.set(command.command, check);
  }
  const next = doctorNext(report);
  return screen(
    ...lead,
    title('doctor', doctorSummary(report)),
    spaced([checkRowLines(full.version, lastFixed), ...full.jumps.map((jump) => row('done', jump))]),
    ...STAGES.map((name, at) => checkSection(`Stage ${at + 1}, ${name}`, full.stages[at] ?? [], lastFixed)),
    checkSection('Project', full.project, lastFixed),
    checkSection('Unsaved work, only on this machine', full.unsaved, lastFixed),
    checkSection('Machine', full.machine, lastFixed),
    checkSection('Server, read only; the owner sets these once per repo', full.server, lastFixed),
    full.timeZone ? checkRowLines(full.timeZone, lastFixed) : [],
    next ? nextLine(next) : [],
  );
}

// What `yokoten doctor` shows by default (issue #1027): one screen. Owner 2026-10-25, after running it
// himself: "我是新手，看到这么一堆文字，就被劝退了" (as a beginner, this wall of text made me give up).
// Flutter's doctor shows a summary unless asked for detail; Homebrew's shows only what is wrong.
// `yokoten doctor --all` keeps the full map. The same text for a person and an agent.

/** Each road step as a task, in plain words for a beginner. A test keeps it in step with the road. */
export const STEP_TITLES: Record<string, string> = {
  rules: 'Write the rules for your agents (AGENTS.md)',
  'tool-hook': "Turn on the guard for your agents' commands",
  'commit-check': 'Check each commit before it is made',
  runtime: 'Add the yokoten runtime to the project',
  tests: 'Run your tests on every push',
  remote: 'Put the project on GitHub or Gitea',
  ci: 'Run the checks on every pull request',
  issues: 'Turn on issues',
  templates: 'Add issue and pull request templates',
  labels: 'Add the standard labels',
  milestone: 'Add a first milestone',
  'no-build-output': 'Keep build output out of git',
  changelog: 'Keep a changelog',
  titles: 'Check pull request titles',
  codeowners: 'Name the owner (CODEOWNERS)',
  bot: 'Set up the bot account',
  skills: 'Install the yokoten skills',
  sandbox: 'Keep your agents in a sandbox',
  review: 'Ask for a review before a merge',
  'security-files': 'Add a license and a security policy',
  protection: 'Protect the main branch',
  'merge-settings': 'Set the merge settings',
  'security-settings': 'Turn on the security settings',
  'tag-bypass': 'Let only you create release tags',
  'release-reviewer': 'Approve each release yourself',
  'release-tag-rule': 'Limit releases to version tags',
};

/** The command to type for a step: one its fix names, or else `yokoten explain`, which says what to do. */
export function nextCommand(next: Finding): string {
  const named = [...next.fix.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? '').find((c) => /^(yokoten|npx yokoten|git) /.test(c));
  return named ?? `yokoten explain ${next.id}`;
}

/**
 * The problems of the default screen, each fix said once (issue #1115): problems whose fix
 * names the same command share one row, and the command is the row's last line,
 * `Fix: \`<command>\``. A fix that names no command stays in the row's text.
 */
export function problemRows(problems: readonly Finding[]): string[][] {
  const byFix = new Map<string, { whats: string[]; thens: string[] }>();
  const plain: string[][] = [];
  for (const f of problems) {
    // A command only when the fix starts with one; "make `yokoten.json` valid JSON" is a sentence.
    const fix = fixCommand(f.fix);
    if (fix === null) plain.push(row('MISSING', `${f.what}; ${f.fix}`));
    else {
      const seen = byFix.get(fix.command);
      byFix.set(fix.command, { whats: [...(seen?.whats ?? []), f.what], thens: fix.then && !seen?.thens.includes(fix.then) ? [...(seen?.thens ?? []), fix.then] : seen?.thens ?? [] });
    }
  }
  // The follow-up ("and type your name") stays, as check's screen keeps it: the same finding says the same on both.
  return [
    // The follow-ups of one fix are one paragraph under the row, not one orphan line each (#1115).
    ...[...byFix].map(([command, { whats, thens }]) => [...row('MISSING', whats.join('; ')), ...(thens.length ? underRow(thens.map((then) => `${sentence(then)}${/[.!?]$/.test(then) ? '' : '.'}`).join(' '), false) : []), ...underRow(`Fix: \`${command}\``, false)]),
    ...plain,
  ];
}

/**
 * A command of two steps, `a && b`, as two commands: `a`, then `b`. Each wraps on its own, so a
 * long place name never pushes a line past the widest a screen may be (#1037).
 */
export const oneStepEach = (text: string): string => text.replace(/`([^`]+?) && ([^`]+)`/g, "`$1`, then `$2`");

/** The notes the default screen keeps, by id: work only on this machine can be lost, and a desk that can't start surprises (#1097). */
const KEPT_NOTES: Record<string, { one: string; many: string }> = {
  'uncommitted-changes': { one: 'place with uncommitted files', many: 'places with uncommitted files' },
  'unpushed-commits': { one: 'branch with commits only on this machine', many: 'branches with commits only on this machine' },
  stashes: { one: 'stash, only on this machine', many: 'stashes, only on this machine' },
  'desk-fence': { one: 'desk fence that cannot start', many: 'desk fences that cannot start' },
};

/**
 * The kept notes as rows, one per kind (#1037): a kind with one note shows its first clause;
 * a kind with more folds into one counted row, and `doctor --all` lists each.
 */
function keptNoteRows(notes: readonly Finding[], all: string): string[][] {
  return Object.entries(KEPT_NOTES).flatMap(([id, words]) => {
    const kind = notes.filter((note) => note.id === id);
    if (!kind.length) return [];
    // The title names the project, so the row starts at the count: "16 uncommitted files, the oldest changed
    // 1 minute ago" stays on one line (a slow runner made the old "this project has …" wrap, 25 lines, #1115).
    if (kind.length === 1) return [row('note', (kind[0]?.what.split(';')[0] ?? '').replace(/^\. has /, ''))];
    return [row('note', `${kind.length} ${words.many}; \`${all}\` lists them`)];
  });
}

/** What a caller puts on the default screen in doctor's place: its own title, rows after it, and its own next command. */
export interface ShortScreenParts {
  /** The title lines, in place of `yokoten doctor · <where>`. */
  title?: string[];
  /** Blocks right after the title, such as what a first run just did. */
  lead?: string[][];
  /** The command to type next, in place of doctor's. */
  next?: string;
}

/**
 * The default screen of `yokoten doctor`, from its report (#1027, #1037): a broken self-test
 * first, the title, the problems (never folded), the road, the kept notes folded by kind, and
 * one Next line. Every row starts its text in one column.
 */
export function shortLines(report: DoctorReport, parts: ShortScreenParts = {}): string[] {
  const lead = (report.view?.lead ?? []).map(noteLines);
  const steps = report.steps ?? [];
  const left = steps.filter((s) => s.mark === 'next' || s.mark === 'to do').sort((a, b) => (a.mark === 'next' ? -1 : b.mark === 'next' ? 1 : 0));
  const problems = problemsOf(report);
  const heading = parts.title ?? title('doctor', report.stage === null && !problems.length ? `${doctorSummary(report)}, nothing to do` : doctorSummary(report));
  if (report.stage === null && !problems.length && !parts.lead?.length && parts.next === undefined) return screen(...lead, heading);
  const done = steps.filter((s) => s.mark === 'done' || s.mark === 'not now').length;
  const all = commandOf(report, 'doctor --all');
  const unchecked = steps.filter((s) => s.mark === "can't check").length;
  const notes = (report.notes ?? []).length;
  const next = parts.next ?? (report.next ? nextCommand(report.next) : null);
  /** The screen with `shown` road steps; the rest fold into one row. */
  const withSteps = (shown: number): string[] => {
    const road: string[][] = [];
    if (steps.length) road.push(row('done', `${done} of ${count(steps.length, 'step')}`));
    for (const s of left.slice(0, shown)) road.push(row(s.mark === 'next' ? 'next' : 'to do', STEP_TITLES[s.id] ?? s.id));
    if (left.length > shown) road.push(row('to do', `${count(left.length - shown, 'more step')}, listed by \`${all}\``));
    if (unchecked) road.push(row("can't check", `${count(unchecked, 'step')}: ${unchecked === 1 ? 'it reads' : 'they read'} the code host; doctor checks ${unchecked === 1 ? 'it' : 'them'} after a push`));
    // A problem fails doctor, so it is never folded; it comes first, each block spaced when an item wraps (#1115).
    return screen(
      ...lead,
      heading,
      ...(parts.lead ?? []),
      spaced(problemRows(problems)),
      spaced(road),
      spaced(keptNoteRows(report.notes ?? [], all)),
      [...(next ? nextLine(next) : []), ...moreLine(`\`${all}\` shows every check${notes ? ` and ${count(notes, 'note')}` : ''}`)],
    );
  };
  // The next step and up to four more, fewer when problems and notes take the room, so the
  // screen fits on every machine (R3; a runner without the desk tools had 25 lines). The next
  // step always shows.
  for (let shown = 5; shown > 1; shown--) {
    const lines = withSteps(shown);
    if (lines.length <= SCREEN_ROWS) return lines;
  }
  return withSteps(1);
}

// ---- The server read (#1039) ----

/** Why a gh call was not made yet: the read runs again once its answer is in. */
const NOT_READ_YET = new Error('not read yet');

/** The error a call left over past the budget throws: the same code as a gh stopped by its timeout. */
const tooSlow = (): Error => Object.assign(new Error('GitHub took too long to answer'), { code: 'ETIMEDOUT' });

/**
 * The server settings, with every gh call that does not wait on another one made at once, all
 * under one budget of `budgetMs` (#1039). `read` is a reader that calls gh one call at a time,
 * such as `readServer`: it runs again with the answers so far, and each round makes at once the
 * calls it asked for and did not have. A call still out when the budget ends throws as a gh
 * timeout does, so its part says it can't check. `slow` counts those calls.
 */
export async function readAtOnce<T>(read: (gh: Gh) => T, gh: GhLater, budgetMs = SERVER_TIMEOUT_MS, clock: () => number = Date.now): Promise<{ result: T; slow: number }> {
  const answers = new Map<string, { text: string } | { error: unknown }>();
  const deadline = clock() + budgetMs;
  const stop = new AbortController();
  let slow = 0;
  for (;;) {
    const asked = new Set<string>();
    const result = read((args) => {
      const key = JSON.stringify(args);
      const answer = answers.get(key);
      if (!answer) {
        asked.add(key);
        throw NOT_READ_YET;
      }
      if ('error' in answer) throw answer.error;
      return answer.text;
    });
    if (!asked.size) return { result, slow };
    const left = deadline - clock();
    let timer: NodeJS.Timeout | undefined;
    const outOfTime = new Promise<void>((done) => {
      timer = setTimeout(done, Math.max(0, left));
    });
    const calls = [...asked].map(async (key) => {
      try {
        answers.set(key, { text: await gh(JSON.parse(key) as string[], stop.signal) });
      } catch (error) {
        answers.set(key, { error });
      }
    });
    await Promise.race([Promise.all(calls), outOfTime]);
    clearTimeout(timer);
    for (const key of asked) {
      if (answers.has(key)) continue;
      answers.set(key, { error: tooSlow() });
      slow += 1;
    }
    if (slow) stop.abort();
  }
}

/**
 * Where full doctor is and what it found, as data (plan 6.4): the report, and whether no problem
 * was found. Nothing here prints; the screens are built from the report.
 */
function doctorRun(
  root: string | null,
  { env, config, session = false, gh, host: givenHost, server: givenServer, fillMarks: isFilling = false, machine: probe = REAL_MACHINE, makeTemp = makeTempDir, platform = hostPathPlace().platform, isFile }: { env: Env; config: Config; session?: boolean; gh?: Gh; host?: Host; server?: ServerRead; fillMarks?: boolean; machine?: MachineProbe; makeTemp?: MakeTemp; platform?: NodeJS.Platform; isFile?: (path: string) => boolean },
): { ok: boolean; report: DoctorReport } {
  const lead: string[] = [];
  const { failed, unset } = SELF_TEST.run(makeTemp);
  const findings: Finding[] = [];
  if (failed.length) {
    lead.push(`yokoten is BROKEN: ${failed.join(', ')} let a known-bad input through. Do not trust any check until this is fixed.`);
    findings.push(finding('self-test', `${failed.join(', ')} let a known-bad input through`, 'do not trust any check until this is fixed; run `yokoten install` again, or report it in an issue'));
  }
  // No temp folder is a machine to fix, not a broken yokoten (#1108): one line, never a failure.
  if (unset.length) {
    const place = hostPathPlace();
    lead.push(noTempLine(unset, place.tmp, homeOf(env), place.platform));
  }
  const base = { version: VERSION, channel: releaseChannel(root, env), selfTest: { ok: !failed.length, failed, ran: !unset.length, skipped: unset, ...(unset.length ? { reason: 'no temp folder to test in' } : {}) }, stages: STAGES };
  if (!root) return { ok: !failed.length, report: { ...base, ok: !failed.length, repo: false, stage: null, next: null, findings, view: { lead } } };

  // Read only, and only in full doctor: a session never calls the network (record 0004).
  // A host with no adapter needs no network, so a session knows it too (#504).
  // The Gitea and GitHub reads are async, so the command makes them and passes them in (#505, #1039).
  const host = givenHost ?? hostOf(gitConfig(root, 'remote.origin.url', env), config.host);
  const server: ServerRead = givenServer !== undefined
    ? givenServer
    : host.kind === 'other'
      ? noAdapter(host)
      : session
        ? undefined
        : gh
          ? readOrigin(host, gh)
          : { unread: 'no way to reach the code host was given', fix: 'run `yokoten doctor`' };
  const where = walk(road(root, env, ROAD, server, config), config.notNow);
  // Only the first run fills the marks here (#390, its question is the write); bare doctor and a
  // session write nothing (record 0043 §3), and name `yokoten marks add` instead.
  // With no home folder, the checks that read or keep settings there are skipped, never crash (#404).
  const hasHome = homeOf(env) !== null;
  const filled = isFilling && !session && hasHome ? trySafely('the marks from this machine', () => filledLines(fillMarks(env, machineMarks(env, { cwd: root, gh })), paths(env).marks)) : [];
  const machine = hasHome ? machineChecks(env) : [];
  // A file missing here may be on the default branch (#405): one git call for every step
  // left. A session asks only when the step it names misses a file.
  const left = where.steps.filter((w) => w.mark === 'next' || w.mark === 'to do').map((w) => w.step);
  const isAsked = missingPaths(root, session ? left.slice(0, 1) : left, config).length > 0;
  const elsewhere = isAsked ? readDefaultBranchFiles(root, missingPaths(root, left, config), env) : null;
  const next = where.next ? stepFinding(where.next, root, env, { server, config, elsewhere }) : null;
  const core = coreRulesCheck(root);
  const isCoreBehind = core?.mark === 'MISSING';

  // A session reads files only, never the network, so it starts fast and works offline.
  if (session) {
    // Each note is a block of lines: a compaction start repeats only the blocks that changed (#405).
    // Each note has a rank, so the cap keeps the ones that matter most (#930).
    const notes: SessionNote[] = [];
    if (next) findings.push(next);
    // Not a step on the road, but the privacy check is weaker until it is fixed.
    const marks = machine.find((c) => c.name === 'private-marks' && !c.ok);
    if (marks) {
      notes.push({ rank: SECURITY, finding: marks.finding });
      findings.push(marks.finding);
    }
    // No guard at all is unsafe at once, so a session hears it too (#904). Only where
    // Claude Code has its own settings: a machine without them has no such session to
    // guard, and full doctor names the missing guard for the user who wants one.
    const guard = hasUserSettings(env) ? machine.find((c) => c.name === 'user-guard' && !c.ok) : undefined;
    if (guard) {
      notes.push({ rank: SECURITY, finding: guard.finding });
      findings.push(guard.finding);
    }
    // A stale plugin keeps old guard rules running; the session hears it (#198).
    const stale = pluginAgeCheck(root, env);
    if (stale) notes.push({ rank: SECURITY, finding: stale });
    // A github marketplace updates over SSH, and fails without a key; the session says how to move it (#950).
    const source = pluginSourceNote(env);
    if (source) notes.push({ rank: SETUP, finding: source });
    if (!hasHome) notes.push({ rank: SETUP, lines: [`yokoten: ${NO_HOME_NOTE}`] });
    // This note only. The other privacy notes stay out of a session (#681).
    const claudeRules = museClaudeRules(env, root);
    if (claudeRules) notes.push({ rank: SETUP, finding: claudeRules.finding });
    const double = hasHome ? doubleInstallCheck(root, env) : null;
    if (double) notes.push({ rank: SETUP, finding: double });
    // An edit stays, and a kit fix that waits behind it is named here, not after a surprise (#477).
    const edited = hasHome ? editedKitCheck(env) : null;
    if (edited) notes.push({ rank: SETUP, finding: edited });
    // A full disk stops every session unseen (record 0012): statfs and one small file, no child process.
    for (const c of diskSpaceChecks(root, env, probe, true).filter((check) => !check.ok)) notes.push({ rank: ONLY_HERE, finding: c.finding });
    const unsaved = sessionUnsaved(root, env);
    if (unsaved.lines.length) notes.push({ rank: ONLY_HERE, lines: unsaved.lines });
    // A lesson the kit learned reaches the project here: the session hears it (#120).
    if (core && isCoreBehind) {
      notes.push({ rank: SETUP, finding: core.finding });
      findings.push(core.finding);
    }
    const waiting = upstreamNote(root, env);
    if (waiting) {
      notes.push({ rank: OTHER, lines: [`yokoten: ${waiting.what}`] });
      findings.push(waiting);
    }
    // A lesson new to this clone that finds something here: one line, at one start only (#339).
    const stateFile = unsaved.commonDir ? join(unsaved.commonDir, STATE_FILE) : findStateFile(root, env);
    const lesson = sessionLessonNote(root, config.notNow, stateFile, env.CLAUDE_PLUGIN_ROOT ? '/yokoten:doctor' : '`yokoten doctor`');
    if (lesson.line) notes.push({ rank: OTHER, lines: [lesson.line] });
    const found = [...unsaved.notes, ...lesson.findings, ...(claudeRules ? [claudeRules.finding] : [])];
    // A machine with no guard fails the run as full doctor does; a session still starts.
    const ok = !failed.length && !isCoreBehind && !guard;
    return { ok, report: { ...base, ok, repo: true, stage: where.stage, next, findings, ...(found.length ? { notes: found } : {}), view: { lead, session: notes } } };
  }

  // Work only on this machine (#365): notes, never a failure, and read only. Read before the
  // road, so the state file is found in the git folder it names (#453), as a session start
  // finds it, and a stage that jumped can say so next to the road (#514).
  const unsaved = readUnsaved(root, { env });
  // Full doctor keeps which lessons this clone has seen; a session start keeps only which it ran.
  const stateFile = unsaved?.commonDir ? join(unsaved.commonDir, STATE_FILE) : findStateFile(root, env);
  const state = readState(stateFile);
  // The road's stage has its own file, next to the lessons state (#514). A broken or missing
  // file has no stage: the first run has nothing to compare with.
  const stageFile = stageFileFor(stateFile);
  const savedStage = readState(stageFile).lastStage;
  const lastStage = typeof savedStage === 'number' && Number.isInteger(savedStage) && savedStage > 0 ? savedStage : null;
  // A stage that moved by more than one since the last full doctor says which stages it
  // passed, and why each counts as done, one line each (#514). The first run has no stage to
  // compare with, and a move of one is the usual next step, so neither says anything.
  const jumps: string[] = [];
  if (where.stage !== null && lastStage !== null && where.stage - lastStage >= 2) {
    for (let stage = lastStage + 1; stage < where.stage; stage++) {
      const marks = where.steps.filter((walked) => walked.step.stage === stage).map((walked) => walked.mark);
      const isDone = marks.every((mark) => mark === 'done');
      jumps.push(`stage ${stage} ${isDone ? 'is done too' : 'counts as done'}: ${stageJumpText(marks)}`);
    }
  }
  const steps: StepState[] = [];
  // With no origin remote, the server settings list leaves out server-settings (#502).
  const noRemote = server !== undefined && 'unread' in server && server.unread === NO_REMOTE;
  const stageRows = STAGES.map((_, i): CheckRow[] => {
    const rows: CheckRow[] = [];
    const walked = where.steps.filter((w) => w.step.stage === i + 1);
    const nameOf = (step: (typeof walked)[number]['step']) => `${step.key}${step.standard ? ` (${step.standard})` : ''}`;
    // The done steps of every stage except the one holding the next step share one row:
    // that stage is the reader's checklist, and a step named alone there still answers
    // "is this done?" at a glance (#946).
    const isCurrent = where.stage === i + 1;
    const doneNames = isCurrent ? [] : walked.filter(({ mark }) => mark === 'done').map(({ step }) => nameOf(step));
    if (doneNames.length) rows.push({ mark: 'done', name: doneNames.join(', ') });
    // The "can't check" steps of a stage that share one reason share one row too.
    const unchecked = new Map<string, string[]>();
    for (const { step, mark } of walked) {
      const stepState: StepState = { id: step.key, stage: step.stage, mark, how: step.how, why: step.why };
      if (step.standard) stepState.standard = step.standard;
      steps.push(stepState);
      if (mark === 'done') {
        if (isCurrent) rows.push({ mark: 'done', name: nameOf(step) });
        continue;
      }
      if (mark === 'not now') {
        // A step that needs CI waits with "notNow" `ci` (#377): its reason, then what covers it meanwhile.
        stepState.reason = Object.hasOwn(config.notNow, step.key) ? config.notNow[step.key] : `${config.notNow.ci} (notNow ci); ${step.withoutCi}`;
        rows.push({ mark: 'skipped', name: nameOf(step), what: `not now, ${stepState.reason}` });
      } else if (mark === 'next' || mark === 'to do') {
        const f = stepFinding(step, root, env, { server, config, elsewhere });
        findings.push(f);
        rows.push({ mark, name: nameOf(step), what: f.what, fix: f.fix });
      } else {
        let note = uncheckedText(step, server);
        // Keep the old words for no origin remote (#502): the server is where these live.
        if (noRemote && note.startsWith(`${NO_REMOTE};`)) note = `${NO_REMOTE}, so doctor can't read the server; ${NO_REMOTE_FIX}`;
        unchecked.set(note, [...(unchecked.get(note) ?? []), nameOf(step)]);
      }
    }
    for (const [note, names] of unchecked) rows.push({ mark: "can't check", name: names.join(', '), ...splitFix(note) });
    return rows;
  });
  const project: CheckRow[] = [];
  const notes: Finding[] = [];
  /** A practice as a row: ok with its detail, or a note with its finding. */
  const practiceRow = (c: Practice, failMark: RowMark = 'note'): CheckRow => (c.ok ? { mark: 'ok', name: c.name, ...(c.detail ? { what: c.detail } : {}) } : { mark: failMark, name: c.name, what: c.finding.what, fix: c.finding.fix });
  for (const c of agentHooks(root, env, platform)) {
    project.push(practiceRow(c));
    if (!c.ok) notes.push(c.finding);
  }
  if (core) {
    project.push(core.mark === 'ok' ? { mark: 'ok', name: 'core-rules' } : { mark: core.mark, name: 'core-rules', what: core.finding.what, fix: core.finding.fix });
    if (core.mark === 'MISSING') findings.push(core.finding);
    else if (core.mark === 'note') notes.push(core.finding);
  }
  // A merge made in another zone stays in history (record 0027): a count to know, never a
  // failure, and one command shows the merges (#760). Full doctor only: a session reads no history.
  const zones = config.privacy.utc ? mergeTimeZones(root, env) : null;
  if (zones) {
    project.push({ mark: 'note', name: 'time-zone', what: zones.what, fix: zones.fix });
    notes.push(zones);
  }
  // Open changes that collide (#909): read from the kept map, no git call for each change.
  const conflicts = conflictNote(root, env, Date.now(), unsaved?.commonDir ?? null);
  if (conflicts) project.push({ mark: 'note', name: 'conflicts', what: conflicts });
  const noCi = noCiNote(config.notNow, where.stage, server);
  if (noCi) {
    project.push({ mark: 'note', name: 'no-ci', what: noCi.what, fix: noCi.fix });
    notes.push(noCi);
  }
  const seenLessons = state.seenLessons ?? [];
  const lessons = lessonChecks(root, config.notNow, undefined, stateFile ? seenLessons : null);
  const nextSeen = seenAfter(seenLessons, lessons);
  // A kit workflow that is an old copy, or has the project's changes (#456): a note, never a
  // failure. A changed copy is noted once per kit version in this clone.
  const seenWorkflows = state.seenWorkflows ?? [];
  const workflows = workflowNotes(root).filter((w) => w.seen === undefined || !seenWorkflows.includes(w.seen));
  for (const { note } of workflows) {
    project.push({ mark: 'note', name: 'kit-workflows', what: note.what, fix: note.fix });
    notes.push(note);
  }
  const nextWorkflows = [...seenWorkflows, ...workflows.flatMap((w) => (w.seen === undefined ? [] : [w.seen]))];
  if (nextSeen.length > seenLessons.length || nextWorkflows.length > seenWorkflows.length) saveState(stateFile, { ...state, seenLessons: nextSeen, ...(nextWorkflows.length ? { seenWorkflows: nextWorkflows } : {}) });
  // A stage this run holds is saved for the next one. The done road (`where.stage === null`)
  // leaves the last stage where it was: there is no new stage to compare with.
  if (where.stage !== null && where.stage !== lastStage) saveState(stageFile, { lastStage: where.stage });
  project.push(...lessonRows(lessons));
  notes.push(...lessons.flatMap((lesson) => lesson.findings));
  const checkNotes: Finding[] = [];
  let problems: Finding[];
  try {
    problems = check(root, { config, env, notes: checkNotes });
  } catch (err) {
    // An unreadable marks file stops the privacy check (#656): doctor says so and goes on.
    if (marksState(env) !== 'unreadable') throw err;
    problems = [finding('private-marks', UNREADABLE_MARKS, UNREADABLE_MARKS_FIX)];
  }
  findings.push(...problems);
  const allowed = allowedMarkCount(env, config, root);
  if (allowed.project) project.push({ mark: 'ok', name: 'own-marks', what: `${allowed.project} of your private marks allowed here by privacy.allow` });
  if (allowed.machine) project.push({ mark: 'ok', name: 'own-marks', what: `${allowed.machine} of your private marks allowed here by this machine (\`yokoten marks allow\`)` });
  if (allowed.ownName) project.push({ mark: 'ok', name: 'own-marks', what: `${allowed.ownName} of your private marks skipped here because they name this repo ("privacy": { "skipOwnName": false } turns this off)` });
  if (allowed.unsure) project.push({ mark: 'note', name: 'own-marks', what: `this machine allows no private mark here, because ${allowed.unsure}` });
  project.push(problems.length ? { mark: 'MISSING', name: 'tree', what: count(problems.length, 'problem'), fix: '`yokoten check` lists them' } : { mark: 'ok', name: 'tree', what: 'layout and privacy clean' });
  // check's own notes (#228), such as an unknown yokoten.json key or a translation behind: worded as check words them, and never a failure.
  for (const n of checkNotes) project.push({ mark: 'note', name: '', what: `${place(n)}${n.what}${formatFindingMarks(n)}. ${sentence(n.why)}. ${sentence(n.fix)}.` });
  notes.push(...checkNotes);
  const unsavedFound = unsaved ? unsavedNotes(unsaved, { home: env.HOME }) : [];
  const unsavedRows: CheckRow[] = !unsaved
    ? [{ mark: 'note', name: 'git', what: "can't read this repo with git, so doctor can't tell what is only here" }]
    : unsavedFound.length
      ? unsavedFound.map((n): CheckRow => ({ mark: 'note', name: n.id, what: oneStepEach(n.what), fix: oneStepEach(n.fix) }))
      : [{ mark: 'ok', name: 'everything is committed and pushed' }];
  notes.push(...unsavedFound);
  const machineRows: CheckRow[] = [];
  for (const c of machine) {
    machineRows.push(practiceRow(c, 'MISSING'));
    if (!c.ok) findings.push(c.finding);
  }
  if (!hasHome) machineRows.push({ mark: 'note', name: 'home', what: NO_HOME_NOTE });
  for (const line of filled) machineRows.push({ mark: 'note', name: 'private-marks', what: line });
  for (const c of hasHome ? privacyNotes(env, root, config.privacy.output) : []) {
    machineRows.push(practiceRow(c));
    notes.push(c.finding);
  }
  // Machine notes (record 0012) never fail doctor: the disk, the agent's temp folder, old
  // test folders left in the temp folder (#400), a Node without the security fixes (#572),
  // and a desk fence that can't start (#1097).
  const agentTemp = agentTempDirCheck(env, probe);
  const leftovers = leftoverTempCheck(env, probe);
  const guardCost = guardCostCheck(root, probe, env);
  const fence = deskFenceCheck(env, platform, isFile);
  for (const c of [...userAgentHooks(env), ...diskSpaceChecks(root, env, probe, false), ...(agentTemp ? [agentTemp] : []), ...(leftovers ? [leftovers] : []), nodeSecurityCheck(probe), ...(guardCost ? [guardCost] : []), ...(fence ? [fence] : [])]) {
    machineRows.push(practiceRow(c));
    if (!c.ok) notes.push(c.finding);
  }
  const named: [string, Finding | null][] = [
    ['plugin', pluginAgeCheck(root, env)],
    ['plugin-source', pluginSourceNote(env)],
    ['plugin-and-install', hasHome ? doubleInstallCheck(root, env) : null],
    ['command', hasHome ? launcherCheck(env, platform) : null],
    ['edited-kit', hasHome ? editedKitCheck(env) : null],
  ];
  for (const [name, note] of named) {
    if (!note) continue;
    machineRows.push({ mark: 'note', name, what: note.what, fix: note.fix });
    notes.push(note);
  }
  const waiting = upstreamNote(root, env);
  if (waiting) {
    machineRows.push({ mark: 'note', name: 'upstream-inbox', what: waiting.what });
    notes.push(waiting);
  }
  // The road's stage 5 shows the settings it groups (#7); here are the rest, which never fail doctor.
  const settings = serverChecks(server ?? { unread: 'no way to reach the code host was given', fix: 'run `yokoten doctor`' }, { isCiOff: Object.hasOwn(config.notNow, 'ci') });
  const serverRows: CheckRow[] = [];
  for (const c of settings.filter((c) => !ROAD_SERVER_IDS.includes(c.id) && !(noRemote && c.id === 'server-settings'))) {
    serverRows.push(c.mark === 'ok' ? { mark: 'ok', name: c.id } : { mark: c.mark, name: c.id, what: c.finding.what, fix: c.finding.fix });
    if (c.mark !== 'ok') notes.push(c.finding);
  }
  // On a host with no adapter, each road step says what it asks; these lists name GitHub's menus (#504).
  if (!isNoAdapter(server)) {
    if (settings[0].id === 'server-settings') serverRows.push(...BY_HAND.map((step): CheckRow => ({ mark: 'to do', name: 'by hand', what: step })));
    serverRows.push(...OWNER_STEPS.map((step): CheckRow => ({ mark: 'to do', name: 'not checked', what: step })));
  }
  serverRows.push(...listBoardSteps(server).map((step): CheckRow => ({ mark: 'to do', name: 'by hand', what: step })));
  // A shell that is not UTC makes each new commit carry its zone (#932). Say the one row
  // for this shell at the end, where a person looks for the next step. A session never
  // needs it: init already sets TZ=UTC for agent sessions.
  const timeZone: CheckRow | undefined = config.privacy.utc && !isUtcTimeZone(env) ? { mark: 'note', name: 'shell', what: `your shell's time zone is not UTC, so each commit would carry it. ${timeZoneFix(env)}.` } : undefined;
  // The road has no failed mark: a step is done, to do, not now or can't check. Steps
  // left are the way ahead, not problems, so they never fail doctor (#208).
  const ok = !failed.length && !isCoreBehind && !problems.length && machine.every((c) => c.ok);
  const version: CheckRow = { mark: failed.length ? 'MISSING' : 'ok', name: `yokoten ${VERSION} (${base.channel})`, what: `self-test ${failed.length ? 'FAILED' : 'ok'}` };
  const full: FullView = { version, jumps, stages: stageRows, project, unsaved: unsavedRows, machine: machineRows, server: serverRows, ...(timeZone ? { timeZone } : {}) };
  return {
    ok,
    report: {
      ...base, ok, repo: true, stage: where.stage, next, findings, steps, notes,
      server: settings.map(({ id, mark }) => ({ id, mark })),
      lessons: lessons.map(({ id, mark, reason, isNew }) => ({ id, mark, ...(reason === undefined ? {} : { reason }), ...(isNew ? { isNew } : {}) })),
      view: { lead, full },
    },
  };
}

/** A sentence and its fix, split at the first `; `: the fix goes on a Fix line when it starts with a command. */
function splitFix(text: string): { what?: string; fix?: string } {
  const at = text.indexOf('; ');
  if (at === -1) return text ? { what: text } : {};
  return { what: text.slice(0, at), fix: text.slice(at + 2) };
}
