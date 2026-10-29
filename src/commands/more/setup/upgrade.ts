// `yokoten upgrade`: bring the yokoten plugin to the newest version.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { type Env } from '../../../rules/config.ts';
import { enabledPlugin } from '../../../setup/advice/marketplace.ts';
import { failure, type Invocation, nextLine, nextSentence, parse, print, row, screen, spaced, title, underRow, usage } from '../../shared.ts';

/**
 * A marketplace name as Claude Code writes it. The name comes from the user's own files and,
 * on Windows, reaches a `cmd` line, so anything else is refused, not quoted.
 */
const PLAIN_NAME = /^[A-Za-z0-9._-]+$/;

/** A clone over a slow line takes minutes; ten is a hang. */
const CLAUDE_TIMEOUT = 600_000;

/**
 * A per-process git config for each `claude` call: `insteadOf` sends a `git@github.com:`
 * address over HTTPS. Nothing in the user's own git config changes (#950). The entry goes
 * after the ones the user already set this way (a proxy, a credential helper), so theirs stay.
 * A count that is set but is not a small number is one yokoten can't add to safely: null.
 */
function withHttpsGit(env: Env): Env | null {
  const set = env.GIT_CONFIG_COUNT ?? '';
  if (set !== '' && !/^\d{1,3}$/.test(set)) return null;
  const count = set === '' ? 0 : Number(set);
  return {
    ...env,
    GIT_CONFIG_COUNT: String(count + 1),
    [`GIT_CONFIG_KEY_${count}`]: 'url.https://github.com/.insteadOf',
    [`GIT_CONFIG_VALUE_${count}`]: 'git@github.com:',
  };
}

/** One step of an upgrade: the thing it updates, whether it worked, and the last line Claude Code said when it failed. */
export interface UpgradeStep {
  label: string;
  ok: boolean;
  said?: string;
}

/**
 * What `yokoten upgrade` did, as data (#1115): the plugin it found (null without one), each
 * step it ran, and the next thing to do. A check that refused before the first step says why
 * in `refused`, and no step ran. A screen is built from it by `upgradeScreen`.
 */
export interface UpgradeResult {
  ok: boolean;
  plugin: null | { id: string; marketplace: string; channel: string };
  steps: UpgradeStep[];
  refused?: string;
  /** The command to type next, or after a failed step the `claude` command to run by hand. */
  next: string;
}

/**
 * How to start Claude Code. On Windows the native installer puts only `claude.exe` on the PATH,
 * and an npm install puts `claude.cmd`: the first one found in PATH order wins, `.exe` before
 * `.cmd` in the same folder. An `.exe` runs by itself; a `.cmd` needs the shell, which finds it
 * by its name. With neither found, the shell is asked for `claude.cmd`, as before (#1002).
 */
export function claudeCommand(env: Env, platform: NodeJS.Platform): { file: string; shell: boolean } {
  if (platform !== 'win32') return { file: 'claude', shell: false };
  const path = env.PATH ?? env.Path ?? '';
  for (const dir of path.split(';').filter(Boolean)) {
    const exe = join(dir, 'claude.exe');
    if (existsSync(exe)) return { file: exe, shell: false };
    if (existsSync(join(dir, 'claude.cmd'))) return { file: 'claude.cmd', shell: true };
  }
  return { file: 'claude.cmd', shell: true };
}

/**
 * Runs `claude <args>` with `env`. A failure keeps the last line it said, so the user reads
 * Claude Code's own words, and the command to run by hand for the rest. Every word is a fixed
 * one or a name PLAIN_NAME passed, so the Windows shell line holds nothing it reads.
 */
function runClaude(args: string[], env: Env, platform: NodeJS.Platform): { ok: boolean; said: string } {
  const { file, shell } = claudeCommand(env, platform);
  const result = spawnSync(file, args, { env, encoding: 'utf8', windowsHide: true, shell, timeout: CLAUDE_TIMEOUT });
  if (result.error) return { ok: false, said: result.error.message };
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  const said = output.split('\n').map((line) => line.trim()).filter(Boolean).at(-1) ?? '';
  return { ok: result.status === 0, said };
}

/**
 * Brings the yokoten plugin to the newest version: the marketplace, then the plugin, with git
 * told to fetch github.com over HTTPS for these calls. It adds and removes nothing, so a
 * failed step leaves the plugin as it was (#950). Without the plugin it names the one command
 * that installs the newest yokoten and runs nothing. The platform is the invocation's (#1000).
 */
export function upgrade(env: Env, platform: NodeJS.Platform): UpgradeResult {
  const found = enabledPlugin(env);
  if (found === null) return { ok: true, plugin: null, steps: [], next: 'npx yokoten@latest' };
  const plugin = { id: found.id, marketplace: found.marketplace, channel: found.channel };
  const name = plugin.marketplace;
  // Both checks come before the first call: a refusal changes nothing.
  if (!PLAIN_NAME.test(name)) {
    return { ok: false, plugin, steps: [], refused: 'the marketplace name in your settings is not a plain name, so nothing ran', next: `claude plugin update ${plugin.id}` };
  }
  const httpsEnv = withHttpsGit(env);
  if (httpsEnv === null) {
    return { ok: false, plugin, steps: [], refused: 'GIT_CONFIG_COUNT is not a small number, so nothing ran', next: 'unset it or make it a small number, then run `yokoten upgrade`' };
  }
  // A failed step stops the rest: the next one needs it.
  const steps: UpgradeStep[] = [];
  for (const [label, args] of [[`the marketplace ${name}`, ['plugin', 'marketplace', 'update', name]], [`the plugin ${plugin.id}`, ['plugin', 'update', plugin.id]]] as const) {
    const done = runClaude([...args], httpsEnv, platform);
    steps.push(done.ok || !done.said ? { label, ok: done.ok } : { label, ok: false, said: done.said });
    if (!done.ok) return { ok: false, plugin, steps, next: `claude ${args.join(' ')}` };
  }
  return { ok: true, plugin, steps, next: 'restart Claude Code; a session already running keeps the old copy' };
}

/**
 * The one screen of `yokoten upgrade`, from its result (#1115): a title that says what is true
 * now, one row per step, and the next thing to do. A failed step is a MISSING row with what
 * Claude Code said and the command to run by hand on its Fix line; a refusal is a failure.
 */
export function upgradeScreen(result: UpgradeResult): string[] {
  if (result.refused !== undefined) return failure('upgrade', result.refused, result.next);
  if (result.plugin === null) return screen(title('upgrade', 'yokoten is not a Claude Code plugin here, so nothing changed'), nextLine(result.next));
  const rows = result.steps.map((step) => {
    if (step.ok) return row('ok', `${step.label}: updated`);
    return [...row('MISSING', `${step.label}: not updated`), ...(step.said ? underRow(`Claude Code said: ${step.said}`, false) : []), ...underRow(`Fix: \`${result.next}\``, false)];
  });
  if (!result.ok) return screen(title('upgrade', 'the yokoten plugin was not updated, it is as it was'), spaced(rows));
  return screen(title('upgrade', `the yokoten plugin is up to date (${result.plugin.channel} channel)`), spaced(rows), nextSentence(result.next));
}

export function runUpgrade(invocation: Invocation): number {
  const options = parse('upgrade', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  const done = upgrade(invocation.env, invocation.platform ?? 'linux');
  // A failed step is never folded: its row, and the command to type by hand (#1027).
  print(invocation, upgradeScreen(done), done.ok ? invocation.stdout : invocation.stderr);
  return done.ok ? 0 : 1;
}
