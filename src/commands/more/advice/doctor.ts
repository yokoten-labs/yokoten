// `yokoten doctor`, `explain` and `adopt`. Doctor reads and shows. A session start also
// writes the agent's status file, git-ignored (#685). A lead writes its log path into
// the repo's git folder (#700). A Claude Code session start keeps what it said in
// ~/.config/yokoten/sessions/ (#405).

import { readSync } from 'node:fs';
import { identityLine } from '../../../agents/desk/team/who.ts';
import * as claudeCode from '../../../agents/runtimes/claude-code.ts';
import * as gemini from '../../../agents/runtimes/gemini.ts';
import { ghIn } from '../../../host/github/index.ts';
import { readGiteaServer } from '../../../host/gitea.ts';
import { hostOf } from '../../../host/hosts.ts';
import { DEFAULTS, loadConfig } from '../../../rules/config.ts';
import { gitConfig } from '../../../run/check.ts';
import { workerRole } from '../../../rules/guards/index.ts';
import { canKeepStatus, changeAgentStatus, findStatusCheckout, startFields } from '../../../run/hook.ts';
import { docsLink, formatFinding } from '../../../rules/message.ts';
import { hideHome } from '../../../rules/privacy.ts';
import { type Draft, draft, facts, table } from '../../../setup/advice/adopt.ts';
import { explain, type Explained, ids } from '../../../setup/advice/explain.ts';
import { cleanOlderInstall, PROFILE_MARK } from '../../../setup/install.ts';
import { blocksToSay, doctor, type DoctorReport, OUTPUT_STOP, SERVER_TIMEOUT_MS, type SessionStart, UNFILTERED } from '../../../setup/doctor/index.ts';
import { ROAD, STAGES } from '../../../setup/road.ts';
import type { Finding } from '../../../rules/message.ts';
import { READERS } from '../../hook.ts';
import { count, field, type Invocation, moreLine, nextLine, noRootFinding, parse, print, printJson, requireRoot, rootOf, row, say, title, usage, wrap } from '../../shared.ts';
import { writeLeadSession } from '../../kanban/feed/read/logs.ts';

/** What full doctor says while the slow reads run: the server read and (in WSL) the drive read. */
const slowReadLine = (host: string): string => `reading ${host} settings...`;

