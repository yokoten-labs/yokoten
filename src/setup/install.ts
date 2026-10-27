// `yokoten install`: the machine layer, the same on every computer. It puts one entry
// skill where Claude Code and the agents that read `.agents/skills` find it in every
// project, and the agents where Claude Code finds them. The other skills stay in the kit
// copy and are read through the entry skill, so the skill list does not grow seven lines.
// It adds two user-level hooks, for Claude Code, Codex and Gemini CLI alike:
//
// - SessionStart runs `doctor --session`, so every session in every repo starts by
//   hearing which practices that repo is missing. Nobody has to remember to ask.
// - PreToolUse (BeforeTool in Gemini CLI) runs `hook --commands-only`: no tag pushes, no
//   force pushes, no skipped checks, in every repo, adopted or not.
//
// Grok CLI, Antigravity CLI and Copilot CLI get the PreToolUse guard only, in
// ~/.grok/hooks/yokoten.json, ~/.gemini/config/hooks.json and
// ~/.copilot/hooks/yokoten.json.
//
// `yokoten uninstall` takes back what install wrote and marked as its own, for a machine
// that moves to the Claude Code plugin (#300): the plugin brings the same pieces, and both
// at once run every hook twice and show every skill twice.
//
// It puts a small `yokoten` launcher in ~/.local/bin (#433), on Windows a .cmd and a .ps1
// for PowerShell (#1038): every message says
// `yokoten init`, and a clone install has no other command on the PATH (#208). That
// folder is on the PATH on most setups. When it is not, install asks once before it adds
// one marked line to the shell profile, and never edits the profile in a run with no terminal.

import { execFileSync } from 'node:child_process';
import { configEntries } from '../run/check.ts';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { basename, delimiter, dirname, join, parse, relative, resolve, sep } from 'node:path';
import type { Env } from '../rules/config.ts';
import { STOPS_FILE, STOPS_OFF_FILE } from '../rules/guards/index.ts';
import { skillFile as sharedSkillFile } from '../agents/agent-skills.ts';
import * as copilot from '../agents/copilot.ts';
import { addUserHooks, agentFile, hasPlugin, hasSessionDoctor, hasUserGuard, removeUserHooks, skillFile as claudeSkillFile, userDir, userSettingsFile as claudeSettingsFile } from '../agents/runtimes/claude-code.ts';
import * as codex from '../agents/runtimes/codex.ts';
import * as gemini from '../agents/runtimes/gemini.ts';
import * as antigravity from '../agents/runtimes/small/antigravity.ts';
import * as grok from '../agents/runtimes/grok.ts';
import * as muse from '../agents/runtimes/muse.ts';
import * as opencode from '../agents/runtimes/small/opencode.ts';
import { commentedFile, type Problem, UnreadableHooksFile } from '../agents/hooks-file.ts';
import { type Change, changeOf, copyRuntime, HOME_DIR, isEditedManaged, isManagedText, isNewerKitCopy, KIT, MANAGED, managedState, type ReportState, type SetupResult, writeManaged, writeNew } from './files.ts';
import { type Finding, finding, type RuleId } from '../rules/text/message.ts';
import { type Gh, readLocalLogins, readLogin } from '../host/github/index.ts';
import { FOUND_HEADER, foundHeader, homeIn, loadMarkKinds, markLines, type Mark, homeOf, isDomainShaped, isLink, isEmailShaped, OWN_HEADER, isPersonalEmail, loadMarks, marksFile, NO_HOME, writtenMarksOnly, privateRemoteHosts, systemHome } from '../rules/privacy.ts';

/**
 * Where yokoten keeps its runtime, its config and the private marks. With no absolute home
 * folder it throws NO_HOME: a relative path would land in the folder the command runs in (#404).
 */
export const paths = (env: Env) => {
  const home = homeIn(env);
  return {
    runtime: join(home, '.local', 'share', 'yokoten'),
    config: join(home, '.config', 'yokoten'),
    // As marksFile gives it with a home folder: the default file, never YOKOTEN_PRIVATE_MARKS,
    // which only adds marks (#656). Install and doctor name this path (#392).
    marks: join(home, '.config', 'yokoten', 'private-marks'),
  };
};

/** The runtime the user hooks run, and what they say when it is gone. `doctor` compares the hooks with these. */
export const USER_CLI = '"$HOME/.local/share/yokoten/bin/yokoten.mjs"';
export const USER_MISSING = 'yokoten: the runtime at ~/.local/share/yokoten is missing; run the install again';

/** Every place a skill goes: Claude Code's folder, and the shared one other agents read. */
export const skillFiles = (env: Env, name: string): string[] => [claudeSkillFile(env, name), sharedSkillFile(env, name)];

/**
 * The one skill install puts in the global folders (#904). It routes to the other skills,
 * which stay in the kit copy at ~/.local/share/yokoten and are read from there. With the
 * Claude Code plugin on, install writes no global skill at all: the plugin brings them.
 */
export const ENTRY_SKILL = 'yokoten';
/** The file install copies as the one entry skill; the plugin brings its own set. */
const entryFile = (): string => join(KIT, 'user', 'entry', 'SKILL.md');

/**
 * Yokoten's skill in the shared folder, as a link to Claude Code's copy (#557). Muse reads
 * both ~/.claude/skills and ~/.agents/skills, and warns once per skill when it sees the two
 * copies (`skill-shadowed`). One real file with one link to it reads as one skill, so Muse
 * sees each skill once, while Claude Code keeps a real file and the other agents read
 * through the link. A folder with the user's own files in it stays real and only the skill
 * file is synced: replacing it with a link would throw their files away. So does a file of
 * theirs, and a link of theirs that points elsewhere.
 */
function writeSharedSkill(linkFile: string, targetFile: string, content: string, platform: NodeJS.Platform): 'linked' | 'same' | 'updated' | 'kept (yours)' | 'kept (your edit)' {
  const path = dirname(linkFile);
  const target = dirname(targetFile);
  // A link, when one is there: readlinkSync throws for a real file or folder, or nothing.
  const linkTarget = (): string | null => {
    try {
      return resolve(dirname(path), readlinkSync(path));
    } catch {
      return null;
    }
  };
  // The skill file's text when it is a file yokoten wrote; null when it is missing or not ours.
  const managedText = (): string | null => {
    try {
      const text = readFileSync(linkFile, 'utf8');
      return isManagedText(text) ? text : null;
    } catch {
      return null;
    }
  };
  const isManaged = (): boolean => managedText() !== null;
  // A junction on Windows: a plain link needs rights a user may not have.
  const link = (): 'linked' => {
    rmSync(path, { recursive: true, force: true });
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(target, path, platform === 'win32' ? 'junction' : 'dir');
    return 'linked';
  };
  const seen = linkTarget();
  if (seen !== null) return seen === target ? 'same' : isManaged() ? link() : 'kept (yours)';
  if (!existsSync(path)) return link();
  let onlyOurs = false;
  try {
    onlyOurs = statSync(path).isDirectory() && readdirSync(path).join() === 'SKILL.md';
  } catch {
    onlyOurs = false;
  }
  if (onlyOurs && isManaged()) {
    // Their own edit to the copy stays a real folder: a link would throw it away (0015).
    const text = managedText();
    if (text !== null && isEditedManaged(text)) return 'kept (your edit)';
    return link();
  }
  if (!isManaged()) return 'kept (yours)';
  // The skill file is there and managed, so this is 'same' or 'updated'.
  const synced = writeManaged(linkFile, content);
  return synced === 'wrote' ? 'updated' : synced;
}

/** The skills folder a skill file is in, for the report: `~/.claude/skills`. */
export const skillsDir = (file: string): string => dirname(dirname(file));

/** The home skill folders that hold a managed yokoten skill, for the duplicate note (#540). */
export function installedSkillDirs(env: Env): string[] {
  return [...new Set(kitSkills().flatMap((name) => skillFiles(env, name).filter(isManaged).map(skillsDir)))];
}

/**
 * The project folders that hold one managed yokoten skill, relative to `root`, for the
 * duplicate note (#540): `.agents/skills/dispatch` and so on. `npx skills add` puts a copy
 * in `.agents/skills` or `.claude/skills`. The note names each folder, never the whole
 * folder above it, which holds other packages' skills too.
 */
export function projectSkillDirs(root: string): string[] {
  const dirs = ['.agents/skills', '.claude/skills'];
  return dirs.flatMap((dir) => kitSkills().filter((name) => isManaged(join(root, dir, name, 'SKILL.md'))).map((name) => `${dir}/${name}`));
}

/** The example install prints when it asks the owner to type a mark (#525). */
const MARK_EXAMPLE = 'for example: your city, a company domain, a server name';

export const MARKS_HEADER = `# yokoten private marks: words that must never be published.
# One per line, matched without case. A name or a city (letters and spaces) is found as
# whole words: a letter next to it hides it, a digit or _ - . / @ does not. yokoten adds
# your git name, git email and forge login by itself; \`yokoten marks add\` adds your city,
# domain, server names, other account names.
# ${MARK_EXAMPLE}
# This file stays on this machine; never commit it or paste it anywhere.
`;

/** The real path of a file, or null when it is not there. */
const realPath = (file: string): string | null => {
  try {
    return realpathSync(file);
  } catch {
    return null;
  }
};

/**
 * The launchers' file names: a shell script, or on Windows a `.cmd` for cmd.exe and Git Bash
 * and a `.ps1` for PowerShell, which finds a script of its own before a .cmd (#1038).
 */
const LAUNCHER_NAMES: Record<'win32' | 'other', readonly string[]> = { win32: ['yokoten.cmd', 'yokoten.ps1'], other: ['yokoten'] };
const launcherNames = (platform: NodeJS.Platform): readonly string[] => LAUNCHER_NAMES[platform === 'win32' ? 'win32' : 'other'];

/** Whether `file` is a launcher yokoten wrote that runs one of `clis`. */
const isOurLauncher = (file: string, clis: string[]): boolean => {
  try {
    const text = readFileSync(file, 'utf8');
    return isManagedText(text) && clis.some((cli) => text.includes(cli));
  } catch {
    return false;
  }
};

/**
 * True when a `yokoten` on the PATH is this copy or the installed runtime: its real path
 * is one of their bin/yokoten.ts or bin/yokoten.mjs, or it is a launcher install wrote for
 * one of them (#433). A launcher from an older install runs yokoten.ts, so it still counts.
 * A shell alias is not on the PATH, so it is not seen.
 */
