// `yokoten install` and `uninstall`: put yokoten on this computer, or take it off.
//
// Each runner reads the invocation once, gets a SetupResult from src/setup/install.ts and
// prints one screen built from it: nothing here reads a printed line back (plan 6.3, #1115).

import { existsSync } from 'node:fs';
import { posix, resolve, win32 } from 'node:path';
import { ghIn } from '../../../host/github/index.ts';
import { homeOf } from '../../../rules/privacy.ts';
import { type Finding, fixCommand } from '../../../rules/text/message.ts';
import { install, isLauncherOnPath, isYes, NOT_INSTALLED, PLUGIN_BRINGS, uninstall, WINDOWS_PATH_STEP } from '../../../setup/install.ts';
import { type Change, describeChange, type Place, type SetupResult, VERSION, YOUR_EDIT } from '../../../setup/files.ts';
import { count, failure, field, type Invocation, moreLine, nextLine, parse, print, row, screen, spaced, title, underRow, usage, wrap } from '../../shared.ts';
import { askWhenTerminal } from './ask.ts';
import { previewLines, SET_UP_QUESTION } from './start.ts';

/** A change that wrote, added, updated, linked or removed something: a run with none changed nothing. */
const isChange = (change: Change): boolean => ['wrote', 'added', 'updated', 'linked', 'removed'].includes(change.state);

/** A hook whose guard runs: written or kept by install, never a file of the user's, or brought by the plugin. */
const isGuarding = (change: Change): boolean =>
  change.kind === 'hook' && (change.note === PLUGIN_BRINGS || (['wrote', 'added', 'updated', 'kept'].includes(change.state) && change.yours !== true));

/** The agents whose guard install really runs, each once, in the order install set them up. */
export function guardedAgents(result: SetupResult): string[] {
  return [...new Set(result.changes.filter(isGuarding).map((change) => change.agent ?? 'Claude Code'))];
}

/** The last part of a path, read the way the platform the screen is for writes paths. */
const pathsOf = (platform: NodeJS.Platform) => (platform === 'win32' ? win32 : posix);

/** A path as a person reads it: the home folder as `~` (#1027, R9). */
const shownPath = (path: string, home: string | null): string => (home ? path.split(home).join('~') : path);

/** The row's label for a problem, by the rule behind it, so every row's text starts in one column. */
function problemLabel(problem: Finding): string {
  if (/hook$|guard$/.test(problem.id)) return 'guard';
  if (problem.id === 'private-marks') return 'marks';
  if (problem.id === 'mailmap') return 'email';
  return 'setup';
}

/** A part of a finding as a sentence: a capital first, a full stop last. */
const asSentence = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}${/[.!?]$/.test(text) ? '' : '.'}`;

/**
 * One problem as a MISSING row: what is wrong, why, then the command on its own Fix line
 * (#1115). With `hasLabel` false the row has no label, for a screen whose rows have none.
 */
function problemItem(problem: Finding, home: string | null, hasLabel = true): string[] {
  const command = fixCommand(problem.fix);
  const what = shownPath(problem.what, home);
  return [
    ...(hasLabel ? row('MISSING', what, problemLabel(problem)) : row('MISSING', what)),
    ...underRow(asSentence(problem.why), hasLabel),
    ...(command ? underRow(`Fix: \`${command.command}\``, hasLabel) : underRow(asSentence(problem.fix), hasLabel)),
  ];
}

/** The PATH row: how the shell finds `yokoten`, said for the platform the screen is for (#1038). */
function pathItem(result: SetupResult, place: Place): string[] {
  const launcher = result.changes.find((change) => change.kind === 'launcher' && change.state !== 'removed' && change.yours !== true);
  if (place.launcherOnPath || !launcher) return [];
  const dir = shownPath(pathsOf(place.platform).dirname(launcher.path), place.home);
  const profile = result.changes.find((change) => change.kind === 'profile' && (change.state === 'added' || change.state === 'kept'));
  if (profile) return [...row('note', `${shownPath(profile.path, place.home)} adds ${dir} to your PATH`, 'command'), ...underRow('open a new shell, then type `yokoten`')];
  const head = row('note', `${dir} is not on your PATH yet`, 'command');
  if (place.platform === 'win32') return [...head, ...underRow(`${WINDOWS_PATH_STEP}.`)];
  return [...head, ...underRow('add this line to your shell profile:'), ...underRow('`export PATH="$HOME/.local/bin:$PATH"`')];
}

