// Tests for src/agents/runtimes/small/antigravity.ts.

import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { addProjectHook, addUserHooks, hasUserDir, KEPT_OFF, keptOffLine, projectHookState, readToolCall, removeUserHooks, userHooksFile, userHooksState } from '../../../../src/agents/runtimes/small/antigravity.ts';
import { makeSandbox, rowsText } from '../../../repo/helpers.ts';

/** A PreToolUse payload as agy 1.4.2 sent it in a real run (#30): camelCase, the call under `toolCall`. */
const payload = (workspace: string, name: string, args: Record<string, unknown>) =>
  JSON.stringify({
    toolCall: { name, args },
    stepIdx: 2,
    conversationId: '356a1164-dcc9-4ae7-bf64-87c7f6ddf1e5',
    workspacePaths: [workspace],
    transcriptPath: join(workspace, 'transcript.jsonl'),
    artifactDirectoryPath: workspace,
    modelName: 'gemini-3.8-flash-high',
  });

test('hook --agent antigravity: run_command by CommandLine, the edit tools by TargetFile; a refusal is a deny decision on stdout (#30)', async () => {
  const sandbox = makeSandbox();
  const call = (name: string, args: Record<string, unknown>, extra?: Record<string, string>) => sandbox.call(['hook', '--agent', 'antigravity'], { input: payload(sandbox.repo, name, args), extra });
  // The positive control: a tag push, in the shape agy sends it, is refused.
  let result = await call('run_command', { CommandLine: 'git push --tags origin', Cwd: sandbox.repo, WaitMsBeforeAsync: 5000, toolAction: 'Pushing git tags', toolSummary: 'Git push tags' });
  assert.equal(result.status, 0, 'agy reads the decision, not the exit code');
  const denial = JSON.parse(result.stdout);
  assert.equal(denial.decision, 'deny');
  assert.match(denial.reason, /^yokoten stopped this: git push --tags pushes tags \[release\]\n\n  Why       Only the owner decides when to release/);
  assert.match(result.stderr, /owner decides when to release/);
  result = await call('run_command', { CommandLine: 'git status', Cwd: sandbox.repo });
  assert.deepEqual([result.status, result.stdout], [0, ''], 'an allowed call leaves stdout empty: agy goes on');
  const worker = { YOKOTEN_ROLE: 'worker' };
  for (const name of ['write_to_file', 'replace_file_content', 'multi_replace_file_content']) {
    assert.equal(JSON.parse((await call(name, { TargetFile: join(sandbox.repo, 'AGENTS.md') }, worker)).stdout).decision, 'deny', `${name}: a worker may not edit a lead-only file`);
  }
  assert.equal(JSON.parse((await call('write_to_file', { TargetFile: join(sandbox.repo, '.agents', 'hooks.json') }, worker)).stdout).decision, 'deny', "a worker may not turn off agy's own hook");
  assert.equal((await call('write_to_file', { TargetFile: join(sandbox.repo, 'src', 'a.ts') }, worker)).stdout, '');
  assert.equal((await call('view_file', { AbsolutePath: join(sandbox.repo, 'AGENTS.md') }, worker)).stdout, '', 'reading is not editing');
  // --json keeps its own contract: the result on stdout, exit 2 on a block.
  result = await sandbox.call(['hook', '--agent', 'antigravity', '--json'], { input: payload(sandbox.repo, 'run_command', { CommandLine: 'git push --tags' }) });
  assert.deepEqual([result.status, JSON.parse(result.stdout).blocked], [2, true]);
});

test('antigravity readToolCall: the cwd is the call\'s Cwd, else the first workspace; anything else is no action', () => {
  assert.deepEqual(readToolCall(JSON.parse(payload('/w', 'run_command', { CommandLine: 'ls', Cwd: '/w/sub' }))), { command: 'ls', paths: [], cwd: '/w/sub', worker: false });
  assert.deepEqual(readToolCall(JSON.parse(payload('/w', 'replace_file_content', { TargetFile: 'a.md' }))), { command: undefined, paths: ['a.md'], cwd: '/w', worker: false });
  for (const input of [null, 'x', [], { toolCall: 'x' }, { toolCall: { name: 'run_command', args: [] } }]) {
    assert.deepEqual(readToolCall(input), { command: undefined, paths: [], cwd: undefined, worker: false });
  }
});

