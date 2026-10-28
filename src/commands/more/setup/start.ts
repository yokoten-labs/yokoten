// `yokoten` with no command: the first run that installs, adds the rules and shows the road.
//
// It reads, runs install and init when they are missing (each returns a SetupResult), reads
// doctor's report, and prints one screen built from those three: nothing here reads a printed
// line back (plan 6.3, #1115).

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ghIn, ghLaterIn, readServer } from '../../../host/github/index.ts';
import { readGiteaServer } from '../../../host/gitea.ts';
import { hostOf } from '../../../host/hosts.ts';
import { type Env, loadConfig } from '../../../rules/config.ts';
import { hideHome, homeOf } from '../../../rules/privacy.ts';
import { columnFor, table } from '../../../rules/text/screen.ts';
import { gitConfig } from '../../../run/check.ts';
import { doctor, type DoctorReport, doctorSummary, problemRows, readAtOnce, SERVER_TIMEOUT_MS, shortLines } from '../../../setup/doctor/index.ts';
import { type Change, type Place, type SetupResult, VERSION } from '../../../setup/files.ts';
import { HOOKS_PATH, init } from '../../../setup/init.ts';
import { agentsHere, install, isMachineSetUp, isYes, launcherDir, skillNames } from '../../../setup/install.ts';
import { askLine, askOnTerminal, count, fail, type Invocation, noRootFinding, noRootScreen, noteLine, print, rootOf, row, screen, spaced, terminalOf, title, wrap } from '../../shared.ts';
import { commitCommand } from './init.ts';
import { guardedAgents, placeOf } from './install.ts';

/**
 * `yokoten` with no command: the one command that gets a project running (#548). It installs
 * on the machine when that is missing, adds the rules to this project when that is missing,
 * and ends with the road, so a beginner reads the next step and nothing else. Each step is
 * already safe by default: install writes its own files, and init only adds (#120, record 0014).
 */
export async function runStart(invocation: Invocation): Promise<number> {
  const { env, cwd } = invocation;
  const root = rootOf(cwd, env);
  // Outside a project yokoten writes nothing: the first step is git's, not ours.
  if (!root) {
    const missing = noRootFinding(cwd, env);
    print(invocation, noRootScreen(undefined, missing), invocation.stderr);
    return 1;
  }
  // No home folder means no place to install into (#548): one failure, instead of a path that throws.
  if (!homeOf(env)) return fail(invocation, 'no home folder found (HOME is empty or not a full path), so nothing was set up', "set HOME to your home folder's full path, then run `yokoten` again");
  const isMachineMissing = !isMachineSetUp(env);
  const isProjectMissing = !hasProjectRules(root);
  if (!isMachineMissing && !isProjectMissing) return (await import('../advice/doctor.ts')).runDoctor(invocation);
  const { stdin, stdout } = invocation;
  const ask = terminalOf(invocation).canAsk && stdin.fd !== null ? askOnTerminal(stdout, stdin.fd) : undefined;
  // Rustup's way (#1027): a person sees one screen of what changes, then answers one
  // question. An agent, CI or a pipe has nobody to ask and goes ahead, as before.
  if (ask) {
    print(invocation, previewLines(env, isMachineMissing, isProjectMissing));
    if (!isYes(ask(SET_UP_QUESTION))) {
      print(invocation, title(VERSION, 'nothing changed'));
      return 0;
    }
  }
  const platform = invocation.platform ?? 'linux';
  const installed = isMachineMissing ? install(env, { cwd, gh: ghIn(cwd, env, 3000), ask, platform }) : undefined;
  const added = isProjectMissing ? init(root, env, undefined, { ask, platform }) : undefined;
  const { ok, report } = await doctorReport(invocation, root);
  print(invocation, startScreen({ ...(installed ? { install: installed } : {}), ...(added ? { init: added } : {}), report, place: placeOf(invocation) }));
  return ok && (installed?.ok ?? true) && (added?.ok ?? true) ? 0 : 1;
}

/**
 * Doctor's report for this project, read as full doctor reads it: the code host's settings
 * first, under one budget, with one note to a person while they load (#1039).
 */
