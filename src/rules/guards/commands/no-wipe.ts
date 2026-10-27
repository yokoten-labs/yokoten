import { posix, win32 } from 'node:path';
import { docsLink, type Finding } from '../../text/message.ts';
import { type Env } from '../../config.ts';
import { homeOf } from '../../privacy.ts';
import { plainArgs, WRITE_REDIRECT } from '../lead-only/targets.ts';
import { braceForms, findProgramPlaces, programName, realPath, unquotedRedirects, withoutShellRedirects } from '../bash/read/words.ts';
import { FIND_LEAD_OPTIONS } from '../worker/mark.ts';
import { gitBashDrive, isHostPaths } from '../../../platform/paths.ts';

// ---- Damage outside the project (#969) ----
//
// Three rules, safe by default for every person and every agent, with no setting:
//
// 1. No root: an agent never runs `sudo`, `doas`, `su`, `pkexec`, `runas`, or PowerShell's
//    `Start-Process -Verb RunAs`. The owner runs what needs root.
// 2. No wipe of home or system folders: a recursive delete, and a recursive mode or owner
//    change, whose target is `/`, the home folder, a top-level system folder, or a glob over
//    one of them (`/*`, `~/*`). `find` with a delete action counts by its start folder. The
//    folder the command runs in counts as the project, so a container's `/app` is no system
//    folder; the folder itself still counts as a wipe. A target the guard cannot read is
//    refused too; one that arrives on stdin (`xargs rm -rf`) is not read, and stays allowed.
// 3. No disk commands: `mkfs*`, `wipefs`, `fdisk`, `parted`, `diskutil`, `dd` with
//    `of=/dev/…`, a redirect into `/dev/…`, `format` and `diskpart`.
//
// These answer after the rules that name the case more exactly: a worker's own rules, the
// git folder, a blocked program, a post that leaks a secret. The first rule found is kept.

const SAFEGUARD_DOCS = docsLink('guide.md', 'the-safeguard');

const NO_ROOT_WHY = 'root can change or erase anything on this machine, and an agent cannot undo it';
const NO_ROOT_FIX = 'tell the owner what needs root and why; the owner runs it';
const noRootFinding = (word: string): Finding => ({ id: 'no-root', what: `\`${word}\` would run this command as root`, why: NO_ROOT_WHY, fix: NO_ROOT_FIX, docs: SAFEGUARD_DOCS });

const WIPE_WHY = 'one command from an agent that lost its context can wipe the home folder or the system, and nothing brings the files back';
const WIPE_FIX = 'delete or change only files inside this project, and name each one. The guard refuses a wipe of home, of the system, or of a target it cannot read';
const wipeFindingOf = (what: string): Finding => ({ id: 'wipe-home-or-system', what, why: WIPE_WHY, fix: WIPE_FIX, docs: SAFEGUARD_DOCS });

const DISK_WHY = 'a disk command can erase a whole disk, and nothing brings the files back';
const DISK_FIX = 'tell the owner what the disk needs and why; the owner runs disk commands';
const diskFindingOf = (what: string): Finding => ({ id: 'disk-command', what, why: DISK_WHY, fix: DISK_FIX, docs: SAFEGUARD_DOCS });

// ---- Rule 1: no root for agents ----

const ROOT_PROGRAMS = new Set(['sudo', 'doas', 'su', 'pkexec', 'runas']);

/** One program of a command and where its word sits (`-1` for a program an `env -S` string holds). */
type ProgramPlace = ReturnType<typeof findProgramPlaces>[number];

// One walk over the programs feeds all three rules: a command that can do none of them
// pays for a single scan (#969).
// `platform` says how paths read: Windows folds case, takes `\` and `/`, and Git Bash's `/c/…` (#999).
export function checkDamage(words: string[], cwd: string | null, env: Env, platform: NodeJS.Platform): Finding | null {
  const programs = findProgramPlaces(words, true);
  return checkNoRoot(programs, words) ?? checkWipe(programs, words, { cwd, env, platform }) ?? checkDisk(programs, words);
}

