// One desk for every worker, whatever the vendor (#637). A desk is a folder (the worker's
// own clone) and a fence around the agent that works in it. The fence is one contract,
// the same for Claude Code, Codex (and DeepSeek through it), Grok and Muse:
//
// 1. The desk folder, `.git` included, and the desk's own state folder for the agent are
//    writable. The lead's state folder (~/.claude, ~/.codex...) is never shown: the desk
//    gets a fresh one next to it, `<desk>.state/<agent>`, with only the login file copied.
//    `.git/config` and `.git/hooks` stay read-only, so the lead never runs a worker's.
// 2. Everything else the agent can see is read-only.
// 3. The owner's other projects and home are not visible: only what the agent needs to
//    run (Node, its own program, yokoten's runtime) is shown again, read-only.
// 4. Child processes work, with pipes (tests start programs).
// 5. Commands have no network. The agent reaches only its model's API hosts, through
//    the proxy in network/proxy.ts, which runs outside.
// 6. YOKOTEN_ROLE=worker and TZ=UTC are set, and no token or key is passed in (agent-env.ts).
// 7. On a team (#674), the team folder is read-only and only the agent's own outbox in it
//    is writable, so no agent writes, changes or deletes another's messages. The file
//    `.git/yokoten-desk.json`, which names the agent, is locked, and YOKOTEN_DESK and
//    YOKOTEN_TEAM say where the agent is (team/who.ts).
// 8. The agent starts with its own sandbox off, by a flag for this one run (#1171): it
//    can't start inside the fence, and the fence is the sandbox. No config file changes.
//
// This file turns a request into a `DeskPlan`: plain lists of paths, hosts and names. A
// backend per system turns the plan into a command: fence/srt.ts (sandbox-runtime) on Linux,
// WSL2 and macOS, or with YOKOTEN_FENCE=own the old fence/bwrap.ts on Linux and WSL2 and
// fence/seatbelt.ts on macOS. Native Windows has no backend (use WSL), but its plan is built
// here: no case in a path, every profile folder and other drive hidden, and a command
// found with PATHEXT. Those rules stay testable on every system.

import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Env } from '../../rules/config.ts';
import { homeIn } from '../../rules/privacy.ts';
import { isPathInside } from '../../platform/paths.ts';
import { findProgram, programExtensions } from '../../platform/process.ts';
import { DESK as CLAUDE_CODE } from '../runtimes/claude-code.ts';
import { DESK as CODEX } from '../runtimes/codex.ts';
import { DESK as GROK } from '../runtimes/grok.ts';
import { DESK as MUSE } from '../runtimes/muse.ts';
import { buildAgentEnv } from './agent-env.ts';
import { DESK_FILE, modelOf, prepareDeskTeam, vendorOf } from './team/team.ts';

/** What a runtime's own file tells the desk: where its state is, how to move it, and its API hosts. */
export interface RuntimeDesk {
  /** The lead's own state folders and files for this agent. Never shown in a desk. */
  leadState: (env: Env) => string[];
  /** The login files to copy from the lead's state into the desk's: `to` is relative to the desk's state folder. */
  login: (env: Env) => { from: string; to: string }[];
  /** Files to write in a new desk state folder, relative to it, when they are missing. */
  starter?: Readonly<Record<string, string>>;
  /** The names that point the agent at the desk's state folder. */
  stateEnv: (state: string) => Record<string, string>;
  /** Parts of the agent's install that sit in its state folder, shown read-only. */
  programParts?: (env: Env) => string[];
  /** The API hosts the agent program may reach, on port 443. */
  hosts: readonly string[];
  /** The model and provider the agent's own config names (#748), or null when it names none. */
  identity?: (env: Env) => { model: string; provider: string } | null;
  /**
   * How the agent starts with its own sandbox off, for this one run (#1171). Its own sandbox
   * can't start inside the desk's fence, and the fence holds the whole agent instead.
   * `program` is the agent's program name. `turnOff` adds the per-run flag to a command that
   * starts it, never a config file, or says why it can't: the desk then does not start.
   */
  ownSandbox: { program: string; turnOff: (command: readonly string[]) => string[] | { fail: string } };
}

/** The runtimes a desk can start, by the name `--agent` takes elsewhere. DeepSeek runs through Codex. */
export const DESK_RUNTIMES: Readonly<Record<string, RuntimeDesk>> = {
  'claude-code': CLAUDE_CODE,
  codex: CODEX,
  grok: GROK,
  muse: MUSE,
};

