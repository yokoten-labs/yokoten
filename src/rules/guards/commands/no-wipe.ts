import { isAbsolute, join, resolve } from 'node:path';
import { docsLink, type Finding } from '../../message.ts';
import { type Env } from '../../config.ts';
import { homeOf } from '../../privacy.ts';
import { plainArgs, WRITE_REDIRECT } from '../lead-only/targets.ts';
import { braceForms, findProgramPlaces, findPrograms, programName, realPath, unquotedRedirects, withoutShellRedirects } from '../bash/read/words.ts';
import { spend } from '../bash/read/run.ts';

// ---- Damage outside the project (#969) ----
//
// Three rules, safe by default for every person and every agent, with no setting:
//
// 1. No root: an agent never runs `sudo`, `doas`, `su`, `pkexec`, `runas`, or PowerShell's
//    `Start-Process -Verb RunAs`. The owner runs what needs root.
// 2. No wipe of home or system folders: a recursive delete, and a recursive mode or owner
//    change, whose target is `/`, the home folder, a top-level system folder, or a glob over
//    one of them (`/*`, `~/*`). A target the guard cannot read is refused too.
// 3. No disk commands: `mkfs*`, `wipefs`, `fdisk`, `parted`, `dd` with `of=/dev/…`, a
//    redirect into `/dev/…`, `format` and `diskpart`.
//
// These answer after the rules that name the case more exactly: a worker's own rules, the
// git folder, a blocked program, a post that leaks a secret. The first rule found is kept.

const SAFEGUARD_DOCS = docsLink('guide.md', 'the-safeguard');

const NO_ROOT_WHY = 'root can change or erase anything on this machine, and an agent cannot undo it';
const NO_ROOT_FIX = 'tell the owner what needs root and why; the owner runs it';
const noRootFinding = (word: string): Finding => ({ id: 'no-root', what: `\`${word}\` would run this command as root`, why: NO_ROOT_WHY, fix: NO_ROOT_FIX, docs: SAFEGUARD_DOCS });

const WIPE_WHY = 'one command from an agent that lost its context can wipe the home folder or the system, and nothing brings the files back';
const WIPE_FIX = 'delete or change only files inside this project, and name each one';
const wipeFindingOf = (what: string): Finding => ({ id: 'wipe-home-or-system', what, why: WIPE_WHY, fix: WIPE_FIX, docs: SAFEGUARD_DOCS });

const DISK_WHY = 'a disk command can erase a whole disk, and nothing brings the files back';
const DISK_FIX = 'tell the owner what the disk needs and why; the owner runs disk commands';
const diskFindingOf = (what: string): Finding => ({ id: 'disk-command', what, why: DISK_WHY, fix: DISK_FIX, docs: SAFEGUARD_DOCS });

// ---- Rule 1: no root for agents ----

const ROOT_PROGRAMS = new Set(['sudo', 'doas', 'su', 'pkexec', 'runas']);

/** A command that asks for root, by any of its programs (#969). The walk counts the launchers too, so `sudo` itself is found. */
export function checkNoRoot(words: string[]): Finding | null {
  spend(words.length);
  for (const { word, index } of findProgramPlaces(words, true)) {
    const name = programName(word).toLowerCase();
    if (ROOT_PROGRAMS.has(name)) return noRootFinding(word);
    if (name === 'start-process' && startsRunAs(words, index)) return noRootFinding(word);
  }
  return null;
}

// PowerShell's `-Verb RunAs` asks for the elevation prompt, which is root. `-Verb` takes
// the next word as its value.
function startsRunAs(words: string[], from: number): boolean {
  for (let index = from + 1; index < words.length; index++) {
    if (words[index].toLowerCase() !== '-verb') continue;
    return /^runas$/i.test(words[index + 1] ?? '');
  }
  return false;
}

// ---- Rule 2: no wipe of home or system folders ----

const WIPE_PROGRAMS = new Set(['rm', 'rmdir', 'remove-item', 'rd']);
// cmd's own flags of `rd`; every other `/…` word is a target.
const CMD_FLAGS = new Set(['/s', '/q']);

/** A recursive delete or a recursive mode or owner change on a dangerous place (#969). */
export function checkWipe(words: string[], cwd: string | null, env: Env): Finding | null {
  const home = homeOf(env);
  const homeReal = home === null ? null : realPath(home);
  spend(words.length);
  let from = 0;
  for (const program of findPrograms(words)) {
    const at = words.indexOf(program, from);
    if (at === -1) continue;
    from = at + 1;
    const name = programName(program).toLowerCase();
    const args = withoutShellRedirects(words, at + 1);
    if (name === 'find') {
      // `find <start> … -delete`: the start folder is the target; an inner `rm` is read at its own word.
      if (!args.includes('-delete')) continue;
      for (const start of findStartFolders(args)) {
        const place = findWipePlace(start, cwd, home, homeReal);
        if (place !== null) return wipeFinding(program, start, place);
      }
      continue;
    }
    if (!WIPE_PROGRAMS.has(name) && name !== 'chmod' && name !== 'chown') continue;
    if (!isWipeRecursive(name, args)) continue;
    for (const target of wipeTargets(name, args)) {
      const place = findWipePlace(target, cwd, home, homeReal);
      if (place !== null) return wipeFinding(program, target, place);
    }
  }
  return null;
}