export function isOnPath(env: Env, runtime: string, platform: NodeJS.Platform = process.platform): boolean {
  const clis = [runtime, HOME_DIR].flatMap((dir) => [join(dir, 'bin', 'yokoten.mjs'), join(dir, 'bin', 'yokoten.ts')]);
  const ours = clis.map(realPath).filter(Boolean);
  const names = platform === 'win32' ? [...launcherNames(platform), 'yokoten'] : launcherNames(platform);
  return (env.PATH ?? '').split(platform === 'win32' ? ';' : delimiter).filter(Boolean).some((dir) =>
    names.some((name) => {
      const found = realPath(join(dir, name));
      return found !== null && (ours.includes(found) || isOurLauncher(found, clis));
    }),
  );
}

/** The line that tells the user how to call `yokoten` when the PATH has no copy that runs this one. */
export const aliasLine = (runtime: string): string =>
  `no \`yokoten\` command on your PATH runs this copy. Add this line to your shell profile (~/.bashrc or ~/.zshrc), then open a new shell: alias yokoten='node ${join(runtime, 'bin', 'yokoten.ts')}'`;

// ---- The launcher on the PATH (#433) ----

/** The mark on the one line install adds to a shell profile; uninstall removes the lines that end with it. */
export const PROFILE_MARK = '# added by yokoten';
/** The line install adds to the shell profile, when the user says yes. */
export const PROFILE_LINE = `export PATH="$HOME/.local/bin:$PATH" ${PROFILE_MARK}`;
/** The profiles uninstall looks in for the marked line. */
const PROFILES = ['.bashrc', '.bash_profile', '.zshrc'];

/** The folder the launcher goes in: ~/.local/bin, on the PATH on most setups. */
export const launcherDir = (home: string): string => join(home, '.local', 'bin');

/** The launcher file for this platform: on Windows the .cmd, the one cmd.exe and Git Bash run. */
export const launcherFile = (home: string, platform: NodeJS.Platform = process.platform): string => join(launcherDir(home), launcherNames(platform)[0] ?? 'yokoten');

/** Every launcher file for this platform: on Windows the .cmd and the .ps1 (#1038). */
export const launcherFiles = (home: string, platform: NodeJS.Platform): string[] => launcherNames(platform).map((name) => join(launcherDir(home), name));

/**
 * What the launcher holds: it runs the installed runtime with every argument, and carries the
 * managed mark. It runs bin/yokoten.mjs, the entry the user hooks run (USER_CLI), which turns on
 * the compile cache. Install rewrites a launcher from an older install that ran yokoten.ts.
 * `name` picks one of the Windows pair: the .ps1 is PowerShell's (#1038).
 */
export function launcherText(runtime: string, platform: NodeJS.Platform, name = launcherNames(platform)[0]): string {
  const cli = join(runtime, 'bin', 'yokoten.mjs');
  // Single quotes keep every character of the path in PowerShell too; a ' inside is doubled.
  if (platform === 'win32' && name?.endsWith('.ps1')) return `# ${MANAGED}: \`yokoten uninstall\` removes this file.\r\n& node '${cli.replaceAll("'", "''")}' @args\r\nexit $LASTEXITCODE\r\n`;
  if (platform === 'win32') return `@echo off\r\nrem ${MANAGED}: \`yokoten uninstall\` removes this file.\r\nnode "${cli}" %*\r\n`;
  // Single quotes keep every character of the path as it is; a ' inside is closed, escaped and reopened.
  return `#!/bin/sh\n# ${MANAGED}: \`yokoten uninstall\` removes this file.\nexec node '${cli.replaceAll("'", "'\\''")}' "$@"\n`;
}

/**
 * The profile of the user's shell, from $SHELL: ~/.bashrc for bash, ~/.zshrc for zsh, else null.
 * macOS opens a login bash, which reads ~/.bash_profile and not ~/.bashrc (#983).
 */
export function shellProfile(env: Env, home: string, platform: NodeJS.Platform): string | null {
  const shell = basename(env.SHELL ?? '');
  if (shell === 'bash') return join(home, platform === 'darwin' ? '.bash_profile' : '.bashrc');
  if (shell === 'zsh') return join(home, '.zshrc');
  return null;
}

/** Whether `dir` is one of the folders on the PATH. */
function isDirOnPath(env: Env, dir: string, platform: NodeJS.Platform): boolean {
  const wanted = realPath(dir) ?? resolve(dir);
  return (env.PATH ?? '').split(platform === 'win32' ? ';' : delimiter).filter(Boolean).some((entry) => (realPath(entry) ?? resolve(entry)) === wanted);
}

/** Whether a profile already has the marked line. */
const hasProfileLine = (profile: string): boolean => existsSync(profile) && readFileSync(profile, 'utf8').split('\n').some((line) => line.trimEnd().endsWith(PROFILE_MARK));

/**
 * The question install asks, and the answer: the line typed, or null when nobody can answer.
 * Only a run with a terminal on stdin and stdout passes one.
 */
export type Ask = (question: string) => string | null;

/** Whether an answer to a [Y/n] question is yes: Enter alone, y or yes. */
export const isYes = (answer: string | null): boolean => answer !== null && /^\s*(y|yes)?\s*$/i.test(answer);

/** Whether ~/.local/bin, the launcher's folder, is on the PATH now: a screen says how to add it when it is not. */
export const isLauncherOnPath = (env: Env, home: string, platform: NodeJS.Platform): boolean => isDirOnPath(env, launcherDir(home), platform);

/** The step that puts a folder on the PATH for the account on Windows, where install never edits it (#1038). */
export const WINDOWS_PATH_STEP = 'search Windows for "Edit environment variables for your account", add it to Path, then open a new terminal';

/** What a profile change says to do next: the PATH counts in a new shell. */
const NEW_SHELL = 'open a new shell, then run `yokoten`';

/**
 * Write the launcher (on Windows the .cmd and the .ps1, #1038) and make sure the shell finds
 * it. A file at that place without the managed mark is the user's: it stays and is named. When
 * ~/.local/bin is not on the PATH, it asks once (only with `ask`) before it adds PROFILE_LINE to
 * the shell's profile; on no, or with no terminal, a note gives the line instead. Windows gets
 * the steps, never an edit.
 */
export function setUpLauncher(env: Env, runtime: string, home: string, { ask, platform = process.platform }: { ask?: Ask; platform?: NodeJS.Platform } = {}): Steps {
  const steps = noSteps();
  const dir = launcherDir(home);
  let isTheirs = false;
  for (const file of launcherFiles(home, platform)) {
    const written = writeManaged(file, launcherText(runtime, platform, basename(file)));
    // The bytes of an edit stay, and so does its mode: a kept launcher is theirs to run or not.
    if (platform !== 'win32' && written !== 'kept (yours)' && written !== 'kept (your edit)') chmodSync(file, 0o755);
    isTheirs ||= written === 'kept (yours)';
    const change = changeOf(written, 'launcher', file, written === 'kept (yours)' ? { note: "it is not yokoten's launcher, so install left it as it is" } : {});
    if (change) steps.changes.push(change);
  }
  if (isTheirs) {
    if (!isOnPath(env, runtime, platform)) steps.notes.push(finding('machine-runtime', 'no `yokoten` command on your PATH runs this copy', `add this line to your shell profile (~/.bashrc or ~/.zshrc), then open a new shell: alias yokoten='node ${join(runtime, 'bin', 'yokoten.ts')}'`));
    return steps;
  }
  if (isDirOnPath(env, dir, platform)) return steps;
  const notOnPath = (fix: string): Finding => finding('machine-runtime', `${dir} is not on your PATH`, fix);
  if (platform === 'win32') {
    steps.notes.push(notOnPath(WINDOWS_PATH_STEP));
    return steps;
  }
  const profile = shellProfile(env, home, platform);
  if (!profile) {
    steps.notes.push(notOnPath(`add this line to your shell profile, then open a new shell: ${PROFILE_LINE}`));
    return steps;
  }
  if (hasProfileLine(profile)) {
    steps.changes.push({ state: 'kept', kind: 'profile', path: profile, note: NEW_SHELL });
    return steps;
  }
  const shown = (path: string): string => `~/${relative(home, path).split(sep).join('/')}`;
  if (ask && isYes(ask(`Add ${shown(dir)} to your PATH in ${shown(profile)}? [Y/n]`))) {
    const before = existsSync(profile) ? readFileSync(profile, 'utf8') : '';
    appendFileSync(profile, `${before === '' || before.endsWith('\n') ? '' : '\n'}${PROFILE_LINE}\n`);
    steps.changes.push({ state: 'added', kind: 'profile', path: profile, note: NEW_SHELL });
    return steps;
  }
  steps.notes.push(notOnPath(`add this line to ${profile}, then open a new shell: ${PROFILE_LINE}`));
  return steps;
}

/** The shell profiles that still hold the line install added. */
const profilesWithLine = (home: string): string[] => PROFILES.map((name) => join(home, name)).filter(hasProfileLine);

/** The changes that name something, without the `not there` ones. */
const named = (changes: (Change | null)[]): Change[] => changes.filter((change): change is Change => change !== null);

/**
 * Take back the launchers and, when `profiles` is true, the marked profile lines: one change
 * for each thing removed or kept. Only a command the user ran edits a profile; a session
 * start passes false (#983).
 */
function removeLauncher(home: string, platform: NodeJS.Platform, profiles = true): Change[] {
  const changes = named(launcherFiles(home, platform).map((file) => changeOf(removeManaged(file), 'launcher', file)));
  if (!profiles) return changes;
  for (const name of PROFILES) {
    const profile = join(home, name);
    if (!hasProfileLine(profile)) continue;
    const text = readFileSync(profile, 'utf8');
    replaceFile(profile, text.split('\n').filter((line) => !line.trimEnd().endsWith(PROFILE_MARK)).join('\n'));
    changes.push({ state: 'removed', kind: 'profile', path: profile });
  }
  return changes;
}

/** What one step of install or uninstall did: its changes, what went wrong, and what is worth a note. */
export type Steps = Pick<SetupResult, 'changes' | 'problems' | 'notes'>;
const noSteps = (): Steps => ({ changes: [], problems: [], notes: [] });

/** Add a step's changes, problems and notes to `into`. */
function addSteps(into: Steps, steps: Partial<Steps>): void {
  into.changes.push(...(steps.changes ?? []));
  into.problems.push(...(steps.problems ?? []));
  into.notes.push(...(steps.notes ?? []));
}

/** A step that must not stop install: an error becomes one problem that says what was skipped and why. */
function stepSafely(what: string, step: () => Partial<Steps>): Partial<Steps> {
  try {
    return step();
  } catch (err) {
    return { problems: [finding('machine-runtime', `install skipped ${what}: ${String((err as Error)?.message ?? err).split('\n')[0]}`, 'run `yokoten install` again')] };
  }
}

