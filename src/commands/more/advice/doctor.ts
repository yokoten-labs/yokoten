// `yokoten doctor`, `explain` and `adopt`. Doctor reads and shows. A session start also
// writes the agent's status file, git-ignored (#685). A lead writes its log path into
// the repo's git folder (#700). A Claude Code session start keeps what it said in
// ~/.config/yokoten/sessions/ (#405). Each command reads, computes a result, then prints one
// screen built from it (plan 6.4): the screens are pure functions of the result.

import { readSync } from 'node:fs';
import { identityLine } from '../../../agents/desk/team/who.ts';
import * as claudeCode from '../../../agents/runtimes/claude-code.ts';
import * as gemini from '../../../agents/runtimes/gemini.ts';
import { ghIn, ghLaterIn, readServer, type ServerSettings, type Unread } from '../../../host/github/index.ts';
import { readGiteaServer } from '../../../host/gitea.ts';
import { type Host, hostOf } from '../../../host/hosts.ts';
import { DEFAULTS, loadConfig } from '../../../rules/config.ts';
import { gitConfig } from '../../../run/check.ts';
import { workerRole } from '../../../rules/guards/index.ts';
import { canKeepStatus, changeAgentStatus, findStatusCheckout, startFields } from '../../../run/hook.ts';
import { docsLink, findingRow, sentence } from '../../../rules/text/message.ts';
import { columnFor, screen, section, spaced, table, type TableRow } from '../../../rules/text/screen.ts';
import { hideHome } from '../../../rules/privacy.ts';
import { type Decision, type Draft, draft, facts, type Row, YOU_DECIDE } from '../../../setup/advice/adopt.ts';
import { explain, type Explained, ids } from '../../../setup/advice/explain.ts';
import { cleanOlderInstall, PROFILE_MARK } from '../../../setup/install.ts';
import { blocksToSay, doctor, fullLines, noteLines, OUTPUT_STOP, readAtOnce, reportJson, SERVER_TIMEOUT_MS, sessionBlocks, type SessionStart, shortLines, STEP_TITLES, UNFILTERED } from '../../../setup/doctor/index.ts';
import { ROAD, STAGES } from '../../../setup/road.ts';
import { READERS } from '../../hook.ts';
import { count, fail, field, type Invocation, moreLine, noRootFinding, noRootScreen, noteLine, parse, print, printJson, requireRoot, rootOf, row, say, terminalOf, title, usage, wrap } from '../../shared.ts';
import { writeLeadSession } from '../../kanban/feed/read/logs.ts';

// The default screen and its parts moved to src/setup/doctor/report.ts, so the first run's
// screen builds on the same report (plan 6.3); these names stay for their callers.
export { nextCommand, problemRows, shortLines, STEP_TITLES } from '../../../setup/doctor/index.ts';

/** The code host whose settings full doctor reads, as its note names it. */
const hostName = (host: Host | undefined): string => (host?.kind === 'gitea' ? 'Gitea' : 'GitHub');

/**
 * The GitHub settings, every read that waits on no other one made at once, under one budget
 * (#1039); undefined for a host gh does not read.
 */
async function readGitHub(host: Host | undefined, root: string, env: Invocation['env']): Promise<{ result: ServerSettings | Unread; slow: number } | undefined> {
  if (host?.kind !== 'github') return undefined;
  return readAtOnce((gh) => readServer(gh, host.repo), ghLaterIn(root, env), SERVER_TIMEOUT_MS);
}

