// Tests for src/rules/guards/lead-only/owner.ts: what the lead does only with the owner's yes (#1212, #1215).

import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { ADAPTERS, canAskOf, isUnattended } from '../../../../src/agents/runtimes/runtime.ts';
import { SANDBOX_FILE as CLAUDE_SANDBOX } from '../../../../src/agents/runtimes/claude-code.ts';
import { SANDBOX_FILE as CODEX_SANDBOX } from '../../../../src/agents/runtimes/codex.ts';
import { SANDBOX_FILE as GEMINI_SANDBOX } from '../../../../src/agents/runtimes/gemini.ts';
import { HOOKS_FILE as GROK_HOOKS, SANDBOX_FILE as GROK_SANDBOX } from '../../../../src/agents/runtimes/grok.ts';
import { HOOKS_FILE as DSH_HOOKS, PATCH_FILE as DSH_PATCH } from '../../../../src/agents/runtimes/small/deepseek-harness.ts';
import { checkCommand, homeGuardSetting, isGuardSetting, isLeadOnly, settleAsk } from '../../../../src/rules/guards/index.ts';
import { DEFAULTS, GUARD_SETTINGS, HOME_GUARD_SETTINGS } from '../../../../src/rules/config.ts';
import { judge } from '../../../../src/run/hook.ts';
import { makeSandbox } from '../../../../test/repo/helpers.ts';

// OpenCode's project hook (.opencode/plugins/) is not lead-only yet, so it is not here either:
// that gap is its own issue.
const NOT_LEAD_ONLY_YET = new Set(['opencode']);