/** The rows of what install did: the guard, the skills, the other agents, the PATH, the notes. */
function installItems(result: SetupResult, place: Place): string[][] {
  const items: string[][] = [];
  const guarded = guardedAgents(result);
  // No agent guarded is never "ok": the row says so, and the problem rows below say why (#1027 review).
  items.push(guarded.length ? row('ok', `on for ${guarded.join(', ')}`, 'guard') : row('MISSING', 'not on for any agent yet', 'guard'));
  const skills = [...new Set(result.changes.filter((change) => change.kind === 'skill' && change.state !== 'removed' && change.yours !== true).map((change) => pathsOf(place.platform).basename(change.path)))];
  if (skills.length) items.push(row('ok', skills.join(', '), 'skills'));
  const absent = result.changes.filter((change) => change.kind === 'hook' && change.state === 'skipped' && change.note === NOT_INSTALLED).length;
  if (absent) items.push(row('note', `${absent} not installed here; run install again later`, 'other AIs'));
  items.push(pathItem(result, place));
  if (result.changes.some((change) => change.note === YOUR_EDIT)) items.push(row('note', 'your own edits stay; the newest copies are in the kit', 'kept'));
  const mailmap = result.changes.find((change) => change.kind === 'setting' && change.path === 'mailmap.file' && change.state === 'skipped');
  const turnOn = mailmap && result.notes.map((note) => fixCommand(note.fix)).find((command) => command?.command.startsWith('git config'));
  // The command stays whole on a line of its own, so it fits 80 columns and copies as one.
  if (mailmap) items.push([...row('note', 'hide your email in git logs: not on yet', 'email'), ...(turnOn ? [...underRow('to turn it on:'), ...underRow(`\`${turnOn.command}\``, false)] : [])]);
  items.push(...result.problems.map((problem) => problemItem(problem, place.home)));
  return items.filter((item) => item.length);
}

/**
 * The one screen `yokoten install` shows, from its result (#1027): a title that says what is
 * true now, one row per part, the problems, then the next command. In a first run the
 * project's screen follows, so `isFirstRun` leaves the next command to it.
 */
export function installScreen(result: SetupResult, place: Place, { isFirstRun = false }: { isFirstRun?: boolean } = {}): string[] {
  const more = moreLine('`yokoten install --list` names every file');
  if (!result.ok && !result.changes.length) {
    const [problem] = result.problems;
    return failure('install', problem?.what ?? 'nothing was set up', problem?.fix ?? 'yokoten install');
  }
  if (result.ok && !result.changes.some(isChange) && !result.problems.length) return screen(title('install', 'already set up here, nothing changed'), more);
  const head = isFirstRun ? title(VERSION, 'first run') : title('install', installSummary(result));
  if (isFirstRun) return screen(head, spaced(installItems(result, place)));
  return screen(head, spaced(installItems(result, place)), [...nextLine(place.hasProjectRules ? 'yokoten doctor' : 'yokoten init'), ...more]);
}

/** What is true after install, for its title. */
const installSummary = (result: SetupResult): string => (result.ok ? 'this computer is set up' : 'this computer is partly set up');

/** What is true after uninstall, for its title. */
const uninstallSummary = (result: SetupResult): string => (result.ok ? 'removed what install wrote' : 'removed some of what install wrote');

