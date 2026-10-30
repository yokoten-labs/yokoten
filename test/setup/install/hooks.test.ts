// Tests for src/setup/install.ts: install: the user-level hooks of each agent.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { rowsText, shareGuardMeasure, shareSelfTest, COMMENTED, commentedGemini, doctorHandAdd, makeSandbox, onToolCall } from '../../repo/helpers.ts';
import { hasHook } from '../../../src/agents/hooks-file.ts';
import { type SetupResult } from '../../../src/setup/files.ts';
import { installIn, uninstallIn, rowsOf, assertRows, findingsOf } from './helpers.ts';

shareGuardMeasure();
shareSelfTest();

const BAD_USER_SETTINGS: [content: string, reason: (file: string) => string][] = [
  ['{ not json', (file) => `${file} is not valid JSON`],
  ['{"hooks": "x"}\n', (file) => `${file} has an unexpected shape (hooks should be an object)`],
  ['[]', (file) => `${file} has an unexpected shape (the file should be a JSON object)`],
  // A deep shape in the second event install adds: checked before the first is written.
  ['{"hooks":{"PreToolUse":[{"hooks":5}]}}', (file) => `${file} has an unexpected shape (hooks.PreToolUse[0].hooks should be a list of objects)`],
];

test('install: the session doctor and the command guard for Codex and Gemini CLI, safe twice (#211)', async () => {
  const sandbox = makeSandbox();
  const codexFile = join(sandbox.home, '.codex', 'hooks.json');
  const geminiFile = join(sandbox.home, '.gemini', 'settings.json');
  // No ~/.codex or ~/.gemini: install makes neither, and says so.
  const skipped = installIn(sandbox);
  assert.ok(skipped.ok, findingsOf(skipped, sandbox.home));
  assertRows(skipped, sandbox.home, 'skipped hook ~/.codex Codex CLI', 'skipped hook ~/.gemini Gemini CLI');
  assert.ok(!existsSync(dirname(codexFile)), 'no ~/.codex made');
  assert.ok(!existsSync(dirname(geminiFile)), 'no ~/.gemini made');
  const mine = (event: string) => ({ [event]: [{ matcher: 'read_file', hooks: [{ type: 'command', command: 'mine' }] }] });
  mkdirSync(dirname(codexFile));
  mkdirSync(dirname(geminiFile));
  writeFileSync(codexFile, JSON.stringify({ description: 'ours', hooks: mine('PreToolUse') }));
  writeFileSync(geminiFile, JSON.stringify({ theme: 'x', hooks: mine('BeforeTool') }));
  const cli = '"$HOME/.local/share/yokoten/bin/yokoten.mjs"';
  const line = 'yokoten: the runtime at ~/.local/share/yokoten is missing; run the install again';
  const atStart = (args: string) => `[ -f ${cli} ] 2>/dev/null || { echo '${line}'; exit 0; }; node ${cli} ${args}`;
  const onCall = (args: string) => onToolCall(`[ -f ${cli} ] 2>/dev/null || { echo '${line}' >&2; exit 1; }; `, cli, args);
  const hooksOf = (result: SetupResult) => result.changes.filter((change) => change.kind === 'hook' && (change.agent === 'Codex CLI' || change.agent === 'Gemini CLI')).map((change) => [change.state, change.agent, change.note, change.path]);
  const both = (state: string) => [[state, 'Codex CLI', 'SessionStart doctor', '~/.codex/hooks.json'], [state, 'Codex CLI', 'command guard', '~/.codex/hooks.json'], [state, 'Gemini CLI', 'SessionStart doctor', '~/.gemini/settings.json'], [state, 'Gemini CLI', 'command guard', '~/.gemini/settings.json']];
  assert.deepEqual(hooksOf(installIn(sandbox)), both('added'));
  assert.deepEqual(hooksOf(installIn(sandbox)), both('kept'));
  const codex = JSON.parse(readFileSync(codexFile, 'utf8'));
  assert.equal(codex.description, 'ours');
  assert.deepEqual(codex.hooks.SessionStart, [{ hooks: [{ type: 'command', command: atStart('doctor --session --agent codex') }] }]);
  assert.deepEqual(codex.hooks.PreToolUse, [...mine('PreToolUse').PreToolUse, { hooks: [{ type: 'command', command: onCall('hook --agent codex --commands-only') }], matcher: 'Bash|apply_patch' }]);
  const gemini = JSON.parse(readFileSync(geminiFile, 'utf8'));
  assert.equal(gemini.theme, 'x');
  assert.deepEqual(gemini.hooks.SessionStart, [{ hooks: [{ type: 'command', command: atStart('doctor --session --agent gemini').replace(`echo '${line}'`, `echo '{"hookSpecificOutput":{"additionalContext":"${line}"}}'`), name: 'yokoten-session' }] }]);
  assert.deepEqual(gemini.hooks.BeforeTool, [...mine('BeforeTool').BeforeTool, { hooks: [{ type: 'command', command: onCall('hook --agent gemini --commands-only'), name: 'yokoten-guard' }], matcher: 'run_shell_command|write_file|replace' }]);
  // The command guard stops a tag push in any repo, adopted or not.
  const shell = (text: string, input: object) => spawnSync(text, { shell: '/bin/sh', cwd: sandbox.repo, env: sandbox.env, input: JSON.stringify(input), encoding: 'utf8' });
  const push = { session_id: 's1', cwd: sandbox.repo, hook_event_name: 'PreToolUse', tool_input: { command: 'git push --tags' } };
  assert.equal(shell(codex.hooks.PreToolUse[1].hooks[0].command, { ...push, tool_name: 'Bash' }).status, 2, 'Codex');
  assert.equal(shell(gemini.hooks.BeforeTool[1].hooks[0].command, { ...push, hook_event_name: 'BeforeTool', tool_name: 'run_shell_command' }).status, 2, 'Gemini CLI');
});