export async function runDoctor(invocation: Invocation): Promise<number> {
  const { env, cwd } = invocation;
  const options = parse('doctor', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  const agent = options.values['--agent'] ?? 'claude-code';
  if (!Object.hasOwn(READERS, agent)) return usage(invocation, `unknown --agent ${agent}; use one of: ${Object.keys(READERS).join(', ')}`);
  const session = options.flags.has('--session');
  const isJson = options.flags.has('--json');
  const root = rootOf(cwd, invocation.env);
  const config = root ? loadConfig(root) : DEFAULTS;
  // The host decides who reads the server settings: GitHub through gh, Gitea through its API (#505).
  const host = root ? hostOf(gitConfig(root, 'remote.origin.url', env), config.host) : undefined;
  // One note while the slow reads run, naming what is read and how long it may take (#561,
  // #1039). A session never reads the server, and --json keeps stdout to the report, so the
  // note goes to a person at a terminal only, in full doctor.
  const isPerson = Boolean(root) && !session && !isJson && terminalOf(invocation).isPerson;
  if (isPerson) print(invocation, noteLine(`reading ${hostName(host)} settings, ${SERVER_TIMEOUT_MS / 1000} seconds at most...`), invocation.stderr);
  // The server reads wait for the network, so they happen here, all at once (#505, #1039).
  const gitea = root && host?.kind === 'gitea' && !session ? await readGiteaServer(host, env) : undefined;
  const github = root && !session ? await readGitHub(host, root, env) : undefined;
  if (isPerson && github?.slow) print(invocation, noteLine(`${count(github.slow, 'GitHub read')} took over ${SERVER_TIMEOUT_MS / 1000} seconds, so ${github.slow === 1 ? 'its settings show' : 'their settings show'} as can't check; run \`yokoten doctor\` again later`), invocation.stderr);
  const server = gitea ?? github?.result;
  // A plugin user updates with `claude plugin update`, which never runs install: the start
  // takes back what v0.1.0 left, with install's own rules (#935).
  const cleanup = session ? cleanOlderInstall(env) : null;
  const { ok, report } = doctor(root, { env, config, session, host, ...(server ? { server } : {}), gh: root ? ghIn(root, env, SERVER_TIMEOUT_MS) : undefined, fillMarks: !session, ...(invocation.platform ? { platform: invocation.platform } : {}) });
  // Full doctor outside a repo says so (#205). A session there stays quiet: no noise in a non-repo folder.
  if (!root && !session) {
    const missing = noRootFinding(cwd, invocation.env);
    if (isJson) printJson(invocation, { ...reportJson(report), ok: false, findings: [...report.findings, missing] });
    else print(invocation, screen(fullLines(report), noRootScreen('doctor', missing)), invocation.stderr);
    return 1;
  }
  if (isJson) {
    printJson(invocation, reportJson(report));
    return session || ok ? 0 : 1;
  }
  const start = root && session && agent === 'claude-code' ? readSessionStart(invocation) : null;
  if (root && session) noteSessionStart(cwd, env, agent, start?.model ?? '', start?.transcriptPath ?? '');
  // A compaction start repeats only what changed (#405); any other start says all, at most
  // SESSION_BLOCKS_MOST blocks (#930). Full doctor shows one screen unless --all asks for the
  // whole map (#1027); a broken self-test still leads.
  const said = root && session
    ? blocksToSay(env, start, sessionBlocks(report, { isPlugin: Boolean(env.CLAUDE_PLUGIN_ROOT) }))
    : [session || options.flags.has('--all') ? fullLines(report) : shortLines(report)];
  const notes: string[][] = [];
  // One block, and only when an older install's copies were there (#935). The edit that
  // stays is named on that first start; a later start finds nothing and says nothing.
  if (cleanup?.files) {
    notes.push([
      ...noteLines(`yokoten: cleaned ${cleanup.files} ${cleanup.files === 1 ? 'file' : 'files'} an older install left; the plugin brings them now`),
      ...(cleanup.edits.length ? noteLines(`yokoten: kept your edit to ${cleanup.edits.join(', ')}: an older install left it`) : []),
      ...cleanup.profiles.flatMap((profile) => noteLines(`yokoten: ${profile} still has the PATH line an older install added; delete the line that ends with "${PROFILE_MARK}"`)),
    ]);
  }
  // A desk that named a vendor other than the harness's (#748) speaks first: the agent
  // learns who it is before the harness's prompt tells it about its own maker.
  const identity = root && session ? identityLine(agent, env) : '';
  // A worker, by YOKOTEN_ROLE or by the mark on its worktree (#555), hears that the guard sees
  // it as one (#402), on every start, a compaction too: its role is safety, never news to
  // drop. The lead hears nothing.
  const role = root && session ? workerRole(env, [cwd]) : null;
  if (role) notes.push(noteLines(`yokoten: ${role === 'mark' ? WORKER_MARKED : WORKER_SESSION}.`));
  // An agent that can't filter command output hears it at session start, with the opt-in (#390).
  if (root && session && agent !== 'claude-code' && config.privacy.output !== 'stop') notes.push(spaced([noteLines(`yokoten: ${UNFILTERED}`), findingRow('Next', `${sentence(OUTPUT_STOP)}.`)]));
  const lines = screen(identity ? noteLines(identity) : [], ...said, ...notes);
  // Gemini CLI reads a SessionStart hook's context from JSON only (#211).
  if (session && agent === 'gemini') {
    if (lines.length) say(invocation, `${gemini.formatSessionContext(hideHome(lines.join('\n'), env))}\n`, invocation.stdout);
  } else print(invocation, lines);
  // A session must start even when doctor found a problem.
  return session || ok ? 0 : 1;
}

/**
 * The session's status file at its start (#685): who runs (vendor, model), in which role
 * (by the guard's own rule), where, and that it works. The board reads it. The model
 * comes from the runtime, or else YOKOTEN_MODEL, which the board sets when it starts one.
 * A lead also records `transcriptPath` for the board (#700). A worker never does.
 */
function noteSessionStart(cwd: string, env: Invocation['env'], agent: string, model: string, transcriptPath: string): void {
  const isWorker = workerRole(env, [cwd]) !== null;
  if (!isWorker && transcriptPath) writeLeadSession(cwd, transcriptPath);
  const checkout = findStatusCheckout(cwd);
  if (!checkout || !canKeepStatus(checkout, isWorker)) return;
  const fields = startFields(agent, isWorker, checkout, model || (env.YOKOTEN_MODEL ?? '').trim().slice(0, 64));
  changeAgentStatus(checkout, { ...fields, set: { ...fields.set, doing: 'started', blocked: null } });
}

const WORKER_SESSION = 'this session is a worker: lead-only files are guarded';
const WORKER_MARKED = 'this session is a worker, because its worktree or clone carries the worker mark: lead-only files are guarded, and the lead pushes after review';

/** How long a session start waits for the hook's event on stdin, at most. */
const STDIN_WAIT_MS = 300;
/** The most of stdin read: an event is a few hundred bytes. */
const STDIN_LIMIT = 1 << 20;

/**
 * The SessionStart event Claude Code writes to stdin, or null when it gives none. It never
 * waits on a terminal, and never longer than STDIN_WAIT_MS on a pipe that stays open.
 */
function readSessionStart({ env, stdin }: Invocation): (SessionStart & { transcriptPath?: string }) | null {
  // Reading the process's stdin stream opens it first. For a pipe, libuv then puts the fd
  // in non-blocking mode, so readSync below throws EAGAIN in place of waiting for a writer
  // that never closes. A file, such as /dev/null, reads to its end at once.
  if (!claudeCode.hasSessionInput(env, stdin.stream.isTTY === true)) return null;
  const { fd } = stdin;
  const toEvent = (text: string) => {
    try {
      return claudeCode.readSessionStart(JSON.parse(text));
    } catch {
      return null;
    }
  };
  // A test's stdin is its text, all there at once.
  if (fd === null) return toEvent(stdin.text ?? '');
  const chunks: Buffer[] = [];
  const buffer = Buffer.alloc(64 * 1024);
  const deadline = Date.now() + STDIN_WAIT_MS;
  const parsed = () => toEvent(Buffer.concat(chunks).toString('utf8'));
  for (let size = 0; size < STDIN_LIMIT; ) {
    let count = 0;
    try {
      count = readSync(fd, buffer);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') break;
      // Nothing to read yet: a whole event read so far is enough; else wait a little.
      if (parsed() || Date.now() > deadline) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      continue;
    }
    if (count === 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, count)));
    size += count;
  }
  return parsed();
}

