import { realpathSync } from 'node:fs';
import nodePath, { basename, dirname, posix, resolve, win32 } from 'node:path';
import { tmpdir } from 'node:os';

// ---- Paths on each system (record 0040) ----
//
// The first piece of the platform layer: how a path an agent writes reads on the system the
// command runs on. Claude Code runs Git Bash on Windows, and Git Bash writes `C:\Users\x` as
// `/c/Users/x` and the temp folder as `/tmp`. Node on Windows reads `/c/Users/x` as
// `C:\c\Users\x`, outside every repo, so a guard that took it as written found nothing to
// guard (#1015). The helpers here are pure: the system and the temp folder come from the
// caller, so Linux CI tests the Windows logic.

/**
 * Where a command's paths are read: the system, and the folder Git Bash calls `/tmp`.
 * `realPath`, when given, reads a full path as that system's disk names it (a Windows short
 * name such as `GITHUB~1` as `.github`), so a test gives another system its disk (#1105).
 * Without it the guard reads this disk on this system, and another system's paths as written.
 */
export type PathPlace = { platform: NodeJS.Platform; tmp: string; realPath?: (path: string) => string };

/**
 * This machine's place, for an entry point to pass down. The only read of the system and the
 * temp folder here; nothing below the entry point calls it again.
 */
export function hostPathPlace(): PathPlace {
  return { platform: process.platform, tmp: tmpdir() };
}

/**
 * The real path, through symlinks. git reports the repo root's real path, and a tool may
 * send a path through a symlink (on macOS, /var is /private/var). A file that does not
 * exist yet takes the real path of its nearest existing folder.
 *
 * The system's own call (`realpathSync.native`), because on Windows it also spells each
 * folder by its long name, in its own case: `C:\Users\RUNNER~1` is `C:\Users\runneradmin`,
 * and `GITHUB~1` is `.github`. git reports the long name, so a short name sent by a tool
 * would read as a file outside the repo, or as no lead-only path, and pass (#1095). Node's
 * own loader names the running copy the same way, so init compares with it too (#1109).
 */
export function realPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : resolve(realPath(parent), basename(path));
  }
}

/** Git Bash's drive form, `/c` or `/c/...`, one letter of either case, as `C:\...`; null for any other path. */
export function gitBashDrive(path: string): string | null {
  const drive = /^\/([A-Za-z])(?=\/|$)/.exec(path);
  if (!drive) return null;
  return `${drive[1].toUpperCase()}:\\${path.slice(2).replace(/^\/+/, '').replace(/\//g, '\\')}`;
}

/**
 * A path as the system reads it. On Windows a Git Bash `/c/...` is `C:\...`, and `/tmp/...` is
 * in `tmp`, the folder Git Bash mounts there. Any other path from one `/` (`/usr/x`, `/etc`)
 * is a folder of the Git install that the guard cannot place: null, which the caller reads as
 * unsure and refuses. A device (`/dev/null`, `/dev/stderr`) stays as written: it is no file.
 * A `//` path and every path on other systems are returned unchanged.
 */
export function fromGitBash(path: string, platform: NodeJS.Platform, tmp: string): string | null {
  if (platform !== 'win32' || !path.startsWith('/') || path.startsWith('//')) return path;
  // Git Bash reads `..` from its own root: `/c/../d/x` is `D:\x`, `/dev/../c/x` is `C:\x`.
  const plain = posix.normalize(path);
  const drive = gitBashDrive(plain);
  if (drive !== null) return drive;
  if (plain === '/tmp' || plain.startsWith('/tmp/')) return tmp + plain.slice('/tmp'.length);
  if (plain.startsWith('/dev/')) return plain;
  return null;
}

/**
 * Whether a relative `path` from `folder` climbs past the folder's drive root on Windows.
 * Windows stops at `C:\`, but Git Bash goes on to its own root `/`, so
 * `../../c/x` from `C:\a` is `C:\x` to bash and `C:\c\x` to Node. The caller reads it as
 * unsure. Always false on other systems.
 */