/** A command that asks for root, by any of its programs (#969). The walk counts the launchers too, so `sudo` itself is found. */
function checkNoRoot(programs: ProgramPlace[], words: string[]): Finding | null {
  for (const { word, index } of programs) {
    const name = programName(word).toLowerCase();
    if (ROOT_PROGRAMS.has(name)) return noRootFinding(word);
    if (name === 'start-process' && startsRunAs(words, index)) return noRootFinding(word);
  }
  return null;
}

// PowerShell's `-Verb RunAs` asks for the elevation prompt, which is root. `-Verb` takes
// the next word, or a `:` or `=` and the value in one word (`-Verb:RunAs`).
function startsRunAs(words: string[], from: number): boolean {
  for (let index = from + 1; index < words.length; index++) {
    const word = words[index].toLowerCase();
    if (word === '-verb') {
      if (/^runas$/i.test(words[index + 1] ?? '')) return true;
      continue;
    }
    if (/^-verb[:=]runas$/.test(word)) return true;
  }
  return false;
}

// ---- Rule 2: no wipe of home or system folders ----

const WIPE_PROGRAMS = new Set(['rm', 'rmdir', 'remove-item', 'rd', 'del', 'erase']);
// cmd's own flags of `rd`, `del` and `erase`; every other `/…` word is a target.
const CMD_PROGRAMS = new Set(['rd', 'del', 'erase']);
const CMD_FLAGS = new Set(['/s', '/q', '/f', '/p', '/a']);
// A find action that deletes or runs a command on each hit. The start folder is what it
// reaches, so a dangerous start with one of these is a wipe.
const FIND_DELETES = ['-delete', '-exec', '-execdir', '-ok', '-okdir'];

/** A recursive delete or a recursive mode or owner change on a dangerous place (#969). */
function checkWipe(programs: ProgramPlace[], words: string[], { cwd, env, platform }: { cwd: string | null; env: Env; platform: NodeJS.Platform }): Finding | null {
  const home = homeOf(env);
  // `realPath` asks this machine's disk, so a path in another platform's form is read as written.
  const readReal = (path: string) => (isHostPaths(platform) ? fullPath(realPath(path), platform) : path);
  const homeFull = home === null ? null : fullPath(home, platform);
  const folders: Folders = {
    cwd: cwd === null ? null : fullPath(cwd, platform),
    home: homeFull,
    homeReal: homeFull === null ? null : readReal(homeFull),
    platform,
    readReal,
  };
  for (const { word: program, index } of programs) {
    // A program an `env -S` string holds has no word of its own here: the reader runs that
    // string as commands, and this rule reads them there.
    if (index < 0) continue;
    const name = programName(program).toLowerCase();
    const args = withoutShellRedirects(words, index + 1);
    if (name === 'find') {
      // `find <starts> … -delete` or `-exec rm …`: the starts are the target; an inner `rm`
      // is read at its own word.
      if (!FIND_DELETES.some((action) => args.includes(action))) continue;
      for (const start of findStartFolders(args)) {
        // `find` walks the tree under its start folder: it reads the folder, and does not take it away.
        const place = findWipePlace(start, folders, false);
        if (place !== null) return wipeFinding(program, start, place);
      }
      continue;
    }
    if (!WIPE_PROGRAMS.has(name) && name !== 'chmod' && name !== 'chown') continue;
    if (!isWipeRecursive(name, args)) continue;
    for (const target of wipeTargets(name, args)) {
      const place = findWipePlace(target, folders);
      if (place !== null) return wipeFinding(program, target, place);
    }
  }
  return null;
}

function wipeFinding(program: string, target: string, place: Place): Finding {
  if (place === 'root') return wipeFindingOf(`\`${program}\` would wipe the root folder`);
  if (place === 'home') return wipeFindingOf(`\`${program}\` would wipe your home folder`);
  if (place === 'system') return wipeFindingOf(`\`${program}\` would wipe the system folder \`${target}\``);
  if (place === 'cwd') return wipeFindingOf(`\`${program}\` would wipe \`${target}\`, the folder this command runs in`);
  return wipeFindingOf(`\`${program}\` may wipe your home folder or the system: the guard cannot read the target \`${target}\``);
}

