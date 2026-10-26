// Tests for src/agents/runtimes/runtime.ts: one contract, one conformance suite and one
// guide table for every agent adapter (#395).

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULTS } from '../../../src/rules/config.ts';
import { judge } from '../../../src/run/hook.ts';
import { ADAPTERS, GUIDE_AGENTS, adapterFor, denialOf, rewriteOf, stopReaderOf, worksWithTable } from '../../../src/agents/runtimes/runtime.ts';
import { makeSandbox, ROOT } from '../../repo/helpers.ts';
import * as claudeCode from '../../../src/agents/runtimes/claude-code.ts';
import * as copilot from '../../../src/agents/copilot.ts';
import * as codex from '../../../src/agents/runtimes/codex.ts';
import * as gemini from '../../../src/agents/runtimes/gemini.ts';
import * as antigravity from '../../../src/agents/runtimes/small/antigravity.ts';
import * as grok from '../../../src/agents/runtimes/grok.ts';
import * as muse from '../../../src/agents/runtimes/muse.ts';

const adapters = Object.values(ADAPTERS);
const options = { root: null, config: DEFAULTS, env: {}, cwd: '/repo' };

test('contract: every adapter fills the table, and its capabilities match its functions', () => {
  assert.ok(adapters.length >= 8, 'the scan found no adapters; the table is broken');
  for (const adapter of adapters) {
    assert.equal(ADAPTERS[adapter.name], adapter, `${adapter.name}: the registry key and the name differ`);
    assert.equal(adapterFor(adapter.name), adapter);
    assert.ok(adapter.label.length > 0 && adapter.projectHook.length > 0 && adapter.blocking.length > 0, `${adapter.name}: a contract field is empty`);
    assert.ok(adapter.userHook === null || adapter.userHook.startsWith('~'), `${adapter.name}: a user hook is not a home path`);
    assert.equal(adapter.capabilities.canRewrite, adapter.formatRewrite !== undefined, `${adapter.name}: canRewrite and formatRewrite differ`);
    assert.equal(adapter.capabilities.hasStopHook, adapter.readStop !== undefined, `${adapter.name}: hasStopHook and readStop differ`);
    assert.equal(adapter.capabilities.hasStopHook, stopReaderOf(adapter.name) !== undefined);
    assert.equal(typeof adapter.call('git status'), 'object', `${adapter.name}: the sample call is not an object`);
  }
});

test('conformance: every adapter reads a force push and a tag push, and the guard blocks both', () => {
  for (const adapter of adapters) {
    for (const command of ['git push --force origin main', 'git push --tags']) {
      const action = adapter.readToolCall(adapter.call(command));
      assert.equal(action.command, command, `${adapter.name} did not read the command`);
      assert.ok(judge(action, options), `${adapter.name} let through: ${command}`);
    }
  }
});

test('conformance: every adapter reads a plain read, and the guard allows it', () => {
  for (const adapter of adapters) {
    const action = adapter.readToolCall(adapter.call('git status'));
    assert.equal(action.command, 'git status', `${adapter.name} did not read the command`);
    assert.equal(judge(action, options), null, `${adapter.name} refused a plain read`);
  }
});

test('conformance: every adapter runs the posted-text scan, and the guard refuses the post', () => {
  // Built from pieces, so this file passes the repo's own privacy check.
  const email = `someone${'@'}personal-mail.com`;
  for (const adapter of adapters) {
    const action = adapter.readToolCall(adapter.call(`gh pr comment 3 --body "write to ${email}"`));
    assert.equal(judge(action, options)?.id, 'email', `${adapter.name} let a private address reach a post`);
  }
});

test('conformance: a rewrite is posted, and an adapter without one says so and keeps the refusal fallback', () => {
  const reason = 'yokoten: it may print your account';
  for (const adapter of adapters) {
    const input = adapter.call('cat ~/.config/yokoten/keys | head');
    const written = rewriteOf(adapter.name, input, 'cat ~/.config/yokoten/keys | yokoten redact', reason);
    if (!adapter.capabilities.canRewrite) {
      assert.equal(written, null, `${adapter.name} rewrites, but its table says it cannot`);
      continue;
    }
    assert.match(written ?? '', /updatedInput/, `${adapter.name} does not post the changed command`);
    assert.match(written ?? '', /yokoten redact/, `${adapter.name} lost the wrapped command`);
  }
});