export async function runDoctor(invocation: Invocation): Promise<number> {
  const { env, cwd } = invocation;
  const options = parse('doctor', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  const agent = options.values['--agent'] ?? 'claude-code';
  if (!Object.hasOwn(READERS, agent)) return usage(invocation, `unknown --agent ${agent}; use one of: ${Object.keys(READERS).join(', ')}`);
  const session = options.flags.has('--session');
  const root = rootOf(cwd, invocation.env);
  const config = root ? loadConfig(root) : DEFAULTS;
  // The host decides who reads the server settings: GitHub through gh, Gitea through its API (#505).
  const host = root ? hostOf(gitConfig(root, 'remote.origin.url', env), config.host) : undefined;
  // One line while the slow reads run. A session never reads the server, and --json
  // keeps stdout to the report, so the line shows on a terminal only, in full doctor.
  if (root && !session && !options.flags.has('--json') && invocation.stdout.isTTY === true) say(invocation, `${slowReadLine(host?.kind === 'gitea' ? 'Gitea' : 'GitHub')}\n`, invocation.stdout);
  // The Gitea read waits for the network, so it happens here; the GitHub read stays in doctor, which uses gh.
  const gitea = host?.kind === 'gitea' && !session ? await readGiteaServer(host, env) : undefined;
  // A plugin user updates with `claude plugin update`, which never runs install: the start
  // takes back what v0.1.0 left, with install's own rules (#935).
  const cleanup = session ? cleanOlderInstall(env) : null;
  const { ok, lines: allLines, blocks, report } = doctor(root, { env, config, session, host, ...(gitea ? { server: gitea } : {}), gh: root ? ghIn(root, env, SERVER_TIMEOUT_MS) : undefined, fillMarks: !session });
  // Full doctor outside a repo says so (#205). A session there stays quiet: no noise in a non-repo folder.
  if (!root && !session) {
    const missing = noRootFinding(cwd, invocation.env);
    if (options.flags.has('--json')) printJson(invocation, { ...report, ok: false, findings: [...report.findings, missing] });
    else print(invocation, [...allLines, `yokoten doctor: ${formatFinding(missing)}`], invocation.stderr);
    return 1;
  }
  const start = root && session && agent === 'claude-code' ? readSessionStart(invocation) : null;
  if (root && session) noteSessionStart(cwd, env, agent, start?.model ?? '', start?.transcriptPath ?? '');
  // A compaction start repeats only what changed (#405); any other start says all.
  // Full doctor shows one screen unless --all asks for the whole map (#1027); a broken self-test still leads.
  const isShort = root && !session && !options.flags.has('--all') && !options.flags.has('--json');
  const lines = root && session && blocks && !options.flags.has('--json') ? blocksToSay(env, start, blocks).flat() : isShort ? shortLines(report, report.selfTest.ok ? undefined : allLines[0]) : allLines;
  // One line, and only when an older install's copies were there (#935). The edit that
  // stays is named on that first start; a later start finds nothing and says nothing.
  if (cleanup?.files && !options.flags.has('--json')) {
    lines.push(`yokoten: cleaned ${cleanup.files} ${cleanup.files === 1 ? 'file' : 'files'} an older install left; the plugin brings them now`);
    if (cleanup.edits.length) lines.push(`yokoten: kept your edit to ${cleanup.edits.join(', ')}: an older install left it`);
    for (const profile of cleanup.profiles) lines.push(`yokoten: ${profile} still has the PATH line an older install added; delete the line that ends with "${PROFILE_MARK}"`);
  }
  // A desk that named a vendor other than the harness's (#748) speaks first: the agent
  // learns who it is before the harness's prompt tells it about its own maker.
  const identity = root && session && !options.flags.has('--json') ? identityLine(agent, env) : '';
  if (identity) lines.unshift(identity);
  // A worker, by YOKOTEN_ROLE or by the mark on its worktree (#555), hears that the guard sees
  // it as one (#402), on every start, a compaction too: its role is safety, never news to
  // drop. The lead hears nothing.
  const role = root && session && blocks && !options.flags.has('--json') ? workerRole(env, [cwd]) : null;
  if (role) lines.push(`yokoten: ${role === 'mark' ? WORKER_MARKED : WORKER_SESSION}.`);
  // An agent that can't filter command output hears it at session start, with the opt-in (#390).
  if (root && session && agent !== 'claude-code' && config.privacy.output !== 'stop') lines.push(`yokoten: ${UNFILTERED}. ${OUTPUT_STOP[0].toUpperCase()}${OUTPUT_STOP.slice(1)}.`);
  if (options.flags.has('--json')) printJson(invocation, report);
  // Gemini CLI reads a SessionStart hook's context from JSON only (#211).
  else if (session && agent === 'gemini') {
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
  const [id] = options.positional;
  if (id === undefined) {
    if (options.flags.has('--json')) printJson(invocation, { ids: ids() });
    else print(invocation, idListLines());
    return 0;
  }
  const found = explain(id);
  if (options.flags.has('--json')) printJson(invocation, found ? { found: true, ...found } : { id, found: false, ids: ids() });
  else if (found) print(invocation, explainScreen(invocation, found));
  else print(invocation, [`yokoten explain: no rule or step is called ${id}.`, `Ids: ${ids().join(', ')}`], invocation.stderr);
  return found ? 0 : 1;
}

/** The first letter small: a task title reads as a sentence after its label (#1027). */
const lowerFirst = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);

/**
 * `yokoten explain <id>` as one screen (#1027): what it is in the title, then What, Why, Check
 * and, for a road step, its Fix. A person and an agent read the same words.
 */
function explainScreen(invocation: Invocation, found: Explained): string[] {
  const step = ROAD.find((s) => s.key === found.id);
  const summary = step ? `stage ${step.stage}, ${STAGES[step.stage - 1]}` : found.kind === 'rule' ? 'a rule yokoten checks' : 'a step on the road';
  const lines = [...title(`explain ${found.id}`, summary), ''];
  const task = step ? STEP_TITLES[found.id] : undefined;
  lines.push(...field('What', task ? lowerFirst(task) : found.what));
  lines.push(...field('Why', found.why));
  lines.push(...field('Check', found.check));
  if (step) {
    const fix = stepFix(step, invocation);
    if (fix) lines.push(...field('Fix', shortFix(fix)));
  }
  // explain is the detail screen: the outside standard a step meets stays here (#58).
  if (step?.standard) lines.push(...field('Standard', step.standard));
  lines.push('');
  lines.push(...moreLine(found.docs ?? docsLink('road.md', found.id)));
  return lines;
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

/** `yokoten explain` with no id: every id, grouped as rules and as road stages, within 80 columns. */
function idListLines(): string[] {
  const all = ids();
  const rules = all.filter((id) => !ROAD.some((step) => step.key === id));
  const steps = ROAD.filter((step) => all.includes(step.key));
  const lines = [...title('explain', `${count(rules.length, 'rule')} and ${count(steps.length, 'step')}`), ''];
  lines.push('Rules', ...wrap('  ', rules.join(', ')));
  if (steps.length) {
    lines.push('Road');
    for (const [stage, name] of STAGES.entries()) {
      const inStage = steps.filter((step) => step.stage === stage + 1);
      if (!inStage.length) continue;
      lines.push(...wrap('  ', `stage ${stage + 1} of ${STAGES.length}, ${name}`));
      lines.push(...wrap('    ', inStage.map((step) => step.key).join(', ')));
    }
  }
  return lines;
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
      print(invocation, [`yokoten adopt: drafted by ${drafted.by}${drafted.note ? `, because ${drafted.note}` : ''}. You decide every row.`], invocation.stderr);
    } else print(invocation, options.flags.has('--all') ? table(drafted) : adoptScreen(drafted));
    return 0;
  });
}