/** The folders a find walks, before its expression: the leading plain words. A find with none walks the current folder. */
function findStartFolders(args: string[]): string[] {
  const starts: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const word = args[index];
    // find's global options come before the start folders: `-H`, `-L`, `-P`, `-O2` and
    // `-D <opt>` name no folder, and the depth and regex options take a value (#969).
    if (FIND_LEAD_OPTIONS.test(word)) continue;
    if (word === '-D' || FIND_GLOBAL_VALUES.has(word)) {
      index++;
      continue;
    }
    if (word.startsWith('-')) break;
    starts.push(word);
  }
  return starts.length === 0 ? ['.'] : starts;
}

const FIND_GLOBAL_VALUES = new Set(['-maxdepth', '-mindepth', '-regextype']);

/** Whether the command removes folders: `rm -r`, `Remove-Item -Recurse`, `rd /s`, `del /s`, `chmod -R`, `chown -R`. `rmdir` always does. */
function isWipeRecursive(name: string, args: string[]): boolean {
  if (name === 'rmdir') return true;
  for (const arg of args) {
    if (CMD_PROGRAMS.has(name)) {
      if (/^\/s/i.test(arg)) return true;
      continue;
    }
    if (!arg.startsWith('-') || arg === '-') continue;
    if (name === 'remove-item') {
      if (/^-r/i.test(arg)) return true;
      continue;
    }
    if ((/^-[A-Za-z]*[rR]/.test(arg) && !arg.startsWith('--')) || /^--rec/.test(arg)) return true;
  }
  return false;
}

/** The paths the command may remove or change. cmd's flags are no targets; the mode and the owner are no targets. */
function wipeTargets(name: string, args: string[]): string[] {
  if (CMD_PROGRAMS.has(name)) return args.filter((word) => !CMD_FLAGS.has(word.toLowerCase()) && !word.startsWith('-'));
  const targets = plainArgs(args);
  return name === 'chmod' || name === 'chown' ? targets.slice(1) : targets;
}

// ---- The places a wipe may reach ----

type Place = 'root' | 'home' | 'system' | 'cwd' | 'unreadable';

// The forms of the home folder a command may name. Bash reads `$HOME` and `${HOME}`;
// PowerShell reads `$env:USERPROFILE` and cmd reads `%USERPROFILE%`. Case aside: Windows
// reads its own forms in either case. A quoted `~` is a folder named `~`, and the guard
// reads it as the home folder anyway: refusing it is the safe way.
const HOME_FORM = /^(?:~|\$HOME|\$\{HOME\}|\$env:USERPROFILE|%USERPROFILE%)(?=[\\/]|$)/i;
// `$PWD` names the folder the command runs in, so the guard reads it as `cwd`.
const PWD_FORM = /^(?:\$PWD|\$\{PWD\})(?=[\\/]|$)/;

// The top-level folders on Linux and macOS (`/System`, `/Library`, `/Applications`, `/opt`,
// `/srv`, `/usr`, `/etc` and the rest) belong to the system, not to a project. The guard
// reads every one- or two-part absolute path as the system, except a temp folder and what
// it holds, and except the project the command runs in (a container keeps it at `/app`,
// `/src` or `/workspace`). Windows has its own tree under a drive, read below.
const TEMP_TOPS = new Set(['/tmp']);
// A command that runs in one of these tops is not in a project: no project allowance.
const SYSTEM_TOPS = new Set(['usr', 'etc', 'bin', 'sbin', 'lib', 'lib64', 'boot', 'dev', 'proc', 'sys', 'var', 'run', 'root', 'home', 'Users', 'System', 'Library', 'Applications', 'private', 'Volumes', 'cores', 'Network']);
const SYSTEM_TOPS_FOLDED = new Set([...SYSTEM_TOPS].map((top) => top.toLowerCase()));

/**
 * Whether a folder at the top of a Windows drive belongs to the system, case aside (#999):
 * `Windows`, `Users`, `ProgramData`, `Program Files` and `Program Files (x86)`.
 */
function isWindowsSystemTop(name: string): boolean {
  const folded = name.toLowerCase();
  return folded === 'windows' || folded === 'users' || folded === 'programdata' || folded.startsWith('program files');
}

