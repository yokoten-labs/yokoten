// `yokoten` with no command, `init`, `update`, `install`, `uninstall` and `upgrade`: they write yokoten into a project or a machine, or bring it up to date.

import { existsSync, readSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ghIn } from '../host/github/index.ts';
import { type Env, loadConfig } from '../rules/config.ts';
import { homeOf, NO_HOME } from '../rules/privacy.ts';
import { formatFinding } from '../rules/message.ts';
import { init, trust, undoTrust, updateCoreRules } from '../setup/init.ts';
import { type Ask, install, isMachineSetUp, uninstall } from '../setup/install.ts';
import { readOriginUrl, setUpPlanning } from '../setup/plan.ts';
import { enabledPlugin } from '../setup/advice/marketplace.ts';
import { type Invocation, noRootFinding, type Output, parse, print, requireRoot, rootOf, usage } from './shared.ts';

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
    print(invocation, [
      `yokoten: ${formatFinding(missing)}.`,
      'A project starts with git: run `git init` here, then `yokoten` again.',
      'Run `yokoten help` to see every command.',
    ], invocation.stderr);
    return 1;
  }
  // No home folder means no place to install into (#548). Say it the way install does,
  // instead of letting a path throw: a beginner reads one plain line, not a stack trace.
  if (!homeOf(env)) {
    print(invocation, [`${NO_HOME}. Set HOME to your home folder's full path and run \`yokoten\` again.`], invocation.stderr);
    return 1;
  }
  // Each step that ran reports whether it is done: an install that failed is not "Setup is done" (#548).
  const stepResults: boolean[] = [];
  if (!isMachineSetUp(env)) {
    print(invocation, ['yokoten is not installed on this machine yet: installing it once for every project.']);
    const done = install(env, { cwd, gh: ghIn(cwd, env, 3000), ask: askWhenTerminal(invocation) });
    print(invocation, done.lines);
    stepResults.push(done.ok);
  }
  if (!hasProjectRules(root)) {
    print(invocation, ['This project has no yokoten rules yet: adding them now, and never overwriting a file of yours.']);
    const done = init(root, env, undefined, { ask: askWhenTerminal(invocation) });
    print(invocation, done.lines);
    stepResults.push(done.ok);
  }
  // After two reports, a reader needs to know that the road below is the point of it all.
  if (stepResults.length && stepResults.every((isOk) => isOk)) print(invocation, ['Setup is done. Here is where this project is now:']);
  return (await import('./advice/doctor.ts')).runDoctor(invocation);
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
    print(invocation, [
      'yokoten trust: a person runs this at a terminal, because it changes the trust in your own agent settings.',
      'Nothing was written. Run `yokoten trust` in your terminal.',
    ], invocation.stderr);
    return 1;
  }
  const dir = resolve(invocation.cwd, options.positional[0] ?? '.');
  if (!existsSync(dir)) {
    print(invocation, [`yokoten trust: ${options.positional[0]} does not exist; nothing was written.`], invocation.stderr);
    return 1;
  }
  const root = requireRoot(invocation, dir);
  if (!root) return 1;
  const done = options.flags.has('--undo') ? undoTrust(root, invocation.env) : trust(root, invocation.env);
  print(invocation, done.lines);
  return done.ok ? 0 : 1;
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
  // The PATH question needs someone to answer it: never in a pipe, a hook or CI (#433).
  const ask = askWhenTerminal(invocation);
  // gh may reach the network for the login: three seconds at most.
  const done = install(invocation.env, { cwd: invocation.cwd, gh: ghIn(invocation.cwd, invocation.env, 3000), ask });
  print(invocation, done.lines);
  return done.ok ? 0 : 1;
}

export function runUninstall(invocation: Invocation): number {
  const options = parse('uninstall', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  const done = uninstall(invocation.env);
  print(invocation, done.lines);
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
  print(invocation, done.lines, done.ok ? invocation.stdout : invocation.stderr);
  return done.ok ? 0 : 1;
}