// #342: agy and Copilot CLI also read user-level hooks, outside any project. The positive
// control is doctor's note before install, and the guard refusing a tag push through the
// command install wrote.
test('install: the user-level command guard for Antigravity CLI and Copilot CLI, safe twice (#342)', async () => {
  const sandbox = makeSandbox();
  const agyFile = join(sandbox.home, '.gemini', 'config', 'hooks.json');
  const copilotFile = join(sandbox.home, '.copilot', 'hooks', 'yokoten.json');
  mkdirSync(dirname(agyFile), { recursive: true });
  mkdirSync(dirname(copilotFile), { recursive: true });
  writeFileSync(agyFile, JSON.stringify({ lint: { PreToolUse: [{ matcher: 'run_command', hooks: [{ command: './lint.sh' }] }] } }));
  writeFileSync(copilotFile, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'mine' }] }] } }));
  const before = await sandbox.call(['doctor', '--all']);
  assert.match(rowsText(before.stdout), /note {8}antigravity-user-hook: no command guard in ~\/\.gemini\/config\/hooks\.json; `yokoten install` adds it/);
  assert.match(rowsText(before.stdout), /note {8}copilot-user-hook: no command guard in ~\/\.copilot\/hooks\/yokoten\.json; `yokoten install` adds it/);
  assertRows(installIn(sandbox), sandbox.home, 'added hook ~/.gemini/config/hooks.json Antigravity CLI', 'added hook ~/.copilot/hooks/yokoten.json Copilot CLI');
  assertRows(installIn(sandbox), sandbox.home, 'kept hook ~/.gemini/config/hooks.json Antigravity CLI', 'kept hook ~/.copilot/hooks/yokoten.json Copilot CLI');
  for (const id of ['antigravity-user-hook', 'copilot-user-hook']) assert.match(rowsText((await sandbox.call(['doctor', '--all'])).stdout), new RegExp(`^  ok {10}${id}$`, 'm'));
  const saved = JSON.parse(readFileSync(agyFile, 'utf8'));
  assert.ok(saved.lint, "another entry stays");
  assert.equal(saved.yokoten.PreToolUse[0].matcher, 'run_command|write_to_file|replace_file_content|multi_replace_file_content');
  const copilot = JSON.parse(readFileSync(copilotFile, 'utf8'));
  assert.equal(copilot.hooks.PreToolUse[0].hooks[0].command, 'mine', "the user's hook stays");
  assert.equal(copilot.hooks.PreToolUse[1].matcher, 'Bash|Edit|Write|MultiEdit|NotebookEdit');
  // A real run through the shell install wrote: a tag push is refused in each shape.
  const shell = (text: string, input: object) => spawnSync(text, { shell: '/bin/sh', cwd: sandbox.repo, env: sandbox.env, input: JSON.stringify(input), encoding: 'utf8' });
  const agyPush = { toolCall: { name: 'run_command', args: { CommandLine: 'git push --tags', Cwd: sandbox.repo } }, workspacePaths: [sandbox.repo] };
  const agy = shell(saved.yokoten.PreToolUse[0].hooks[0].command, agyPush);
  assert.equal(agy.status, 0, 'agy reads the decision, not the exit code');
  assert.match(JSON.parse(agy.stdout).reason, /git push --tags pushes tags/);
  const copilotPush = { session_id: 's1', cwd: sandbox.repo, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push --tags' } };
  const cp = shell(copilot.hooks.PreToolUse[1].hooks[0].command, copilotPush);
  assert.equal(cp.status, 2);
  assert.match(cp.stderr, /git push --tags pushes tags/);
  // uninstall takes the guard out and leaves the user's own entries.
  const removed = uninstallIn(sandbox);
  assert.ok(removed.ok, findingsOf(removed, sandbox.home));
  assertRows(removed, sandbox.home, 'removed hook ~/.gemini/config/hooks.json Antigravity CLI', 'removed hook ~/.copilot/hooks/yokoten.json Copilot CLI');
  assert.deepEqual(JSON.parse(readFileSync(agyFile, 'utf8')), { lint: { PreToolUse: [{ matcher: 'run_command', hooks: [{ command: './lint.sh' }] }] } });
  assert.deepEqual(JSON.parse(readFileSync(copilotFile, 'utf8')), { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'mine' }] }] } });
});