export function climbsPastDrive(folder: string, path: string, platform: NodeJS.Platform): boolean {
  if (platform !== 'win32') return false;
  // The drive (`C:`) is the first part, so the drive root is depth 0.
  let depth = folder.split(/[\\/]+/).filter(Boolean).length - 1;
  for (const part of path.split(/[\\/]+/)) {
    if (part === '..') {
      if (--depth < 0) return true;
    } else if (part !== '' && part !== '.') depth++;
  }
  return false;
}

/** The path functions for `platform`, so a Windows path reads as Windows reads it on any machine. */
export function pathsFor(platform: NodeJS.Platform): typeof posix {
  return platform === 'win32' ? win32 : posix;
}

/** Whether `platform` reads paths as this machine does, so its paths can be looked up on this disk. */
export function isHostPaths(platform: NodeJS.Platform): boolean {
  return pathsFor(platform) === nodePath;
}

// ---- Comparing full paths (#1095) ----
//
// Two full paths, each already read through the guard's `realPath`, name the same place when
// they match as the system compares names. Windows ignores case and reads `/` as `\`, so a
// comparison there folds both; a system that keeps case compares them as written. Every check
// that stores or compares a real path goes through these two, so no caller folds its own way.

/** A full path as `platform` compares it: on Windows, `\` separators and lower case. */
function comparable(path: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? path.replace(/\//g, '\\').toLowerCase() : path;
}

/** Whether `a` and `b` name the same place on `platform`. */
export function isSamePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return comparable(a, platform) === comparable(b, platform);
}

/** Whether `path` is `folder` or inside it, on `platform`. */
export function isPathInside(path: string, folder: string, platform: NodeJS.Platform = process.platform): boolean {
  const { sep } = pathsFor(platform);
  const inner = comparable(path, platform);
  const outer = comparable(folder, platform);
  return inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : outer + sep);
}

// ---- The one path reader (#1237) ----
//
// A path word is read here, once, as the system that runs the command reads it: POSIX, `~`,
// a drive (`C:/x`, `C:\x`), Git Bash's `/c/x`, WSL's `/mnt/c/x` and a UNC share. What the
// system would read two ways is null, and the caller refuses it: a guard that guesses lets
// one of the two ways through. The platform is an argument, so Linux CI tests every system.

/** How a path word is written, whatever system reads it; null for a word that is no path. */
export type PathForm = 'home' | 'drive' | 'git-bash' | 'wsl' | 'unc' | 'device' | 'posix' | 'relative';

/** The way `word` is written: the first rule that fits, in the order of the type. */
export function pathForm(word: string): PathForm | null {
  if (word === '') return null;
  if (word === '~' || /^~[\\/]/.test(word)) return 'home';
  if (/^[\\/]{2}[?.][\\/]/.test(word)) return 'device';
  if (/^[\\/]{2}[^\\/]/.test(word)) return 'unc';
  if (/^[A-Za-z]:[\\/]/.test(word)) return 'drive';
  if (/^\/mnt\/[A-Za-z](?:\/|$)/.test(word)) return 'wsl';
  if (/^\/[A-Za-z](?:\/|$)/.test(word)) return 'git-bash';
  if (word.startsWith('/')) return 'posix';
  return 'relative';
}

// An 8.3 short name, as Windows spells a long folder name for old programs: `RUNNER~1`, `GITHUB~1.TXT`.
const SHORT_NAME = /^[^~\\/]{1,8}~\d+(?:\.[^\\/.]{0,3})?$/;

/** Whether a part of a path is a Windows 8.3 short name (`RUNNER~1`). */
export const isShortName = (part: string): boolean => SHORT_NAME.test(part);

/**
 * Whether a part of a Windows path reads two ways: Windows drops a trailing dot or space from
 * a name, so `...`, `a.` and `a ` may each name another folder than Node's path functions say,
 * and a `:` past the drive names a file's data stream. `.` and `..` are read by both alike.
 */
