// `yokoten check`: the tree, --staged, --history, and in CI --pr and --issue. `--pr <number>`
// reads one pull request through gh, for a repo without CI (#377). And
// `yokoten redact`, the privacy check's filter for command output (#390). And `yokoten marks`,
// the private marks from the command line: `allow`, which lets one mark through in the
// repo you are in, kept on this machine, never in the repo (#447); `allow --remove` is its way
// back (record 0014). Alone it counts the marks by kind; `add` and `remove` take one value
// from the terminal with no echo, or from stdin, so it never lands in the shell history;
// `off <kind>` and `on <kind>` stop and start install adding a kind, kept in machine.json
// (#434). A mark is never printed, logged or repeated back. Marks the owner added are never
// touched by `off`, `on` or install. And `yokoten test`, the tests run light on a shared
// machine (#461).

import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { checkAnchors } from '../../host/sigstore/anchor.ts';
import { findAnchor, workflowIdentity } from '../../host/sigstore/rekor.ts';
import { readEventLog } from '../../host/sigstore/record.ts';
import { cores, freeMemory, isLight, NICE_LEVEL, OFF_SWITCH, onPath, testCommand, testJobs } from '../../host/light.ts';
import { readCurrentPullRequest, readsCurrentPullRequest } from '../../host/current-pr.ts';
import { asText, botConfig, botEnv, borrowedHost, type Gh, ghIn, installationToken, isObject, OPEN_PULL_LIMIT, readApproverLogin, readCodeOwners, readIssue, readNumberedPullRequest, readOpenPulls, readPullRequest, readRepoLabelNames, repoOf } from '../../host/github/index.ts';
import { type Env, loadConfig } from '../../rules/config.ts';
import { finding, type Finding, formatFindingMarks, isWarningFinding } from '../../rules/text/message.ts';
import { shownValue } from '../../rules/text/terminal.ts';
import { addedLinesByFile, changedLines, checkIssueLabels, checkIssueTitle, checkOwnedTier, checkPullRequest, isChangeFile, largeDiff, longSentenceNote, longSentences, madeWithModelNote, parseMadeWith, parseProvenance, provenanceFindings, splitForDependabot } from '../../rules/pr.ts';
import { BOARD_AGENT_FILE, parseBoardAgent, readBoardWorktrees } from '../kanban/agents.ts';
import { parseChange } from '../../run/changelog.ts';
import { borrowedFiles, type BorrowedChange, type BorrowedWatch, check, checkHistory, GitReadError, gitReadFinding, type GitRun, historyTimeZones, indexFiles, readGit, syncPull, type SyncOutcome, timeZoneNote, unstageHint, verifyMerge, watchBorrowed } from '../../run/check.ts';
import { readBranchDesks } from '../../run/hook.ts';
import { isCodeFile, nameNotes } from '../../run/notes/names.ts';
import { addedIgnores, type AllowEntry, hideHome, isLink, loadMarks, type Mark, marksFile, marksFiles, machineAllowed, machineAllowFile, makeRedactor, matchingEntries, NO_HOME, readMachineAllow, repoKey } from '../../rules/privacy.ts';
import { addOwnMark, countMarkKinds, fillMarks, kindsTurnedOff, machineMarks, machineUserNames, paths, removeMarks, setKindOff, SWITCHED_KINDS } from '../../setup/install.ts';
import { readOriginUrl } from '../../setup/plan.ts';
import { count, fail, failure, field, type Invocation, isTerminal, moreLine, parse, problemRows, print, printJson, readInput, requireRoot, row, type RowMark, say, screen, show, showOnPullRequest, spaced, summaryLine, title, underRow, usage, wrap } from '../shared.ts';
import { asSentence, MARK_COLUMN, nextSentence, ROW_INDENT, section, table, type TableRow, utcText } from '../../rules/text/screen.ts';

/** How long `check --pr <number>` waits for gh. */
const GH_TIMEOUT_MS = 15000;

/** A mode of `yokoten check`: the whole tree, or one of its flags. */
export type CheckMode = 'tree' | 'staged' | 'history' | 'pr' | 'issue' | 'anchor';

/**
 * One run of `yokoten check`, as plain data (issue #1115): what it found, the notes it took
 * on the way, and, for a commit it stopped, how to unstage. `skipped` says why there was
 * nothing to check. The screen and --json are both built from it.
 */
export interface CheckResult {
  mode: CheckMode;
  /** The pull request's number, for `check --pr <number>`. */
  number?: string;
  problems: Finding[];
  notes: Finding[];
  /** How to unstage the files a stopped commit names (#503). */
  hints: string[];
  skipped?: string;
}

