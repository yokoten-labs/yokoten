// Tests for src/setup/init.ts: the settings and sandboxes init writes for each agent, and how it treats a file it cannot read.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { at, COMMENTED, commentedGemini, doctorHandAdd, handAdd, JSON_FIX, makeSandbox, MISSING_PROJECT, onToolCall, rowsText, shareGuardMeasure, shareSelfTest } from '../../repo/helpers.ts';
import { hasHook, skippedBecause, UnreadableHooksFile } from '../../../src/agents/hooks-file.ts';
import { addProjectSandbox as addClaudeSandbox, checkProjectSettings } from '../../../src/agents/runtimes/claude-code.ts';
import { checkProjectHooks as codexCheckHooks } from '../../../src/agents/runtimes/codex.ts';
import { checkProjectHooks as geminiCheckHooks } from '../../../src/agents/runtimes/gemini.ts';
import { type InitResult } from '../../../src/setup/init.ts';
import { initIn, has, noted, said, leadsWithHookOn, folderWith } from './helpers.ts';

shareGuardMeasure();
shareSelfTest();

const guarded = (path: string, args: string) => `[ -f ${path} ] 2>/dev/null || { echo '${MISSING_PROJECT}' >&2; exit 1; }; node ${path} ${args}`;

const guardedCall = (path: string, args: string) => onToolCall(`[ -f ${path} ] 2>/dev/null || { echo '${MISSING_PROJECT}' >&2; exit 1; }; `, path, args);

const BAD_PROJECT_SETTINGS: [content: string, reason: (file: string) => string][] = [
  ['{ not json', (file) => `can't read ${file} ${JSON_FIX('init')}`],
  ['{"hooks": "x"}\n', (file) => `${file} has an unexpected shape (\`hooks\` should be an object)`],
  ['[]', (file) => `${file} has an unexpected shape (the file should be a JSON object)`],
  ['{"env": "x"}', (file) => `${file} has an unexpected shape (\`env\` should be an object)`],
  // The stop check is the second hook init adds: checked before the first is written.
  ['{"hooks":{"Stop":[{"hooks":5}]}}', (file) => `${file} has an unexpected shape (\`hooks.Stop[0].hooks\` should be a list of objects)`],
  ['{"hooks":{"SubagentStop":[{"hooks":5}]}}', (file) => `${file} has an unexpected shape (\`hooks.SubagentStop[0].hooks\` should be a list of objects)`],
];

// Gemini CLI (v0.64.0) swaps `$GEMINI_PROJECT_DIR` in the command text for the shell-quoted
// launch folder, then runs the text in a shell (#210). This copies that against a repo whose
// path has a space and an @.
test('init: the Gemini hook command runs when Gemini quotes a path with a space (#210)', async () => {
  const sandbox = makeSandbox();
  // An older yokoten wrote the folder in double quotes; init updates that hook in place.
  const old = 'node "$GEMINI_PROJECT_DIR/.yokoten/bin/yokoten.ts" hook --agent gemini';
  sandbox.write('.gemini/settings.json', JSON.stringify({ hooks: { BeforeTool: [{ matcher: 'run_shell_command', hooks: [{ type: 'command', command: old, name: 'yokoten' }] }] } }));
  const result = sandbox.run(['init', '--list']); // a real process: the entry point of init, end to end
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /updated the Gemini CLI tool-call hook/);
  const repo = join(dirname(sandbox.repo), 'my repo@1');
  renameSync(sandbox.repo, repo);
  const groups = JSON.parse(readFileSync(join(repo, '.gemini', 'settings.json'), 'utf8')).hooks.BeforeTool;
  assert.equal(groups.length, 1, 'updated, not added');
  const command: string = groups[0].hooks[0].command;
  assert.equal(command, guardedCall('$GEMINI_PROJECT_DIR/.yokoten/bin/yokoten.mjs', 'hook --agent gemini'));
  // shell-quote, which Gemini uses, writes a path with a space and no single quote as
  // '…'; a single quote inside would become '\''.
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  const input = JSON.stringify({ session_id: 's1', cwd: repo, hook_event_name: 'BeforeTool', tool_name: 'run_shell_command', tool_input: { command: 'git push --tags' } });
  const asGemini = (text: string) =>
    spawnSync('bash', ['-c', text.replaceAll('$GEMINI_PROJECT_DIR', quote(repo))], { cwd: repo, env: { ...sandbox.env, GEMINI_PROJECT_DIR: repo }, input, encoding: 'utf8' });
  const ran = asGemini(command);
  assert.equal(ran.status, 2, ran.stderr);
  assert.match(ran.stderr, /owner decides when to release/);
  // The control: the old quoted command never reaches yokoten.
  const broken = asGemini(old);
  assert.notEqual(broken.status, 2);
  assert.match(broken.stderr, /Cannot find module/);
});

