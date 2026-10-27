// `yokoten install` and `uninstall`: put yokoten on this computer, or take it off.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ghIn } from '../../../host/github/index.ts';
import { homeOf } from '../../../rules/privacy.ts';
import { install, isYes, launcherDir, uninstall } from '../../../setup/install.ts';
import { VERSION } from '../../../setup/files.ts';
import { type Invocation, moreLine, nextLine, parse, print, row, spaced, title, usage, wrap } from '../../shared.ts';
import { askWhenTerminal, remaining, ROW_TEXT_INDENT } from './ask.ts';
import { previewLines, SET_UP_QUESTION } from './start.ts';

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
/** The home folder as `~`, so a screen measures what a reader sees (#1027, R9). */
const shownPath = (invocation: Invocation, path: string): string => {
  const home = homeOf(invocation.env);
  return home ? path.split(home).join('~') : path;
};

/** The agents whose guard install really runs: a file of the user's own is not the guard. */
export function guardedAgents(lines: string[]): string[] {
  const others = lines
    .filter((line) => !/\(yours, not yokoten's\)/.test(line))
    .map((line) => /(?:added|kept|updated|wrote) the (\w[\w ]*?) (?:SessionStart doctor|command guard) in /.exec(line)?.[1])
    .filter((name): name is string => name !== undefined);
  const isClaude = lines.some((line) => /the (?:SessionStart doctor|user-level command guard)$/.test(line) || /Claude Code hooks/.test(line));
  return [...(isClaude ? ['Claude Code'] : []), ...new Set(others)];
}

/** The one screen `yokoten install` shows, from the report it wrote (#1027). */
export function installScreen(invocation: Invocation, lines: string[], ok: boolean, isFirstRun = false): string[] {
  if (ok && !lines.some((line) => CHANGED.test(line))) {
    return [...title('install', 'already set up here, nothing changed'), ...moreLine('`yokoten install --list` names every file')];
  }
  const out = title(isFirstRun ? VERSION : 'install', isFirstRun ? 'first run' : ok ? 'this computer is set up' : 'this computer is partly set up');
  out.push('');
  const guarded = guardedAgents(lines);
  // Each row is one item: a blank line goes between them once one wraps (#1115).
  const items: string[][] = [];
  // No agent guarded is never "ok": the row says so, and the problem rows below say why (#1027 review).
  items.push(guarded.length ? row('ok', `on for ${guarded.join(', ')}`, 'guard') : row('MISSING', 'not on for any agent yet', 'guard'));
  const skills = reportedSkills(lines);
  if (skills.length) items.push(row('ok', skills.join(', '), 'skills'));
  const absent = absentAgents(lines);
  if (absent.length) items.push(row("can't check", `${absent.length} not installed here; run install again later`, 'other AIs'));
  const pathLine = lines.find((line) => / is not on your PATH/.test(line));
  if (pathLine) {
    items.push([
      ...row('note', `${shownPath(invocation, /^(\S+) is not on your PATH/.exec(pathLine)?.[1] ?? launcherDir(homeOf(invocation.env) ?? ''))} is not on your PATH yet`, 'command'),
      ...(invocation.platform === 'win32'
        ? wrap(ROW_TEXT_INDENT, 'Windows: "Edit environment variables for your account"')
        : wrap(ROW_TEXT_INDENT, 'add this line to your shell profile: export PATH="$HOME/.local/bin:$PATH"')),
    ]);
  }
  out.push(...spaced(items));
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
export function uninstallScreen(lines: string[], ok: boolean): string[] {
  // Say why there is nothing to remove, so the screen means something to a newcomer (#1115).
  if (!lines.some((line) => /^removed /.test(line))) return title('uninstall', 'nothing to remove: yokoten is not installed on this computer');
  const skills = new Set(lines.map((line) => /^removed skill ([\w-]+) in /.exec(line)?.[1]).filter(Boolean)).size;
  const agents = lines.filter((line) => /^removed agent /.test(line)).length;
  const hooks = lines.filter((line) => /^removed the .*(doctor|guard|hooks)/.test(line)).length;
  const removed = [skills && `${skills} skill${skills === 1 ? '' : 's'}`, agents && `${agents} agents`, hooks && `${hooks} hooks`].filter(Boolean);
  const out = title('uninstall', ok ? 'removed what install wrote' : 'removed some of what install wrote');
  out.push('');
  // No label column, so the MISSING rows below start their text in the same column (#1115).
  if (removed.length) out.push(...row('ok', `removed ${removed.join(', ')}`));
  if (ok) out.push(...row('ok', 'kept your own files, keys and private marks'));
  const problems = lines.filter((line) => !/^(removed|nothing to remove|not there|kept|yokoten: cleaned)/.test(line));
  if (problems.length) out.push('', ...problems.flatMap((line) => row('MISSING', line)));
  out.push('');
  out.push(`To install again: \`yokoten install\``);
  return out;
}

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
  const done = install(invocation.env, { cwd: invocation.cwd, gh: ghIn(invocation.cwd, invocation.env, 3000), ask, platform: invocation.platform });
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