/** Whether an unquoted drive path lost its `\` and left a system top behind: `C:Users` for `C:\Users`. */
function isDriveSystemTop(word: string): boolean {
  const top = /^[A-Za-z]:([^\\/]+)$/.exec(word)?.[1] ?? '';
  return top !== '' && isWindowsSystemTop(top.replace(/[*?[]+$/, ''));
}

/** What a wipe target is read against. Every path is in `fullPath`'s form. */
type Folders = { cwd: string | null; home: string | null; homeReal: string | null; platform: NodeJS.Platform; readReal: (path: string) => string };

/**
 * A path in one form, so two forms of one folder compare equal (#999). On POSIX, `posix.resolve`.
 * A drive path, and every path on Windows: `/` between parts, `.` and `..` read, no trailing
 * `/`, and case folded. On Windows a Git Bash `/c/x` is `c:/x`; another `/x` keeps its root.
 */
function fullPath(path: string, platform: NodeJS.Platform): string {
  const isWindows = platform === 'win32';
  // Git Bash's `/c/x` is `C:\x` (src/platform/paths.ts); `\c\x` is read the same way here.
  let text = isWindows ? (gitBashDrive(path.replace(/^[\\/]([A-Za-z])(?:[\\/]|$)/, '/$1/')) ?? path) : path;
  const drive = /^[A-Za-z]:/.exec(text)?.[0];
  if (drive === undefined && !isWindows) return posix.resolve(text);
  if (drive !== undefined) text = text.slice(drive.length);
  const parts: string[] = [];
  for (const part of text.split(/[\\/]+/)) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `${drive ?? ''}/${parts.join('/')}`.toLowerCase();
}

/** Whether `path` is absolute: a drive path; on Windows also one from the root; elsewhere one from `/`. */
function isFullPath(path: string, platform: NodeJS.Platform): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || (platform === 'win32' ? win32.isAbsolute(path) : posix.isAbsolute(path));
}

/** Whether `abs` sits strictly inside the project the command runs in. The project folder itself stays refused. */
function isInProject(abs: string, { cwd, platform }: Folders): boolean {
  if (cwd === null || cwd === '/') return false;
  const top = cwd.split('/').filter(Boolean)[0] ?? '';
  if ((platform === 'win32' ? SYSTEM_TOPS_FOLDED : SYSTEM_TOPS).has(top)) return false;
  return abs.startsWith(`${cwd}/`);
}