test('guard settings: settings files only, each one lead-only, and each adapter\'s own files in the list (#1212)', () => {
  for (const path of GUARD_SETTINGS) assert.ok(isLeadOnly(path.replace('/**', '/x'), DEFAULTS.leadOnly, false), `${path} must be lead-only too, so a worker is refused it`);
  // Each runtime's project hook file, as its adapter names it, and its sandbox file.
  for (const adapter of Object.values(ADAPTERS)) {
    const hook = /`([^`]+)`/.exec(adapter.projectHook)?.[1];
    assert.ok(hook, `${adapter.name}: names its hook file`);
    assert.equal(isGuardSetting(hook, 'linux'), !NOT_LEAD_ONLY_YET.has(adapter.name), `${adapter.name}: ${hook}`);
  }
  for (const path of [CLAUDE_SANDBOX, CODEX_SANDBOX, GEMINI_SANDBOX, GROK_HOOKS, GROK_SANDBOX, DSH_HOOKS, DSH_PATCH, '.claude/settings.local.json', '.githooks/pre-commit', 'yokoten.json']) {
    assert.ok(isGuardSetting(path, 'linux'), path);
  }
  assert.ok(isGuardSetting('.worktrees/1212-x/.claude/settings.json', 'linux'), 'a worktree reads from its own root');
  assert.ok(isGuardSetting('.claude', 'linux'), 'a folder that holds one');
  assert.ok(isGuardSetting('.claude/', 'linux'));
  // Asks stay rare (record 0056): the rest of lead-only is not asked about.
  for (const path of ['.claude/skills/x/SKILL.md', '.claude/agents/worker.md', '.claude/commands/x.md', '.claude-plugin/plugin.json', '.yokoten/bin/yokoten.ts', '.yokotenignore', 'AGENTS.md', 'CLAUDE.md', '.github/workflows/ci.yml', 'src/a.ts', '.claude/skills']) {
    assert.ok(!isGuardSetting(path, 'linux'), path);
  }
  assert.ok(isGuardSetting('.CLAUDE/Settings.json', 'darwin'), 'case folds where file names do');
  assert.ok(!isGuardSetting('.CLAUDE/Settings.json', 'linux'));
  const env = { HOME: '/home/u' };
  for (const adapter of Object.values(ADAPTERS)) {
    if (adapter.userHook === null || NOT_LEAD_ONLY_YET.has(adapter.name)) continue;
    assert.equal(homeGuardSetting(adapter.userHook.replace('~', '/home/u'), env, 'linux'), adapter.userHook, `${adapter.name}: its user hook`);
  }
  assert.ok(HOME_GUARD_SETTINGS.length > 0);
  assert.equal(homeGuardSetting('/home/u/.claude/skills/x/SKILL.md', env, 'linux'), null);
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
  assert.equal(judge({ paths: ['.claude/skills/x/SKILL.md'], worker: false }, options), null, 'the lead edits a skill freely');
  assert.equal(judge({ paths: ['.claude/skills/x/SKILL.md'], worker: false }, worker)?.id, 'lead-only', 'a worker is still refused every lead-only path');
  assert.equal(judge({ paths: ['AGENTS.md'], worker: false }, options), null, 'the lead edits the rules in words freely');
  assert.equal(judge({ paths: [join(sandbox.home, '.claude', 'settings.json')], worker: false }, { ...options, env: { HOME: sandbox.home } })?.id, 'guard-settings', 'the user settings too');
  // A shell write.
  const lead = (command: string) => checkCommand(command, { env: {}, cwd: sandbox.repo });
  assert.equal(lead('echo {} > .claude/settings.json')?.ask, true);
  assert.equal(lead('sed -i s/a/b/ .codex/config.toml')?.id, 'guard-settings');
  assert.equal(lead('rm -rf .gemini')?.ask, true, 'a folder that holds one');
  assert.equal(lead('echo x > .claude/skills/x/SKILL.md'), null, 'a skill is not a setting');
  assert.equal(lead('cat .claude/settings.json'), null, 'a read asks nothing');
  assert.equal(lead('echo x > notes.md'), null);
  assert.equal(checkCommand('echo x > ~/.claude/settings.json', { env: { HOME: sandbox.home }, cwd: sandbox.repo })?.id, 'guard-settings');
  // A restore from the index or HEAD puts back reviewed content: no question. One from another commit changes the setting.
  for (const command of ['git checkout -- .githooks/pre-commit', 'git checkout HEAD -- .claude/settings.json', 'git checkout .claude/settings.json', 'git restore .claude/settings.json', 'git restore --staged .claude/settings.json', 'git restore --source=HEAD yokoten.json', 'git restore -s HEAD yokoten.json']) {
    assert.equal(lead(command), null, command);
  }
  for (const command of ['git checkout main -- .claude/settings.json', 'git checkout origin/x .claude/settings.json', 'git restore --source=main .claude/settings.json', 'git restore -s main yokoten.json', 'git restore -smain yokoten.json', 'git restore --source main --worktree .codex/config.toml']) {
    assert.equal(lead(command)?.id, 'guard-settings', command);
  }
  assert.equal(lead('git checkout main -- src/a.ts'), null, 'another file from another commit asks nothing');
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
  assert.deepEqual(settleAsk(ask, { isUnattended: false, canAsk: true, agent: 'Claude Code' }), { ask });
  const cloud = settleAsk(ask, { isUnattended: true, canAsk: true, agent: 'Claude Code' });
  assert.ok('refuse' in cloud);
  assert.equal(cloud.refuse.id, 'guard-settings');
  assert.equal(cloud.refuse.ask, undefined);
  assert.match(cloud.refuse.fix, /owner's yes/);
  assert.match(cloud.refuse.fix, /cloud session/);
  const codex = settleAsk(ask, { isUnattended: false, canAsk: false, agent: 'Codex CLI' });
  assert.ok('refuse' in codex);
  assert.match(codex.refuse.fix, /owner's yes, and Codex CLI's hook can't ask the owner/);
  // Another question keeps its own way out in the refusal.
  const disk = settleAsk({ id: 'disk-space', what: 'low', why: 'full', fix: 'free some space', ask: true }, { isUnattended: true, canAsk: true, agent: 'x' });
  assert.ok('refuse' in disk);
  assert.match(disk.refuse.fix, /; or free some space$/);
});

test('settle: the adapters say who can ask, and when no one is at the prompt (#1212, #1215)', () => {
  assert.equal(canAskOf('claude-code', {}), true);
  assert.equal(canAskOf('codex', {}), false, 'a hook with no ask form');
  assert.equal(isUnattended({}), false);
  assert.equal(isUnattended({ CLAUDE_CODE_REMOTE: 'true' }), true, 'a Claude Code cloud session');
  assert.equal(isUnattended({ CLAUDE_CODE_REMOTE: '' }), false, 'an empty value is not set');
  assert.equal(canAskOf('claude-code', { CLAUDE_CODE_REMOTE: '1' }), false);
});