/** The rule behind each agent's user hooks, so a problem with its file names it (`yokoten explain`). */
const HOOK_RULES: Record<string, RuleId> = {
  'Claude Code': 'user-guard',
  'Codex CLI': 'codex-user-hook',
  'Gemini CLI': 'gemini-user-hook',
  'Antigravity CLI': 'antigravity-user-hook',
  'Copilot CLI': 'copilot-user-hook',
  'Grok CLI': 'grok-user-hook',
  'Muse Code': 'muse-user-hook',
  OpenCode: 'opencode-user-hook',
};

/** The note on Claude Code's hooks when the plugin brings them: the guard is on through the plugin. */
export const PLUGIN_BRINGS = 'the yokoten plugin brings them';

/** Why a hooks file stays as it was, as one problem: what is wrong, why it matters, and the command after the fix. */
function unreadableHooks(agent: string, file: string, problem: Problem): Finding {
  const id = HOOK_RULES[agent] ?? 'user-guard';
  const why = `the guard is not on for ${agent} until`;
  if (problem.kind === 'json') return finding(id, `${file} is not valid JSON`, 'run `yokoten install` again', { why: `${why} you make it valid JSON` });
  if (problem.kind === 'shape') return finding(id, `${file} has an unexpected shape (${problem.hint.replaceAll('`', '')})`, 'run `yokoten install` again', { why: `${why} you fix that` });
  // A file with comments is never rewritten (#258): doctor shows the hooks to add by hand.
  return finding(id, commentedFile(file), 'run `yokoten doctor --all`, then add the hooks it shows by hand', { why: `${why} its hooks are added by hand` });
}

/**
 * One agent's user hooks as changes, or one skipped change and a problem when its file won't
 * parse or has the wrong shape (#248, #254), or is a Gemini CLI file with comments, which
 * yokoten never rewrites (#258): the file stays as it was, the other steps go on, and `ok` is
 * false until the hooks are there.
 */
function agentHooks(agent: string, file: string, add: () => Record<string, HookState>): Steps & { ok: boolean } {
  try {
    const states = Object.entries(add());
    const changes = states.map(([hook, state]): Change =>
      // Antigravity's guard the user turned off stays off (#984): theirs, and not on.
      state === antigravity.KEPT_OFF ? { state: 'kept', kind: 'hook', path: file, agent, yours: true, note: `the command guard stays off, as you set it; to turn it on, ${antigravity.TURN_ON_STEP}` } : (changeOf(state, 'hook', file, { agent, note: HOOK_NAMES[hook] ?? hook }) as Change),
    );
    const notes = agent === 'OpenCode' ? states.map(([, state]) => keptPluginNote(state, file)).filter((note) => note !== null) : [];
    return { ok: true, changes, problems: [], notes };
  } catch (err) {
    if (!(err instanceof UnreadableHooksFile)) throw err;
    return { ok: false, changes: [{ state: 'skipped', kind: 'hook', path: file, agent }], problems: [unreadableHooks(agent, file, err.problem)], notes: [] };
  }
}

/** What a runtime's hook step did: a write's state, or Antigravity's guard kept off as the user set it. */
type HookState = ReportState | typeof antigravity.KEPT_OFF;

/** What each hook a runtime adds is, in a change's note. */
const HOOK_NAMES: Record<string, string> = { doctor: 'SessionStart doctor', guard: 'command guard' };

/** An agent whose own folder is not on this computer: install never makes it, so nothing is guarded there yet. */
const notInstalled = (agent: string, dir: string): Change => ({ state: 'skipped', kind: 'hook', path: dir, agent, note: NOT_INSTALLED });

/** The note on an agent install found no folder of: run install again after installing it. */
export const NOT_INSTALLED = 'not installed here';

/**
 * Put yokoten on this computer: its runtime, the entry skill, the agents, the user hooks of
 * every agent here, the private marks, the mailmap and the launcher. The result names each
 * thing as a change; `ok` is false when a hooks file was skipped (#248).
 */
export function install(env: Env, { cwd, gh, ask, platform = process.platform }: { cwd?: string; gh?: Gh; ask?: Ask; platform?: NodeJS.Platform } = {}): SetupResult {
  // Refuse before writing anything: with no home, every path below would be relative (#404).
  if (!homeOf(env)) return { ok: false, changes: [], problems: [noHomeProblem('install')], notes: [] };
  const target = paths(env);
  // Read before anything is written: uninstall later takes back only what install made (#985).
  const existedBefore = existingInstallPaths(env);
  const result: SetupResult = { ok: true, ...noSteps() };
  const plugin = hasPlugin(env);
  // With the plugin on, a machine that uses Claude Code alone needs no copy of yokoten:
  // the plugin brings the skills, the hooks and the runtime. Another tool's hook still
  // needs the runtime, so it stays when that tool is here.
  const otherTool = codex.hasUserDir(env) || gemini.hasUserDir(env) || antigravity.hasUserDir(env) || copilot.hasUserDir(env) || grok.hasUserDir(env) || muse.hasUserDir(env) || opencode.hasUserDir(env);
  // `yokoten install` through the launcher runs from the runtime itself: removing it would
  // delete the kit this run still reads, so that copy stays (#904).
  const isRunningFromRuntime = resolve(HOME_DIR) === resolve(target.runtime);
  // The plugin brings both user hooks too, so install takes back the copy an older install
  // added: it would run the guard twice. It goes before the runtime does, and the runtime
  // stays while a hook is left that still runs it: a file install cannot walk, or a user's
  // own hook (#904).
  const hooks = plugin ? removeUserHooks(env) : undefined;
  const needsRuntime = !plugin || otherTool || isRunningFromRuntime || hooks === null || hookRunsYokoten(env);
  // Run from this copy, install keeps it (#204).
  if (needsRuntime) {
    const copied = copyRuntime(target.runtime, { withKit: true, platform });
    result.changes.push(copied === 'kept' ? { state: 'kept', kind: 'runtime', path: target.runtime, note: 'the copy running now' } : { state: 'wrote', kind: 'runtime', path: target.runtime });
  } else {
    const had = existsSync(target.runtime);
    rmSync(target.runtime, { recursive: true, force: true });
    result.changes.push({ state: had ? 'removed' : 'skipped', kind: 'runtime', path: target.runtime, note: 'the yokoten plugin brings its own' });
  }

  const skills = join(KIT, 'user', 'skills');
  // The plugin brings every skill and agent, so a global copy would show each one twice
  // (#904). Install then only takes back the copies it wrote before; a run on a machine with
  // no copy names nothing per skill.
  for (const name of readdirSync(skills)) {
    const [claudeFile, sharedFile] = skillFiles(env, name);
    if (plugin || name !== ENTRY_SKILL) {
      result.changes.push(...named([changeOf(removeManaged(claudeFile, { folder: true }), 'skill', dirname(claudeFile)), changeOf(removeSharedSkill(sharedFile, claudeFile), 'skill', dirname(sharedFile))]));
      continue;
    }
    const content = readFileSync(entryFile(), 'utf8');
    result.changes.push(...named([changeOf(writeManaged(claudeFile, content), 'skill', dirname(claudeFile)), changeOf(writeSharedSkill(sharedFile, claudeFile, content, platform), 'skill', dirname(sharedFile))]));
  }
  const agents = join(KIT, 'user', 'agents');
  for (const file of readdirSync(agents)) {
    const state = plugin ? removeManaged(agentFile(env, file)) : writeManaged(agentFile(env, file), readFileSync(join(agents, file), 'utf8'));
    result.changes.push(...named([changeOf(state, 'agent', agentFile(env, file))]));
  }

  // With the plugin on, the user hooks went above, before the runtime (#904).
  // A hooks file is named as the person names it: from ~, or from the folder setting they set ($CODEX_HOME).
  const claudeSettings = claudeSettingsFile(env);
  if (plugin) {
    if (!hooks) {
      // The plugin check reads only enabledPlugins, so a file with a broken hooks shape gets here too.
      result.changes.push({ state: 'skipped', kind: 'hook', path: claudeSettings, agent: 'Claude Code' });
      result.problems.push(finding('user-guard', `${claudeSettings} is not JSON, or its hooks have an unexpected shape`, 'run `yokoten install` again', { why: 'yokoten takes its old hooks out of it only when you fix it' }));
      result.ok = false;
    } else result.changes.push({ state: hooks.doctor === 'removed' || hooks.guard === 'removed' ? 'removed' : 'skipped', kind: 'hook', path: claudeSettings, agent: 'Claude Code', note: PLUGIN_BRINGS });
  }
  // Codex and Gemini CLI get the same two hooks (#211), but only when the CLI's folder is
  // already there: install never makes ~/.codex or ~/.gemini for someone who doesn't use it.
  // A file that won't parse, or has the wrong shape, is named and skipped, never rewritten (#248).
  // Antigravity CLI and Copilot CLI get the command guard alone: agy has no session-start
  // event, and no real run has shown Copilot's SessionStart (#342). Grok CLI gets the command
  // guard alone: it shows a session-start hook's output only to the user (#407). Muse Code
  // reads a `hooks` block in its user settings in every repo (checked with 1.4.11). OpenCode
  // gets the command guard as a plugin file, only when its config folder is already there.
  const home = homeIn(env);
  // The folder an agent keeps its user files in, as the not-installed change names it.
  const folderOf = (file: string, depth = 1): string => file.split('/').slice(0, -depth).join('/');
  const tools: [agent: string, isHere: boolean, file: string, dir: string, add: () => Record<string, HookState>][] = [
    ['Claude Code', !plugin, claudeSettings, userDir(env), () => addUserHooks(env, USER_CLI, USER_MISSING)],
    ['Codex CLI', codex.hasUserDir(env), codex.userHooksFile(env), folderOf(codex.userHooksFile(env)), () => codex.addUserHooks(env, USER_CLI, USER_MISSING)],
    ['Gemini CLI', gemini.hasUserDir(env), GEMINI_SETTINGS, '~/.gemini', () => gemini.addUserHooks(env, USER_CLI, USER_MISSING)],
    ['Antigravity CLI', antigravity.hasUserDir(env), antigravity.userHooksFile(env), folderOf(antigravity.userHooksFile(env)), () => antigravity.addUserHooks(env, USER_CLI, USER_MISSING)],
    ['Copilot CLI', copilot.hasUserDir(env), copilot.userHooksFile(env), folderOf(copilot.userHooksFile(env), 2), () => copilot.addUserHooks(env, USER_CLI, USER_MISSING)],
    ['Grok CLI', grok.hasUserDir(env), grok.userHooksFile(env), folderOf(grok.userHooksFile(env), 2), () => grok.addUserHooks(env, USER_CLI, USER_MISSING)],
    ['Muse Code', muse.hasUserDir(env), muse.userSettingsFile(env), folderOf(muse.userSettingsFile(env)), () => muse.addUserHooks(env, USER_CLI, USER_MISSING)],
    ['OpenCode', opencode.hasUserDir(env), opencode.userPluginFile(env), folderOf(opencode.userPluginFile(env), 2), () => ({ guard: writeOpenCodePlugin(opencode.userPluginPath(env), opencode.userPluginSource(USER_CLI, USER_MISSING)) })],
  ];
  for (const [agent, isHere, file, dir, add] of tools) {
    if (agent === 'Claude Code' && !isHere) continue;
    if (!isHere) {
      result.changes.push(notInstalled(agent, dir));
      continue;
    }
    const added = agentHooks(agent, file, add);
    result.ok &&= added.ok;
    addSteps(result, added);
  }

  const marks = writeNew(target.marks, MARKS_HEADER, { mode: 0o600 });
  result.changes.push({ state: marks, kind: 'file', path: target.marks });
  // The obvious marks come from the machine; the rest only the owner knows (#390).
  const found = machineMarks(env, { cwd, gh });
  addSteps(result, stepSafely('the marks from this machine', () => marksSteps(env, found, target.marks)));
  addSteps(result, stepSafely('the git mailmap', () => setUpMailmap(env, found, { ask })));
  // Last, so the way to call `yokoten` is the step the user reads at the end.
  if (needsRuntime) addSteps(result, stepSafely('the launcher', () => setUpLauncher(env, target.runtime, home, { ask, platform })));
  // Nothing is kept out silently: with the plugin on, a launcher that was never there is
  // not worth a change, and one an older install left is named as removed.
  else addSteps(result, stepSafely('the launcher', () => ({ changes: removeLauncher(home, platform) })));
  addSteps(result, stepSafely('the list of what install made', () => {
    recordCreatedPaths(env, existedBefore);
    return {};
  }));
  return result;
}

/** Gemini CLI's user settings, as the person names the file. */
const GEMINI_SETTINGS = '~/.gemini/settings.json';

/** The one problem install and uninstall give with no home folder (#404). */
const noHomeProblem = (command: 'install' | 'uninstall'): Finding => finding('machine-runtime', NO_HOME, `set HOME to your home folder's full path, then run \`yokoten ${command}\` again`);

/** The marks from this machine in the private-marks file, and a note when the file has none (#522, #525). */
function marksSteps(env: Env, found: MachineMark[], file: string): Partial<Steps> {
  const kinds = fillMarks(env, found);
  const changes: Change[] = kinds.length ? [{ state: 'added', kind: 'file', path: file, note: `${kinds.join(', ')} from this machine (the values are not shown)` }] : [];
  // One answer, as doctor gives it (#522): no marks at all, or an optional offer.
  const marks = loadMarks(env);
  const missing = missingMarkKinds(marks, found);
  if (!marks.length) return { changes, notes: [finding('private-marks', `${file} has no marks yet`, EMPTY_MARKS_FIX, { why: MARK_EXAMPLE })] };
  if (missing.length) return { changes, notes: [finding('private-marks', offerMarkKinds(missing), OFFER_MARKS_FIX, { why: MARK_EXAMPLE })] };
  return { changes };
}

const kitSkills = (): string[] => readdirSync(join(KIT, 'user', 'skills'));
const kitAgents = (): string[] => readdirSync(join(KIT, 'user', 'agents'));

/** The skills install puts here, for the one screen it shows before it asks (#1027). */
export const skillNames = (): string[] => kitSkills();

/**
 * The agents this computer has, Claude Code aside (it is set up everywhere). Install puts
 * the guard in each one, and the preview names them before it writes (#1027).
 */
export function agentsHere(env: Env): string[] {
  return [
    ...(codex.hasUserDir(env) ? ['Codex'] : []),
    ...(gemini.hasUserDir(env) ? ['Gemini CLI'] : []),
    ...(antigravity.hasUserDir(env) ? ['Antigravity CLI'] : []),
    ...(copilot.hasUserDir(env) ? ['Copilot CLI'] : []),
    ...(grok.hasUserDir(env) ? ['Grok CLI'] : []),
    ...(muse.hasUserDir(env) ? ['Muse Code'] : []),
    ...(opencode.hasUserDir(env) ? ['OpenCode'] : []),
  ];
}

/**
 * Write an OpenCode plugin (the user's here, the project's in init) as a file yokoten owns:
 * a file without the mark, or one the user edited, stays (#984). A file yokoten can't read
 * throws `UnreadableHooksFile` and stays as it was.
 */
export function writeOpenCodePlugin(path: string, source: string): 'added' | 'updated' | 'same' | 'kept (yours)' | 'kept (your edit)' {
  if (managedState(path, source) === 'unreadable') throw new UnreadableHooksFile(path, opencode.UNREADABLE_PLUGIN);
  const state = writeManaged(path, source);
  return state === 'wrote' ? 'added' : state;
}

/** The note on an OpenCode plugin install kept, the user's own or edited: how to get yokoten's (#984). None for any other write. */
function keptPluginNote(state: HookState, file: string): Finding | null {
  if (state !== 'kept (yours)' && state !== 'kept (your edit)') return null;
  const whose = state === 'kept (yours)' ? "not yokoten's plugin" : "yokoten's plugin with your edits";
  return finding('opencode-user-hook', `${file} is ${whose}, so yokoten leaves it`, "to get yokoten's, move that file away and run `yokoten install`");
}

/** A managed file's text: `missing` when no file is there, `yours` when the file is not ours. */
const managedFileText = (path: string): { text: string } | 'missing' | 'yours' => {
  try {
    const text = readFileSync(path, 'utf8');
    return isManagedText(text) ? { text } : 'yours';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'yours';
  }
};

/** Whether `path` is a file yokoten wrote: it carries the managed mark. */
const isManaged = (path: string): boolean => typeof managedFileText(path) === 'object';

/**
 * Take back the shared skill: a link install made is removed, never followed. A real
 * folder is removed, kept or missing, as `removeManaged` says for its skill file.
 */
function removeSharedSkill(file: string, claudeFile: string): 'removed' | 'kept (yours)' | 'kept (your edit)' | 'not there' {
  const path = dirname(file);
  let target: string;
  try {
    target = readlinkSync(path);
  } catch {
    return removeManaged(file, { folder: true });
  }
  // install links the shared folder to the Claude Code copy. A link to anywhere else is the
  // user's, and a link to a skill file that stays (an edited one) stays with it.
  const claudeDir = dirname(claudeFile);
  if (resolve(dirname(path), target) !== resolve(claudeDir)) return 'kept (yours)';
  if (existsSync(claudeFile)) return 'kept (your edit)';
  unlinkSync(path);
  return 'removed';
}

/**
 * True when a hook left in Claude Code's user settings still runs yokoten, or the file can't
 * be read. It runs after yokoten's own hooks are taken out, so what is left is the user's:
 * any command naming yokoten counts, by the runtime's path or the launcher, also next to
 * shell syntax such as `$(…)`, `;` or `|`. `my-yokoten` and `yokoten-old` are other programs (#904).
 */
export function hookRunsYokoten(env: Env): boolean {
  let table: unknown;
  try {
    table = JSON.parse(readFileSync(join(userDir(env), 'settings.json'), 'utf8'));
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ENOENT';
  }
  const commands: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) {
        if (key === 'command' && typeof inner === 'string') commands.push(inner);
        else walk(inner);
      }
    }
  };
  walk((table as { hooks?: unknown } | null)?.hooks);
  return commands.some((command) => /(^|[^\w.-])yokoten(\.(mjs|ts|cmd|ps1|exe))?(?![\w-])/.test(command) || /[\\/]share[\\/]+yokoten[\\/]/.test(command));
}

