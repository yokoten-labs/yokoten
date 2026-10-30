// The desk fence on Linux and macOS: anthropics/sandbox-runtime (`srt`, Apache-2.0), the
// sandbox Claude Code itself uses (bubblewrap on Linux, Seatbelt on macOS, and a proxy that
// lets through only the allowed hosts). yokoten runs it as a program and ships none of its
// code: `srt` on PATH when it is the pinned version, else the pinned version through `npx`,
// and never an `srt` from the project or the desk (`findSrt`).
// It is never a dependency of the package (the core has none).
//
// - The plan becomes srt's settings file in a pure function, `srtSettings`.
// - Fail closed (record 0040): when srt can't start a sandbox here, the desk does not
//   start, and says why in one line. It never falls back to "no fence".
// - Native Windows has no system fence: the guard alone holds the rules, and the
//   desk says to use WSL.
// - `YOKOTEN_FENCE=own` picks the old backends (bwrap.ts, seatbelt.ts) for a while, in start.ts.

import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, existsSync, mkdtempSync, openSync, readdirSync, readSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { findProgram } from '../../../platform/process.ts';
import type { Env } from '../../../rules/config.ts';
import { homeIn } from '../../../rules/privacy.ts';
import { type DeskBackend, type DeskPlan, hiddenFolders, isInside, OWN_RUNTIME, programFolders, tempEnv } from '../desk.ts';

/** The pinned version. A new one is a code change, checked by the contract test (#637). */
export const SRT_VERSION = '0.0.81';
export const SRT_PACKAGE = '@anthropic-ai/sandbox-runtime';

/** The npx words that run a command with the pinned srt on PATH. */
export const NPX_ARGS = ['--yes', `--package=${SRT_PACKAGE}@${SRT_VERSION}`, '--'];

/** What the desk asks of the fence: the folder it starts in, what it may write, and the hosts it may reach. */
export type FenceSpec = { root: string; writable: string[]; network: string[] };

/** The command to run, which fence holds it, and the one line the desk prints about it. */
export type FencedCommand = { command: string[]; fence: 'system' | 'guard'; notice: string };

/** The parts of a plan srt reads. Every path is absolute and real. */
export type SrtPlan = Pick<DeskPlan, 'desk' | 'state' | 'readable' | 'hidden' | 'locked' | 'hosts'>;

/** A path entry in srt's settings: a pattern when it reads as one, so a path with `*`, `?`, `[` or `{` is marked literal. */
type PathEntry = string | { path: string; literal: true };

/** srt's settings file, the fields yokoten sets. */
export interface SrtSettings {
  network: { allowedDomains: string[]; deniedDomains: string[]; strictAllowlist: true; allowLocalBinding: false };
  filesystem: { denyRead: PathEntry[]; allowRead: PathEntry[]; allowWrite: PathEntry[]; denyWrite: PathEntry[]; allowGitConfig: false };
}

const entry = (path: string): PathEntry => (/[*?[\]{}]/.test(path) ? { path, literal: true } : path);
const entries = (paths: string[]): PathEntry[] => [...new Set(paths)].map(entry);

/**
 * The plan as srt's settings. Reads: everything but the hidden folders, inside which only
 * the desk, its state and the readable paths are shown again. Writes: only the desk and its
 * state; the locked files and `.git/config` stay read-only. Network: only the plan's hosts,
 * and no local port.
 */
export function srtSettings(plan: SrtPlan): SrtSettings {
  return {
    network: { allowedDomains: [...new Set(plan.hosts)], deniedDomains: [], strictAllowlist: true, allowLocalBinding: false },
    filesystem: {
      denyRead: entries(plan.hidden),
      allowRead: entries([plan.desk, ...plan.state, ...plan.readable]),
      allowWrite: entries([plan.desk, ...plan.state]),
      denyWrite: entries(plan.locked),
      allowGitConfig: false,
    },
  };
}

/**
 * The plan with some hidden folders hidden child by child. srt 0.0.81 on Linux shows a
 * readable folder inside a hidden one read-only, over any writable path inside it: a
 * team's own outbox, inside the read-only team folder, could not be written. So a hidden
 * folder that holds such a readable folder is hidden one level down, each child that is not
 * on the way to a shown path. The cost: an entry made there after the desk starts is
 * visible, read-only. A folder `list` can't read (null) stays hidden whole: fail closed.
 * On macOS srt denies by path rule, not by mount, so the plan stays as it is.
 */
