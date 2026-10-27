// `yokoten upgrade`: bring the yokoten plugin to the newest version.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { type Env } from '../../../rules/config.ts';
import { enabledPlugin } from '../../../setup/advice/marketplace.ts';
import { type Invocation, nextLine, parse, print, row, title, usage } from '../../shared.ts';

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

/** A step's own line: the result first, then what it did. */
const ok = (text: string): string => `ok      ${text}`;
const failed = (text: string): string => `failed  ${text}`;

/** What `yokoten upgrade` did: its lines, and whether every step worked. */
export interface UpgradeDone {
  ok: boolean;
  lines: string[];
}

/**
 * How to start Claude Code. On Windows the native installer puts only `claude.exe` on the PATH,
 * and an npm install puts `claude.cmd`: the first one found in PATH order wins, `.exe` before
 * `.cmd` in the same folder. An `.exe` runs by itself; a `.cmd` needs the shell, which finds it
 * by its name. With neither found, the shell is asked for `claude.cmd`, as before (#1002).
 */
export function claudeCommand(env: Env, platform: NodeJS.Platform = process.platform): { file: string; shell: boolean } {
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
 * that installs the newest yokoten and runs nothing.
 */
export function upgrade(env: Env, platform: NodeJS.Platform = process.platform): UpgradeDone {
  const plugin = enabledPlugin(env);
  if (plugin === null) {
    return {
      ok: true,
      lines: [
        'yokoten upgrade: yokoten is not a Claude Code plugin here, so there is no plugin to update.',
        'To get the newest yokoten, run: npx yokoten@latest',
      ],
    };
  }
  const name = plugin.marketplace;
  // Both checks come before the first call: a refusal changes nothing.
  if (!PLAIN_NAME.test(name)) {
    return { ok: false, lines: [`yokoten upgrade: the marketplace name in your settings is not a plain name, so yokoten runs nothing. Update by hand: claude plugin update ${plugin.id}`] };
  }
  const httpsEnv = withHttpsGit(env);
  if (httpsEnv === null) {
    return { ok: false, lines: ['yokoten upgrade: GIT_CONFIG_COUNT is set, but not to a small number, so yokoten can\'t add its HTTPS setting after yours. It runs nothing. Unset GIT_CONFIG_COUNT, or fix it, and run it again.'] };
  }
  const lines = [`yokoten upgrade: the yokoten plugin is on (${plugin.channel} channel).`];
  // Each step says one line. A failed step stops the rest: the next one needs it.
  const step = (label: string, args: string[]): boolean => {
    const done = runClaude(args, httpsEnv, platform);
    lines.push(done.ok ? ok(label) : failed(label));
    if (done.ok) return true;
    if (done.said) lines.push(`  ${done.said}`);
    lines.push(`To see the whole message, run this by hand: claude ${args.join(' ')}`);
    return false;
  };
  if (!step(`updated the marketplace ${name}`, ['plugin', 'marketplace', 'update', name])) return { ok: false, lines };
  if (!step(`updated the plugin ${plugin.id}`, ['plugin', 'update', plugin.id])) return { ok: false, lines };
  lines.push('Restart Claude Code to load it: a session that is already running keeps the old copy until it restarts.');
  return { ok: true, lines };
}

export function runUpgrade(invocation: Invocation): number {
  const options = parse('upgrade', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  const done = upgrade(invocation.env);
  // A failed step is never folded: its own lines and the command to type by hand (#1027).
  if (!done.ok) {
    print(invocation, done.lines, invocation.stderr);
    return 1;
  }
  const steps = done.lines.filter((line) => /^ok /.test(line));
  if (!steps.length) {
    print(invocation, [...title('upgrade', 'yokoten is not a Claude Code plugin here'), '', ...row('note', 'there is no plugin to update; nothing was changed'), '', ...nextLine('npx yokoten@latest')]);
    return 0;
  }
  print(invocation, [...title('upgrade', 'the yokoten plugin is up to date'), '', ...row('ok', 'updated', 'plugin'), '', ...nextLine('restart Claude Code to use it')]);
  return 0;
}