test('conformance: each adapter has a refusal the agent obeys, or the core fallback', () => {
  for (const adapter of adapters) {
    const denial = denialOf(adapter.name, 'yokoten: denied');
    if (adapter.formatDenial === undefined) assert.deepEqual(denial, { stdout: '', exitCode: 2 }, `${adapter.name}: the fallback changed`);
    else assert.ok(denial.exitCode !== 0 || denial.stdout.includes('deny'), `${adapter.name}: a refusal exits 0 and says no deny`);
  }
});

test('conformance: a stop hook is there exactly when the table says, and it reads a turn end', () => {
  for (const adapter of adapters) {
    const read = stopReaderOf(adapter.name);
    if (!adapter.capabilities.hasStopHook) {
      assert.equal(read, undefined, `${adapter.name} has a stop reader, but its table says it has none`);
      continue;
    }
    assert.equal(read?.({ cwd: '/w', stop_hook_active: false })?.cwd, '/w', `${adapter.name} cannot read a turn end`);
  }
});

test('guide: every adapter has a row, and the Works with table is the generated one', () => {
  const covered = new Set(GUIDE_AGENTS.map((entry) => entry.adapter));
  assert.deepEqual([...covered].sort(), Object.keys(ADAPTERS).sort(), 'a guide row names an adapter that is not in the table, or an adapter has no row');
  const guide = readFileSync(join(ROOT, 'docs/guide.md'), 'utf8');
  assert.ok(guide.includes(worksWithTable()), 'docs/guide.md: the Works with table differs from the generated one');
  // Positive control: one changed capability must change the table.
  const changed = GUIDE_AGENTS.map((entry) => (entry.label === 'Codex CLI' ? { ...entry, changes: { canRewrite: true } } : entry));
  assert.notEqual(worksWithTable(changed), worksWithTable(), 'the generator ignores a capability; the table is not from the data');
});

// #1100: a runtime's user guard runs in every session, the project hook only in a repo that
// loads it. Each runtime's two hooks are written as install and init write them, and the user
// guard must run on every tool the project hook runs on: one list in the adapter, never one
// chosen by hand. Then each edit tool, through the user guard: a worker's write into a CI
// workflow is refused, and the lead's is allowed.
type Group = { matcher?: string; hooks: { command: string }[] };
type GuardPair = {
  /** The adapter that reads the user guard's calls. */
  reader: string;
  /** Both hooks written, as install and init write them; each file's guard groups. */
  install: (repo: string, env: { HOME: string }) => { project: Group[]; user: Group[] };
  /** One edit call by `tool` on `file`, in this runtime's shape, when it is not Claude Code's. */
  edit?: (tool: string, file: string, repo: string) => unknown;
};
const groupsOf = (file: string, event: string): Group[] => JSON.parse(readFileSync(file, 'utf8')).hooks[event];
// agy's hooks.json maps an entry's name to its events.
const agyGroupsOf = (file: string): Group[] => JSON.parse(readFileSync(file, 'utf8')).yokoten.PreToolUse;
const CLI = '.yokoten/bin/yokoten.mjs';
const USER_CLI = '/x/yokoten.mjs';
const GUARD_PAIRS: Record<string, GuardPair> = {
  'claude-code': {
    reader: 'claude-code',
    install: (repo, env) => {
      claudeCode.addProjectHook(repo, CLI);
      claudeCode.addUserHooks(env, USER_CLI, 'gone');
      return { project: groupsOf(join(repo, '.claude', 'settings.json'), 'PreToolUse'), user: groupsOf(join(env.HOME, '.claude', 'settings.json'), 'PreToolUse') };
    },
  },
  // Copilot CLI runs the project hook in .claude/settings.json, and its own user guard.
  copilot: {
    reader: 'claude-code',
    install: (repo, env) => {
      claudeCode.addProjectHook(repo, CLI);
      copilot.addUserHooks(env, USER_CLI, 'gone');
      return { project: groupsOf(join(repo, '.claude', 'settings.json'), 'PreToolUse'), user: groupsOf(join(env.HOME, '.copilot', 'hooks', 'yokoten.json'), 'PreToolUse') };
    },
  },
  codex: {
    reader: 'codex',
    install: (repo, env) => {
      codex.addProjectHook(repo, CLI);
      codex.addUserHooks(env, USER_CLI, 'gone');
      return { project: groupsOf(join(repo, '.codex', 'hooks.json'), 'PreToolUse'), user: groupsOf(join(env.HOME, '.codex', 'hooks.json'), 'PreToolUse') };
    },
    // apply_patch sends its patch as `command`; the file headers are the paths.
    edit: (tool, file, repo) => ({ cwd: repo, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command: `*** Begin Patch\n*** Add File: ${file}\n+x\n*** End Patch` } }),
  },
  gemini: {
    reader: 'gemini',
    install: (repo, env) => {
      gemini.addProjectHook(repo, CLI);
      gemini.addUserHooks(env, USER_CLI, 'gone');
      return { project: groupsOf(join(repo, '.gemini', 'settings.json'), 'BeforeTool'), user: groupsOf(join(env.HOME, '.gemini', 'settings.json'), 'BeforeTool') };
    },
  },
  antigravity: {
    reader: 'antigravity',
    install: (repo, env) => {
      antigravity.addProjectHook(repo, CLI);
      antigravity.addUserHooks(env, USER_CLI, 'gone');
      return { project: agyGroupsOf(join(repo, '.agents', 'hooks.json')), user: agyGroupsOf(join(env.HOME, '.gemini', 'config', 'hooks.json')) };
    },
    edit: (tool, file, repo) => ({ toolCall: { name: tool, args: { TargetFile: file, CodeContent: 'x' } }, workspacePaths: [repo] }),
  },
  muse: {
    reader: 'muse',
    install: (repo, env) => {
      muse.addProjectHooks(repo, CLI);
      muse.addUserHooks(env, USER_CLI, 'gone');
      return { project: groupsOf(join(repo, '.muse', 'hooks.json'), 'PreToolUse'), user: groupsOf(join(env.HOME, '.config', 'muse', 'settings.json'), 'PreToolUse') };
    },
  },
  grok: {
    reader: 'grok',
    install: (repo, env) => {
      grok.addProjectHooks(repo, CLI);
      grok.addUserHooks(env, USER_CLI, 'gone');
      return { project: groupsOf(join(repo, grok.HOOKS_FILE), 'PreToolUse'), user: groupsOf(join(env.HOME, '.grok', 'hooks', 'yokoten.json'), 'PreToolUse') };
    },
  },
};
// The adapters with no user matcher to compare, and why. A new adapter joins one of the two tables.
const NO_USER_MATCHER: Record<string, string> = {
  'deepseek-harness': 'install writes no user hook',
  opencode: 'its user hook is a plugin that sends every tool call to the guard, with no matcher',
};