test('init: adds the practices, keeps what is there, and doctor asks for the remote next', async () => {
  const sandbox = makeSandbox();
  // An AGENTS.md with `## This project` is left to `update` (#378).
  const ours = '# our own rules\n\n## This project\n\nours\n';
  sandbox.write('AGENTS.md', ours);
  sandbox.write('.github/SECURITY.md', '# email us\n');
  // The user's own Codex and Gemini CLI settings stay.
  const mine = (event: string) => ({ [event]: [{ matcher: 'read_file', hooks: [{ type: 'command', command: 'mine' }] }] });
  sandbox.write('.codex/hooks.json', JSON.stringify({ description: 'ours', hooks: mine('PreToolUse') }));
  sandbox.write('.gemini/settings.json', JSON.stringify({ theme: 'x', hooks: mine('BeforeTool') }));
  assert.match(rowsText(sandbox.run(['doctor', '--all']).stdout), /note +codex-hook: no tool-call guard/, 'reported, not counted as missing'); // a real process: the entry point of doctor
  assert.match(rowsText((await sandbox.call(['doctor', '--all'])).stdout), /note +antigravity-hook: no tool-call guard in \.agents\/hooks\.json/, 'the positive control for the Antigravity CLI step (#30)');
  let result = initIn(sandbox);
  assert.ok(result.ok, said(result));
  assert.ok(has(result, 'kept', /^AGENTS\.md/));
  assert.ok(has(result, 'wrote', /^\.githooks\/pre-commit/));
  assert.ok(has(result, 'wrote', /^\.yokoten\/ \(a copy of yokoten, about 90 files; committing it is the point\)/));
  assert.ok(has(result, 'wrote', /^\.github\/CODEOWNERS \(the lead-only paths; make the repo, add the remote and push, then put your GitHub handle in place of @YOUR_GITHUB_HANDLE\)/));
  assert.equal(readFileSync(join(sandbox.repo, 'AGENTS.md'), 'utf8'), ours);
  assert.ok(has(result, 'kept', /^\.github\/SECURITY\.md/));
  assert.equal(readFileSync(join(sandbox.repo, '.github/SECURITY.md'), 'utf8'), '# email us\n', 'the project\'s own policy stays');
  assert.ok(has(result, 'wrote', /^\.github\/dependabot\.yml/));
  assert.ok(has(result, 'wrote', /^CHANGELOG\.md/));
  assert.match(readFileSync(join(sandbox.repo, 'CHANGELOG.md'), 'utf8'), /^## \[Unreleased\]$/m, 'the changelog skeleton (#34)');
  assert.ok(has(result, 'wrote', /^changes\/README\.md/));
  assert.match(readFileSync(join(sandbox.repo, 'changes/README.md'), 'utf8'), /node \.yokoten\/bin\/yokoten\.ts changelog --write/, 'the change files folder (#132)');
  assert.ok(statSync(join(sandbox.repo, '.githooks', 'pre-commit')).mode & 0o100);
  assert.ok(has(result, 'wrote', /^\.gitignore \(\.worktrees\/, \.yokoten-agent\.json\)$/), 'the .gitignore test below holds each case');
  // The workflows are the kit's, byte for byte: the "no workflows" test below holds each line.
  assert.ok(existsSync(join(sandbox.repo, '.yokoten', 'VERSION')));
  assert.equal(sandbox.git('config', 'core.hooksPath').stdout.trim(), '.githooks');
  // Again: nothing changes.
  result = initIn(sandbox);
  assert.ok(has(result, 'kept', /^\.github\/SECURITY\.md/));
  assert.ok(has(result, 'kept', /^\.github\/dependabot\.yml/));
  assert.ok(has(result, 'kept', /^CHANGELOG\.md/));
  assert.ok(has(result, 'kept', /^the tool-call hook/));
  assert.ok(has(result, 'kept', /^TZ=UTC for agent sessions/));
  const settings = JSON.parse(readFileSync(join(sandbox.repo, '.claude', 'settings.json'), 'utf8'));
  assert.equal(settings.hooks.PreToolUse.length, 1);
  assert.ok(has(result, 'kept', /^the stop check/));
  const stopHook = { hooks: [{ type: 'command', command: guarded('"$CLAUDE_PROJECT_DIR/.yokoten/bin/yokoten.mjs"', 'hook --stop'), timeout: 600 }] };
  assert.deepEqual(settings.hooks.Stop, [stopHook], 'the stop check, once (#92)');
  assert.deepEqual(settings.hooks.SubagentStop, [stopHook], 'SubagentStop, once (#614)');
  assert.equal(settings.env.TZ, 'UTC', 'agent commits record no time zone (#40)');
  assert.equal(settings.env.NODE_USE_ENV_PROXY, '1', "Node's fetch goes through the sandbox's proxy (#1347)");
  assert.ok(has(result, 'kept', /^NODE_USE_ENV_PROXY=1 for agent sessions/));
  assert.ok(has(result, 'kept', /^the Codex tool-call hook/));
  assert.ok(has(result, 'kept', /^the Gemini CLI tool-call hook/));
  const codex = JSON.parse(readFileSync(join(sandbox.repo, '.codex', 'hooks.json'), 'utf8'));
  assert.equal(codex.description, 'ours');
  assert.equal(codex.hooks.PreToolUse.length, 2);
  assert.deepEqual(codex.hooks.PreToolUse[1], {
    hooks: [{ type: 'command', command: guardedCall('"$(git rev-parse --show-toplevel)/.yokoten/bin/yokoten.mjs"', 'hook --agent codex') }],
    matcher: 'Bash|apply_patch',
  });
  const gemini = JSON.parse(readFileSync(join(sandbox.repo, '.gemini', 'settings.json'), 'utf8'));
  assert.equal(gemini.theme, 'x');
  assert.equal(gemini.hooks.BeforeTool.length, 2);
  assert.deepEqual(gemini.hooks.BeforeTool[1], {
    hooks: [{ type: 'command', command: guardedCall('$GEMINI_PROJECT_DIR/.yokoten/bin/yokoten.mjs', 'hook --agent gemini'), name: 'yokoten' }],
    matcher: 'run_shell_command|write_file|replace',
  });
  // The stop checks (#211): Codex's Stop and Gemini's AfterAgent take no matcher, once each.
  assert.ok(has(result, 'kept', /^the Codex stop check/));
  assert.ok(has(result, 'kept', /^the Gemini CLI stop check/));
  assert.deepEqual(codex.hooks.Stop, [{ hooks: [{ type: 'command', command: guarded('"$(git rev-parse --show-toplevel)/.yokoten/bin/yokoten.mjs"', 'hook --stop --agent codex'), timeout: 600 }] }]);
  assert.deepEqual(gemini.hooks.AfterAgent, [{ hooks: [{ type: 'command', command: guarded('$GEMINI_PROJECT_DIR/.yokoten/bin/yokoten.mjs', 'hook --stop --agent gemini'), name: 'yokoten-stop', timeout: 600_000 }] }]);
  // Codex's hooks are in place; this home has no ~/.codex, so doctor says nothing of its trust (#341).
  assert.match(rowsText((await sandbox.call(['doctor', '--all'])).stdout), /ok +codex-hook: \.codex\/hooks\.json is in place; trust not checked, no ~\/\.codex\n +ok +gemini-hook\n +ok +antigravity-hook/);
  // No agent home, so no trust step: the next test holds those lines (#654).
  // Antigravity CLI (#30): its own file, and Copilot CLI reads .claude/settings.json.
  assert.ok(has(result, 'kept', /^the Antigravity CLI tool-call hook in \.agents\/hooks\.json/));
  const agents = JSON.parse(readFileSync(join(sandbox.repo, '.agents', 'hooks.json'), 'utf8'));
  assert.deepEqual(agents.yokoten.PreToolUse[0].hooks[0].command, guardedCall('"$(git rev-parse --show-toplevel)/.yokoten/bin/yokoten.mjs"', 'hook --agent antigravity'));
  // The pre-commit hook runs the vendored check on a real commit.
  sandbox.git('add', '.');
  const commit = sandbox.git('commit', '-qm', 'adopt yokoten');
  assert.equal(commit.status, 0, commit.stderr);
  sandbox.write('leak.md', `me${at}gmail.com\n`);
  sandbox.git('add', 'leak.md');
  assert.notEqual(sandbox.git('commit', '-qm', 'leak').status, 0);
  // A secret is refused the same way (#8): the secrets tests hold it. The stages of the
  // road after init are in report.test.ts.
});

// #988: yokoten wants TZ=UTC for agent commits, but a TZ the user set in
// .claude/settings.json stays. init says so in one line and never prints the value. The
// positive control: the old init wrote UTC over it and said "updated".
test("init: a TZ the user set in .claude/settings.json is kept, with one note (#988)", async () => {
  const sandbox = makeSandbox();
  const file = join(sandbox.repo, '.claude', 'settings.json');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ env: { TZ: 'Europe/Paris' } }));
  const result = initIn(sandbox);
  assert.ok(result.ok, said(result));
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).env.TZ, 'Europe/Paris', "the user's value stays");
  assert.deepEqual(result.changes.filter((change) => change.yours).map((change) => change.note), ['your TZ in .claude/settings.json; yokoten wants UTC so commit times carry no time zone: set "TZ": "UTC" under "env" there'], 'one kept setting of the user\'s, shown as a note');
  assert.doesNotMatch(said(result), /Europe\/Paris/, 'the value is not printed');
  assert.doesNotMatch(said(result), /updated TZ=UTC/);
});