// #904: uninstall takes back every tool's user hook, and the files and folders install
// made for them. A hook of the user's stays, and so does a file install never touched.
test('uninstall: takes back the user hooks of Codex, Gemini CLI, Grok CLI, Muse Code and OpenCode (#904)', async () => {
  const sandbox = makeSandbox();
  const codexFile = join(sandbox.home, '.codex', 'hooks.json');
  const geminiFile = join(sandbox.home, '.gemini', 'settings.json');
  const grokFile = join(sandbox.home, '.grok', 'hooks', 'yokoten.json');
  const museFile = join(sandbox.home, '.config', 'muse', 'settings.json');
  const openCodeFile = join(sandbox.home, '.config', 'opencode', 'plugins', 'yokoten.ts');
  for (const file of [codexFile, geminiFile, grokFile, museFile, openCodeFile]) mkdirSync(dirname(file), { recursive: true });
  // A hook of the user's in Codex's file, which stays.
  const mine = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'mine' }] }] } };
  writeFileSync(codexFile, JSON.stringify(mine));
  assert.equal((await sandbox.call(['install', '--list'])).status, 0);
  for (const file of [grokFile, museFile, openCodeFile]) assert.ok(existsSync(file), `install wrote ${file}`);
  const result = uninstallIn(sandbox);
  assert.ok(result.ok, findingsOf(result, sandbox.home));
  assertRows(result, sandbox.home, 'removed hook ~/.codex/hooks.json Codex CLI', 'removed hook ~/.gemini/settings.json Gemini CLI', 'removed hook ~/.grok/hooks/yokoten.json Grok CLI', 'removed hook ~/.config/muse/settings.json Muse Code', 'removed hook ~/.config/opencode/plugins/yokoten.ts OpenCode');
  assert.deepEqual(JSON.parse(readFileSync(codexFile, 'utf8')), mine, 'the user\'s own hook stays');
  for (const file of [geminiFile, grokFile, museFile, openCodeFile]) assert.ok(!existsSync(file), `${file} is gone`);
});

