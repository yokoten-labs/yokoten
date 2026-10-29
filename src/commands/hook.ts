// `yokoten hook`: the tool-call guard, and with --stop the end-of-turn check.

import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { isPathInside, isSamePath } from '../platform/paths.ts';
import { Writable } from 'node:stream';
import type { DropReason, SortedEnv } from '../agents/desk/agent-env.ts';
import * as claudeCode from '../agents/runtimes/claude-code.ts';
import { ADAPTERS, adapterFor, askOf, canAskOf, contextOf, isUnattended, rewriteOf, stopReaderOf } from '../agents/runtimes/runtime.ts';
import { type Env, loadConfig } from '../rules/config.ts';
import { addWorkerPath, findHeavyJob, gitLinkAbove, hardenRead, markNote, printsAccount, privateOutput, realPath, removeWorkerPath, settleAsk, stopsFile, stopsOffFile, withWorkerMark, WORKER_MARK, workerMarkAt, workerRole, wrapForRedact } from '../rules/guards/index.ts';
import { DESK_OWN_SANDBOX_NOTE, type Finding, finding, formatFinding, formatRefusal, notRepoFinding } from '../rules/text/message.ts';
import { shownValue } from '../rules/text/terminal.ts';
import { allowedOutput, askedOutput, fromGuardInput, type GuardOutput, parseGuardInput, protocolRefusal, refusedOutput } from '../run/protocol.ts';
import { checkChanged, readGit } from '../run/check.ts';
import { formatSpace, HOST_DISK_FIX, HOST_DRIVE, isLowOnSpace, readKeptHostDisk } from '../setup/doctor/host-disk.ts';
import {
  type Action,
  type Anchor,
  type AnchorOutcome,
  bumpDoneTries,
  bumpRepeat,
  canKeepStatus,
  changeAgentStatus,
  clearDoneTries,
  clearRefusedMarker,
  clearRepeats,
  commandShape,
  describeAction,
  DONE_TRY_LIMIT,
  doneTryKey,
  findStatusCheckout,
  listAnchors,
  recordAnchor,
  registerDesk,
  type Guard,
  guardDeadline,
  judgeWithDeadline,
  loadHookConfig,
  logStop,
  noteRefused,
  readDoneWhen,
  type Repo,
  agentIdOf,
  repeatKeyOf,
  repeatStopFinding,
  REPEAT_STOP_LIMIT,
  runDoneWhen,
  sessionIdOf,
  startFields,
  STATUS_EVERY_MS,
  stopsState,
  type StopAnswer,
  type StopEvent,
  wasRefusedRecently,
  writeAgentChecks,
} from '../run/hook.ts';
import { count, fail, field, type Invocation, nextLine, noteLine, type Output, parse, type Parsed, print, printJson, readInput, requireRoot, rootOf, row, say, screen, show, spaced, title, usage, wrap } from './shared.ts';

// Each runtime sends its tool call in its own shape; its adapter turns it into an Action.
// The table below asks the adapters' contract (#395), never a runtime's name.
export const READERS: Record<string, (input: unknown) => Action> = Object.fromEntries(
  Object.values(ADAPTERS).map((adapter) => [adapter.name, adapter.readToolCall]),
);

/** The unread team messages for the agent in `folder`, wrapped as data; '' when none (#674). */
const teamMessages = async (folder: string, env: Env, root: string | null): Promise<string> => {
  const { deliveryFor } = await import('../agents/desk/team/deliver.ts');
  return deliveryFor(folder, env, root);
};

// A runtime whose hook can change a command before it runs (#390) says so in its adapter.
// The others run the command as it is, unless yokoten.json "privacy.output" is "stop":
// then the core refuses it, with the wrapped command as the fix.

/**
 * How the wrapped command runs `yokoten redact`: the node that runs this hook and this
 * same copy of yokoten, each by its path, quoted for bash. Neither depends on the PATH.
 * The home folder is written `$HOME`, so the command names no user.
 */
