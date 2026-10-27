// Tests for src/commands/desk/pick-agent.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DESK_AGENTS, pickAgent } from '../../../src/commands/desk/pick-agent.ts';

const only = (...programs: string[]) => (program: string) => programs.includes(program);
const runtimeOf = (picked: ReturnType<typeof pickAgent>) => ('problem' in picked ? picked.problem : picked.runtime);

test('desk agent: Claude Code first, else the one installed; --agent picks; none is one line (#1054)', () => {
  assert.equal(runtimeOf(pickAgent(undefined, only('claude', 'codex'))), 'claude-code');
  assert.equal(runtimeOf(pickAgent(undefined, only('codex'))), 'codex');
  assert.equal(runtimeOf(pickAgent('codex', only('claude', 'codex'))), 'codex');
  assert.equal(runtimeOf(pickAgent('codex', only('claude'))), 'Codex is not installed here: `codex` is not on PATH');
  assert.equal(runtimeOf(pickAgent('grok', only('claude'))), '--agent grok: a desk starts claude-code or codex');
  assert.equal(runtimeOf(pickAgent(undefined, only())), 'no AI to start: neither Claude Code nor Codex is installed');
});

test('desk agent: the brief is the first prompt, interactive or headless (#1054)', () => {
  const [claude, codex] = DESK_AGENTS;
  assert.deepEqual(claude?.interactive('do it'), ['claude', 'do it']);
  assert.deepEqual(claude?.headless('do it'), ['claude', '-p', 'do it']);
  assert.deepEqual(codex?.interactive('do it'), ['codex', 'do it']);
  assert.deepEqual(codex?.headless('do it'), ['codex', 'exec', 'do it']);
});