export async function runCheck(invocation: Invocation): Promise<number> {
  const options = parse('check', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  const modes = ['--staged', '--history', '--pr', '--issue', '--anchor'].filter((m) => options.flags.has(m));
  if (modes.length > 1) return usage(invocation, `${modes.join(' and ')} can't be used together`);
  const mode = (modes[0]?.slice(2) ?? 'tree') as CheckMode;
  // A number goes with --pr only (#377): that pull request, read through gh.
  const number = options.positional[0];
  if (number !== undefined && mode !== 'pr') return usage(invocation, `unexpected argument ${number}: a number goes with --pr`);
  const json = options.flags.has('--json');
  const root = requireRoot(invocation, invocation.cwd, json ? (missing) => checkJson({ mode, problems: [missing], notes: [], hints: [] }) : undefined);
  if (!root) return 1;
  const config = loadConfig(root);
  const result: CheckResult = { mode, number, problems: [], notes: [], hints: [] };
  try {
    const found = await runMode(invocation, mode, root, config, result.notes, { number, values: options.values });
    if (typeof found === 'string') result.skipped = found;
    else result.problems = found;
  } catch (err) {
    // A git read the check depends on gave no answer (#403): one finding, and the check fails.
    if (!(err instanceof GitReadError)) throw err;
    result.problems = [gitReadFinding(err)];
  }
  if (result.skipped !== undefined) {
    if (json) printJson(invocation, checkJson(result));
    else show(invocation, checkScreen(result));
    return 0;
  }
  result.hints = unstageLines(root, invocation.env, mode, result.problems);
  // In a GitHub Actions job, the annotations come first: the screen is the last thing a person reads.
  showOnPullRequest(invocation, `yokoten ${checkCommand(mode)}`, result.problems, result.notes, { json, isPlaceAFile: mode !== 'history' });
  if (json) printJson(invocation, checkJson(result));
  else print(invocation, checkScreen(result, { isAll: options.flags.has('--all') }), result.problems.length ? invocation.stderr : invocation.stdout);
  return result.problems.length ? 1 : 0;
}

/** What `check --json` prints (issue #1115): the result the screen is built from, in the shape --json has always had. A skipped check has no findings and no notes. */
export interface CheckJson {
  check: CheckMode;
  ok: boolean;
  skipped?: string;
  findings: Finding[];
  notes: Finding[];
}

/** The one way a check's result becomes its --json (issue #1115). */
export function checkJson(result: CheckResult): CheckJson {
  if (result.skipped !== undefined) return { check: result.mode, ok: true, skipped: result.skipped, findings: [], notes: [] };
  return { check: result.mode, ok: !result.problems.length, findings: result.problems, notes: result.notes };
}

/** The words after `yokoten` that ran this check: `check`, or `check --pr`. */
const checkCommand = (mode: CheckMode): string => `check${mode === 'tree' ? '' : ` --${mode}`}`;


/**
 * The notes of a check (#1027, #1115). By default they fold into one row with the command
 * that shows them; a warning (a likely secret) is counted on its own, so it is never lost in
 * the count. With --all each note is a row: its place and what it is, then why and the fix
 * under it. No row has a label, so the text starts in the column of a problem with a long place.
 */
export function noteRows(notes: readonly Finding[], isAll: boolean): string[] {
  if (!notes.length) return [];
  if (!isAll) {
    const warnings = notes.filter(isWarningFinding).length;
    return row('note', `${count(notes.length, 'note')}${warnings ? `, ${count(warnings, 'warning')} among them` : ''}: \`yokoten check --all\` shows each`);
  }
  return spaced(
    notes.map((note) => {
      const where = note.file === undefined ? '' : `${note.file}${note.line === undefined ? '' : `:${note.line}`}: `;
      // The grade and an ignore's reason stay on the row: a reviewer reads why it was let through (#616).
      const what = `${where}${isWarningFinding(note) ? 'warning: ' : ''}${note.what}${formatFindingMarks(note)}`;
      return [...row('note', what), ...underRow([note.why, note.fix].filter((part) => part.trim() !== '').map(asSentence).join(' '), false)];
    }),
  );
}

/**
 * The screen of a check (issue #1027, #1115): a clean check is its title and its notes; one
 * that found problems gives the count, a row per problem with its place first and why and the
 * fix under it, the notes, then the one command to type. Problems are never folded; a link
 * they share is one More line. A skipped check is its title alone.
 */
export function checkScreen(result: CheckResult, { isAll = false }: { isAll?: boolean } = {}): string[] {
  const command = checkCommand(result.mode);
  if (result.skipped !== undefined) return title(command, result.skipped);
  const notes = noteRows(result.notes, isAll);
  if (!result.problems.length) return screen(title(command, cleanSummary(result.mode, result.number)), notes);
  const links = [...new Set(result.problems.map((problem) => problem.docs).filter((docs) => docs !== undefined))];
  return screen(
    title(command, count(result.problems.length, 'problem')),
    problemRows(result.problems),
    spaced([...result.hints.map((hint) => row('note', hint)), ...(notes.length ? [notes] : [])]),
    [...nextSentence(`fix ${result.problems.length === 1 ? 'it' : 'them'}, then \`yokoten check\``), ...(links.length === 1 ? moreLine(links[0] ?? '') : [])],
  );
}

/** What a clean check is true of, in the mode's own words. */
function cleanSummary(mode: CheckMode, number?: string): string {
  if (mode === 'history') return 'clean: every commit on every branch';
  if (mode === 'pr') return number === undefined ? 'no problems in this pull request' : `PR #${number}, no problems`;
  if (mode === 'issue') return 'no problems in this issue';
  if (mode === 'anchor') return 'clean: every anchored day checks out';
  return 'clean: layout, privacy, lead-only files';
}

/** For a stopped commit, the line that says how to unstage the files it names (#503). Nothing for other modes. */
function unstageLines(root: string, env: Invocation['env'], mode: CheckMode, problems: Finding[]): string[] {
  if (mode !== 'staged') return [];
  try {
    const hint = unstageHint(root, env, problems);
    return hint ? [hint] : [];
  } catch {
    return []; // git can't answer now: the problems above already stand
  }
}

/** The repo whose anchor workflow signed the entries: --repo, GITHUB_REPOSITORY, or origin. */
function anchorRepo(root: string, env: Invocation['env'], given?: string): string | undefined {
  const named = given ?? env.GITHUB_REPOSITORY;
  if (named) return /^[\w.-]+\/[\w.-]+$/.test(named) ? named : undefined;
  try {
    const url = readGit(root, ['config', '--get', 'remote.origin.url'], { env }).toString('utf8').trim().replace(/\.git$/, '');
    const found = url.match(/github\.com[:/]([\w.-]+)\/([\w.-]+)$/);
    return found ? `${found[1]}/${found[2]}` : undefined;
  } catch {
    return undefined;
  }
}

/** The event log: `.git/yokoten/events.jsonl` under the repo's common git folder. */
function eventLogPath(root: string, env: Invocation['env']): string {
  const common = readGit(root, ['rev-parse', '--git-common-dir'], { env }).toString('utf8').trim();
  return resolve(root, common, 'yokoten', 'events.jsonl');
}

/**
 * `check --anchor`: each past UTC day of the event log against its Rekor entry. Only the
 * day's 64 hex characters go out; no line, path or name leaves the machine (#768).
 */
async function runAnchor(invocation: Invocation, root: string, notes: Finding[], values: Record<string, string>): Promise<Finding[]> {
  const { env } = invocation;
  let logPath: string;
  try {
    logPath = eventLogPath(root, env);
  } catch {
    return [finding('anchor', 'git cannot name the event log for this repo', 'run the check inside the repo')];
  }
  let text: string;
  try {
    // Read once, with no check first: another process may remove the log between the two.
    text = readFileSync(logPath, 'utf8');
  } catch (err) {
    // A log that is there but unreadable is not a missing log; let the caller see the error.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return [finding('anchor', `there is no event log to check (${hideHome(logPath, env)} is not there)`, 'the hooks and runners write it; there is nothing to anchor before the first event')];
  }
  const repo = anchorRepo(root, env, values['--repo']);
  if (!repo) return [finding('anchor', 'the repo whose workflow signed the anchors is not known', 'pass --repo owner/name, or set GITHUB_REPOSITORY')];
  const log = readEventLog(text);
  const report = await checkAnchors(log, {
    today: new Date().toISOString().slice(0, 10),
    lookup: (hash) => findAnchor(hash, { identity: workflowIdentity(repo) }),
  });
  notes.push(...report.notes);
  return report.problems;
}

/**
 * The agent that filed a status file in the checkout on `branch`, or null (#748). A desk
 * is a plain clone, so the list `yokoten desk` keeps supplies it too. No status file, or a
 * status file with no model, gives null: there is nothing to compare.
 */
function branchWorker(root: string, env: Invocation['env'], branch: string): { name: string; model: string } | null {
  const trees = readBoardWorktrees(root, env);
  if (typeof trees === 'string') return null;
  const tree = trees.find((one) => one.branch === branch);
  if (!tree) return null;
  try {
    const agent = parseBoardAgent(readFileSync(join(tree.path, BOARD_AGENT_FILE), 'utf8'), tree.path);
    return agent?.model ? { name: agent.name, model: agent.model } : null;
  } catch {
    return null;
  }
}

/** The problems of one mode of `check`, or why there is nothing to check; its notes go into `notes`. It prints nothing. */
async function runMode(invocation: Invocation, mode: CheckMode, root: string, config: ReturnType<typeof loadConfig>, notes: Finding[], { number, values }: { number?: string; values: Record<string, string> }): Promise<Finding[] | string> {
  const { env } = invocation;
  let problems: Finding[];
  if (mode === 'anchor') {
    return runAnchor(invocation, root, notes, values);
  }
  if (mode === 'issue') {
    const issue = readIssue(env);
    if (!issue) return 'no issue in this run (it reads the CI event); nothing to check';
    // An event that can't be read is one finding (#267), so --json and the summary still work.
    // The labels need the kinds the repo has, read through gh; when gh can't list
    // them, only the title is checked (#544).
    problems =
      'problem' in issue ? [issue.problem] : [...checkIssueTitle(issue.title, config, issue.labels), ...checkIssueLabels(issue.labels, readRepoLabelNames(ghIn(root, env, GH_TIMEOUT_MS)))];
  } else if (mode === 'pr') {
    let pr = number === undefined ? readPullRequest(root, env) : readNumberedPullRequest(root, ghIn(root, env, GH_TIMEOUT_MS), number, env);
    // When the workflow asks for it (#645), the title, body, labels and milestone are the
    // ones the pull request has now, never the event file's. The commits stay the event's.
    if (pr && !('problem' in pr) && number === undefined && readsCurrentPullRequest(env)) {
      const now = await readCurrentPullRequest(env);
      pr = 'problem' in now ? now : { ...pr, ...now };
    }
    if (!pr) return 'no pull request in this run (it reads the CI event); nothing to check';
    // An event or commits that can't be read are one finding (#267), never git's raw error.
    if ('problem' in pr) {
      problems = [pr.problem];
    } else {
      // The file as the pull request leaves it, or null when the pull request deletes it.
      // Any other file git can't show stops the check (#403): never read as deleted.
      const deleted = new Set(pr.deleted);
      const readAtHead = (file: string): string | null => (deleted.has(file) ? null : readGit(root, ['show', `${pr.head}:${file}`], { env }).toString('utf8'));
      // One diff with renames found, so a moved file is not noted as all new. Fixed
      // prefixes and plain paths, whatever the user's git settings say.
      const diffArgs = ['-c', 'core.quotePath=false', 'diff', '-U0', '-M', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', `${pr.base}...${pr.head}`];
      const added = pr.files.length ? addedLinesByFile(readGit(root, diffArgs, { env }).toString('utf8')) : new Map<string, Set<number>>();
      // Plain English (record 0005): a long sentence on a line the pull request adds is a
      // note, never a failure. Old lines are left alone, as with names: a small change in a
      // long page must not bury the check's problems under notes about text it did not write.
      const long: Finding[] = [];
      for (const file of pr.files.filter((p) => /\.md$/i.test(p))) {
        const text = readAtHead(file);
        const lines = added.get(file) ?? new Set<number>();
        if (text !== null) for (const s of longSentences(text)) if (lines.has(s.line)) long.push(longSentenceNote(file, s));
      }
      notes.push(...long);
      // Names (record 0006): hard-to-read names on the lines a pull request adds to code
      // are notes too. Old lines are left alone, so a project is not noted all at once.
      const names: Finding[] = [];
      const codeFiles = pr.files.filter(isCodeFile);
      for (const file of codeFiles) {
        const text = added.has(file) ? readAtHead(file) : null;
        if (text !== null) names.push(...nameNotes(file, text, added.get(file) ?? new Set()));
      }
      notes.push(...names);
      // Each ignore the pull request adds (#616) is a notice for the reviewer, never a failure.
      const ignores: Finding[] = [];
      for (const [file, lines] of added) {
        let text: string | null = null;
        try {
          text = lines.size ? readAtHead(file) : null;
        } catch {
          // A submodule's pointer is not a file: it holds no ignore.
        }
        if (text !== null && !text.includes('\0')) ignores.push(...addedIgnores(file, text, lines, env));
      }
      notes.push(...ignores);
      // A large pull request (record 0004) is a note too, never a failure.
      const large = largeDiff(changedLines(pr.numstat));
      if (large) notes.push(large);
      // The `Made with` line names the model the worker ran (#748). The worker's own
      // checkout filed that model in its status file; when the two disagree, the line
      // names the wrong vendor's model, and the note says so. Never a failure.
      const worker = pr.branch ? branchWorker(root, env, pr.branch) : null;
      const modelNote = worker ? madeWithModelNote(pr.body, worker.model, pr.branch) : null;
      if (modelNote) notes.push(modelNote);
      problems = checkPullRequest(pr, config);
      // Provenance (#756): the line names each desk that worked on the branch, and a
      // reviewer is another model (record 0045). Only status files here can say what ran.
      problems.push(...provenanceFindings(parseMadeWith(pr.body)?.roles ?? null, readBranchDesks(root, env, pr.branch)));
      // Each change file the pull request leaves (#132) must be one `yokoten changelog` can read.
      for (const file of pr.files.filter(isChangeFile)) {
        const text = readAtHead(file);
        if (text !== null) problems.push(...parseChange(file, text).problems);
      }
      // Owned paths set the lowest tier, from the base branch's CODEOWNERS.
      const owned = checkOwnedTier(pr, readCodeOwners(root, pr.base, env));
      if (owned) problems.push(owned);
      // Dependabot can't write our body (#299): those rules are notes for it, never a silent skip.
      const split = splitForDependabot(pr, problems);
      problems = split.problems;
      notes.push(...split.notes);
    }
  } else {
    problems = mode === 'history' ? checkHistory(root, { config, env, notes }) : check(root, { config, env, staged: mode === 'staged', notes });
    // A translation behind its English source (#87) is a note, for the whole tree only.
    const zones = mode === 'history' && config.privacy.utc ? historyTimeZones(root, env) : 0;
    if (zones) notes.push(timeZoneNote(zones));
  }
  return problems;
}

/** One commit's message, as `git log` gives it: the id and the whole body (#756). */
interface CommitMessage {
  commit: string;
  message: string;
}

/** The commits `ref` names, oldest first, with their messages. A range names its own commits. */
function readCommitMessages(root: string, env: Invocation['env'], ref: string): CommitMessage[] {
  // A range names its own commits. Any other ref is one commit, not all of its history.
  const range = ref.includes('..');
  const text = readGit(root, ['log', ...(range ? [] : ['-1']), '--no-color', '--format=%H%x00%B%x00%x00', '--end-of-options', ref, '--'], { env }).toString('utf8');
  return text
    .split('\0\0')
    .filter((chunk) => chunk.trim() !== '')
    .map((chunk) => {
      const clean = chunk.replace(/^\n+/, '');
      const split = clean.indexOf('\0');
      return split === -1 ? { commit: clean.trim(), message: '' } : { commit: clean.slice(0, split).trim(), message: clean.slice(split + 1) };
    })
    .filter((commit) => commit.commit !== '');
}

/** The agents a provenance line names, as `vendor (model)`, or `none`. */
const agentsText = (agents: { vendor: string; model: string }[]): string => (agents.length ? agents.map((agent) => `${agent.vendor} (${agent.model})`).join(', ') : 'none');

/** One commit's provenance, with the approver the host's reviews name ('' when unknown). It is what --json prints. */
export type ProvenanceRow = ReturnType<typeof parseProvenance> & { approver: string };

/** What `provenance --json` prints (issue #1115): one object per row the screen shows, an unknown approver as null. */
export function provenanceJson(rows: readonly ProvenanceRow[]): { commit: string; subject: string; writers: ProvenanceRow['writers']; reviewers: ProvenanceRow['reviewers']; approver: string | null; tier: ProvenanceRow['tier']; issues: ProvenanceRow['issues'] }[] {
  return rows.map((row) => ({ commit: row.commit, subject: row.subject, writers: row.writers, reviewers: row.reviewers, approver: row.approver || null, tier: row.tier, issues: row.issues }));
}

/** The screen of `yokoten provenance` (#756, #1115): per commit, its title, then one field per role. */
export function provenanceScreen(rows: readonly ProvenanceRow[], ref: string): string[] {
  if (!rows.length) return title('provenance', `no commit in ${ref}`);
  return screen(
    ...rows.flatMap((record) => [
      title('provenance', `${record.commit.slice(0, 7)} ${record.subject}`),
      [
        ...field('writer', agentsText(record.writers)),
        ...field('reviewers', agentsText(record.reviewers)),
        ...field('approver', record.approver || 'unknown'),
        ...field('tier', record.tier ?? 'none'),
        ...field('issue', record.issues.length ? record.issues.map((issue) => `#${issue}`).join(', ') : 'none'),
      ],
    ]),
  );
}

/**
 * `yokoten provenance <ref>` (#756): for a commit or a range, the writer, reviewers,
 * approver, tier and issue that the squashed message and the host's reviews record.
 * The approver is the latest Approve on the pull request the subject names; gh that
 * can't answer leaves it unknown, never an error.
 */
export async function runProvenance(invocation: Invocation): Promise<number> {
  const options = parse('provenance', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  const ref = options.positional[0];
  if (!ref) return usage(invocation, 'give a commit or a range, such as `HEAD` or `main~3..main`');
  const root = requireRoot(invocation, invocation.cwd);
  if (!root) return 1;
  const json = options.flags.has('--json');
  let records: ReturnType<typeof parseProvenance>[];
  try {
    records = readCommitMessages(root, invocation.env, ref).map(({ commit, message }) => parseProvenance(commit, message));
  } catch (err) {
    if (!(err instanceof GitReadError)) throw err;
    const problem = gitReadFinding(err);
    if (json) printJson(invocation, { command: 'provenance', ok: false, findings: [problem] });
    else print(invocation, failure('provenance', problem.what, '`git log --oneline -3` shows the commits git can name here'), invocation.stderr);
    return 1;
  }
  if (!records.length) {
    if (json) printJson(invocation, provenanceJson([]));
    else show(invocation, provenanceScreen([], ref));
    return 0;
  }
  const gh = ghIn(root, invocation.env, GH_TIMEOUT_MS);
  const approvers = new Map<string, string>();
  const approverOf = (subject: string): string => {
    const number = /\(#(\d+)\)\s*$/.exec(subject)?.[1];
    if (!number) return '';
    if (!approvers.has(number)) approvers.set(number, readApproverLogin(gh, Number(number)));
    return approvers.get(number) ?? '';
  };
  const rows: ProvenanceRow[] = records.map((record) => ({ ...record, approver: approverOf(record.subject) }));
  if (json) printJson(invocation, provenanceJson(rows));
  else show(invocation, provenanceScreen(rows, ref));
  return 0;
}

/** Past this many characters with no line end, the text goes out at its last space or tab, so memory stays small. */
const MAX_PENDING = 1 << 20;

/** Where to cut text that has no line end yet: after its last space or tab, or the whole of it. Never inside a word. */
export function cutPoint(pending: string, max: number = MAX_PENDING): number {
  const line = pending.lastIndexOf('\n') + 1;
  if (line > 0 || pending.length <= max) return line;
  const space = Math.max(pending.lastIndexOf(' '), pending.lastIndexOf('\t'));
  return space === -1 ? pending.length : space + 1;
}

/** A failure in one word with no path in it: an error code such as EACCES, or the error's name. */
export function failureWord(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  const name = (err as Error | null)?.name;
  const word = typeof code === 'string' ? code : typeof name === 'string' ? name : '';
  return /^[A-Za-z_]{1,40}$/.test(word) ? word : 'error';
}

/**
 * Send `stream` through `redact` to `write`, a piece at a time: whole lines, or text cut at
 * a space (cutPoint). Resolves null when every piece was redacted and written. Else it
 * resolves the error that stopped it: then nothing more is written, and the rest of the
 * input is read and dropped, so a closed pipe never stops the command that writes it (#1006).
 */
export function redactStream(stream: NodeJS.ReadableStream, redact: (text: string) => string, write: (text: string) => void): Promise<unknown> {
  let failure: unknown = null;
  let pending = '';
  const send = (text: string) => {
    if (!text || failure !== null) return;
    try {
      write(redact(text));
    } catch (err) {
      failure = err ?? new Error('redact failed');
    }
  };
  return new Promise((settle) => {
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      if (failure !== null) return;
      pending += chunk;
      const cut = cutPoint(pending);
      if (cut === 0) return;
      send(pending.slice(0, cut));
      pending = pending.slice(cut);
    });
    stream.on('end', () => {
      send(pending);
      settle(failure);
    });
    stream.on('error', (err) => settle(failure ?? err ?? new Error('stdin failed')));
  });
}

/**
 * `yokoten redact`: stdin to stdout, with the owner hidden. It works line by line, so a
 * long output streams through. It reads only this machine (no network). It fails closed
 * (#1006): when it can't hide the output fully, it prints no more of it, reads the rest and
 * drops it, says so in one line on stderr, and exits 1. Then the wrapper (wrapForRedact)
 * prints REDACT_FAILED. A marks file that is not there is no failure: the built-in rules
 * (secrets, emails, home folder, git name) still run. A marks file it can't read is a
 * failure. On exit 0 the wrapper gives the command's own exit code, through pipefail.
 */
export function runRedact(invocation: Invocation): number | Promise<number> {
  const { env, stdout } = invocation;
  const options = parse('redact', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  // One failure screen on stderr (#1115): what stopped it, and the one thing to do next.
  const refuse = (why: string, err: unknown, next: string) => fail(invocation, `the output is hidden, because ${why} (${failureWord(err)})`, next);
  let redact: ((text: string) => string) | null = null;
  let setupError: unknown = null;
  try {
    const found = machineMarks(env, { cwd: invocation.cwd });
    redact = makeRedactor(
      {
        marks: loadMarks(env),
        owners: [...found.filter((mark) => mark.kind === 'git name' || mark.kind === 'git email').map((mark) => mark.value), ...machineUserNames(env)],
        hosts: found.filter((mark) => mark.kind === 'private remote host').map((mark) => mark.value),
      },
      env,
    );
  } catch (err) {
    setupError = err ?? new Error('redact failed');
  }
  // With nothing to redact by, the first piece fails: nothing is written, and the input is drained.
  const pieces =
    redact ??
    (() => {
      throw setupError;
    });
  return new Promise((settle) => {
    stdout.on('error', () => settle(0));
    void redactStream(invocation.stdin.stream, pieces, (text) => stdout.write(text)).then((err) => {
      if (!redact) settle(refuse('it could not read what to hide, such as your private-marks file', setupError, '`yokoten marks` says whether your private marks can be read'));
      else if (err === null) settle(0);
      else settle(refuse('a piece of it could not be redacted', err, 'run the command again; `yokoten doctor` checks the setup'));
    });
  });
}

// ---- `yokoten test` (#461) ----

/**
 * The files Node's test runner finds by its own default patterns (`*.test.ts`, `test-*.js`,
 * everything under a `test/` folder, and the rest), out of the files git lists. A build
 * folder such as `dist/` is ignored by git, so its copies are never tested (issue #1044).
 */
const TEST_FILE = /(?:^|\/)(?:[^/]*[._-]test|test-[^/]*|test)\.[cm]?[jt]s$|(?:^|\/)test\/.+\.[cm]?[jt]s$/;
export const testFilesOf = (files: readonly string[]): string[] => files.filter((file) => !/(?:^|\/)node_modules\//.test(file) && TEST_FILE.test(file));

/** What `yokoten test` will run, as plain data: the files, how many at once, and the command. */
export interface TestPlan {
  /** The test files git lists, or null when words after `--` name them, or git can't list them. */
  files: string[] | null;
  light: boolean;
  jobs: number;
  cores: number;
  freeBytes: number;
  hasNice: boolean;
  /** The command as a person reads it: `node`, and the file list as a count. */
  shown: string;
}

/** The plan in a few words, for a title. */
function planText(plan: TestPlan): string {
  const files = plan.files === null ? 'the tests you named' : count(plan.files.length, 'test file');
  if (!plan.light) return `${files}, every core: the light run is off`;
  return `${files}, ${plan.jobs} at once${plan.hasNice ? ', niced' : ''}`;
}

/** `yokoten test --print`: what it would run, and why, and nothing run (#461). */
export function testPlanScreen(plan: TestPlan): string[] {
  const why = plan.light
    ? `${plan.jobs} at once: ${count(plan.cores, 'core')}, ${(plan.freeBytes / 1024 ** 3).toFixed(1)} GB free${plan.hasNice ? `, nice ${NICE_LEVEL}` : ', no nice here'}`
    : 'the light run is off';
  return screen(
    title('test', `would run ${planText(plan)}`),
    spaced([field('command', plan.shown), field('why', why), field('off', `${OFF_SWITCH}=0, or --heavy`)]),
  );
}

/** The row after the runner's own words: passed, or failed with the one thing to do. */
export function testEndScreen(status: number): string[] {
  if (status === 0) return row('done', 'tests passed');
  return screen(row('MISSING', `tests failed (exit ${status})`), nextSentence('fix the failures above, then run `yokoten test` again'));
}

/**
 * `yokoten test`: Node's test runner, light on a shared machine. Words after `--` go to the
 * runner as they are. `YOKOTEN_LIGHT_TESTS=0` or `--heavy` turns the light run off. With no
 * words it runs the test files git lists, so a build folder is never tested, and the dot
 * reporter keeps a passing run to a few lines (issue #1044).
 */
export function runTest(invocation: Invocation): number {
  const { args, env } = invocation;
  // Everything after `--` is for the test runner, unchanged.
  const end = args.indexOf('--');
  const options = parse('test', end === -1 ? args : args.slice(0, end));
  if (typeof options === 'string') return usage(invocation, options);
  const words = end === -1 ? [] : args.slice(end + 1);
  const light = isLight(env) && !options.flags.has('--heavy');
  const freeBytes = freeMemory();
  const jobs = testJobs(cores(), freeBytes);
  const hasNice = (invocation.platform ?? 'linux') !== 'win32' && onPath('nice', env);
  let files: string[] | null = null;
  if (!words.some((word) => !word.startsWith('-'))) {
    try {
      const listed = readGit(invocation.cwd, ['-c', 'core.quotePath=false', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { env }).toString('utf8').split('\0');
      files = testFilesOf(listed).filter((file) => existsSync(join(invocation.cwd, file)));
    } catch {
      files = null; // not in a repo: the runner's own patterns
    }
  }
  const reporter = words.some((word) => word.startsWith('--test-reporter')) ? [] : ['--test-reporter=dot'];
  const command = testCommand([...reporter, ...words, ...(files ?? [])], { light, jobs, hasNice });
  const shownWords = testCommand([...reporter, ...words, ...(files === null ? [] : [`<${count(files.length, 'test file')}>`])], { light, jobs, hasNice });
  const shown = [shownWords.file, ...shownWords.args].map((word) => (word === process.execPath ? 'node' : word)).join(' ');
  const plan: TestPlan = { files, light, jobs, cores: cores(), freeBytes, hasNice, shown };
  if (options.flags.has('--print')) {
    show(invocation, testPlanScreen(plan));
    return 0;
  }
  if (files !== null && !files.length) return fail(invocation, 'no test files here: none of the files git lists is named as a test', 'yokoten test -- <file>');
  // One screen around the runner (#1027): the plan first, the runner's own words as they are,
  // and one row at the end. The exit code is the runner's, unchanged.
  show(invocation, title('test', planText(plan)));
  const result = spawnSync(command.file, command.args, { cwd: invocation.cwd, stdio: 'inherit', windowsHide: true });
  if (result.error) return fail(invocation, `can't run the tests: ${result.error.message}`, 'yokoten test --print');
  const status = result.status ?? 1;
  print(invocation, testEndScreen(status), status === 0 ? invocation.stdout : invocation.stderr);
  return status;
}

// ---- `yokoten marks` (#447) ----

const MARK_ACTIONS = ['allow', 'add', 'remove', 'fill', 'off', 'on'];
const SHAPE = '`yokoten marks allow <mark> --here`, or `yokoten marks allow --remove <mark> --here`';

/** What to type when a write failed: the doctor, which says why. */
const DOCTOR_NEXT = 'run `yokoten doctor` to see why';
/** What to type after a refused allow: the same command, which reads the file again. */
const ALLOW_AGAIN = 'run `yokoten marks allow <mark> --here` again';
/** What to type when HOME is not set. */
const HOME_NEXT = 'set HOME to your home folder, then run `yokoten marks` again';

export function runMarks(invocation: Invocation): number | Promise<number> {
  const { args } = invocation;
  // After `--`, every word is a word, so a mark may start with `-`.
  const end = args.indexOf('--');
  const options = parse('marks', end === -1 ? args : args.slice(0, end));
  // The parser repeats the word it can't read; here it may be a mark, so it is never shown.
  if (typeof options === 'string') {
    return usage(invocation, options.startsWith('unknown option') ? `an unknown option; to give a mark that starts with -, put it after --, as in \`yokoten marks allow --here -- <mark>\`` : `too many words; give one mark, as in ${SHAPE}`);
  }
  const words = [...options.positional, ...(end === -1 ? [] : args.slice(end + 1))];
  if (words.length > 2) return usage(invocation, `too many words; give one mark, as in ${SHAPE}`);
  const [action, mark] = words;
  // The other actions, and `yokoten marks` alone, which counts the marks (#434).
  if (action === undefined || (MARK_ACTIONS.includes(action) && action !== 'allow')) {
    if (options.flags.size) return usage(invocation, `--here and --remove go with allow only: ${SHAPE}`);
    return runMarkAction(invocation, action, mark);
  }
  if (!MARK_ACTIONS.includes(action)) return usage(invocation, `the action is add, remove, fill, off, on or allow; run \`yokoten marks\` alone to count your marks`);
  if (mark === undefined || !mark.trim()) return usage(invocation, `give the mark: ${SHAPE}`);
  if (!options.flags.has('--here')) return usage(invocation, `add --here: an allow is always for one repo, the one you are in`);
  return allowHere(invocation, mark.trim().toLowerCase(), { isRemoving: options.flags.has('--remove') });
}

/** The kinds `yokoten marks` counts, in the order it shows them. */
const SHOWN_KINDS = ['git name', 'git email', 'forge login', 'private remote host', 'by hand'];
/** The word the command line uses for a kind: `git name` is `git-name`. */
const kindWord = (kind: string): string => kind.replace(/ /g, '-');
const KIND_WORDS = Object.keys(SWITCHED_KINDS).join(', ');
/** Where install reads each kind, for when this machine has none to add. */
const SOURCES: Record<string, string> = {
  'git name': 'git has no user.name here',
  'git email': 'git has no user.email here, or it is a noreply address, which is public',
  'forge login': 'gh is not signed in here',
};

/** Run `yokoten marks [add | remove | fill | off <kind> | on <kind>]`. `word` is the second word, if any. */
export function runMarkAction(invocation: Invocation, action: string | undefined, word: string | undefined): number | Promise<number> {
  try {
    marksFile(invocation.env);
  } catch {
    return fail(invocation, NO_HOME, HOME_NEXT);
  }
  if (action === undefined) return showCounts(invocation);
  if (action === 'add' || action === 'remove') {
    // A mark on the command line would land in the shell history, so it is refused, and never repeated.
    if (word !== undefined) return usage(invocation, `the mark is never a word on the command line, where your shell history keeps it. Run \`yokoten marks ${action}\` and type it, or pipe it in`);
    return readHidden(invocation).then((value) => changeOne(invocation, action, value));
  }
  if (action === 'fill') {
    if (word !== undefined) return usage(invocation, 'fill takes no word: run `yokoten marks fill`');
    return fill(invocation);
  }
  const kind = word === undefined ? undefined : SWITCHED_KINDS[word];
  if (!kind) return usage(invocation, `name the kind: ${KIND_WORDS}, as in \`yokoten marks ${action} git-name\``);
  return action === 'off' ? turnOff(invocation, kind) : turnOn(invocation, kind);
}

/** The word `yokoten marks` uses for a kind, in a row: short, and never a value. */
const KIND_LABELS: Record<string, string> = {
  'git name': 'git-name',
  'git email': 'git-email',
  'forge login': 'forge-login',
  'private remote host': 'private host',
  'by hand': 'your own',
};
const INSTALL_KINDS = new Set(['git name', 'git email', 'forge login']);
const kindLabel = (kind: string): string => KIND_LABELS[kind] ?? kind;

/** What `yokoten marks` counts, as plain data: never a value. */
export interface MarkCounts {
  /** Each kind shown, in order, with its count and whether install adds it. */
  kinds: { kind: string; count: number; isOff: boolean; isFromInstall: boolean }[];
  /** The files the count read, when there is more than the default (#656). */
  files: string[];
}

/**
 * What one `yokoten marks` run did, as plain data (issue #1115): the screen is built from it
 * and from nothing else. It holds kinds, counts and file names, never a mark's value.
 */
export type MarksResult =
  /** `yokoten marks`: the counts, read only. */
  | ({ action: 'list' } & MarkCounts)
  /** `marks add`: added, or already there. */
  | { action: 'add'; isAdded: boolean }
  /** `marks remove`: removed or not there; `from` is the kind install found it as, when it did. */
  | { action: 'remove'; isRemoved: boolean; from?: string; isSwitched: boolean }
  /** `marks off <kind>`: how many marks of the kind install had added were taken out. */
  | { action: 'off'; kind: string; removed: number }
  /** `marks on <kind>`: whether this machine has one of the kind, and whether it was added now. */
  | { action: 'on'; kind: string; found: number; isAdded: boolean }
  /** `marks fill`: the kinds this machine gave that the file lacked, and the file they went in. */
  | { action: 'fill'; found: number; kinds: string[]; file: string }
  /** `marks allow [--remove] <mark> --here`: whether the allow file changed. */
  | { action: 'here'; isRemoving: boolean; isChanged: boolean };

/** Words in a list: `a`, `a and b`, `a, b and c`. */
const andList = (words: readonly string[]): string => (words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`);

/** The words of the kinds this machine can give, for when it gave none. */
const MACHINE_KINDS = 'a git name, a git email, a gh login or a private git host';

/** The screen of a `yokoten marks` run (#434, #447, #1115): what is true now, never a value. */
export function marksScreen(result: MarksResult): string[] {
  switch (result.action) {
    case 'list': {
      const total = result.kinds.reduce((sum, kind) => sum + kind.count, 0);
      const rows = result.kinds.map(({ kind, count: found, isOff, isFromInstall }) => field(kindLabel(kind), `${found}${isOff ? ', off: install does not add it' : isFromInstall ? ', added by install' : ''}`));
      return screen(
        title('marks', `${total} private ${total === 1 ? 'mark' : 'marks'}, values never shown`),
        spaced([
          ...(rows.length ? rows : [row('note', 'no private marks yet')]),
          // The count is of every file the check reads (#656): the setting's file adds to the default.
          ...(result.files.length > 1 ? [row('note', `read from ${result.files[0]} and the file YOKOTEN_PRIVATE_MARKS names`)] : []),
        ]),
        wrap('Add one: ', '`yokoten marks add`'),
      );
    }
    case 'add':
      return title('marks', result.isAdded ? 'added the mark to your private marks (not shown)' : 'that mark is already in your private marks, so nothing changed');
    case 'remove': {
      if (!result.isRemoved) return title('marks', 'that mark is not in your private marks, so nothing changed');
      const { from } = result;
      return screen(
        title('marks', 'removed the mark from your private marks'),
        from === undefined ? [] : row('note', result.isSwitched ? `it came from this machine (your ${from}), so install adds it again` : `it came from this machine (a ${from}), so install adds it again while this machine has it`),
        result.isSwitched && from !== undefined ? field('stop it', `\`yokoten marks off ${kindWord(from)}\``) : [],
      );
    }
    case 'off':
      return screen(
        title('marks', `install no longer adds your ${result.kind}`),
        [...row('done', `removed ${count(result.removed, 'mark')} it had added; marks you added yourself are kept`), ...field('undo', `\`yokoten marks on ${kindWord(result.kind)}\``)],
      );
    case 'on': {
      const back = `install adds your ${result.kind} again`;
      return title('marks', result.isAdded ? `${back}, and added it now (not shown)` : result.found ? `${back}; there is nothing new to add now` : `${back}, but there is none to add now: ${SOURCES[result.kind]}`);
    }
    case 'fill':
      if (result.kinds.length) {
        return screen(
          title('marks', `added your ${andList(result.kinds)} from this machine (not shown)`),
          field('file', result.file),
        );
      }
      return title('marks', result.found ? 'nothing new from this machine, so nothing changed' : `this machine has none to add (${MACHINE_KINDS}), so nothing changed`);
    case 'here':
      if (!result.isChanged) return title('marks', result.isRemoving ? 'that mark is not allowed here, so nothing changed' : 'that mark is already allowed here, so nothing changed');
      return result.isRemoving
        ? title('marks', 'the allow is taken back; the checks stop that mark in this repo again')
        : screen(
            title('marks', 'that mark is allowed in this repo only'),
            [...row('note', 'the allow is kept on this machine, not in the repo'), ...field('undo', '`yokoten marks allow --remove <mark> --here`')],
          );
  }
}

/** `yokoten marks`: the counts, read only. */
function showCounts(invocation: Invocation): number {
  let counts: Map<string, number>;
  try {
    counts = countMarkKinds(invocation.env);
  } catch {
    return fail(invocation, "your private-marks file can't be read", DOCTOR_NEXT);
  }
  const off = new Set(kindsTurnedOff(invocation.env));
  const kinds = [...SHOWN_KINDS, ...[...counts.keys()].filter((kind) => !SHOWN_KINDS.includes(kind))]
    .filter((kind) => (counts.get(kind) ?? 0) > 0 || off.has(kind))
    .map((kind) => ({ kind, count: counts.get(kind) ?? 0, isOff: off.has(kind), isFromInstall: INSTALL_KINDS.has(kind) }));
  const files = marksFiles(invocation.env).length > 1 ? [paths(invocation.env).marks, 'YOKOTEN_PRIVATE_MARKS'] : [paths(invocation.env).marks];
  show(invocation, marksScreen({ action: 'list', kinds, files }));
  return 0;
}

/**
 * The one value the user gives: typed in a terminal with no echo, or all of stdin when it is
 * not a terminal. Null when the user stops it (Ctrl-C). The terminal part is kept thin: it
 * can only be tried by hand.
 */
function readHidden(invocation: Invocation): Promise<string | null> {
  const stream = invocation.stdin.stream as NodeJS.ReadStream;
  if (!isTerminal(invocation.stdin) || typeof stream.setRawMode !== 'function') return Promise.resolve(readInput(invocation.stdin));
  say(invocation, 'Type the mark, then press Enter (it is not shown): ', invocation.stderr);
  return new Promise((settle) => {
    let value = '';
    const finish = (result: string | null) => {
      stream.off('data', onData);
      stream.setRawMode(false);
      stream.pause();
      say(invocation, '\n', invocation.stderr);
      settle(result);
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n' || char === '\u0004') return finish(value);
        if (char === '\u0003') return finish(null);
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
      }
    };
    stream.setEncoding('utf8');
    stream.setRawMode(true);
    stream.on('data', onData);
    stream.resume();
  });
}

