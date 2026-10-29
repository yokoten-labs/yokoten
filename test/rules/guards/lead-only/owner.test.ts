// Tests for src/rules/guards/lead-only/owner.ts: what the lead does only with the owner's yes (#1212, #1215).

import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkCommand, homeGuardSetting, isGuardSetting, settleAsk } from '../../../../src/rules/guards/index.ts';
import { DEFAULTS, GUARD_SETTINGS } from '../../../../src/rules/config.ts';
import { judge } from '../../../../src/run/hook.ts';
import { makeSandbox } from '../../../../test/repo/helpers.ts';

test('guard settings: the list is the agent-config part of the default leadOnly, never a fork (#1212)', () => {
  for (const path of GUARD_SETTINGS) assert.ok(DEFAULTS.leadOnly.includes(path), path);
  for (const path of ['.claude/settings.json', '.claude/settings.local.json', '.codex/config.toml', '.gemini/settings.json', '.grok/hooks/yokoten.json', '.muse/hooks.json', '.dsh/hooks.json', '.agents/hooks.json', '.githooks/pre-commit', 'yokoten.json', '.yokoten/bin/yokoten.ts']) {
    assert.ok(isGuardSetting(path, 'linux'), path);
  }
  assert.ok(isGuardSetting('.worktrees/1212-x/.claude/settings.json', 'linux'), 'a worktree reads from its own root');
  assert.ok(isGuardSetting('.claude', 'linux'), 'a folder that holds one');
  for (const path of ['AGENTS.md', 'CLAUDE.md', '.github/workflows/ci.yml', 'src/a.ts', 'docs/claude/settings.json']) assert.ok(!isGuardSetting(path, 'linux'), path);
  assert.ok(isGuardSetting('.CLAUDE/Settings.json', 'darwin'), 'case folds where file names do');
  assert.ok(!isGuardSetting('.CLAUDE/Settings.json', 'linux'));
  const env = { HOME: '/home/u' };
  assert.equal(homeGuardSetting('/home/u/.claude/settings.json', env, 'linux'), '~/.claude/settings.json');
  assert.equal(homeGuardSetting('/home/u/.codex/hooks.json', env, 'linux'), '~/.codex/hooks.json');
  assert.equal(homeGuardSetting('/home/u/notes.md', env, 'linux'), null);
  assert.equal(homeGuardSetting('/elsewhere/.claude/settings.json', env, 'linux'), null);
});

test('guard settings: the lead\'s edit or shell write asks; a worker\'s is refused by lead-only (#1212)', () => {
  const sandbox = makeSandbox();
  const options = { root: sandbox.repo, config: DEFAULTS, env: {}, cwd: sandbox.repo };
  const worker = { ...options, env: { YOKOTEN_ROLE: 'worker' } };
  const edit = judge({ paths: ['.claude/settings.json'], worker: false }, options);
  assert.equal(edit?.id, 'guard-settings');
  assert.equal(edit?.ask, true);
  assert.match(edit?.what ?? '', /\.claude\/settings\.json, which holds guard, hook or sandbox settings/);
  assert.equal(judge({ paths: ['.claude/settings.json'], worker: false }, worker)?.id, 'lead-only');
  assert.equal(judge({ paths: ['.claude/settings.json'], worker: false }, worker)?.ask, undefined, 'a worker gets no question');
  assert.equal(judge({ paths: ['.claude/settings.json'], worker: true }, options)?.id, 'lead-only', 'a worker subagent too');
  assert.equal(judge({ paths: ['AGENTS.md'], worker: false }, options), null, 'the lead edits the rules in words freely');
  assert.equal(judge({ paths: [join(sandbox.home, '.claude', 'settings.json')], worker: false }, { ...options, env: { HOME: sandbox.home } })?.id, 'guard-settings', 'the user settings too');
  // A shell write.
  const lead = (command: string) => checkCommand(command, { env: {}, cwd: sandbox.repo });
  assert.equal(lead('echo {} > .claude/settings.json')?.ask, true);
  assert.equal(lead('sed -i s/a/b/ .codex/config.toml')?.id, 'guard-settings');
  assert.equal(lead('rm -rf .gemini')?.ask, true, 'a folder that holds one');
  assert.equal(lead('cat .claude/settings.json'), null, 'a read asks nothing');
  assert.equal(lead('echo x > notes.md'), null);
  assert.equal(checkCommand('echo x > ~/.claude/settings.json', { env: { HOME: sandbox.home }, cwd: sandbox.repo })?.id, 'guard-settings');
  // A refusal anywhere on the line wins over the question.
  assert.equal(lead('echo {} > .claude/settings.json && git push --tags')?.id, 'release');
  assert.equal(checkCommand('echo {} > .claude/settings.json', { env: { YOKOTEN_ROLE: 'worker' }, cwd: sandbox.repo })?.id, 'lead-only');
});

test('leave sandbox: the lead\'s call asks, a worker\'s is refused (#1212)', () => {
  const sandbox = makeSandbox();
  const options = { root: sandbox.repo, config: DEFAULTS, env: {}, cwd: sandbox.repo };
  const call = { command: 'ls', paths: [], worker: false, leavesSandbox: true };
  assert.deepEqual([judge(call, options)?.id, judge(call, options)?.ask], ['leave-sandbox', true]);
  const refused = judge(call, { ...options, env: { YOKOTEN_ROLE: 'worker' } });
  assert.deepEqual([refused?.id, refused?.ask], ['leave-sandbox', undefined]);
  assert.equal(judge({ ...call, worker: true }, options)?.ask, undefined, 'a worker subagent is refused too');
  assert.equal(judge({ ...call, leavesSandbox: false }, options), null);
  assert.equal(judge({ ...call, command: 'git push --tags' }, options)?.id, 'release', 'a floor refusal stays a refusal');
});

test('settle: an ask no one can answer becomes a refusal that names the owner\'s yes (#1212, #1215)', () => {
  const sandbox = makeSandbox();
  const ask = judge({ paths: ['.claude/settings.json'], worker: false }, { root: sandbox.repo, config: DEFAULTS, env: {}, cwd: sandbox.repo });
  assert.ok(ask?.ask);
  assert.deepEqual(settleAsk(ask, { env: {}, canAsk: true, agent: 'Claude Code' }), { ask });
  const cloud = settleAsk(ask, { env: { CLAUDE_CODE_REMOTE: 'true' }, canAsk: true, agent: 'Claude Code' });
  assert.ok('refuse' in cloud);
  assert.equal(cloud.refuse.id, 'guard-settings');
  assert.equal(cloud.refuse.ask, undefined);
  assert.match(cloud.refuse.fix, /owner's yes/);
  assert.match(cloud.refuse.fix, /cloud session/);
  assert.deepEqual(settleAsk(ask, { env: { CLAUDE_CODE_REMOTE: '' }, canAsk: true, agent: 'Claude Code' }), { ask }, 'an empty value is not set');
  const codex = settleAsk(ask, { env: {}, canAsk: false, agent: 'Codex CLI' });
  assert.ok('refuse' in codex);
  assert.match(codex.refuse.fix, /owner's yes, and Codex CLI's hook can't ask the owner/);
  // Another question keeps its own way out in the refusal.
  const disk = settleAsk({ id: 'disk-space', what: 'low', why: 'full', fix: 'free some space', ask: true }, { env: { CLAUDE_CODE_REMOTE: '1' }, canAsk: true, agent: 'x' });
  assert.ok('refuse' in disk);
  assert.match(disk.refuse.fix, /; or free some space$/);
});