/** The contract for one desk, as plain data. Every path is absolute. */
export interface DeskPlan {
  /** The desk folder: the worker's own clone. Writable. */
  desk: string;
  /** The agent's state folders and files. Writable. */
  state: string[];
  /** Folders and files shown again, read-only, inside the hidden ones. */
  readable: string[];
  /** Folders that are not visible at all: home folders, other drives, the desk's parent folder. */
  hidden: string[];
  /** Files and folders inside a writable folder that stay read-only: `.git/config`, `.git/hooks`, the worker mark. */
  locked: string[];
  /** The hosts the proxy lets the agent reach. */
  hosts: string[];
  /** The agent's environment. The backend adds the proxy names. */
  env: Record<string, string>;
  /** The agent command and its words. */
  command: string[];
  /** Whether the command starts the agent, so its own sandbox is off for this run (#1171). */
  isOwnSandboxOff: boolean;
}

/** What a desk request gives: the folder, the agent, its command, and the lead's few choices. */
export interface DeskRequest {
  runtime: string;
  desk: string;
  command: string[];
  env: Env;
  /** Extra paths to show read-only (`--read`). */
  extraReadable?: string[];
  /** Extra API hosts (`--host`), for example a DeepSeek host for Codex. */
  extraHosts?: string[];
  /** yokoten runtime folders to show read-only: this copy and the installed one. */
  runtimes?: string[];
  /** The private-marks file, shown read-only only when the lead asks (`--marks`). Off by default until #665. */
  marks?: string;
  /** The system the plan is for: its hidden folders differ. */
  platform?: NodeJS.Platform;
  /** The team the agent joins (#674): the team folder, and the agent's name on it. */
  team?: { folder: string; name: string };
  /**
   * Writes the worker mark into the desk clone, as `yokoten worker mark` does from the
   * lead's checkout (#672), and returns the plain reason when it can't. Muse Code passes
   * its hooks no YOKOTEN_ROLE, so in a desk the mark is what makes it a worker.
   */
  markDesk: (desk: string) => { fail: string } | { top: string };
}

/** The parts of this yokoten that run in a desk: the guard, the commit check and the bridge. */
const OWN_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const OWN_RUNTIME = ['bin', 'src', 'kit', 'dist', 'package.json'].map((part) => join(OWN_ROOT, part));

/** Windows, and the names its plan needs: the drive letters to hide and the folder of the profiles. */
const WINDOWS_PLATFORM: NodeJS.Platform = 'win32';
const WINDOWS_DRIVES = 'CDEFGHIJKLMNOPQRSTUVWXYZ';
const WINDOWS_PROFILES = 'Users';

/**
 * Whether `path` is `folder` or inside it. Windows names folders without case, so the
 * comparison there ignores case; a system that keeps case compares it as written.
 */
export const isInside = isPathInside;