/** `marks add` or `marks remove` with the value read. */
function changeOne(invocation: Invocation, action: 'add' | 'remove', value: string | null): number {
  const again = `run \`yokoten marks ${action}\` and type it, or pipe it in`;
  if (value === null) return fail(invocation, 'stopped, so nothing changed', again);
  const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return fail(invocation, 'no mark was given, so nothing changed', again);
  if (lines.length > 1) return fail(invocation, 'give one mark at a time; nothing changed', again);
  const [mark] = lines;
  if (mark.startsWith('#')) return fail(invocation, "a mark can't start with #, because the file reads that line as a comment; nothing changed", again);
  const { env } = invocation;
  if (action === 'add') {
    let isAdded: boolean;
    try {
      isAdded = addOwnMark(env, mark);
    } catch {
      return fail(invocation, "your private-marks file can't be written, so nothing changed", DOCTOR_NEXT);
    }
    show(invocation, marksScreen({ action: 'add', isAdded }));
    return 0;
  }
  let removed: Mark[];
  try {
    removed = removeMarks(env, (one) => one.value === mark.toLowerCase());
  } catch {
    return fail(invocation, "your private-marks file can't be changed, so nothing changed", DOCTOR_NEXT);
  }
  if (!removed.length) {
    show(invocation, marksScreen({ action: 'remove', isRemoved: false, isSwitched: false }));
    return 0;
  }
  const off = new Set(kindsTurnedOff(env));
  const from = removed.map((one) => one.kind).find((kind): kind is string => kind !== null && !off.has(kind));
  const isSwitched = from !== undefined && (Object.values(SWITCHED_KINDS) as string[]).includes(from);
  show(invocation, marksScreen({ action: 'remove', isRemoved: true, isSwitched, ...(from === undefined ? {} : { from }) }));
  return 0;
}