export function splitHidden(plan: SrtPlan, list: (folder: string) => string[] | null, platform: NodeJS.Platform): SrtPlan {
  const writable = [plan.desk, ...plan.state];
  const shown = [...writable, ...plan.readable];
  const nests = plan.readable.filter((read) => writable.some((write) => write !== read && isInside(write, read, platform)));
  if (platform !== 'linux' || !nests.length) return plan;
  const hidden: string[] = [];
  const hide = (folder: string) => {
    const names = nests.some((read) => isInside(read, folder, platform)) ? list(folder) : null;
    if (!names) return hidden.push(folder);
    for (const name of names) {
      const child = join(folder, name);
      if (!shown.some((path) => isInside(child, path, platform))) hide(child);
    }
  };
  for (const folder of plan.hidden) hide(folder);
  return { ...plan, hidden: [...new Set(hidden)] };
}

/** The names in a folder, or null when it can't be read. */
const listFolder = (folder: string): string[] | null => {
  try {
    return readdirSync(folder);
  } catch {
    return null;
  }
};

/** Runs a program with no shell and gives its output, or null when it fails. A test passes a table. */
export type RunProgram = (file: string, args: string[]) => string | null;

const runWith = (env: Env, cwd?: string): RunProgram => (file, args) => {
  const ran = spawnSync(file, args, { env, cwd, encoding: 'utf8', timeout: 120_000, shell: false });
  return ran.status === 0 ? ran.stdout : null;
};

/** The one-line refusal when srt can't start here. */
export function srtRefusal(reason: string): string {
  return `the sandbox (sandbox-runtime ${SRT_VERSION}) can't start here: ${reason}. Nothing was started.`;
}

/** The real path, or the path itself when it is not there. */
const realOr = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/** The folder and the git checkout it is in (the nearest folder above with `.git`), real. */
const withCheckout = (folder: string): string[] => {
  const real = realOr(folder);
  for (let at = real; ; at = dirname(at)) {
    if (existsSync(join(at, '.git'))) return [real, at];
    if (dirname(at) === at) return [real];
  }
};

const fencedFolders = (projects: string[]): string[] => projects.flatMap(withCheckout);

/** npx's own cache for one package: `<npm cache>/_npx/<hash>/node_modules/.bin`. */
const NPX_CACHE_BIN = /[\\/]_npx[\\/][0-9a-f]+[\\/]node_modules[\\/]\.bin$/;

/**
 * The PATH folders an srt may come from: absolute, and neither inside `projects` (the desk,
 * the folder the lead runs in, and their git checkouts) nor a `node_modules/.bin`, which a
 * repository fills. With `npx`, npx's own cache for the package is let through too. Each
 * folder is judged by its real path, so a link into a project is caught.
 */
export function trustedPath(path: string | undefined, projects: string[], npx: boolean): string {
  const fenced = fencedFolders(projects);
  const trusted = (entry: string) => {
    if (!isAbsolute(entry)) return false;
    const both = [resolve(entry), realOr(entry)];
    if (both.some((folder) => fenced.some((project) => isInside(folder, project)))) return false;
    if (both.every((folder) => !folder.endsWith(`${sep}node_modules${sep}.bin`))) return true;
    return npx && both.every((folder) => NPX_CACHE_BIN.test(folder));
  };
  return (path ?? '').split(delimiter).filter(trusted).join(delimiter);
}

/**
 * The srt program to start, never one a project put there: the one on a trusted PATH
 * folder (`trustedPath`) when it is the pinned version, else the pinned version through npx,
 * run from an empty folder so no project's packages count, and taken only from npx's own
 * cache. Else the reason, in one line (fail closed). `projects` are the desk and the folder
 * the lead runs in. A candidate is run (`--version`) only after its folder passed.
 */
export function findSrt(env: Env, platform: NodeJS.Platform, projects: string[], run?: RunProgram): string | { problem: string } {
  const safe: Env = { ...env, PATH: trustedPath(env.PATH, projects, false) };
  const away = realpathSync(mkdtempSync(join(tmpdir(), 'yokoten-npx-')));
  try {
    const runs = run ?? runWith(safe, away);
    // The program itself may be a link into a project, from a folder that passed.
    const fenced = fencedFolders(projects);
    const isPinned = (file: string | null): file is string => file !== null && !fenced.some((project) => isInside(realOr(file), project)) && runs(file, ['--version'])?.trim() === SRT_VERSION;
    const onPath = findProgram('srt', safe.PATH, platform, env);
    if (isPinned(onPath)) return onPath;
    const npx = findProgram('npx', safe.PATH, platform, env);
    const npxPath = npx === null ? null : runs(npx, [...NPX_ARGS, 'node', '-e', 'process.stdout.write(process.env.PATH ?? "")']);
    if (npxPath === null) return { problem: srtRefusal(`npx can't get ${SRT_PACKAGE}@${SRT_VERSION}; check the network, or run npm install -g ${SRT_PACKAGE}@${SRT_VERSION}`) };
    const cached = trustedPath(npxPath, projects, true).split(delimiter).filter((folder) => NPX_CACHE_BIN.test(resolve(folder)));
    const fetched = findProgram('srt', cached.join(delimiter), platform, env);
    return isPinned(fetched) ? fetched : { problem: srtRefusal(`npx gave no srt ${SRT_VERSION}`) };
  } finally {
    rmSync(away, { recursive: true, force: true });
  }
}