/** Remove a file yokoten owns, and its folder when that is left empty. A file without the mark is the user's, and so is a marked file the user edited. */
function removeManaged(path: string, { folder = false, keepLink = false }: { folder?: boolean; keepLink?: boolean } = {}): 'removed' | 'kept (yours)' | 'kept (your edit)' | 'not there' {
  // One read decides all three: missing, ours, or the user's. A check before the read would
  // leave a gap where the file changes (CodeQL js/file-system-race).
  const found = managedFileText(path);
  if (found === 'missing') return 'not there';
  if (found === 'yours') return 'kept (yours)';
  if (isEditedManaged(found.text)) return 'kept (your edit)';
  // A linked file keeps its link: its target gets empty text in place of yokoten's (#984).
  if (keepLink && isLink(path)) {
    writeFileSync(path, '');
    return 'removed';
  }
  rmSync(path);
  if (folder) {
    try {
      rmdirSync(dirname(path));
    } catch {
      // the folder holds other files: they are the user's
    }
  }
  return 'removed';
}

/**
 * What a session start took back from an older install (#935): the files removed, the edits
 * that stay, and the shell profiles that still hold install's PATH line (#983).
 */
export type OlderInstallCleanup = { files: number; edits: string[]; profiles: string[] };

/**
 * Take back what v0.1.0's install left beside the plugin (#935): the global skills in both
 * folders, the agents, the Claude Code user hooks, the launcher and the runtime. Each goes
 * by the rules install uses (#904): only a file with yokoten's mark that the user did not
 * edit, and only an empty folder. A user hook stays, and an edited copy stays and is named.
 * Nothing happens without the plugin. Another tool's hook still needs the runtime, so the
 * runtime and the launcher stay then.
 */