/** `marks off <kind>`: kept in machine.json, and the marks install added of that kind taken out. */
function turnOff(invocation: Invocation, kind: string): number {
  const { env } = invocation;
  let removed: Mark[];
  try {
    setKindOff(env, kind, true);
    removed = removeMarks(env, (mark) => mark.kind === kind);
  } catch {
    return fail(invocation, "the machine state or your private-marks file can't be written, so the kind may still be on", `run \`yokoten marks off ${kindWord(kind)}\` again`);
  }
  show(invocation, marksScreen({ action: 'off', kind, removed: removed.length }));
  return 0;
}

/** `marks on <kind>`: the default again, and the kind filled from this machine now. */
function turnOn(invocation: Invocation, kind: string): number {
  const { env, cwd } = invocation;
  let added: string[];
  let found: number;
  try {
    setKindOff(env, kind, false);
    // gh may reach the network for the login: three seconds at most, and only for that kind.
    const marks = machineMarks(env, { cwd, gh: kind === 'forge login' ? ghIn(cwd, env, 3000) : undefined }).filter((mark) => mark.kind === kind);
    found = marks.length;
    added = fillMarks(env, marks);
  } catch {
    return fail(invocation, "the machine state or your private-marks file can't be written", `run \`yokoten marks on ${kindWord(kind)}\` again`);
  }
  show(invocation, marksScreen({ action: 'on', kind, found, isAdded: added.length > 0 }));
  return 0;
}

