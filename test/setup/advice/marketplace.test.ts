// Tests for src/setup/advice/marketplace.ts: the plugin Claude Code recorded, the way it fetches
// the marketplace, and the one note about a source that needs an SSH key (#950).

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { enabledPlugin, pluginSourceNote, readPluginMarketplace } from '../../../src/setup/advice/marketplace.ts';
import { formatFinding } from '../../../src/rules/text/message.ts';
import { makeSandbox, makeTempDir, rowsText } from '../../repo/helpers.ts';

/** Writes the two files Claude Code keeps the plugin in, into `home`. */
function writePluginState(home: string, settings: unknown, known?: unknown): string {
  const claude = join(home, '.claude');
  mkdirSync(join(claude, 'plugins'), { recursive: true });
  if (settings !== undefined) writeFileSync(join(claude, 'settings.json'), JSON.stringify(settings));
  if (known !== undefined) writeFileSync(join(claude, 'plugins', 'known_marketplaces.json'), JSON.stringify(known));
  return home;
}

/** A fresh home folder with the plugin on and the given marketplace source. */
function pluginHome(known: unknown, settings: unknown = { enabledPlugins: { 'yokoten@yokoten': true } }): string {
  return writePluginState(makeTempDir(), settings, known);
}

const githubSource = { yokoten: { source: { source: 'github', repo: 'yokoten-labs/yokoten' }, installLocation: 'plugins/yokoten' } };
const httpsSource = { yokoten: { source: { source: 'git', url: 'https://github.com/yokoten-labs/yokoten.git' }, installLocation: 'plugins/yokoten' } };

/** A sandbox whose home has the plugin on and the given marketplace source. */
function sandboxWith(known: unknown) {
  const sandbox = makeSandbox();
  writePluginState(sandbox.home, { enabledPlugins: { 'yokoten@yokoten': true } }, known);
  return sandbox;
}

test('plugin: the channel and the marketplace come from the enabled plugin id', () => {
  const home = pluginHome(githubSource, { enabledPlugins: { 'yokoten-beta@yokoten': true } });
  assert.deepEqual(enabledPlugin({ HOME: home }), { id: 'yokoten-beta@yokoten', name: 'yokoten-beta', marketplace: 'yokoten', channel: 'beta' });
});

test('plugin: an off plugin, another plugin, or no settings file enables nothing', () => {
  assert.equal(enabledPlugin({ HOME: pluginHome(githubSource, { enabledPlugins: { 'yokoten@yokoten': false } }) }), null);
  assert.equal(enabledPlugin({ HOME: pluginHome(githubSource, { enabledPlugins: { 'other@market': true } }) }), null);
  assert.equal(enabledPlugin({ HOME: writePluginState(makeTempDir(), undefined) }), null);
  assert.equal(enabledPlugin({}), null);
});

test('marketplace: a github source and an SSH address are told apart from the HTTPS address', () => {
  assert.equal(readPluginMarketplace({ HOME: pluginHome(githubSource) })?.source, 'ssh');
  assert.equal(readPluginMarketplace({ HOME: pluginHome(httpsSource) })?.source, 'https');
  for (const url of ['git@github.com:yokoten-labs/yokoten.git', 'ssh://git@github.com/yokoten-labs/yokoten.git']) {
    assert.equal(readPluginMarketplace({ HOME: pluginHome({ yokoten: { source: { source: 'git', url } } }) })?.source, 'ssh', url);
  }
  // Nothing known, or another repo: no yokoten marketplace to report.
  assert.equal(readPluginMarketplace({ HOME: pluginHome(undefined) }), null);
  assert.equal(readPluginMarketplace({ HOME: pluginHome({ other: { source: { source: 'github', repo: 'octo/demo' } } }) }), null);
  // A repo or address that only holds the words is not yokoten.
  assert.equal(readPluginMarketplace({ HOME: pluginHome({ x: { source: { source: 'github', repo: 'octo/yokoten-labs/yokoten-fork' } } }) }), null);
  assert.equal(readPluginMarketplace({ HOME: pluginHome({ x: { source: { source: 'git', url: 'https://example.com/yokoten-labs/yokoten.git' } } }) }), null);
});

test('marketplace: the entry is found by its repo when the user named it otherwise', () => {
  const home = pluginHome({ mine: { source: { source: 'github', repo: 'yokoten-labs/yokoten' } } }, {});
  assert.deepEqual(readPluginMarketplace({ HOME: home }), { name: 'mine', source: 'ssh', url: null });
});

test('marketplace: an SSH source gets one note, naming the command that updates over HTTPS', () => {
  const note = pluginSourceNote({ HOME: pluginHome(githubSource) });
  assert.ok(note, 'a github source is a note');
  const text = formatFinding(note);
  assert.match(text, /Claude Code fetches the yokoten marketplace over SSH\./);
  assert.match(text, /Update with `npx yokoten@latest upgrade`: it fetches over HTTPS, so it needs no SSH key\./);
  assert.match(text, /Without a GitHub SSH key the clone fails/, 'the note says what goes wrong');
});

test('marketplace: the HTTPS address says nothing', () => {
  assert.equal(pluginSourceNote({ HOME: pluginHome(httpsSource) }), null);
});

test('doctor: the note reaches a session for an SSH source, and not for the HTTPS address', () => {
  assert.match(sandboxWith(githubSource).run(['doctor', '--session']).stdout, /^yokoten: Claude Code fetches the yokoten marketplace over SSH/m);
  assert.doesNotMatch(sandboxWith(httpsSource).run(['doctor', '--session']).stdout, /marketplace over SSH/);
});

test('doctor: the full report names the note as plugin-source', () => {
  assert.match(rowsText(sandboxWith(githubSource).run(['doctor', '--all']).stdout), /^ {2}note {8}plugin-source: Claude Code fetches the yokoten marketplace over SSH; update with/m);
});
