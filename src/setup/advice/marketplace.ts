// The yokoten plugin as Claude Code records it: the channel that is on, and how Claude Code
// fetches the marketplace it came from. A `github` source, or a git address over SSH, fails on a
// machine with no GitHub SSH key. `yokoten upgrade` fetches over HTTPS for its own calls and
// changes nothing on disk (#950); doctor names it once. The state and the note sit in one module.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Env } from '../../rules/config.ts';
import { type Finding, finding } from '../../rules/text/message.ts';
import { homeOf } from '../../rules/privacy.ts';
import { type PluginChannel, readPluginChannel, userDir } from '../../agents/runtimes/claude-code.ts';

/** How Claude Code fetches a marketplace: over SSH (a `github` source or an SSH address), over HTTPS, or another way. */
export type MarketplaceSource = 'ssh' | 'https' | 'other';

/** The yokoten marketplace Claude Code knows: its name, and how it fetches it. */
export interface PluginMarketplace {
  /** The name `claude plugin marketplace update` takes, from known_marketplaces.json. */
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

// The yokoten repo exactly: `owner/repo` for a github source, or its address over HTTPS or SSH.
// A repo whose name only contains these words is not yokoten.
const YOKOTEN_REPO = /^yokoten-labs\/yokoten$/i;
const YOKOTEN_ADDRESS = /^(?:https:\/\/|ssh:\/\/git@|git@)github\.com[:/]yokoten-labs\/yokoten(?:\.git)?\/?$/i;
const SSH_ADDRESS = /^(?:ssh:\/\/|git@)/i;

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
    if (!(repo !== null && YOKOTEN_REPO.test(repo)) && !(url !== null && YOKOTEN_ADDRESS.test(url))) continue;
    if (source.source === 'github') return { name, source: 'ssh', url };
    if (source.source === 'git' && url !== null && /^https:\/\//i.test(url)) return { name, source: 'https', url };
    if (source.source === 'git' && url !== null && SSH_ADDRESS.test(url)) return { name, source: 'ssh', url };
    return { name, source: 'other', url };
  }
  return null;
}

/**
 * A note when Claude Code fetches the yokoten marketplace over SSH, so its own updates need a key.
 * Null when the source is the HTTPS address, when Claude Code knows no yokoten marketplace,
 * or when there is no home folder. A note, never a failure: the plugin works until it updates.
 */
export function pluginSourceNote(env: Env): Finding | null {
  const marketplace = readPluginMarketplace(env);
  if (marketplace === null || marketplace.source !== 'ssh') return null;
  return finding(
    'plugin-version',
    'Claude Code fetches the yokoten marketplace over SSH',
    'update with `npx yokoten@latest upgrade`: it fetches over HTTPS, so it needs no SSH key',
    { why: 'without a GitHub SSH key the clone fails, so the plugin never updates and you stay on an old yokoten' },
  );
}
