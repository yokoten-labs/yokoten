// The home folder, one topic of the privacy rule (#627). The CLI fills it in once, and every
// rule reads it from the env it is given, never from the process.

import { homedir, userInfo } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { Env } from '../config.ts';

/** Where the system says the home folder is, with no $HOME: the password file. Empty when it can't tell. */
export const systemHome = (): string => {
  try {
    return homedir() || userInfo().homedir || '';
  } catch {
    return '';
  }
};

/**
 * The home folder from the password database, never from `$HOME` (#739). `homedir()` follows
 * `$HOME`, so a command that changes `HOME` would hide this folder. Empty when it can't tell.
 */
function passwordHome(): string {
  try {
    const home = userInfo().homedir;
    return home && isAbsolute(home) ? home : '';
  } catch {
    return '';
  }
}

// One slot on the process, so a vendored copy of this file (a project's .yokoten/) sees the
// same stand-in as the copy the tests load (#739). A test sets it; production leaves it empty.
const REAL_HOME = Symbol.for('yokoten.readRealHome');
type RealHomeGlobal = typeof globalThis & { [REAL_HOME]?: () => string };

/** The read of the real home: a test's stand-in, or the password database. */
export function realHomeRead(): () => string {
  return (globalThis as RealHomeGlobal)[REAL_HOME] ?? passwordHome;
}

/** A test points the real-home read at a stand-in. The returned function puts the previous read back. */
export function useRealHome(read: () => string): () => void {
  const holder = globalThis as RealHomeGlobal;
  const previous = holder[REAL_HOME];
  holder[REAL_HOME] = read;
  return () => {
    if (previous === undefined) delete holder[REAL_HOME];
    else holder[REAL_HOME] = previous;
  };
}

/**
 * The home folder: `$HOME` when it is an absolute path. Null when it is not (#392): then
 * there is no place outside the repo, and a relative `.config` would land in the folder
 * the command runs in. Only the CLI entry fills HOME from the system (withHome, #356).
 * The marks reader still reads the real home when `$HOME` is missing (#739).
 */
export function homeOf(env: Env): string | null {
  return env.HOME && isAbsolute(env.HOME) ? env.HOME : null;
}

/** The home folder, as homeOf finds it. With none, it throws NO_HOME. */
export function homeIn(env: Env): string {
  const home = homeOf(env);
  if (!home) throw new Error(NO_HOME);
  return home;
}

/**
 * The CLI's environment: `env` with HOME from the system when HOME is empty or not a full
 * path (#392). The one place yokoten falls back to the system's home (#356); everything
 * else reads HOME from the env it is given.
 */
export function withHome(env: Env, system: () => string = systemHome): Env {
  if (homeOf(env)) return env;
  const home = system();
  return home && isAbsolute(home) ? { ...env, HOME: home } : env;
}

/** Thrown when there is no home folder, so nothing outside the repo can be read or written. */
export const NO_HOME = 'yokoten finds no home folder (HOME is empty or not a full path), so it has no place outside the repo';

// ---- Config folders a variable moves (#988) ----
//
// A tool's config folder can move: CLAUDE_CONFIG_DIR, CODEX_HOME, XDG_CONFIG_HOME. yokoten
// reads and writes where the tool itself looks, so a hook lands in the file the tool reads.
// A value that is not a full path is ignored and the default is used, as the XDG spec says:
// a relative folder would land in the folder the command runs in.

/** The folder `$name` names when it is a full path; else null. */
export function envFolder(env: Env, name: string): string | null {
  const value = env[name];
  return value && isAbsolute(value) ? value : null;
}

/** `$name` when it is a full path, else `parts` under the home folder. Null with neither. */
export function folderOf(env: Env, name: string, ...parts: string[]): string | null {
  const named = envFolder(env, name);
  if (named) return named;
  const home = homeOf(env);
  return home ? join(home, ...parts) : null;
}

/** As folderOf; with neither it throws NO_HOME, so nothing is written. */
export function folderIn(env: Env, name: string, ...parts: string[]): string {
  const folder = folderOf(env, name, ...parts);
  if (!folder) throw new Error(NO_HOME);
  return folder;
}

/** The user's config folder: `$XDG_CONFIG_HOME` when it is a full path, else `.config` in the home folder. Null with neither. */
export const configHomeOf = (env: Env): string | null => folderOf(env, 'XDG_CONFIG_HOME', '.config');
/** As configHomeOf; with neither it throws NO_HOME. */
export const configHomeIn = (env: Env): string => folderIn(env, 'XDG_CONFIG_HOME', '.config');
/** A path in the config folder as the user would type it: `$XDG_CONFIG_HOME/rest` when that is used, else `~/.config/rest`. */
export const configHomeShown = (env: Env, rest: string): string => `${envFolder(env, 'XDG_CONFIG_HOME') ? '$XDG_CONFIG_HOME' : '~/.config'}/${rest}`;

// ---- A Windows home that bash ran together (#1017) ----

/**
 * The forms a Windows home takes when bash reads it unquoted and drops each backslash:
 * `C:\Users\name` becomes `C:Usersname`, or `Usersname` without the drive. Only a drive
 * path with two or more folders under the drive has them, so `C:` or `C:\Users` alone
 * gives none. A POSIX home gives none either: bash keeps `/`. Each form comes with the
 * path it stands for, with `\` between its folders. A pure function of the path.
 */
export function gluedHomes(home: string | undefined): { glued: string; path: string }[] {
  const drive = home ? /^([A-Za-z]:)[\\/](.*)$/.exec(home) : null;
  if (!drive) return [];
  const parts = drive[2].split(/[\\/]+/).filter(Boolean);
  if (parts.length < 2) return [];
  const joined = parts.join('');
  const path = `\\${parts.join('\\')}`;
  return [
    { glued: `${drive[1]}${joined}`, path: `${drive[1]}${path}` },
    { glued: joined, path },
  ];
}

// ---- Account names that name nobody ----

/**
 * Account names that every machine of a kind has (a CI runner, a container, a cloud VM).
 * They name nobody, and hiding them would hide common words such as "root" and "test".
 */
export const SHARED_ACCOUNTS: ReadonlySet<string> = new Set([
  ...['root', 'runner', 'user', 'users', 'admin', 'administrator', 'guest', 'nobody', 'temp', 'dev', 'test', 'app', 'build'],
  ...['ubuntu', 'debian', 'node', 'vscode', 'codespace', 'codespaces', 'gitpod', 'vagrant', 'ec2-user', 'jenkins'],
]);
// The folders in a Windows Users folder that are not a person's: shared, system and service accounts.
const WINDOWS_SHARED_FOLDERS = new Set(['public', 'default', 'default user', 'all users', 'wdagutilityaccount', 'temp', 'postgres', 'mysql', 'sshd', 'updatususer', 'wsiaccount', 'defaultapppool']);
const WINDOWS_SHARED_PATTERN = /^(?:defaultuser\d+|.*\.migrated|\.net v.*|classic \.net apppool|mssql.*|\$.*)$/;

/** Whether a folder in a users folder (`/home`, `C:\Users`) is a person's, not a shared, system or service account. */
export const isPersonFolder = (name: string): boolean => !WINDOWS_SHARED_FOLDERS.has(name.toLowerCase()) && !WINDOWS_SHARED_PATTERN.test(name.toLowerCase()) && !SHARED_ACCOUNTS.has(name.toLowerCase());