export function runExplain(invocation: Invocation): number {
  const options = parse('explain', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  const isJson = options.flags.has('--json');
  const [id] = options.positional;
  if (id === undefined) {
    if (isJson) printJson(invocation, { ids: ids() });
    else print(invocation, idListScreen(ids()));
    return 0;
  }
  const found = explain(id);
  if (isJson) {
    printJson(invocation, found ? { found: true, ...found } : { id, found: false, ids: ids() });
    return found ? 0 : 1;
  }
  if (!found) return fail(invocation, `no rule or step is called ${id}`, 'yokoten explain');
  const step = ROAD.find((s) => s.key === found.id);
  print(invocation, explainScreen(found, step ? stepFix(step, invocation) : undefined));
  return 0;
}

/** The first letter small: a task title reads as a sentence after its label (#1027). */
const lowerFirst = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);

/**
 * `yokoten explain <id>` as one screen (#1027): what it is in the title, then What, Why, Check
 * and, for a road step, its Fix, as the caller computed it. A person and an agent read the same
 * words. Pure: the same `found` and `fix` give the same screen.
 */
export function explainScreen(found: Explained, fix?: string): string[] {
  const step = ROAD.find((s) => s.key === found.id);
  const summary = step ? `stage ${step.stage}, ${STAGES[step.stage - 1]}` : found.kind === 'rule' ? 'a rule yokoten checks' : 'a step on the road';
  const task = step ? STEP_TITLES[found.id] : undefined;
  return screen(
    title(`explain ${found.id}`, summary),
    spaced([
      field('What', task ? lowerFirst(task) : found.what),
      field('Why', found.why),
      field('Check', found.check),
      ...(step && fix ? [field('Fix', shortFix(fix))] : []),
      // explain is the detail screen: the outside standard a step meets stays here (#58).
      ...(step?.standard ? [field('Standard', step.standard)] : []),
    ]),
    moreLine(found.docs ?? docsLink('road.md', found.id)),
  );
}