export function cleanOlderInstall(env: Env, { platform = process.platform }: { platform?: NodeJS.Platform } = {}): OlderInstallCleanup {
  const cleanup: OlderInstallCleanup = { files: 0, edits: [], profiles: [] };
  if (!hasPlugin(env) || homeOf(env) === null) return cleanup;
  const count = (what: string, outcome: ReturnType<typeof removeManaged>): void => {
    if (outcome === 'removed') cleanup.files += 1;
    else if (outcome === 'kept (your edit)' && !cleanup.edits.includes(what)) cleanup.edits.push(what);
  };
  for (const name of kitSkills()) {
    const [claudeFile, sharedFile] = skillFiles(env, name);
    count(`skill ${name}`, removeManaged(claudeFile, { folder: true }));
    count(`skill ${name}`, removeSharedSkill(sharedFile, claudeFile));
  }
  for (const file of kitAgents()) count(`agent ${file.replace(/\.md$/, '')}`, removeManaged(agentFile(env, file)));
  // An unreadable hooks file stays as it is: a session never rewrites a setting.
  const hooks = removeUserHooks(env);
  if (hooks) cleanup.files += Number(hooks.doctor === 'removed') + Number(hooks.guard === 'removed');
  const otherTool = codex.hasUserDir(env) || gemini.hasUserDir(env) || antigravity.hasUserDir(env) || copilot.hasUserDir(env) || grok.hasUserDir(env) || muse.hasUserDir(env) || opencode.hasUserDir(env);
  if (otherTool) return cleanup;
  const target = paths(env);
  // The runtime stays while anything still runs it: this very process, or a hook left in
  // the settings (a file it could not walk, or a user's own hook that calls the runtime).
  if (resolve(HOME_DIR) === resolve(target.runtime) || hookRunsYokoten(env)) return cleanup;
  if (existsSync(target.runtime)) {
    rmSync(target.runtime, { recursive: true, force: true });
    cleanup.files += 1;
  }
  // A session never edits a shell profile: the line stays, and the session names it (#983).
  const launchers = stepSafely('the launcher', () => ({ changes: removeLauncher(homeIn(env), platform, false) })).changes ?? [];
  cleanup.files += launchers.filter((change) => change.state === 'removed').length;
  if (cleanup.files) cleanup.profiles = profilesWithLine(homeIn(env));
  return cleanup;
}

/**
 * A managed file the user edited while the kit's copy has changed since (#477). `file` is
 * the user's copy; `kitFile` is the newer copy to compare it with.
 */
export type EditedKitCopy = { name: string; file: string; kitFile: string };

/** A file's text, or null when it is missing or cannot be read. */
const readTextOrNull = (file: string): string | null => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

/** A folder's entries, or none when it is missing or cannot be read. */
const listOrNone = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

/**
 * The managed files the user edited whose kit copy has changed since install wrote it
 * (record 0015, #477). The hash in the mark says which version install wrote, so a
 * different hash in the kit means a newer copy is waiting. A file with no hash came from
 * an older yokoten and says nothing here.
 */
export function editedKitCopies(env: Env): EditedKitCopy[] {
  const copies: EditedKitCopy[] = [];
  const seen = new Set<string>();
  const look = (file: string, kitFile: string, name: string): void => {
    const text = readTextOrNull(file);
    const kitText = readTextOrNull(kitFile);
    if (text === null || kitText === null || !isEditedManaged(text) || !isNewerKitCopy(text, kitText)) return;
    // The shared skill may be a link to Claude Code's copy: name that copy once.
    const real = realPath(file) ?? file;
    if (seen.has(real)) return;
    seen.add(real);
    copies.push({ name, file, kitFile });
  };
  // A project copy of the kit has no kit/user folder, so this says nothing there (#77).
  for (const name of listOrNone(join(KIT, 'user', 'skills'))) {
    const [claudeFile, sharedFile] = skillFiles(env, name);
    // The entry skill comes from kit/user/entry: the adoption skill is not the copy install writes.
    const kitFile = name === ENTRY_SKILL ? entryFile() : join(KIT, 'user', 'skills', name, 'SKILL.md');
    look(claudeFile, kitFile, `skill ${name}`);
    look(sharedFile, kitFile, `skill ${name}`);
  }
  for (const file of listOrNone(join(KIT, 'user', 'agents'))) look(agentFile(env, file), join(KIT, 'user', 'agents', file), `agent ${file.replace(/\.md$/, '')}`);
  return copies;
}

/**
 * The pieces of install that are on this machine, for the doctor note when the plugin is
 * on too (#300). Empty when install never ran, or `uninstall` took them back.
 */
export function installedPieces(env: Env): string[] {
  const pieces: string[] = [];
  const hooks = [hasSessionDoctor(env) && 'the SessionStart doctor', hasUserGuard(env) && 'the command guard'].filter((hook) => hook !== false);
  if (hooks.length) pieces.push(`${hooks.join(' and ')} in ${join(userDir(env), 'settings.json')}`);
  const skillDirs = installedSkillDirs(env);
  if (skillDirs.length) pieces.push(`the skills in ${skillDirs.join(' and ')}`);
  if (kitAgents().some((file) => isManaged(agentFile(env, file)))) pieces.push(`the agents in ${join(userDir(env), 'agents')}`);
  if (existsSync(paths(env).runtime)) pieces.push(paths(env).runtime);
  return pieces;
}

/**
 * True when this machine has what install would put there: the runtime, and at least one
 * of the hooks, skills or agents. A machine with only part of it counts as missing, so
 * `yokoten` with no command installs again and repairs it (#548).
 */
export function isMachineSetUp(env: Env): boolean {
  const { runtime } = paths(env);
  if (!existsSync(join(runtime, 'bin', 'yokoten.mjs'))) return false;
  return installedPieces(env).some((piece) => !piece.includes(runtime));
}

/**
 * Take back what install wrote: the skills and agents that carry the managed mark, the two
 * user-level hooks, the runtime, and the files install made that the user never added to
 * (the private marks' header, the mailmap). A key or a mark of theirs keeps its file and
 * folder. A second run finds nothing and changes nothing. `ok` is false when a hooks file
 * could not be read, so its hooks stay for the person to take out.
 */
export function uninstall(env: Env, { platform }: { platform: NodeJS.Platform }): SetupResult {
  // As install: with no home, every path below would be relative (#404).
  if (!homeOf(env)) return { ok: false, changes: [], problems: [noHomeProblem('uninstall')], notes: [] };
  const target = paths(env);
  const result: SetupResult = { ok: true, ...noSteps() };
  for (const name of kitSkills()) {
    const [claudeFile, sharedFile] = skillFiles(env, name);
    result.changes.push(...named([changeOf(removeManaged(claudeFile, { folder: true }), 'skill', dirname(claudeFile)), changeOf(removeSharedSkill(sharedFile, claudeFile), 'skill', dirname(sharedFile))]));
  }
  for (const file of kitAgents()) result.changes.push(...named([changeOf(removeManaged(agentFile(env, file)), 'agent', agentFile(env, file))]));

  const settings = claudeSettingsFile(env);
  const hooks = removeUserHooks(env);
  if (hooks) result.changes.push(...named([changeOf(hooks.doctor, 'hook', settings, { agent: 'Claude Code', note: HOOK_NAMES.doctor }), changeOf(hooks.guard, 'hook', settings, { agent: 'Claude Code', note: HOOK_NAMES.guard })]));
  else result.problems.push(handRemoval('Claude Code', settings));
  // The user-level guards outside Claude Code's settings (#342). Each is touched only
  // when its tool is on this machine; an unreadable file stays as it is.
  const home = homeIn(env);
  const extras: [agent: string, file: string, removed: 'removed' | 'not there' | 'kept (yours)' | 'kept (your edit)' | null | { doctor: 'removed' | 'not there'; guard: 'removed' | 'not there' }][] = [
    ['Antigravity CLI', antigravity.userHooksFile(env), antigravity.hasUserDir(env) ? antigravity.removeUserHooks(env) : 'not there'],
    ['Copilot CLI', copilot.userHooksFile(env), copilot.hasUserDir(env) ? copilot.removeUserHooks(env) : 'not there'],
    ['Codex CLI', codex.userHooksFile(env), codex.hasUserDir(env) ? codex.removeUserHooks(env) : 'not there'],
    ['Gemini CLI', GEMINI_SETTINGS, gemini.hasUserDir(env) ? gemini.removeUserHooks(env) : 'not there'],
    ['Grok CLI', grok.userHooksFile(env), grok.hasUserDir(env) ? grok.removeUserHooks(env) : 'not there'],
    ['Muse Code', muse.userSettingsFile(env), muse.hasUserDir(env) ? muse.removeUserHooks(env) : 'not there'],
    ['OpenCode', opencode.userPluginFile(env), opencode.hasUserDir(env) ? removeManaged(opencode.userPluginPath(env), { keepLink: true }) : 'not there'],
  ];
  for (const [agent, file, removed] of extras) {
    if (removed === null) result.problems.push(handRemoval(agent, file));
    else if (typeof removed === 'object') {
      if (removed.doctor === 'removed' || removed.guard === 'removed') result.changes.push({ state: 'removed', kind: 'hook', path: file, agent });
    } else if (removed === 'removed') result.changes.push({ state: 'removed', kind: 'hook', path: file, agent });
  }

  addSteps(result, stepSafely('the launcher', () => ({ changes: removeLauncher(home, platform) })));
  if (existsSync(target.runtime)) result.changes.push({ state: 'removed', kind: 'runtime', path: target.runtime });
  rmSync(target.runtime, { recursive: true, force: true });
  // The stop log is yokoten's own, so uninstall takes it with the rest (#621).
  const stopLog = join(target.config, STOPS_FILE);
  const stopOff = join(target.config, STOPS_OFF_FILE);
  if (existsSync(stopLog) || existsSync(stopOff)) result.changes.push({ state: 'removed', kind: 'file', path: stopLog, note: 'the stop log' });
  rmSync(stopLog, { force: true });
  rmSync(stopOff, { force: true });
  // A file install wrote and the user never added to goes too, so the home folder is as
  // it was before install (#904). A mark or a mailmap line of their own keeps the file.
  const headerOnly = (file: string, header: string): boolean => {
    try {
      return readFileSync(file, 'utf8') === header;
    } catch {
      return false;
    }
  };
  if (headerOnly(target.marks, MARKS_HEADER)) {
    rmSync(target.marks, { force: true });
    result.changes.push({ state: 'removed', kind: 'file', path: target.marks });
  }
  const mailmapFile = join(target.config, 'mailmap');
  if (headerOnly(mailmapFile, MAILMAP_HEADER) && mailmapState(env) !== 'other') {
    rmSync(mailmapFile, { force: true });
    result.changes.push({ state: 'removed', kind: 'file', path: mailmapFile });
  }
  if (mailmapState(env) === 'ours') {
    readGitValue(env, ['config', '--global', '--unset', 'mailmap.file']);
    result.changes.push({ state: 'removed', kind: 'setting', path: 'mailmap.file' });
  }
  // Only what install made goes (#985). An install older than this record named nothing,
  // so its folders and git config file stay: a leftover empty folder is the safe side.
  const created = readCreatedPaths(env);
  const gitConfig = globalGitConfigFile(env);
  try {
    if (created.has(gitConfig) && statSync(gitConfig).size === 0) rmSync(gitConfig, { force: true });
  } catch {
    // no global git config, or it holds the user's own settings: it stays
  }
  forgetCreatedPaths(env);
  // A folder install made, and the user never put anything in, goes too. A folder that was
  // there before install stays, even when it is empty, and so does one with anything in it.
  for (const dir of installFolders(env)) {
    if (!created.has(dir)) continue;
    try {
      rmdirSync(dir);
    } catch {
      // the folder holds something of the user's: it stays
    }
  }
  if (existsSync(target.config)) result.changes.push({ state: 'kept', kind: 'file', path: target.config, yours: true, note: 'your keys and private marks' });
  result.ok = result.problems.length === 0;
  return result;
}

