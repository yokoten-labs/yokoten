// `yokoten` with no command, `init`, `update`, `install`, `uninstall` and `upgrade`: they write yokoten into a project or a machine, or bring it up to date.

import { existsSync, readSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Writable } from 'node:stream';
import { ghIn } from '../../host/github/index.ts';
import { type Env, loadConfig } from '../../rules/config.ts';
import { hideHome, homeOf, NO_HOME } from '../../rules/privacy.ts';
import { init, trust, undoTrust, updateCoreRules } from '../../setup/init.ts';
import { type Ask, agentsHere, install, isMachineSetUp, isYes, launcherDir, skillNames, uninstall } from '../../setup/install.ts';
import { readOriginUrl, setUpPlanning } from '../../setup/plan.ts';
import { VERSION } from '../../setup/files.ts';
import { enabledPlugin } from '../../setup/advice/marketplace.ts';
import { count, type Invocation, moreLine, nextLine, noRootFinding, noRootScreen, type Output, parse, print, requireRoot, rootOf, row, screen, spaced, title, usage, wrap } from '../shared.ts';

/**
 * `yokoten` with no command: the one command that gets a project running (#548). It installs
 * on the machine when that is missing, adds the rules to this project when that is missing,
 * and ends with the road, so a beginner reads the next step and nothing else. Each step is
 * already safe by default: install writes its own files, and init only adds (#120, record 0014).
 */
export async function runStart(invocation: Invocation): Promise<number> {
  const { env, cwd } = invocation;
  const root = rootOf(cwd, env);
  // Outside a project yokoten writes nothing: the first step is git's, not ours.
  if (!root) {
    const missing = noRootFinding(cwd, env);
    print(invocation, noRootScreen(undefined, missing), invocation.stderr);
    return 1;
  }
  // No home folder means no place to install into (#548). Say it the way install does,
  // instead of letting a path throw: a beginner reads one plain line, not a stack trace.
  if (!homeOf(env)) {
    print(invocation, [`${NO_HOME}. Set HOME to your home folder's full path and run \`yokoten\` again.`], invocation.stderr);
    return 1;
  }
  const isMachineMissing = !isMachineSetUp(env);
  const isProjectMissing = !hasProjectRules(root);
  const ask = askWhenTerminal(invocation);
  // Rustup's way (#1027): a person sees one screen of what changes, then answers one
  // question. An agent, CI or a pipe has nobody to ask and goes ahead, as before.
  if ((isMachineMissing || isProjectMissing) && ask) {
    print(invocation, previewLines(env, isMachineMissing, isProjectMissing));
    if (!isYes(ask(SET_UP_QUESTION))) {
      print(invocation, title(VERSION, 'nothing changed'));
      return 0;
    }
    print(invocation, ['']);
  }
  // Each step that ran reports whether it is done: an install that failed is not "Setup is done" (#548).
  // A step that went well is one row on doctor's screen; one that failed keeps its whole screen,
  // since a problem is never folded (#1027).
  const doneRows: string[] = [];
  const failedScreens: string[][] = [];
  if (isMachineMissing) {
    const done = install(env, { cwd, gh: ghIn(cwd, env, 3000), ask, platform: invocation.platform });
    // No label column: doctor's rows below have none, so every row's text starts in one column (#1115).
    if (done.ok) doneRows.push(...row('ok', `guard on for ${guardedAgents(done.lines).join(', ') || 'your agents'} on this computer`));
    else failedScreens.push(installScreen(invocation, done.lines, done.ok, true));
  }
  if (isProjectMissing) {
    const done = init(root, env, undefined, { ask, platform: invocation.platform });
    const wrote = done.lines.filter((line) => /^wrote /.test(line)).length;
    if (done.ok && !done.lines.some((line) => NEEDS_HAND.test(line))) doneRows.push(...row('ok', `${count(wrote, 'file')} written in this project, none of yours changed`));
    else failedScreens.push(projectScreen(done.lines, done.ok, true));
  }
  for (const screen of failedScreens) print(invocation, [...screen, '']);
  const ran = isMachineMissing || isProjectMissing;
  const runDoctor = (await import('./advice/doctor.ts')).runDoctor;
  if (!ran) return runDoctor(invocation);
  // One screen (#1027): doctor's title, what this run did, the road, and one Next line, to keep
  // what it wrote. Doctor's own Next waits for that commit; its More line stays last.
  const held: string[] = [];
  const sink = new Writable({ write: (chunk, _, done) => { held.push(String(chunk)); done(); } });
  const code = await runDoctor({ ...invocation, stdout: sink });
  const lines = held.join('').replace(/\n$/, '').split('\n');
  const next = lines.findIndex((line) => line.startsWith('Next: '));
  const moreAt = lines.findIndex((line) => line.startsWith('More: '));
  const more = moreAt === -1 ? [] : lines.slice(moreAt);
  const body = lines.slice(0, next === -1 ? (moreAt === -1 ? lines.length : moreAt) : next);
  while (body.length && body.at(-1) === '') body.pop();
  // The title says this run set things up, then where the road is.
  const head = body[0]?.replace(/^yokoten doctor · /, `yokoten ${VERSION} · set up; `) ?? '';
  // Doctor's problems come first, as their own block (#1115): this run's rows stand apart from them.
  const isProblemNext = doneRows.length > 0 && /^ {2}MISSING /.test(body[2] ?? '');
  print(invocation, [head, ...body.slice(1, 2), ...doneRows, ...(isProblemNext ? [''] : []), ...body.slice(2), '', ...nextLine('git add -A && git commit -m "chore: add yokoten"'), ...more]);
  return code;
}

