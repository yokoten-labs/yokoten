// What the lead may do only with the owner's yes (#1212, record 0054 decision 2, record 0056
// decision 3): change the guard, hook, sandbox or fence settings of any agent, or run a
// command outside the sandbox. The guard asks the owner; it does not refuse. A worker is
// refused the same actions: the settings by lead-only, the sandbox by `workerLeavesSandbox`.
//
// The settings are the agents' settings files only (GUARD_SETTINGS, all of them lead-only),
// from the repo root, and the user settings under home (HOME_GUARD_SETTINGS). A path in a
// worker worktree reads from that worktree, as lead-only does (#571). No runtime is named
// here: whether a session can ask is the runtime adapter's answer (src/agents/runtimes/).

import nodePath from 'node:path';
import { GUARD_SETTINGS, HOME_GUARD_SETTINGS, type Env } from '../../config.ts';
import { homeOf } from '../../privacy/home.ts';
import { finding, type Finding } from '../../text/message.ts';
import { commandPlace, placedPath } from '../bash/read/words.ts';
import { pathsFor } from '../../../platform/paths.ts';
import { foldsCase, isLeadOnly, stripWorktreeRoot } from './edit.ts';
import { writeTargets, type FileRules } from './targets.ts';

// Each folder or file name in a settings path: a word that holds none of them can't write one,
// even after a `cd` (`cd .claude && echo x > settings.json` names both). Built on first use:
// config.ts and this module load each other.
let settingsPart: RegExp | null = null;
const namesSettingsPart = (word: string): boolean => {
  settingsPart ??= new RegExp(
    [...new Set([...GUARD_SETTINGS, ...HOME_GUARD_SETTINGS].flatMap((path) => path.split('/')).filter((part) => part !== '**'))]
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|'),
    'i',
  );
  return settingsPart.test(word);
};

const SETTINGS_FIX = "say yes only if you asked for this change: an agent may not change the rules it works under on its own";
const SANDBOX_FIX = 'say yes only if this command must run outside the sandbox and you trust what it does';

/** Whether `path` (from the repo root, forward slashes) is a guard setting, or a folder that holds one. */
export function isGuardSetting(path: string, platform: NodeJS.Platform): boolean {
  return matchesSettings(stripWorktreeRoot(path), GUARD_SETTINGS, foldsCase(platform));
}

/** Whether `path` is one of `settings`, or a folder that holds one (`rm -r .claude`). */
function matchesSettings(path: string, settings: readonly string[], folds: boolean): boolean {
  if (isLeadOnly(path, [...settings], folds)) return true;
  const plain = (folds ? path.toLowerCase() : path).replace(/\/+$/, '');
  if (plain === '' || plain === '.') return false;
  const folder = `${plain}/`;
  return settings.some((entry) => (folds ? entry.toLowerCase() : entry).startsWith(folder));
}

/** The path from home, when `full` (absolute) is a user settings file under home; null otherwise. */
export function homeGuardSetting(full: string, env: Env, platform: NodeJS.Platform): string | null {
  const home = homeOf(env);
  if (home === null) return null;
  const paths = pathsFor(platform);
  const rel = paths.relative(home, full);
  if (rel === '' || rel.startsWith('..') || paths.isAbsolute(rel)) return null;
  const fromHome = rel.split(paths.sep).join('/');
  return matchesSettings(fromHome, HOME_GUARD_SETTINGS, foldsCase(platform)) ? `~/${fromHome}` : null;
}

/** The question before the lead edits a guard setting (#1212). `shown` is the path as the message names it. */
export const settingsEditAsk = (shown: string): Finding => ({
  ...finding('guard-settings', `this edit changes ${shown}, which holds guard, hook or sandbox settings`, SETTINGS_FIX),
  ask: true,
});

const settingsWriteAsk = (shown: string): Finding => ({
  ...finding('guard-settings', `this command writes ${shown}, which holds guard, hook or sandbox settings`, SETTINGS_FIX),
  ask: true,
});

/**
 * The question before the lead's shell write to a guard setting (#1212), or null. A target
 * the guard can't place is not asked about: lead-only refuses that only for a worker, and
 * the lead's own command is not stopped for a path it wrote unclearly. A `git checkout` or
 * `git restore` from the index or HEAD puts back reviewed content and asks nothing; one
 * from another commit changes the setting, so it asks.
 */
export function guardSettingsWrite(words: string[], { rules, folder, env, platform }: { rules: FileRules; folder: string | null; env: Env; platform: NodeJS.Platform }): Finding | null {
  // Most lead commands name no part of a settings path: they skip the write read, which
  // costs the command's read budget (#226), so a long command stays readable.
  if (!words.some(namesSettingsPart)) return null;
  const paths = commandPlace.current ? pathsFor(commandPlace.current.platform) : nodePath;
  for (const target of writeTargets(words, folder, rules.rootOf, { keepsRestores: 'otherRef' })) {
    if (target.isUnread || target.path === '' || target.path === '-') continue;
    const ruled = rules.ruled(target, env);
    if (ruled !== null && isGuardSetting(ruled.path, platform)) return settingsWriteAsk(ruled.path);
    const expanded = placedPath(/^~(?=\/|$)/.test(target.path) && env.HOME ? paths.join(env.HOME, target.path.slice(1)) : target.path, target.from);
    if (expanded === null || (target.from === null && !paths.isAbsolute(expanded))) continue;
    const home = homeGuardSetting(paths.resolve(target.from ?? '/', expanded), env, platform);
    if (home !== null) return settingsWriteAsk(home);
  }
  return null;
}

/** The question before the lead runs a command outside the sandbox (#1212, #1163). */
export const leaveSandboxAsk = (): Finding => ({
  ...finding('leave-sandbox', "this command asks to run outside the agent's sandbox", SANDBOX_FIX),
  ask: true,
});

/** A worker's command outside the sandbox: refused, since no one is there to say yes. */
export const workerLeavesSandbox = (): Finding =>
  finding('leave-sandbox', "a worker's command asks to run outside the agent's sandbox", 'run it inside the sandbox; if the task needs more, stop and ask the lead');

/** The actions only the owner's yes lets through: a refusal of one says that, with no other way round. */
const OWNER_ASKS = new Set(['guard-settings', 'leave-sandbox']);

/**
 * An ask where no one can answer it becomes a refusal (#1212, #1215). The runtime adapter
 * decides both: `isUnattended`, a session with no one at the prompt (a cloud session), and
 * `canAsk`, a hook with an ask decision. The refusal keeps the ask's rule and what it saw,
 * and says the owner's yes is needed. Any other ask comes back as it is.
 */
export function settleAsk(ask: Finding, { isUnattended, canAsk, agent }: { isUnattended: boolean; canAsk: boolean; agent: string }): { ask: Finding } | { refuse: Finding } {
  const where = isUnattended ? 'a cloud session has no one to ask' : canAsk ? null : `${agent}'s hook can't ask the owner`;
  if (where === null) return { ask };
  const tell = `stop and tell the owner what you need and why: this needs the owner's yes, and ${where}`;
  const fix = OWNER_ASKS.has(ask.id) ? tell : `${tell}; or ${ask.fix}`;
  const refused: Finding = { ...ask, fix };
  delete refused.ask;
  return { refuse: refused };
}