/** A hooks file uninstall can't read: its hooks stay, and the person takes them out (#342). */
const handRemoval = (agent: string, file: string): Finding =>
  finding(HOOK_RULES[agent] ?? 'user-guard', `${file} is not JSON, so the ${agent} hooks are still in it`, 'run `yokoten uninstall` again', { why: 'uninstall never rewrites a file it cannot read, so take them out by hand first' });

/** The first line of the mailmap install writes: a file with only this line is install's alone. */
const MAILMAP_HEADER = "# yokoten: git prints the owner's emails as a placeholder. Kept outside every repo; never commit it.\n";

// ---- What install made, so uninstall takes back only that (#985) ----

/** The machine.json key that lists the folders and files install made. */
const CREATED_KEY = 'installCreated';

/** The file git's `--global` writes: $GIT_CONFIG_GLOBAL, or ~/.gitconfig. */
const globalGitConfigFile = (env: Env): string => env.GIT_CONFIG_GLOBAL || join(homeIn(env), '.gitconfig');

/** The folders install may make, deepest first, so uninstall can take each back once it is empty. */
function installFolders(env: Env): string[] {
  const home = homeIn(env);
  return [
    join(home, '.local', 'bin'),
    join(home, '.local', 'share'),
    join(home, '.local'),
    paths(env).config,
    join(home, '.agents', 'skills'),
    join(home, '.agents'),
    join(userDir(env), 'skills'),
    join(userDir(env), 'agents'),
    userDir(env),
    join(home, '.grok', 'hooks'),
    join(home, '.copilot', 'hooks'),
    join(home, '.gemini', 'config'),
    join(home, '.config', 'opencode', 'plugins'),
    join(home, '.config', 'muse'),
    join(home, '.config'),
  ];
}

/** Every path install may make: its folders and the global git config file. */
const installPaths = (env: Env): string[] => [...installFolders(env), globalGitConfigFile(env)];

/** The paths of `installPaths` that are there now. Install reads this before it writes anything. */
export const existingInstallPaths = (env: Env): Set<string> => new Set(installPaths(env).filter((path) => existsSync(path)));

/** The paths machine.json says install made. Only paths install may make count, so a hand-edited list can't name another folder. */
export function readCreatedPaths(env: Env): Set<string> {
  const listed = readMachineState(machineStateFile(env), REAL_USER_PROBE)[CREATED_KEY];
  const known = new Set(installPaths(env));
  return new Set(Array.isArray(listed) ? listed.filter((path): path is string => typeof path === 'string' && known.has(path)) : []);
}

/**
 * Write what install made to machine.json: what was missing before this run and is there now,
 * and what an earlier install made that this run found still there.
 */
function recordCreatedPaths(env: Env, before: Set<string>): void {
  const earlier = readCreatedPaths(env);
  const created = installPaths(env).filter((path) => existsSync(path) && (!before.has(path) || earlier.has(path)));
  if (!created.length && !earlier.size) return;
  saveMachineState(machineStateFile(env), REAL_USER_PROBE, CREATED_KEY, created);
}

/** Take the record out of machine.json, and the file too when nothing else is left in it. */
function forgetCreatedPaths(env: Env): void {
  const file = machineStateFile(env);
  const state = readMachineState(file, REAL_USER_PROBE);
  if (!(CREATED_KEY in state)) return;
  const rest = { ...state };
  delete rest[CREATED_KEY];
  if (Object.keys(rest).length) REAL_USER_PROBE.writeText(file, `${JSON.stringify(rest, null, 2)}\n`);
  else rmSync(file, { force: true });
}

// ---- What this machine knows about its owner (#390) ----
//
// The obvious marks are on the machine already: git's user.name and user.email, the login
// gh is signed in with, the hosts of private remotes. `install` and full `doctor` add the
// ones the private-marks file lacks, and never print a value. A machine-level mailmap makes
// `git log` and `git show` print a placeholder for the owner's emails at the source.

/** A folder in no repo, the root of the file system, for a git read of the machine's own config. */
const OUTSIDE_REPOS = parse(process.execPath).root;

/** One git read with the caller's environment (its HOME and global config), in `cwd` or outside every repo, or null. Nothing is printed. */
function readGitValue(env: Env, args: string[], cwd: string = OUTSIDE_REPOS): string | null {
  try {
    const value = execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim();
    return value || null;
  } catch {
    return null;
  }
}

/** One value this machine knows about its owner, and its kind in plain words. */
export interface MachineMark {
  kind: 'git name' | 'git email' | 'forge login' | 'private remote host';
  value: string;
}

/**
 * The owner's values this machine knows: git user.name and user.email (as git reads them in
 * `cwd`, or outside every repo without one), the login gh is signed in with (only when `gh` is given: it may reach the network),
 * and the hosts of remotes in `cwd` that are not public forges.
 */
export function machineMarks(env: Env, { cwd, gh }: { cwd?: string; gh?: Gh } = {}): MachineMark[] {
  const found: MachineMark[] = [];
  // In a run (full doctor), one config list kept for the run holds all three (#453).
  const listed = (match: string | RegExp) => configEntries(cwd ?? OUTSIDE_REPOS, match, env)?.map((entry) => entry.value.trim()) ?? null;
  const lastOf = (key: string) => {
    const values = listed(key);
    return values ? values.at(-1) || null : readGitValue(env, ['config', '--get', key], cwd);
  };
  const name = lastOf('user.name');
  if (name) found.push({ kind: 'git name', value: name });
  const email = lastOf('user.email');
  // A noreply address is meant to be public; the login in it is added on its own.
  if (email && isPersonalEmail(email)) found.push({ kind: 'git email', value: email });
  const login = gh ? readLogin(gh) : null;
  if (login) found.push({ kind: 'forge login', value: login });
  const urls = listed(/^remote\..*\.url$/)?.map((value) => value.split(/\s+/)[0]) ?? (readGitValue(env, ['config', '--get-regexp', String.raw`^remote\..*\.url$`], cwd) ?? '').split('\n').map((line) => line.split(/\s+/)[1] ?? '');
  for (const host of privateRemoteHosts(urls)) found.push({ kind: 'private remote host', value: host });
  return found;
}

/** Where yokoten keeps what it read about this machine: outside every repo. Throws NO_HOME with no home. */
export const machineStateFile = (env: Env): string => join(paths(env).config, 'machine.json');

/**
 * Write a file whole or not at all: a temp file in the same folder, then a rename. Two
 * yokoten processes that write at once then never leave half a file (#404).
 */
export function writeFileAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, text);
    renameSync(temp, path);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
}

/** The file reads and writes machine.json needs: doctor's probe and the user-name probe both have them. */
interface StateFiles {
  readText(path: string): string | null;
  writeText(path: string, text: string): void;
}