/** True when init has already put the rules in this project. */
const hasProjectRules = (root: string): boolean =>
  existsSync(resolve(root, 'AGENTS.md')) && existsSync(resolve(root, 'yokoten.json'));

/**
 * Whether someone is at the terminal. Trust has no question, so this is what makes its
 * write the person's decision rather than a pipe's (#661).
 */
const isAtTerminal = (invocation: Invocation): boolean => invocation.stdin.stream.isTTY === true && invocation.stdout.isTTY === true;

/**
 * The terminal to ask on, or undefined in a pipe, a hook or CI (#433): an asked question
 * with nobody there would stop the command.
 */
const askWhenTerminal = (invocation: Invocation): Ask | undefined => {
  const { stdin, stdout } = invocation;
  return stdin.fd !== null && stdin.stream.isTTY && stdout.isTTY ? askOnTerminal(stdout, stdin.fd) : undefined;
};

// ---- One screen per command (issue #1027) ----

/** Where a labelled row's text starts, so a wrapped line lines up under it. */
const ROW_TEXT_INDENT = ' '.repeat(26);

/** A line that says install changed something; a run with none of them changed nothing. */
const CHANGED = /^(wrote|added|updated|linked|removed) /;

/** The skill names a report names, each once. */
function reportedSkills(lines: string[]): string[] {
  const names = lines.map((line) => / skill ([\w-]+) in /.exec(line)?.[1]).filter((name): name is string => name !== undefined);
  return [...new Set(names)];
}

/** The agents install left out because their own folder is not on this computer. */
const absentAgents = (lines: string[]): string[] =>
  lines.map((line) => /^skipped (.+?): .*not found/.exec(line)?.[1]).filter((name): name is string => name !== undefined);

/** A line that leaves a step for the person: the commit check not on yet, or a line to add by hand (#1027 review). */
const NEEDS_HAND = /core\.hooksPath|not on yet|by hand/;

/** A step left for the person, as a MISSING row; a line to paste stays whole on its own line, so it copies as one (#1027 review). */
function handRow(problem: string): string[] {
  const at = /^(.*?Add this line[^:]*:) (.+)$/.exec(problem.replace(/^kept /, ''));
  if (!at) return row('MISSING', problem.replace(/^kept /, ''));
  return [...row('MISSING', at[1]), `${' '.repeat(14)}${at[2]}`];
}

/** Why a line is a problem: a step that failed, or one left for the person; never one that found nothing to do. */
const isProblem = (line: string): boolean =>
  /^(couldn't|kept the Claude Code hooks)/.test(line) || NEEDS_HAND.test(line) || (/^skipped /.test(line) && !/ not found|the global git setting|"notNow"/.test(line));

/** The home folder as `~`, so a screen measures what a reader sees (#1027, R9). */
const shownPath = (invocation: Invocation, path: string): string => {
  const home = homeOf(invocation.env);
  return home ? path.split(home).join('~') : path;
};

/** The agents whose guard install really runs: a file of the user's own is not the guard. */
function guardedAgents(lines: string[]): string[] {
  const others = lines
    .filter((line) => !/\(yours, not yokoten's\)/.test(line))
    .map((line) => /(?:added|kept|updated|wrote) the (\w[\w ]*?) (?:SessionStart doctor|command guard) in /.exec(line)?.[1])
    .filter((name): name is string => name !== undefined);
  const isClaude = lines.some((line) => /the (?:SessionStart doctor|user-level command guard)$/.test(line) || /Claude Code hooks/.test(line));
  return [...(isClaude ? ['Claude Code'] : []), ...new Set(others)];
}

/** The rest of a report, for a command whose full list sits behind --list. */
function remaining(lines: string[], { isProblemsOnly = false } = {}): string[] {
  const notes = lines.filter((line) => /^skipped the global git setting mailmap\.file/.test(line) || /^your edits stay/.test(line));
  const problems = lines.filter(isProblem);
  const out: string[] = [];
  for (const note of notes) {
    if (isProblemsOnly) continue;
    if (/^your edits stay/.test(note)) {
      out.push(...row('note', 'your own edits stay; the newest copies are in the kit', 'kept'));
      continue;
    }
    const fix = /`(git config[^`]+)`/.exec(note)?.[1];
    out.push(...row('note', 'hide your email in git logs: not on yet', 'email'));
    // The command stays whole on a line of its own, so it fits 80 columns and copies as one.
    if (fix) out.push(`${ROW_TEXT_INDENT}to turn it on:`, `${' '.repeat(14)}\`${fix}\``);
  }
  for (const problem of problems) out.push(...handRow(problem));
  return out;
}