/** The real path, or the path itself when it is not there. */
function realOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The real path, or null when it can't be resolved. */
function realOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * A PATH the fence can walk (#1181). Each entry becomes its real path and stays unless it
 * is inside a `hidden` folder and in none of `shown`, by whole path segments (`/a/b` never
 * admits `/a/bc`). Order is kept and a repeat is dropped. An entry that is relative, empty
 * or can't be resolved is dropped too: fail closed.
 *
 * Why: Seatbelt (macOS) answers a walk into a hidden folder with EPERM, not ENOENT. A
 * program search (libuv's, like execvp) moves on past ENOENT, EACCES and ENOTDIR but stops
 * at EPERM, so one PATH folder linked into the hidden home, before git's folder, broke
 * every program started by name. The agent program is found before this, with the full
 * PATH, and its folder is readable, so it stays.
 */
export function walkablePath(path: string, hidden: readonly string[], shown: readonly string[], platform: NodeJS.Platform, real: (path: string) => string | null = realOrNull): string {
  const isWindows = platform === WINDOWS_PLATFORM;
  const delimiter = isWindows ? ';' : ':';
  const isAbsolute = isWindows ? win32.isAbsolute : (entry: string) => entry.startsWith('/');
  const realFolders = (folders: readonly string[]) => folders.map((folder) => real(folder) ?? folder);
  const [hide, show] = [realFolders(hidden), realFolders(shown)];
  const kept: string[] = [];
  for (const entry of path.split(delimiter)) {
    if (!isAbsolute(entry)) continue;
    const resolved = real(entry);
    if (resolved === null || kept.includes(resolved)) continue;
    const isHidden = hide.some((folder) => isInside(resolved, folder, platform)) && !show.some((folder) => isInside(resolved, folder, platform));
    if (!isHidden) kept.push(resolved);
  }
  return kept.join(delimiter);
}

/** Whether `path` is a link, even one that points nowhere. */
function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

// Finding a program is the platform layer's: the system is passed in (record 0040).
export { findProgram, programExtensions };

/**
 * The folders a program needs to run: the folder it is named from, and the package or
 * folder its real file sits in. A Node program's real file is deep in its package, so
 * the nearest folder with a package.json is taken; a binary's own folder otherwise.
 */
export function programFolders(file: string): string[] {
  const real = realOr(file);
  let folder = dirname(real);
  for (let at = folder; at !== dirname(at); at = dirname(at)) {
    if (existsSync(join(at, 'package.json'))) {
      folder = at;
      break;
    }
  }
  return [dirname(file), folder];
}

/**
 * The folders that are never shown: every home, other drives and mounts, and the desk's
 * parent folder. On Linux also /run, which holds sockets to the host: on WSL2 the one that
 * starts Windows programs outside any fence, the session bus, and Docker's. On Windows the
 * parent of the home folder (`C:\Users`) hides every other profile, and any other drive
 * root is hidden like /Volumes on macOS. The desk's own drive stays walkable: a hidden
 * drive root would be too wide to show the system folders again.
 */
export function hiddenFolders(platform: NodeJS.Platform, home: string, desk: string, exists: (path: string) => boolean = existsSync): string[] {
  if (platform === WINDOWS_PLATFORM) {
    const profileFolder = win32.dirname(home);
    const roots = [home, win32.dirname(desk)];
    if (win32.basename(profileFolder).toLowerCase() === WINDOWS_PROFILES.toLowerCase()) roots.push(profileFolder);
    const ownDrive = win32.parse(desk).root.toLowerCase();
    for (const letter of WINDOWS_DRIVES) {
      const root = `${letter}:\\`;
      if (root.toLowerCase() !== ownDrive) roots.push(root);
    }
    return [...new Set(roots.filter((folder) => exists(folder)))];
  }
  const roots = platform === 'darwin' ? ['/Users', '/Volumes'] : ['/home', '/root', '/mnt', '/media', '/run'];
  return [...new Set([...roots, home, dirname(desk)])].filter((folder) => exists(folder));
}

/** Throw when `path` is a link or not of the kind wanted: a worker could point it at the lead's files. */
function requireReal(path: string, kind: 'folder' | 'file'): void {
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || (kind === 'folder' ? !entry.isDirectory() : !entry.isFile())) {
    throw new Error(`${path} is a link or not a ${kind}. Remove it, then run the desk again.`);
  }
}

/**
 * Make the desk's own state folder for the agent, `<desk>.state/<agent>`, and copy the
 * lead's login file in. Nothing else of the lead's state comes along: no settings, hooks,
 * memory, MCP config, history or sessions. A login file is copied again when the lead's is
 * newer. A link a worker left there is refused, never followed.
 */
export function prepareDeskState(runtime: RuntimeDesk, name: string, desk: string, env: Env): string {
  const root = `${desk}.state`;
  const state = join(root, name);
  mkdirSync(state, { recursive: true });
  requireReal(root, 'folder');
  requireReal(state, 'folder');
  for (const { from, to } of runtime.login(env)) {
    if (!existsSync(from)) continue;
    const target = join(state, to);
    mkdirSync(dirname(target), { recursive: true });
    requireReal(dirname(target), 'folder');
    if (!isLink(target) && existsSync(target) && statSync(target).mtimeMs >= statSync(from).mtimeMs) continue;
    rmSync(target, { force: true });
    copyFileSync(from, target, constants.COPYFILE_EXCL);
  }
  for (const [file, text] of Object.entries(runtime.starter ?? {})) {
    const target = join(state, file);
    if (!existsSync(target)) writeFileSync(target, text, { flag: 'wx' });
  }
  return state;
}

/** Why `desk` can't be a desk, or null: it must be a git clone of its own, not a worktree. */
export function cloneProblem(desk: string): string | null {
  if (!existsSync(join(desk, '.git'))) return `${desk} is not a git clone. Make the desk with \`git clone <repo> <folder>\`.`;
  if (statSync(join(desk, '.git')).isFile()) return `${desk} is a worktree: its git folder lives in another checkout, which the desk hides. Make the desk with \`git clone\`.`;
  return null;
}

/**
 * Turn a request into the desk's plan. It throws, with a reason the lead can act on, when
 * the runtime is unknown, the folder is not a clone, or a path would open a hidden folder.
 */
export function planDesk(request: DeskRequest): DeskPlan {
  const runtime = Object.hasOwn(DESK_RUNTIMES, request.runtime) ? DESK_RUNTIMES[request.runtime] : undefined;
  if (!runtime) throw new Error(`a desk starts ${Object.keys(DESK_RUNTIMES).join(', ')}; not "${request.runtime}". DeepSeek runs through codex.`);
  if (!request.command.length) throw new Error('no agent command after --');
  const { env } = request;
  const platform = request.platform ?? process.platform;
  // Who the agent really is (#748): the agent's own config may name a model of another
  // vendor than the harness's. The command line wins, as the runtime does: `--model X`
  // names the model for the board's roster and for the desk's env alike. The model goes to
  // the board; when the vendor differs, the brief also starts with one line saying so
  // (identity.ts).
  const named = runtime.identity?.(env) ?? null;
  const asked = modelOf(request.command);
  const model = asked !== 'model not named' && asked.trim() ? asked.trim() : named?.model ?? '';
  const vendor = model ? vendorOf(request.runtime, model, named?.provider) : '';
  const identity = model && vendor !== vendorOf(request.runtime, '') ? { model, vendor } : null;
  const home = realOr(homeIn(env));
  const desk = realOr(resolve(request.desk));
  const notClone = cloneProblem(desk);
  if (notClone) throw new Error(notClone);
  requireReal(join(desk, '.git'), 'folder');
  // The lead's own state is hidden too, where it lives outside the home folder.
  const leadState = runtime.leadState(env).map(realOr).filter((path) => existsSync(path));
  const hidden = [...new Set([...hiddenFolders(platform, home, desk), ...leadState.filter((path) => statSync(path).isDirectory())])];
  // A path the agent may see must not open a whole hidden folder, or the desk itself.
  const isTooWide = (path: string) => hidden.some((folder) => isInside(folder, path, platform)) || isInside(desk, path, platform);
  const program = findProgram(request.command[0], env.PATH, platform, env);
  if (!program) throw new Error(`can't find ${request.command[0]} on PATH`);
  const command = commandWithSandboxOff(runtime, request, platform);
  const node = dirname(dirname(realOr(process.execPath)));
  const wanted = [node, ...programFolders(program), ...(runtime.programParts?.(env) ?? []), ...OWN_RUNTIME, ...(request.runtimes ?? []), join(home, '.gitconfig'), join(home, '.config', 'git')];
  if (request.marks) wanted.push(request.marks);
  const readable: string[] = [];
  // Nothing of the lead's state but the program parts the runtime names.
  const parts = (runtime.programParts?.(env) ?? []).map(realOr);
  const isLeadState = (path: string) => leadState.some((folder) => isInside(path, folder, platform) || isInside(folder, path, platform)) && !parts.some((part) => isInside(path, part, platform));
  for (const path of wanted.map(realOr)) {
    if (!existsSync(path) || isTooWide(path) || isLeadState(path) || readable.includes(path)) continue;
    readable.push(path);
  }
  for (const path of request.extraReadable ?? []) {
    const real = realOr(resolve(path));
    if (!existsSync(real)) throw new Error(`--read ${path}: not there`);
    if (isTooWide(real)) throw new Error(`--read ${path} would open a hidden folder or the whole system`);
    if (isLeadState(real)) throw new Error(`--read ${path} would show the lead's own ${request.runtime} state`);
    if (!readable.includes(real)) readable.push(real);
  }
  // The worker mark first, so it is locked with the rest; a desk that can't be marked doesn't start.
  const marked = request.markDesk(desk);
  if ('fail' in marked) throw new Error(`can't mark the desk as a worker's: ${marked.fail}`);
  if (!existsSync(join(desk, '.git', 'yokoten-worker'))) throw new Error(`can't mark the desk as a worker's: no mark in ${join(desk, '.git')}`);
  // Git's config and hooks, and the worker mark, stay read-only: a worker can't plant a
  // hook or an alias that the lead would run later. A link there is refused.
  const locked: string[] = [];
  for (const [part, kind] of [['config', 'file'], ['hooks', 'folder'], ['yokoten-worker', 'file']] as const) {
    const path = join(desk, '.git', part);
    if (!existsSync(path) && !isLink(path)) continue;
    requireReal(path, kind);
    locked.push(path);
  }
  const state = prepareDeskState(runtime, request.runtime, desk, env);
  // The team (#674): its folder read-only, the agent's own outbox writable, and the desk file that names the agent locked.
  const writable = [state];
  const teamEnv: Env = {};
  rmSync(join(desk, '.git', DESK_FILE), { force: true });
  if (request.team) {
    const folder = realOr(resolve(request.team.folder));
    if (isTooWide(folder) || isInside(desk, folder, platform) || isInside(folder, desk, platform)) throw new Error(`the team folder ${folder} would open a hidden folder or the desk`);
    const team = prepareDeskTeam({ team: folder, name: request.team.name, runtime: request.runtime, model: model || 'model not named', desk });
    if (!readable.includes(team.readable)) readable.push(team.readable);
    writable.push(team.writable);
    locked.push(team.locked);
    // Who the agent is (team/who.ts): the lead's own env never has these.
    Object.assign(teamEnv, { YOKOTEN_DESK: desk, YOKOTEN_TEAM: folder });
  }
  // Every backend gets a PATH without hidden folders (#1181); Seatbelt cuts it further.
  const path = env.PATH === undefined ? {} : { PATH: walkablePath(env.PATH, hidden, [desk, ...writable, ...readable], platform) };
  return {
    desk,
    state: writable,
    readable,
    hidden,
    locked,
    hosts: [...new Set([...runtime.hosts, ...(request.extraHosts ?? [])])],
    env: { ...buildAgentEnv(env, { runtime: request.runtime, set: { YOKOTEN_ROLE: 'worker', ...teamEnv, ...(model ? { YOKOTEN_MODEL: model } : {}), ...(identity ? { YOKOTEN_VENDOR: identity.vendor } : {}) } }), ...path, ...runtime.stateEnv(state), TZ: 'UTC' },
    command: command ?? request.command,
    isOwnSandboxOff: command !== null,
  };
}

/** Whether `word`, a command's first word, names `program`: by its file name, with an extension on Windows. */
export function isProgramNamed(word: string, program: string, platform: NodeJS.Platform, env: Env): boolean {
  const isWindows = platform === WINDOWS_PLATFORM;
  const name = isWindows ? win32.basename(word).toLowerCase() : basename(word);
  return programExtensions(platform, env).some((extension) => name === (isWindows ? `${program}${extension}`.toLowerCase() : `${program}${extension}`));
}

/**
 * The command with the agent's own sandbox off for this run (#1171), or null when the
 * command does not start the agent (git, the tests). It throws when the runtime can't
 * turn its sandbox off for this command: the desk then does not start (fail closed).
 */
function commandWithSandboxOff(runtime: RuntimeDesk, request: DeskRequest, platform: NodeJS.Platform): string[] | null {
  if (!isProgramNamed(request.command[0], runtime.ownSandbox.program, platform, request.env)) return null;
  const turned = runtime.ownSandbox.turnOff(request.command);
  if (!Array.isArray(turned)) throw new Error(`can't start ${runtime.ownSandbox.program} with its own sandbox off: ${turned.fail}`);
  return turned;
}

/** The names that point an agent at the proxy. Upper and lower case: programs read either. */
export function proxyEnv(url: string): Record<string, string> {
  const names = ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY'];
  // NODE_USE_ENV_PROXY: Node's own fetch reads the names above only with it (Node 22.21 and 24).
  return { ...Object.fromEntries(names.flatMap((name) => [[name, url], [name.toLowerCase(), url]])), NODE_USE_ENV_PROXY: '1', NO_PROXY: '', no_proxy: '' };
}

/** A command that starts the agent inside the fence. */
export interface FencedCommand {
  file: string;
  args: string[];
  env: Record<string, string>;
}

/** One system's way to build the fence. */
export interface DeskBackend {
  /** The name the desk prints, such as `bwrap`. */
  name: string;
  /** Null when the backend can run here; else the reason, in one line. */
  problem: (env: Env) => string | null;
  /** Where the proxy listens outside: a socket path in `scratch`, or a port (0 for any); null when the fence runs its own. */
  proxyAddress: (scratch: string) => string | number | null;
  /** The command that starts `plan` inside the fence, with the proxy at `address` and a private scratch folder. */
  fence: (plan: DeskPlan, address: string | number, scratch: string) => FencedCommand;
}
