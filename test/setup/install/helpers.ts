// What the install tests share (test/setup/install/*.test.ts): install and uninstall for a
// sandbox in this process, and the short rows a test reads a result by.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { sep } from 'node:path';
import { type SetupResult } from '../../../src/setup/files.ts';
import { install, uninstall } from '../../../src/setup/install.ts';

/** The system these tests run on, passed down as a runner passes it. */
export const PLATFORM = process.platform;

/** install for a sandbox in this process, as `yokoten install` runs it in a pipe: nobody to ask. */
export const installIn = (sandbox: { env: NodeJS.ProcessEnv; repo: string }, more: Parameters<typeof install>[1] = {}): SetupResult => install(sandbox.env, { cwd: sandbox.repo, platform: PLATFORM, ...more });

/** uninstall for a sandbox in this process. */
export const uninstallIn = (sandbox: { env: NodeJS.ProcessEnv }): SetupResult => uninstall(sandbox.env, { platform: PLATFORM });

/**
 * A result's changes as short rows a test reads in one look: the state, the kind, the path
 * with the home as ~ and / between folders, then `yours` and the agent when it has them.
 */
export function rowsOf(result: SetupResult, home: string): string[] {
  return result.changes.map((change) => [change.state, change.kind, change.path.split(home).join('~').split(sep).join('/'), ...(change.yours ? ['yours'] : []), ...(change.agent ? [change.agent] : [])].join(' '));
}

/** Assert that `result` holds each row, as rowsOf writes it. */
export function assertRows(result: SetupResult, home: string, ...rows: string[]): void {
  const have = rowsOf(result, home);
  for (const row of rows) assert.ok(have.includes(row), `no change "${row}" in:\n${have.join('\n')}`);
}

/** The text of a result's notes and problems, home as ~, for a test that looks for one. */
export const findingsOf = (result: SetupResult, home: string): string => [...result.notes, ...result.problems].map((f) => `${f.id}: ${f.what}; ${f.why}; ${f.fix}`.split(home).join('~').split(sep).join('/')).join('\n');
