// A desk's own clone (issue #1054, step 5 of the refactor plan): `../<repo>-desks/<n>/`, next
// to the project, one folder for all its desks. The clone gets the branch `desk/<n>` from
// the remote's main, origin pointing back at the remote, the project's hooks folder and git
// name, and `npm ci --ignore-scripts` when there is a lock file. Nothing is pushed.

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Env } from '../../rules/config.ts';

/** What one program run gives back. */
export type Ran = { status: number; stdout: string; stderr: string };

/** Runs a program with no shell, in `cwd`, with `extra` added to its environment. A test passes one that records the calls. */
export type Run = (file: string, args: string[], cwd: string, extra?: Env) => Ran;

/** The real runner: no shell, a time limit, and the given environment. */
export const runWith = (env: Env): Run => (file, args, cwd, extra) => {
  const ran = spawnSync(file, args, { cwd, env: extra ? { ...env, ...extra } : env, encoding: 'utf8', timeout: 600_000, shell: false, windowsHide: true });
  return { status: ran.status ?? 1, stdout: ran.stdout ?? '', stderr: ran.error ? ran.error.message : (ran.stderr ?? '') };
};

/** The folder that holds every desk of the project at `root`: `../<repo>-desks`. */
export const desksHome = (root: string): string => join(dirname(root), `${basename(root)}-desks`);

/** The branch a desk works on. */
export const deskBranch = (name: string): string => `desk/${name}`;

/** The files a desk's clone never commits: the board's status file. */
export const DESK_EXCLUDE = ['.yokoten-agent.json'];

/** The first line of a failed run, for a one-line reason. */
const firstLine = (ran: Ran): string => (ran.stderr || ran.stdout).split('\n').map((line) => line.trim()).find(Boolean) ?? `exit ${ran.status}`;

export interface CloneRequest {
  /** The project's main checkout. */
  root: string;
  /** The desk's name: the issue number, or a short name made from a task. */
  name: string;
  run: Run;
  /** Run `npm ci --ignore-scripts` when the project has a lock file. */
  install: boolean;
}

/**
 * Make the desk's clone, or say in one line why it can't. The base is the remote's main,
 * fetched now; with no network, the project's own checked-out commit. Returns the desk
 * folder and the commit its branch starts from.
 */
export function makeClone({ root, name, run, install }: CloneRequest): { desk: string; base: string } | { problem: string } {
  const desk = join(desksHome(root), name);
  if (existsSync(desk)) return { problem: `${desk} is already there. Run \`yokoten desk ${name}\` to go on with it, or move it away.` };
  const git = (args: string[], cwd = desk) => run('git', args, cwd);
  const cloned = git(['clone', '-q', '--no-checkout', root, desk], dirname(root));
  if (cloned.status !== 0) return { problem: `git clone failed: ${firstLine(cloned)}` };
  const origin = git(['remote', 'get-url', 'origin'], root);
  if (origin.status === 0 && origin.stdout.trim()) git(['remote', 'set-url', 'origin', origin.stdout.trim()]);
  // The project's own git name and hooks folder: the agent's commits run the commit check inside the fence.
  for (const key of ['user.name', 'user.email', 'core.hooksPath']) {
    const value = git(['config', '--local', '--get', key], root);
    if (value.status === 0 && value.stdout.trim()) git(['config', key, value.stdout.trim()]);
  }
  const fetched = origin.status === 0 ? git(['fetch', '-q', 'origin', 'main']) : { status: 1, stdout: '', stderr: '' };
  const start = fetched.status === 0 ? 'FETCH_HEAD' : git(['rev-parse', 'HEAD'], root).stdout.trim();
  const branched = git(['checkout', '-q', '-b', deskBranch(name), start]);
  if (branched.status !== 0) return { problem: `git checkout failed: ${firstLine(branched)}` };
  appendFileSync(join(desk, '.git', 'info', 'exclude'), `${DESK_EXCLUDE.join('\n')}\n`);
  if (install && existsSync(join(desk, 'package-lock.json'))) {
    const installed = run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], desk);
    if (installed.status !== 0) return { problem: `npm ci failed in ${desk}: ${firstLine(installed)}. Run it again with --no-install to skip it.` };
  }
  return { desk, base: git(['rev-parse', 'HEAD']).stdout.trim() };
}