function wipeFinding(program: string, target: string, place: Place): Finding {
  if (place === 'root') return wipeFindingOf(`\`${program}\` would wipe the root folder`);
  if (place === 'home') return wipeFindingOf(`\`${program}\` would wipe your home folder`);
  if (place === 'system') return wipeFindingOf(`\`${program}\` would wipe the system folder \`${target}\``);
  return wipeFindingOf(`\`${program}\` may wipe your home folder or the system: the guard cannot read the target \`${target}\``);
}

/** The folders a find walks, before its expression: the leading plain words. A find with none walks the current folder. */
function findStartFolders(args: string[]): string[] {
  const starts: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const word = args[index];
    if (word.startsWith('-')) {
      if (FIND_GLOBALS.has(word)) index++;
      break;
    }
    starts.push(word);
  }
  return starts.length === 0 ? ['.'] : starts;
}

const FIND_GLOBALS = new Set(['-maxdepth', '-mindepth', '-regextype']);

/** Whether the command removes folders: `rm -r`, `Remove-Item -Recurse`, `rd /s`, `chmod -R`, `chown -R`. `rmdir` always does. */
function isWipeRecursive(name: string, args: string[]): boolean {
  if (name === 'rmdir') return true;
  for (const arg of args) {
    if (name === 'rd') {
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
  if (name === 'rd') return args.filter((word) => !CMD_FLAGS.has(word.toLowerCase()) && !word.startsWith('-'));
  const targets = plainArgs(args);
  return name === 'chmod' || name === 'chown' ? targets.slice(1) : targets;
}

// ---- The places a wipe may reach ----

type Place = 'root' | 'home' | 'system' | 'unreadable';

// The forms of the home folder a command may name. Bash reads `$HOME` and `${HOME}`;
// PowerShell reads `$env:USERPROFILE` and cmd reads `%USERPROFILE%`. Case aside: Windows
// reads its own forms in either case. A quoted `~` is a folder named `~`, and the guard
// reads it as the home folder anyway: refusing it is the safe way.
const HOME_FORM = /^(?:~|\$HOME|\$\{HOME\}|\$env:USERPROFILE|%USERPROFILE%)(?=[\\/]|$)/i;

// The top-level system folders on Linux and macOS, by exact path. Windows has its own
// tree under a drive, read below (`C:\Windows`, `C:\Users`).
const SYSTEM_TOPS = new Set(['/etc', '/usr', '/var', '/bin', '/boot', '/home', '/Users']);
const WINDOWS_TOPS = new Set(['windows', 'users']);

/** The dangerous place the target `word` names, or null when the guard can read it as a safe one. */
function findWipePlace(word: string, cwd: string | null, home: string | null, homeReal: string | null): Place | null {
  const lead = HOME_FORM.exec(word);
  if (lead) {
    // The home folder must be known for any of its forms to be read.
    if (home === null) return 'unreadable';
    return findPlaceInPath(join(home, word.slice(lead[0].length)), home, homeReal);
  }
  if (/^[A-Za-z]:[\\/]?$/s.test(word)) return 'root'; // `C:\`, `C:/`, `C:`
  if (/[$%`]/.test(word)) return 'unreadable'; // a value the shell fills in
  if (/^[A-Za-z]:[\\/]/.test(word) || isAbsolute(word)) return findPlaceInPath(word, home, homeReal);
  // A relative path is read from the folder the command runs in; without it the guard cannot read the target.
  if (cwd === null) return 'unreadable';
  return findPlaceInPath(resolve(cwd, word), home, homeReal);
}

/** The dangerous place a full path, a glob allowed, can name, or null. */
function findPlaceInPath(path: string, home: string | null, homeReal: string | null): Place | null {
  for (const form of braceForms(path, 0)) {
    const parts = form.split(/[\\/]+/);
    // Windows keeps its own tree under a drive, which resolve does not follow here.
    if (/^[A-Za-z]:$/.test(parts[0] ?? '')) {
      const rest = parts.slice(1).filter(Boolean);
      if (rest.length === 1 && WINDOWS_TOPS.has(rest[0].toLowerCase())) return 'system';
      continue;
    }
    const globAt = parts.findIndex((part) => /[*?[{]/.test(part));
    const before = globAt === -1 ? form : parts.slice(0, globAt).join('/');
    const place = findPlainPlace(before, home, homeReal);
    if (place !== null) return place;
  }
  return null;
}

/** The dangerous place a glob-free full path names, or null. An empty path is a glob at the root. */
function findPlainPlace(text: string, home: string | null, homeReal: string | null): Place | null {
  if (text === '') return 'root';
  if (!isAbsolute(text)) return null;
  const abs = resolve(text);
  if (/^\/{1,2}$/.test(abs)) return 'root';
  // The home folder counts by real path too, so a symlink to it counts.
  if (home !== null && (abs === home || realPath(abs) === homeReal)) return 'home';
  return SYSTEM_TOPS.has(abs) ? 'system' : null;
}

// ---- Rule 3: no disk commands ----

const DISK_PROGRAMS = new Set(['wipefs', 'fdisk', 'sfdisk', 'cfdisk', 'parted', 'diskpart', 'format']);
// The /dev nodes that are not disks: a redirect or `dd` may still write to these.
const QUIET_DEV = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty']);

/** A disk command, or a write into a disk under `/dev` (#969). */
export function checkDisk(words: string[]): Finding | null {
  spend(words.length);
  for (const { word, index } of findProgramPlaces(words)) {
    const name = programName(word).toLowerCase();
    if (name.startsWith('mkfs')) return diskFindingOf(`\`${word}\` would write a filesystem on a disk`);
    if (DISK_PROGRAMS.has(name)) return diskFindingOf(`\`${word}\` would change a disk`);
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