test('antigravity project hook: init writes the yokoten entry, keeps the others, updates an old one, and keeps one the user turned off (#984)', () => {
  const sandbox = makeSandbox();
  const file = join(sandbox.repo, '.agents', 'hooks.json');
  const cli = '.yokoten/bin/yokoten.ts';
  assert.equal(projectHookState(sandbox.repo, cli), 'added');
  sandbox.write('.agents/hooks.json', JSON.stringify({ lint: { PostToolUse: [{ matcher: 'run_command', hooks: [{ command: './lint.sh' }] }] } }));
  assert.equal(addProjectHook(sandbox.repo, cli), 'added');
  const written = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(written), ['lint', 'yokoten'], "another hook's entry stays");
  assert.equal(written.yokoten.PreToolUse[0].matcher, 'run_command|write_to_file|replace_file_content|multi_replace_file_content');
  assert.match(written.yokoten.PreToolUse[0].hooks[0].command, /"\$\(git rev-parse --show-toplevel\)\/\.yokoten\/bin\/yokoten\.ts" hook --agent antigravity/);
  assert.equal(addProjectHook(sandbox.repo, cli), 'same');
  // The positive control: an old guard is updated.
  sandbox.write('.agents/hooks.json', JSON.stringify({ yokoten: { PreToolUse: [{ matcher: 'run_command', hooks: [{ command: 'old' }] }] } }));
  assert.equal(projectHookState(sandbox.repo, cli), 'updated');
  assert.equal(addProjectHook(sandbox.repo, cli), 'updated');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).yokoten, written.yokoten);
  // #984: a guard the user turned off, old or not, stays as the user left it.
  for (const off of [{ ...written.yokoten, enabled: false }, { PreToolUse: [{ matcher: 'run_command', hooks: [{ command: 'old' }] }], enabled: false }]) {
    const text = JSON.stringify({ yokoten: off });
    sandbox.write('.agents/hooks.json', text);
    assert.equal(projectHookState(sandbox.repo, cli), KEPT_OFF, 'a disabled guard is the user\'s choice');
    assert.equal(addProjectHook(sandbox.repo, cli), KEPT_OFF);
    assert.equal(readFileSync(file, 'utf8'), text, 'the file stays byte for byte');
  }
  assert.equal(keptOffLine('.agents/hooks.json'), 'kept your Antigravity CLI guard in .agents/hooks.json off, as you set it (yokoten would turn it on): to turn it on, delete `"enabled": false` from its `"yokoten"` entry');
  sandbox.write('.agents/hooks.json', '{ not json');
  assert.deepEqual(projectHookState(sandbox.repo, cli), { kind: 'json' });
  assert.throws(() => addProjectHook(sandbox.repo, cli), /can't read/);
  assert.equal(readFileSync(file, 'utf8'), '{ not json', 'a file yokoten cannot read stays as it was');
  sandbox.write('.agents/hooks.json', '{ "yokoten": [] }');
  assert.deepEqual(projectHookState(sandbox.repo, cli), { kind: 'shape', hint: '`yokoten` should be an object' });
});

