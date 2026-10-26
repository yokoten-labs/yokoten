// ---- Programs and processes on each system (record 0040) ----
//
// What a command that starts another program needs, written once with the system
// passed in, so Linux CI tests every system's case:
// - find a program on PATH as that system's shell would (Windows tries PATHEXT);
// - start it with no shell between, so no word of the command is read twice;
// - end it and every program it started;
// - read what a program prints, or start one and let it go (the kanban area, #1091).
// Nothing here reads process.platform: the entry point passes the system down.

import { execFileSync, spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { posix, win32 } from 'node:path';

type Env = Record<string, string | undefined>;

/**
 * The extensions a system tries after a command name. Windows reads PATHEXT (`.CMD` and
 * `.EXE` are the usual ones); every other system runs the name as it is.
 */
export function programExtensions(platform: NodeJS.Platform, env: Env): string[] {
  if (platform !== 'win32') return [''];
  return ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map((extension) => extension.trim()).filter(Boolean)];
}

/** Whether `path` is a file; a test passes its own. */
const isFileOnDisk = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/**
 * The file a command name runs, found on `path` like the system's shell would, or null.
 * A name with a separator is taken as a path. The separator, the list delimiter and the
 * extensions are the system's, not this machine's.
 */
export function findProgram(name: string, path: string | undefined, platform: NodeJS.Platform, env: Env = {}, isFile: (path: string) => boolean = isFileOnDisk): string | null {
  const paths = platform === 'win32' ? win32 : posix;
  const extensions = programExtensions(platform, env);
  if (name.includes('/') || (platform === 'win32' && name.includes('\\'))) {
    const file = paths.resolve(name);
    return extensions.map((extension) => file + extension).find(isFile) ?? null;
  }
  for (const folder of (path ?? '').split(paths.delimiter)) {
    if (!paths.isAbsolute(folder)) continue;
    for (const extension of extensions) {
      const file = paths.join(folder, name + extension);
      if (isFile(file)) return file;
    }
  }
  return null;
}

/** How a program is started: never through a shell. */
export interface StartOptions {
  shell: false;
  /** On Linux and macOS, its own process group, so the whole tree can be ended at once. */
  detached: boolean;
  /** On Windows, no new console window. */
  windowsHide: boolean;
}

/**
 * The spawn options for a program on `platform`. `group` gives it its own process group
 * on Linux and macOS. Leave it off for a program that reads the terminal: a program in
 * another group is stopped when it reads the terminal.
 */
export function startOptions(platform: NodeJS.Platform, group: boolean): StartOptions {
  return { shell: false, detached: platform !== 'win32' && group, windowsHide: platform === 'win32' };
}

/** What ending a tree runs: a signal to a process or a group, or a program. */
export type TreeKill = { kind: 'signal'; pid: number; signal: NodeJS.Signals } | { kind: 'run'; file: string; args: string[] };

/**
 * How to end `pid` and what it started, on `platform`. On Linux and macOS a program
 * started in its own group (`group`) gets the signal on the whole group (a negative pid);
 * otherwise only itself, and it passes the signal on. On Windows `taskkill /T` ends the tree.
 */
export function treeKill(pid: number, signal: NodeJS.Signals, platform: NodeJS.Platform, group: boolean): TreeKill {
  if (platform === 'win32') return { kind: 'run', file: 'taskkill', args: ['/PID', String(pid), '/T', '/F'] };
  return { kind: 'signal', pid: group ? -pid : pid, signal };
}

/**
 * What `file` prints, run with `args` in `cwd` and no shell between. Its input and its
 * errors are not read. Throws when it fails, or when it runs past `timeout` ms.
 */
export function readProgram(file: string, args: string[], { cwd, env, timeout }: { cwd: string; env: Env; timeout?: number }): string {
  return execFileSync(file, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout, shell: false });
}

/**
 * Start `file` on its own, with no shell, and never wait for it or fail: a program that
 * cannot start is let go. For a program the user looks at, such as a browser.
 */
export function startAndLetGo(file: string, args: string[], env: Env): void {
  try {
    const child = spawn(file, args, { detached: true, stdio: 'ignore', env, shell: false });
    child.on('error', () => {});
    child.unref();
  } catch {
    // Nothing to start: the caller has said how to try again.
  }
}
