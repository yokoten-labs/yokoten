// Tests for src/setup/advice/marketplace.ts: the plugin Claude Code recorded, the way it fetches
// the marketplace, and the one note about a source that needs an SSH key (#950).

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { enabledPlugin, pluginSourceNote, readPluginMarketplace } from '../../../src/setup/advice/marketplace.ts';
import { formatFinding } from '../../../src/rules/message.ts';
import { makeSandbox, makeTempDir } from '../../repo/helpers.ts';

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

test('marketplace: a github source is told apart from the HTTPS address', () => {
  assert.equal(readPluginMarketplace({ HOME: pluginHome(githubSource) })?.source, 'github');
  assert.equal(readPluginMarketplace({ HOME: pluginHome(httpsSource) })?.source, 'https');
  // Nothing known, or another repo: no yokoten marketplace to report.
  assert.equal(readPluginMarketplace({ HOME: pluginHome(undefined) }), null);
  assert.equal(readPluginMarketplace({ HOME: pluginHome({ other: { source: { source: 'github', repo: 'octo/demo' } } }) }), null);
});

test('marketplace: the entry is found by its repo when the user named it otherwise', () => {
  const home = pluginHome({ mine: { source: { source: 'github', repo: 'yokoten-labs/yokoten' } } }, {});
  assert.deepEqual(readPluginMarketplace({ HOME: home }), { name: 'mine', source: 'github', url: null });
});

test('marketplace: a github source gets one note, naming the one command that moves it', () => {
  const note = pluginSourceNote({ HOME: pluginHome(githubSource) });
  assert.ok(note, 'a github source is a note');
  const text = formatFinding(note);
  assert.match(text, /the yokoten marketplace is a github source, so Claude Code clones it over SSH\./);
  assert.match(text, /Run `yokoten upgrade` once: it moves the marketplace to the HTTPS address, which needs no SSH key\./);
  assert.match(text, /Without a GitHub SSH key the clone fails/, 'the note says what goes wrong');
});

test('marketplace: the HTTPS address says nothing', () => {
  assert.equal(pluginSourceNote({ HOME: pluginHome(httpsSource) }), null);
});

test('doctor: the note reaches a session for a github source, and not for the HTTPS address', () => {
  assert.match(sandboxWith(githubSource).run(['doctor', '--session']).stdout, /^yokoten: the yokoten marketplace is a github source/m);
  assert.doesNotMatch(sandboxWith(httpsSource).run(['doctor', '--session']).stdout, /marketplace is a github source/);
});

test('doctor: the full report names the note as plugin-source', () => {
  assert.match(sandboxWith(githubSource).run(['doctor']).stdout, /^ {2}note {4}plugin-source: the yokoten marketplace is a github source, so Claude Code clones it over SSH; run/m);
});
