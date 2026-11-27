// What the init tests share (test/setup/init/*.test.ts): sandboxes and the short rows a test reads a result by.

import '../../repo/home.ts';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { makeSandbox, makeTempDir } from '../../repo/helpers.ts';
import { type ChangeState } from '../../../src/setup/files.ts';
import { type Finding } from '../../../src/rules/text/message.ts';
import { HOOKS_PATH, init, type InitResult, resultLines, type Step } from '../../../src/setup/init.ts';

/** init in this process, as the data its screens are built from (#1115). */
export const initIn = (sandbox: ReturnType<typeof makeSandbox>, { noCi = false, extra = {} }: { noCi?: boolean; extra?: Record<string, string> } = {}): InitResult =>
  init(sandbox.repo, { ...sandbox.env, ...extra }, undefined, { noCi, platform: process.platform });

/** Whether a step made a change in this state whose words (its note, after the state) match. */
export const has = (result: Step, state: ChangeState, words: RegExp): boolean => result.changes.some((change) => change.state === state && words.test(change.note ?? change.path));

/** The note or problem of a step whose words match, or undefined. */
export const noted = (result: Step, words: RegExp): Finding | undefined => [...result.problems, ...result.notes].find((note) => words.test(note.what));

/** A step in words, one line each, for a failure message. */
export const said = (result: Step): string => resultLines(result).join('\n');

/**
 * A gh first on PATH that answers only the given calls (all its words, joined by spaces)
 * and fails every other one, so the real gh and GitHub are never reached (#313). Each
 * call is logged, one a line, for `ghCalls`.
 */
export function stubGh(sandbox: ReturnType<typeof makeSandbox>, answers: Record<string, string>): Record<string, string> {
  const bin = join(sandbox.home, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, 'gh'),
    `#!/usr/bin/env node
// A dynamic import works whether Node loads this file as CommonJS or as an ES module.
import('node:fs').then(({ appendFileSync }) => {
  const answers = ${JSON.stringify(answers)};
  const call = process.argv.slice(2).join(' ');
  appendFileSync(${JSON.stringify(join(sandbox.home, 'gh.log'))}, call + '\\n');
  const said = answers[call];
  if (said === undefined) process.exit(1);
  console.log(said);
});
`,
  );
  chmodSync(join(bin, 'gh'), 0o755);
  return { PATH: `${bin}:${process.env.PATH}` };
}

/** The calls the gh from `stubGh` got, in order. */
export const ghCalls = (sandbox: ReturnType<typeof makeSandbox>): string[] => {
  const log = join(sandbox.home, 'gh.log');
  return existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
};

/** Whether the step's first change is git pointed at .githooks: the commit check leads the list (#654). */
export const leadsWithHookOn = (result: Step): boolean => result.changes[0]?.path === HOOKS_PATH && result.changes[0]?.note === 'the commit check, run from .githooks';

/** A folder with these files, plain fs: no git and no init, only the folder's own files. */
export const folderWith = (files: Record<string, string>): string => {
  const root = makeTempDir();
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
};

export const NO_SYMLINK = process.platform === 'win32' && 'Windows makes a symlink only with Developer Mode or admin rights';

/** A home folder for one agent, so init sees it as installed here. */
export const home = (sandbox: ReturnType<typeof makeSandbox>, ...parts: string[]): string => {
  const dir = join(sandbox.home, ...parts);
  mkdirSync(dir, { recursive: true });
  return dir;
};