// #342: agy runs its user hooks in every workspace. The positive control is doctor's
// "added" before install, and the other entry in the file staying as it was.
test('antigravity user hook: install writes the guard in ~/.gemini/config/hooks.json and uninstall takes it out (#342)', () => {
  const sandbox = makeSandbox();
  const env = { HOME: sandbox.home };
  const file = join(sandbox.home, '.gemini', 'config', 'hooks.json');
  const cli = '"$HOME/.local/share/yokoten/bin/yokoten.mjs"';
  const missing = 'yokoten: the runtime at ~/.local/share/yokoten is missing; run the install again';
  assert.equal(userHooksFile(env), '~/.gemini/config/hooks.json');
  assert.equal(hasUserDir(env), false, 'no ~/.gemini/config: agy looks unused');
  mkdirSync(dirname(file), { recursive: true });
  assert.equal(hasUserDir(env), true);
  writeFileSync(file, JSON.stringify({ lint: { PreToolUse: [{ matcher: 'run_command', hooks: [{ command: './lint.sh' }] }] } }));
  assert.deepEqual(userHooksState(env, cli, missing), { guard: 'added' });
  assert.deepEqual(addUserHooks(env, cli, missing), { guard: 'added' });
  assert.deepEqual(userHooksState(env, cli, missing), { guard: 'same' });
  const written = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(written.lint, "another entry stays");
  assert.deepEqual(Object.keys(written), ['lint', 'yokoten']);
  assert.equal(written.yokoten.PreToolUse[0].matcher, 'run_command|write_to_file|replace_file_content|multi_replace_file_content', 'the user guard runs on the project hook tools (#1100)');
  const command = written.yokoten.PreToolUse[0].hooks[0].command as string;
  assert.ok(command.startsWith(`[ -f ${cli} ] 2>/dev/null || { echo '${missing}' >&2; exit 1; };`), 'a missing runtime refuses the call');
  assert.match(command, / hook --agent antigravity --commands-only /);
  assert.match(command, /node --max-old-space-size=256/);
  // #984: the user turned the guard off; it stays off, and the file stays as it was.
  const off = JSON.stringify({ ...written, yokoten: { ...written.yokoten, enabled: false } });
  writeFileSync(file, off);
  assert.deepEqual(userHooksState(env, cli, missing), { guard: KEPT_OFF });
  assert.equal(addUserHooks(env, cli, missing).guard, KEPT_OFF);
  assert.equal(readFileSync(file, 'utf8'), off);
  assert.equal(removeUserHooks(env), 'removed');
  assert.equal(userHooksState(env, cli, missing).guard, 'added');
  assert.equal(removeUserHooks(env), 'not there');
  writeFileSync(file, '{ not json');
  assert.equal(removeUserHooks(env), null);
  assert.equal(readFileSync(file, 'utf8'), '{ not json', 'a file yokoten cannot read stays as it was');
  // #984: a linked hooks file keeps its link when the last entry goes. The positive control
  // is the plain file above, removed.
  rmSync(file);
  const target = join(sandbox.home, 'dotfiles-hooks.json');
  writeFileSync(target, '{}\n');
  symlinkSync(target, file);
  addUserHooks(env, cli, missing);
  assert.equal(removeUserHooks(env), 'removed');
  assert.equal(lstatSync(file).isSymbolicLink(), true, 'the link stays');
  assert.equal(readFileSync(target, 'utf8'), '{}\n');
});

// #984: the user's `enabled: false` is kept by init, install and doctor, each with one line
// that says how to turn the guard on. The positive control is the guard added where the
// user set nothing.
test('antigravity: init, install and doctor keep a guard the user turned off, and say how to turn it on (#984)', async () => {
  const sandbox = makeSandbox();
  const userFile = join(sandbox.home, '.gemini', 'config', 'hooks.json');
  mkdirSync(dirname(userFile), { recursive: true });
  let result = await sandbox.call(['install', '--list']);
  assert.match(rowsText(result.stdout), /^ {2}added +Antigravity CLI hooks in ~\/\.gemini\/config\/hooks\.json: command guard$/m, 'no user value: set as before');
  result = await sandbox.call(['init', '--list', '--no-ci']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(rowsText(result.stdout), /^ {2}added the Antigravity CLI tool-call hook in \.agents\/hooks\.json$/m, 'no user value: set as before');
  const projectFile = join(sandbox.repo, '.agents', 'hooks.json');
  const turnOff = (path: string): string => {
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    const text = `${JSON.stringify({ ...saved, yokoten: { ...saved.yokoten, enabled: false } }, null, 2)}\n`;
    writeFileSync(path, text);
    return text;
  };
  const userText = turnOff(userFile);
  const projectText = turnOff(projectFile);
  const how = 'to turn it on, delete `"enabled": false` from its `"yokoten"` entry';
  result = await sandbox.call(['install', '--list']);
  assert.ok(rowsText(result.stdout).includes(`kept        Antigravity CLI hooks in ~/.gemini/config/hooks.json (yours, not yokoten's): the command guard stays off, as you set it; ${how}`), result.stdout);
  assert.equal(readFileSync(userFile, 'utf8'), userText, 'install kept the user file');
  result = await sandbox.call(['init', '--list', '--no-ci']);
  assert.ok(rowsText(result.stdout).includes(`kept your Antigravity CLI guard in .agents/hooks.json off, as you set it (yokoten would turn it on): ${how}`), result.stdout);
  assert.equal(readFileSync(projectFile, 'utf8'), projectText, 'init kept the project file');
  const doctor = rowsText((await sandbox.call(['doctor', '--all'])).stdout);
  assert.ok(doctor.includes(`antigravity-hook: you turned off the tool-call guard in .agents/hooks.json; ${how}`), doctor);
  assert.ok(doctor.includes(`antigravity-user-hook: you turned off the command guard in ~/.gemini/config/hooks.json; ${how}`), doctor);
});