// #1347: the sandbox sends network through a proxy, and Node's own fetch reads it only with
// NODE_USE_ENV_PROXY=1. init adds the key; a value the user set stays, with one note and no value shown.
test('init: NODE_USE_ENV_PROXY=1 is added for agent sessions, and a value the user set is kept (#1347)', async () => {
  const fresh = makeSandbox();
  const added = initIn(fresh);
  assert.ok(added.ok, said(added));
  assert.ok(has(added, 'added', /^NODE_USE_ENV_PROXY=1 for agent sessions in \.claude\/settings\.json$/));
  assert.equal(JSON.parse(readFileSync(join(fresh.repo, '.claude', 'settings.json'), 'utf8')).env.NODE_USE_ENV_PROXY, '1');
  const sandbox = makeSandbox();
  const file = join(sandbox.repo, '.claude', 'settings.json');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ env: { NODE_USE_ENV_PROXY: 'off-by-choice' } }));
  const result = initIn(sandbox);
  assert.ok(result.ok, said(result));
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).env.NODE_USE_ENV_PROXY, 'off-by-choice', "the user's value stays");
  assert.deepEqual(result.changes.filter((change) => change.yours).map((change) => change.note), ['your NODE_USE_ENV_PROXY in .claude/settings.json; yokoten wants 1 so a Node program reaches the network in the sandbox: set "NODE_USE_ENV_PROXY": "1" under "env" there']);
  assert.doesNotMatch(said(result), /off-by-choice/, 'the value is not printed');
});

