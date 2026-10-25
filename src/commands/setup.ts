// `yokoten` with no command, `init`, `update`, `install`, `uninstall` and `upgrade`: they write yokoten into a project or a machine, or bring it up to date.

import { existsSync, readSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ghIn } from '../host/github/index.ts';
import { type Env, loadConfig } from '../rules/config.ts';
import { hideHome, homeOf, NO_HOME } from '../rules/privacy.ts';
import { formatFinding } from '../rules/message.ts';
import { init, trust, undoTrust, updateCoreRules } from '../setup/init.ts';
import { type Ask, agentsHere, install, isMachineSetUp, isYes, launcherDir, skillNames, uninstall } from '../setup/install.ts';
import { readOriginUrl, setUpPlanning } from '../setup/plan.ts';
import { VERSION } from '../setup/files.ts';
import { enabledPlugin } from '../setup/advice/marketplace.ts';
import { type Invocation, moreLine, nextLine, noRootFinding, type Output, parse, print, requireRoot, rootOf, row, title, usage, wrap } from './shared.ts';

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
    print(invocation, [`yokoten: ${formatFinding(missing)}.`, 'A project starts with git: run `git init` here, then `yokoten` again.', 'Run `yokoten help` to see every command.'], invocation.stderr);
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
  const stepResults: boolean[] = [];
  if (isMachineMissing) {
    const done = install(env, { cwd, gh: ghIn(cwd, env, 3000), ask });
    print(invocation, installScreen(invocation, done.lines, done.ok, true));
    stepResults.push(done.ok);
  }
  if (isProjectMissing) {
    if (stepResults.length) print(invocation, ['']);
    const done = init(root, env, undefined, { ask });
    print(invocation, projectScreen(done.lines, done.ok));
    stepResults.push(done.ok);
  }
  // The screen of where the project is now is doctor's, never a copy (#1027).
  if (stepResults.length) print(invocation, ['']);
  const code = await (await import('./advice/doctor.ts')).runDoctor(invocation);
  // The one thing a first run should do next is keep what it wrote.
  if (stepResults.length) {
    print(invocation, ['', ...nextLine('git add -A && git commit -m "chore: add yokoten"')]);
  }
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

/** Why a line is a problem: a step that failed, never one that found nothing to do. */
const isProblem = (line: string): boolean =>
  /^(couldn't|kept the Claude Code hooks)/.test(line) || (/^skipped /.test(line) && !/ not found|the global git setting/.test(line));

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
    if (fix) out.push(...wrap(ROW_TEXT_INDENT, `to turn it on: \`${fix}\``));
  }
  for (const problem of problems) out.push(...row('MISSING', problem));
  return out;
}

/** The one screen `yokoten install` shows, from the report it wrote (#1027). */
function installScreen(invocation: Invocation, lines: string[], ok: boolean, isFirstRun = false): string[] {
  if (ok && !lines.some((line) => CHANGED.test(line))) {
    return [...title('install', 'already set up here, nothing changed'), ...moreLine('`yokoten install --list` names every file')];
  }
  const out = title(isFirstRun ? VERSION : 'install', isFirstRun ? 'first run: this computer is set up' : ok ? 'this computer is set up' : 'this computer is partly set up');
  out.push('');
  const guarded = guardedAgents(lines);
  out.push(...row('ok', guarded.length ? `on for ${guarded.join(', ')}` : 'on for Claude Code', 'guard'));
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
  if (!lines.some((line) => /^removed /.test(line))) return title('uninstall', 'nothing to remove, nothing changed');
  const skills = new Set(lines.map((line) => /^removed skill ([\w-]+) in /.exec(line)?.[1]).filter(Boolean)).size;
  const agents = lines.filter((line) => /^removed agent /.test(line)).length;
  const hooks = lines.filter((line) => /^removed the .*(doctor|guard|hooks)/.test(line)).length;
  const removed = [skills && `${skills} skill${skills === 1 ? '' : 's'}`, agents && `${agents} agents`, hooks && `${hooks} hooks`].filter(Boolean);
  const out = title('uninstall', ok ? 'removed what install wrote' : 'removed some of what install wrote');
  out.push('');
  if (removed.length) out.push(...row('ok', removed.join(', '), 'removed'));
  if (lines.some((line) => /^kept /.test(line))) out.push(...row('ok', 'your own files, keys and private marks', 'kept'));
  const problems = lines.filter((line) => !/^(removed|nothing to remove|not there|kept|yokoten: cleaned)/.test(line));
  if (problems.length) out.push('', ...problems.flatMap((line) => row('MISSING', line)));
  out.push('');
  out.push(`To install again: \`yokoten install\``);
  return out;
}