/**
 * `marks fill`: the marks this machine gives (git name and email, the gh login, private git
 * hosts) that the file lacks, added at its end, as doctor used to do on its own. A kind that is
 * off is never added. It says the kinds it wrote and the file, never a value.
 */
function fill(invocation: Invocation): number {
  const { env, cwd } = invocation;
  let found: number;
  let kinds: string[];
  try {
    // gh may reach the network for the login: three seconds at most.
    const marks = machineMarks(env, { cwd, gh: ghIn(cwd, env, 3000) });
    found = marks.length;
    kinds = fillMarks(env, marks);
  } catch {
    return fail(invocation, "your private-marks file can't be written, so it may not have every mark", 'run `yokoten doctor` to see why, then `yokoten marks fill` again');
  }
  show(invocation, marksScreen({ action: 'fill', found, kinds, file: paths(env).marks }));
  return 0;
}

/** Past this age, a lock file is from a run that died, and is taken over. */
const STALE_LOCK_MS = 30_000;

/** Add the mark to this repo's entry in the machine allow file, or with `isRemoving`, take it out. */
function allowHere(invocation: Invocation, mark: string, { isRemoving }: { isRemoving: boolean }): number {
  const { env } = invocation;
  const root = requireRoot(invocation, invocation.cwd);
  if (!root) return 1;
  let file: string;
  let marks: string[];
  try {
    file = machineAllowFile(env);
    marks = loadMarks(env);
  } catch (err) {
    if ((err as Error).message === NO_HOME) return fail(invocation, NO_HOME, HOME_NEXT);
    return fail(invocation, "your private-marks file can't be read, so nothing was changed", DOCTOR_NEXT);
  }
  // Only a mark the file holds: anything else is not private to this machine, so nothing to allow.
  if (!isRemoving && !marks.includes(mark)) return fail(invocation, 'that is not a line of your private-marks file, so there is nothing to allow', 'check the spelling, or add it first with `yokoten marks add`');
  const key = repoKey(root, env);
  if ('none' in key) return fail(invocation, `nothing was changed, because ${key.none}`, 'put the mark in `privacy.allow` in yokoten.json instead');
  if ('unsure' in key) return fail(invocation, `nothing was changed, because ${key.unsure}`, ALLOW_AGAIN);
  // A link to the file is kept: the file it points to is the one changed. A link to nothing is refused.
  let target = file;
  if (isLink(file)) {
    try {
      target = realpathSync(file);
    } catch {
      return fail(invocation, "nothing was changed, because this machine's allow file is a link to a file that is not there", `fix the link or remove it, then ${ALLOW_AGAIN}`);
    }
  }
  const lock = `${target}.lock`;
  try {
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  } catch {
    return fail(invocation, "nothing was changed, because the allow file's folder can't be written", DOCTOR_NEXT);
  }
  const locked = takeLock(lock);
  if (locked !== 'taken') {
    return locked === 'busy' ? fail(invocation, 'nothing was changed, because another `yokoten marks` is changing the allow file', ALLOW_AGAIN) : fail(invocation, "nothing was changed, because the allow file's folder can't be written", DOCTOR_NEXT);
  }
  try {
    // Read inside the lock, so a change another run made is kept.
    const read = readMachineAllow(env);
    if ('unsure' in read) return fail(invocation, `nothing was changed, because ${read.unsure}`, `fix it or delete it, then ${ALLOW_AGAIN}`);
    const found = matchingEntries(read.entries, key);
    if (found.length > 1) return fail(invocation, "nothing was changed, because two entries in this machine's allow file match this repo", `delete one, then ${ALLOW_AGAIN}`);
    const entry = found[0];
    const has = entry?.allow.some((allowed) => allowed.toLowerCase() === mark) ?? false;
    let entries: AllowEntry[];
    if (isRemoving) {
      if (!entry || !has) {
        show(invocation, marksScreen({ action: 'here', isRemoving, isChanged: false }));
        return 0;
      }
      const left = entry.allow.filter((allowed) => allowed.toLowerCase() !== mark);
      entries = left.length ? read.entries.map((one) => (one === entry ? { ...one, allow: left } : one)) : read.entries.filter((one) => one !== entry);
    } else {
      if (has) {
        show(invocation, marksScreen({ action: 'here', isRemoving, isChanged: false }));
        return 0;
      }
      entries = entry ? read.entries.map((one) => (one === entry ? { ...one, allow: [...one.allow, mark] } : one)) : [...read.entries, { remote: key.remote, allow: [mark] }];
    }
    try {
      save(target, entries, read.skipOwnName);
    } catch {
      return fail(invocation, "the allow file can't be written, so nothing was changed", DOCTOR_NEXT);
    }
    // Say what the file now says, never what was meant to happen.
    const now = machineAllowed(env, root);
    const isAllowed = now.allow.includes(mark);
    if (now.unsure || isAllowed === isRemoving) return fail(invocation, 'the allow file does not say what was asked', DOCTOR_NEXT);
    show(invocation, marksScreen({ action: 'here', isRemoving, isChanged: true }));
    return 0;
  } finally {
    rmSync(lock, { force: true });
  }
}

/**
 * Make the lock file: 'taken', 'busy' when another run holds it, or 'unwritable'. A lock left
 * by a run that died is taken over atomically: it is renamed away under a name of this run's
 * own, then made again with `wx`, so of two runs that try at once, the one whose `wx` loses is
 * busy. A lock renamed away that turns out fresh (another run had just taken it over) is put
 * back with a hard link, which never replaces one made since.
 */
function takeLock(lock: string): 'taken' | 'busy' | 'unwritable' {
  const make = (): 'taken' | 'busy' | 'unwritable' => {
    try {
      closeSync(openSync(lock, 'wx', 0o600));
      return 'taken';
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'EEXIST' ? 'busy' : 'unwritable';
    }
  };
  const first = make();
  if (first !== 'busy') return first;
  const isStale = (path: string) => Date.now() - statSync(path).mtimeMs >= STALE_LOCK_MS;
  const away = `${lock}.${process.pid}.${randomUUID()}.stale`;
  try {
    if (!isStale(lock)) return 'busy';
    renameSync(lock, away);
  } catch {
    return make(); // released or taken over meanwhile: one more try decides
  }
  let isFresh: boolean;
  try {
    isFresh = !isStale(away);
  } catch {
    return 'busy';
  }
  if (isFresh) {
    // Another run's live lock: put it back. If that fails, it is left where it is, never deleted.
    try {
      linkSync(away, lock);
      rmSync(away, { force: true });
    } catch {
      // busy either way
    }
    return 'busy';
  }
  rmSync(away, { force: true });
  return make();
}

/** Write the file whole, readable by its owner only, through a temporary file so a crash never leaves half of it. */
function save(file: string, entries: AllowEntry[], skipOwnName?: false): void {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(skipOwnName === false ? { skipOwnName, repos: entries } : { repos: entries }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

// ---- Actions health (#647) ----
//
// `yokoten ci-health` reads the last 200 Actions runs and the checks of the open pull
// requests through gh, then writes one Markdown report to one issue, `CI health`, which
// it creates and pins on the first run. A scheduled workflow updates it in place. The
// report says what is red and why: a failed run on main, a failed or cancelled check on
// an open pull request, a slow workflow, a long wait, or a workflow and branch that both
// passed and failed in the window. The branch a merge lands on is the repo's default.

/** How long one gh read may take before the command stops waiting. */
const CI_HEALTH_TIMEOUT = 30000;
/** The title of the one issue the report lives in. The report body starts with its marker. */
const CI_HEALTH_ISSUE = 'CI health';
/** How many runs one report reads: two pages of 100. */
const CI_HEALTH_RUNS = 200;

/** The conclusions that mean a run failed. A cancelled run is counted apart: it is not a failure. */
const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'action_required', 'startup_failure']);
/** The conclusions that keep a check green. A cancelled check is not here: it shows as a red x. */
const PASSING_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);
/** The conclusions of a completed run. */
const COMPLETED_STATUS = 'completed';