/** What machine.json holds, or an empty object when it is missing or broken. */
export function readMachineState(file: string, files: StateFiles): Record<string, unknown> {
  try {
    const state: unknown = JSON.parse(files.readText(file) ?? 'null');
    return state && typeof state === 'object' && !Array.isArray(state) ? (state as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Set one key of machine.json and keep the others. Throws when the file can't be written. */
export function saveMachineState(file: string, files: StateFiles, key: string, value: unknown): void {
  files.writeText(file, `${JSON.stringify({ ...readMachineState(file, files), [key]: value }, null, 2)}\n`);
}

/** What `machineUserNames` reads, so a test can give fake values. */
export interface UserNameProbe extends StateFiles {
  /** The account name, as the system's user database gives it. May throw. */
  username(): string;
  /** The home folder in the system's user database. */
  systemHome(): string;
  /** The names of the folders in `path`, or null when it can't be read. */
  listFolders(path: string): string[] | null;
  now(): Date;
}

/** The real machine. It never starts a program. */
export const REAL_USER_PROBE: UserNameProbe = {
  username: () => userInfo().username,
  systemHome,
  listFolders(path) {
    try {
      return readdirSync(path, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return null;
    }
  },
  readText(path) {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  },
  writeText: writeFileAtomic,
  now: () => new Date(),
};

// Account names that every machine of a kind has (a CI runner, a container, a cloud VM).
// They name nobody, and hiding them would hide common words such as "root" and "test".
const SHARED_ACCOUNTS = new Set([
  ...['root', 'runner', 'user', 'users', 'admin', 'administrator', 'guest', 'nobody', 'temp', 'dev', 'test', 'app', 'build'],
  ...['ubuntu', 'debian', 'node', 'vscode', 'codespace', 'codespaces', 'gitpod', 'vagrant', 'ec2-user', 'jenkins'],
]);
// The folders in a Windows Users folder that are not a person's: shared, system and service accounts.
const WINDOWS_SHARED_FOLDERS = new Set(['public', 'default', 'default user', 'all users', 'wdagutilityaccount', 'temp', 'postgres', 'mysql', 'sshd', 'updatususer', 'wsiaccount', 'defaultapppool']);
const WINDOWS_SHARED_PATTERN = /^(?:defaultuser\d+|.*\.migrated|\.net v.*|classic \.net apppool|mssql.*|\$.*)$/;
/** Whether a folder in a Windows Users folder is a person's. */
const isPersonFolder = (name: string): boolean => !WINDOWS_SHARED_FOLDERS.has(name.toLowerCase()) && !WINDOWS_SHARED_PATTERN.test(name.toLowerCase()) && !SHARED_ACCOUNTS.has(name.toLowerCase());
// A folder that holds the users' homes: its child is a user name.
const USERS_FOLDER = /^(?:\/home|\/Users|\/mnt\/[a-z]\/Users|\/[a-z]\/Users|[A-Za-z]:[\\/]Users)$/i;

/** The user name in a home path such as `/home/<name>` or `C:\Users\<name>`, or null for any other path. */
function homeUserName(home: string | undefined): string | null {
  const path = (home ?? '').replace(/[\\/]+$/, '');
  const split = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return split > 0 && USERS_FOLDER.test(path.slice(0, split)) ? path.slice(split + 1) : null;
}

/** The Windows user names machine.json keeps: the folders found, when, and how long the read took. */
interface WindowsUsersCache {
  names: string[];
  readAt: string;
  scanMs: number;
}

/** Kept names older than this are read again: an account may have come or gone. */
const MAX_NAMES_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** A read of the drives slower than this is not repeated when the names go old: a sleeping drive must not slow every redact. */
const SLOW_SCAN_MS = 50;
/** What each probe read in this process, for when machine.json can't be written. */
const namesRead = new WeakMap<UserNameProbe, string[]>();

/**
 * The Windows accounts a WSL distro can see: the person folders in `/mnt/<drive>/Users`.
 * Read once, then kept in machine.json as `windowsUsers` for 30 days, so a later run reads
 * one local file (#404). With no file, the names are kept for this process only.
 */
function windowsUserNames(env: Env, probe: UserNameProbe): string[] {
  const known = namesRead.get(probe);
  if (known) return known;
  let file: string | null = null;
  try {
    file = machineStateFile(env);
  } catch {
    // no home: read the drives, and keep the names in this process
  }
  const kept = file ? (readMachineState(file, probe).windowsUsers as Partial<WindowsUsersCache> | undefined) : undefined;
  const isValid = Array.isArray(kept?.names) && kept.names.every((name) => typeof name === 'string') && typeof kept.readAt === 'string';
  const age = isValid ? probe.now().getTime() - Date.parse(kept?.readAt ?? '') : Number.NaN;
  const isFresh = Number.isFinite(age) && age >= 0 && age <= MAX_NAMES_AGE_MS;
  let names: string[];
  if (isValid && (isFresh || (kept?.scanMs ?? 0) > SLOW_SCAN_MS)) names = kept?.names ?? [];
  else {
    const start = probe.now().getTime();
    const drives = (probe.listFolders('/mnt') ?? []).filter((name) => /^[a-z]$/.test(name));
    names = [...new Set(drives.flatMap((drive) => probe.listFolders(`/mnt/${drive}/Users`) ?? []).filter(isPersonFolder))];
    const cache: WindowsUsersCache = { names, readAt: probe.now().toISOString(), scanMs: probe.now().getTime() - start };
    // An empty list is kept too: no drive is mounted, and the next run need not look again.
    try {
      if (file) saveMachineState(file, probe, 'windowsUsers', cache);
    } catch {
      // a read-only home: this process keeps the names below
    }
  }
  // Filtered again: a file from an older yokoten, or one edited by hand, may hold a shared folder.
  const result = names.filter(isPersonFolder);
  namesRead.set(probe, result);
  return result;
}

/**
 * The user names of this machine, which git and the forge do not know (#404): the account
 * name, the last folder of each home under a users folder, and in WSL the Windows user name.
 * The Windows name comes from USERPROFILE when WSLENV passes it, else from the folders in
 * `/mnt/<drive>/Users`: the one named like a Linux name, or every person folder when none is.
 * Shared account names (root, runner, test) and names of under 3 characters are left out.
 * It starts no program.
 */
export function machineUserNames(env: Env, probe: UserNameProbe = REAL_USER_PROBE): string[] {
  const read = (get: () => string): string => {
    try {
      return get();
    } catch {
      return '';
    }
  };
  const names = [env.USER, env.LOGNAME, read(() => probe.username())];
  for (const home of [env.HOME, read(() => probe.systemHome()), env.USERPROFILE]) names.push(homeUserName(home) ?? '');
  const isWsl = Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP);
  if (isWsl && !homeUserName(env.USERPROFILE)) {
    const linux = new Set(names.map((name) => (name ?? '').toLowerCase()));
    const windows = windowsUserNames(env, probe);
    const same = windows.filter((name) => linux.has(name.toLowerCase()));
    // No folder named like the Linux user: hide them all, as privacy comes first.
    names.push(...(same.length ? same : windows));
  }
  const kept = new Map<string, string>();
  for (const name of names) {
    const trimmed = (name ?? '').trim();
    const key = trimmed.toLowerCase();
    if (trimmed.length >= 3 && !SHARED_ACCOUNTS.has(key) && !kept.has(key)) kept.set(key, trimmed);
  }
  return [...kept.values()];
}

/**
 * The private-marks text with each block under the old plain header (before #410) split
 * by kind, or null when it has none. A value is a forge login only when it is one of
 * `logins`; an address is a git email; one of `hosts`, or a value with a dot, is a host.
 * Anything else goes under OWN_HEADER, so the check treats it as the owner's: strict.
 * The lines outside those blocks stay as they are.
 */
export function migrateMarks(text: string, { logins, hosts }: { logins: string[]; hosts: string[] }): string | null {
  const lines = text.split('\n');
  if (!lines.some((line) => line.trim() === FOUND_HEADER)) return null;
  const loginSet = new Set(logins.map((login) => login.toLowerCase()));
  const hostSet = new Set(hosts.map((host) => host.toLowerCase()));
  const kindOf = (value: string): string | null => {
    const key = value.toLowerCase();
    if (loginSet.has(key)) return 'forge login';
    if (isEmailShaped(key)) return 'git email';
    if (hostSet.has(key) || key.includes('.')) return 'private remote host';
    return null;
  };
  const out: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].trim() !== FOUND_HEADER) {
      out.push(lines[index]);
      continue;
    }
    // The block runs to the next comment line.
    const values: string[] = [];
    while (index + 1 < lines.length && !lines[index + 1].trim().startsWith('#')) {
      index++;
      const value = lines[index].replace(/\r$/, '').trim();
      if (value) values.push(value);
    }
    const groups = new Map<string | null, string[]>();
    for (const value of values) groups.set(kindOf(value), [...(groups.get(kindOf(value)) ?? []), value]);
    for (const [kind, group] of groups) out.push(kind === null ? OWN_HEADER : foundHeader(kind), ...group);
  }
  const joined = out.join('\n');
  return joined.endsWith('\n') ? joined : `${joined}\n`;
}