/** The one screen `yokoten install` shows, from the report it wrote (#1027). */
function installScreen(invocation: Invocation, lines: string[], ok: boolean, isFirstRun = false): string[] {
  if (ok && !lines.some((line) => CHANGED.test(line))) {
    return [...title('install', 'already set up here, nothing changed'), ...moreLine('`yokoten install --list` names every file')];
  }
  const out = title(isFirstRun ? VERSION : 'install', isFirstRun ? 'first run' : ok ? 'this computer is set up' : 'this computer is partly set up');
  out.push('');
  const guarded = guardedAgents(lines);
  // No agent guarded is never "ok": the row says so, and the problem rows below say why (#1027 review).
  out.push(...(guarded.length ? row('ok', `on for ${guarded.join(', ')}`, 'guard') : row('MISSING', 'not on for any agent yet', 'guard')));
  const skills = reportedSkills(lines);
  if (skills.length) out.push(...row('ok', skills.join(', '), 'skills'));
  const absent = absentAgents(lines);
  if (absent.length) out.push(...row("can't check", `${absent.length} not installed here; run install again later`, 'other AIs'));
  const pathLine = lines.find((line) => / is not on your PATH/.test(line));
  if (pathLine) {
    out.push(...row('note', `${shownPath(invocation, /^(\S+) is not on your PATH/.exec(pathLine)?.[1] ?? launcherDir(homeOf(invocation.env) ?? ''))} is not on your PATH yet`, 'command'));
    out.push(
      ...(invocation.platform === 'win32'
        ? wrap(ROW_TEXT_INDENT, 'Windows: "Edit environment variables for your account"')
        : wrap(ROW_TEXT_INDENT, 'add this line to your shell profile: export PATH="$HOME/.local/bin:$PATH"')),
    );
  }
  const rest = remaining(lines);
  if (rest.length) out.push('', ...rest);
  // In a first run the project's screen follows, so this one has no next command of its own.
  if (!isFirstRun) {
    out.push('');
    out.push(...nextLine(existsSync(resolve(invocation.cwd, 'AGENTS.md')) ? 'yokoten doctor' : 'yokoten init'));
    out.push(...moreLine('`yokoten install --list` names every file'));
  }
  return out;
}

/** The one screen `yokoten uninstall` shows: counts, then the command that puts it back (#1027). */
function uninstallScreen(lines: string[], ok: boolean): string[] {
  // Say why there is nothing to remove, so the screen means something to a newcomer (#1115).
  if (!lines.some((line) => /^removed /.test(line))) return title('uninstall', 'nothing to remove: yokoten is not installed on this computer');
  const skills = new Set(lines.map((line) => /^removed skill ([\w-]+) in /.exec(line)?.[1]).filter(Boolean)).size;
  const agents = lines.filter((line) => /^removed agent /.test(line)).length;
  const hooks = lines.filter((line) => /^removed the .*(doctor|guard|hooks)/.test(line)).length;
  const removed = [skills && `${skills} skill${skills === 1 ? '' : 's'}`, agents && `${agents} agents`, hooks && `${hooks} hooks`].filter(Boolean);
  const out = title('uninstall', ok ? 'removed what install wrote' : 'removed some of what install wrote');
  out.push('');
  // No label column, so the MISSING rows below start their text in the same column (#1115).
  if (removed.length) out.push(...row('ok', `removed ${removed.join(', ')}`));
  if (ok) out.push(...row('ok', 'kept your own files, keys and private marks'));
  const problems = lines.filter((line) => !/^(removed|nothing to remove|not there|kept|yokoten: cleaned)/.test(line));
  if (problems.length) out.push('', ...problems.flatMap((line) => row('MISSING', line)));
  out.push('');
  out.push(`To install again: \`yokoten install\``);
  return out;
}