/** One Actions run, as the report needs it. Times are GitHub's own ISO stamps. */
export interface HealthRun {
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

/** One workflow over the window: how often it ran, failed, was cancelled, and how long it took and waited. */
export interface WorkflowHealth {
  workflow: string;
  runs: number;
  failed: number;
  cancelled: number;
  /** Middle run time in milliseconds, or null when no run gave both stamps. */
  medianRunTime: number | null;
  /** Middle wait before the run started, in milliseconds, or null. */
  medianWaitTime: number | null;
}

/** One failed or cancelled check on an open pull request. */
export interface PullCheckProblem {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  check: string;
  conclusion: string;
}

/** A workflow and branch that both passed and failed in the window: a sign of flakiness or of work in progress. */
export interface UnstableWorkflow {
  workflow: string;
  branch: string;
  passes: number;
  failures: number;
}

/** Everything the report shows. */
export interface ActionsHealth {
  /** The branch a merge lands on: `main` unless the repo says otherwise. */
  defaultBranch: string;
  runs: HealthRun[];
  workflows: WorkflowHealth[];
  mainFailures: HealthRun[];
  mainCancelled: HealthRun[];
  pullProblems: PullCheckProblem[];
  slowest: HealthRun[];
  unstable: UnstableWorkflow[];
}

/** The repo's default branch, or `main` when gh can't say. */
export function readDefaultBranch(gh: Gh, repo: string): string {
  try {
    return gh(['repo', 'view', repo, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name']).trim() || 'main';
  } catch {
    return 'main';
  }
}

/** One row of the Actions run list as a run, or null when it has no usable id. */
function parseHealthRun(value: unknown): HealthRun | null {
  if (!isObject(value) || typeof value.id !== 'number' || !Number.isSafeInteger(value.id) || value.id <= 0) return null;
  return {
    id: value.id,
    workflow: asText(value.name),
    event: asText(value.event),
    branch: asText(value.head_branch),
    status: asText(value.status),
    conclusion: asText(value.conclusion),
    createdAt: asText(value.created_at),
    startedAt: asText(value.run_started_at),
    updatedAt: asText(value.updated_at),
    url: asText(value.html_url),
  };
}

/** Why a gh read failed, in words a beginner can act on. */
export function healthReadFailed(err: unknown, what: string): string {
  if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'gh is not installed: get it from https://cli.github.com, then run `gh auth login`';
  const said = String((err as { stderr?: string }).stderr || '')
    .split('\n')[0]
    .trim();
  return `gh can't read the ${what}${said ? ` (${said})` : ''}: run \`gh auth login\`, and check the repo`;
}

/** The gh words for one page of 100 Actions runs. The kanban reads the first page too. */
export const actionsRunsQuery = (repo: string, page = 1): string[] => ['api', `repos/${repo}/actions/runs?per_page=100&page=${page}`];

/** One page of gh's Actions run list: its runs and how many rows it held, or why it is no list. JSON that does not parse throws. */
export function actionsRunPage(text: string): { runs: HealthRun[]; rows: number } | string {
  const raw: unknown = JSON.parse(text);
  if (!isObject(raw) || !Array.isArray(raw.workflow_runs)) return 'gh gave no Actions run list: run it again';
  const runs: HealthRun[] = [];
  for (const row of raw.workflow_runs) {
    const run = parseHealthRun(row);
    if (run) runs.push(run);
  }
  return { runs, rows: raw.workflow_runs.length };
}

/** The last `max` Actions runs of `repo`, newest first, or why gh can't read them. */
export function readActionsRuns(gh: Gh, repo: string, max: number = CI_HEALTH_RUNS): HealthRun[] | string {
  const pages = Math.ceil(max / 100);
  const runs: HealthRun[] = [];
  try {
    for (let page = 1; page <= pages; page++) {
      const found = actionsRunPage(gh(actionsRunsQuery(repo, page)));
      if (typeof found === 'string') return found;
      runs.push(...found.runs);
      if (found.rows < 100) break;
    }
  } catch (err) {
    return healthReadFailed(err, 'Actions runs');
  }
  runs.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return runs.slice(0, max);
}

/** One check's time: completedAt, startedAt, or createdAt when it has neither. NaN when no stamp parses. */
function checkTime(entry: Record<string, unknown>): number {
  for (const key of ['completedAt', 'startedAt', 'createdAt']) {
    const time = Date.parse(asText(entry[key]));
    if (!Number.isNaN(time)) return time;
  }
  return NaN;
}

/**
 * The latest run of each check on one pull request. A later green run clears an old red
 * one. A check with no name stands alone. A dateless run never beats a dated one.
 */
function latestChecks(entries: unknown[]): Record<string, unknown>[] {
  const byName = new Map<string, Record<string, unknown>>();
  const nameless: Record<string, unknown>[] = [];
  for (const entry of entries) {
    if (!isObject(entry)) continue;
    const name = asText(entry.name) || asText(entry.context);
    if (!name) {
      nameless.push(entry);
      continue;
    }
    const seen = byName.get(name);
    if (seen === undefined) {
      byName.set(name, entry);
      continue;
    }
    const seenTime = checkTime(seen);
    const entryTime = checkTime(entry);
    if (Number.isNaN(entryTime)) continue;
    if (Number.isNaN(seenTime) || entryTime > seenTime) byName.set(name, entry);
  }
  return [...byName.values(), ...nameless];
}

/** A check's conclusion: a check run's conclusion, or a commit status's state. Lower case, or ''. */
const checkConclusion = (entry: Record<string, unknown>): string => (asText(entry.conclusion) || asText(entry.state)).toLowerCase();

/** True when a check is done. A commit status says PENDING until it is not. */
const checkIsDone = (entry: Record<string, unknown>): boolean => asText(entry.status) === 'COMPLETED' || (asText(entry.state) !== '' && asText(entry.state) !== 'PENDING');

/** The failed or cancelled checks of the open pull requests, or why gh can't read them. */
export function readHealthPullChecks(gh: Gh, repo: string): PullCheckProblem[] | string {
  const query = ['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '100', '--json', 'number,title,url,isDraft,statusCheckRollup'];
  let rows: unknown;
  try {
    rows = JSON.parse(gh(query));
  } catch (err) {
    return healthReadFailed(err, 'open pull requests');
  }
  if (!Array.isArray(rows)) return 'gh gave no pull request list: run it again';
  const problems: PullCheckProblem[] = [];
  for (const row of rows) {
    if (!isObject(row) || typeof row.number !== 'number' || !Number.isSafeInteger(row.number)) continue;
    const rollup = Array.isArray(row.statusCheckRollup) ? row.statusCheckRollup : [];
    for (const entry of latestChecks(rollup)) {
      if (!checkIsDone(entry)) continue;
      const conclusion = checkConclusion(entry);
      if (PASSING_CONCLUSIONS.has(conclusion)) continue;
      const check = asText(entry.name) || asText(entry.context) || 'check';
      problems.push({
        number: row.number,
        title: asText(row.title),
        url: asText(row.url),
        isDraft: row.isDraft === true,
        check,
        conclusion: conclusion || 'no conclusion',
      });
    }
  }
  return problems;
}

/** The time between two stamps in milliseconds, or NaN when one does not parse. */
function timeBetween(from: string, to: string): number {
  const start = Date.parse(from);
  const end = Date.parse(to);
  return Number.isNaN(start) || Number.isNaN(end) ? NaN : end - start;
}

/** The middle of a list of numbers, rounded, or null when it is empty. */
function medianNumber(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

/** The workflows over the window, the ones with the most failed or cancelled runs first. */
function summarizeWorkflows(runs: HealthRun[]): WorkflowHealth[] {
  const groups = new Map<string, HealthRun[]>();
  for (const run of runs) {
    if (!run.workflow) continue;
    const group = groups.get(run.workflow);
    if (group) group.push(run);
    else groups.set(run.workflow, [run]);
  }
  const health = [...groups].map(([workflow, rows]) => {
    const completed = rows.filter((run) => run.status === COMPLETED_STATUS);
    return {
      workflow,
      runs: rows.length,
      failed: rows.filter((run) => FAILED_CONCLUSIONS.has(run.conclusion)).length,
      cancelled: rows.filter((run) => run.conclusion === 'cancelled').length,
      medianRunTime: medianNumber(completed.map((run) => timeBetween(run.startedAt, run.updatedAt)).filter(Number.isFinite)),
      medianWaitTime: medianNumber(completed.map((run) => timeBetween(run.createdAt, run.startedAt)).filter(Number.isFinite)),
    };
  });
  return health.sort((a, b) => b.failed + b.cancelled - (a.failed + a.cancelled) || b.runs - a.runs || a.workflow.localeCompare(b.workflow));
}

/** The workflow and branch pairs that both passed and failed in the window, the most failures first. */
function findUnstable(runs: HealthRun[]): UnstableWorkflow[] {
  const groups = new Map<string, UnstableWorkflow>();
  for (const run of runs) {
    if (run.status !== COMPLETED_STATUS || !run.branch) continue;
    const passed = run.conclusion === 'success';
    const failed = FAILED_CONCLUSIONS.has(run.conclusion);
    if (!passed && !failed) continue;
    const key = `${run.workflow}\n${run.branch}`;
    const seen = groups.get(key);
    if (seen) {
      if (passed) seen.passes++;
      else seen.failures++;
    } else groups.set(key, { workflow: run.workflow, branch: run.branch, passes: passed ? 1 : 0, failures: failed ? 1 : 0 });
  }
  return [...groups.values()]
    .filter((group) => group.passes > 0 && group.failures > 0)
    .sort((a, b) => b.failures - a.failures || b.passes - a.passes)
    .slice(0, 5);
}

/** What the runs and pull request checks add up to. */
export function summarizeActionsHealth(runs: HealthRun[], pullProblems: PullCheckProblem[], defaultBranch = 'main'): ActionsHealth {
  const completed = runs.filter((run) => run.status === COMPLETED_STATUS && Number.isFinite(timeBetween(run.startedAt, run.updatedAt)));
  return {
    defaultBranch,
    runs,
    workflows: summarizeWorkflows(runs),
    mainFailures: runs.filter((run) => run.branch === defaultBranch && FAILED_CONCLUSIONS.has(run.conclusion)),
    mainCancelled: runs.filter((run) => run.branch === defaultBranch && run.conclusion === 'cancelled'),
    pullProblems,
    slowest: [...completed].sort((a, b) => timeBetween(b.startedAt, b.updatedAt) - timeBetween(a.startedAt, a.updatedAt)).slice(0, 5),
    unstable: findUnstable(runs),
  };
}

/** A time in minutes, or seconds below one minute. */
function minutesText(milliseconds: number | null): string {
  if (milliseconds === null) return '—';
  return milliseconds < 60000 ? `${Math.round(milliseconds / 1000)} s` : `${(milliseconds / 60000).toFixed(1)} min`;
}

/**
 * A table cell: no pipe, one line. The text comes from GitHub, so the work stays linear:
 * each line is trimmed and joined, and no pattern scans a whitespace run twice.
 * A backslash is escaped first, or `a\|b` would close the cell.
 */
const cellText = (text: string): string =>
  text
    .replace(/[\\|]/g, '\\$&')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');

/** The run as one line: workflow, event, branch, conclusion, time, link. */
function runLine(run: HealthRun): string {
  const where = run.branch ? ` on \`${run.branch}\`` : '';
  const link = run.url ? ` — <${run.url}>` : '';
  return `- \`${run.workflow}\` (${run.event})${where}: **${run.conclusion}** at ${utcText(run.updatedAt)}${link}`;
}

/** Markdown paragraphs: blocks of lines, one blank line between them. */
const markdownOf = (blocks: readonly (readonly string[])[]): string => `${blocks.filter((block) => block.length).map((block) => block.join('\n')).join('\n\n')}\n`;

/** The Markdown body of the `CI health` issue. */
export function renderActionsHealth(health: ActionsHealth, { repo, now }: { repo: string; now: Date }): string {
  const { runs, mainFailures, mainCancelled, pullProblems } = health;
  const main = health.defaultBranch;
  const problems = mainFailures.length + mainCancelled.length + pullProblems.length;
  const head = [
    ['<!-- yokoten:ci-health -->'],
    ['# CI health'],
    [`_Updated ${utcText(now.toISOString())}. Reads the last ${runs.length} Actions runs of \`${repo}\` and the checks of its open pull requests. This issue is updated in place; pin it to keep it in view._`],
  ];
  if (!runs.length) return markdownOf([...head, ['No Actions runs in this window. Check that CI is on for this repo.']]);
  const oldest = runs.reduce((earliest, run) => (Date.parse(run.createdAt) < Date.parse(earliest.createdAt) ? run : earliest), runs[0]);
  const shown = health.workflows.slice(0, 12);
  return markdownOf([
    ...head,
    [`Window: ${utcText(oldest.createdAt)} to ${utcText(now.toISOString())}. Newest run first.`],
    [
      problems
        ? `**${problems} problem${problems === 1 ? ' needs' : 's need'} a look:** ${mainFailures.length} failed on \`${main}\`, ${mainCancelled.length} cancelled on \`${main}\`, ${pullProblems.length} failed or cancelled on open pull requests.`
        : `**No failed or cancelled run on \`${main}\`, and no failed or cancelled check on an open pull request.**`,
    ],
    ['## Main'],
    !mainFailures.length && !mainCancelled.length ? [`No failed or cancelled run on \`${main}\` in this window.`] : [...mainFailures, ...mainCancelled].map(runLine),
    ['## Open pull requests'],
    !pullProblems.length
      ? ['Every check on every open pull request passed, or is still running.']
      : [
          '| Pull request | Check | Result |',
          '| --- | --- | --- |',
          ...pullProblems.map((problem) => `| [#${problem.number} ${cellText(problem.title)}](${problem.url || '#'})${problem.isDraft ? ' (draft)' : ''} | ${cellText(problem.check)} | ${cellText(problem.conclusion)} |`),
        ],
    ['## Workflows'],
    !shown.length
      ? ['No workflow gave its name in the window.']
      : [
          '| Workflow | Runs | Failed | Cancelled | Median run | Median wait |',
          '| --- | ---: | ---: | ---: | ---: | ---: |',
          ...shown.map((workflow) => `| ${cellText(workflow.workflow)} | ${workflow.runs} | ${workflow.failed} | ${workflow.cancelled} | ${minutesText(workflow.medianRunTime)} | ${minutesText(workflow.medianWaitTime)} |`),
        ],
    shown.length && health.workflows.length > shown.length ? [`${health.workflows.length - shown.length} more workflow(s) ran in this window.`] : [],
    ['_Wait is the time a run spent queued before it started._'],
    ['## Slowest runs'],
    !health.slowest.length
      ? ['No completed run gave a time.']
      : health.slowest.map((run) => `- ${minutesText(timeBetween(run.startedAt, run.updatedAt))}: \`${run.workflow}\`${run.branch ? ` on \`${run.branch}\`` : ''}${run.url ? ` — <${run.url}>` : ''}`),
    ['## What passed and failed on one branch'],
    !health.unstable.length
      ? ['None: every workflow and branch either always passed or never did in this window.']
      : health.unstable.map((group) => `- \`${group.workflow}\` on \`${group.branch}\`: ${group.passes} passed, ${group.failures} failed`),
    ['## What this counts'],
    [
      '- A run that is still queued or running is not a problem yet; only its latest check counts.',
      '- A cancelled run is listed apart from a failure. It still shows as a red x, so it is worth removing at its cause.',
      '- A rerun that passes clears an old failure on the same check name.',
      '- The window is the last 200 runs GitHub returned, newest first, not a fixed clock.',
    ],
  ]);
}

/** Text from GitHub on one line of a screen: no control character, no line break. */
const oneLine = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();

/** A table on a screen whose text starts where the text of a row with no label does, so every text of the screen starts in one column. */
const rowTable = (rows: readonly TableRow[]): string[] => table(rows.map(([label, text]) => [oneLine(label), oneLine(text)]), MARK_COLUMN);

/** What `yokoten ci-health` read, as plain data: the screen and the issue body are both built from it. */
export interface CiHealthResult {
  repo: string;
  health: ActionsHealth;
  /** Why gh could not read the open pull requests' checks, when it could not. */
  pullsError?: string;
  /** Where --write put the report. */
  posted?: PostedHealth;
  /** --dry-run: the report only, with no next step. */
  isDryRun?: boolean;
}

/**
 * The screen of `yokoten ci-health` (#647, #1115): what is red on the default branch and on
 * open pull requests, as rows, then the workflows, the slowest runs and what both passed and
 * failed, as tables. Every text starts in one column. With --write, where the report went.
 */
export function ciHealthScreen(result: CiHealthResult): string[] {
  const { health, repo, posted } = result;
  const problems = health.mainFailures.length + health.mainCancelled.length + health.pullProblems.length;
  const said = `${count(health.runs.length, 'run')}: ${count(problems, 'problem')}`;
  if (posted) return screen(title('ci-health', `${posted.created ? 'opened' : 'updated'} issue #${posted.number} in ${repo}${posted.pinned ? '' : ' (not pinned yet)'}`), row('ok', said));
  const main = health.defaultBranch;
  const mainRows = [...health.mainFailures, ...health.mainCancelled].map((run) => [
    ...row(run.conclusion === 'cancelled' ? 'note' : 'MISSING', `${oneLine(run.workflow)}: ${run.conclusion} at ${utcText(run.updatedAt)} (${run.event})`),
    ...(run.url ? underRow(run.url, false) : []),
  ]);
  const pullRows = health.pullProblems.map((problem) => [
    ...row('MISSING', `PR #${problem.number} ${oneLine(problem.check)}: ${problem.conclusion}${problem.isDraft ? ' (draft)' : ''}`),
    ...underRow(oneLine(problem.title), false),
  ]);
  const shown = health.workflows.slice(0, 12);
  return screen(
    title('ci-health', health.runs.length ? `${repo}, the last ${said}` : `${repo}: no Actions runs; check that CI is on`),
    section(`On ${main}`, mainRows.length ? spaced(mainRows) : row('ok', `no failed or cancelled run on ${main}`)),
    section('Open pull requests', pullRows.length ? spaced(pullRows) : result.pullsError === undefined ? row('ok', 'every check passed, or is still running') : [...row("can't check", 'gh could not read the checks of the open pull requests'), ...underRow('Fix: `gh auth status`', false)]),
    section('Workflows', rowTable(shown.map((workflow) => [workflow.workflow, `${count(workflow.runs, 'run')}, ${workflow.failed} failed, ${workflow.cancelled} cancelled; ${minutesText(workflow.medianRunTime)} a run, ${minutesText(workflow.medianWaitTime)} waiting`]))),
    shown.length && health.workflows.length > shown.length ? summaryLine(`${count(health.workflows.length - shown.length, 'more workflow')} ran in this window`) : [],
    section('Slowest runs', rowTable(health.slowest.map((run) => [minutesText(timeBetween(run.startedAt, run.updatedAt)), `${run.workflow}${run.branch ? ` on ${run.branch}` : ''}`]))),
    section('Passed and failed on one branch', rowTable(health.unstable.map((group) => [group.workflow, `${group.branch}: ${group.passes} passed, ${group.failures} failed`]))),
    result.isDryRun ? [] : nextSentence('`yokoten ci-health --write` puts it in the pinned issue "CI health"'),
  );
}

/** One posted report: the issue, whether this run made it, and whether it could be pinned. */
export interface PostedHealth {
  number: number;
  created: boolean;
  pinned: boolean;
}

/** The number of the open `CI health` issue, 0 when there is none, or why gh can't read the list. */
function findHealthIssue(gh: Gh, repo: string): number | string {
  try {
    const rows: unknown = JSON.parse(gh(['issue', 'list', '--repo', repo, '--state', 'open', '--limit', '100', '--search', `"${CI_HEALTH_ISSUE}" in:title`, '--json', 'number,title']));
    if (!Array.isArray(rows)) return 'gh gave no issue list: run it again';
    for (const row of rows) if (isObject(row) && asText(row.title) === CI_HEALTH_ISSUE && typeof row.number === 'number') return row.number;
    return 0;
  } catch (err) {
    return healthReadFailed(err, 'issue list');
  }
}

/** Create or update the one report issue, through a temporary body file, then pin it. */
export function postHealthIssue(gh: Gh, repo: string, body: string): PostedHealth | string {
  const found = findHealthIssue(gh, repo);
  if (typeof found === 'string') return found;
  const dir = mkdtempSync(join(tmpdir(), 'yokoten-ci-health-'));
  const file = join(dir, 'body.md');
  try {
    writeFileSync(file, body, { mode: 0o600 });
    let number = found;
    let created = false;
    if (number) gh(['issue', 'edit', String(number), '--repo', repo, '--body-file', file]);
    else {
      const url = gh(['issue', 'create', '--repo', repo, '--title', CI_HEALTH_ISSUE, '--body-file', file]).trim();
      const match = url.match(/\/(\d+)\/?$/);
      if (!match) return `gh made an issue but gave no number (${url}): run the command again`;
      number = Number(match[1]);
      created = true;
    }
    let pinned = false;
    try {
      gh(['issue', 'pin', String(number), '--repo', repo]);
      pinned = true;
    } catch {
      // An older gh has no `issue pin`, or the token may not pin: the report still stands.
    }
    return { number, created, pinned };
  } catch (err) {
    return healthReadFailed(err, 'report issue');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * `yokoten ci-health`: read Actions health and print it. Only `--write` posts it to the one
 * pinned issue: a bare command reads and shows, and never writes (issue #1046).
 */
export function runCiHealth(invocation: Invocation): number {
  const options = parse('ci-health', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  const isWrite = options.flags.has('--write');
  if (isWrite && options.flags.has('--dry-run')) return usage(invocation, '--write posts the report and --dry-run only prints it; pass one of them');
  const root = requireRoot(invocation, invocation.cwd);
  if (!root) return 1;
  const { env } = invocation;
  const given = options.values['--repo'];
  const stated = given || env.GITHUB_REPOSITORY || '';
  const origin = readOriginUrl(root, env);
  const repo = stated || repoOf(origin) || '';
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    // Say which value was wrong, and show what the person typed (#1115); the remote's URL may name a machine path, so it is not shown.
    const why = given ? `--repo ${shownValue(given)} is not owner/name`
      : env.GITHUB_REPOSITORY ? `GITHUB_REPOSITORY is ${shownValue(env.GITHUB_REPOSITORY)}, not owner/name`
      : origin ? 'the origin remote is not a GitHub repo, and no --repo was given'
      : 'no --repo, no GITHUB_REPOSITORY and no origin remote';
    return fail(invocation, `no GitHub repo to read: ${why}`, 'yokoten ci-health --repo owner/name');
  }
  const gh = ghIn(root, env, CI_HEALTH_TIMEOUT);
  const defaultBranch = readDefaultBranch(gh, repo);
  const runs = readActionsRuns(gh, repo);
  if (typeof runs === 'string') return fail(invocation, runs, 'gh auth status');
  const pulls = readHealthPullChecks(gh, repo);
  const result: CiHealthResult = { repo, health: summarizeActionsHealth(runs, typeof pulls === 'string' ? [] : pulls, defaultBranch), isDryRun: options.flags.has('--dry-run') };
  if (typeof pulls === 'string') result.pullsError = pulls;
  // A bare run and --dry-run read and show, and change nothing (issue #1046).
  if (!isWrite) {
    show(invocation, ciHealthScreen(result));
    return 0;
  }
  let body = renderActionsHealth(result.health, { repo, now: new Date() });
  if (typeof pulls === 'string') body += `\n> The open pull request checks were not read: ${pulls}\n`;
  const posted = postHealthIssue(gh, repo, body);
  if (typeof posted === 'string') return fail(invocation, posted, 'gh auth status');
  // One screen: where the report is, then what it found (issue #1027).
  show(invocation, ciHealthScreen({ ...result, posted }));
  return 0;
}

// ---- Borrowed code (record 0024) ----

/** The issue for one changed source. The title meets the issue-title rule of this repo. */
export function borrowedIssue(change: BorrowedChange): { title: string; body: string; labels: string[] } {
  const title = change.isSecurity ? 'check: take a borrowed security fix' : 'check: review borrowed code upstream';
  const labels = change.isSecurity ? ['bug', 'hotfix', 'tier B'] : ['bug', 'tier B'];
  const where = change.files.map((path) => `- \`${path}\``).join('\n');
  const newest = change.latestCommit === null ? 'the file is gone from the default branch' : `\`${change.latestCommit}\``;
  const commits = change.commits.length
    ? change.commits.map((commit) => `- \`${commit.sha}\` ${commit.message.split('\n')[0]}`).join('\n')
    : '- none the host could list';
  const security = change.isSecurity ? '\n**Upstream names a security fix. Take it first.**\n' : '';
  const note = change.note ? `\n${change.note}.\n` : '';
  const body = [
    `Upstream changed \`${change.source}\` after the commit we borrowed.`,
    security + note,
    `Borrowed files:\n${where}`,
    `Borrowed commit: \`${change.borrowedCommit}\``,
    `Newest commit on the default branch: ${newest}`,
    `Commits after the borrowed one:\n${commits}`,
    'Record 0024: re-take the part we need, or say in this issue why the change does not touch it.',
  ].join('\n\n');
  return { title, body: `${body}\n`, labels };
}

/**
 * Whether an open issue already names this source, so a later run opens no second one.
 * An answer that is not a list throws: it is a gap, not "none open", so the run stops
 * instead of opening a duplicate.
 */
export function hasOpenIssue(gh: Gh, source: string): boolean {
  const text = gh(['issue', 'list', '--state', 'open', '--limit', '500', '--json', 'number,body']);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('gh did not give an issue list');
  }
  if (!Array.isArray(json)) throw new Error('gh did not give an issue list');
  return json.some((issue) => isObject(issue) && asText(issue.body).includes(source));
}

/** What became of one moved source's issue: shown only, opened, already open, or not opened. */
export interface BorrowedIssueOutcome {
  change: BorrowedChange;
  title: string;
  /** The issue's body and labels, as it is (or would be) opened. */
  body: string;
  labels: string[];
  state: 'would open' | 'opened' | 'open already' | 'failed';
  /** Why the issue was not opened, for `failed`. */
  reason?: string;
}

/** One run of `yokoten borrowed`, as plain data (issue #1115). */
export interface BorrowedResult {
  /** How many sources the wheels name. */
  sources: number;
  outcomes: BorrowedIssueOutcome[];
  unreadable: BorrowedWatch['unreadable'];
}

/**
 * What `borrowed --json` prints (issue #1115): the sources that moved and the ones the host
 * could not answer for, then the issue each moved source gets. It is made from the result
 * the screen is built from; with --json nothing is opened, so each outcome is `would open`.
 */
export function borrowedJson(result: BorrowedResult): { borrowed: BorrowedWatch; issues: { source: string; title: string; body: string; labels: string[] }[] } {
  return {
    borrowed: { changed: result.outcomes.map((outcome) => outcome.change), unreadable: result.unreadable },
    issues: result.outcomes.map((outcome) => ({ source: outcome.change.source, title: outcome.title, body: outcome.body, labels: outcome.labels })),
  };
}

/** Text from the host in a row: one line, and no backticks, so it never reads as a command to type. */
const hostText = (text: string): string => oneLine(text).replace(/`/g, "'");

/**
 * The screen of `yokoten borrowed` (record 0024, #1115): the count first, then a row per
 * source that moved, with what became of its issue under it, and a row per source the host
 * could not answer for. When an issue could not be opened or a source read, the next step.
 */
export function borrowedScreen(result: BorrowedResult): string[] {
  const moved = result.outcomes.length;
  const said: Record<BorrowedIssueOutcome['state'], (outcome: BorrowedIssueOutcome) => string> = {
    'would open': (outcome) => `would open "${outcome.title}"`,
    opened: (outcome) => `opened "${outcome.title}"`,
    'open already': () => 'an issue for it is open already',
    failed: (outcome) => `could not open its issue: ${hostText(outcome.reason ?? 'gh gave no answer')}`,
  };
  const marks: Record<BorrowedIssueOutcome['state'], RowMark> = { 'would open': 'next', opened: 'done', 'open already': 'ok', failed: 'MISSING' };
  const rows = [
    ...result.outcomes.map((outcome) => [...row(marks[outcome.state], `${outcome.change.source} moved ${count(outcome.change.commits.length, 'commit')}`), ...underRow(said[outcome.state](outcome), false)]),
    ...result.unreadable.map((gap) => row("can't check", `${gap.source}: ${hostText(gap.reason)}`)),
  ];
  const isFailed = result.unreadable.length > 0 || result.outcomes.some((outcome) => outcome.state === 'failed');
  return screen(
    title('borrowed', `${count(result.sources, 'source')}, ${moved ? `${count(moved, 'source')} moved` : 'none moved'}`),
    spaced(rows),
    isFailed ? nextSentence('sign gh in (`gh auth status`), then run `yokoten borrowed` again') : [],
  );
}

/**
 * `yokoten borrowed`: compare each wheel with upstream's default branch, and open one
 * issue per source that moved (record 0024). A security fix is called out. With
 * `--dry-run` it writes nothing; with `--json` it prints the report and writes nothing.
 */
export async function runBorrowed(invocation: Invocation): Promise<number> {
  const options = parse('borrowed', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  const isDryRun = options.flags.has('--dry-run');
  const json = options.flags.has('--json');
  const root = requireRoot(invocation, invocation.cwd, json ? (missing) => ({ borrowed: { changed: [], unreadable: [] }, ok: false, findings: [missing] }) : undefined);
  if (!root) return 1;
  const { env } = invocation;
  const files = borrowedFiles(indexFiles(root, env), (path) => {
    try {
      return readFileSync(join(root, path), 'utf8');
    } catch {
      return null;
    }
  });
  const gh = ghIn(root, env, GH_TIMEOUT_MS);
  const watch = watchBorrowed(files, borrowedHost(gh));
  const result: BorrowedResult = { sources: new Set(files.map((file) => file.source)).size, outcomes: [], unreadable: watch.unreadable };
  for (const change of watch.changed) {
    const issue = borrowedIssue(change);
    const outcome = (state: BorrowedIssueOutcome['state'], reason?: string): BorrowedIssueOutcome => ({ change, ...issue, state, ...(reason === undefined ? {} : { reason }) });
    // --json writes nothing, as --dry-run does: it says what would be opened.
    if (isDryRun || json) {
      result.outcomes.push(outcome('would open'));
      continue;
    }
    try {
      if (hasOpenIssue(gh, change.source)) {
        result.outcomes.push(outcome('open already'));
        continue;
      }
      gh(['issue', 'create', ...issue.labels.flatMap((label) => ['--label', label]), '--title', issue.title, '--body', issue.body]);
      result.outcomes.push(outcome('opened'));
    } catch (error) {
      result.outcomes.push(outcome('failed', error instanceof Error ? error.message : String(error)));
    }
  }
  if (json) {
    printJson(invocation, borrowedJson(result));
    return watch.unreadable.length ? 1 : 0;
  }
  const isFailed = watch.unreadable.length > 0 || result.outcomes.some((outcome) => outcome.state === 'failed');
  print(invocation, borrowedScreen(result), isFailed ? invocation.stderr : invocation.stdout);
  return isFailed ? 1 : 0;
}
// ---- `yokoten pr sync` (#432) ----
//
// The lead runs this after every merge. Each open pull request whose branch is behind its
// base gets the base merged in, the two mechanical conflicts resolved, typecheck and the
// touched tests run, and the branch pushed as the bot. Anything else stops with the files,
// the hunks and a dispatch brief. It never force-pushes, rebases or edits on GitHub.

/** How long one git or gh call in the sync may take. */
const PR_SYNC_TIMEOUT_MS = 120_000;

/** The environment for every git call of the sync: no prompt, and UTC commit times (#809). */
export function prSyncEnv(env: Env): Env {
  return { ...env, GIT_TERMINAL_PROMPT: '0', TZ: 'UTC' };
}

/** One pull request in the sync's report: what its sync did, and its base branch. A fork's branch is not synced. */
export type PrSyncPull = SyncOutcome & { base: string; isFork?: boolean };

/** One run of `yokoten pr sync`, as plain data (issue #1115). */
export interface PrSyncResult {
  pulls: PrSyncPull[];
  /** The open list stopped at its limit, so some pull requests were not synced. */
  isCut: boolean;
}

/** Lines of a tool's own text under a heading, indented as rows are and never wrapped: a hunk or a brief keeps its form. */
const verbatim = (text: string): string[] => text.split('\n').map((line) => (line === '' ? line : `${' '.repeat(ROW_INDENT)}${line}`));

/**
 * The screen of `yokoten pr sync` (#432, #1027, #1115): the count, a row per pull request,
 * then for each one that needs an agent its files, its conflict hunks and the dispatch brief
 * as sections, and the one thing to do next.
 */
export function prSyncScreen(result: PrSyncResult): string[] {
  const needing = result.pulls.filter((pull) => pull.state === 'needs-agent');
  const rows = result.pulls.map((pull) => (pull.isFork ? row('note', 'needs an agent: the branch is in a fork, which yokoten does not push', `PR #${pull.number}`) : pullLine(pull)));
  // The list gh gives stops at its limit (#809): said once, as a row of the screen.
  if (result.isCut) rows.push(row('note', `stops at ${OPEN_PULL_LIMIT} pull requests; the rest are not synced`, 'open list'));
  return screen(
    title('pr sync', result.pulls.length ? `${count(result.pulls.length, 'open pull request')}${needing.length ? `, ${needing.length} ${needing.length === 1 ? 'needs' : 'need'} an agent` : ''}` : 'no open pull requests'),
    spaced(rows),
    ...needing.flatMap((pull) => [
      section(`PR #${pull.number}, files`, (pull.files ?? []).flatMap(verbatim)),
      section(`PR #${pull.number}, conflict hunks`, (pull.hunksText ?? []).flatMap(verbatim)),
      section(`PR #${pull.number}, dispatch brief`, verbatim(pull.brief ?? '').filter((line, at, all) => line !== '' || at < all.length - 1)),
    ]),
    needing.length ? nextSentence('hand each dispatch brief to an agent, then run `yokoten pr sync` again') : [],
  );
}

/** One open pull request's branches, as `gh pr list` gives them. */
export async function runPr(invocation: Invocation): Promise<number> {
  const options = parse('pr', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  const action = options.positional[0];
  if (action !== 'sync') {
    return usage(invocation, action === undefined ? 'give the action: `yokoten pr sync`' : `"${action}" is not an action of pr; the one action is sync`);
  }
  const { env, cwd } = invocation;
  const root = requireRoot(invocation, cwd);
  if (!root) return 1;

  let remote = '';
  try {
    remote = execFileSync('git', ['config', '--get', 'remote.origin.url'], { cwd: root, env: prSyncEnv(env), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    // Reported below, with the same words whatever git said.
  }
  const repo = repoOf(remote);
  const refuse = (what: string, next: string): number => {
    print(invocation, failure('pr sync', what, next), invocation.stderr);
    return 1;
  };
  if (!repo) return refuse('the origin remote is not a GitHub repo, so there is nothing to list', '`git remote -v` shows the origin remote');

  let open: ReturnType<typeof readOpenPulls>;
  try {
    open = readOpenPulls(ghIn(root, env, GH_TIMEOUT_MS), repo);
  } catch (err) {
    return refuse(`gh could not list the open pull requests: ${(err as Error).message.split('\n')[0]}`, 'gh auth status');
  }
  if (typeof open === 'string') return refuse(open, 'gh auth status');
  if (!open.pulls.length) {
    show(invocation, prSyncScreen({ pulls: [], isCut: open.isCut }));
    return 0;
  }

  // The branches and base branches must be here before any merge. One fetch is enough.
  const fetched = spawnSync('git', ['fetch', '--prune', 'origin'], { cwd: root, env: prSyncEnv(env), encoding: 'utf8', timeout: PR_SYNC_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
  if (fetched.status !== 0) return refuse(`git fetch origin failed: ${String(fetched.stderr || fetched.stdout).trim().split('\n')[0]}`, 'git fetch origin');

  const git = (args: string[], worktree: string): GitRun => {
    const result = spawnSync('git', ['--no-replace-objects', ...args], {
      cwd: worktree,
      env: prSyncEnv(env),
      encoding: 'utf8',
      timeout: PR_SYNC_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
  // The token is asked for once, and only when a branch is ready to push.
  let token: Promise<string> | null = null;
  const push = async (worktree: string, branch: string): Promise<{ ok: boolean; said: string }> => {
    try {
      token ??= (async () => {
        const config = botConfig(env);
        if (typeof config === 'string') throw new Error(config);
        return installationToken(config, repo);
      })();
      const value = await token;
      const pushed = spawnSync('git', ['push', 'origin', `HEAD:refs/heads/${branch}`], {
        cwd: worktree,
        env: botEnv(env, value),
        encoding: 'utf8',
        timeout: PR_SYNC_TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
      });
      if (pushed.error) return { ok: false, said: pushed.error.message.split('\n')[0] };
      return { ok: pushed.status === 0, said: String(pushed.stderr || pushed.stdout).trim().split('\n').slice(-1)[0] ?? '' };
    } catch (err) {
      return { ok: false, said: (err as Error).message.split('\n')[0] };
    }
  };

  const result: PrSyncResult = { pulls: [], isCut: open.isCut };
  for (const pull of open.pulls) {
    if (pull.isFork) {
      result.pulls.push({ number: pull.number, branch: pull.branch, base: pull.base, state: 'needs-agent', isFork: true });
      continue;
    }
    const outcome = await syncPull({
      root,
      number: pull.number,
      branch: pull.branch,
      base: pull.base,
      git,
      push,
      verify: (worktree, files) => verifyMerge(worktree, files, env),
      tempRoot: join(root, '.tmp', 'yokoten-pr-sync'),
    });
    result.pulls.push({ ...outcome, base: pull.base });
  }
  show(invocation, prSyncScreen(result));
  return result.pulls.some((pull) => pull.state === 'needs-agent') ? 1 : 0;
}

/**
 * The rows a pull request gets in the sync's report (#432, #1027): its state in plain words,
 * and for one that needs an agent, the file it conflicts on and what to do next.
 */
export function pullLine(outcome: SyncOutcome & { base: string }): string[] {
  const label = `PR #${outcome.number}`;
  if (outcome.state === 'up-to-date') return row('ok', `up to date with ${outcome.base}`, label);
  if (outcome.state === 'merged') return row('ok', `${outcome.base} merged in, tests pass, pushed`, label);
  if (outcome.state === 'resolved') return row('ok', `${outcome.base} merged in (${outcome.hunks ?? 0} hunk${outcome.hunks === 1 ? '' : 's'} resolved), tests pass, pushed`, label);
  const lines = outcome.files?.length ? row('MISSING', `conflict in ${outcome.files.join(', ')}`, label) : row('MISSING', 'needs an agent', label);
  lines.push(...underRow('not mechanical: the hunks and the brief are below'));
  return lines;
}