/** The word a plain reader knows for each decision (issue #1027). */
const DECISION_WORDS = { 'as-is': 'keep', lighter: 'add', 'not-now': 'decide' } as const;
const DECISION_MARKS = { 'as-is': 'ok', lighter: 'next', 'not-now': "can't check" } as const;

/**
 * The default screen of `yokoten adopt` (issue #1027): a title, then one row per practice,
 * grouped by what the draft says to do with it, and the full table behind `--json`.
 */
export function adoptScreen(drafted: Draft): string[] {
  const lines = [...title('adopt', 'a draft for this project'), ''];
  // The first few of each group, so the screen fits (R3); the rest fold into a count.
  const caps = { 'as-is': 3, lighter: 4, 'not-now': 3 } as const;
  for (const decision of ['as-is', 'lighter', 'not-now'] as const) {
    const rows = drafted.rows.filter((r) => r.decision === decision);
    for (const one of rows.slice(0, caps[decision])) lines.push(...row(DECISION_MARKS[decision], one.evidence || one.status, DECISION_WORDS[decision]));
    if (rows.length > caps[decision]) lines.push(...row(DECISION_MARKS[decision], `${count(rows.length - caps[decision], 'more row')}, with \`yokoten adopt --all\``));
  }
  // Why the rules drafted it, when they did: a note, never folded (R5).
  if (drafted.by === 'rules') lines.push('', ...row('note', `drafted by rules${drafted.note ? `: ${drafted.note}` : ''}`));
  lines.push('', ...moreLine('`yokoten adopt --json` shows every row with its reason'));
  return lines;
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

/** The default screen of `yokoten doctor`, from its report; a broken self-test line leads. */
export function shortLines(report: DoctorReport, brokenLine?: string): string[] {
  const lines: string[] = brokenLine ? [brokenLine, ''] : [];
  const steps = report.steps ?? [];
  const stepIds = new Set(steps.map((s) => s.id));
  const left = steps.filter((s) => s.mark === 'next' || s.mark === 'to do').sort((a, b) => (a.mark === 'next' ? -1 : b.mark === 'next' ? 1 : 0));
  const problems = report.findings.filter((x) => !stepIds.has(x.id));
  if (report.stage === null && !problems.length) return [...lines, ...title('doctor', `all ${STAGES.length} stages done, nothing to do`)];
  lines.push(...title('doctor', report.stage === null ? `all ${STAGES.length} stages done` : `stage ${report.stage} of ${STAGES.length}, ${STAGES[report.stage - 1]}`), '');
  const done = steps.filter((s) => s.mark === 'done' || s.mark === 'not now').length;
  if (steps.length) lines.push(...row('done', `${done} of ${count(steps.length, 'step')}`));
  // A problem fails doctor, so it is never folded: each one with its fix.
  for (const f of problems) lines.push(...row('MISSING', `${f.what}; ${f.fix}`));
  // The next step and four more; the rest fold into one row, so a new project still fits a screen (R3).
  for (const s of left.slice(0, 5)) lines.push(...row(s.mark === 'next' ? 'next' : 'to do', STEP_TITLES[s.id] ?? s.id));
  if (left.length > 5) lines.push(...row('to do', `${count(left.length - 5, 'more step')}, listed by \`yokoten doctor --all\``));
  const unchecked = steps.filter((s) => s.mark === "can't check").length;
  if (unchecked) lines.push(...row("can't check", `${count(unchecked, 'step')} read the code host; doctor checks them after a push`));
  // Work only on this machine can be lost, so it shows too, one line each.
  for (const f of (report.notes ?? []).filter((n) => n.id === 'uncommitted-changes' || n.id === 'unpushed-commits')) lines.push(...row('note', f.what.split(';')[0]?.replace(/^\. has /, 'this project has ') ?? f.what));
  lines.push('');
  if (report.next) lines.push(...nextLine(nextCommand(report.next)));
  const notes = (report.notes ?? []).length;
  lines.push(...moreLine(`\`yokoten doctor --all\` shows every check${notes ? ` and ${count(notes, 'note')}` : ''}`));
  return lines;
}