/** The first, usable part of a fix: the rest is a command or a link, and the screen stays short. */
function shortFix(fix: string): string {
  const first = fix.split(', then ')[0] ?? fix;
  // A cut fix says where the rest is, so "paste this" never points at nothing.
  const rest = '; the whole fix: `yokoten doctor --all`';
  if (first === fix && first.length <= 160) return first;
  if (first.length <= 160) return `${first}${rest}`;
  return `${first.slice(0, first.lastIndexOf(' ', 158))}…${rest}`;
}

/** A step's fix, computed where it can be; a step that needs a code host reads none here. */
function stepFix(step: (typeof ROAD)[number], invocation: Invocation): string | undefined {
  try {
    return step.fix(rootOf(invocation.cwd, invocation.env) ?? invocation.cwd, invocation.env, undefined);
  } catch {
    return undefined;
  }
}

/** `yokoten explain` with no id: every id, as rules and as road stages, within 80 columns. */
export function idListScreen(all: readonly string[]): string[] {
  const rules = all.filter((id) => !ROAD.some((step) => step.key === id));
  const steps = ROAD.filter((step) => all.includes(step.key));
  const stages: TableRow[] = STAGES.flatMap((name, stage): TableRow[] => {
    const inStage = steps.filter((step) => step.stage === stage + 1);
    return inStage.length ? [[`${stage + 1}. ${name}`, inStage.map((step) => step.key).join(', ')]] : [];
  });
  return screen(
    title('explain', `${count(rules.length, 'rule')} and ${count(steps.length, 'step')}`),
    section('Rules', wrap('  ', rules.join(', '))),
    section('Road', table(stages)),
    moreLine('`yokoten explain <id>` says what one of them is, and why'),
  );
}