/** Write a file in one step: a temp file next to it, then a rename. It keeps the file's mode. */
function replaceFile(link: string, text: string): void {
  // Through a symlink to the file it names: a profile or marks file a dotfile manager links
  // stays a link (#983).
  const file = realPath(link) ?? link;
  const temp = `${file}.${process.pid}.tmp`;
  let mode = 0o600;
  try {
    mode = statSync(file).mode & 0o777;
  } catch {
    // a new file: 600
  }
  try {
    writeFileSync(temp, text, { mode });
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

/**
 * Add the machine's marks that the private-marks file lacks, at its end. It makes the file
 * (mode 600) when it is missing. A block under the old plain header is first split by kind
 * (`migrateMarks`), in one atomic write. Returns the kinds it added, never a value.
 */
export function fillMarks(env: Env, found: MachineMark[]): string[] {
  const file = marksFile(env);
  const logins = found.filter((mark) => mark.kind === 'forge login').map((mark) => mark.value);
  if (existsSync(file)) {
    const hosts = found.filter((mark) => mark.kind === 'private remote host').map((mark) => mark.value);
    const migrated = migrateMarks(readFileSync(file, 'utf8'), { logins: [...readLocalLogins(env), ...logins], hosts });
    if (migrated !== null) replaceFile(file, migrated);
  }
  // Known from the file it writes, so a mark only in the setting's file still goes in (#656).
  const own = writtenMarksOnly(env);
  const known = new Set(loadMarks(own));
  const off = new Set(kindsTurnedOff(env));
  // A git name that is a login is covered by the login's mark (#410, #434): the one added now, or one the file has.
  const loginSet = new Set([...(off.has('forge login') ? [] : logins.map((login) => login.toLowerCase())), ...loadMarkKinds(own).filter((mark) => mark.kind === 'forge login').map((mark) => mark.value)]);
  const added: MachineMark[] = [];
  for (const mark of found.filter((one) => !off.has(one.kind))) {
    const key = mark.value.toLowerCase();
    if (known.has(key)) continue;
    if (mark.kind === 'git name' && (!isPersonName(mark.value) || loginSet.has(key))) continue;
    known.add(key);
    added.push(mark);
  }
  if (!added.length) return [];
  if (!existsSync(file)) writeNew(file, MARKS_HEADER, { mode: 0o600 });
  const text = readFileSync(file, 'utf8');
  // One header per kind, so the check knows a forge login from a mark the owner wrote (#410).
  const kinds = [...new Set(added.map((mark) => mark.kind))];
  const blocks = kinds.map((kind) => `${foundHeader(kind)}\n${added.filter((mark) => mark.kind === kind).map((mark) => mark.value).join('\n')}\n`);
  appendFileSync(file, `${text === '' || text.endsWith('\n') ? '' : '\n'}${blocks.join('')}`);
  return kinds;
}

/**
 * Whether the private-marks files have a mark, of any kind: the ones install found count too
 * (#522). `unreadable` when one of them is there but can't be read (#656).
 */
export function marksState(env: Env): 'some' | 'none' | 'unreadable' {
  try {
    return loadMarks(env).length > 0 ? 'some' : 'none';
  } catch {
    return 'unreadable';
  }
}

/** Whether the private-marks files have a mark. False when they are missing or can't be read. */
export const hasMarks = (env: Env): boolean => marksState(env) === 'some';

/** What doctor says when a private-marks file can't be read (#656), and what to do. */
export const UNREADABLE_MARKS = "a private-marks file can't be read, so the privacy check stops every commit";
export const UNREADABLE_MARKS_FIX = 'make ~/.config/yokoten/private-marks readable, and check that YOKOTEN_PRIVATE_MARKS, if set, names a file you can read';

/** What doctor and install say to do when the private-marks file has no mark. */
export const EMPTY_MARKS_FIX = 'run `yokoten marks add` and type your name, your city or a domain; it is not shown';

/**
 * What doctor says to do when the private-marks file has no mark: the explicit action that
 * fills it from this machine (record 0043 §3: bare doctor writes nothing).
 */
export const FILL_MARKS_FIX = 'run `yokoten marks fill`, and it adds your git name, git email and GitHub login from this machine (never shown)';

/** The offer of the kinds yokoten can't find, when the file has marks: optional, never missing (#522). */
export const offerMarkKinds = (missing: string[]): string => `optional: add ${missing.join(' or ')} too; yokoten can't find them on its own`;
export const OFFER_MARKS_FIX = 'run `yokoten marks add` and type one; it is not shown';

/**
 * The lines install and doctor print after `fillMarks`: the kinds, never the values. The git
 * name has a line of its own (#434). Nothing when nothing was added: the private-marks check
 * gives the file's state, once (#522).
 */
export function filledLines(kinds: string[], file: string): string[] {
  const others = kinds.filter((kind) => kind !== 'git name');
  const lines = kinds.includes('git name') ? [GIT_NAME_ADDED] : [];
  if (others.length) lines.push(`added to ${file} from this machine: ${others.join(', ')} (the values are not shown)`);
  return lines;
}

/** What install says when it adds the git name: never the name. */
export const GIT_NAME_ADDED = 'added your git name to the private marks (not shown)';

// Names a tutorial or a template puts in user.name: they name nobody.
const PLACEHOLDER_NAMES = new Set(['your name', 'john doe', 'jane doe', 'user', 'name', 'admin', 'first last', 'firstname lastname']);

/**
 * Whether a git user.name names a person, so install adds it as a mark: 3 characters or
 * more, not an address, not a placeholder (`your name`, `john doe`), and not an account
 * name every machine of a kind has (`root`, `test`). One word counts too: it may be all
 * the name the owner uses.
 */
export function isPersonName(name: string): boolean {
  const key = name.trim().toLowerCase().replace(/\s+/g, ' ');
  return key.length >= 3 && !key.includes('@') && !PLACEHOLDER_NAMES.has(key) && !SHARED_ACCOUNTS.has(key);
}

// ---- The kinds of mark the owner can turn off (#434) ----

/** The kinds install adds by itself that `yokoten marks off` can turn off, as the command line names them. */
export const SWITCHED_KINDS: Record<string, MachineMark['kind']> = { 'git-name': 'git name', 'git-email': 'git email', 'forge-login': 'forge login' };

/** The kinds the owner turned off with `yokoten marks off`, from machine.json: install and doctor don't add them. */
export function kindsTurnedOff(env: Env): string[] {
  let file: string;
  try {
    file = machineStateFile(env);
  } catch {
    return [];
  }
  const off = readMachineState(file, REAL_USER_PROBE).marksOff;
  const known = Object.values(SWITCHED_KINDS) as string[];
  return Array.isArray(off) ? off.filter((kind): kind is string => typeof kind === 'string' && known.includes(kind)) : [];
}

/** Turn one kind off or back on in machine.json, keeping the other keys. Throws when the file can't be written. */
export function setKindOff(env: Env, kind: string, isOff: boolean): void {
  const rest = kindsTurnedOff(env).filter((one) => one !== kind);
  saveMachineState(machineStateFile(env), REAL_USER_PROBE, 'marksOff', isOff ? [...rest, kind] : rest);
}

/**
 * Add one mark the owner gives, as their own (`yokoten marks add`): at the end of the file,
 * under `# your own marks` when the last part is one yokoten added. It makes the file (mode
 * 600) when it is missing. False when the file has the mark already.
 */
export function addOwnMark(env: Env, value: string): boolean {
  const file = marksFile(env);
  if (loadMarks(writtenMarksOnly(env)).includes(value.toLowerCase())) return false;
  if (!existsSync(file)) writeNew(file, MARKS_HEADER, { mode: 0o600 });
  const text = readFileSync(file, 'utf8');
  const last = text.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('#')).at(-1) ?? '';
  const isFound = last === FOUND_HEADER || last.startsWith(`${FOUND_HEADER}: `);
  appendFileSync(file, `${text === '' || text.endsWith('\n') ? '' : '\n'}${isFound ? `${OWN_HEADER}\n` : ''}${value}\n`);
  return true;
}

/**
 * Take out the marks `drop` picks, and a header yokoten wrote that has no mark left under it.
 * An old plain block is split by kind first, as `fillMarks` does. The owner's comments stay.
 * Returns the marks taken out, never printed.
 */
export function removeMarks(env: Env, drop: (mark: Mark) => boolean): Mark[] {
  const file = marksFile(env);
  if (!existsSync(file)) return [];
  const before = readFileSync(file, 'utf8');
  const text = migrateMarks(before, { logins: readLocalLogins(env), hosts: [] }) ?? before;
  const lines = text.split('\n');
  const read = markLines(text);
  const removed: Mark[] = [];
  const kept = lines.filter((_, index) => {
    const mark = read[index];
    if (!mark || !drop(mark)) return true;
    removed.push(mark);
    return false;
  });
  if (!removed.length) {
    if (text !== before) replaceFile(file, text);
    return [];
  }
  // A header of yokoten's own with only blank lines or another comment after it is left empty: it goes too.
  const isOurs = (line: string) => line.trim() === FOUND_HEADER || line.trim().startsWith(`${FOUND_HEADER}: `) || line.trim() === OWN_HEADER;
  const out = kept.filter((line, index) => {
    if (!isOurs(line)) return true;
    const next = kept.slice(index + 1).find((after) => after.trim() !== '');
    return next !== undefined && !next.trim().startsWith('#');
  });
  replaceFile(file, out.join('\n'));
  return removed;
}

/** How many marks the file holds of each kind, the owner's as `by hand`. Never the values. */
export function countMarkKinds(env: Env): Map<string, number> {
  const counts = new Map<string, number>();
  for (const mark of loadMarkKinds(env)) counts.set(mark.kind ?? 'by hand', (counts.get(mark.kind ?? 'by hand') ?? 0) + 1);
  return counts;
}

/**
 * The kinds of mark yokoten can't find on its own, which the file seems to lack, in plain
 * words. A domain has a dot; anything else not from the machine may be the city. The name
 * is not asked for: install adds the git name (#434). A guess from the shape, so doctor shows it as a note.
 */
export function missingMarkKinds(marks: string[], found: MachineMark[]): string[] {
  const fromMachine = new Set(found.map((mark) => mark.value.toLowerCase()));
  const own = marks.filter((mark) => !fromMachine.has(mark) && !mark.includes('@'));
  const missing: string[] = [];
  if (!own.some((mark) => !/\s/.test(mark) && !isDomainShaped(mark))) missing.push('your city');
  if (!own.some(isDomainShaped)) missing.push('your domains');
  return missing;
}

/** The mailmap yokoten keeps, outside every repo, as git config names it (git expands `~/`). */
export const MAILMAP_SETTING = '~/.config/yokoten/mailmap';
/** The name and address git prints for the owner once the mailmap is set. */
export const MAILMAP_OWNER = 'owner <owner@noreply.invalid>';

/** Whether git's global mailmap.file is yokoten's, another file, or not set. */
export function mailmapState(env: Env): 'ours' | 'other' | 'unset' {
  const value = readGitValue(env, ['config', '--global', '--get', 'mailmap.file']);
  if (!value) return 'unset';
  return value === MAILMAP_SETTING || value === join(paths(env).config, 'mailmap') ? 'ours' : 'other';
}

/** The question install asks before it sets git's global mailmap.file (#985). */
export const MAILMAP_QUESTION = 'Hide your email in git logs that agents read? [Y/n]';

/**
 * Write yokoten's mailmap: one line per owner email (git user.email and the marks shaped
 * like an address), each shown as MAILMAP_OWNER. The file is yokoten's own. Pointing git's
 * global mailmap.file at it changes the user's git config, so install asks first (#985):
 * with no terminal, or no yes, the setting stays unset and the line gives the command.
 * A mailmap.file the user set to another file is theirs: it stays and the line says so.
 */
export function setUpMailmap(env: Env, found: MachineMark[], { ask }: { ask?: Ask } = {}): Partial<Steps> {
  const emails = [...new Set([...found.filter((mark) => mark.kind === 'git email').map((mark) => mark.value), ...loadMarks(env).filter((mark) => /^[^@\s]+@[^@\s]+$/.test(mark))].map((email) => email.toLowerCase()))];
  const file = join(paths(env).config, 'mailmap');
  // The file may hold lines the owner wrote: it only gets the lines it lacks.
  const before = existsSync(file) ? readFileSync(file, 'utf8') : null;
  const mapped = new Set([...(before ?? '').matchAll(/<([^<>\s]+)>\s*$/gm)].map((match) => match[1].toLowerCase()));
  const missing = emails.filter((email) => !mapped.has(email));
  if (before === null) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, MAILMAP_HEADER, { mode: 0o600 });
  }
  if (missing.length) appendFileSync(file, `${before && !before.endsWith('\n') ? '\n' : ''}${missing.map((email) => `${MAILMAP_OWNER} <${email}>\n`).join('')}`);
  const fileChange: Change = { state: before === null ? 'wrote' : missing.length ? 'added' : 'kept', kind: 'file', path: file, ...(missing.length && before !== null ? { note: `${missing.length} line(s)` } : {}) };
  const state = mailmapState(env);
  const turnOn = `run \`git config --global mailmap.file ${MAILMAP_SETTING}\``;
  if (state === 'other') {
    return { changes: [fileChange, { state: 'kept', kind: 'setting', path: 'mailmap.file', yours: true }], notes: [finding('mailmap', 'your own git mailmap.file setting stays', `add the lines of ${file} to that file`)] };
  }
  if (state === 'unset' && !(ask && isYes(ask(MAILMAP_QUESTION)))) {
    // Install changes the user's git config only when they say yes (#985).
    return { changes: [fileChange, { state: 'skipped', kind: 'setting', path: 'mailmap.file', note: 'install changes your git config only when you say yes' }], notes: [finding('mailmap', MAILMAP_NOT_ON, turnOn, { why: 'a mailmap makes git print a placeholder in place of your email' })] };
  }
  // git prints nothing when it sets a value, so the setting is read back to see it took.
  if (state === 'unset') readGitValue(env, ['config', '--global', 'mailmap.file', MAILMAP_SETTING]);
  if (mailmapState(env) !== 'ours') {
    return { changes: [fileChange, { state: 'failed', kind: 'setting', path: 'mailmap.file' }], problems: [finding('mailmap', 'git config could not set mailmap.file', turnOn, { why: 'a mailmap makes git print a placeholder in place of your email' })] };
  }
  return { changes: [fileChange, { state: state === 'ours' ? 'kept' : 'added', kind: 'setting', path: 'mailmap.file', note: 'git log and git show print your emails as a placeholder' }] };
}

/** What install says when the global mailmap.file stays unset: git still prints the owner's email. */
export const MAILMAP_NOT_ON = 'hide your email in git logs: not on yet';

/**
 * One privacy step of install or doctor, which never stops them: an error becomes one plain
 * line that says what was skipped and why.
 */
export function trySafely(what: string, step: () => string[]): string[] {
  try {
    return step();
  } catch (err) {
    return [`skipped ${what}: ${String((err as Error)?.message ?? err).split('\n')[0]}`];
  }
}
