// `yokoten` with no command: the first run that installs, adds the rules and shows the road.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Writable } from 'node:stream';
import { ghIn } from '../../../host/github/index.ts';
import { type Env } from '../../../rules/config.ts';
import { hideHome, homeOf, NO_HOME } from '../../../rules/privacy.ts';
import { init } from '../../../setup/init.ts';
import { agentsHere, install, isMachineSetUp, isYes, launcherDir, skillNames } from '../../../setup/install.ts';
import { VERSION } from '../../../setup/files.ts';
import { count, type Invocation, nextLine, noRootFinding, noRootScreen, print, rootOf, row, screen, title } from '../../shared.ts';
import { askWhenTerminal, NEEDS_HAND } from './ask.ts';
import { guardedAgents, installScreen } from './install.ts';
import { projectScreen } from './init.ts';

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
  // No home folder means no place to install into (#548). Say it the way install does,
  // instead of letting a path throw: a beginner reads one plain line, not a stack trace.
  if (!homeOf(env)) {
    print(invocation, [`${NO_HOME}. Set HOME to your home folder's full path and run \`yokoten\` again.`], invocation.stderr);
    return 1;
  }
  const isMachineMissing = !isMachineSetUp(env);
  const isProjectMissing = !hasProjectRules(root);
  const ask = askWhenTerminal(invocation);
  // Rustup's way (#1027): a person sees one screen of what changes, then answers one
  // question. An agent, CI or a pipe has nobody to ask and goes ahead, as before.
  if ((isMachineMissing || isProjectMissing) && ask) {
    print(invocation, previewLines(env, isMachineMissing, isProjectMissing));
    if (!isYes(ask(SET_UP_QUESTION))) {
      print(invocation, title(VERSION, 'nothing changed'));
      return 0;
    }
    print(invocation, ['']);
  }
  // Each step that ran reports whether it is done: an install that failed is not "Setup is done" (#548).
  // A step that went well is one row on doctor's screen; one that failed keeps its whole screen,
  // since a problem is never folded (#1027).
  const doneRows: string[] = [];
  const failedScreens: string[][] = [];
  if (isMachineMissing) {
    const done = install(env, { cwd, gh: ghIn(cwd, env, 3000), ask, platform: invocation.platform });
    // No label column: doctor's rows below have none, so every row's text starts in one column (#1115).
    if (done.ok) doneRows.push(...row('ok', `guard on for ${guardedAgents(done.lines).join(', ') || 'your agents'} on this computer`));
    else failedScreens.push(installScreen(invocation, done.lines, done.ok, true));
  }
  if (isProjectMissing) {
    const done = init(root, env, undefined, { ask, platform: invocation.platform });
    const wrote = done.lines.filter((line) => /^wrote /.test(line)).length;
    if (done.ok && !done.lines.some((line) => NEEDS_HAND.test(line))) doneRows.push(...row('ok', `${count(wrote, 'file')} written in this project, none of yours changed`));
    else failedScreens.push(projectScreen(done.lines, done.ok, true));
  }
  for (const screen of failedScreens) print(invocation, [...screen, '']);
  const ran = isMachineMissing || isProjectMissing;
  const runDoctor = (await import('../advice/doctor.ts')).runDoctor;
  if (!ran) return runDoctor(invocation);
  // One screen (#1027): doctor's title, what this run did, the road, and one Next line, to keep
  // what it wrote. Doctor's own Next waits for that commit; its More line stays last.
  const held: string[] = [];
  const sink = new Writable({ write: (chunk, _, done) => { held.push(String(chunk)); done(); } });
  const code = await runDoctor({ ...invocation, stdout: sink });
  print(invocation, startScreen(held.join('').replace(/\n$/, '').split('\n'), doneRows));
  return code;
}

/**
 * The first run's one screen (#1027) from doctor's lines and the rows of what this run did:
 * doctor's title says it set things up, then this run's rows, then the rest of doctor's screen
 * (its problems and the road, whatever that holds), one Next line to keep what was written, and
 * doctor's More line last. Each block is told apart by one blank line (#1115), decided from the
 * blocks themselves: doctor's own Next waits for that commit.
 */
export function startScreen(doctorLines: readonly string[], doneRows: readonly string[]): string[] {
  const next = doctorLines.findIndex((line) => line.startsWith('Next: '));
  const moreAt = doctorLines.findIndex((line) => line.startsWith('More: '));
  const more = moreAt === -1 ? [] : doctorLines.slice(moreAt);
  const body = doctorLines.slice(0, next === -1 ? (moreAt === -1 ? doctorLines.length : moreAt) : next);
  while (body.length && body.at(-1) === '') body.pop();
  // A broken self-test line may lead the title.
  const titleAt = Math.max(0, body.findIndex((line) => line.startsWith('yokoten doctor · ')));
  const lead = body.slice(0, titleAt).filter(Boolean);
  const head = body[titleAt]?.replace(/^yokoten doctor · /, `yokoten ${VERSION} · set up; `) ?? '';
  const rest = body.slice(titleAt + 1);
  while (rest[0] === '') rest.shift();
  return screen(lead, [head], doneRows, rest, [...nextLine('git add -A && git commit -m "chore: add yokoten"'), ...more]);
}

/** True when init has already put the rules in this project. */
export const hasProjectRules = (root: string): boolean =>
  existsSync(resolve(root, 'AGENTS.md')) && existsSync(resolve(root, 'yokoten.json'));

/** What the first run will write, before it asks: two groups, then the way back (#1027). */
export function previewLines(env: Env, isComputer: boolean, isProject: boolean): string[] {
  const out = title(VERSION, 'first run: here is what changes');
  out.push('');
  if (isComputer) {
    const agents = ['Claude Code', ...agentsHere(env)];
    out.push(`  computer   guard on for ${agents.join(', ')}, ${skillNames().length} skills`);
    out.push(`             the runtime and a yokoten command in ${hideHome(launcherDir(homeOf(env) ?? ''), env)}`);
  }
  if (isProject) {
    out.push(`  project    AGENTS.md, the commit check, CI and the templates`);
    out.push('             nothing of yours is overwritten');
  }
  out.push('');
  out.push(isComputer ? 'Undo: `yokoten uninstall`' : 'Undo: `git restore .`');
  return out;
}

/** The question the first run and install ask before they write (#1027). */
export const SET_UP_QUESTION = 'Set up yokoten here? [Y/n]';