/** The project part of the first run: init's report as four rows and a file count (#1027). */
function projectScreen(lines: string[], ok: boolean, isFirstRun = false): string[] {
  const wrote = lines.filter((line) => /^wrote /.test(line));
  const kept = lines.filter((line) => /^kept /.test(line));
  if (ok && !wrote.length) return title('init', 'already set up here, nothing changed');
  const workflows = wrote.filter((line) => /^wrote \.github\/workflows\//.test(line)).length;
  const hasDependabot = wrote.some((line) => /dependabot/.test(line));
  const hasGithubFiles = wrote.some((line) => /templates|CODEOWNERS|pull_request_template/.test(line));
  const agents = lines.filter((line) => /hook in \./.test(line)).length;
  const isDone = ok && !lines.some((line) => NEEDS_HAND.test(line));
  const out = title('init', isDone ? 'this project is set up' : 'this project is partly set up');
  out.push('');
  out.push(...row('ok', 'AGENTS.md, the commit check', 'rules'));
  const ci = [workflows && `${workflows} workflows`, hasDependabot && 'Dependabot'].filter(Boolean).join(', ');
  if (ci) out.push(...row('ok', ci, 'CI'));
  if (hasGithubFiles) out.push(...row('ok', 'issue and PR templates, CODEOWNERS', 'GitHub'));
  out.push(...row('ok', `guard for Claude Code${agents > 1 ? ` and ${agents - 1} more` : ''}`, 'agents'));
  out.push(`${ROW_TEXT_INDENT}${wrote.length} files written${kept.length ? `, ${kept.length} of yours kept` : ', none of yours changed'}`);
  const rest = remaining(lines, { isProblemsOnly: true });
  if (rest.length) out.push('', ...rest);
  // The first run ends on one Next line, after doctor, so this screen names only the rest.
  if (!isFirstRun) {
    out.push('');
    out.push(...nextLine('git add -A && git commit -m "chore: add yokoten"'));
    out.push(...moreLine('`yokoten init --list` names every file'));
  } else out.push('', ...moreLine('`yokoten init --list` names every file'));
  return out;
}

/** What the first run will write, before it asks: two groups, then the way back (#1027). */
export function previewLines(env: Env, isComputer: boolean, isProject: boolean): string[] {
  const out = title(VERSION, 'first run: here is what changes');
  out.push('');
  if (isComputer) {
    const agents = ['Claude Code', ...agentsHere(env)];
    out.push(`  computer   guard on for ${agents.join(', ')}, ${skillNames().length} skills`);
    out.push(`             the runtime and a yokoten command in ${hideHome(launcherDir(homeOf(env) ?? ''), env)}`);
  }
  if (isProject) {
    out.push(`  project    AGENTS.md, the commit check, CI and the templates`);
    out.push('             nothing of yours is overwritten');
  }
  out.push('');
  out.push(isComputer ? 'Undo: `yokoten uninstall`' : 'Undo: `git restore .`');
  return out;
}

/** The question the first run and install ask before they write (#1027). */
export const SET_UP_QUESTION = 'Set up yokoten here? [Y/n]';

export function runInit(invocation: Invocation): number {
  const options = parse('init', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  if (options.flags.has('--yes') && !options.flags.has('--github')) return usage(invocation, '--yes goes with --github');
  if (options.flags.has('--remove-default-labels') && !options.flags.has('--github')) return usage(invocation, '--remove-default-labels goes with --github');
  if (options.flags.has('--board') && !options.flags.has('--github')) return usage(invocation, '--board goes with --github');
  const dir = resolve(invocation.cwd, options.positional[0] ?? '.');
  // Checked before anything is written (#205): a typo never becomes a new folder.
  if (!existsSync(dir)) {
    print(invocation, [`yokoten init: ${options.positional[0]} does not exist; nothing was written. Create it and run \`git init\` there first.`], invocation.stderr);
    return 1;
  }
  const root = requireRoot(invocation, dir);
  if (!root) return 1;
  // Read first: a broken yokoten.json stops init before it writes a file.
  const { areas } = loadConfig(root);
  // The tests job is asked first (#550): only with a terminal on stdin and stdout, as install asks.
  const ask = askWhenTerminal(invocation);
  const done = init(root, invocation.env, undefined, { noCi: options.flags.has('--no-ci'), ask, platform: invocation.platform });
  // The host is changed only when asked (#10): it is a remote, and other people see it.
  // Without --yes, init only reads it and says what it would do, or what it skipped.
  const planning = setUpPlanning(ghIn(root, invocation.env), readOriginUrl(root, invocation.env), {
    apply: options.flags.has('--yes'),
    removeDefaults: options.flags.has('--remove-default-labels'),
    areas,
    board: options.flags.has('--board'),
  });
  // --github --yes asked for changes on GitHub; a skip made none, so it fails (#208).
  const isRefused = planning.skipped && options.flags.has('--yes');
  // `--list` keeps the full report, printed as before, on the stream that already carried it.
  if (options.flags.has('--list')) {
    print(invocation, done.lines);
    print(invocation, planning.lines, planning.ok && !isRefused ? invocation.stdout : invocation.stderr);
  } else {
    // A plain init never asks GitHub, so its skip is not news on the screen (#1027); --github shows rows.
    const plan = options.flags.has('--github') ? planScreen(planning.lines) : [];
    print(invocation, initScreen(done.lines, plan, done.ok), planning.ok && !isRefused ? invocation.stdout : invocation.stderr);
  }
  if (isRefused) print(invocation, ['yokoten init: --github --yes changed nothing on GitHub (the reason is above). The project files are as listed above.'], invocation.stderr);
  return planning.ok && !isRefused && done.ok ? 0 : 1;
}

// The default screen of `yokoten init` (issue #1027, the design the owner approved 2026-10-25):
// a title, groups of rows, and the command to type. `--list` keeps the full line-by-line report.
// Only the printing changes: the same files are written, and the exit code is untouched.

/** The agents init writes a guard for, in the order the report names them. */
const INIT_AGENTS = ['Claude Code', 'Codex', 'Gemini CLI', 'Antigravity CLI', 'OpenCode', 'Muse Code', 'DeepSeek Harness', 'Grok CLI'];
/** The folders whose files are the agents' guard and sandbox settings. */
const AGENT_FOLDERS = ['.claude/', '.codex/', '.gemini/', '.agents/', '.opencode/', '.muse/', '.dsh/', '.grok/'];

interface InitItem {
  /** True when init wrote or changed this item on this run. */
  isWritten: boolean;
  /** The file the line is about, when it names one. */
  path: string | null;
  line: string;
}

/** One report line of init as an item: whether it was written, and which file it names. */
function initItem(line: string): InitItem {
  const isWritten = /^(?:wrote|updated|linked|added) /.test(line);
  const direct = /^(?:wrote|updated|linked|kept) ([^\s(]+)/.exec(line);
  const inside = / in (\.[^\s()]+)/.exec(line);
  const path = direct?.[1] !== undefined && /[./]/.test(direct[1]) ? direct[1] : inside?.[1] ?? null;
  return { isWritten, path, line };
}

/** Whether a line says a file of the user's was left as it is, which is a note. */
const isYours = (line: string): boolean => /^kept (?:your|\(your edit\))/.test(line) || /\(yours, not yokoten's\)$/.test(line);

/** The group a line belongs to; null for the plain files the count folds. */
function initGroup(item: InitItem): 'rules' | 'CI' | 'GitHub' | 'agents' | null {
  const path = item.path ?? '';
  if (/AGENTS\.md/.test(item.line) || item.line.startsWith('git hook:') || path.startsWith('.githooks/')) return 'rules';
  if (path.startsWith('.github/workflows/') || path === '.github/dependabot.yml') return 'CI';
  if (path.startsWith('.github/ISSUE_TEMPLATE/') || path === '.github/pull_request_template.md' || path === '.github/CODEOWNERS' || path === '.github/SECURITY.md') return 'GitHub';
  if (AGENT_FOLDERS.some((folder) => path.startsWith(folder))) return 'agents';
  return null;
}

/** The text of one group's row, from the items it holds. */
function groupText(group: 'rules' | 'CI' | 'GitHub' | 'agents', items: InitItem[]): string {
  const paths = items.filter((item) => initGroup(item) === group && item.path !== null).map((item) => item.path ?? '');
  if (group === 'rules') return 'AGENTS.md, the commit check';
  if (group === 'CI') {
    const workflows = new Set(paths.filter((path) => path.startsWith('.github/workflows/')));
    const parts = [count(workflows.size, 'workflow')];
    if (paths.includes('.github/dependabot.yml')) parts.push('Dependabot');
    return parts.join(', ');
  }
  if (group === 'GitHub') {
    const parts: string[] = [];
    if (paths.some((path) => path.startsWith('.github/ISSUE_TEMPLATE/') || path === '.github/pull_request_template.md')) parts.push('issue and PR templates');
    if (paths.includes('.github/CODEOWNERS')) parts.push('CODEOWNERS');
    if (paths.includes('.github/SECURITY.md')) parts.push('a security policy');
    return parts.join(', ') || 'nothing to add';
  }
  const found = INIT_AGENTS.filter((name) => items.some((item) => initGroup(item) === 'agents' && item.line.includes(name)));
  const [first] = found;
  if (first === undefined) return 'no agent found';
  return found.length === 1 ? `guard for ${first}` : `guard for ${first} (${found.length - 1} more ready)`;
}

/** The default screen of `yokoten init`, from its report lines and the GitHub rows when asked. */
export function initScreen(lines: string[], plan: string[] = [], ok = true): string[] {
  const items = lines.map(initItem);
  const isRuntimeCopy = (item: InitItem): boolean => item.path === '.yokoten/';
  const written = new Set(items.filter((item) => item.isWritten && !isRuntimeCopy(item) && item.path !== null).map((item) => item.path ?? ''));
  const kept = new Set(items.filter((item) => !item.isWritten && !isRuntimeCopy(item) && item.path !== null).map((item) => item.path ?? ''));
  // A file kept because the user changed it, a skip and a command to run by hand need an answer,
  // so they are never folded (R5 of the design).
  const notes = items
    .filter((item) => isYours(item.line) || /^(?:skipped |could not )/.test(item.line) || (!/^(?:wrote|updated|linked|added|kept) /.test(item.line) && !item.line.startsWith('git hook:') && item.line !== 'other agents: see the guide'))
    .map((item) => item.line)
    .filter((line, at, all) => all.indexOf(line) === at);
  // A step left for the person is a MISSING row, never a note or a file count (#1027 review).
  const handRows = lines.filter((line, at) => NEEDS_HAND.test(line) && lines.indexOf(line) === at).flatMap(handRow);
  const otherNotes = notes.filter((line) => !NEEDS_HAND.test(line));
  const more = moreLine('`yokoten init --list` shows every file');
  // The notes are a block of their own, as on the first run (#1115).
  if (written.size === 0 && !handRows.length) {
    const said = screen(title('init', 'already set up here, nothing changed'), plan, spaced(notes.map(noteLine)));
    return plan.length || notes.length ? [...said, '', ...more] : [...said, ...more];
  }
  const groups = (['rules', 'CI', 'GitHub', 'agents'] as const).filter((group) => items.some((item) => initGroup(item) === group));
  // Partly new: list only the groups that got something on this run.
  const shown = groups.filter((group) => items.some((item) => initGroup(item) === group && item.isWritten));
  const isPartly = !ok || handRows.length > 0;
  const out = [...title('init', isPartly ? 'this project is partly set up' : 'this project is set up'), ''];
  const isPartlyNew = kept.size > 0;
  // Partly new: a group names only what this run added, so an old file is not news.
  const listed = isPartlyNew ? items.filter((item) => item.isWritten) : items;
  // The group in the text, not a label column: the notes and MISSING rows have none (#1115).
  for (const group of shown) out.push(...row('done', `${group}: ${groupText(group, listed)}`));
  const summary = isPartlyNew
    ? `${count(written.size, 'file')} added, ${count(kept.size, 'file')} already there`
    : `${count(written.size, 'file')} written, ${notes.some(isYours) ? 'your own files kept' : 'none of yours changed'}`;
  out.push(...wrap('  ', summary));
  out.push(...handRows, ...plan);
  // The notes are a block of their own, a blank line between them when one wraps (#1115).
  const noteRows = spaced(otherNotes.map(noteLine));
  if (noteRows.length) out.push('', ...noteRows);
  out.push('', ...nextLine('git add -A && git commit -m "chore: add yokoten"'), ...more);
  return out;
}

/** One note of init as a row, so a queue and an agent read the same words. */
function noteLine(line: string): string[] {
  const text = line.replace(/^kept (?:your|\(your edit\)) /, 'your ').replace(/^kept /, '');
  return row('note', text);
}

/** The GitHub part of `yokoten init --github` as rows: what was done, kept, skipped or planned. */
export function planScreen(lines: string[]): string[] {
  const rows: string[] = [];
  for (const line of lines) {
    const done = /^- done: (.*)$/.exec(line);
    const failed = /^- could not (.*)$/.exec(line);
    const keptLine = /^- (.*kept)$/.exec(line);
    const item = /^- (.*)$/.exec(line);
    const head = /^GitHub: (.*)$/.exec(line);
    if (done) rows.push(...row('done', done[1] ?? '', 'GitHub'));
    else if (failed) rows.push(...row('MISSING', failed[1] ?? '', 'GitHub'));
    else if (keptLine) rows.push(...row('ok', keptLine[1] ?? '', 'GitHub'));
    else if (line === 'Nothing to change.') rows.push(...row('ok', 'nothing to change', 'GitHub'));
    else if (item) rows.push(...row('to do', item[1] ?? '', 'GitHub'));
    else if (head) rows.push(...row(line.startsWith('GitHub: skipped') ? 'note' : 'ok', head[1] ?? '', 'GitHub'));
    else if (line.startsWith('Nothing changed.')) rows.push(...nextLine(line.replace(/^Nothing changed\. /, '').replace(/`/g, '')));
    else if (line !== 'Would do:') rows.push(...wrap('  ', line));
  }
  return rows;
}

export function runTrust(invocation: Invocation): number {
  const options = parse('trust', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  // A person turns the guard on (#661): a pipe, a hook or CI has nobody to decide, and an
  // agent that ran the command would change the trust in its user's own settings.
  if (!isAtTerminal(invocation)) {
    print(invocation, [...title('trust', 'a person runs this at a terminal; nothing was written'), '', ...row('note', 'it changes the trust in your own agent settings, so a person decides'), '', ...nextLine('yokoten trust')], invocation.stderr);
    return 1;
  }
  const dir = resolve(invocation.cwd, options.positional[0] ?? '.');
  if (!existsSync(dir)) {
    print(invocation, [`yokoten trust: ${options.positional[0]} does not exist; nothing was written.`], invocation.stderr);
    return 1;
  }
  const root = requireRoot(invocation, dir);
  if (!root) return 1;
  const isUndo = options.flags.has('--undo');
  const done = isUndo ? undoTrust(root, invocation.env) : trust(root, invocation.env);
  print(invocation, trustScreen(done.lines, isUndo));
  return done.ok ? 0 : 1;
}

/** The one screen `yokoten trust` shows: each agent, then the way back (#1027). */
function trustScreen(lines: string[], isUndo: boolean): string[] {
  const names = lines.map((line) => /^(?:turned on yokoten's guard in|removed the trust yokoten added in) (.+?)(?: \(|$)/.exec(line)?.[1]).filter((name): name is string => name !== undefined);
  const already = lines.flatMap((line) => /^yokoten's guard is already on in (.+)$/.exec(line)?.[1]?.split(/, | and /) ?? []);
  const problems = lines.filter((line) => !/^(turned on yokoten's guard in|removed the trust yokoten added in|yokoten's guard is already on in|undo: |no agent installed here|nothing to undo)/.test(line));
  const counted = names.length + already.length;
  if (!counted && !problems.length) return title('trust', 'no agent here needs a change');
  const summary = isUndo ? 'the guard is off again in the agents here' : `the guard now runs in ${counted} ${counted === 1 ? 'agent' : 'agents'} here`;
  const out = title('trust', counted ? summary : 'no agent here needs a change');
  out.push('');
  for (const name of names) out.push(...row('ok', isUndo ? 'this folder is no longer trusted' : 'this folder is trusted', name));
  for (const name of already) out.push(...row('ok', 'this folder is already trusted', name));
  // R5: a refusal or a problem is never folded away.
  if (problems.length) {
    if (counted) out.push('');
    for (const line of problems) out.push(...row(/^(left the trust|kept your choice)/.test(line) ? 'note' : 'MISSING', line));
  }
  out.push('');
  out.push(isUndo ? 'To turn it on again: `yokoten trust`' : 'Undo: `yokoten trust --undo`');
  return out;
}

export function runUpdate(invocation: Invocation): number {
  // Its own command, not an init flag: init promises to add only, never to overwrite (#120).
  const options = parse('update', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  const dir = resolve(invocation.cwd, options.positional[0] ?? '.');
  if (!existsSync(dir)) {
    print(invocation, [`yokoten update: ${options.positional[0]} does not exist; nothing to update.`], invocation.stderr);
    return 1;
  }
  const root = requireRoot(invocation, dir);
  if (!root) return 1;
  const isWrite = options.flags.has('--write');
  const { ok, lines } = updateCoreRules(root, { write: isWrite }, invocation.env);
  // --all keeps the whole preview, line by line, for the person who reads it before --write.
  const screen = options.flags.has('--all') ? [`yokoten update: ${lines[0]}`, ...lines.slice(1)] : updateScreen({ ok, lines, isWrite });
  print(invocation, screen, ok ? invocation.stdout : invocation.stderr);
  return ok ? 0 : 1;
}

/** The core rule a diff line belongs to, from the rules table; null for any other line. */
const ruleOf = (line: string): string | null => /^\| (\d+) \|/.exec(line.trim())?.[1] ?? null;

/**
 * The default screen of `yokoten update` (issue #1027): how many core rules changed, one row
 * per rule, and the note that the project's own part stays. A problem is never folded (R5).
 */
export function updateScreen({ ok, lines, isWrite }: { ok: boolean; lines: string[]; isWrite: boolean }): string[] {
  const [first = '', ...rest] = lines;
  // Nothing to do: one line (R8).
  if (/are up to date/.test(first)) return title('update', 'the core rules are up to date, nothing changed');
  // A refusal keeps every word of why and how to fix it, wrapped (R5).
  if (!ok) return [...title('update', 'nothing changed'), '', ...row('MISSING', first)];
  if (isWrite) {
    const kept = /kept as (\S+?);/.exec(first)?.[1];
    return [
      ...title('update', "the core rules in AGENTS.md are this version's now"),
      '',
      ...row('ok', 'AGENTS.md, the core rules', 'rules'),
      ...(kept === undefined ? [] : row('note', `the file before it is kept as ${kept}`, 'backup')),
    ];
  }
  const added = new Set<string>();
  const removed = new Set<string>();
  for (const line of rest) {
    const change = /^([+-]) (.*)$/.exec(line);
    const rule = change?.[2] === undefined ? null : ruleOf(change[2]);
    if (!change || rule === null) continue;
    (change[1] === '+' ? added : removed).add(rule);
  }
  const rules = [...new Set([...added, ...removed])].sort((a, b) => Number(a) - Number(b));
  if (!rules.length) {
    return [...title('update', 'the core rules changed upstream'), '', ...row('note', 'the change is outside the rules table; `yokoten update --write` writes it'), '', ...nextLine('yokoten update --write')];
  }
  const rows = rules.flatMap((rule) => row('next', added.has(rule) && removed.has(rule) ? 'wording changed' : added.has(rule) ? 'new' : 'removed', `rule ${rule}`));
  return [
    ...title('update', `${count(rules.length, 'core rule')} changed upstream`),
    '',
    ...rows,
    '  Your "This project" part stays as it is.',
    '',
    ...nextLine('yokoten update --write'),
  ];
}

/**
 * Ask one question on the terminal and read one line back, or null at end of input. Install
 * is synchronous, so it reads stdin a byte at a time; it is used only when stdin is a terminal.
 */
const askOnTerminal = (stdout: Output, fd: number): Ask => (question) => {
  stdout.write(`${question} `);
  const byte = Buffer.alloc(1);
  const bytes: number[] = [];
  for (;;) {
    let count: number;
    try {
      count = readSync(fd, byte, 0, 1, null);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EAGAIN') continue;
      return null;
    }
    if (count === 0) return bytes.length ? Buffer.from(bytes).toString('utf8') : null;
    if (byte[0] === 10) return Buffer.from(bytes).toString('utf8').replace(/\r$/, '');
    bytes.push(byte[0]);
  }
};

export function runInstall(invocation: Invocation): number {
  const options = parse('install', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  // The PATH and mailmap questions need someone to answer them: never in a pipe, a hook or CI (#433).
  const ask = askWhenTerminal(invocation);
  // Before it writes anything, a person reads what will change and answers once (#1027).
  // --yes, an agent and CI go ahead without the question, as before.
  if (ask && !options.flags.has('--yes')) {
    print(invocation, previewLines(invocation.env, true, false));
    if (!isYes(ask(SET_UP_QUESTION))) {
      print(invocation, title('install', 'nothing changed'));
      return 0;
    }
    print(invocation, ['']);
  }
  // gh may reach the network for the login: three seconds at most.
  const done = install(invocation.env, { cwd: invocation.cwd, gh: ghIn(invocation.cwd, invocation.env, 3000), ask, platform: invocation.platform });
  print(invocation, options.flags.has('--list') ? done.lines : installScreen(invocation, done.lines, done.ok));
  return done.ok ? 0 : 1;
}

export function runUninstall(invocation: Invocation): number {
  const options = parse('uninstall', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  const done = uninstall(invocation.env);
  print(invocation, options.flags.has('--list') ? done.lines : uninstallScreen(done.lines, done.ok));
  return done.ok ? 0 : 1;
}

/**
 * A marketplace name as Claude Code writes it. The name comes from the user's own files and,
 * on Windows, reaches a `cmd` line, so anything else is refused, not quoted.
 */
const PLAIN_NAME = /^[A-Za-z0-9._-]+$/;

/** A clone over a slow line takes minutes; ten is a hang. */
const CLAUDE_TIMEOUT = 600_000;

/**
 * A per-process git config for each `claude` call: `insteadOf` sends a `git@github.com:`
 * address over HTTPS. Nothing in the user's own git config changes (#950). The entry goes
 * after the ones the user already set this way (a proxy, a credential helper), so theirs stay.
 * A count that is set but is not a small number is one yokoten can't add to safely: null.
 */
function withHttpsGit(env: Env): Env | null {
  const set = env.GIT_CONFIG_COUNT ?? '';
  if (set !== '' && !/^\d{1,3}$/.test(set)) return null;
  const count = set === '' ? 0 : Number(set);
  return {
    ...env,
    GIT_CONFIG_COUNT: String(count + 1),
    [`GIT_CONFIG_KEY_${count}`]: 'url.https://github.com/.insteadOf',
    [`GIT_CONFIG_VALUE_${count}`]: 'git@github.com:',
  };
}

/** A step's own line: the result first, then what it did. */
const ok = (text: string): string => `ok      ${text}`;
const failed = (text: string): string => `failed  ${text}`;

/** What `yokoten upgrade` did: its lines, and whether every step worked. */
export interface UpgradeDone {
  ok: boolean;
  lines: string[];
}

/**
 * How to start Claude Code. On Windows the native installer puts only `claude.exe` on the PATH,
 * and an npm install puts `claude.cmd`: the first one found in PATH order wins, `.exe` before
 * `.cmd` in the same folder. An `.exe` runs by itself; a `.cmd` needs the shell, which finds it
 * by its name. With neither found, the shell is asked for `claude.cmd`, as before (#1002).
 */
export function claudeCommand(env: Env, platform: NodeJS.Platform = process.platform): { file: string; shell: boolean } {
  if (platform !== 'win32') return { file: 'claude', shell: false };
  const path = env.PATH ?? env.Path ?? '';
  for (const dir of path.split(';').filter(Boolean)) {
    const exe = join(dir, 'claude.exe');
    if (existsSync(exe)) return { file: exe, shell: false };
    if (existsSync(join(dir, 'claude.cmd'))) return { file: 'claude.cmd', shell: true };
  }
  return { file: 'claude.cmd', shell: true };
}

/**
 * Runs `claude <args>` with `env`. A failure keeps the last line it said, so the user reads
 * Claude Code's own words, and the command to run by hand for the rest. Every word is a fixed
 * one or a name PLAIN_NAME passed, so the Windows shell line holds nothing it reads.
 */
function runClaude(args: string[], env: Env, platform: NodeJS.Platform): { ok: boolean; said: string } {
  const { file, shell } = claudeCommand(env, platform);
  const result = spawnSync(file, args, { env, encoding: 'utf8', windowsHide: true, shell, timeout: CLAUDE_TIMEOUT });
  if (result.error) return { ok: false, said: result.error.message };
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  const said = output.split('\n').map((line) => line.trim()).filter(Boolean).at(-1) ?? '';
  return { ok: result.status === 0, said };
}

/**
 * Brings the yokoten plugin to the newest version: the marketplace, then the plugin, with git
 * told to fetch github.com over HTTPS for these calls. It adds and removes nothing, so a
 * failed step leaves the plugin as it was (#950). Without the plugin it names the one command
 * that installs the newest yokoten and runs nothing.
 */
export function upgrade(env: Env, platform: NodeJS.Platform = process.platform): UpgradeDone {
  const plugin = enabledPlugin(env);
  if (plugin === null) {
    return {
      ok: true,
      lines: [
        'yokoten upgrade: yokoten is not a Claude Code plugin here, so there is no plugin to update.',
        'To get the newest yokoten, run: npx yokoten@latest',
      ],
    };
  }
  const name = plugin.marketplace;
  // Both checks come before the first call: a refusal changes nothing.
  if (!PLAIN_NAME.test(name)) {
    return { ok: false, lines: [`yokoten upgrade: the marketplace name in your settings is not a plain name, so yokoten runs nothing. Update by hand: claude plugin update ${plugin.id}`] };
  }
  const httpsEnv = withHttpsGit(env);
  if (httpsEnv === null) {
    return { ok: false, lines: ['yokoten upgrade: GIT_CONFIG_COUNT is set, but not to a small number, so yokoten can\'t add its HTTPS setting after yours. It runs nothing. Unset GIT_CONFIG_COUNT, or fix it, and run it again.'] };
  }
  const lines = [`yokoten upgrade: the yokoten plugin is on (${plugin.channel} channel).`];
  // Each step says one line. A failed step stops the rest: the next one needs it.
  const step = (label: string, args: string[]): boolean => {
    const done = runClaude(args, httpsEnv, platform);
    lines.push(done.ok ? ok(label) : failed(label));
    if (done.ok) return true;
    if (done.said) lines.push(`  ${done.said}`);
    lines.push(`To see the whole message, run this by hand: claude ${args.join(' ')}`);
    return false;
  };
  if (!step(`updated the marketplace ${name}`, ['plugin', 'marketplace', 'update', name])) return { ok: false, lines };
  if (!step(`updated the plugin ${plugin.id}`, ['plugin', 'update', plugin.id])) return { ok: false, lines };
  lines.push('Restart Claude Code to load it: a session that is already running keeps the old copy until it restarts.');
  return { ok: true, lines };
}

export function runUpgrade(invocation: Invocation): number {
  const options = parse('upgrade', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  const done = upgrade(invocation.env);
  // A failed step is never folded: its own lines and the command to type by hand (#1027).
  if (!done.ok) {
    print(invocation, done.lines, invocation.stderr);
    return 1;
  }
  const steps = done.lines.filter((line) => /^ok /.test(line));
  if (!steps.length) {
    print(invocation, [...title('upgrade', 'yokoten is not a Claude Code plugin here'), '', ...row('note', 'there is no plugin to update; nothing was changed'), '', ...nextLine('npx yokoten@latest')]);
    return 0;
  }
  print(invocation, [...title('upgrade', 'the yokoten plugin is up to date'), '', ...row('ok', 'updated', 'plugin'), '', ...nextLine('restart Claude Code to use it')]);
  return 0;
}