export function runAdopt(invocation: Invocation): number | Promise<number> {
  const { env } = invocation;
  // Reads files and asks the model; never writes a file or changes config.
  const options = parse('adopt', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  const root = requireRoot(invocation, invocation.cwd);
  if (!root) return 1;
  return draft(facts(root, env), { env }).then((drafted) => {
    if (options.flags.has('--json')) {
      printJson(invocation, drafted.rows.map(({ key, status, evidence, decision, reason }) => ({ key, status, evidence, decision, reason })));
      print(invocation, noteLine(`${draftedBy(drafted)} You decide every row.`), invocation.stderr);
    } else print(invocation, options.flags.has('--all') ? adoptAllScreen(drafted) : adoptScreen(drafted));
    return 0;
  });
}

/** Who drafted the rows, as a sentence: the model by name, or the rules and why. */
const draftedBy = (drafted: Draft): string => `Drafted by ${drafted.by}${drafted.note ? `, because ${drafted.note}` : ''}.`;

/** The word a plain reader knows for each decision (issue #1027). */
const DECISION_WORDS = { 'as-is': 'keep', lighter: 'add', 'not-now': 'decide' } as const;
const DECISION_MARKS = { 'as-is': 'ok', lighter: 'next', 'not-now': "can't check" } as const;
/** The heading of each decision's rows on `adopt --all`. */
const DECISION_HEADINGS = { 'as-is': 'Keep as it is', lighter: 'Add a lighter form', 'not-now': 'Not now, or decide later' } as const;
const DECISION_ORDER: readonly Decision[] = ['as-is', 'lighter', 'not-now'];

/**
 * The default screen of `yokoten adopt` (issue #1027): a title, then one row per practice,
 * grouped by what the draft says to do with it, and the full table behind `--all`.
 */
export function adoptScreen(drafted: Draft): string[] {
  // The first few of each group, so the screen fits (R3); the rest fold into a count.
  const caps = { 'as-is': 3, lighter: 4, 'not-now': 3 } as const;
  const rows = DECISION_ORDER.flatMap((decision) => {
    const inGroup = drafted.rows.filter((r) => r.decision === decision);
    return [
      ...inGroup.slice(0, caps[decision]).map((one) => row(DECISION_MARKS[decision], one.evidence || one.status, DECISION_WORDS[decision])),
      ...(inGroup.length > caps[decision] ? [row(DECISION_MARKS[decision], `${count(inGroup.length - caps[decision], 'more row')}, with \`yokoten adopt --all\``, DECISION_WORDS[decision])] : []),
    ];
  });
  return screen(
    title('adopt', 'a draft for this project'),
    spaced(rows),
    // Why the rules drafted it, when they did: a note, never folded (R5).
    drafted.by === 'rules' ? row('note', `drafted by rules${drafted.note ? `: ${drafted.note}` : ''}`, 'why') : [],
    moreLine('`yokoten adopt --json` shows every row with its reason'),
  );
}

/**
 * `yokoten adopt --all`: every row of the draft, grouped by decision, each practice with what
 * the project does today and why, in one text column (#1115). Then who drafted it, and that the
 * person decides every row.
 */
export function adoptAllScreen(drafted: Draft): string[] {
  const column = columnFor(drafted.rows.map((one) => one.key));
  const tableOf = (rows: readonly Row[]): string[] => table(rows.map((one): TableRow => [one.key, `${one.status}${one.evidence ? `: ${one.evidence}` : ''}. ${sentence(one.reason)}${/[.!?]$/.test(one.reason) ? '' : '.'}`]), column);
  return screen(
    title('adopt', `the whole draft, ${count(drafted.rows.length, 'row')}`),
    ...DECISION_ORDER.map((decision) => section(DECISION_HEADINGS[decision], tableOf(drafted.rows.filter((one) => one.decision === decision)))),
    wrap('', drafted.by === 'rules' ? `Drafted by rules (done, missing or unknown: as-is; partial: lighter), because ${drafted.note ?? 'no model was set'}.` : draftedBy(drafted)),
    wrap('', YOU_DECIDE),
  );
}