/** The removed changes of one kind, counted: each skill once, though it sits in two folders. */
function removedCount(result: SetupResult, kind: Change['kind']): number {
  const removed = result.changes.filter((change) => change.kind === kind && change.state === 'removed');
  return kind === 'skill' ? new Set(removed.map((change) => posix.basename(change.path.replaceAll('\\', '/')))).size : removed.length;
}

/** The one screen `yokoten uninstall` shows: counts, then the command that puts it back (#1027). */
export function uninstallScreen(result: SetupResult): string[] {
  if (!result.ok && !result.changes.length && result.problems.length) {
    const [problem] = result.problems;
    if (problem) return failure('uninstall', problem.what, problem.fix);
  }
  const problems = result.problems.map((problem) => problemItem(problem, null));
  // Say why there is nothing to remove, so the screen means something to a newcomer (#1115).
  if (!result.changes.some((change) => change.state === 'removed') && !problems.length) return title('uninstall', 'nothing to remove: yokoten is not installed on this computer');
  const skills = removedCount(result, 'skill');
  const agents = removedCount(result, 'agent');
  const hooks = removedCount(result, 'hook');
  const removed = [skills && count(skills, 'skill'), agents && count(agents, 'agent'), hooks && count(hooks, 'hook')].filter(Boolean);
  const rows: string[][] = [];
  if (removed.length) rows.push(row('ok', removed.join(', '), 'removed'));
  if (result.ok) rows.push(row('ok', 'your own files, keys and private marks', 'kept'));
  return screen(
    title('uninstall', uninstallSummary(result)),
    spaced([...rows, ...problems]),
    result.ok ? wrap('To install again: ', '`yokoten install`') : nextLine('yokoten uninstall'),
  );
}

/** `--list`: every change as a row under the title, its state as the mark, then the notes and problems (#1115). */
export function listScreen(command: 'install' | 'uninstall', result: SetupResult, place: Place): string[] {
  const rows = result.changes.map((change) => field(change.state, shownPath(describeChange(change), place.home)));
  const notes = result.notes.map((note) => [...row('note', shownPath(note.what, place.home)), ...underRow(asSentence(shownPath(note.fix, place.home)), false)]);
  const head = command === 'install' ? title('install', installSummary(result)) : title('uninstall', uninstallSummary(result));
  return screen(head, spaced(rows), spaced(notes), spaced(result.problems.map((problem) => problemItem(problem, place.home, false))), result.ok ? [] : nextLine(`yokoten ${command}`));
}

/** The system the command runs on, as the invocation says it (#1000). */
const platformOf = (invocation: Invocation): NodeJS.Platform => invocation.platform ?? 'linux';

/** The place a screen is drawn for, read from the invocation once: the platform is passed down from here (#1000). */
export function placeOf(invocation: Invocation): Place {
  const home = homeOf(invocation.env);
  const platform = platformOf(invocation);
  return {
    platform,
    home,
    hasProjectRules: existsSync(resolve(invocation.cwd, 'AGENTS.md')),
    launcherOnPath: home !== null && isLauncherOnPath(invocation.env, home, platform),
  };
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
  }
  // gh may reach the network for the login: three seconds at most.
  const done = install(invocation.env, { cwd: invocation.cwd, gh: ghIn(invocation.cwd, invocation.env, 3000), ask, platform: platformOf(invocation) });
  const place = placeOf(invocation);
  const isFailed = !done.ok && !done.changes.length;
  print(invocation, options.flags.has('--list') && !isFailed ? listScreen('install', done, place) : installScreen(done, place), isFailed ? invocation.stderr : invocation.stdout);
  return done.ok ? 0 : 1;
}

export function runUninstall(invocation: Invocation): number {
  const options = parse('uninstall', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  const done = uninstall(invocation.env, { platform: platformOf(invocation) });
  const isFailed = !done.ok && !done.changes.length;
  print(invocation, options.flags.has('--list') && !isFailed ? listScreen('uninstall', done, placeOf(invocation)) : uninstallScreen(done), isFailed ? invocation.stderr : invocation.stdout);
  return done.ok ? 0 : 1;
}