// #248: a hooks file that won't parse, or where a key yokoten edits has the wrong type, is
// named and skipped, byte for byte as it was; the other CLI still gets its hooks, and install
// fails. A parse error asks for valid JSON; a wrong shape names the key instead.
test('install: an unreadable Codex or Gemini CLI hooks file is skipped, the rest goes on, and install exits 1 (#248)', async () => {
  const agents = [
    { name: 'Codex', cli: 'Codex CLI', file: '.codex/hooks.json', id: 'codex-user-hook', guard: 'PreToolUse' },
    { name: 'Gemini CLI', cli: 'Gemini CLI', file: '.gemini/settings.json', id: 'gemini-user-hook', guard: 'BeforeTool' },
  ];
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const [bad, good] of [agents, [...agents].reverse()]) {
    const shown = `~/${bad.file}`;
    const cases: [content: string, skip: string, doctor: string][] = [
      ['{ not json', `${shown} is not valid JSON`, `can't read ${shown}; make it valid JSON`],
      ...(
        [
          ['{"hooks": "x"}\n', '`hooks` should be an object'],
          ['{"hooks": []}', '`hooks` should be an object'],
          ['[]', 'the file should be a JSON object'],
          ['{"hooks": {"SessionStart": "x"}}', '`hooks.SessionStart` should be a list of objects'],
          // Deep shapes, once a crash: a number for a group's hooks, a null handler. The bad
          // guard event leaves the file whole, though the doctor hook comes first.
          [`{"hooks":{"${bad.guard}":[{"hooks":5}]}}`, `\`hooks.${bad.guard}[0].hooks\` should be a list of objects`],
          ['{"hooks":{"SessionStart":[{"hooks":[null]}]}}', '`hooks.SessionStart[0].hooks` should be a list of objects'],
        ] as const
      ).map(([content, hint]): [string, string, string] => [content, `${shown} has an unexpected shape (${hint.replaceAll('`', '')})`, `${shown} has an unexpected shape; ${hint}; fix it`]),
    ];
    for (const [content, skip, doctor] of cases) {
      const sandbox = makeSandbox();
      const badPath = join(sandbox.home, bad.file);
      const goodPath = join(sandbox.home, good.file);
      mkdirSync(dirname(badPath));
      mkdirSync(dirname(goodPath));
      writeFileSync(badPath, content);
      const result = installIn(sandbox);
      const what = `${bad.name}, ${JSON.stringify(content)}`;
      assert.equal(result.ok, false, what);
      assert.deepEqual(result.problems.map((problem) => [problem.id, problem.what]), [[bad.id, skip]], what);
      assertRows(result, sandbox.home, `skipped hook ${shown} ${bad.cli}`);
      assert.ok(!result.changes.some((change) => change.agent === bad.cli && change.state !== 'skipped'), `${what}: no hook of ${bad.cli} is named as written`);
      assert.equal(readFileSync(badPath, 'utf8'), content, `${what}: the file changed`);
      // Every other step still ran: the other CLI, Claude Code's hooks, and the marks file.
      assertRows(result, sandbox.home, `added hook ~/${good.file} ${good.cli}`, 'added hook ~/.claude/settings.json Claude Code', 'wrote file ~/.config/yokoten/private-marks');
      assert.ok(hasHook(goodPath, 'SessionStart', 'doctor'), `${what}: no ${good.name} hooks`);
      // Doctor names the same problem. A doctor call walks the sandbox like a whole install,
      // so it runs once per file pair, for the parse error where the wording differs most;
      // an unexpected shape names the same place and hint on install's own print (#943).
      if (content === '{ not json') {
        // The entry exits 1, and its screen shows no home path.
        const run = await sandbox.call(['install']);
        assert.equal(run.status, 1, what);
        assert.ok(!run.output.includes(sandbox.home), `${what}: the home path is shown`);
        assert.match(rowsText((await sandbox.call(['doctor', '--all'])).stdout), new RegExp(`^  note {8}${bad.id}: ${escape(doctor)}`, 'm'), what);
      }
    }
  }
});

test('install: a commented ~/.gemini/settings.json is left as it was and gets the hooks to add by hand; with them, it is ok (#258)', async () => {
  const sandbox = makeSandbox();
  const file = join(sandbox.home, '.gemini', 'settings.json');
  mkdirSync(dirname(file));
  const before = commentedGemini('{}');
  writeFileSync(file, before);
  const result = installIn(sandbox);
  assert.equal(result.ok, false);
  // The problem says why, and the Fix is doctor's screen, which shows the hooks to add by hand.
  assert.deepEqual(result.problems.map((problem) => [problem.what, problem.fix]), [[COMMENTED('~/.gemini/settings.json').replace(/; add this.*$/, ''), 'run `yokoten doctor --all`, then add the hooks it shows by hand']]);
  assert.equal(readFileSync(file, 'utf8'), before, 'the file changed');
  const add = doctorHandAdd(rowsText((await sandbox.call(['doctor', '--all'])).stdout), 'gemini-user-hook', '~/.gemini/settings.json');
  assert.deepEqual(Object.keys(add), ['SessionStart', 'BeforeTool']);
  assert.deepEqual(
    Object.values(add).map((groups) => (groups as { hooks: { name: string }[] }[]).map((g) => g.hooks[0].name)),
    [['yokoten-session'], ['yokoten-guard']],
  );
  // The rest still ran.
  assertRows(result, sandbox.home, 'added hook ~/.claude/settings.json Claude Code');

  // Added by hand, comments and all: install finds them the same and leaves the file.
  const after = commentedGemini(JSON.stringify(add, null, 2));
  writeFileSync(file, after);
  const again = installIn(sandbox);
  assert.ok(again.ok, findingsOf(again, sandbox.home));
  assert.deepEqual(again.changes.filter((change) => change.agent === 'Gemini CLI').map((change) => [change.state, change.note]), [['kept', 'SessionStart doctor'], ['kept', 'command guard']]);
  assert.equal(readFileSync(file, 'utf8'), after, 'the file changed');
  assert.match(rowsText((await sandbox.call(['doctor', '--all'])).stdout), /^ {2}ok {10}gemini-user-hook$/m);
});

test('install: Gemini CLI allows comments but not trailing commas, and Codex allows neither (#258)', async () => {
  for (const [dir, file, cli, content] of [
    ['.gemini', 'settings.json', 'Gemini CLI', '{ // c\n  "theme": "dark",\n}\n'],
    ['.codex', 'hooks.json', 'Codex CLI', '{ // c\n  "hooks": {}\n}\n'],
  ]) {
    const sandbox = makeSandbox();
    mkdirSync(join(sandbox.home, dir));
    writeFileSync(join(sandbox.home, dir, file), content);
    const result = installIn(sandbox);
    assert.equal(result.ok, false, cli);
    assert.deepEqual(result.problems.map((problem) => problem.what), [`~/${dir}/${file} is not valid JSON`], cli);
    assert.equal(readFileSync(join(sandbox.home, dir, file), 'utf8'), content, cli);
  }
});

test('install: an unreadable ~/.claude/settings.json is skipped, the rest goes on, and install exits 1 (#254)', async () => {
  for (const [content, reason] of BAD_USER_SETTINGS) {
    const sandbox = makeSandbox();
    const file = join(sandbox.home, '.claude', 'settings.json');
    for (const dir of ['.claude', '.codex', '.gemini']) mkdirSync(join(sandbox.home, dir));
    writeFileSync(file, content);
    const result = installIn(sandbox);
    const what = JSON.stringify(content);
    assert.equal(result.ok, false, what);
    assert.deepEqual(result.problems.map((problem) => problem.what), [reason('~/.claude/settings.json')], what);
    assert.deepEqual(rowsOf(result, sandbox.home).filter((row) => row.endsWith('Claude Code')), ['skipped hook ~/.claude/settings.json Claude Code'], what);
    assert.equal(readFileSync(file, 'utf8'), content, `${what}: the file changed`);
    // Every other step still ran: the Codex and Gemini CLI hooks, and the marks file.
    assertRows(result, sandbox.home, 'added hook ~/.codex/hooks.json Codex CLI', 'added hook ~/.gemini/settings.json Gemini CLI', 'wrote file ~/.config/yokoten/private-marks');
    // Doctor names the same problem, never that the hook is missing, and doesn't crash.
    const doctor = await sandbox.call(['doctor', '--all']);
    const said = content.startsWith('{ not') ? "can't read ~/.claude/settings.json" : '~/.claude/settings.json has an unexpected shape';
    assert.ok(rowsText(doctor.stdout).split('\n').some((line) => line.startsWith(`  MISSING     session-doctor: ${said}`)), `${what}: ${doctor.stdout}${doctor.stderr}`);
    assert.doesNotMatch(doctor.stderr, /SyntaxError|TypeError|at /, what);
    assert.equal(readFileSync(file, 'utf8'), content, `${what}: doctor changed the file`);
  }
});

// #254: only the keys install edits are checked. Another event, or an `env` install never
// touches, is the user's: install adds its hooks and keeps the key as it was.
test('install: keys in ~/.claude/settings.json that install does not edit are kept and the hooks added (#254)', async () => {
  for (const [content, key, value] of [
    ['{"hooks":{"Notification":"x"}}', 'Notification', 'x'],
    ['{"env":"x"}', 'env', 'x'],
  ] as const) {
    const sandbox = makeSandbox();
    const file = join(sandbox.home, '.claude', 'settings.json');
    mkdirSync(dirname(file));
    writeFileSync(file, content);
    const result = await sandbox.call(['install', '--list']);
    assert.equal(result.status, 0, `${content}: ${result.stdout}${result.stderr}`);
    const settings = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(key === 'env' ? settings.env : settings.hooks.Notification, value, content);
    assert.ok(hasHook(file, 'SessionStart', 'doctor'), `${content}: no doctor hook`);
    assert.ok(hasHook(file, 'PreToolUse', 'hook'), `${content}: no guard`);
    assert.match(rowsText((await sandbox.call(['doctor', '--all'])).stdout), /^  ok {10}session-doctor$/m, content);
  }
});

// #248 review: yokoten checks only the keys it edits. Other keys under `hooks`, such as
// Gemini CLI's `hooks.disabled` list, are the user's: install adds its hooks and keeps them.
test('install: other keys under hooks, such as Gemini CLI hooks.disabled, are kept and the hooks added (#248)', async () => {
  for (const [dir, file, guard] of [['.gemini', 'settings.json', 'BeforeTool'], ['.codex', 'hooks.json', 'PreToolUse']]) {
    const sandbox = makeSandbox();
    const path = join(sandbox.home, dir, file);
    mkdirSync(dirname(path));
    writeFileSync(path, '{"hooks":{"disabled":["x"],"Other":5}}');
    const result = await sandbox.call(['install', '--list']);
    assert.equal(result.status, 0, `${dir}: ${result.stdout}${result.stderr}`);
    const settings = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(settings.hooks.disabled, ['x'], dir);
    assert.equal(settings.hooks.Other, 5, dir);
    assert.ok(hasHook(path, 'SessionStart', 'doctor'), `${dir}: no doctor hook`);
    assert.ok(hasHook(path, guard, 'hook'), `${dir}: no guard`);
    assert.match(rowsText((await sandbox.call(['doctor', '--all'])).stdout), new RegExp(`^  ok {10}${dir.slice(1)}-user-hook$`, 'm'), dir);
  }
});

test("install and uninstall: the user's own keys in every agent config file stay (#984)", () => {
  const sandbox = makeSandbox();
  const mine = { matcher: 'Bash', hooks: [{ type: 'command', command: 'my-own-check' }] };
  const files: [file: string, theirs: Record<string, unknown>][] = [
    ['.claude/settings.json', { model: 'x', permissions: { allow: ['Bash(ls)'] }, hooks: { Notification: [mine] } }],
    ['.codex/hooks.json', { description: 'mine', hooks: { Stop: [mine] } }],
    ['.gemini/settings.json', { theme: 'dark', hooks: { disabled: ['x'] } }],
    ['.gemini/config/hooks.json', { lint: { PreToolUse: [{ matcher: 'run_command', hooks: [{ command: './lint.sh' }] }] } }],
    ['.copilot/hooks/yokoten.json', { version: 1, hooks: { PreToolUse: [mine] } }],
    ['.grok/hooks/yokoten.json', { note: 'mine', hooks: { PreToolUse: [mine] } }],
    ['.config/muse/settings.json', { model: 'm', hooks: { Stop: [mine] } }],
  ];
  for (const [file, theirs] of files) {
    mkdirSync(dirname(join(sandbox.home, file)), { recursive: true });
    writeFileSync(join(sandbox.home, file), JSON.stringify(theirs));
  }
  // OpenCode's plugin is one file: a file of the user's at that place stays whole.
  const plugin = join(sandbox.home, '.config', 'opencode', 'plugins', 'yokoten.ts');
  mkdirSync(dirname(plugin), { recursive: true });
  writeFileSync(plugin, 'export const mine = 1;\n');
  /** Whether every key the user wrote is in `found` with their value; a hook list may have yokoten's groups added. */
  const keeps = (found: unknown, theirs: unknown): boolean => {
    if (Array.isArray(theirs)) return Array.isArray(found) && theirs.every((item) => found.some((other) => keeps(other, item)));
    if (theirs && typeof theirs === 'object') return !!found && typeof found === 'object' && Object.entries(theirs).every(([key, value]) => keeps((found as Record<string, unknown>)[key], value));
    return found === theirs;
  };
  const check = (when: string): void => {
    for (const [file, theirs] of files) assert.ok(keeps(JSON.parse(readFileSync(join(sandbox.home, file), 'utf8')), theirs), `${when}: ${file} lost a key of the user's`);
    assert.equal(readFileSync(plugin, 'utf8'), 'export const mine = 1;\n', `${when}: the user's OpenCode plugin changed`);
  };
  const first = installIn(sandbox);
  assert.ok(first.ok, findingsOf(first, sandbox.home));
  // Positive control: install wrote its own hooks into each of those files.
  for (const agent of ['Claude Code', 'Codex CLI', 'Gemini CLI', 'Antigravity CLI', 'Copilot CLI', 'Grok CLI', 'Muse Code']) assert.ok(first.changes.some((change) => change.agent === agent && change.state === 'added'), `install added no hook for ${agent}`);
  assertRows(first, sandbox.home, 'kept hook ~/.config/opencode/plugins/yokoten.ts yours OpenCode');
  check('after install');
  // The user turns the Antigravity guard off: a second install keeps it off and says so.
  const agyFile = join(sandbox.home, '.gemini', 'config', 'hooks.json');
  const agy = JSON.parse(readFileSync(agyFile, 'utf8'));
  agy.yokoten.enabled = false;
  writeFileSync(agyFile, JSON.stringify(agy));
  const second = installIn(sandbox);
  check('after a second install');
  assert.equal(JSON.parse(readFileSync(agyFile, 'utf8')).yokoten.enabled, false, 'the guard the user turned off stays off');
  assertRows(second, sandbox.home, 'kept hook ~/.gemini/config/hooks.json yours Antigravity CLI');
  assert.ok(uninstallIn(sandbox).ok);
  check('after uninstall');
});