export function redactCommand(node: string, cli: string, home: string | undefined): string {
  const homePath = home?.replaceAll('\\', '/').replace(/\/+$/, '');
  let realHome = homePath;
  try {
    if (home) realHome = realpathSync(home).replaceAll('\\', '/');
  } catch {}
  const quoted = (file: string) => {
    let path = file.replaceAll('\\', '/');
    try {
      path = realpathSync(file).replaceAll('\\', '/');
    } catch {}
    const escape = (text: string) => text.replace(/["$`\\]/g, (mark) => `\\${mark}`);
    for (const prefix of [homePath, realHome]) {
      if (prefix && path.startsWith(`${prefix}/`)) return `"$HOME/${escape(path.slice(prefix.length + 1))}"`;
    }
    return `"${escape(path)}"`;
  };
  return `${quoted(node)} ${quoted(cli)} redact`;
}

// Each runtime's event for the end of a turn is in its adapter (#211, #614).

/**
 * The yokoten repos (those with a `yokoten.json`) an edit's files are in, past the
 * session's own (#307). A worktree in another folder, or a session started above the repo,
 * loads no project hook, so the guard applies the file's own repo's rules. One `rootOf`
 * per folder and one config per repo. A command's paths count too: Codex runs apply_patch
 * through the shell (#221).
 */
function editRepos(invocation: Invocation, action: Action, base: string, session: Repo | null, commandsOnly: boolean): Repo[] {
  const rootByFolder = new Map<string, string | null>([[base, session?.root ?? null]]);
  const repos = new Map<string, Repo | null>();
  // In the full hook, the session's root already has its rules.
  if (session) repos.set(session.root, commandsOnly ? session : null);
  // The file's folder as written and where it really is: a link in a folder outside any repo
  // that points at a lead-only file is ruled by the repo it points into (#1225).
  const folders = action.paths.flatMap((path) => [dirname(resolve(base, path)), dirname(realPath(resolve(base, path)))]);
  for (let folder of new Set(folders)) {
    while (!existsSync(folder) && dirname(folder) !== folder) folder = dirname(folder);
    if (!rootByFolder.has(folder)) rootByFolder.set(folder, rootOf(folder, invocation.env));
    const root = rootByFolder.get(folder);
    if (!root || repos.has(root)) continue;
    repos.set(root, repoAt(invocation, root));
  }
  // A repo without yokoten.json still gets the safeguard (#816): the defaults, which stop
  // the five protections from turning off. No init and no setting is needed.
  return [...repos.values()].filter((repo): repo is Repo => repo !== null);
}

/** A repo's rules: its yokoten.json, or the defaults when it has none. */
function repoAt(invocation: Invocation, root: string): Repo {
  return { root, config: loadHookConfig(root, (line) => say(invocation, `${line}\n`, invocation.stderr)) };
}

/**
 * The stop check (#92, #614). The agent runs it when it is about to end its turn
 * (code.claude.com/docs/en/hooks#stop). Findings in the changed files send a lead back
 * once: exit 2, with the findings on stderr as the reason. `stop_hook_active` means it was
 * already sent back, so a lead's turn ends whatever is found: never a loop.
 *
 * A worker also runs the task's done-when command (or the changed-file check when the
 * brief has none). A failing check sends the worker back, with the output in short. After
 * DONE_TRY_LIMIT refusals the next stop is let through. The worker's message to the lead
 * must start with "NOT DONE: checks failing". A linked worktree's `.yokoten-agent.json`
 * gets `checks` set to `failing`, so the lead can see it. The board will show it later
 * (#603). The main checkout is not written. A pass sets `checks` to `passing`.
 * A subagent is a worker only by its own type. On any error the turn ends too, with one
 * line on stderr: a broken check must not trap a session.
 */
async function stopHook(invocation: Invocation, json: boolean, read: (input: unknown) => StopEvent | null, agent: string): Promise<number> {
  const { env } = invocation;
  let event: StopEvent | null;
  try {
    event = read(JSON.parse(readInput(invocation.stdin)));
  } catch {
    event = null;
  }
  if (!event) {
    if (json) printJson(invocation, { blocked: false, stop: false });
    return 0;
  }
  const folder = event.cwd ?? invocation.cwd;
  const folders = [folder, invocation.cwd];
  const key = doneTryKey(event.sessionId, folder);
  // Team messages (#674) come after the checks, never in their place. A turn sent back only
  // to read messages does not count as sent back: the next stop is checked in full.
  const messagesKey = `${key}-messages`;
  // Messages send a turn on at most once in a row, so a chatty sender can't keep an agent from stopping.
  const afterMessages = event.active && wasRefusedRecently(folder, messagesKey);
  if (afterMessages) event = { ...event, active: false };
  clearRefusedMarker(folder, messagesKey);
  const takeMessages = async (): Promise<string> => (event?.subagent ? '' : teamMessages(invocation.cwd, env, rootOf(invocation.cwd, env)));
  // SubagentStop fires for every subagent. Its own type decides. The parent session's
  // role does not: a reviewer started by a worker is not checked (#614).
  const isWorker = event.subagent ? event.worker : event.worker || workerRole(env, folders) !== null;
  if (event.subagent && !event.worker) {
    if (json) printJson(invocation, { blocked: false, stop: true, findings: [] });
    return 0;
  }
  if (event.active && !isWorker) {
    noteLeadStop(folder, agent);
    if (json) printJson(invocation, { blocked: false, stop: true, skipped: 'the agent was already sent back once', findings: [] });
    return 0;
  }
  let findings: Finding[];
  const notes: Finding[] = [];
  let root: string | null;
  try {
    root = rootOf(folder, env);
    // A worker by YOKOTEN_ROLE, by the mark on its worktree, or by the event (#555, #614).
    const marked = withWorkerMark(env, folders);
    const workerEnv = isWorker ? { ...marked, YOKOTEN_ROLE: 'worker' } : marked;
    findings = root ? checkChanged(root, { config: loadConfig(root), env: workerEnv, notes }) : [];
  } catch (err) {
    print(invocation, skippedNote(err), invocation.stderr);
    if (json) printJson(invocation, { blocked: false, stop: true, skipped: 'the check failed', findings: [] });
    return 0;
  }
  let doneWhen: { command: string; ok: boolean; output: string } | undefined;
  // A subagent runs in the worker's worktree only when the event's folder is that
  // worktree. Otherwise it shares the lead's folder (#614).
  // A broken `.git` still reads its own done-when, so run it in the desk it belongs to (#746).
  const link = isWorker ? gitLinkAbove(folder) : null;
  const ranIn = isWorker && root ? (event.subagent ? subagentDir(folder) : link?.top ?? root) : folder;
  if (isWorker && root) {
    const command = readDoneWhen(env, event.subagent ? ranIn : folder);
    if (command) {
      try {
        const ran = await runDoneWhen(command, ranIn, { ...env, YOKOTEN_ROLE: 'worker' });
        doneWhen = { command, ...ran };
      } catch (err) {
        print(invocation, skippedNote(err), invocation.stderr);
        if (json) printJson(invocation, { blocked: false, stop: true, skipped: 'the check failed', findings });
        return 0;
      }
    }
  }
  const failed = findings.length > 0 || doneWhen?.ok === false;
  if (!failed) {
    let anchor: Anchor | null = null;
    if (isWorker) {
      forgetDoneTries(env, key);
      clearRefusedMarker(folder, key);
      recordChecks(invocation, folder, 'passing', agent);
      // The tests pass: a clean tree becomes an anchor. Only a dirty tree asks for a
      // checkpoint commit; an anchored HEAD and a folder without git each get their own line.
      const passing = doneWhen?.ok === true ? doneWhen.command : 'the changed-file check';
      const outcome = root ? recordAnchor(ranIn, { ...env, YOKOTEN_ROLE: 'worker' }, passing) : null;
      anchor = outcome && (outcome.kind === 'recorded' || outcome.kind === 'already') ? outcome.anchor : null;
      if (!json) print(invocation, anchorNote(outcome), invocation.stderr);
    } else noteLeadStop(folder, agent);
    if (!json && notes.length) print(invocation, warningNotes(notes), invocation.stderr);
    // The checks pass: unread messages send the turn on once, and the next stop is checked again.
    const messages = event.active || afterMessages ? '' : await takeMessages();
    if (messages) {
      noteRefused(folder, messagesKey);
      if (json) printJson(invocation, { blocked: true, stop: false, findings, messages: true, ...(anchor ? { anchor } : {}) });
      print(invocation, [messages], invocation.stderr);
      return 2;
    }
    if (json) printJson(invocation, { blocked: false, stop: true, findings, ...(notes.length ? { notes } : {}), ...(anchor ? { anchor } : {}) });
    return 0;
  }
  if (!isWorker) {
    logTurnStop(invocation, agent, false, findings, doneWhen, 'refused');
    if (json) printJson(invocation, { blocked: true, stop: true, findings, ...(notes.length ? { notes } : {}) });
    print(invocation, screen(refusalLines(findings), warningNotes(notes)), invocation.stderr);
    return withMessages(invocation, 2, await takeMessages());
  }
  const bumped = bumpDoneTries(env, key);
  // No saved count: stop_hook_active, or a refusal of this worker in the last 5 minutes,
  // lets the stop through. A runtime that never sets stop_hook_active cannot trap it.
  if (bumped === null) {
    if (event.active || wasRefusedRecently(folder, key)) {
      logTurnStop(invocation, agent, true, findings, doneWhen, 'allowed once');
      return allowFailingStop(invocation, json, findings, notes, doneWhen, DONE_TRY_LIMIT, env, key, folder, agent);
    }
    noteRefused(folder, key);
    logTurnStop(invocation, agent, true, findings, doneWhen, 'refused');
    return withMessages(invocation, refuseFailingStop(invocation, json, findings, notes, doneWhen, 1, false), await takeMessages());
  }
  if (bumped > DONE_TRY_LIMIT) {
    logTurnStop(invocation, agent, true, findings, doneWhen, 'allowed once');
    return allowFailingStop(invocation, json, findings, notes, doneWhen, bumped, env, key, folder, agent);
  }
  logTurnStop(invocation, agent, true, findings, doneWhen, 'refused');
  return withMessages(invocation, refuseFailingStop(invocation, json, findings, notes, doneWhen, bumped, true), await takeMessages());
}

/** What a passing worker hears about its anchor, as a note on stderr. Only a dirty tree asks for a commit (#792). */
export function anchorNote(outcome: AnchorOutcome | null): string[] {
  if (outcome === null) return noteLine('tests pass. No anchor: there is no project root here.');
  if (outcome.kind === 'dirty') {
    return noteLine('tests pass. Make a checkpoint commit now; that commit is your anchor. If you get lost, go back with `git switch -c try-2 <anchor>`');
  }
  if (outcome.kind === 'no-checkout') return noteLine('tests pass. No anchor: this folder is not a git checkout.');
  if (outcome.kind === 'no-commit') return noteLine('tests pass. No anchor: this checkout has no commit yet.');
  if (outcome.kind === 'write-failed') {
    return noteLine('tests pass. No anchor: the anchor file could not be written. A checkpoint commit still holds your work.');
  }
  const { commit } = outcome.anchor;
  if (outcome.kind === 'already') {
    return noteLine(`tests pass. HEAD ${commit.slice(0, 12)} is already your anchor; go back with \`git switch -c try-2 ${commit}\``);
  }
  return noteLine(`tests pass. Anchor ${commit.slice(0, 12)} saved; go back with \`git switch -c try-2 ${commit}\``);
}

/** The first line of an error, for a failure title. */
const firstLine = (error: unknown): string => ((error as Error).message ?? String(error)).split('\n')[0] ?? '';

/** The one note when the end-of-turn check could not run: the turn ends, and the first line of the error says why. */
export const skippedNote = (error: unknown): string[] => noteLine(`the end-of-turn check was skipped: ${firstLine(error)}`);

/** The warnings in the changed files: one note each, never a refusal. Empty when there are none. */
export const warningNotes = (notes: readonly Finding[]): string[] => spaced(notes.map((note) => noteLine(`a warning in the changed files: ${formatFinding({ ...note, docs: undefined })}${note.docs === undefined ? '' : ` More: ${note.docs}`}`)));

/** A refusal at the end of a turn, with the unread team messages after it (#674). */
function withMessages(invocation: Invocation, code: number, messages: string): number {
  if (messages) print(invocation, [messages], invocation.stderr);
  return code;
}

/**
 * The linked worktree's real root, or null for the main checkout and outside a repo.
 * `realpath` runs first. If it fails, nothing is written. A link into another worktree
 * is not this folder's worktree, so that worktree's status file stays as it is.
 */
function linkedWorktree(folder: string): string | null {
  let realFolder: string;
  try {
    realFolder = realpathSync(folder);
  } catch {
    return null;
  }
  const link = gitLinkAbove(realFolder);
  if (link?.kind !== 'file') return null;
  let top: string;
  try {
    top = realpathSync(link.top);
  } catch {
    return null;
  }
  return staysInsideWorktree(folder, top) ? top : null;
}

/** Whether `folder` is `top` or inside it, without following a symlink out. */
function staysInsideWorktree(folder: string, top: string): boolean {
  let dir = resolve(folder);
  for (;;) {
    try {
      if (!lstatSync(dir).isSymbolicLink() && realpathSync(dir) === top) return true;
    } catch {
      return false;
    }
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * Write `checks` at a worker's checkout, and that it is done (#685): its worktree or desk,
 * when the repo uses yokoten. Else at a linked worktree's root, `checks` only. The main
 * checkout is the lead's, so a worker leaves it unchanged.
 */
function recordChecks(invocation: Invocation, folder: string, checks: 'failing' | 'passing', agent: string): void {
  const checkout = findStatusCheckout(folder);
  if (checkout?.isMain && !checkout.isDesk) return;
  if (checkout) {
    const start = startFields(agent, true, checkout, '');
    changeAgentStatus(checkout, { fill: { ...start.fill, vendor: agent }, set: { checks, state: 'done', doing: checks === 'passing' ? 'finished, checks pass' : 'stopped, checks fail', blocked: null } });
    return;
  }
  const root = linkedWorktree(folder);
  if (!root) return;
  writeAgentChecks(root, checks, new Date(), (line) => say(invocation, line, invocation.stderr));
}

/** The lead's turn ended: it waits for the owner (#685). Only in a repo that uses yokoten. */
function noteLeadStop(folder: string, agent: string): void {
  const checkout = findStatusCheckout(folder);
  if (!checkout || !canKeepStatus(checkout, false)) return;
  const start = startFields(agent, false, checkout, '');
  changeAgentStatus(checkout, { fill: { ...start.fill, vendor: agent }, set: { state: 'waiting', doing: 'its turn ended: waiting for your answer' } });
}

/**
 * Keep the session's status file for one tool call (#685). An allowed call says what it
 * does, at most once every STATUS_EVERY_MS; a refused call always sets `blocked`. A file
 * that does not exist yet gets the start fields, for runtimes with no session-start hook.
 */
function noteToolCall(folder: string, agent: string, action: Action, isWorker: boolean, found: Finding | null): void {
  const checkout = findStatusCheckout(folder);
  if (!checkout || !canKeepStatus(checkout, isWorker)) return;
  const start = startFields(agent, isWorker, checkout, '');
  const fill = { ...start.fill, vendor: agent };
  if (found) {
    changeAgentStatus(checkout, { fill, set: { state: 'working', blocked: `the guard stopped this: ${found.what}`.split('\n')[0].slice(0, 140) } });
    return;
  }
  const doing = describeAction(action);
  changeAgentStatus(checkout, { fill, set: { state: 'working', blocked: null, ...(doing ? { doing } : {}) }, throttleMs: STATUS_EVERY_MS });
}

/** The folder a subagent's command runs in: the linked worktree the event names, or the event's own folder. */
function subagentDir(folder: string): string {
  const link = gitLinkAbove(folder);
  return link?.kind === 'file' ? link.top : folder;
}

/** Drop the try count. `clearDoneTries` already ignores an `rmSync` error; this is the second wall. */
function forgetDoneTries(env: Invocation['env'], key: string): void {
  try {
    clearDoneTries(env, key);
  } catch {
    // A count file that cannot be removed must not crash the hook.
  }
}

/**
 * Each finding as the refusal a tool denial prints (#707): title, why, do instead, more.
 * The board splits the same four parts from an end-of-turn refusal as from a denial.
 */
const refusalLines = (findings: Finding[]): string[] => findings.map((found) => formatRefusal(found));

/** The rule a failing stop names first, for the log: a finding's id, or the task's done-when check. */
function stopRule(findings: Finding[], doneWhen: { ok: boolean } | undefined): string {
  return findings[0]?.id ?? (doneWhen?.ok === false ? 'done-when' : 'unknown');
}

/** Write one end-of-turn stop to the log (#621). The command is not logged: a turn names files, not a command. */
function logTurnStop(invocation: Invocation, agent: string, isWorker: boolean, findings: Finding[], doneWhen: { ok: boolean } | undefined, answer: StopAnswer): void {
  logStop(invocation.env, { vendor: agent, role: isWorker ? 'worker' : 'lead', rule: stopRule(findings, doneWhen), answer });
}

/** The lines that send a worker back, and, on the last refusal, what to tell the lead. */
function refuseFailingStop(
  invocation: Invocation,
  json: boolean,
  findings: Finding[],
  notes: Finding[],
  doneWhen: { ok: boolean; output: string } | undefined,
  tries: number,
  saved: boolean,
): number {
  if (json) printJson(invocation, { blocked: true, stop: true, findings, ...(notes.length ? { notes } : {}), ...(doneWhen ? { doneWhen: { ok: false, output: doneWhen.output, tries, limit: DONE_TRY_LIMIT } } : {}) });
  // The last refusal is the one the worker can still read. The allowed stop's stderr reaches nobody.
  print(invocation, failingStopLines({ findings, notes, doneWhen, tries, isLast: !saved || tries >= DONE_TRY_LIMIT }), invocation.stderr);
  return 2;
}

/**
 * What a worker sent back at the end of its turn reads (#614): each refusal as the guard
 * gives it, the warnings, the done-when output, then the try count. On the last try it says
 * what the final message to the lead must start with.
 */
export function failingStopLines({ findings, notes, doneWhen, tries, isLast }: { findings: readonly Finding[]; notes: readonly Finding[]; doneWhen?: { ok: boolean; output: string }; tries: number; isLast: boolean }): string[] {
  const failed = doneWhen?.ok === false ? [...wrap('', 'The done-when check failed. Fix what it reports, then end the task again:'), ...(doneWhen.output ? [doneWhen.output] : [])] : [];
  const tried = isLast
    ? [`This was try ${tries} of ${DONE_TRY_LIMIT}. The next stop is let through.`, ...wrap('', 'Your final message to the lead must start with "NOT DONE: checks failing" and quote the failing output.')]
    : [`This was try ${tries} of ${DONE_TRY_LIMIT}.`];
  return screen(refusalLines([...findings]), warningNotes(notes), failed, tried);
}

/** Let the worker stop, and leave a record the lead can read. The try count starts again. */
function allowFailingStop(
  invocation: Invocation,
  json: boolean,
  findings: Finding[],
  notes: Finding[],
  doneWhen: { ok: boolean; output: string } | undefined,
  tries: number,
  env: Invocation['env'],
  key: string,
  folder: string,
  agent: string,
): number {
  recordChecks(invocation, folder, 'failing', agent);
  forgetDoneTries(env, key);
  const payload = { blocked: false, stop: true, findings, ...(notes.length ? { notes } : {}), skipped: 'stopped with failing checks', ...(doneWhen ? { doneWhen: { ok: false, output: doneWhen.output, tries, limit: DONE_TRY_LIMIT } } : {}) };
  if (json) printJson(invocation, payload);
  print(invocation, noteLine('stopped with failing checks: the done-when check still fails. Tell the lead this task is not done.'), invocation.stderr);
  return 0;
}

/**
 * The answer a refusal gets (#707). Only a hook installed for Claude Code (`--agent
 * claude-code`) answers with a deny in `hookSpecificOutput` on exit 0: an unnamed hook is
 * read by Copilot CLI too, so it keeps the exit-2 answer. Copilot's own user hook names
 * `claude-code` for the input shape, so install also passes `--denial exit2` to keep the
 * answer its reader expects. A structured answer is safe only as the whole of stdout: on
 * exit 0 Claude Code reads any surrounding text as plain output, which lets the call run.
 * So a refusal beside other text falls back to exit 2.
 */
export function chooseDenial(
  agent: string,
  reason: string,
  env: Env,
  { isNamed, isStdoutEmpty, isExit2 = false }: { isNamed: boolean; isStdoutEmpty: boolean; isExit2?: boolean },
): { stdout: string; exitCode: number } {
  if (isExit2) return claudeCode.fallbackDenial(reason);
  const formatDenial = adapterFor(agent)?.formatDenial;
  const denial = isNamed && formatDenial !== undefined
    ? formatDenial(reason, env)
    : agent === 'claude-code' ? claudeCode.fallbackDenial(reason) : { stdout: '', exitCode: 2 };
  return denial.exitCode === 0 && !isStdoutEmpty ? claudeCode.fallbackDenial(reason) : denial;
}

/**
 * The one answer a tool call gets on stdout (#707): a rewrite, a context note or a refusal.
 * Keep it in hand until the branch knows which, so a refusal can check that its JSON would
 * be alone there (see `chooseDenial`).
 */
function answerBuffer(): { stream: Output; text: () => string } {
  let text = '';
  const stream = new Writable({
    decodeStrings: false,
    write(chunk, _, done) {
      text += String(chunk);
      done();
    },
  }) as Output;
  return { stream, text: () => text };
}

/**
 * The question before a heavy job when the kept host reading is low (#401): what runs,
 * why a full drive can corrupt the repo, and the fix. Null when no fresh reading is kept,
 * the drive has room, or the command is light. It reads one small file, never the drive.
 */
export function askForHeavyJob(command: string, env: Env): Finding | null {
  const disk = readKeptHostDisk(env);
  if (!disk || !isLowOnSpace(disk, env)) return null;
  const job = findHeavyJob(command);
  if (job === null) return null;
  const when = new Date(disk.readAt).toISOString().slice(0, 16).replace('T', ' ');
  return {
    ...finding('disk-space', `\`${job}\` is a heavy job, and ${HOST_DRIVE} has ${formatSpace(disk)} (read ${when} UTC)`, `before this job, ${HOST_DISK_FIX}. Then run \`yokoten doctor\` to read the drive again`, {
      why: 'a full drive can corrupt the repo: git can write empty objects, and a branch head can be lost',
    }),
    ask: true,
  };
}

/**
 * `yokoten hook --protocol`: the guard protocol (#898). One fixed call on stdin, one fixed
 * answer on stdout. A tool that yokoten has no adapter for adds this call itself, and its
 * own plugin translates its tool call into `GuardInput`. The end of a turn is not in
 * version 1.
 *
 * The answer is the truth: `allow` and `ask` exit 0, `refuse` exits 2. An input yokoten
 * cannot read is refused, because the caller asked for the guard by name.
 */
async function runProtocol(invocation: Invocation, guard: Guard | undefined, commandsOnly: boolean): Promise<number> {
  const { cwd, env: callEnv } = invocation;
  const parsed = parseGuardInput(readInput(invocation.stdin), invocation.platform);
  const answer = async (output: GuardOutput): Promise<number> => {
    printJson(invocation, output);
    return output.decision === 'refuse' ? 2 : 0;
  };
  if (typeof parsed === 'string') return answer(protocolRefusal(parsed));
  const { action, role: claimed, project } = fromGuardInput(parsed);
  // The protocol names no runtime; the tool's own name, when it sends one, marks the line.
  const vendor = parsed.action.tool === undefined ? 'protocol' : `protocol:${parsed.action.tool}`;
  // The project is the session's folder. A call that names another folder judges that one.
  const base = resolve(cwd, project);
  const root = rootOf(base, callEnv);
  const folders = [resolve(cwd, action.cwd ?? base), cwd];
  const marked = workerRole(callEnv, folders);
  const isWorker = claimed === 'worker' || action.worker || marked === 'mark';
  const env = isWorker ? { ...callEnv, YOKOTEN_ROLE: 'worker' } : callEnv;
  const config = loadHookConfig(root, (line) => say(invocation, `${line}\n`, invocation.stderr));
  const repos = editRepos(invocation, action, action.cwd ?? root ?? base, root ? { root, config } : null, commandsOnly);
  const judged = await judgeWithDeadline(action, { root, config, env, cwd: base, commandsOnly, repos }, guardDeadline(env.YOKOTEN_GUARD_DEADLINE_MS), guard);
  // A question for the owner (#1212), then a heavy job on a nearly full host drive (#401).
  // The protocol has an ask answer; a cloud session still refuses it (#1215).
  const question = judged?.ask ? judged : !judged && action.command !== undefined ? askForHeavyJob(action.command, env) : null;
  const settled = question ? settleAsk(question, { isUnattended: isUnattended(env), canAsk: true, agent: vendor }) : null;
  const ask = settled && 'ask' in settled ? settled.ask : null;
  let found = judged?.ask ? null : judged;
  if (settled && 'refuse' in settled) found = settled.refuse;
  // A worker by the mark hears why, and where the lead works (#555).
  if (found && marked === 'mark' && WORKER_RULES.has(found.id)) found = { ...found, fix: `${found.fix}. ${capital(markNote(folders, callEnv))}` };
  if (found) {
    // One line per stop, on this computer only (#621). The protocol names no runtime.
    logStop(env, {
      vendor,
      role: isWorker ? 'worker' : 'lead',
      rule: found.id,
      answer: found.id === 'unreadable-command' ? 'no answer' : 'refused',
      command: action.command ?? action.commands?.[0],
    });
  }
  noteToolCall(cwd, vendor, action, isWorker, found);
  if (found) return answer(refusedOutput(found));
  return answer(ask ? askedOutput(ask) : allowedOutput());
}

/** `guard`: the guard's worker, when bin/main.ts started it early (#408). */
export function runHook(invocation: Invocation, guard?: Guard): number | Promise<number> {  const { cwd } = invocation;
  const options = parse('hook', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  const json = options.flags.has('--json');
  const namedAgent = options.values['--agent'];
  const agent = namedAgent ?? 'claude-code';
  const denialMode = options.values['--denial'];
  if (denialMode !== undefined && denialMode !== 'exit2') return usage(invocation, `unknown --denial ${shownValue(denialMode)}; use exit2`);
  // The guard protocol (#898): one fixed call, one fixed answer, no runtime in it.
  if (options.flags.has('--protocol')) {
    if (namedAgent !== undefined || options.flags.has('--stop') || denialMode !== undefined) {
      return usage(invocation, '--protocol is the whole call, so it takes no --agent, --stop or --denial');
    }
    return runProtocol(invocation, guard, options.flags.has('--commands-only'));
  }
  if (options.flags.has('--stop')) {
    if (options.flags.has('--commands-only')) return usage(invocation, "--stop and --commands-only can't be used together");
    const readStop = stopReaderOf(agent);
    if (!readStop) return usage(invocation, `unknown --agent ${shownValue(agent)}; use one of: ${Object.values(ADAPTERS).filter((adapter) => adapter.readStop !== undefined).map((adapter) => adapter.name).join(', ')}`);
    return stopHook(invocation, json, readStop, agent);
  }
  const read = Object.hasOwn(READERS, agent) ? READERS[agent] : undefined;
  if (!read) return usage(invocation, `unknown --agent ${shownValue(agent)}; use one of: ${Object.keys(READERS).join(', ')}`);
  let input: unknown;
  try {
    input = JSON.parse(readInput(invocation.stdin));
  } catch {
    // Not a tool call; nothing to judge. A runtime never sends one, and blocking here
    // would stop every tool call the day a runtime changes its input.
    if (json) printJson(invocation, { blocked: false, toolCall: false });
    return 0;
  }
  const action = read(input);
  const root = rootOf(action.cwd ?? cwd, invocation.env);
  // A worktree the lead marked makes every agent in it a worker, whatever env it passes (#555).
  // Both folders count: a call may name another folder (Muse's `workdir`) than the hook's own.
  const folders = [resolve(cwd, action.cwd ?? '.'), cwd];
  const role = workerRole(invocation.env, folders);
  const env = role === 'mark' ? { ...invocation.env, YOKOTEN_ROLE: 'worker' } : invocation.env;
  const config = loadHookConfig(root, (line) => say(invocation, `${line}\n`, invocation.stderr));
  const commandsOnly = options.flags.has('--commands-only');
  const repos = editRepos(invocation, action, action.cwd ?? root ?? cwd, root ? { root, config } : null, commandsOnly);
  const judged = judgeWithDeadline(action, { root, config, env, cwd, commandsOnly, repos }, guardDeadline(env.YOKOTEN_GUARD_DEADLINE_MS), guard);
  const answer = answerBuffer();
  const answerInvocation: Invocation = { ...invocation, stdout: answer.stream };
  /** Writes the branch's one answer to stdout, then returns `code`. */
  const finish = (code: number): number => {
    invocation.stdout.write(answer.text());
    return code;
  };
  // The circuit breaker (#711): one count for the session, one shape for this step. A call
  // with no session id gets no count: the count would belong to the folder, not a session (#792).
  const sessionKey = repeatKeyOf(sessionIdOf(input), agentIdOf(input));
  const shape = commandShape(action.command, action.paths);
  return judged.then((judgedFinding) => {
    // A question for the owner (#1212) is not a refusal.
    let ask = judgedFinding?.ask ? judgedFinding : null;
    let found = ask ? null : judgedFinding;
    // A command that may print the owner's details runs through `yokoten redact` (#390),
    // with a question or without: after the owner's yes it still runs wrapped (#1212).
    const printed = !found && action.command !== undefined ? printsAccount(action.command) : null;
    let wrapped: string | null = null;
    if (printed && action.command !== undefined) {
      const redacted = wrapForRedact(hardenRead(action.command), redactCommand(process.execPath, invocation.script, env.HOME));
      if (adapterFor(agent)?.formatRewrite !== undefined) wrapped = redacted;
      else if (config.privacy.output === 'stop') found = privateOutput(printed, redacted);
    }
    // A heavy job on a nearly full host drive asks first (#401). Where no one can answer,
    // a question becomes a refusal: a cloud session, or a runtime with no ask (#1212, #1215).
    if (!found && !ask && action.command !== undefined) ask = askForHeavyJob(action.command, env);
    if (!found && ask) {
      const settled = settleAsk(ask, { isUnattended: isUnattended(env), canAsk: canAskOf(agent, env), agent: adapterFor(agent)?.label ?? agent });
      if ('refuse' in settled) {
        found = settled.refuse;
        ask = null;
      }
    }
    // The wrapped command runs in place of the one the agent wrote. A question carries it,
    // so the owner's yes runs the wrapped command (#1212); with no question, it is an allow.
    const asked = askOf(agent);
    const rewritten = found || !printed || wrapped === null
      ? null
      : ask
        ? asked === null ? null : asked(`yokoten: ${formatFinding(ask)}`, { input, command: wrapped })
        : rewriteOf(agent, input, wrapped, `yokoten: ${printed}, so its output goes through yokoten redact`);
    if (rewritten !== null) {
      if (json) printJson(answerInvocation, { blocked: false, toolCall: true, ...(ask ? { ask } : {}), rewritten: wrapped });
      // Written as it is: hiding the home folder would change the command.
      else answerInvocation.stdout.write(rewritten);
      noteToolCall(cwd, agent, action, role !== null || action.worker, null);
      if (sessionKey !== null) clearRepeats(env, sessionKey);
      return finish(0);
    }
    // A worker by the mark hears why, and where the lead works (#555).
    const markReason = found != null && role === 'mark' && WORKER_RULES.has(found.id) ? capital(markNote(folders, invocation.env)) : undefined;
    if (found != null && markReason !== undefined) found = { ...found, fix: `${found.fix}. ${markReason}` };
    // The third same refusal becomes a stop message; any success starts the count again (#711).
    if (found) {
      const repeats = sessionKey === null ? null : bumpRepeat(env, sessionKey, found.id, shape);
      if (repeats !== null && repeats >= REPEAT_STOP_LIMIT) found = repeatStopFinding();
      // One line per stop, on this computer only (#621).
      logStop(env, {
        vendor: agent,
        role: role !== null || action.worker ? 'worker' : 'lead',
        rule: found.id,
        // A guard that could not read the call has no rule answer; it still refuses the call.
        answer: found.id === 'unreadable-command' ? 'no answer' : 'refused',
        command: action.command ?? action.commands?.[0],
      });
    } else if (sessionKey !== null) {
      clearRepeats(env, sessionKey);
    }
    noteToolCall(cwd, agent, action, role !== null || action.worker, found);
    if (json) printJson(answerInvocation, found ? { blocked: true, finding: found } : ask ? { blocked: false, toolCall: true, ask } : { blocked: false, toolCall: true });
    if (!found && ask) {
      const question = `yokoten: ${formatFinding(ask)}`;
      if (!json && asked !== null) say(answerInvocation, asked(question), answerInvocation.stdout);
      else if (!json) say(answerInvocation, `${question}\n`, invocation.stderr);
      return finish(0);
    }
    if (!found && !json && adapterFor(agent)?.formatContext !== undefined) {
      // The session's own folder, never the call's: a folder a desk agent wrote can't name the lead's team.
      // When the call names no other folder, the root above is this folder's: one git call, not two (#821).
      const sessionRoot = resolve(cwd, action.cwd ?? '.') === resolve(cwd) ? root : rootOf(cwd, env);
      return teamMessages(cwd, env, sessionRoot).then((messages) => {
        const text = messages ? contextOf(agent, messages) : null;
        if (text) say(answerInvocation, text, answerInvocation.stdout);
        return finish(0);
      });
    }
    if (!found) return finish(0);
    // The runtimes read the reason from stderr when the hook exits 2; some read stdout.
    // Every rule gives the same four parts (#707): title, why, do instead, more.
    const reason = formatRefusal(found);
    say(invocation, `${reason}\n`, invocation.stderr);
    // The --agent the hook was installed with decides the answer, never an environment
    // variable another host could inherit (#707). An unnamed hook may be read by another
    // host through the shared .claude/settings.json, so it keeps exit 2.
    const denial = chooseDenial(agent, reason, invocation.env, { isNamed: namedAgent !== undefined, isStdoutEmpty: answer.text() === '', isExit2: denialMode === 'exit2' });
    if (!json && denial.stdout) say(answerInvocation, denial.stdout, answerInvocation.stdout);
    return finish(json ? 2 : denial.exitCode);
  });
}

// The rules that apply to a worker only: a refusal by one of them names the mark, when the role came from it.
const WORKER_RULES = new Set(['lead-only', 'worker-push', 'worker-mark']);
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** What `yokoten stops` shows: whether the log is written, where it is, and how to turn it the other way. */
export function stopsScreen(state: { isOff: boolean; count: number; file: string }): string[] {
  return screen(
    title('stops', state.isOff ? 'off: no stops logged' : `on: ${count(state.count, 'stop')} logged on this computer`),
    [...field('log', state.file), ...row('note', state.isOff ? 'yokoten writes no line while it is off' : 'Nothing is sent anywhere; the log stays on this computer')],
    state.isOff ? wrap('Turn on: ', '`yokoten stops on` starts the writing again') : wrap('Turn off: ', '`yokoten stops off` stops the writing and deletes the log'),
  );
}

/** What `yokoten stops off` shows once the log is off and gone. */
export const stopsOffScreen = (): string[] => screen(title('stops', 'off, and the log is deleted'), wrap('Turn on: ', '`yokoten stops on` starts it again'));

/** What `yokoten stops on` shows once the log is written again. */
export const stopsOnScreen = (file: string): string[] => screen(title('stops', 'on, and the log is written again'), field('log', file));

/**
 * `yokoten stops`: the stop log's state, and the way back. `off` stops the writing and
 * deletes the log; `on` starts it again. The log stays in the user's config folder, never
 * in the project (#621).
 */
export function runStops(invocation: Invocation): number {
  const options = parse('stops', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  const [action] = options.positional;
  const { env } = invocation;
  const file = stopsFile(env);
  const offFile = stopsOffFile(env);
  if (!file || !offFile) return fail(invocation, 'no home folder, so there is no stop log to manage', "set HOME to your home folder's full path, then run `yokoten stops` again");
  if (action === undefined) {
    const state = stopsState(env);
    show(invocation, stopsScreen({ isOff: state.isOff, count: state.count, file: state.file ?? file }));
    return 0;
  }
  if (action === 'off') {
    try {
      mkdirSync(dirname(offFile), { recursive: true });
      writeFileSync(offFile, 'off\n');
      rmSync(file, { force: true });
    } catch (err) {
      return fail(invocation, `the log cannot be turned off: ${firstLine(err)}`, `check that you can write to ${dirname(offFile)}, then run \`yokoten stops off\` again`);
    }
    show(invocation, stopsOffScreen());
    return 0;
  }
  if (action === 'on') {
    try {
      rmSync(offFile, { force: true });
    } catch (err) {
      return fail(invocation, `the log cannot be turned on: ${firstLine(err)}`, `check that you can write to ${dirname(offFile)}, then run \`yokoten stops on\` again`);
    }
    show(invocation, stopsOnScreen(file));
    return 0;
  }
  return usage(invocation, `unknown action ${shownValue(action)}; use off or on`);
}

/**
 * `worker mark <dir>`: mark the worktree at <dir> as a worker's (#555). The guard then
 * treats every agent there as a worker, whatever env its runtime passes to the hook. The
 * mark is a file in the worktree's own git folder, and its path on the worker list (#566),
 * outside the worktree, so moving `.git` away keeps the role. `git worktree remove`
 * removes the file with the worktree, and the guard skips the list entry whose folder is
 * gone; `worker unmark` clears an entry outright, and only the lead runs it. The main
 * checkout is the lead's, so it is never marked.
 */

/** Why `markWorktree` marked nothing: `fail` the whole sentence (the desk quotes it), `what` and `next` for a failure screen. */
export interface MarkFailure {
  fail: string;
  what: string;
  next: string;
}

/** A folder as a screen names it: from `cwd` when that is short (`../task`), else in full (the home shows as ~). */
export function shownFolder(cwd: string, folder: string): string {
  const path = relative(cwd, folder);
  if (path === '') return '.';
  return !isAbsolute(path) && path.split(/[\\/]/).filter((part) => part === '..').length <= 2 ? path : folder;
}

// The same, read through symlinks on both sides: git names a folder by its real path, and the
// session's folder may come through a link (on macOS, /var is /private/var), so a near folder
// would show as a long machine path.
const shownFrom = (cwd: string, folder: string): string => shownFolder(realPath(cwd), realPath(folder));

/**
 * Mark the worktree at `dir` (from `cwd`) as a worker's, exactly as `yokoten worker
 * mark` does: the mark file in its own git folder, and its path on the worker list.
 * The board calls this for the worktree it makes or reuses, so runtimes that drop
 * YOKOTEN_ROLE still run as workers. Returns the worktree root, or the plain reason.
 */
export function markWorktree(cwd: string, dir: string, callerEnv: Env): { top: string; kind: 'worktree' | 'clone' } | MarkFailure {
  const folder = resolve(cwd, dir);
  const shown = (path: string) => shownFrom(cwd, path);
  // In a sentence, the folder the lead is in reads as "this folder"; a command keeps `.`.
  const named = (path: string) => (shown(path) === '.' ? 'this folder' : shown(path));
  // Git reads the folder from the caller's GIT_DIR before the path: dropped, so the mark goes where `dir` is (#672).
  const env = withoutGitPlace(callerEnv);
  let isFolder = false;
  try {
    isFolder = statSync(folder).isDirectory();
  } catch {}
  if (!isFolder) return { fail: `${dir} is not a folder. Make the worktree first: \`git worktree add ${dir} -b <branch>\`, then \`yokoten worker mark ${dir}\`.`, what: `${named(folder)} is not a folder`, next: `make the worktree first with \`git worktree add ${shown(folder)} -b <branch>\`, then mark it` };
  let answer: string[];
  try {
    // --show-superproject-working-tree prints nothing outside a submodule, so it comes last.
    answer = readGit(folder, ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir', '--show-superproject-working-tree'], { env }).toString('utf8').trim().split('\n');
  } catch {
    return { fail: formatFinding(notRepoFinding(folder)), what: `${named(folder)} is not inside a git repo`, next: `make a worktree with \`git worktree add <dir> -b <branch>\`, then mark it` };
  }
  const [top, gitDir, common, superproject] = answer;
  const kind = isSamePath(realPath(gitDir), realPath(resolve(folder, common ?? ''))) ? 'clone' : 'worktree';
  const makeOne = 'mark a worktree instead: make one with `git worktree add <dir> -b <branch>`';
  if (kind === 'clone') {
    if (superproject) return { fail: `${top} is a submodule's checkout, not a worktree. Mark a worktree: \`git worktree add <dir> -b <branch>\`, then \`yokoten worker mark <dir>\`.`, what: `${named(top)} is a submodule's checkout, not a worktree`, next: makeOne };
    // A plain clone is a worker's desk (#672), unless the lead works in it: the session runs
    // there, or worktrees hang off it. Those are the main checkout, never marked.
    const isLeadHere = isPathInside(realPath(cwd), realPath(top));
    if (isLeadHere || hasLinkedWorktrees(folder, env)) return { fail: `${top} is the main checkout, the lead's. Mark a worktree (\`git worktree add <dir> -b <branch>\`) or a clone of its own (\`git clone <repo> <dir>\`), then \`yokoten worker mark <dir>\`.`, what: `${named(top)} is the main checkout, the lead's`, next: makeOne };
    // The lead marks a clone from its own checkout, so that checkout is never the one marked.
    if (leadCheckout(cwd, env) === null) return { fail: `run \`yokoten worker mark ${dir}\` from your own checkout, the lead's: yokoten then knows that ${top} is not it.`, what: `yokoten can't tell that ${named(top)} is not your own checkout`, next: `go to your own checkout, the lead's, and run \`yokoten worker mark\` from there` };
  }
  // Git and the guard must name the same git folder, or the mark lands where the guard never looks.
  const link = gitLinkAbove(folder);
  const again = `then run \`yokoten worker mark ${shown(folder)}\` again`;
  if (link === null || link.kind === 'broken' || !isSamePath(realPath(link.gitDir), realPath(gitDir))) return { fail: `git names ${gitDir} as the git folder of ${top}, but its .git does not. Nothing is marked.`, what: `git and the .git in ${named(top)} name two git folders, so nothing is marked`, next: `fix the .git file in that folder, ${again}` };
  try {
    const note = kind === 'clone' ? "A worker's clone: yokoten's guard treats every agent here as a worker. Removing the clone removes this mark.\n" : "A worker's worktree: yokoten's guard treats every agent here as a worker. `git worktree remove` removes this mark.\n";
    writeFileSync(join(gitDir, WORKER_MARK), note);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'error';
    return { fail: `can't write the mark in ${gitDir} (${code}). Check that the lead can write there, then run it again.`, what: `can't write the mark in ${named(gitDir)} (${code})`, next: `check that you can write there, ${again}` };
  }
  try {
    addWorkerPath(env, top);
  } catch (error) {
    const said = (error as Error).message.split('\n')[0];
    return { fail: `the mark is written in ${gitDir}, but the worker list can't be written (${said}). Clear it with \`yokoten worker unmark ${top}\` once the list is writable, then mark again.`, what: `the mark is written, but the worker list can't be written (${said})`, next: `once the list is writable, run \`yokoten worker unmark ${shown(top)}\`, then mark it again` };
  }
  // The guard finds the mark without git; check that it finds the file itself, not the list.
  if (!existsSync(join(link.gitDir, WORKER_MARK)) || workerMarkAt(folder, env) !== 'mark') return { fail: `the mark is written in ${gitDir}, but the guard can't find it from ${top}.`, what: `the mark is written in ${named(gitDir)}, but the guard can't find it from ${named(top)}`, next: `check the .git file in that folder, ${again}` };
  return { top, kind };
}

// The names that point git at another git folder or work tree than the folder it runs in.
const GIT_PLACE = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR'];
const withoutGitPlace = (env: Env): Env => Object.fromEntries(Object.entries(env).filter(([name]) => !GIT_PLACE.includes(name)));

// The top of the checkout the lead runs in, or null outside one.
function leadCheckout(cwd: string, env: Env): string | null {
  try {
    return readGit(cwd, ['rev-parse', '--show-toplevel'], { env }).toString('utf8').trim() || null;
  } catch {
    return null;
  }
}

// Whether other worktrees hang off the checkout at `folder`: then it is a main checkout.
function hasLinkedWorktrees(folder: string, env: Env): boolean {
  try {
    const list = readGit(folder, ['worktree', 'list', '--porcelain'], { env }).toString('utf8');
    return list.split('\n').filter((line) => line.startsWith('worktree ')).length > 1;
  } catch {
    // Git can't list them: the guard can't tell, so the checkout stays the lead's.
    return true;
  }
}

/** What `yokoten anchor` shows: the checkpoints, newest first, and the way back to one. */
export function anchorScreen(anchors: readonly Anchor[]): string[] {
  if (!anchors.length) return screen(title('anchor', 'no checkpoints yet'), row('to do', 'A worker records one when its checks pass and its tree is clean'));
  return screen(
    title('anchor', `${count(anchors.length, 'checkpoint')}, newest first`),
    spaced(anchors.map((anchor) => row('ok', `${anchor.commit.slice(0, 12)} saved ${anchor.at}, after ${anchor.check} passed`))),
    nextLine('git switch -c try-2 <commit>'),
  );
}

/**
 * `anchor`: list the checkpoints a worker's passing checks recorded (#711). An anchor is
 * a commit, so going back is `git switch -c <new> <anchor>`: nothing is reset or deleted.
 */
export function runAnchor(invocation: Invocation): number {
  const options = parse('anchor', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  if (options.positional.length) return usage(invocation, 'anchor takes no arguments');
  if (!requireRoot(invocation, invocation.cwd)) return 1;
  const anchors = listAnchors(invocation.cwd);
  if (options.flags.has('--json')) {
    printJson(invocation, { anchors });
    return 0;
  }
  show(invocation, anchorScreen(anchors));
  return 0;
}

/** What `yokoten worker mark` shows: the folder it marked, what that means, and the two ways back. */
export function workerMarkedScreen({ kind, folder }: { kind: 'worktree' | 'clone'; folder: string }): string[] {
  return screen(
    title('worker', `marked the ${kind} at ${folder}: every agent there is a worker`),
    spaced([
      field('lead-only', 'Files there are guarded.'),
      field('way back', kind === 'clone' ? 'Removing the clone removes the mark.' : `\`git worktree remove ${folder}\` removes the mark.`),
      field('sooner', `\`yokoten worker unmark ${folder}\` clears it now.`),
    ]),
  );
}

/** What `yokoten worker unmark` shows. */
export const workerUnmarkedScreen = (folder: string): string[] => screen(title('worker', `${folder} is unmarked`), wrap('', 'The guard no longer treats agents there as workers.'));

/** How many names `worker env` dropped, by why. */
export type DroppedCounts = Record<DropReason, number>;

/** What `yokoten worker env` shows: the names an agent gets, never a value, and how many are dropped and why. */
export function workerEnvScreen({ runtime, kept, dropped }: { runtime?: string; kept: readonly string[]; dropped: DroppedCounts }): string[] {
  const who = runtime === undefined ? 'an agent that yokoten starts' : `a ${runtime} agent that yokoten starts`;
  return screen(
    title('worker', `${who} would get ${count(kept.length, 'name')} from this shell`),
    spaced([
      field('kept', kept.join(', ') || 'none'),
      field('dropped', `${dropped['secret name']} with a secret-looking name, ${dropped['secret value']} with a value shaped like a key or token, ${dropped['too long']} too long to check, ${dropped['not on the list']} not on the list`),
      field('values', 'never shown'),
      field('used by', '`yokoten desk`, when it starts an agent'),
    ]),
    runtime === undefined ? wrap('More: ', '`yokoten worker env claude-code` counts its own login names too') : [],
  );
}

// Where the lead runs `worker mark` and `worker unmark`: inside a marked checkout, every session is a worker.
const leadOutside = (action: 'mark' | 'unmark'): string => `a worker commits in its own checkout and reports. The lead runs \`yokoten worker ${action}\` from its own checkout, outside the marked one`;

export function runWorker(invocation: Invocation): number | Promise<number> {
  const options = parse('worker', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  const [action, dir] = options.positional;
  if (action === 'env') return runEnv(invocation, dir);
  if ((action !== 'mark' && action !== 'unmark') || dir === undefined) return usage(invocation, `say what to do and where: yokoten worker ${action === 'unmark' ? 'unmark' : 'mark'} <dir>, or yokoten worker env [runtime]`);
  if (action === 'unmark') return runUnmark(invocation, dir);
  if (workerRole(invocation.env, [invocation.cwd]) !== null) return fail(invocation, 'only the lead marks a worktree or a clone: this session is a worker', leadOutside('mark'));
  const marked = markWorktree(invocation.cwd, dir, invocation.env);
  if ('fail' in marked) return fail(invocation, marked.what, marked.next);
  show(invocation, workerMarkedScreen({ kind: marked.kind, folder: shownFrom(invocation.cwd, marked.top) }));
  return 0;
}

/**
 * `worker env [runtime]`: the names an agent that yokoten starts would get from this
 * shell (#613), and how many are dropped and why. Names only: a value is never printed.
 * With a runtime, its own login and config names count too. The module loads only here,
 * so the guard's path never loads it.
 */
async function runEnv(invocation: Invocation, runtime: string | undefined): Promise<number> {
  const { sortAgentEnv } = await import('../agents/desk/agent-env.ts');
  let sorted: SortedEnv;
  try {
    sorted = sortAgentEnv(invocation.env, runtime);
  } catch (error) {
    return usage(invocation, `${(error as Error).message}. Example: yokoten worker env claude-code`);
  }
  const droppedFor = (reason: DropReason) => sorted.dropped.filter((drop) => drop.reason === reason).length;
  const dropped: DroppedCounts = { 'secret name': droppedFor('secret name'), 'secret value': droppedFor('secret value'), 'too long': droppedFor('too long'), 'not on the list': droppedFor('not on the list') };
  show(invocation, workerEnvScreen({ runtime, kept: sorted.kept, dropped }));
  return 0;
}

/**
 * `worker unmark <dir>`: forget the marked worktree at <dir> (#566). Only the lead runs
 * it: a worker's session, by YOKOTEN_ROLE or by the mark on its own worktree, is refused.
 * It drops the worktree's path from the worker list, and the mark file when `.git` still
 * names it. Given a folder with no `.git` (moved away), it still clears by path.
 */
function runUnmark(invocation: Invocation, dir: string): number {
  if (workerRole(invocation.env, [invocation.cwd]) !== null) return fail(invocation, 'only the lead unmarks a worktree: this session is a worker', leadOutside('unmark'));
  const folder = resolve(invocation.cwd, dir);
  let top = folder;
  let gitDir: string | undefined;
  try {
    const answer = readGit(folder, ['rev-parse', '--show-toplevel', '--absolute-git-dir'], { env: withoutGitPlace(invocation.env) }).toString('utf8').trim().split('\n');
    if (answer[0]) top = answer[0];
    gitDir = answer[1];
  } catch {
    // No `.git` to read (moved away): the list entry is still cleared by path below.
  }
  if (gitDir) rmSync(join(gitDir, WORKER_MARK), { force: true });
  try {
    removeWorkerPath(invocation.env, top);
  } catch (error) {
    return fail(invocation, `can't clear the worker list (${firstLine(error)})`, `check HOME, then run \`yokoten worker unmark ${dir}\` again`);
  }
  show(invocation, workerUnmarkedScreen(shownFrom(invocation.cwd, top)));
  return 0;
}

/**
 * `desk <agent> <folder> -- <command>`: start a worker's agent in its own fenced desk
 * (#637). Only the lead runs it. The modules load only here, so the guard never loads them.
 * desk/desk.ts parses the words before `--` and passes them on.
 */
export async function runDesk(invocation: Invocation, options: Parsed): Promise<number> {
  // Inside a Linux desk, its first program: the bridge to the proxy, then the agent.
  if (invocation.args[0] === '--bridge') return (await import('../agents/desk/network/bridge.ts')).runBridge(invocation.args.slice(1), invocation.stderr);
  const end = invocation.args.indexOf('--');
  const [runtime, folder] = options.positional;
  const command = end === -1 ? [] : invocation.args.slice(end + 1);
  if (runtime === undefined || folder === undefined || !command.length) return usage(invocation, 'name the agent, the folder and the command: yokoten desk <agent> <folder> -- <command>');
  const list = (name: string) => (options.values[name] ?? '').split(',').map((word) => word.trim()).filter(Boolean);
  const started = await startFencedDesk(invocation, { runtime, folder, command, name: options.values['--name'], read: list('--read'), hosts: list('--host'), marks: options.flags.has('--marks') }, 'inherit');
  if ('fail' in started) return fail(invocation, started.fail, 'yokoten desk --help');
  if (started.stderr) invocation.stderr.write(started.stderr);
  return started.code;
}

/**
 * The one screen before a desk's agent starts (#1027): where it writes, what it reaches, its
 * fence and its role. When the agent's own sandbox is off for the run (#1171), one line says so.
 */
export function deskStartScreen({ runtime, folder, hosts, fence, upstream, isOwnSandboxOff = false }: { runtime: string; folder: string; hosts: readonly string[]; fence: string; upstream?: string; isOwnSandboxOff?: boolean }): string[] {
  return screen(
    title('desk', `${runtime} in ${folder}`),
    // The hosts it can reach, named in full: an extra --host is never hidden (#1027 review).
    // The host's proxy (#1172) by host and port only: `upstream` is UpstreamProxy.shown, never its URL.
    spaced([field('writes', `${folder} only`), field('network', hosts.join(', ') || 'none'), ...(upstream ? [field('through', `${upstream} (HTTPS_PROXY)`)] : []), field('fence', fence), field('role', 'worker, TZ=UTC, no tokens')]),
    isOwnSandboxOff ? noteLine(DESK_OWN_SANDBOX_NOTE) : [],
    wrap('', 'Starting… (stop with Ctrl+C)'),
  );
}

/** What a fenced desk starts: the agent, its clone, the command, and the lead's few choices. */
export interface FencedDeskRequest {
  runtime: string;
  folder: string;
  command: string[];
  name?: string;
  read?: string[];
  hosts?: string[];
  marks?: boolean;
}

/**
 * Start `command` in the fenced desk at `folder` (#637): the screen first, then the agent,
 * and its exit code. With 'pipe' (`yokoten desk <issue>` running the tests inside the
 * fence), no screen, and the output comes back. `{ fail }` is one plain line: nothing started.
 */
export async function startFencedDesk(invocation: Invocation, request: FencedDeskRequest, stdio: 'inherit' | 'pipe'): Promise<{ fail: string } | { code: number; stdout: string; stderr: string }> {
  const { runtime, folder, command } = request;
  if (workerRole(invocation.env, [invocation.cwd]) !== null) return { fail: 'only the lead starts a desk: this session is a worker.' };
  const [{ cloneProblem, planDesk }, { chooseBackend, startDesk }, { paths }, team, { teamFolderFor, teamName }] = await Promise.all([import('../agents/desk/desk.ts'), import('../agents/desk/start.ts'), import('../setup/install.ts'), import('../agents/desk/team/who.ts'), import('../agents/desk/team/team.ts')]);
  // The folder first: a wrong folder is named before the sandbox is looked for.
  const notClone = cloneProblem(resolve(invocation.cwd, folder));
  if (notClone) return { fail: notClone };
  // srt never comes from the lead's project or the desk (P6 review).
  const backend = chooseBackend(invocation.platform ?? 'linux', invocation.env, [invocation.cwd, resolve(invocation.cwd, folder)]);
  if (typeof backend === 'string') return { fail: backend };
  const isShown = stdio === 'inherit';
  const installed = paths(invocation.env);
  // The team of the lead's project (#674): next to its main checkout. The agent's name is
  // --name, or the desk folder's made into a name; a folder name that can't be one joins no team.
  const main = team.leadCheckout(invocation.cwd, invocation.env);
  const name = request.name ?? teamName(basename(resolve(invocation.cwd, folder)));
  if (isShown && typeof main === 'string' && name === null) print(invocation, noteLine('the folder\'s name can\'t be a name on the team, so this desk joins no team. Name it with `--name` to join one.'), invocation.stderr);
  let plan: ReturnType<typeof planDesk>;
  try {
    plan = planDesk({
      runtime,
      desk: resolve(invocation.cwd, folder),
      command,
      env: invocation.env,
      extraReadable: (request.read ?? []).map((path) => resolve(invocation.cwd, path)),
      extraHosts: request.hosts ?? [],
      runtimes: [installed.runtime],
      marks: request.marks ? installed.marks : undefined,
      team: typeof main === 'string' && name !== null ? { folder: teamFolderFor(main), name } : undefined,
      markDesk: (desk) => markWorktree(invocation.cwd, desk, invocation.env),
    });
  } catch (error) {
    return { fail: (error as Error).message };
  }
  // One screen before the agent starts (#1027): where it writes, what it reaches, and its role.
  if (isShown) print(invocation, deskStartScreen({ runtime, folder: shownFrom(invocation.cwd, plan.desk), hosts: plan.hosts, fence: backend.name, upstream: plan.upstream?.proxy?.shown, isOwnSandboxOff: plan.isOwnSandboxOff }), invocation.stderr);
  if (isShown && plan.upstream?.problem) print(invocation, noteLine(plan.upstream.problem), invocation.stderr);
  // The board shows the desk's agent (#685). A desk that can't be noted still starts.
  const unlisted = registerDesk(invocation.cwd, plan.desk);
  if (isShown && unlisted) print(invocation, noteLine(`the board won't show this desk: ${unlisted}.`), invocation.stderr);
  const refused = new Set<string>();
  const result = await startDesk(plan, backend, {
    stdio,
    onEvent: (event) => {
      if (!event.isAllowed) refused.add(event.target);
    },
  });
  if (isShown && refused.size) print(invocation, noteLine(`the proxy refused ${[...refused].join(', ')}. Add an API host with \`--host\` if the agent needs it.`), invocation.stderr);
  return result;
}