/** The dangerous place the target `word` names, or null when the guard can read it as a safe one. `isExactTarget` is false for a walk of a folder's contents. */
function findWipePlace(word: string, folders: Folders, isExactTarget = true): Place | null {
  const lead = HOME_FORM.exec(word);
  if (lead) {
    // The home folder must be known for any of its forms to be read.
    if (folders.home === null) return 'unreadable';
    return findPlaceInPath(`${folders.home}/${word.slice(lead[0].length)}`, folders, isExactTarget);
  }
  // `$PWD` names the folder the command runs in; the guard reads it from `cwd`.
  const pwd = PWD_FORM.exec(word);
  if (pwd) {
    if (folders.cwd === null) return 'unreadable';
    return findPlaceInPath(`${folders.cwd}/${word.slice(pwd[0].length)}`, folders, isExactTarget);
  }
  if (/^[A-Za-z]:[\\/]?$/s.test(word)) return 'root'; // `C:\`, `C:/`, `C:`
  // An unquoted Windows path loses its `\` in the guard's read (`C:\Users` becomes
  // `C:Users`), so a drive-relative word that names a system top counts as one (#969).
  if (isDriveSystemTop(word)) return 'system';
  if (/[$%`]/.test(word)) return 'unreadable'; // a value the shell fills in
  if (word.startsWith('~')) return 'unreadable'; // `~user`: another account's home folder
  if (isFullPath(word, folders.platform)) return findPlaceInPath(word, folders, isExactTarget);
  // A relative path is read from the folder the command runs in; without it the guard cannot read the target.
  if (folders.cwd === null) return 'unreadable';
  return findPlaceInPath(`${folders.cwd}/${word}`, folders, isExactTarget);
}

/** The dangerous place a full path, a glob allowed, can name, or null. */
function findPlaceInPath(path: string, folders: Folders, isExactTarget: boolean): Place | null {
  for (const form of braceForms(path, 0)) {
    const abs = fullPath(form, folders.platform);
    const parts = abs.split('/');
    const globAt = parts.findIndex((part) => /[*?[{]/.test(part));
    const before = globAt === -1 ? abs : parts.slice(0, globAt).join('/');
    const place = findPlainPlace(before, folders, isExactTarget && globAt === -1);
    if (place !== null) return place;
  }
  return null;
}

/** The dangerous place a glob-free path in `fullPath`'s form names, or null. An empty path is a glob at the root. `isExact` says the path had no glob of its own. */
function findPlainPlace(abs: string, folders: Folders, isExact: boolean): Place | null {
  const { cwd, home, homeReal } = folders;
  if (abs === '' || /^\/{1,2}$/.test(abs) || /^[a-z]:\/?$/i.test(abs)) return 'root';
  // The home folder counts by real path too, so a symlink to it counts.
  if (home !== null && (abs === home || folders.readReal(abs) === homeReal)) return 'home';
  // Wiping the project folder would take the command's own working folder away with it. A
  // glob over its contents (`rm -rf ./*.log`) is a wipe of the contents, not of the folder.
  if (isExact && abs === cwd) return 'cwd';
  const drive = /^[a-z]:\//i.exec(abs);
  if (drive) {
    // On a drive, a system top and each folder in it are the system, the way two-part POSIX
    // paths are: `C:\Users\<name>`, `C:\Windows\System32`. Other drive folders hold projects.
    const rest = abs.slice(drive[0].length).split('/').filter(Boolean);
    return rest.length <= 2 && isWindowsSystemTop(rest[0] ?? '') ? 'system' : null;
  }
  const parts = abs.split('/').filter(Boolean);
  if (parts.length <= 2 && !TEMP_TOPS.has(`/${parts[0]}`) && !isInProject(abs, folders)) return 'system';
  return null;
}

// ---- Rule 3: no disk commands ----

const DISK_PROGRAMS = new Set(['wipefs', 'fdisk', 'sfdisk', 'cfdisk', 'parted', 'diskpart', 'format', 'diskutil', 'hdparm', 'gpt', 'sgdisk', 'nvme', 'blkdiscard']);
// The /dev nodes that are not disks: a redirect or `dd` may still write to these.
const QUIET_DEV = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty']);

/** A disk command, or a write into a disk under `/dev` (#969). */
function checkDisk(programs: ProgramPlace[], words: string[]): Finding | null {
  for (const { word, index } of programs) {
    const name = programName(word).toLowerCase();
    if (name.startsWith('mkfs')) return diskFindingOf(`\`${word}\` would write a filesystem on a disk`);
    if (DISK_PROGRAMS.has(name)) return diskFindingOf(`\`${word}\` would change a disk`);
    // `shred` wipes a file, and a disk when it names one: only the disk is this rule's.
    if (name === 'shred') {
      const disk = words.slice(index + 1).find((arg) => /^\/dev\//i.test(arg) && !QUIET_DEV.has(arg.toLowerCase()));
      if (disk !== undefined) return diskFindingOf(`\`shred\` would write to the disk \`${disk}\``);
      continue;
    }
    if (name !== 'dd') continue;
    for (const arg of words.slice(index + 1)) {
      const disk = /^of=(\/dev\/.*)$/i.exec(arg)?.[1];
      if (disk !== undefined && !QUIET_DEV.has(disk.toLowerCase())) return diskFindingOf(`\`dd\` would write to the disk \`${disk}\``);
    }
  }
  for (const index of unquotedRedirects.get(words) ?? []) {
    const redirect = WRITE_REDIRECT.exec(words[index]);
    const target = redirect && (redirect[2] || words[index + 1]);
    if (target && /^\/dev\//i.test(target) && !QUIET_DEV.has(target.toLowerCase())) {
      return diskFindingOf(`the redirect would write to the disk \`${target}\``);
    }
  }
  return null;
}