/** True when `file` is a Node script whose first line asks PATH (or a fixed path) for `node`. */
const isNodeScript = (file: string): boolean => {
  let fd: number | null = null;
  try {
    fd = openSync(file, 'r');
    const head = Buffer.alloc(256);
    const line = head.subarray(0, readSync(fd, head, 0, head.length, 0)).toString('utf8').split('\n')[0] ?? '';
    return /^#!\s*(\/usr\/bin\/env\s+node|\/\S*\/node)\s*$/.test(line);
  } catch {
    return false;
  } finally {
    if (fd !== null) closeSync(fd);
  }
};

/** How srt starts: the program, the words before its own, and its environment. */
export type SrtLaunch = { file: string; args: string[]; env: Env };

/**
 * How to start `srt` so that nothing from a project runs before the fence holds. npm's srt is
 * a Node script (`#!/usr/bin/env node`), so this Node runs it straight and PATH is never asked
 * for `node`. srt finds bwrap, socat and rg on PATH, so its PATH keeps only the trusted
 * folders (`trustedPath`). That PATH is the agent's inside the fence too.
 */
export function srtLaunch(srt: string, env: Env, projects: string[]): SrtLaunch {
  const safe: Env = { ...env, PATH: trustedPath(env.PATH, projects, false) };
  return isNodeScript(srt) ? { file: process.execPath, args: [realOr(srt)], env: safe } : { file: srt, args: [], env: safe };
}

/** Write the settings for `plan` into `folder`, read-only, and return the file. */
function writeSettings(folder: string, name: string, plan: SrtPlan): string {
  const file = join(folder, name);
  writeFileSync(file, `${JSON.stringify(srtSettings(plan), null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o400);
  return file;
}

/**
 * Null when `srt` starts a sandbox here; else the reason in one line. It runs `true` in a
 * sandbox with no network and no writes. srt starts as `srtLaunch` gives, so a program a
 * project planted on PATH never runs here.
 */
export function srtProblem(srt: string, env: Env, settingsFolder: string, projects: string[]): string | null {
  const settings = writeSettings(settingsFolder, 'srt-probe.json', { desk: settingsFolder, state: [], readable: [], hidden: [], locked: [], hosts: [] });
  const launch = srtLaunch(srt, env, projects);
  const tried = spawnSync(launch.file, [...launch.args, '--settings', settings, '--', 'true'], { env: launch.env, encoding: 'utf8', timeout: 120_000, shell: false });
  if (tried.error) return srtRefusal(`can't run ${srt} (${(tried.error as NodeJS.ErrnoException).code ?? tried.error.message})`);
  if (tried.status === 0) return null;
  const said = `${tried.stderr ?? ''}\n${tried.stdout ?? ''}`.split('\n').map((line) => line.trim()).find(Boolean);
  return srtRefusal(said ?? `exit ${tried.status ?? tried.signal}`);
}

/** The one line the desk prints about the fence. */
export function fenceNotice(hosts: string[]): string {
  return `fence  sandbox-runtime ${SRT_VERSION} (Anthropic, Apache-2.0): writes only the desk; reaches ${hosts.join(', ') || 'no host'} only`;
}

const WINDOWS_NOTICE = 'fence  none on native Windows: only the guard holds the rules. Run yokoten in WSL, where the desk has a sandbox.';

/** The plan with srt's own files readable: npx keeps them in the home folder, which is hidden. */
const withSrtFiles = (plan: SrtPlan, srt: string): SrtPlan => ({ ...plan, readable: [...new Set([...plan.readable, ...programFolders(srt)])] });

/**
 * The command that starts `command` in `spec.root` inside the fence. On Linux and macOS it
 * is srt, with a settings file in a new private temp folder; it throws, with one plain line,
 * when srt can't start (fail closed). On native Windows it is the command as it is, under
 * the guard alone, with a notice to use WSL: the desk there starts nothing. `env` is the
 * Invocation's (#475): PATH finds srt, and YOKOTEN_FENCE is read. The command sets srt's
 * own PATH (`srtLaunch`) through `env`, so it is safe whatever environment starts it.
 */
export function fenceCommand(spec: FenceSpec, command: string[], platform: NodeJS.Platform, env: Env): FencedCommand {
  if (platform === 'win32') return { command, fence: 'guard', notice: WINDOWS_NOTICE };
  if (env.YOKOTEN_FENCE === 'own') throw new Error('YOKOTEN_FENCE=own runs only through `yokoten desk <agent> <folder> -- <command>`. Unset it to use sandbox-runtime.');
  const srt = findSrt(env, platform, [spec.root]);
  if (typeof srt !== 'string') throw new Error(srt.problem);
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'yokoten-fence-')));
  const problem = srtProblem(srt, env, folder, [spec.root]);
  if (problem) throw new Error(problem);
  const launch = srtLaunch(srt, env, [spec.root]);
  const setEnv = findProgram('env', launch.env.PATH, platform, env);
  if (!setEnv) throw new Error(srtRefusal('no env program on a trusted PATH folder'));
  const program = findProgram(command[0] ?? '', env.PATH, platform, env);
  const home = homeIn(env);
  const plan: SrtPlan = {
    desk: spec.root,
    state: spec.writable,
    // What a program needs to run: Node, the program's own folders, yokoten's runtime (the guard), and the user's git config.
    readable: [dirname(dirname(process.execPath)), ...(program ? programFolders(program) : []), ...OWN_RUNTIME, join(home, '.gitconfig'), join(home, '.config', 'git')],
    hidden: hiddenFolders(platform, home, spec.root),
    // commondir, gitdir and config.worktree point git at another config: locked too, even before they are there.
    locked: ['config', 'hooks', 'yokoten-worker', 'commondir', 'gitdir', 'config.worktree'].map((part) => join(spec.root, '.git', part)),
    hosts: spec.network,
  };
  const settings = writeSettings(folder, 'srt-settings.json', splitHidden(withSrtFiles(plan, srt), listFolder, platform));
  return { command: [setEnv, `PATH=${launch.env.PATH ?? ''}`, launch.file, ...launch.args, '--settings', settings, '--', ...command], fence: 'system', notice: fenceNotice(spec.network) };
}