async function doctorReport(invocation: Invocation, root: string): Promise<{ ok: boolean; report: DoctorReport }> {
  const { env } = invocation;
  const config = loadConfig(root);
  const host = hostOf(gitConfig(root, 'remote.origin.url', env), config.host);
  const isRead = host.kind === 'github' || host.kind === 'gitea';
  if (isRead && terminalOf(invocation).isPerson) print(invocation, noteLine(`reading ${host.kind === 'gitea' ? 'Gitea' : 'GitHub'} settings, ${SERVER_TIMEOUT_MS / 1000} seconds at most...`), invocation.stderr);
  const server = host.kind === 'gitea' ? await readGiteaServer(host, env) : host.kind === 'github' ? (await readAtOnce((gh) => readServer(gh, host.repo), ghLaterIn(root, env), SERVER_TIMEOUT_MS)).result : undefined;
  return doctor(root, { env, config, session: false, host, ...(server ? { server } : {}), gh: ghIn(root, env, SERVER_TIMEOUT_MS), fillMarks: true, ...(invocation.platform ? { platform: invocation.platform } : {}) });
}

/** What the first run's screen is built from: the parts that ran, doctor's report after them, and the place. */
export interface StartParts {
  install?: SetupResult;
  init?: SetupResult;
  report: DoctorReport;
  place: Place;
}

/** Whether a change wrote something on this run. */
const isWritten = (change: Change): boolean => ['wrote', 'updated', 'linked', 'added'].includes(change.state);

/** The files init wrote in the project: not the runtime copy, an agent's own settings or the git setting. */
const projectFiles = (result: SetupResult): Change[] => result.changes.filter((change) => isWritten(change) && change.kind !== 'runtime' && change.kind !== 'agent' && change.path !== HOOKS_PATH);

/** A part that ran: one ok row when it is done, else what it did and each problem with its fix (#1027: a problem is never folded). */
function partItems(result: SetupResult, done: string, missing: string): string[][] {
  const isDone = result.ok && !result.problems.length;
  if (isDone) return [row('ok', done)];
  const problems = problemRows(result.problems);
  return problems.length ? problems : [row('MISSING', missing)];
}

/**
 * The first run's one screen (#1027, #1115): doctor's default screen with a title that says the
 * first run set things up, a row for each part that ran right under it, and the command that
 * keeps what init wrote as the one Next line. Built from the results, never from printed text.
 */
export function startScreen({ install, init, report, place }: StartParts): string[] {
  const items: string[][] = [];
  if (install) {
    const agents = guardedAgents(install);
    // A part that is not done still says the guard it did turn on.
    if (!(install.ok && !install.problems.length) && agents.length) items.push(row('ok', `guard on for ${agents.join(', ')} on this computer`));
    items.push(...partItems(install, `guard on for ${agents.join(', ') || 'your agents'} on this computer`, 'this computer is only partly set up'));
  }
  const written = init ? projectFiles(init).length : 0;
  if (init) {
    const kept = init.changes.some((change) => change.yours) ? 'your own files kept' : 'none of yours changed';
    items.push(...partItems(init, `${count(written, 'file')} written in this project, ${kept}`, 'this project is only partly set up'));
  }
  const isDone = (install?.ok ?? true) && (init?.ok ?? true) && !install?.problems.length && !init?.problems.length;
  const heading = title(VERSION, `${isDone ? 'set up' : 'partly set up'}; ${doctorSummary(report)}`);
  return shortLines(report, { title: heading, lead: [spaced(items)], ...(written ? { next: commitCommand(place.platform) } : {}) });
}

/** True when init has already put the rules in this project. */
export const hasProjectRules = (root: string): boolean =>
  existsSync(resolve(root, 'AGENTS.md')) && existsSync(resolve(root, 'yokoten.json'));

/** What the first run will write, before it asks: one group per place, then the way back (#1027). */
export function previewLines(env: Env, isComputer: boolean, isProject: boolean): string[] {
  const groups: [string, string, string][] = [];
  if (isComputer) {
    const agents = ['Claude Code', ...agentsHere(env)];
    groups.push(['computer', `guard on for ${agents.join(', ')}, ${skillNames().length} skills`, `the runtime and a yokoten command in ${hideHome(launcherDir(homeOf(env) ?? ''), env)}`]);
  }
  if (isProject) groups.push(['project', 'AGENTS.md, the commit check, CI and the templates', 'nothing of yours is overwritten']);
  // Each group is its own item, a blank line between, and every group's text starts in one column.
  const column = columnFor(groups.map(([label]) => label));
  const rows = spaced(groups.map(([label, what, more]) => [...table([[label, what]], column), ...wrap(' '.repeat(2 + column), more)]));
  return screen(title(VERSION, 'first run: here is what changes'), rows, wrap('Undo: ', isComputer ? '`yokoten uninstall`' : '`git restore .`'));
}

/** The question the first run and install ask before they write (#1027). */
export const SET_UP_QUESTION = askLine('Set up yokoten here?');
