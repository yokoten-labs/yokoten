// The yokoten plugin as Claude Code records it: the channel that is on, and how Claude Code
// fetches the marketplace it came from. A `github` source is cloned over SSH, which fails on a
// machine with no GitHub SSH key, so `yokoten upgrade` moves it to the HTTPS address (#950), and
// doctor says so once. The state and the note about it sit in one module.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Env } from '../../rules/config.ts';
import { type Finding, finding } from '../../rules/message.ts';
import { homeOf } from '../../rules/privacy.ts';
import { type PluginChannel, readPluginChannel, userDir } from '../../agents/runtimes/claude-code.ts';

/** The marketplace address that needs no SSH key, and the one `upgrade` moves to (#950). */
export const HTTPS_ADDRESS = 'https://github.com/yokoten-labs/yokoten.git';

/** How Claude Code fetches a marketplace: over SSH (`github`), over HTTPS (`https`), or another way. */
export type MarketplaceSource = 'github' | 'https' | 'other';

/** The yokoten marketplace Claude Code knows: its name, and how it fetches it. */
export interface PluginMarketplace {
  /** The name `claude plugin marketplace remove` takes, from known_marketplaces.json. */
  name: string;
  source: MarketplaceSource;
  /** The address it fetches, when the file records one. */
  url: string | null;
}

/** The yokoten plugin that is on in the user's settings, with the marketplace it came from. */
export interface EnabledPlugin {
  /** `<plugin>@<marketplace>`, the id `claude plugin update` takes. */
  id: string;
  /** `yokoten`, `yokoten-beta` or `yokoten-dev`. */
  name: string;
  /** The marketplace the id names. */
  marketplace: string;
  channel: PluginChannel;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A JSON file, or null when it is missing or not the shape we know. Never throws. */
function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

const namesYokoten = (value: string | null): boolean => value !== null && value.includes('yokoten-labs/yokoten');

/**
 * The yokoten plugin on in ~/.claude/settings.json, or null when none is on. `enabledPlugins`
 * keys are `<plugin>@<marketplace>`, so the id carries the channel and the marketplace both.
 * A settings file yokoten can't read enables nothing, as for `hasPlugin`.
 */
export function enabledPlugin(env: Env): EnabledPlugin | null {
  if (homeOf(env) === null) return null;
  const settings = readJsonFile(join(userDir(env), 'settings.json'));
  if (!isRecord(settings) || !isRecord(settings.enabledPlugins)) return null;
  for (const [id, on] of Object.entries(settings.enabledPlugins)) {
    const channel = readPluginChannel(id);
    if (channel === null || on !== true) continue;
    const at = id.indexOf('@');
    return { id, name: id.slice(0, at), marketplace: id.slice(at + 1), channel };
  }
  return null;
}

/**
 * The yokoten marketplace in ~/.claude/plugins/known_marketplaces.json, or null when Claude
 * Code knows none. The enabled plugin's marketplace is read first, then any entry that
 * points at the yokoten repo: a user may have added it under another name.
 */
export function readPluginMarketplace(env: Env): PluginMarketplace | null {
  if (homeOf(env) === null) return null;
  const known = readJsonFile(join(userDir(env), 'plugins', 'known_marketplaces.json'));
  if (!isRecord(known)) return null;
  const plugin = enabledPlugin(env);
  const names = plugin === null ? Object.keys(known) : [plugin.marketplace, ...Object.keys(known).filter((name) => name !== plugin.marketplace)];
  for (const name of names) {
    const entry = known[name];
    if (!isRecord(entry) || !isRecord(entry.source)) continue;
    const { source } = entry;
    const url = typeof source.url === 'string' ? source.url : null;
    const repo = typeof source.repo === 'string' ? source.repo : null;
    if (!namesYokoten(repo) && !namesYokoten(url)) continue;
    if (source.source === 'github') return { name, source: 'github', url };
    if (source.source === 'git' && url !== null && /^https:\/\//i.test(url)) return { name, source: 'https', url };
    return { name, source: 'other', url };
  }
  return null;
}

/**
 * A note when the yokoten marketplace is a `github` source, so every update goes over SSH.
 * Null when the source is the HTTPS address, when Claude Code knows no yokoten marketplace,
 * or when there is no home folder. A note, never a failure: the plugin works until it updates.
 */
export function pluginSourceNote(env: Env): Finding | null {
  const marketplace = readPluginMarketplace(env);
  if (marketplace === null || marketplace.source !== 'github') return null;
  return finding(
    'plugin-version',
    'the yokoten marketplace is a github source, so Claude Code clones it over SSH',
    'run `npx yokoten@latest upgrade` once: it moves the marketplace to the HTTPS address, which needs no SSH key',
    { why: 'without a GitHub SSH key the clone fails, so the plugin never updates and you stay on an old yokoten' },
  );
}