/** The project part of the first run: init's report as four rows and a file count (#1027). */
function projectScreen(lines: string[], ok: boolean): string[] {
  const wrote = lines.filter((line) => /^wrote /.test(line));
  const kept = lines.filter((line) => /^kept /.test(line));
  if (ok && !wrote.length) return title('init', 'already set up here, nothing changed');
  const workflows = wrote.filter((line) => /^wrote \.github\/workflows\//.test(line)).length;
  const hasDependabot = wrote.some((line) => /dependabot/.test(line));
  const hasGithubFiles = wrote.some((line) => /templates|CODEOWNERS|pull_request_template/.test(line));
  const agents = lines.filter((line) => /hook in \./.test(line)).length;
  const out = title('init', ok ? 'this project is set up' : 'this project is partly set up');
  out.push('');
  out.push(...row('ok', 'AGENTS.md, the commit check', 'rules'));
  const ci = [workflows && `${workflows} workflows`, hasDependabot && 'Dependabot'].filter(Boolean).join(', ');
  if (ci) out.push(...row('ok', ci, 'CI'));
  if (hasGithubFiles) out.push(...row('ok', 'issue and PR templates, CODEOWNERS', 'GitHub'));
  out.push(...row('ok', `guard for Claude Code${agents > 1 ? ` and ${agents - 1} more` : ''}`, 'agents'));
  out.push(`${ROW_TEXT_INDENT}${wrote.length} files written${kept.length ? `, ${kept.length} of yours kept` : ', none of yours changed'}`);
  const rest = remaining(lines, { isProblemsOnly: true });
  if (rest.length) out.push('', ...rest);
  out.push('');
  out.push(...nextLine('git add -A && git commit -m "chore: add yokoten"'));
  out.push(...moreLine('`yokoten init --list` names every file'));
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
  const done = init(root, invocation.env, undefined, { noCi: options.flags.has('--no-ci'), ask });
  print(invocation, done.lines);
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
  print(invocation, planning.lines, planning.ok && !isRefused ? invocation.stdout : invocation.stderr);
  if (isRefused) print(invocation, ['yokoten init: --github --yes changed nothing on GitHub (the reason is above). The project files are as listed above.'], invocation.stderr);
  return planning.ok && !isRefused && done.ok ? 0 : 1;
}

export function runTrust(invocation: Invocation): number {
  const options = parse('trust', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  // A person turns the guard on (#661): a pipe, a hook or CI has nobody to decide, and an
  // agent that ran the command would change the trust in its user's own settings.
  if (!isAtTerminal(invocation)) {
    print(invocation, [...title('trust', 'a person runs this at a terminal'), '', ...row('note', 'it changes the trust in your own agent settings', 'why'), ...row('note', 'nothing was written'), '', ...nextLine('yokoten trust')], invocation.stderr);
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
  const { ok, lines } = updateCoreRules(root, { write: options.flags.has('--write') }, invocation.env);
  print(invocation, [`yokoten update: ${lines[0]}`, ...lines.slice(1)], ok ? invocation.stdout : invocation.stderr);
  return ok ? 0 : 1;
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
  const done = install(invocation.env, { cwd: invocation.cwd, gh: ghIn(invocation.cwd, invocation.env, 3000), ask });
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