/** The DeepSeek Harness bridge commands init names, one a line, so each copies whole (#1040). */
const DSH_STEPS = [
  'dsh plugin --profile <profile> add @deepseek-ai/dsh-hooks-claude-code@0.2.1-rc.2',
  'dsh plugin --profile <profile> add @deepseek-ai/dsh-hook-protocol@0.2.1-rc.2',
  'dsh <profile> --patch .dsh/yokoten.patch.yml',
];

test('init: with no agent installed, the git hook change leads and no trust step is named (#654)', async () => {
  const sandbox = makeSandbox();
  const result = initIn(sandbox);
  assert.ok(result.ok, said(result));
  assert.ok(leadsWithHookOn(result), said(result));
  assert.doesNotMatch(said(result), /GitHub Copilot CLI runs the hooks/);
  assert.doesNotMatch(said(result), /to trust this folder in Copilot CLI/);
  assert.doesNotMatch(said(result), /Codex runs the hooks/);
  assert.doesNotMatch(said(result), /to trust them in Codex/);
  assert.doesNotMatch(said(result), /Muse Code runs the hooks/);
  assert.doesNotMatch(said(result), /Grok CLI runs the hooks/);
  assert.doesNotMatch(said(result), /dsh plugin --profile/);
  assert.doesNotMatch(said(result), /dsh <profile> --patch/);
  // No trust step for an agent that is not here. The one DeepSeek Harness note a system may add is #332's (its hooks run in PowerShell), never a step.
  assert.equal(noted(result, /trust/), undefined, 'no step for an agent that is not here');
  const harness = noted(result, /DeepSeek Harness/);
  assert.ok(harness === undefined || /issue #332/.test(harness.what), 'the only DeepSeek Harness note is #332');
  for (const file of ['.codex/hooks.json', '.muse/hooks.json', '.claude/settings.json', '.gemini/settings.json', '.agents/hooks.json', '.grok/hooks/yokoten.json', '.dsh/hooks.json']) {
    assert.ok(existsSync(join(sandbox.repo, file)), file);
  }
});

test('init: every installed agent is named in one trust note, with the command (#654, #661)', async () => {
  const sandbox = makeSandbox();
  mkdirSync(join(sandbox.home, '.copilot'));
  mkdirSync(join(sandbox.home, '.codex'));
  mkdirSync(join(sandbox.home, '.config', 'muse'), { recursive: true });
  mkdirSync(join(sandbox.home, '.grok'));
  mkdirSync(join(sandbox.home, '.dsh', 'profiles'), { recursive: true });
  const result = initIn(sandbox);
  assert.ok(result.ok, said(result));
  const trustNote = noted(result, /^yokoten's guard is off in /);
  assert.deepEqual([trustNote?.what, trustNote?.fix], ["yokoten's guard is off in Codex, Grok CLI, Copilot CLI and Muse Code until a person turns it on", 'yokoten trust']);
  assert.doesNotMatch(said(result), /runs the hooks in .* only after you trust/);
  if (process.platform === 'win32') {
    assert.ok(noted(result, /not checked on Windows yet/), said(result));
    assert.doesNotMatch(said(result), /dsh plugin --profile/);
  } else {
    assert.deepEqual(noted(result, /^DeepSeek Harness checks calls/)?.fix.split('\n'), DSH_STEPS);
  }
});

test('init: safe defaults, Dependabot and a security policy; doctor lists the security switches (#35)', async () => {
  const sandbox = makeSandbox();
  const r = initIn(sandbox);
  assert.ok(r.ok, said(r));
  assert.ok(has(r, 'wrote', /^\.github\/SECURITY\.md/));
  assert.ok(has(r, 'wrote', /^\.github\/dependabot\.yml/));
  const dependabot = readFileSync(join(sandbox.repo, '.github/dependabot.yml'), 'utf8');
  for (const line of [/package-ecosystem: github-actions/, /interval: monthly/, /default-days: 7/, /patterns: \['\*'\]/, /prefix: ci/]) assert.match(dependabot, line);
  assert.equal([...dependabot.matchAll(/^\s*- package-ecosystem:/gm)].length, 1, 'actions only, since the stack is unknown');
  assert.match(readFileSync(join(sandbox.repo, '.github/SECURITY.md'), 'utf8'), /\*\*Report a vulnerability\*\*/);
  const doctor = rowsText((await sandbox.call(['doctor', '--all'])).stdout);
  for (const sw of [/private vulnerability reporting/, /secret scanning with push protection/, /Dependabot alerts/]) assert.match(doctor, sw);
  // Right after init only the license is missing: say what to do, not that init adds it (#208).
  const security = (text: string) => text.split('\n').find((l) => / security-files\b/.test(l)) ?? '';
  assert.match(security(doctor), /: no license file; choose a license and add it as LICENSE$/);
  assert.doesNotMatch(security(doctor), /yokoten init/);
  rmSync(join(sandbox.repo, '.github/SECURITY.md'));
  assert.match(security(rowsText((await sandbox.call(['doctor', '--all'])).stdout)), /: no security policy \(SECURITY\.md\), no license file; run `yokoten init` to add the security policy and Dependabot, and choose a license and add it as LICENSE$/);
  // With a license and the policy, the step is done: the --no-ci test holds that line.
});

test('init: an unreadable project .codex/hooks.json or .gemini/settings.json is skipped, the rest goes on, and init exits 1 (#248)', async () => {
  const files = [
    ['.codex/hooks.json', '.gemini/settings.json', 'the Codex hooks', 'Stop', (root: string) => codexCheckHooks(root)],
    ['.gemini/settings.json', '.codex/hooks.json', 'the Gemini CLI hooks', 'AfterAgent', (root: string) => geminiCheckHooks(root, '.yokoten/bin/yokoten.mjs')],
  ] as const;
  const casesFor = (bad: string, stop: string) => [
    ['{ not json', `can't read ${bad} (make it valid JSON, then run \`yokoten init\` again)`],
    ['{"hooks": "x"}', `${bad} has an unexpected shape (\`hooks\` should be an object)`],
    // The stop event is added second: a bad one leaves the file whole.
    [`{"hooks":{"${stop}":[{"hooks":[1]}]}}`, `${bad} has an unexpected shape (\`hooks.${stop}[0].hooks\` should be a list of objects)`],
  ];
  // Every case is read by the check init runs before it writes the file, and skipped with the line init prints.
  for (const [bad, , , stop, check] of files) {
    for (const [content, skip] of casesFor(bad, stop)) {
      const root = folderWith({ [bad]: content });
      assert.throws(() => check(root), (err) => err instanceof UnreadableHooksFile && skippedBecause(bad, err.problem, 'init') === skip, `${bad}, ${content}`);
    }
  }
  // End to end, one case for each file: the rest of init goes on.
  for (const [bad, good, name, stop] of files) {
    for (const [content, skip] of casesFor(bad, stop).filter((_, index) => index === (bad === '.codex/hooks.json' ? 0 : 2))) {
      const sandbox = makeSandbox();
      mkdirSync(join(sandbox.repo, dirname(bad)));
      writeFileSync(join(sandbox.repo, bad), content);
      const result = initIn(sandbox);
      const what = `${bad}, ${JSON.stringify(content)}`;
      assert.equal(result.ok, false, said(result));
      assert.ok(result.problems.some((problem) => problem.what === `skipped ${name}: ${skip}`), `${what}: ${said(result)}`);
      assert.equal(readFileSync(join(sandbox.repo, bad), 'utf8'), content, `${what}: the file changed`);
      assert.ok(hasHook(join(sandbox.repo, good), dirname(good) === '.codex' ? 'Stop' : 'AfterAgent', 'hook'), `${what}: no stop check in ${good}`);
      assert.ok(has(result, 'added', /^TZ=UTC for agent sessions/), what);
    }
  }
});

test('init: a commented .gemini/settings.json is left as it was and gets the hooks to add by hand; with them, it is ok (#258)', async () => {
  const sandbox = makeSandbox();
  const file = join(sandbox.repo, '.gemini', 'settings.json');
  const before = commentedGemini('{ "BeforeTool": [] }');
  sandbox.write('.gemini/settings.json', before);
  const result = initIn(sandbox);
  assert.equal(result.ok, false, said(result));
  assert.doesNotMatch(said(result), /can't read|unexpected shape/);
  assert.equal(readFileSync(file, 'utf8'), before, 'the file changed');
  const add = handAdd(noted(result, /^skipped the Gemini CLI hooks/)?.what ?? '', `skipped the Gemini CLI hooks: ${COMMENTED('.gemini/settings.json')}, then run \`yokoten init\` again:`);
  // The tool-call command may carry a fail-closed wrapper (#260); either way it checks for the
  // project runtime first, then runs the yokoten guard with node.
  const runtimePath = '$GEMINI_PROJECT_DIR/.yokoten/bin/yokoten.mjs';
  const guardCall = String((add.BeforeTool?.[0] as { hooks?: { command?: unknown }[] } | undefined)?.hooks?.[0]?.command);
  const missingCheck = guarded(runtimePath, 'x').slice(0, -`node ${runtimePath} x`.length);
  assert.ok(guardCall.startsWith(missingCheck), guardCall);
  assert.match(guardCall, /\bnode(?: --\S+)* \$GEMINI_PROJECT_DIR\/\.yokoten\/bin\/yokoten\.mjs hook --agent gemini(?: |$)/);
  assert.deepEqual(add, {
    BeforeTool: [{ hooks: [{ type: 'command', command: guardCall, name: 'yokoten' }], matcher: 'run_shell_command|write_file|replace' }],
    AfterAgent: [{ hooks: [{ type: 'command', command: guarded('$GEMINI_PROJECT_DIR/.yokoten/bin/yokoten.mjs', 'hook --stop --agent gemini'), name: 'yokoten-stop', timeout: 600_000 }] }],
  });
  assert.ok(hasHook(join(sandbox.repo, '.codex', 'hooks.json'), 'Stop', 'hook'), 'no Codex stop check');
  assert.deepEqual(doctorHandAdd(rowsText((await sandbox.call(['doctor', '--all'])).stdout), 'gemini-hook', '.gemini/settings.json'), add);

  const after = commentedGemini(JSON.stringify(add, null, 2)).replace(/\n}\n$/, `,\n  "security": {\n    "disableYoloMode": true\n  }\n}\n`);
  writeFileSync(file, after);
  const again = initIn(sandbox);
  assert.ok(again.ok, said(again));
  assert.ok(has(again, 'kept', /^the Gemini CLI tool-call hook in \.gemini\/settings\.json$/));
  assert.ok(has(again, 'kept', /^the Gemini CLI stop check in \.gemini\/settings\.json/));
  assert.equal(readFileSync(file, 'utf8'), after, 'the file changed');
  assert.match(rowsText((await sandbox.call(['doctor', '--all'])).stdout), /^ {2}ok {11}gemini-hook$/m);
});

test('init: an unreadable project .claude/settings.json is skipped, the rest goes on, and init exits 1 (#254)', async () => {
  // Every bad file is read by the check init runs first, and skipped with the line init
  // prints, before anything is written.
  // The sandbox step and doctor read it too, and leave it byte for byte: yokoten never
  // overwrites the user's config. One sandbox, one file at a time, doctor in this process.
  const reader = makeSandbox();
  const readerFile = join(reader.repo, '.claude', 'settings.json');
  mkdirSync(dirname(readerFile));
  for (const [content, reason] of BAD_PROJECT_SETTINGS) {
    const root = folderWith({ '.claude/settings.json': content });
    const what = JSON.stringify(content);
    assert.throws(() => checkProjectSettings(root), (err) => err instanceof UnreadableHooksFile && skippedBecause('.claude/settings.json', err.problem, 'init') === reason('.claude/settings.json'), what);
    assert.equal(readFileSync(join(root, '.claude', 'settings.json'), 'utf8'), content, `${what}: the file changed`);
    assert.doesNotThrow(() => addClaudeSandbox(root), what);
    assert.equal(readFileSync(join(root, '.claude', 'settings.json'), 'utf8'), content, `${what}: the sandbox step changed the file`);
    writeFileSync(readerFile, content);
    const doctor = await reader.call(['doctor', '--all']);
    assert.doesNotMatch(doctor.stderr, /SyntaxError|TypeError|at /, what);
    assert.equal(readFileSync(readerFile, 'utf8'), content, `${what}: doctor changed the file`);
  }
  // End to end, two of them: a file that won't parse, and a bad Stop hook, read before the
  // first hook is written. The rest of init goes on.
  for (const [content, reason] of [BAD_PROJECT_SETTINGS[0], BAD_PROJECT_SETTINGS[4]]) {
    const sandbox = makeSandbox();
    const file = join(sandbox.repo, '.claude', 'settings.json');
    mkdirSync(dirname(file));
    writeFileSync(file, content);
    const result = initIn(sandbox);
    const what = JSON.stringify(content);
    assert.equal(result.ok, false, said(result));
    assert.ok(result.problems.some((problem) => problem.what === `skipped the Claude Code settings: ${reason('.claude/settings.json')}`), `${what}: ${said(result)}`);
    assert.doesNotMatch(said(result), /in \.claude\/settings\.json/, what);
    assert.equal(readFileSync(file, 'utf8'), content, `${what}: the file changed`);
    // Every other step still ran: the Codex and Gemini CLI hooks, and the commit check.
    assert.ok(hasHook(join(sandbox.repo, '.codex', 'hooks.json'), 'Stop', 'hook'), `${what}: no Codex stop check`);
    assert.ok(hasHook(join(sandbox.repo, '.gemini', 'settings.json'), 'AfterAgent', 'hook'), `${what}: no Gemini CLI stop check`);
    assert.ok(leadsWithHookOn(result), what);
    const doctor = await sandbox.call(['doctor', '--all']);
    assert.doesNotMatch(doctor.stderr, /SyntaxError|TypeError|at /, what);
    assert.equal(readFileSync(file, 'utf8'), content, `${what}: doctor changed the file`);
  }
});

test('init: writes each agent sandbox, a second run changes nothing, and a sandbox the user set is kept (#589)', async () => {
  const sandbox = makeSandbox();
  const result = initIn(sandbox);
  assert.ok(result.ok, said(result));
  assert.ok(has(result, 'added', /^the Claude Code sandbox in \.claude\/settings\.json \(shell commands stay in the project/));
  assert.ok(has(result, 'added', /^the Codex sandbox in \.codex\/config\.toml \(writes stay in the project/));
  assert.ok(has(result, 'added', /^the Gemini sandbox in \.gemini\/settings\.json \(YOLO mode/));
  assert.ok(has(result, 'added', /^the Grok sandbox in \.grok\/sandbox\.toml \(the yokoten profile/));
  const claude = JSON.parse(readFileSync(join(sandbox.repo, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(claude.sandbox, { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false });
  assert.ok(claude.hooks.PreToolUse.length === 1, 'the sandbox keeps the hooks');
  assert.equal(claude.env.TZ, 'UTC');
  const codex = readFileSync(join(sandbox.repo, '.codex', 'config.toml'), 'utf8');
  assert.match(codex, /^sandbox_mode = "workspace-write"$/m);
  assert.match(codex, /^approval_policy = "on-request"$/m);
  assert.match(codex, /^\[sandbox_workspace_write\]$/m);
  assert.match(codex, /^network_access = false$/m);
  const gemini = JSON.parse(readFileSync(join(sandbox.repo, '.gemini', 'settings.json'), 'utf8'));
  assert.deepEqual(gemini.security, { disableYoloMode: true });
  assert.ok(gemini.hooks.BeforeTool.length >= 1, 'the sandbox keeps the hooks');
  const grok = readFileSync(join(sandbox.repo, '.grok', 'sandbox.toml'), 'utf8');
  assert.match(grok, /^\[profiles\.yokoten\]$/m);
  assert.match(grok, /^extends = "workspace"$/m);
  const again = initIn(sandbox);
  assert.ok(again.ok, said(again));
  assert.ok(has(again, 'kept', /^the Claude Code sandbox in \.claude\/settings\.json$/));
  assert.ok(has(again, 'kept', /^the Codex sandbox in \.codex\/config\.toml$/));
  assert.ok(has(again, 'kept', /^the Gemini sandbox in \.gemini\/settings\.json$/));
  assert.ok(has(again, 'kept', /^the Grok sandbox in \.grok\/sandbox\.toml$/));
  assert.deepEqual(JSON.parse(readFileSync(join(sandbox.repo, '.claude', 'settings.json'), 'utf8')).sandbox, { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false });

  // The user sets each sandbox their own way: a third run keeps them, and still exits 0.
  const setJson = (file: string, change: (data: Record<string, unknown>) => void) => {
    const data = JSON.parse(readFileSync(join(sandbox.repo, file), 'utf8'));
    change(data);
    writeFileSync(join(sandbox.repo, file), JSON.stringify(data));
  };
  // The Claude Code file loses its hooks too: init puts them back next to the user's sandbox.
  setJson('.claude/settings.json', (data) => { data.sandbox = { enabled: false }; delete data.hooks; });
  setJson('.gemini/settings.json', (data) => { data.security = { disableYoloMode: false }; });
  sandbox.write('.codex/config.toml', 'sandbox_mode = "danger-full-access"\napproval_policy = "on-request"\n\n[sandbox_workspace_write]\nnetwork_access = false\n');
  sandbox.write('.grok/sandbox.toml', '[profiles.yokoten]\nextends = "devbox"\n');
  // A sandbox kept because the user set it is the user's, so the screen shows it as a note (#964).
  const yours = initIn(sandbox);
  assert.ok(yours.ok, said(yours));
  for (const [agent, file] of [['Claude Code', '.claude/settings.json'], ['Codex', '.codex/config.toml'], ['Gemini', '.gemini/settings.json'], ['Grok', '.grok/sandbox.toml']]) {
    const kept = yours.changes.find((change) => change.note === `your ${agent} sandbox in ${file} (doctor names what differs)`);
    assert.deepEqual([kept?.state, kept?.yours], ['kept', true], agent);
  }
  assert.deepEqual(JSON.parse(readFileSync(join(sandbox.repo, '.claude', 'settings.json'), 'utf8')).sandbox, { enabled: false });
  assert.ok(hasHook(join(sandbox.repo, '.claude', 'settings.json'), 'PreToolUse', 'hook'), 'the hooks still go in');
  assert.deepEqual(JSON.parse(readFileSync(join(sandbox.repo, '.gemini', 'settings.json'), 'utf8')).security, { disableYoloMode: false });
  assert.match(readFileSync(join(sandbox.repo, '.codex', 'config.toml'), 'utf8'), /^sandbox_mode = "danger-full-access"$/m);
  assert.match(readFileSync(join(sandbox.repo, '.grok', 'sandbox.toml'), 'utf8'), /^extends = "devbox"$/m);
});

// #984 for init's writes: an agent file the project already has is merged, never replaced.
test('init (#984): a project agent file that is there gets yokoten\'s entries, and every key of the user\'s stays', () => {
  const sandbox = makeSandbox();
  const claude = { permissions: { allow: ['Bash(make test)'] }, env: { FOO: 'ours' }, hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'our-lint' }] }] } };
  const gemini = { theme: 'Dracula', general: { vimMode: true } };
  sandbox.write('.claude/settings.json', `${JSON.stringify(claude, null, 2)}\n`);
  sandbox.write('.gemini/settings.json', `${JSON.stringify(gemini, null, 2)}\n`);
  const result = initIn(sandbox);
  assert.ok(result.ok, said(result));
  // The positive control: yokoten's entries went in, so init did write these files.
  assert.ok(has(result, 'added', /^the tool-call hook in \.claude\/settings\.json$/), said(result));
  assert.ok(has(result, 'added', /^the Gemini CLI tool-call hook in \.gemini\/settings\.json$/), said(result));
  const claudeAfter = JSON.parse(readFileSync(join(sandbox.repo, '.claude', 'settings.json'), 'utf8'));
  assert.ok(hasHook(join(sandbox.repo, '.claude', 'settings.json'), 'PreToolUse', 'hook'));
  // The user's keys, and their own hook, stay as they were.
  assert.deepEqual(claudeAfter.permissions, claude.permissions);
  assert.equal(claudeAfter.env.FOO, 'ours');
  assert.ok(JSON.stringify(claudeAfter.hooks.PreToolUse).includes('our-lint'), 'the user\'s own hook stays');
  const geminiAfter = JSON.parse(readFileSync(join(sandbox.repo, '.gemini', 'settings.json'), 'utf8'));
  assert.equal(geminiAfter.theme, 'Dracula');
  assert.deepEqual(geminiAfter.general, gemini.general);
  // A second run changes neither file.
  const before = [readFileSync(join(sandbox.repo, '.claude', 'settings.json'), 'utf8'), readFileSync(join(sandbox.repo, '.gemini', 'settings.json'), 'utf8')];
  assert.ok(initIn(sandbox).ok);
  assert.deepEqual([readFileSync(join(sandbox.repo, '.claude', 'settings.json'), 'utf8'), readFileSync(join(sandbox.repo, '.gemini', 'settings.json'), 'utf8')], before);
});

test('init: only an agent\'s project sandbox change carries isSandbox, added then kept (#1360)', () => {
  const sandbox = makeSandbox();
  const marked = (result: InitResult) => result.changes.filter((change) => change.isSandbox);
  const first = marked(initIn(sandbox));
  assert.ok(first.some((change) => change.agent === 'Claude Code' && change.state === 'added' && change.path === '.claude/settings.json'), JSON.stringify(first));
  assert.ok(first.every((change) => change.kind === 'setting' && change.agent), 'each one names its agent');
  const again = marked(initIn(sandbox));
  assert.ok(again.some((change) => change.agent === 'Claude Code' && change.state === 'kept'), JSON.stringify(again));
  assert.deepEqual(first.map((change) => change.agent), ['Claude Code', 'Codex', 'Grok CLI'], 'Gemini is no sandbox');
  const geminiChange = initIn(makeSandbox()).changes.find((change) => change.agent === 'Gemini CLI' && change.path === '.gemini/settings.json' && change.kind === 'setting' && /sandbox/.test(change.note ?? ''));
  assert.ok(geminiChange, 'the Gemini change is still there');
  assert.equal(geminiChange.isSandbox, undefined);
});