const isUnsureWindowsPart = (part: string): boolean => part !== '.' && part !== '..' && (/[. ]$/.test(part) || /[:<>"|?*]/.test(part));

/** Where a path word is read: the place, the home folder, and the folder a relative word is read from. */
export type PathReading = PathPlace & { home?: string | null; folder?: string | null };

/**
 * A path word as `place.platform` reads it, as a full path; null when it can't be placed,
 * which the caller refuses. On Windows a short-name part (`RUNNER~1`) is spelled out by the
 * system's own real path, so a check after this sees the long name git reports; with no real
 * path to ask (another system's path on this disk), a short name is null.
 *
 * - `~`, `~/x`: in `home`; null with no home. `~name` is another account's home: null.
 * - A drive (`C:/x`, `C:\x`) and a UNC share (`\\host\share`, `//host/share`) on Windows. POSIX
 *   reads `C:/x` as a folder named `C:` in `folder`, `\` as a letter, and `//x` as `/x`.
 * - Git Bash `/c/x` and `/tmp/x`: on Windows as `fromGitBash` reads them; any `/` path elsewhere is POSIX.
 * - A device path (`\\?\C:\x`, `\\.\pipe`): null, it skips the system's own reading.
 * - A relative word: from `folder`; null with no folder, or past the drive root.
 */
export function readPath(word: string, place: PathReading): string | null {
  const { platform } = place;
  const form = pathForm(word);
  // A device path is Windows' way past its own reading; on any system it is refused, never guessed.
  if (form === null || form === 'device' || (word.startsWith('~') && form !== 'home')) return null;
  if (platform !== 'win32') {
    // POSIX reads `\` as a letter and a drive as a folder name: only `/` and `~/` start a full path.
    // Bash reads `~\x` as a name with a backslash, not as home: only `~` and `~/` are.
    if (form === 'home') return place.home && (word === '~' || word.startsWith('~/')) ? posix.join(place.home, word.slice(2)) : null;
    if (word.startsWith('/')) return posix.normalize(word);
    return place.folder ? posix.resolve(place.folder, word) : null;
  }
  let full: string | null;
  switch (form) {
    case 'home':
      full = place.home ? win32.join(place.home, word.slice(2)) : null;
      break;
    case 'drive':
    case 'unc':
      full = win32.normalize(word);
      break;
    case 'git-bash':
    case 'wsl':
    case 'posix':
      // A `/` path Git Bash keeps as its own (`/dev/null`) is no file on the disk.
      full = fromGitBash(word, platform, place.tmp);
      if (full === null || full.startsWith('/')) return null;
      full = win32.normalize(full);
      break;
    case 'relative':
      // `C:x` is from the drive's own current folder, and `\x` from the current drive's root: neither is `folder`.
      if (/^[A-Za-z]:/.test(word) || word.startsWith('\\')) return null;
      full = place.folder && !climbsPastDrive(place.folder, word, platform) ? win32.resolve(place.folder, word) : null;
      break;
  }
  if (full === null) return null;
  const parts = word.split(/[\\/]+/).filter(Boolean);
  // The drive itself (`C:`) is the one part a `:` may end.
  if (parts.slice(form === 'drive' ? 1 : 0).some(isUnsureWindowsPart)) return null;
  if (!full.split(/[\\/]+/).some(isShortName)) return full;
  const real = place.realPath ?? (isHostPaths(platform) ? realPath : null);
  const long = real === null ? null : real(full);
  return long === null || long.split(/[\\/]+/).some(isShortName) ? null : long;
}

// ---- Users folders (#1237) ----
//
// The folder that holds the homes, and the user name right under it: `/home/<n>`,
// `/Users/<n>`, `C:\Users\<n>`, `C:/Users/<n>`, Git Bash's `/c/Users/<n>` and WSL's
// `/mnt/c/Users/<n>`. A WSL user's Windows home is not their $HOME, so the name is read by
// the shape, whatever the home folder is.

/** A folder that holds the users' homes: its child is a user name. */
export const USERS_FOLDER = /^(?:\/home|\/Users|\/mnt\/[a-z]\/Users|\/[a-z]\/Users|[A-Za-z]:[\\/]+Users)$/i;

/** The user name in a home path such as `/home/<name>` or `C:\Users\<name>`, or null for any other path. */
export function usersFolderUser(home: string | undefined): string | null {
  const path = (home ?? '').replace(/[\\/]+$/, '');
  const split = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return split > 0 && USERS_FOLDER.test(path.slice(0, split).replace(/[\\/]+$/, '')) ? path.slice(split + 1) : null;
}

/** The last part of a path written with either separator (`/data/zed/` and `D:\zed` give `zed`), or null when it has none. */
export function lastPathPart(path: string | undefined): string | null {
  return path?.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || null;
}


// ---- Users folders in text (#1237) ----
//
// Text writes a users-folder path in many ways: with `\` or `/`, doubled or escaped as JSON
// writes them (`C:\\Users`, `\/home\/x`), after a device or share prefix (`\\?\C:`,
// `\\server\c$`, `\\wsl$\Ubuntu`), after `../`, or right after a JSON escape (`\n/home/x`).
// The name ends where the system says a name can't go on. When that can't be told, more is
// hidden, never less.

// One separator, as text may write it: `/`, `\`, `\\`, or JSON's `\/`.
const SEP = String.raw`(?:\\*\/|\\+)`;
// A drive that holds homes. A: and B: are floppy drives, so `/a/users/me` is no Windows home.
const DRIVE_LETTER = '[C-Zc-z]';
// A Windows root before `Users`: a drive (also after `\\?\` or `\\.\`), an admin share
// (`\\server\c$`), WSL's `/mnt/c`, Cygwin's `/cygdrive/c` and Git Bash's `/c`.
const WINDOWS_ROOT = String.raw`(?:${DRIVE_LETTER}:|(?:\\\\[?.]\\UNC\\|[\\/]{2,})[^\\/\s"]+${SEP}${DRIVE_LETTER}\$|${SEP}mnt${SEP}${DRIVE_LETTER}|${SEP}cygdrive${SEP}${DRIVE_LETTER}|${SEP}${DRIVE_LETTER})`;
// Not inside a word, or right after a JSON escape (`\n`, `\t`, `\r`), whose letter is no word.
const AFTER_ESCAPE = String.raw`(?<=(?<!\\)\\[ntr])`;
// A Windows name holds spaces and most punctuation; it ends at a separator, a quote, a line
// end, or a character Windows does not allow in a name (`< > : | ? *`).
// A line end (`\n`, `\r`, `\v`, `\f`, U+0085, U+2028, U+2029) ends it too.
const WINDOWS_NAME = String.raw`[^\\/"\n\r\t\v\f\u0085\u2028\u2029<>:|?*\x00]+`;
// A POSIX account name holds no space: the name ends there, or at a separator or quote.
const POSIX_NAME = String.raw`[^\\/"\s<>|\x00]+`;
// Windows folds case, so the drive forms do; `/home` and `/Users` match as written.
const WINDOWS_USERS_IN_TEXT = new RegExp(String.raw`(?:(?<![\p{L}\p{N}_~\-])|${AFTER_ESCAPE})(${WINDOWS_ROOT}${SEP}[Uu][Ss][Ee][Rr][Ss])(${SEP}+)(${WINDOWS_NAME})`, 'gu');
// A `\` right after a word joins it (`src\/home`), so the word blocks the folder there too.
const POSIX_USERS_IN_TEXT = new RegExp(String.raw`(?:(?<![\p{L}\p{N}_~\-]\\*)|${AFTER_ESCAPE})((?:[\\/]{2,}[Ww][Ss][Ll](?:\$|\.localhost)${SEP}[^\\/\s"]+)?${SEP}(?:home|Users))(${SEP}+)(${POSIX_NAME})`, 'gu');

/** How a users-folder path in text was written: a Windows root, a WSL share, or a POSIX `/home` or `/Users`. */
export type UsersFolderForm = 'windows' | 'wsl' | 'home' | 'users';

// What may close a name in prose and is no part of it: a full stop, a comma, a closing quote or bracket.
const NAME_TRAIL = /[\s.,;:!'\x60\]}…]+$/u;

/** `written` without the prose that may follow a name: trailing punctuation, and a `)` it never opened. */
function trimName(written: string): string {
  let name = written;
  for (;;) {
    const next = name.replace(NAME_TRAIL, '');
    const closed = next.endsWith(')') && !next.includes('(') ? next.slice(0, -1) : next;
    if (closed === name) return name;
    name = closed;
  }
}

// A name with spaces may end anywhere, and no rule can tell where (`C:\Users\Kim Do`,
// `Mary Jane Watson Parker`). So a name runs on to a sure end only: a separator, a quote, a
// line end, a tab, a shell joiner (` && `, ` || `, ` | `), or the next
// drive or users-folder path. The rest of the line may be hidden with it: more, never less.
const SURE_END = /\s(?:&&|\|\||\|)(?=\s|$)/u;
// The start of the next path in the run: a drive (`C:\`, `C:/`) after a space or a comma.
const NEXT_DRIVE = /(?:^|[\s,;(])[A-Za-z]:(?=[\\/]|$)/u;
// The run of a `/Users/` name with spaces: up to a separator, a quote or a line end.
const USERS_RUN = /^[^\\/"\n\r\t\v\f\u0085\u2028\u2029\x00]*/u;

/** `run` cut at its first sure end, and before a drive the next path begins with. */
function cutAtSureEnd(run: string): string {
  const end = SURE_END.exec(run);
  const cut = end ? run.slice(0, end.index) : run;
  const drive = NEXT_DRIVE.exec(cut);
  return drive ? cut.slice(0, drive.index) : cut;
}

type FolderHit = { folder: string; slash: string; written: string; start: number; next: string };

/**
 * `text` with each user name in a users-folder path given to `replace`, with the form it was
 * written in and the text after the name; `replace` returns what to write in its place, or
 * null to keep it. Trailing prose punctuation stays out of a name, and a name of only dots
 * (`...`) or one already hidden or a variable (`~`, `%USERNAME%`, `$USER`) is kept. The scan
 * goes on right after each name, so a second path in the prose after it is read too.
 */
export function replaceUsersFolderNames(text: string, replace: (name: string, form: UsersFolderForm, after: string) => string | null): string {
  if (!/home|users/i.test(text)) return text;
  const pass = (input: string, pattern: RegExp, nameOf: (hit: FolderHit) => string, formOf: (folder: string) => UsersFolderForm) => {
    let out = '';
    let last = 0;
    pattern.lastIndex = 0;
    for (let found = pattern.exec(input); found !== null; found = pattern.exec(input)) {
      const [whole, folder, slash, written] = found;
      const start = found.index + folder.length + slash.length;
      const name = nameOf({ folder, slash, written, start, next: input[found.index + whole.length] ?? '' });
      const end = start + name.length;
      const shown = name === '' || /^[.~%$]|^\.+$/.test(name) ? null : replace(name, formOf(folder), input.slice(end));
      if (shown !== null) {
        out += input.slice(last, start) + shown;
        last = end;
      }
      // Go on after the name, never inside the folder: an empty name moves past the separator.
      pattern.lastIndex = Math.max(end, start, found.index + 1);
    }
    return out + input.slice(last);
  };
  // A Windows name stops at a character no name holds (`: < > | ? *`), and at a sure end.
  // `alice, C` before `:\Users\bob`: the letter is the next path's drive.
  const windowsName = ({ written, next }: FolderHit) => {
    let name = cutAtSureEnd(written);
    if (next === ':' && name === written) name = name.replace(/(?:^|[^\p{L}\p{N}_])[A-Za-z]$/u, '');
    return trimName(name);
  };
  // A /home name holds no space: it ends there. Under /Users a folder made by hand may hold
  // spaces, so its name runs on as a Windows name does.
  const posixName = (input: string) => ({ folder, written, start }: FolderHit) => (folder.endsWith('Users') ? trimName(cutAtSureEnd(USERS_RUN.exec(input.slice(start))?.[0] ?? written)) : trimName(written));
  const windows = pass(text, WINDOWS_USERS_IN_TEXT, windowsName, () => 'windows');
  return pass(windows, POSIX_USERS_IN_TEXT, posixName(windows), (folder) => (/wsl/i.test(folder) ? 'wsl' : folder.endsWith('home') ? 'home' : 'users'));
}