test('user guard: every adapter is in one table, with a user matcher or the reason it has none (#1100)', () => {
  for (const name of Object.keys(ADAPTERS)) {
    assert.ok(Object.hasOwn(GUARD_PAIRS, name) !== Object.hasOwn(NO_USER_MATCHER, name), `${name}: add it to GUARD_PAIRS, or to NO_USER_MATCHER with the reason`);
  }
});

test('user guard: every runtime runs it on each tool its project hook guards, and it keeps a worker out of CI files (#1100)', async () => {
  const claudeCall = (tool: string, file: string, repo: string) => ({ cwd: repo, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { file_path: file, path: file, notebook_path: file, content: 'x' } });
  const guardOf = (groups: Group[]) => groups.find((group) => group.hooks.some((hook) => / hook\b/.test(hook.command)));
  for (const [name, { reader, install, edit = claudeCall }] of Object.entries(GUARD_PAIRS)) {
    const sandbox = makeSandbox();
    const files = install(sandbox.repo, { HOME: sandbox.home });
    const project = guardOf(files.project)?.matcher?.split('|') ?? [];
    const user = guardOf(files.user);
    assert.ok(project.length > 0 && user, `${name}: both guards are written`);
    // The cause: a tool the project hook guards that the user guard skips.
    assert.deepEqual(project.filter((tool) => !user.matcher?.split('|').includes(tool)), [], `${name}: the user guard skips a tool its project hook guards`);
    const args = /\/x\/yokoten\.mjs (hook [^;]*?) 2>&1/.exec(user.hooks[0].command)?.[1].split(' ');
    assert.ok(args, user.hooks[0].command);
    const file = join(sandbox.repo, '.github', 'workflows', 'x.yml');
    const edits = project.filter((tool) => ADAPTERS[reader].readToolCall(edit(tool, file, sandbox.repo)).paths.length > 0);
    assert.ok(edits.length > 0, `${name}: the project hook guards no edit tool`);
    for (const tool of edits) {
      for (const worker of [true, false]) {
        const result = await sandbox.call(args, { input: JSON.stringify(edit(tool, file, sandbox.repo)), extra: worker ? { YOKOTEN_ROLE: 'worker' } : {} });
        const refused = result.status === 2 || /"(?:permissionDecision|decision)":"deny"/.test(result.stdout);
        assert.equal(refused, worker, `${name} user guard, ${worker ? 'worker' : 'lead'} ${tool}: ${result.stdout}${result.stderr}`);
        if (worker) assert.match(result.stderr + result.stdout, /lead-only/, `${name} ${tool}`);
      }
    }
  }
});