/**
 * The host's proxy for srt's own process (#1172): srt 0.0.81 reads HTTPS_PROXY and NO_PROXY
 * from its own environment and chains its allowed tunnels through that proxy; its allowlist
 * is checked first. srt then sets HTTPS_PROXY, https_proxy, NO_PROXY and no_proxy for the
 * agent to itself, so the host's proxy and its password stay outside. It does so only when
 * it runs its proxy, which it does for a plan with hosts: with none, nothing is passed.
 */
export function srtUpstreamEnv(plan: Pick<DeskPlan, 'upstream' | 'hosts'>): Record<string, string> {
  const proxy = plan.upstream?.proxy;
  if (!proxy || !plan.hosts.length) return {};
  const noProxy = proxy.noProxy.join(',');
  return { HTTPS_PROXY: proxy.url, https_proxy: proxy.url, NO_PROXY: noProxy, no_proxy: noProxy };
}

/**
 * The temp names for srt and the agent (#1172). srt sets the agent's TMPDIR to its own
 * CLAUDE_CODE_TMPDIR (else `/tmp/claude`, which may not be there and is read-only inside),
 * so that name is the desk's writable `work` folder, and so are TEMP and TMP. srt's own
 * TMPDIR is `scratch`, the folder `work` is in, which the agent can't write: srt keeps the
 * files it binds into the sandbox there.
 */
export function srtTempEnv(scratch: string, work: string): Record<string, string> {
  return { ...tempEnv(work), TMPDIR: scratch, CLAUDE_CODE_TMPDIR: work };
}

/**
 * The desk backend for start.ts. srt runs its own proxy, so the desk starts none
 * (`proxyAddress` is null), and srt sets the proxy names in the agent's environment.
 * srt starts as `srtLaunch` gives: `projects` are the folders no program may come from.
 * The agent's temp folder is `<scratch>/tmp`, which start.ts makes, writable.
 */
export function srtBackend(srt: string, platform: NodeJS.Platform, projects: string[]): DeskBackend {
  return {
    name: `sandbox-runtime ${SRT_VERSION} (Anthropic, Apache-2.0)`,
    problem: () => null,
    proxyAddress: () => null,
    fence: (plan: DeskPlan, _: string | number, scratch: string) => {
      const launch = srtLaunch(srt, plan.env, projects);
      const work = join(scratch, 'tmp');
      const withWork = { ...plan, state: [...plan.state, work] };
      const settings = writeSettings(scratch, 'srt-settings.json', splitHidden(withSrtFiles(withWork, srt), listFolder, platform));
      return { file: launch.file, args: [...launch.args, '--settings', settings, '--', ...plan.command], env: { ...plan.env, PATH: launch.env.PATH ?? '', ...srtTempEnv(scratch, work), ...srtUpstreamEnv(plan) } };
    },
  };
}
