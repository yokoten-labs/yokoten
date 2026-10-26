// The shape of the code, checked. A rule about structure that no test holds drifts.
import './home.ts';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { dirname, join, posix, relative } from 'node:path';
import { test } from 'node:test';
import { killedLine, makeSandbox, makeTempDir, runChild } from './helpers.ts';
import { fileURLToPath } from 'node:url';
import { COMMANDS } from '../../src/run/cli.ts';
import { findDeclarations, findNameProblems, splitWords, type Token, tokenize } from '../../src/run/notes/names.ts';
import { HOME_DIR, homeDirOf, VERSION } from '../../src/setup/files.ts';
import { noteWork } from '../../src/rules/text/message.ts';
import { assertLinear, assertLinearEach, assertWallSmoke } from '../../scripts/linear.ts';
import { judgeSuite, readReport, SUITE_BUDGET, verdictOf } from '../../scripts/time/suite.ts';
import { capOf, CRASHED, crashLines, entriesOf, type FileRun, isCrash, judgeKnown, knownFor, knownText, listLines, maskReason, platformOf, scopeFor, skippedLines, TEST_AREAS, readFailures, readKnown, readReasons, reasonCounts, fileLine, progressLine, slowLine, slowestFiles, reportLines, summaryTable, readTimes, runWithRetry, shardOf, staleKnown, testFiles, TIMED_OUT, weightsOf } from '../../scripts/time/windows-known.ts';
import { clearYokotenEnv, TEST_HOME } from './home.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(ROOT, 'src');

// Lowest first. A module may import from its own layer or a lower one, never a higher.
// platform: how paths and processes read on each system (record 0040). rules: what is
// allowed, as pure functions. run: the checks at work (hook, commit, CI).
// agents: one adapter per AI runtime, and llama.ts, the model API that adopt calls.
// host: one adapter per code host (the bot, a CI run's pull request). setup: writing
// yokoten into a machine or a project. commands: one module per command or small group,
// which bin/main.ts calls (#330).
const LAYERS = ['platform', 'rules', 'run', 'agents', 'host', 'setup', 'commands'];

test('layers: no module imports from a layer above its own', () => {
  const found = new Set<string>();
  for (const layer of readdirSync(SRC)) {
    assert.ok(LAYERS.includes(layer), `src/${layer}/ is not in LAYERS: add it, in order`);
    // A layer may have folders of its own (src/setup/advice/); their files belong to it.
    const files = readdirSync(join(SRC, layer), { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
    for (const entry of files) {
      const file = relative(join(SRC, layer), join(entry.parentPath, entry.name));
      const text = readFileSync(join(entry.parentPath, entry.name), 'utf8');
      for (const [, spec] of text.matchAll(/from '(\.[^']+)'/g)) {
        const target = relative(SRC, join(entry.parentPath, spec)).split(/[\\/]/)[0];
        found.add(`${layer}->${target}`);
        assert.ok(LAYERS.indexOf(target) <= LAYERS.indexOf(layer), `src/${layer}/${file} imports ${spec}, from the higher layer ${target}`);
      }
    }
  }
  assert.ok(found.size > 0, 'the import scan found nothing; the pattern is broken');
});

// One test file per src module, at the module's own path: src/run/check.ts is tested in
// test/run/check.test.ts (#152). A branch that changes a module adds its tests, and their
// imports, to that module's file, so parallel branches do not meet in one import block.
// Next to the layer folders, test/ holds repo/: this file and the shared helpers, which
// check the repo as a whole, not one src module, git-template.ts, which copies a test repo,
// invoke.ts, which runs a command in-process (#475), and merge-utc.test.ts, which reads
// the merge skill and record. docs.test.ts checks that prose agrees with the code: the
// manifesto count against the guide (#487), and the open standard against the shapes (#755).
// screens.test.ts checks the text every screen prints against record 0049, calibrated on the
// owner's verdicts in captured-screens.ts (#1099). The real-home preload is a temp script home.ts writes, not a file here, so this folder stays at 7 (#739).
const TEST_TOP = ['repo/architecture.test.ts', 'repo/git-template.ts', 'repo/helpers.ts', 'repo/home.ts', 'repo/invoke.ts', 'repo/merge-utc.test.ts', 'repo/docs/docs.test.ts', 'repo/docs/readme-tables.test.ts', 'repo/docs/screens.test.ts', 'repo/docs/captured-screens.ts'];
// Kit prose has no src module. This test reads the skill files (#531).
const PROSE_TESTS = ['setup/kit-habits.test.ts'];
// Modules with no test file of their own. Keep it short: a new module gets its test file.
const NO_TEST_FILE = [
  'agents/agent-skills.ts', // no tests yet (#152)
  'host/github/index.ts', // re-exports the GitHub adapter's public names
  'commands/more/merge/conflicts/types.ts', // shapes and constants only; every conflicts test uses them (#914)
  'commands/kanban/page/browser/types.ts', // the kanban page's API types only, no code: tsc checks them where the core and the page use them (#1054)
  'setup/files.ts', // no tests yet (#152); the install tests and this file use it
  'platform/paths.ts', // test/ holds 7 entries, the cap; its tests are in test/rules/guards/commands/no-wipe.test.ts, its first user (#1015)
  'platform/folder-keys.ts', // the same cap; its case tables are in test/agents/runtimes/codex.test.ts, its first user
  'platform/process.ts', // the same cap; its case tables are in test/agents/desk/fence/srt.test.ts and desk.test.ts, its first users, and test/commands/kanban/ (readProgram, startAndLetGo)
  'rules/text/screen.ts', // its tests are in test/repo/docs/screens.test.ts, with the screen test of record 0049 (#1099)
];

const filesUnder = (folder: string) =>
  readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(folder, join(entry.parentPath, entry.name)).split(/[\\/]/).join('/'));

// What is wrong with test/, given the src modules and the test files, each by its path
// inside its folder.
function testFileProblems(modules: string[], tests: string[]): string[] {
  const problems: string[] = [];
  for (const path of tests) {
    if (TEST_TOP.includes(path) || PROSE_TESTS.includes(path)) continue;
    const module = path.replace(/\.test\.ts$/, '.ts');
    if (module === path || !modules.includes(module)) problems.push(`test/${path} is not the test file of a src module (src/${module})`);
  }
  for (const module of modules) {
    const hasFile = tests.includes(module.replace(/\.ts$/, '.test.ts'));
    if (!hasFile && !NO_TEST_FILE.includes(module)) problems.push(`src/${module} has no test/${module.replace(/\.ts$/, '.test.ts')}`);
    if (hasFile && NO_TEST_FILE.includes(module)) problems.push(`src/${module} has a test file now: take it off NO_TEST_FILE`);
  }
  for (const module of NO_TEST_FILE) if (!modules.includes(module)) problems.push(`NO_TEST_FILE names src/${module}, which is not there`);
  return problems;
}

test('test files: each one is the test file of a src module, at the same path (#152)', () => {
  const modules = ['run/check.ts', 'setup/advice/adopt.ts', ...NO_TEST_FILE];
  assert.deepEqual(testFileProblems(modules, ['repo/architecture.test.ts', 'repo/helpers.ts', 'run/check.test.ts', 'setup/advice/adopt.test.ts', 'setup/kit-habits.test.ts']), []);
  assert.deepEqual(testFileProblems(modules, ['run/check.test.ts', 'setup/advice/adopt.test.ts', 'run/gone.test.ts', 'run/check/pr.test.ts', 'run/util.ts', 'top.test.ts']), [
    'test/run/gone.test.ts is not the test file of a src module (src/run/gone.ts)',
    'test/run/check/pr.test.ts is not the test file of a src module (src/run/check/pr.ts)',
    'test/run/util.ts is not the test file of a src module (src/run/util.ts)',
    'test/top.test.ts is not the test file of a src module (src/top.ts)',
  ]);
  const tests = filesUnder(join(ROOT, 'test'));
  assert.ok(tests.includes('run/check.test.ts'), 'test/run/check.test.ts not found; the scan is broken');
  assert.deepEqual(
    testFileProblems(filesUnder(SRC), tests).filter((problem) => problem.startsWith('test/')),
    [],
    'name each test file after its src module, or put shared code in test/repo/helpers.ts',
  );
});

test('test files: every src module has one, but the few on NO_TEST_FILE (#152)', () => {
  assert.deepEqual(testFileProblems(['run/check.ts', 'run/new.ts', ...NO_TEST_FILE], ['run/check.test.ts', 'setup/files.test.ts']), [
    'src/run/new.ts has no test/run/new.test.ts',
    'src/setup/files.ts has a test file now: take it off NO_TEST_FILE',
  ]);
  assert.deepEqual(testFileProblems(['run/check.ts'], ['run/check.test.ts']), NO_TEST_FILE.map((module) => `NO_TEST_FILE names src/${module}, which is not there`));
  assert.deepEqual(
    testFileProblems(filesUnder(SRC), filesUnder(join(ROOT, 'test'))).filter((problem) => !problem.startsWith('test/')),
    [],
    'a new src module gets its test file next to the others',
  );
});

// src/commands/ holds the three commands up front, the hidden ones in more/, and the two
// files the guard's hot path loads (issue #1054, architecture §5). Anything else is a new
// top-level command: it goes into one of the folders.
const COMMANDS_TOP = ['desk', 'hook.ts', 'kanban', 'more', 'shared.ts', 'tidy'];
const commandsTopProblems = (entries: string[]): string[] => [
  ...entries.filter((entry) => !COMMANDS_TOP.includes(entry)).map((entry) => `src/commands/${entry}: put it in desk/, kanban/, tidy/ or more/`),
  ...COMMANDS_TOP.filter((entry) => !entries.includes(entry)).map((entry) => `src/commands/${entry} is missing`),
];

test('commands: src/commands/ holds only desk/, kanban/, tidy/, more/, hook.ts and shared.ts (#1054)', () => {
  // The positive control: a new file at the top and a lost folder are both caught.
  assert.deepEqual(commandsTopProblems(['desk', 'hook.ts', 'kanban', 'more', 'shared.ts', 'check.ts']), ['src/commands/check.ts: put it in desk/, kanban/, tidy/ or more/', 'src/commands/tidy is missing']);
  assert.deepEqual(commandsTopProblems(readdirSync(join(SRC, 'commands')).sort()), []);
  assert.deepEqual(readdirSync(join(ROOT, 'test', 'commands')).sort(), ['desk', 'hook.test.ts', 'kanban', 'more', 'shared.test.ts', 'tidy'], 'test/commands/ moves the same way');
});

// A step names what it needs in host-neutral words; only src/host/ talks to a host's API
// (record 0004). Then adding a host (Gitea) means one new adapter, not a change in each step.
const HOST_API = /api\.github\.com|\bgh api\b|GITHUB_EVENT_PATH/;
const namesHostApi = (files: Record<string, string>) => Object.keys(files).filter((p) => !p.startsWith('src/host/') && HOST_API.test(files[p]));

test('host: nothing outside src/host/ names a GitHub API (#33)', () => {
  assert.deepEqual(namesHostApi({ 'src/setup/a.ts': 'run gh api repos/x', 'src/rules/b.ts': 'env.GITHUB_EVENT_PATH', 'bin/c.ts': 'https://api.github.com', 'src/host/github/index.ts': 'https://api.github.com', 'src/run/d.ts': 'gh pr view' }), ['src/setup/a.ts', 'src/rules/b.ts', 'bin/c.ts']);
  const files: Record<string, string> = {};
  for (const path of execFileSync('git', ['ls-files', 'bin', 'src'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)) files[path] = readFileSync(join(ROOT, path), 'utf8');
  assert.ok(Object.keys(files).some((p) => p.startsWith('src/host/') && HOST_API.test(files[p])), 'src/host/ names no API; the scan is broken');
  assert.deepEqual(namesHostApi(files), [], 'move the host call into an adapter in src/host/');
});

test('AGENTS.md: the core rules here are the kit\'s, word for word', () => {
  const core = (path: string) => readFileSync(join(ROOT, path), 'utf8').split('\n## This project')[0];
  assert.equal(core('AGENTS.md'), core('kit/project/AGENTS.md'), 'change kit/project/AGENTS.md and copy it here, or the other way round');
});

// This repo files issues from the kit's own templates (#169). A copy here that drifts
// from the kit means `learn` reads one set of fields here and another in every project.
// A `{{...}}` in the kit's file stands for any text in the copy.
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, (mark) => `\\${mark}`);
const matchesKit = (copy: string, kit: string) => new RegExp(`^${kit.split(/\{\{[^}]*\}\}/).map(escape).join('.+?')}$`, 's').test(copy);

test('issue templates: each one here is the kit\'s, word for word; a changed copy is caught (#169)', () => {
  const kitDir = join(ROOT, 'kit/project/.github/ISSUE_TEMPLATE');
  const hereDir = join(ROOT, '.github/ISSUE_TEMPLATE');
  const kitFiles = readdirSync(kitDir);
  const shared = readdirSync(hereDir).filter((file) => kitFiles.includes(file));
  assert.ok(shared.includes('incident.yml'), 'the incident template is in both places');
  for (const file of shared) {
    const kit = readFileSync(join(kitDir, file), 'utf8');
    assert.ok(matchesKit(readFileSync(join(hereDir, file), 'utf8'), kit), `.github/ISSUE_TEMPLATE/${file}: copy kit/project/.github/ISSUE_TEMPLATE/${file} here, or the other way round`);
    // Positive control: a copy with a word changed, or a line left out, is caught.
    assert.ok(matchesKit(kit, kit));
    assert.ok(!matchesKit(kit.replace(/label: \S+/, 'label: Changed'), kit), `${file}: a changed label must be caught`);
    assert.ok(!matchesKit(kit.split('\n').slice(1).join('\n'), kit), `${file}: a missing line must be caught`);
  }
  // A placeholder in the kit matches any text there, and nowhere else.
  assert.ok(matchesKit('name: Acme (a.b)\n', 'name: {{project}}\n'));
  assert.ok(!matchesKit('title: Acme\n', 'name: {{project}}\n'));
});

// A tag can be moved to other code; a commit can't. Every action is pinned to a full
// commit, with the version it is in a comment for people and Dependabot. A local
// action (`./path`) is code in the repo and needs no pin.
const PINNED = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d/;
const unpinned = (text: string) =>
  [...text.matchAll(/^\s*(?:-\s+)?uses:\s*(.+?)\s*$/gm)].map((m) => m[1]).filter((ref) => !ref.startsWith('./') && !PINNED.test(ref));

test('workflows: every action is pinned to a commit, the version in a comment', () => {
  assert.deepEqual(unpinned('      - uses: actions/checkout@v4\n        uses: a/b@main\n      - uses: ./local\n'), ['actions/checkout@v4', 'a/b@main']);
  assert.deepEqual(unpinned(`      - uses: a/b@${'0'.repeat(40)}\n`), [`a/b@${'0'.repeat(40)}`], 'a pin with no version comment');
  let seen = 0;
  for (const dir of ['.github/workflows', 'kit/project/.github/workflows']) {
    for (const file of readdirSync(join(ROOT, dir)).filter((f) => /\.ya?ml$/.test(f))) {
      const text = readFileSync(join(ROOT, dir, file), 'utf8');
      seen += [...text.matchAll(/uses:/g)].length;
      assert.deepEqual(unpinned(text), [], `${dir}/${file}: pin each action to a commit, as \`owner/repo@<40 hex> # vX.Y.Z\``);
    }
  }
  // The action other repos run (#106) pins what it uses the same way.
  const action = readFileSync(join(ROOT, 'action.yml'), 'utf8');
  assert.ok(/uses:/.test(action), 'action.yml: no `uses:` found; the scan is broken');
  assert.deepEqual(unpinned(action), [], 'action.yml: pin each action to a commit, as `owner/repo@<40 hex> # vX.Y.Z`');
  assert.ok(seen > 0, 'no `uses:` found; the scan is broken');
});

// The action handles the events people run it on (#269): `check --issue` on issues, and
// on pull_request_target a notice instead of `check --pr` on the wrong commits.
const actionStep = (text: string, name: string) => text.split(/\n(?=    - )/).find((step) => step.includes(`- name: ${name}\n`)) ?? '';

test('action.yml: check --issue on issues; a notice, not check --pr, on pull_request_target (#269)', () => {
  const action = readFileSync(join(ROOT, 'action.yml'), 'utf8');
  assert.match(action, /\n  issue-check:\n(?:    .*\n)*?    default: 'true'\n/, 'action.yml: no `issue-check` input defaulting to true');
  const issue = actionStep(action, 'yokoten check --issue');
  assert.match(issue, /if: \$\{\{ !cancelled\(\) && inputs\.issue-check == 'true' && github\.event_name == 'issues' \}\}/, 'action.yml: the `check --issue` step runs on issues when issue-check is true');
  assert.match(issue, /run: node "\$GITHUB_ACTION_PATH\/bin\/yokoten\.ts" check --issue\n/);
  const pr = actionStep(action, 'yokoten check --pr');
  assert.match(pr, /github\.event_name == 'pull_request' \}\}/, 'action.yml: `check --pr` runs on pull_request only');
  const target = action.split(/\n(?=    - )/).find((step) => step.includes("github.event_name == 'pull_request_target'")) ?? '';
  assert.match(target, /run: \|\n +echo "::notice::[^"\n]*runs on pull_request, not pull_request_target[^"\n]*"\n/, 'action.yml: on pull_request_target, a notice says the check runs on pull_request');
  assert.ok(!target.includes('check --pr"') && !/yokoten\.ts" check/.test(target), 'action.yml: the pull_request_target step must not run yokoten');
});

// Node runs .ts as it is, so no other code file is needed; one appearing means someone
// reached for a build-era habit (AGENTS.md, "This project").
// Two exceptions, both plain JavaScript the hooks start directly. bin/yokoten.mjs is the
// entry the agent hooks run: a .ts entry makes Node load its type stripper before the
// compile cache is on, on every hook call (record 0013). bin/launch.mjs is the Claude
// Code plugin hook (#706): the hook command stays one short line, and the resolver
// lives in that file, so a refusal does not print a long program.
const ENTRY = 'bin/yokoten.mjs';
const LAUNCH = 'bin/launch.mjs';
const strayCode = (paths: string[]) => paths.filter((p) => p !== ENTRY && p !== LAUNCH && /^(bin|src|test)\//.test(p) && /\.(js|mjs|cjs|jsx|tsx|mts|cts)$/.test(p));

test('code is .ts only: no .js, .mjs, .cjs or .tsx under bin, src or test (#43)', () => {
  assert.deepEqual(strayCode(['src/a.ts', 'src/b.mjs', 'test/c.tsx', 'bin/d.js', 'bin/main.mjs', 'kit/e.js', 'docs/f.md', ENTRY, LAUNCH]), ['src/b.mjs', 'test/c.tsx', 'bin/d.js', 'bin/main.mjs']);
  const files = execFileSync('git', ['ls-files', 'bin', 'src', 'test'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  assert.ok(files.some((f) => f.endsWith('.ts')), 'no .ts found; the scan is broken');
  assert.deepEqual(strayCode(files), [], 'write it as .ts: Node runs it with no build');
});

// #400: a test made its folder with a bare mkdtempSync and never removed it; one machine
// held 4,000 of them. makeTempDir (test/repo/helpers.ts) removes each one when its test
// ends. A line that starts with a quote is text a test writes out, not code that runs here.
// The [d] keeps this pattern from matching its own line. test/repo/home.ts makes the test
// home folder before any test runs and removes it when the process exits (#356).
const TEMP_HELPER = 'test/repo/helpers.ts';
const TEMP_MAKERS = new Set([TEMP_HELPER, 'test/repo/home.ts']);
const findBareTempDirs = (files: Record<string, string>) =>
  Object.entries(files).flatMap(([path, text]) =>
    TEMP_MAKERS.has(path)
      ? []
      : text.split('\n').flatMap((line, index) => (!/^\s*["'`]/.test(line) && /\bmk[d]temp(Sync)?\s*\(/.test(line) ? [`${path}:${index + 1}`] : [])));

test('temp folders: tests make them with makeTempDir, not with mkdtempSync alone (#400)', () => {
  assert.deepEqual(findBareTempDirs({
    'test/a.test.ts': "const dir = mkdtempSync(join(tmpdir(), 'x-'));\nconst ok = makeTempDir('x-');\n",
    'test/b.test.ts': "  \"const root = mkdtempSync(join(tmpdir(), 'lesson-'));\",\nawait mkdtemp(prefix);\n",
    [TEMP_HELPER]:
      "const parent = mkdtempSync(join(tmpdir(), 'yokoten-test-'));\n",
  }), ['test/a.test.ts:1', 'test/b.test.ts:2']);
  const paths = execFileSync('git', ['ls-files', 'test'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter((p) => p.endsWith('.ts'));
  assert.ok(paths.includes(TEMP_HELPER), 'the helper is not found; the scan is broken');
  const files = Object.fromEntries(paths.map((p) => [p, readFileSync(join(ROOT, p), 'utf8')]));
  assert.deepEqual(findBareTempDirs(files), [], `make the folder with makeTempDir from ${TEMP_HELPER}: it is removed when the test ends`);
});

// #475: each sandbox repo is a copy of one template. A copy that shared objects or a path
// with the template would let one test's commit show up in the next test's repo.
test('sandbox repos: each is its own copy, on main with the test user, and holds no path to the template (#475)', () => {
  const first = makeSandbox();
  const second = makeSandbox();
  assert.equal(first.git('symbolic-ref', 'HEAD').stdout, 'refs/heads/main\n');
  assert.equal(first.git('config', 'user.name').stdout, 'Test\n');
  first.write('a.md', 'a\n');
  first.git('add', '.');
  assert.equal(first.git('commit', '-qm', 'a').status, 0);
  assert.equal(second.git('rev-parse', '-q', '--verify', 'HEAD').status, 1, 'the commit stays in its own copy');
  assert.equal(makeSandbox().git('rev-parse', '-q', '--verify', 'HEAD').status, 1, 'and is not in the template');
  for (const sandbox of [first, second]) {
    const files = readdirSync(join(sandbox.repo, '.git'), { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
    const named = files.filter((entry) => readFileSync(join(entry.parentPath, entry.name), 'utf8').includes(tmpdir()));
    assert.deepEqual(named, [], 'no file in .git names a temp folder');
  }
});

// #436: a child killed by its timeout showed only `actual: null`, and a file that died later
// named no test. runChild prints the kill with the running test's name.
test('child processes: a killed child names the test that ran it (#436)', () => {
  const written: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((text: string | Uint8Array) => written.push(String(text)) > 0) as typeof process.stderr.write;
  let result;
  try {
    result = runChild('node', ['-e', 'setTimeout(() => {}, 60_000)'], { timeout: 100 });
  } finally {
    process.stderr.write = write;
  }
  assert.equal(result.signal, 'SIGTERM');
  assert.deepEqual(written, ['test "child processes: a killed child names the test that ran it (#436)": its child `node` was killed after 100 ms\n']);
  assert.equal(killedLine('a', 'git', 5, { signal: 'SIGKILL' }), 'test "a": its child `git` was killed by SIGKILL\n');
  assert.equal(killedLine('a', 'git', 5, { signal: null }), null, 'a child that ended by itself');
  const tooMuch = Object.assign(new Error('spawnSync git ENOBUFS'), { code: 'ENOBUFS' });
  assert.equal(killedLine('a', 'git', 5, { signal: 'SIGTERM', error: tooMuch }), 'test "a": its child `git` was killed for printing more than maxBuffer\n');
  assert.equal(runChild('node', ['-e', "process.stdout.write('x'.repeat(2 ** 21))"]).stdout.length, 2 ** 21, 'more than Node\'s 1 MB default');
  assert.equal(runChild('node', ['-e', '']).status, 0);
});

// #813: runChild spread the caller's options into spawnSync, so `shell: true` let a test value
// (a temp path, a file name) become shell code. A caller that asks for a shell gets none.
test('child processes: runChild never starts a shell (#813)', () => {
  // The type names every field, so TypeScript callers cannot ask. Plain JavaScript, or this cast,
  // still can: the helper must ignore it at runtime, not only refuse it at compile time.
  const asksForShell = { shell: true } as unknown as Parameters<typeof runChild>[2];
  const result = runChild('/bin/echo', ['a; echo shell ran'], asksForShell);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'a; echo shell ran\n', 'an argument stays a value, even when a caller asks for a shell');
});

// #436: one gh call in 100 left a telemetry sender running, which wrote its device id into
// the sandbox's home after the test removed it, so removing the sandbox failed. Git's
// background maintenance can race a test the same way (#442).
test('child processes: no gh telemetry or git maintenance runs on after a test (#436)', () => {
  assert.equal((makeSandbox().env as Record<string, string>).GH_TELEMETRY, '0');
  assert.equal(process.env.GH_TELEMETRY, '0');
  assert.equal(execFileSync('git', ['config', 'maintenance.auto'], { encoding: 'utf8' }).trim(), 'false', 'no background git maintenance either');
});

// ---- The npm package (#31) ----
//
// The hooks run on a fresh machine with nothing but Node, and `npx yokoten` installs one
// package, never a tree. So there are no runtime dependencies; dev ones are for tsc only.
const DEPENDENCY_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies'];
const runtimeDependencies = (pkg: Record<string, unknown>): string[] =>
  DEPENDENCY_FIELDS.flatMap((field) => {
    const value = pkg[field];
    if (Array.isArray(value)) return value.map((name) => `${field}: ${name}`);
    if (value && typeof value === 'object') return Object.keys(value).map((name) => `${field}: ${name}`);
    return value ? [`${field}: ${String(value)}`] : [];
  });

test('package: zero runtime dependencies (#31)', () => {
  assert.deepEqual(runtimeDependencies({ dependencies: { chalk: '^5' }, peerDependencies: {}, bundleDependencies: ['a'], devDependencies: { typescript: '^7' } }), ['dependencies: chalk', 'bundleDependencies: a']);
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.devDependencies?.typescript, 'no typescript in devDependencies; the read is broken');
  assert.deepEqual(runtimeDependencies(pkg), [], 'yokoten uses Node\'s standard library only (AGENTS.md, "This project")');
});

// Node does not strip types under node_modules, so the package runs the built .js in dist/.
// dist/ is made at pack time and never committed; the repo runs the .ts files.
test('package: the bin is the build, made at pack time and git-ignored (#31)', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.bin.yokoten, 'dist/bin/yokoten.js');
  for (const part of ['bin', 'src', 'kit', 'dist']) assert.ok(pkg.files.includes(part), `package.json files has no ${part}`);
  assert.match(pkg.scripts.prepack, /scripts\/build\.ts/);
  assert.equal(execFileSync('git', ['check-ignore', 'dist/bin/yokoten.js'], { cwd: ROOT, encoding: 'utf8' }).trim(), 'dist/bin/yokoten.js');
});

test('package: the runtime finds its home from the .ts and from the built .js (#31)', () => {
  assert.equal(homeDirOf(join('/pkg', 'src', 'setup', 'files.ts')), join('/pkg'));
  assert.equal(homeDirOf(join('/pkg', 'dist', 'src', 'setup', 'files.js')), join('/pkg'));
  assert.equal(HOME_DIR, ROOT);
});

// The ruleset on main names one check, `ci`. So `ci` must wait for every other job in
// its workflow, and run even when one of them failed. Then a red job turns `ci` red (#36).
// The jobs are read from the text: a job is a key two spaces in under `jobs:`.
const jobs = (text: string) => {
  const body = text.split(/^jobs:\n/m)[1] ?? '';
  return body.split(/^ {2}(?=[\w-]+:\n)/m).slice(1).map((block) => ({
    name: block.slice(0, block.indexOf(':')),
    block,
  }));
};
const ciProblems = (text: string) => {
  const all = jobs(text);
  const ci = all.find((j) => j.name === 'ci');
  if (!ci) return ['no `ci` job'];
  const problems: string[] = [];
  if (!/^ {4}if: always\(\)$/m.test(ci.block)) problems.push('`ci` has no `if: always()`');
  const needs = (ci.block.match(/^ {4}needs: \[(.*)\]$/m)?.[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const j of all) if (j.name !== 'ci' && !needs.includes(j.name)) problems.push(`\`ci\` does not need \`${j.name}\``);
  for (const j of all) if (!/^ {4}timeout-minutes: \d+$/m.test(j.block)) problems.push(`\`${j.name}\` has no time limit`);
  if (!/^permissions: \{\}$/m.test(text)) problems.push('the workflow does not start from no permissions');
  return problems;
};

test('workflows: the one required check, `ci`, waits for every job (#36)', () => {
  const good = 'permissions: {}\njobs:\n  a:\n    timeout-minutes: 10\n  ci:\n    if: always()\n    needs: [a]\n    timeout-minutes: 10\n';
  assert.deepEqual(ciProblems(good), []);
  assert.deepEqual(ciProblems(good.replace('jobs:\n', 'jobs:\n  b:\n    timeout-minutes: 5\n')), ['`ci` does not need `b`']);
  assert.deepEqual(ciProblems(good.replace('    if: always()\n', '')), ['`ci` has no `if: always()`']);
  for (const dir of ['.github/workflows', 'kit/project/.github/workflows']) {
    const text = readFileSync(join(ROOT, dir, 'yokoten.yml'), 'utf8');
    assert.ok(jobs(text).length > 1, `${dir}/yokoten.yml: no jobs found; the scan is broken`);
    assert.deepEqual(ciProblems(text), [], `${dir}/yokoten.yml`);
  }
});

test('workflows: checkout keeps no token (#36)', () => {
  for (const dir of ['.github/workflows', 'kit/project/.github/workflows']) {
    for (const file of readdirSync(join(ROOT, dir)).filter((f) => /\.ya?ml$/.test(f))) {
      const text = readFileSync(join(ROOT, dir, file), 'utf8');
      const checkouts = [...text.matchAll(/uses: actions\/checkout@.*\n((?: {8,}.*\n)*)/g)];
      for (const c of checkouts) assert.match(c[1], /persist-credentials: false/, `${dir}/${file}: add \`persist-credentials: false\` to checkout`);
    }
  }
});

// What a project gets from `init` meets the standard this repo keeps (#36), in every
// workflow file, not only yokoten.yml: pinned actions, a time limit on each job, no
// token kept by checkout, and a `ci` job (where there is one) that needs every job.
const workflowProblems = (text: string) => {
  const problems = unpinned(text).map((ref) => `\`${ref}\` is not pinned to a commit with a version comment`);
  const all = jobs(text);
  if (all.length === 0) problems.push('no jobs found');
  for (const j of all) if (!/^ {4}timeout-minutes: \d+$/m.test(j.block)) problems.push(`\`${j.name}\` has no time limit`);
  for (const c of text.matchAll(/uses: actions\/checkout@.*\n((?: {8,}.*\n)*)/g)) {
    if (!/persist-credentials: false/.test(c[1])) problems.push('a checkout keeps its token');
  }
  if (all.some((j) => j.name === 'ci')) problems.push(...ciProblems(text).filter((p) => p.startsWith('`ci`')));
  return problems;
};

test('workflows: every workflow, in the kit and here, meets the standard; a bad one is caught (#36)', () => {
  const checkout = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1';
  const good = `permissions: {}\njobs:\n  a:\n    timeout-minutes: 10\n    steps:\n      - uses: ${checkout}\n        with:\n          persist-credentials: false\n  ci:\n    if: always()\n    needs: [a]\n    timeout-minutes: 10\n`;
  assert.deepEqual(workflowProblems(good), []);
  const bad = 'permissions: {}\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n  b:\n    timeout-minutes: 5\n  ci:\n    if: always()\n    needs: [a]\n    timeout-minutes: 10\n';
  assert.deepEqual(workflowProblems(bad), [
    '`actions/checkout@v4` is not pinned to a commit with a version comment',
    '`a` has no time limit',
    'a checkout keeps its token',
    '`ci` does not need `b`',
  ]);
  // This repo's own workflows too, so the two never drift apart.
  for (const folder of ['.github/workflows', 'kit/project/.github/workflows']) {
    const files = readdirSync(join(ROOT, folder)).filter((f) => /\.ya?ml$/.test(f));
    assert.ok(files.includes('yokoten.yml'), `${folder}: no yokoten.yml; the scan is broken`);
    for (const file of files) assert.deepEqual(workflowProblems(readFileSync(join(ROOT, folder, file), 'utf8')), [], `${folder}/${file}`);
  }
  const dir = 'kit/project/.github/workflows';
  // The workflows lint themselves, and Dependabot keeps the pinned actions current.
  const kitWorkflow = readFileSync(join(ROOT, dir, 'yokoten.yml'), 'utf8');
  assert.ok(jobs(kitWorkflow).some((j) => j.name === 'lint' && /actionlint/.test(j.block)), `${dir}/yokoten.yml: no \`lint\` job that runs actionlint`);
  const dependabot = readFileSync(join(ROOT, 'kit/project/.github/dependabot.yml'), 'utf8');
  assert.match(dependabot, /package-ecosystem: github-actions/, 'kit/project/.github/dependabot.yml: Dependabot must keep the actions bumped');
});

// ---- A short CI for a docs-only pull request (#438) ----
//
// The `changes` job's script runs here as CI runs it, in a real git repo. The `if:` and
// matrix expressions are read from the file and evaluated in JS: `&&`, `||`, `==`, `!=`
// and quoted strings mean the same in both, and `github` carries the event name. An
// unknown name throws, so the read can't pass by accident.
const WORKFLOWS = ['.github/workflows/yokoten.yml', 'kit/project/.github/workflows/yokoten.yml'];
const jobBlock = (text: string, name: string) => jobs(text).find((job) => job.name === name)?.block ?? '';
const changesScript = (text: string) => (jobBlock(text, 'changes').match(/^ {8}run: \|\n((?: {10}.*\n|\n)+)/m)?.[1] ?? '').replace(/^ {10}/gm, '');
type Needs = Record<string, { result: string; outputs?: Record<string, string> }>;
const evaluate = (expression: string, needs: Needs, github: { event_name: string; event?: object; workflow?: string; ref?: string; run_id?: number } = { event_name: '' }, matrix?: object): unknown => {
  const code = expression
    .replace(/contains\(needs\.\*\.result, '(\w+)'\)/g, "contains('$1')")
    .replace(/needs\.([\w-]+)\.outputs\.([\w-]+)/g, "(needs['$1'].outputs?.['$2'] ?? '')")
    .replace(/needs\.([\w-]+)\.result/g, "needs['$1'].result");
  const contains = (value: string) => Object.values(needs).some((job) => job.result === value);
  return new Function('needs', 'contains', 'fromJSON', 'cancelled', 'github', 'matrix', `return (${code});`)(needs, contains, JSON.parse, () => false, github, matrix);
};
const inBraces = (block: string, pattern: RegExp) => {
  const found = block.match(pattern)?.[1];
  assert.ok(found, `no match for ${pattern}; the read is broken`);
  return found;
};
const jobCondition = (block: string) => inBraces(block, /^ {4}if: \$\{\{ (.+) \}\}$/m);
const ciRule = (text: string) => inBraces(jobBlock(text, 'ci'), /^ {6}- if: >-\n((?: {10}.*\n)+)/m).replace(/\s*\n\s*/g, ' ').trim();
// The results `ci` sees: `changes` with its output, then each job's result.
const results = (docsOnly: string, jobResults: Record<string, string>): Needs => ({
  changes: { result: docsOnly === '' ? 'failure' : 'success', outputs: docsOnly === '' ? {} : { docs_only: docsOnly } },
  ...Object.fromEntries(Object.entries(jobResults).map(([name, result]) => [name, { result }])),
});

test('ci: `changes` finds a docs-only pull request; other files, a push, or an unread list run in full (#438)', { skip: process.platform === 'win32' && 'the script is bash' }, () => {
  const [ours, kit] = WORKFLOWS.map((path) => readFileSync(join(ROOT, path), 'utf8'));
  const script = changesScript(ours);
  assert.match(script, /docs_only=/, 'no `changes` script found; the read is broken');
  assert.equal(changesScript(kit), script, 'the kit and this repo run the same `changes` script');
  for (const text of [ours, kit]) {
    const block = jobBlock(text, 'changes');
    assert.match(block, /^ {4}permissions:\n {6}contents: read\n {4}outputs:/m, '`changes` reads the repo and nothing else');
    assert.match(block, /continue-on-error: true\n/, 'a failed checkout makes a full run, not a red `changes`');
  }
  const sandbox = makeSandbox();
  sandbox.write('README.md', '# demo\n');
  sandbox.write('src/a.ts', 'export {};\n');
  sandbox.git('add', '-A');
  sandbox.git('commit', '-qm', 'base');
  const base = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  // A pull request from `base` that changes these files; its head commit.
  const pullRequest = (paths: string[]) => {
    sandbox.git('checkout', '-qB', 'topic', base);
    for (const path of paths) sandbox.write(path, `${path} changed\n`);
    sandbox.git('add', '-A');
    sandbox.git('commit', '-qm', 'change');
    return sandbox.git('rev-parse', 'HEAD').stdout.trim();
  };
  const runChanges = (env: Record<string, string>) => {
    const output = join(sandbox.home, 'github-output');
    writeFileSync(output, '');
    const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-c', script], { cwd: sandbox.repo, env: { ...sandbox.env, GITHUB_OUTPUT: output, ...env }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return { output: readFileSync(output, 'utf8'), stdout: result.stdout };
  };
  const onPullRequest = (paths: string[]) => runChanges({ EVENT: 'pull_request', BASE_SHA: base, HEAD_SHA: pullRequest(paths) }).output;
  // Docs-only: the short run.
  assert.equal(onPullRequest(['docs/guide.md', 'changes/1-a.md', 'README.md', 'docs/i18n/README.md', 'CHANGELOG.md', 'src/CHANGELOG.md']), 'docs_only=true\n');
  // Any Markdown file counts, outside the rules, the kit and CI (#1051).
  assert.equal(onPullRequest(['CONTRIBUTING.md', 'src/notes.md', 'docs/records/0099-a.md']), 'docs_only=true\n');
  assert.equal(onPullRequest(['src/AGENTS.md']), 'docs_only=false\n', 'an AGENTS.md holds rules');
  assert.equal(onPullRequest(['.github/SECURITY.md']), 'docs_only=false\n');
  assert.equal(onPullRequest(['kit/user/skills/record/SKILL.md']), 'docs_only=false\n', 'kit/ is what other projects get');
  // One file that is not docs: the full run.
  assert.equal(onPullRequest(['docs/guide.md', 'src/a.ts']), 'docs_only=false\n');
  assert.equal(onPullRequest(['kit/project/README.md']), 'docs_only=false\n', 'kit/ is what other projects get');
  assert.equal(onPullRequest(['AGENTS.md']), 'docs_only=false\n');
  assert.equal(onPullRequest(['.github/workflows/yokoten.yml']), 'docs_only=false\n');
  assert.equal(onPullRequest(['package.json']), 'docs_only=false\n');
  // A push to main: the full run.
  assert.equal(runChanges({ EVENT: 'push', BASE_SHA: '', HEAD_SHA: '' }).output, 'docs_only=false\n');
  // A merge queue group reads its files from the group's base to its head, as a pull request does (#1068).
  const docsHead = pullRequest(['docs/guide.md']);
  assert.equal(runChanges({ EVENT: 'merge_group', BASE_SHA: base, HEAD_SHA: docsHead }).output, 'docs_only=true\n');
  assert.equal(runChanges({ EVENT: 'merge_group', BASE_SHA: base, HEAD_SHA: pullRequest(['src/a.ts']) }).output, 'docs_only=false\n');
  // A group whose files can't be read is a full run.
  assert.equal(runChanges({ EVENT: 'merge_group', BASE_SHA: '', HEAD_SHA: '' }).output, 'docs_only=false\n');
  // Any other event, such as the daily schedule, is a full run.
  assert.equal(runChanges({ EVENT: 'schedule', BASE_SHA: base, HEAD_SHA: docsHead }).output, 'docs_only=false\n');
  // The file list can't be read: the full run, and a warning says why.
  const head = pullRequest(['docs/guide.md']);
  for (const [baseSha, headSha] of [['0'.repeat(40), head], ['', head], [base, ''], [head, head]]) {
    const run = runChanges({ EVENT: 'pull_request', BASE_SHA: baseSha, HEAD_SHA: headSha });
    assert.equal(run.output, 'docs_only=false\n', `base ${baseSha || '(none)'}, head ${headSha || '(none)'}`);
    assert.match(run.stdout, /^::warning::The pull request's changed files could not be read, so every job runs\.$/m);
  }
});

test('ci: a docs-only pull request runs one test job, skips typecheck, action, lint and Windows, and `ci` is green (#438, #1051)', () => {
  const text = readFileSync(join(ROOT, WORKFLOWS[0]), 'utf8');
  const testJob = jobBlock(text, 'test');
  const matrix = (docsOnly: string, event: string) => {
    const github = { event_name: event };
    const needs = results(docsOnly, {});
    const nodes = evaluate(inBraces(testJob, /^ {8}node: \$\{\{ (.+) \}\}$/m), needs, github) as string[];
    const extra = evaluate(inBraces(testJob, /^ {8}include: \$\{\{ (.+) \}\}$/m), needs, github) as { os: string; node: string; shard: number; of: number }[];
    // Every setup runs each of its shards: three, or two macOS shards on a pull request,
    // so the shared runners stay free (#568).
    // A docs-only pull request runs one job, not three shards (#1051).
    const shards = evaluate(inBraces(testJob, /^ {8}shard: \$\{\{ (.+) \}\}$/m), needs, github) as number[];
    const ofAxis = evaluate(inBraces(testJob, /^ {8}of: \$\{\{ (.+) \}\}$/m), needs, github) as number[];
    assert.deepEqual([shards, ofAxis], docsOnly === 'true' ? [[1], [1]] : [[1, 2, 3], [3]]);
    for (const setup of new Set(extra.map((entry) => `${entry.os} ${entry.node}`))) {
      const runs = extra.filter((entry) => `${entry.os} ${entry.node}` === setup);
      assert.ok(runs.every((entry) => entry.of === runs[0].of), `${setup}: mixed shard counts`);
      assert.deepEqual(runs.map((entry) => entry.shard), shards.slice(0, runs[0].of), `${setup} runs every shard`);
    }
    // Each setup's suite-time budget, as the time step reads it from the matrix: `` is 180 s.
    const entries = [...nodes.flatMap((node) => shards.map((shard) => ({ os: 'ubuntu-latest', node, shard, of: ofAxis[0] }))), ...extra];
    const budgets = Object.fromEntries(entries.map((entry) => [`${entry.os} ${entry.node} ${entry.of === 1 ? 'whole' : 'shard'}`, evaluate(budgetExpression, needs, github, entry)]));
    return {
      setups: [...new Set([...nodes.map((node) => `ubuntu-latest ${node}`), ...extra.map((entry) => `${entry.os} ${entry.node}`)])],
      whole: extra.filter((entry) => entry.of === 1).map((entry) => `${entry.os} ${entry.node} ${entry.shard}/${entry.of}`),
      macos: extra.filter((entry) => entry.os === 'macos-latest').map((entry) => `${entry.shard}/${entry.of}`),
      budgets,
    };
  };
  const budgetExpression = inBraces(testJob, /^ {8}run: node scripts\/time\/suite\.ts \$\{\{ runner\.temp \}\}\/tests\.tap \$\{\{ (.+) \}\}$/m);
  // The shard numbers reach the shell through env, not inside the script (zizmor template-injection).
  assert.match(testJob, /--test-shard="\$SHARD\/\$OF"/, 'the run step uses the shard');
  assert.match(testJob, /SHARD: \$\{\{ matrix\.shard \}\}\n\s+OF: \$\{\{ matrix\.of \}\}/, 'the shard numbers come from the matrix');
  assert.match(text, /^  schedule:\n    - cron: '[^']+'$/m, 'the full matrix runs on a schedule (#568)');
  assert.match(jobBlock(text, 'ci'), /never started/, '`ci` names jobs that never got a runner (#568)');
  assert.deepEqual(matrix('true', 'pull_request').setups, ['ubuntu-latest ^24.22.1']);
  // Each test runs once before a merge (#1084). A pull request runs Linux on Node 22 and
  // macOS in two shards (#568); its merge queue group runs Linux on Node 24. A push to main
  // runs Linux on both Nodes and no macOS; the schedule runs the full matrix. A docs-only
  // run, the docs tests.
  const full = ['ubuntu-latest 22.23.4', 'ubuntu-latest ^24.22.1', 'macos-latest ^24.22.1'];
  const pullRequestSetups = ['ubuntu-latest 22.23.4', 'macos-latest ^24.22.1'];
  const pr = matrix('false', 'pull_request');
  assert.deepEqual(pr.setups, pullRequestSetups, 'a pull request runs no Linux Node 24 shards: the queue runs them');
  assert.deepEqual([pr.whole, pr.macos], [[], ['1/2', '2/2']], 'a pull request runs macOS in two shards, about four minutes (#568)');
  assert.deepEqual(matrix('', 'pull_request').setups, pullRequestSetups, '`changes` failed: the pull request\'s full run');
  const queue = matrix('false', 'merge_group');
  assert.deepEqual([queue.setups, queue.whole], [['ubuntu-latest ^24.22.1'], []], 'a queue group runs Linux Node 24 only, all shards');
  assert.deepEqual(matrix('true', 'merge_group').setups, ['ubuntu-latest ^24.22.1']);
  assert.deepEqual(matrix('', 'merge_group').setups, ['ubuntu-latest ^24.22.1'], '`changes` failed: one Node still, all shards');
  // No setup runs both before the merge: what the pull request runs, the queue does not.
  assert.deepEqual(pr.setups.filter((setup) => queue.setups.includes(setup)), []);
  const daily = matrix('false', 'schedule');
  assert.deepEqual([daily.setups, daily.macos], [full, ['1/3', '2/3', '3/3']], 'the schedule runs the full macOS matrix (#568)');
  // Every setup that runs keeps its own budget (#475): 90 s for Linux Node 24, the fastest; macOS fails on the daily run.
  assert.deepEqual(daily.budgets, { 'ubuntu-latest 22.23.4 shard': '', 'ubuntu-latest ^24.22.1 shard': '--budget 90', 'macos-latest ^24.22.1 shard': '' });
  const push = matrix('false', 'push');
  assert.deepEqual([push.setups, push.macos], [['ubuntu-latest 22.23.4', 'ubuntu-latest ^24.22.1'], []], 'a push to main runs no macOS: the pull request ran it, and a queued macOS job turned main red (2026-10-26)');
  assert.deepEqual(push.budgets, { 'ubuntu-latest 22.23.4 shard': '', 'ubuntu-latest ^24.22.1 shard': '--budget 90' });
  // A pull request's macOS shards only warn: the same tests took 454 s and 629 s there (PR #1112).
  assert.deepEqual(pr.budgets, { 'ubuntu-latest 22.23.4 shard': '', 'macos-latest ^24.22.1 shard': '--budget 240 --warn-only' });
  assert.deepEqual(queue.budgets, { 'ubuntu-latest ^24.22.1 shard': '--budget 90' });
  assert.equal(evaluate(jobCondition(testJob), results('true', {})), true, 'test runs on every pull request');
  for (const name of ['typecheck', 'action', 'windows', 'lint']) {
    const condition = jobCondition(jobBlock(text, name));
    assert.equal(evaluate(condition, results('true', {})), false, `${name} is skipped on a docs-only pull request`);
    assert.equal(evaluate(condition, results('false', {})), true, `${name} runs in full`);
    assert.equal(evaluate(condition, results('', {})), true, `${name} runs when \`changes\` failed`);
  }
  assert.doesNotMatch(jobBlock(text, 'check'), /^ {4}(?:if|needs):/m, 'check runs on every pull request: it holds the privacy rule');
  // A docs-only pull request runs only the tests that read the docs; the time budget is for the whole suite.
  assert.match(testJob, /- if: needs\.changes\.outputs\.docs_only == 'true'\n {8}run: node --test [^\n]*test\/repo\/docs\//);
  assert.match(testJob, /- if: needs\.changes\.outputs\.docs_only != 'true'\n {8}run: node --test --test-concurrency/);
  assert.match(testJob, /- if: needs\.changes\.outputs\.docs_only != 'true'\n {8}run: node scripts\/time\/suite\.ts/);
  // `ci` is red when this is true.
  const isRed = (docsOnly: string, jobResults: Record<string, string>) => evaluate(ciRule(text), results(docsOnly, jobResults));
  const green = { test: 'success', windows: 'success', typecheck: 'success', check: 'success', lint: 'success', action: 'success' };
  const docsRun = { ...green, windows: 'skipped', typecheck: 'skipped', action: 'skipped', lint: 'skipped' };
  assert.equal(isRed('true', docsRun), false, 'docs-only: typecheck and action skipped on purpose');
  assert.equal(isRed('false', green), false);
  assert.equal(isRed('false', docsRun), true, 'skipped on a full run is red');
  assert.equal(isRed('true', { ...docsRun, test: 'skipped' }), true, 'test always runs');
  assert.equal(isRed('false', { ...green, lint: 'skipped' }), true, 'lint runs in full');
  assert.equal(isRed('true', { ...docsRun, lint: 'failure' }), true);
  assert.equal(isRed('true', { ...docsRun, check: 'failure' }), true);
  assert.equal(isRed('true', { ...docsRun, test: 'cancelled' }), true);
  assert.equal(isRed('false', { ...green, windows: 'failure' }), true, 'a Windows failure is red (record 0040)');
  assert.equal(isRed('', green), true, '`changes` failed: red, though the rest ran in full');
});

// The per-event table (#1084): a merge queue group leaves out Windows, and `ci` counts
// that one skip as passed. Any other skip in a group is red: the jobs are read from
// `ci`'s needs, so a new job that the rule forgets fails here.
test('ci: a merge queue group skips Windows and nothing else; `ci` stays fail closed (#1084)', () => {
  const text = readFileSync(join(ROOT, WORKFLOWS[0]), 'utf8');
  const runs = (name: string, docsOnly: string, event: string) => evaluate(jobCondition(jobBlock(text, name)), results(docsOnly, {}), { event_name: event });
  for (const docsOnly of ['false', '']) {
    assert.equal(runs('windows', docsOnly, 'merge_group'), false, 'Windows is left out of a queue group');
    for (const event of ['pull_request', 'push', 'schedule']) assert.equal(runs('windows', docsOnly, event), true, `Windows runs on ${event}`);
    for (const name of ['test', 'typecheck', 'lint', 'action']) assert.equal(runs(name, docsOnly, 'merge_group'), true, `${name} runs in a queue group`);
  }
  assert.doesNotMatch(jobBlock(text, 'check'), /^ {4}if:/m, 'check runs on every event');
  const isRed = (docsOnly: string, jobResults: Record<string, string>, event: string) => evaluate(ciRule(text), results(docsOnly, jobResults), { event_name: event });
  const needs = inBraces(jobBlock(text, 'ci'), /^ {4}needs: \[(.*)\]$/m).split(',').map((name) => name.trim());
  assert.ok(needs.includes('windows') && needs.length > 5, 'the read of `ci` needs is broken');
  const green = Object.fromEntries(needs.filter((name) => name !== 'changes').map((name) => [name, 'success']));
  const queueRun = { ...green, windows: 'skipped' };
  assert.equal(isRed('false', queueRun, 'merge_group'), false, 'a queue group without Windows is green');
  assert.equal(isRed('false', green, 'merge_group'), false);
  assert.equal(isRed('false', green, 'pull_request'), false, 'a pull request with no Linux Node 24 shards is green');
  // Positive controls: a queue group that skips or fails a job it needs is red.
  for (const name of Object.keys(green).filter((job) => job !== 'windows')) {
    assert.equal(isRed('false', { ...queueRun, [name]: 'skipped' }, 'merge_group'), true, `a queue group that skips ${name} is red`);
    assert.equal(isRed('', { ...queueRun, [name]: 'skipped' }, 'merge_group'), true, `\`changes\` failed and ${name} skipped: red`);
    assert.equal(isRed('false', { ...queueRun, [name]: 'failure' }, 'merge_group'), true);
  }
  assert.equal(isRed('false', { ...green, windows: 'failure' }, 'merge_group'), true, 'a Windows run that fails is red, even in a group');
  assert.equal(isRed('false', { ...green, windows: 'cancelled' }, 'merge_group'), true);
  // The skip counts only in a queue group.
  for (const event of ['pull_request', 'push', 'schedule']) assert.equal(isRed('false', queueRun, event), true, `Windows skipped on ${event} is red`);
  // A docs-only group skips what a docs-only pull request skips.
  const docsRun = { ...green, windows: 'skipped', typecheck: 'skipped', action: 'skipped', lint: 'skipped' };
  assert.equal(isRed('true', docsRun, 'merge_group'), false);
  assert.equal(isRed('true', { ...docsRun, test: 'skipped' }, 'merge_group'), true);
  assert.equal(isRed('false', docsRun, 'merge_group'), true, 'a full group that skips typecheck, lint and action is red');
});

test('ci: the kit lets a project skip its own jobs on a docs-only pull request; check and lint always run (#438)', () => {
  const text = readFileSync(join(ROOT, WORKFLOWS[1]), 'utf8');
  // The lines the kit tells a project to give its own jobs.
  const example = inBraces(text, /^ {2}# {3}if: \$\{\{ (.+) \}\}$/m);
  assert.match(text, /^ {2}# {3}needs: changes$/m);
  assert.equal(evaluate(example, results('true', {})), false);
  assert.equal(evaluate(example, results('false', {})), true);
  assert.equal(evaluate(example, results('', {})), true, 'runs when `changes` failed');
  const isRed = (docsOnly: string, jobResults: Record<string, string>) => evaluate(ciRule(text), results(docsOnly, jobResults));
  const green = { check: 'success', lint: 'success', build: 'success' };
  assert.equal(isRed('false', green), false);
  assert.equal(isRed('true', { ...green, build: 'skipped' }), false, 'a project job skipped on a docs-only pull request');
  assert.equal(isRed('false', { ...green, build: 'skipped' }), true);
  assert.equal(isRed('true', { ...green, check: 'skipped' }), true, 'check always runs');
  assert.equal(isRed('true', { ...green, lint: 'skipped' }), true, 'lint always runs');
  assert.equal(isRed('true', { ...green, build: 'failure' }), true);
});

// ---- The same required checks on a merge queue group (#590) ----
//
// `yokoten.yml` reports `ci` and `pr.yml` reports `pr`: both checks are required, so
// both workflows run on `merge_group`, and a queued merge runs the same checks as a
// pull request. `issue.yml` is not a check on a merge, so it stays off. There is no
// pull request on a merge group run: `yokoten.yml` reads the group's files as a pull request's, and the `pr`
// job skips, which the queue counts as green. Read in both dirs: the kit files and
// this repo's own workflows carry the same trigger lines.
// The events in the top-level `on:` block: each key two spaces in.
const readTriggers = (text: string) => {
  const head = text.split(/^jobs:\n/m)[0];
  const on = head.split(/^on:\n/m)[1]?.split(/^(?:permissions|concurrency|env):/m)[0] ?? '';
  return on.split('\n').filter((line) => /^  [\w-]+:/.test(line)).map((line) => line.trim().replace(/:.*$/, ''));
};

test('workflows: the required checks run on merge_group, with the same jobs as a pull request (#590)', () => {
  assert.deepEqual(readTriggers('on:\n  pull_request:\n  push:\n    branches: [main]\njobs:\n'), ['pull_request', 'push'], 'the read finds the events');
  const kitYokoten = readFileSync(join(ROOT, 'kit/project/.github/workflows/yokoten.yml'), 'utf8');
  for (const dir of ['.github/workflows', 'kit/project/.github/workflows']) {
    const yokoten = readFileSync(join(ROOT, dir, 'yokoten.yml'), 'utf8');
    const pr = readFileSync(join(ROOT, dir, 'pr.yml'), 'utf8');
    for (const [name, text] of [['yokoten.yml', yokoten], ['pr.yml', pr]] as const) {
      assert.ok(readTriggers(text).includes('pull_request'), `${dir}/${name}: the read is broken`);
      assert.ok(readTriggers(text).includes('merge_group'), `${dir}/${name}: no merge_group trigger, so a queued merge would run no checks`);
    }
    assert.ok(!readTriggers(readFileSync(join(ROOT, dir, 'issue.yml'), 'utf8')).includes('merge_group'), `${dir}/issue.yml is not a check on a merge`);
    // The `pr` job skips on a merge group run, because there is no pull request to
    // check. It never skips a pull request, a draft included: a skip counts as a pass, and
    // a skipped run that GitHub ends last would hide a failure (#645).
    const prJob = jobBlock(pr, 'pr');
    assert.equal(evaluate(jobCondition(prJob), {}, { event_name: 'merge_group' }), false);
    assert.equal(evaluate(jobCondition(prJob), {}, { event_name: 'pull_request', event: { pull_request: { draft: true } } }), true);
    assert.equal(evaluate(jobCondition(prJob), {}, { event_name: 'pull_request', event: { pull_request: { draft: false } } }), true);
    // No run is cancelled: a cancelled run shows as a failure on the pull request page (#645).
    assert.doesNotMatch(pr, /cancel-in-progress/, `${dir}/pr.yml cancels runs`);
    assert.match(prJob, /check --pr/);
    assert.doesNotMatch(jobCondition(prJob), /draft/, `${dir}/pr.yml: the pr job skips on the draft state`);
    // The step reads the pull request as it is now, so runs may start in any order (#645):
    // it asks for that, it gets the job's token, and the job may read pull requests.
    assert.match(prJob, /check --pr\n {8}env:\n {10}YOKOTEN_PR_LIVE: '1'\n {10}GITHUB_TOKEN: \$\{\{ github\.token \}\}\n/, `${dir}/pr.yml: check --pr does not read the pull request as it is now`);
    assert.match(pr, /^permissions:\n(?: {2}.*\n)*? {2}pull-requests: read\n/m, `${dir}/pr.yml can't read pull requests`);
  }
  assert.ok(!readTriggers(kitYokoten.replace(/^  merge_group:\n/m, '')).includes('merge_group'), 'a missing trigger is caught');
  // Every job in the kit yokoten.yml runs on a merge group run, as on a pull request.
  // Only `ci` carries a condition, and it always runs. This repo's own file carries
  // docs-only conditions instead; the matrix test runs them for each event, merge_group too.
  for (const job of jobs(kitYokoten)) {
    const condition = job.block.match(/^ {4}if: (.+)$/m)?.[1] ?? '';
    assert.ok(condition === '' || (job.name === 'ci' && condition === 'always()'), `${job.name} runs only when "${condition}"`);
  }
});

// ---- A run on main is kept while it waits, and never cancelled (#660, #798) ----
//
// Cancelling an older run is right for a pull request: only its newest commit can
// merge. Every other event gets a group of its own. GitHub keeps one running and one
// waiting run per group and cancels the waiting one when a newer run arrives, so a
// shared group on main would cancel a run that never started. Each commit then stays in
// history, is tested on its own, and never leaves a ✗ on it.
const readCancel = (text: string) => inBraces(text, /^ {2}cancel-in-progress: (?:\$\{\{ )?(.+?)(?: \}\})?$/m);
// The group line as a template literal: each `${{ ... }}` is one `${...}`, so the literal
// text between two of them (the `-`) keeps its meaning in JavaScript.
const readGroup = (text: string) =>
  `\`${inBraces(text, /^ {2}group: (.+)$/m).replace(/\$\{\{ /g, '${').replace(/ \}\}/g, '}')}\``;

test('workflows: a run on main is never cancelled, waiting or running (#660, #798)', () => {
  const cancels = (text: string, event_name: string) => evaluate(readCancel(text), {}, { event_name }) === true;
  const groupFor = (text: string, github: { event_name: string; ref: string; run_id: number }) => String(evaluate(readGroup(text), {}, { workflow: 'yokoten', ...github }));
  for (const dir of ['.github/workflows', 'kit/project/.github/workflows']) {
    const text = readFileSync(join(ROOT, dir, 'yokoten.yml'), 'utf8');
    assert.equal(cancels(text, 'pull_request'), true, `${dir}/yokoten.yml: a new push to a pull request runs beside the old one`);
    assert.equal(cancels(text, 'push'), false, `${dir}/yokoten.yml: a push to main cancels the run before it`);
    assert.equal(cancels(text, 'merge_group'), false, `${dir}/yokoten.yml cancels a merge queue run`);
    // Two runs on one pull request share a group, so a new push cancels the older run;
    // two pull requests never share one.
    const pullRequest = { event_name: 'pull_request', ref: 'refs/pull/798/merge' };
    assert.equal(groupFor(text, { ...pullRequest, run_id: 1 }), groupFor(text, { ...pullRequest, run_id: 2 }), `${dir}/yokoten.yml: two runs on one pull request never share a group, so neither cancels the other`);
    assert.notEqual(groupFor(text, { ...pullRequest, run_id: 1 }), groupFor(text, { event_name: 'pull_request', ref: 'refs/pull/799/merge', run_id: 1 }), `${dir}/yokoten.yml: two pull requests share a group, so they cancel each other`);
    // Every other event gets a group per run: a newer run leaves both the running and the
    // waiting run alone, so every commit on main is tested (#798).
    for (const event_name of ['push', 'schedule', 'merge_group']) {
      const run = { event_name, ref: 'refs/heads/main' };
      assert.notEqual(groupFor(text, { ...run, run_id: 1 }), groupFor(text, { ...run, run_id: 2 }), `${dir}/yokoten.yml: two ${event_name} runs share a group, so the waiting one is cancelled`);
    }
  }
  // The positive control: the old group of the workflow and the ref shares one group for
  // two pushes, and this read says so.
  const old = readFileSync(join(ROOT, WORKFLOWS[0]), 'utf8').replace(/^ {2}group: .+$/m, '  group: ${{ github.workflow }}-${{ github.ref }}');
  const run = { event_name: 'push', ref: 'refs/heads/main' };
  assert.equal(groupFor(old, { ...run, run_id: 1 }), groupFor(old, { ...run, run_id: 2 }), 'the read misses the old group');
});

// ---- Names (#109, record 0006) ----
//
// The names we declare in src/, bin/ and test/ follow the rule in AGENTS.md. The reader lives
// in src/run/notes/names.ts, where `check --pr` uses it too. A test may still use a one-letter name
// inside a short block (10 lines or fewer).

test('names: words are counted from camelCase, PascalCase and CONSTANT_CASE (#109)', () => {
  assert.deepEqual(splitWords('loadHttpUrl'), ['load', 'Http', 'Url']);
  assert.deepEqual(splitWords('loadHTTPUrl'), ['load', 'HTTP', 'Url']);
  assert.deepEqual(splitWords('CODEOWNERS_PLACES'), ['CODEOWNERS', 'PLACES']);
  assert.deepEqual(splitWords('sha256Hex'), ['sha256', 'Hex']);
  assert.deepEqual(splitWords('_'), []);
});

test('names: the reader catches each kind of bad name (#109)', () => {
  const bad = [
    'export const x = 1;',
    'function load(_unused: string, value_: number, _: boolean) {',
    '  const MAX_TRIES = 3;',
    '  let i = 0;',
    ...Array(10).fill('  i++;'),
    '  return MAX_TRIES + i;',
    '}',
    'const processTheUserInputDataNow = () => 1;',
    'interface Shape { q: number; size: number }',
    'const [_, second] = pair;',
  ].join('\n');
  assert.deepEqual(findNameProblems(bad).map((problem) => `${problem.line}: ${problem.kind}: ${problem.what}`), [
    '1: one-letter: "x" is one letter, and exported',
    '2: underscore: "_unused" starts or ends with "_"',
    '2: underscore: "value_" starts or ends with "_"',
    '3: constant-case: "MAX_TRIES" is CONSTANT_CASE inside a function',
    '4: one-letter: "i" is used for 11 lines',
    '17: too-many-words: "processTheUserInputDataNow" has 6 words, over 4',
    '18: one-letter: "q" is one letter, and a property',
    '19: underscore: "_" names something that is not a parameter',
  ]);
  const fixes = findNameProblems(bad).map((problem) => problem.fix);
  assert.match(fixes[3], /"maxTries"/);
  assert.match(fixes[4], /"index"/);
});

test('names: strings, comments, templates and regular expressions are not read as code (#109)', () => {
  const good = [
    "const text = 'const _bad = 1; let VERY_LONG_NAME_IS_BAD';",
    'const shown = `${ { _key: 1 }._key } and ${`nested ${text}`} let _x`;',
    'const pattern = /const _x = [/]+/g; // const _comment',
    '/* let _block = 2; */',
    'const half = shown.length / 2 / 1;',
    'export function sum(list: number[]): number {',
    '  let total = 0;',
    '  for (const n of list) total += n;',
    '  return list.reduce((a, b) => a + b, total);',
    '}',
    'const ROOT_DIR = "x";',
    'const handler = { run(value: string) { return value; } };',
    'const ignore = (_: unknown, item: string) => item;',
  ].join('\n');
  assert.deepEqual(findNameProblems(good), []);
  const names = findDeclarations(tokenize(good)).map((declaration) => declaration.name);
  assert.deepEqual(names, ['text', 'shown', 'pattern', 'half', 'sum', 'list', 'total', 'n', 'a', 'b', 'ROOT_DIR', 'handler', 'run', 'value', 'ignore', '_', 'item']);
});

test('names: src/, bin/ and test/ use whole, short names (#109, #113)', () => {
  const found: string[] = [];
  const kinds = new Set<string>();
  let declared = 0;
  for (const path of execFileSync('git', ['ls-files', 'bin', 'src', 'test'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter((file) => file.endsWith('.ts'))) {
    const text = readFileSync(join(ROOT, path), 'utf8');
    const declarations = findDeclarations(tokenize(text));
    declared += declarations.length;
    for (const declaration of declarations) kinds.add(declaration.kind);
    for (const problem of findNameProblems(text)) found.push(`${path}:${problem.line}: ${problem.what}. ${problem.why}. ${problem.fix}.`);
  }
  assert.ok(declared > 500, `only ${declared} names found in src/, bin/ and test/; the reader is broken`);
  assert.deepEqual([...kinds].sort(), ['function', 'parameter', 'property', 'type', 'variable'], 'a kind of declaration was not found; the reader is broken');
  assert.deepEqual(found, [], 'rename each one; the rule and its reasons are in AGENTS.md ("Names") and docs/records/0006-names.md');
});

// The install commands have one machine-readable source, docs/facts.json, which the site
// reads (#150). The guides show the same commands, word for word; README shows npx.
type InstallStep = { cmd: string; note?: { en: string; zh: string } };
type Facts = { install: Record<string, InstallStep[]> };

/** The commands in `lists` of `facts` that `text` does not hold word for word. */
function missingCommands(facts: Facts, lists: string[], text: string): string[] {
  return lists.flatMap((list) => (facts.install[list] ?? []).map((step) => step.cmd)).filter((cmd) => !text.includes(cmd));
}

test('docs: every install command in docs/facts.json is in the guides and READMEs (#150)', () => {
  const fake: Facts = { install: { npx: [{ cmd: 'npx yokoten install' }, { cmd: 'npx yokoten uninstall' }] } };
  assert.deepEqual(missingCommands(fake, ['npx'], 'npx yokoten install\n'), ['npx yokoten uninstall']);

  const facts: Facts = JSON.parse(readFileSync(join(ROOT, 'docs/facts.json'), 'utf8'));
  assert.ok(facts.install.clone?.length && facts.install.npx?.length, 'docs/facts.json has no install.clone or install.npx; the site reads install.clone');
  for (const step of Object.values(facts.install).flat()) {
    if (step.note) assert.ok(step.note.en && step.note.zh, `"${step.cmd}": a note needs en and zh`);
  }
  const shown: [string, string[]][] = [
    ['docs/guide.md', ['npx', 'clone']],
    ['docs/i18n/zh-CN/guide.md', ['npx', 'clone']],
    ['README.md', ['npx']],
    ['docs/i18n/zh-CN/README.md', ['npx']],
    ['docs/i18n/ja/README.md', ['npx']],
    ['docs/i18n/zh-TW/README.md', ['npx']],
  ];
  for (const [file, lists] of shown) {
    assert.deepEqual(missingCommands(facts, lists, readFileSync(join(ROOT, file), 'utf8')), [], `${file} lacks these commands from docs/facts.json; change both`);
  }
});

// npm shows the README from the package. A relative image or link breaks there (#713).
// http(s) URLs and #anchors still open. The scan names the file and the line.
type ReadmeTarget = { line: number; target: string };

/** The URL in a Markdown destination, without a title or angle brackets. */
function readLinkTarget(raw: string): string {
  const target = raw.trim();
  if (target.startsWith('<')) {
    const end = target.indexOf('>');
    return (end >= 0 ? target.slice(1, end) : target.slice(1)).trim();
  }
  const title = target.search(/\s+["']/);
  return (title >= 0 ? target.slice(0, title) : target).trim();
}

/** One inline link at `open` (`[`), plus links nested in its text, such as a badge. */
function parseMarkdownLink(line: string, open: number): { target: string; end: number; inner: string[] } | null {
  const inner: string[] = [];
  let index = open + 1;
  while (index < line.length) {
    const character = line[index];
    if (character === '\\') {
      index += 2;
      continue;
    }
    if (character === '[') {
      const nested = parseMarkdownLink(line, index);
      if (!nested) {
        index += 1;
        continue;
      }
      inner.push(nested.target, ...nested.inner);
      index = nested.end + 1;
      continue;
    }
    if (character === ']' && line[index + 1] === '(') {
      const start = index + 2;
      let depth = 1;
      let cursor = start;
      while (cursor < line.length && depth > 0) {
        const next = line[cursor];
        if (next === '\\') {
          cursor += 2;
          continue;
        }
        if (next === '(') depth += 1;
        else if (next === ')') depth -= 1;
        if (depth > 0) cursor += 1;
      }
      if (depth !== 0) return null;
      return { target: readLinkTarget(line.slice(start, cursor)), end: cursor, inner };
    }
    index += 1;
  }
  return null;
}

/** Targets of `src`, `srcset`, `href`, Markdown images, links and reference definitions on one line. */
function collectReadmeTargets(line: string, lineNumber: number, found: ReadmeTarget[]): void {
  const definition = /^\s{0,3}\[[^\]]+\]:\s*<?([^\s>]+)>?/.exec(line);
  if (definition) found.push({ line: lineNumber, target: definition[1] });
  for (const match of line.matchAll(/\b(srcset|src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    const parts = match[1].toLowerCase() === 'srcset' ? value.split(',') : [value];
    for (const part of parts) {
      const target = part.trim().split(/\s+/)[0];
      if (target) found.push({ line: lineNumber, target });
    }
  }
  let index = 0;
  while (index < line.length) {
    const open = line.indexOf('[', index);
    if (open < 0) return;
    if (open > 0 && line[open - 1] === '\\') {
      index = open + 1;
      continue;
    }
    const parsed = parseMarkdownLink(line, open);
    if (!parsed) {
      index = open + 1;
      continue;
    }
    for (const target of [...parsed.inner, parsed.target]) found.push({ line: lineNumber, target });
    index = parsed.end + 1;
  }
}

/** Every image and link target in a README, in source order. */
function findReadmeTargets(text: string): ReadmeTarget[] {
  const found: ReadmeTarget[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) collectReadmeTargets(lines[index].replace(/\r$/, ''), index + 1, found);
  return found;
}

/** True when npm can still open `target`: an http(s) URL, or a #anchor. */
const isAllowedReadmeTarget = (target: string): boolean => target.startsWith('#') || /^https?:\/\//i.test(target);

test('docs: README images and links use full URLs, so the npm page can show them (#713)', () => {
  const sample = [
    '<img src="docs/a.svg" alt="x">',
    "<source srcset='docs/b.svg 1x, https://example.com/c.svg'>",
    '![pic](docs/d.svg "a title")',
    '[site](https://example.com/page)',
    '[here](#local)',
    '[rel](docs/guide.md)',
    '[![badge](https://example.com/b.svg)](LICENSE)',
    '[angled](<https://example.com/a>)',
    '<a href="docs/e.md">e</a>',
    '[ref]: docs/f.md',
  ].join('\n');
  assert.deepEqual(findReadmeTargets(sample).map((item) => `${item.line} ${item.target}`), [
    '1 docs/a.svg',
    '2 docs/b.svg',
    '2 https://example.com/c.svg',
    '3 docs/d.svg',
    '4 https://example.com/page',
    '5 #local',
    '6 docs/guide.md',
    '7 https://example.com/b.svg',
    '7 LICENSE',
    '8 https://example.com/a',
    '9 docs/e.md',
    '10 docs/f.md',
  ]);

  const files = ['README.md', 'docs/i18n/zh-CN/README.md', 'docs/i18n/zh-TW/README.md', 'docs/i18n/ja/README.md'];
  const found: string[] = [];
  for (const file of files) {
    for (const item of findReadmeTargets(readFileSync(join(ROOT, file), 'utf8'))) {
      if (!isAllowedReadmeTarget(item.target)) found.push(`${file}:${item.line}: ${item.target}`);
    }
  }
  assert.deepEqual(found, [], found.join('\n'));
});

/**
 * Whether `text` from `start` is an autolink target, such as `https://example.com` or `a@example.com`.
 * A scheme is 2 to 32 characters (CommonMark), so `<o:p>` stays a tag: Word pastes it, and a
 * one-letter scheme would hide it from this check (#966).
 */
function isAutolinkTarget(text: string, start: number): boolean {
  const rest = text.slice(start);
  if (/^[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*>/.test(rest)) return true;
  return /^[^\s<>@]+@[^\s<>@]+>/.test(rest);
}

/**
 * `text` without inline code, HTML comments and Markdown autolinks, so a real tag is
 * all that is left. A scan, not one regex: CodeQL flags a regex that strips a comment
 * marker, because filtering with one is incomplete by nature (#966).
 */
function stripNonTagText(text: string): string {
  let plain = '';
  let index = 0;
  while (index < text.length) {
    if (text[index] === '`') {
      const close = text.indexOf('`', index + 1);
      if (close !== -1) {
        index = close + 1;
        continue;
      }
    }
    if (text.startsWith('<!--', index)) {
      const close = text.indexOf('-->', index + 4);
      if (close !== -1) {
        index = close + '-->'.length;
        continue;
      }
    }
    if (text[index] === '<' && isAutolinkTarget(text, index + 1)) {
      // An autolink target ends with `>`, so the guard is belt and braces: a `-1` here
      // would loop on the same character forever if that regex ever changed.
      const close = text.indexOf('>', index + 1);
      if (close === -1) {
        plain += text[index];
        index++;
        continue;
      }
      index = close + 1;
      continue;
    }
    plain += text[index];
    index++;
  }
  return plain;
}

/**
 * The lines of `text` outside code fences that hold an HTML tag. A comment is not a tag,
 * and neither is a Markdown autolink such as `<https://example.com>` (#966).
 */
function htmlTagLines(text: string): number[] {
  const lines: number[] = [];
  let isFenced = false;
  for (const [index, line] of text.split('\n').entries()) {
    if (line.startsWith('```')) isFenced = !isFenced;
    else if (!isFenced && /<\/?[A-Za-z][^>]*>/.test(stripNonTagText(line))) lines.push(index + 1);
  }
  return lines;
}

test('docs: the READMEs are plain Markdown, so npm and GitHub show the same page (#832)', () => {
  // npm, GitHub and agents render HTML differently, and npm showed a broken banner for
  // v0.1.0. Plain Markdown reads the same everywhere; the website carries the design.
  assert.deepEqual(htmlTagLines('# a\n<div align="center">\n`<b>` is code\n```\n<b>\n```\n<!-- note -->'), [2]);
  // An autolink and a comment holding a tag are not HTML; a real tag beside them still is (#966).
  assert.deepEqual(htmlTagLines('see <https://example.com>\n<!-- <b> -->\nmail <a@example.com>\n<b>bold</b> <https://x.dev>'), [4]);
  // A namespaced tag is a tag, not an autolink: its scheme is one letter, and CommonMark
  // asks for at least two. A two-letter scheme is still an autolink (#966).
  assert.deepEqual(htmlTagLines('<o:p>\n<b:foo> x\n<o:p></o:p>\n<mailto:a@b>'), [1, 2, 3]);
  const found: string[] = [];
  for (const file of ['README.md', 'docs/i18n/zh-CN/README.md', 'docs/i18n/zh-TW/README.md', 'docs/i18n/ja/README.md']) {
    for (const line of htmlTagLines(readFileSync(join(ROOT, file), 'utf8'))) found.push(`${file}:${line}`);
  }
  assert.deepEqual(found, [], `use Markdown, not HTML, at: ${found.join(', ')}`);
});

// The guide's Commands table is typed by hand; COMMANDS in src/run/cli.ts is what the
// parser and --help read (#219). Each command needs a row, and each option must show in
// one of its rows or in the paragraph right after the table. A command with no row, like
// help and version, passes when that paragraph names `yokoten <name>`: they take no
// option, and a row would only repeat the paragraph (#230).
type GuideCommand = { name: string; options: { name: string }[] };

/** True when `text` holds `word` with no letter, digit or dash right before or after it. */
const hasWord = (text: string, word: string): boolean => new RegExp(`(?<![\\w-])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(text);

/** What the Commands table under `heading` in `guide` lacks from `commands`, or names that `commands` lacks. */
function findGuideGaps(guide: string, heading: string, commands: GuideCommand[]): string[] {
  const lines = guide.split('\n');
  const start = lines.indexOf(heading);
  if (start < 0) return [`no "${heading}" heading`];
  const tableStart = lines.findIndex((line, i) => i > start && line.startsWith('|'));
  if (tableStart < 0 || lines.slice(start + 1, tableStart).some((line) => line.startsWith('#'))) return [`no table under "${heading}"`];
  let tableEnd = tableStart;
  while (lines[tableEnd]?.startsWith('|')) tableEnd++;
  // Skip the header row and the |---| row.
  const rows = lines.slice(tableStart + 2, tableEnd);
  let paragraphEnd = tableEnd + 1;
  while (lines[paragraphEnd]?.trim()) paragraphEnd++;
  const paragraph = lines.slice(tableEnd + 1, paragraphEnd).join(' ');
  // The command a row is about: the first word of its first cell.
  const commandOf = (row: string): string => row.split('|')[1].replaceAll('`', '').trim().split(/\s+/)[0];
  const gaps: string[] = [];
  for (const row of rows) {
    const name = commandOf(row);
    if (!commands.some((command) => command.name === name)) gaps.push(`a row names "${name}", which is not in COMMANDS`);
  }
  for (const command of commands) {
    const commandRows = rows.filter((row) => commandOf(row) === command.name);
    if (!commandRows.length && !hasWord(paragraph, `yokoten ${command.name}`)) gaps.push(`${command.name}: no row`);
    for (const option of command.options) {
      const isInParagraph = hasWord(paragraph, `\`${command.name}`) && hasWord(paragraph, option.name);
      if (!commandRows.some((row) => hasWord(row, option.name)) && !isInParagraph) gaps.push(`${command.name} ${option.name}: in no row`);
    }
  }
  return gaps;
}

test('docs: the guides\' Commands table covers every command and option in COMMANDS (#230)', () => {
  const fake: GuideCommand[] = [
    { name: 'check', options: [{ name: '--json' }, { name: '--staged' }] },
    { name: 'version', options: [] },
  ];
  const table = '### Commands\n\nIntro.\n\n| Command | What |\n|---|---|\n';
  assert.deepEqual(findGuideGaps(`${table}| \`check [--staged]\` | x |\n| \`lint\` | y |\n\nRun \`yokoten version\`.\n`, '### Commands', fake), [
    'a row names "lint", which is not in COMMANDS',
    'check --json: in no row',
  ]);
  assert.deepEqual(findGuideGaps(`${table}| \`check --staged\` | x |\n\n\`check\` takes \`--json\`.\n\nRun \`yokoten version\`.\n`, '### Commands', fake), ['version: no row']);
  assert.deepEqual(findGuideGaps(`${table}| \`check --staged\` | x |\n\n\`check\` takes \`--json\`. \`yokoten version\` too.\n`, '### Commands', fake), []);

  const guides: [string, string][] = [
    ['docs/guide.md', '### Commands'],
    ['docs/i18n/zh-CN/guide.md', '### 命令'],
  ];
  for (const [file, heading] of guides) {
    assert.deepEqual(findGuideGaps(readFileSync(join(ROOT, file), 'utf8'), heading, COMMANDS), [], `${file}: its Commands table differs from COMMANDS in src/run/cli.ts`);
  }
});

// The split tool (#152) moves tests one or two folders deeper. A test that imports a script
// still finds it there; an import the tool cannot place stops it, with a list. The fixture
// repo has a script and two test files named like the real ones, so the real table places them.
function makeSplitFixture(files: Record<string, string>): string {
  const root = makeTempDir('yokoten-split-');
  const hoisted = "const ROOT = 'root';\nconst CLI = 'cli';\nconst at = '@';\nfunction makeSandbox(): string {\n  return ROOT + CLI + at;\n}\n";
  const all: Record<string, string> = {
    'test/cli.test.ts': `import assert from 'node:assert/strict';\nimport { test } from 'node:test';\n\n${hoisted}\ntest('install: the helpers move', () => {\n  assert.equal(makeSandbox(), 'rootcli@');\n});\n`,
    ...files,
  };
  for (const [path, text] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

function runSplit(root: string): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [join(ROOT, 'scripts/split-tests.ts'), '--from', join(root, 'test'), '--out', join(root, 'split')], { encoding: 'utf8' });
  return { status: result.status, output: result.stdout + result.stderr };
}

test('split tests: an import of ../scripts/ gets the extra ../ and the moved test runs (#152)', () => {
  const root = makeSplitFixture({
    'scripts/greet.ts': 'export function greet(name: string): string {\n  return `hello ${name}`;\n}\n',
    'test/bot.test.ts': [
      "import assert from 'node:assert/strict';",
      "import { test } from 'node:test';",
      "import { greet } from '../scripts/greet.ts';",
      '',
      "test('board sync: a static import of a script', () => {",
      "  assert.equal(greet('board'), 'hello board');",
      '});',
      '',
      "test('board sync: a dynamic import of a script', async () => {",
      "  const module = await import('../scripts/greet.ts');",
      "  assert.equal(module.greet('sync'), 'hello sync');",
      '});',
      '',
    ].join('\n'),
  });
  const split = runSplit(root);
  assert.equal(split.status, 0, split.output);
  const moved = readFileSync(join(root, 'split/host/github.test.ts'), 'utf8');
  assert.match(moved, /^\/\/ Tests for scripts\/greet\.ts\.\n/);
  assert.match(moved, /^import \{ greet \} from '\.\.\/\.\.\/scripts\/greet\.ts';$/m);
  assert.match(moved, /await import\('\.\.\/\.\.\/scripts\/greet\.ts'\)/);
  // The child must not report to this test run, so it gets no NODE_TEST_CONTEXT.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'split/**/*.test.ts'], { cwd: root, encoding: 'utf8', env });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /^# pass 3$/m);
  assert.match(run.stdout, /^# fail 0$/m);
});

test('split tests: an import it cannot place stops it with a list, and nothing is written (#152)', () => {
  const root = makeSplitFixture({
    'test/bot.test.ts': [
      "import { test } from 'node:test';",
      "import { missing } from '../scripts/missing.ts';",
      "import { packaged } from 'some-package';",
      '',
      "test('board sync: never runs', () => {",
      '  missing(packaged);',
      '});',
      '',
    ].join('\n'),
  });
  const split = runSplit(root);
  assert.equal(split.status, 1, split.output);
  assert.match(split.output, /imports this script cannot place/);
  assert.match(split.output, /test\/bot\.test\.ts:2: missing from '\.\.\/scripts\/missing\.ts': no file scripts\/missing\.ts in the repo/);
  assert.match(split.output, /test\/bot\.test\.ts:3: packaged from 'some-package': not node: and not a relative path/);
  assert.ok(!existsSync(join(root, 'split')), 'a stopped split writes nothing');
});

// A simulated clock for the smoke control: a wait adds to the time instead of spinning.
const simulated = () => {
  let now = 0;
  return { clock: { now: () => now }, wait: (ms: number) => void (now += ms) };
};

test('assertLinear: a quadratic scan fails every time; a linear scan passes (#754)', () => {
  // n * n counted steps. The old control counted pairs and hoped the clock noticed.
  const quadratic = (input: string) => {
    for (let i = 0; i < input.length; i++) for (let j = 0; j < input.length; j++) noteWork(1);
  };
  assert.throws(() => assertLinear('quadratic', (n) => 'x'.repeat(n), quadratic, 200), /linear is about 8x/);
  const linear = (input: string) => {
    for (let i = 0; i < input.length; i++) noteWork(1);
  };
  assertLinear('linear', (n) => 'x'.repeat(n), linear, 200);
});

test('assertLinearEach: one quadratic shape among linear ones fails (#442)', () => {
  const linear = (input: string) => {
    for (let i = 0; i < input.length; i++) noteWork(1);
  };
  const quadratic = (input: string) => {
    for (let i = 0; i < input.length; i++) for (let j = 0; j < input.length; j++) noteWork(1);
  };
  const shapes = (read: (input: string) => void) => [
    { name: 'linear a', make: (n: number) => 'a'.repeat(n), read: linear },
    { name: 'the odd one', make: (n: number) => 'b'.repeat(n), read },
    { name: 'linear c', make: (n: number) => 'c'.repeat(n), read: linear },
  ];
  assert.throws(
    () => assertLinearEach(shapes(quadratic), 200),
    (error: Error) => /^the odd one: .* \d+x; linear is about 8x$/.test(error.message) && !error.message.includes('linear a'),
  );
});

test('assertLinear: a scan that counts nothing fails (#754)', () => {
  assert.throws(() => assertLinear('empty', (n) => 'x'.repeat(n), () => {}, 8), /counted no work/);
});

test('assertLinear: a scan that counts only its outer loop still passes (#754)', () => {
  // The inner loop is quadratic and never calls noteWork. Record 0032: the count cannot see it.
  const hidden = (input: string) => {
    for (let i = 0; i < input.length; i++) {
      noteWork(1);
      for (let j = 0; j < input.length; j++) input.charCodeAt(j);
    }
  };
  assertLinear('hidden quadratic', (n) => 'x'.repeat(n), hidden, 50);
});

test('wall-clock smoke: a 100x blow-up fails, one slow read is retried, and a hang fails at once (#754)', () => {
  const blow = simulated();
  const quadraticTime = (input: string) => blow.wait(input.length > 100 ? 100 : 1);
  assert.throws(() => assertWallSmoke('blow', (n) => 'x'.repeat(n), quadraticTime, 100, blow.clock), /100x blow-up/);
  // The first big read is slow. The retry is linear, so the smoke passes.
  const noisy = simulated();
  let slowReads = 0;
  const oneSlowRead = (input: string) => {
    if (input.length > 100 && slowReads++ === 0) noisy.wait(5_000);
    noisy.wait(input.length / 100);
  };
  assertWallSmoke('noisy', (n) => 'x'.repeat(n), oneSlowRead, 100, noisy.clock);
  const hung = simulated();
  assert.throws(() => assertWallSmoke('hung', (n) => 'x'.repeat(n), () => hung.wait(30_000), 100, hung.clock), /a hang/);
});

// No test reads or writes the real home folder (#356). test/repo/home.ts points HOME at an
// empty temp folder, so it has to load before anything else: it is each test file's first
// import. A child process inherits that HOME, unless the test gives it an env of its own
// with no HOME; then the CLI falls back to the system's home, the real one. In src, only
// privacy.ts asks the system for the home folder; the rest reads HOME from the env it is given.
const HOME_MODULE = 'repo/home.ts';
const RUNS_CHILD = /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\(/;

/** The object literal that starts at `open` (a `{`), braces matched; the rest of the line when it runs on. */
function literalAt(line: string, open: number): string {
  let depth = 0;
  for (let i = open; i < line.length; i++) {
    if (line[i] === '{') depth++;
    else if (line[i] === '}' && --depth === 0) return line.slice(open, i + 1);
  }
  return line.slice(open);
}

/** What breaks the rule in the test files, each given by its path inside test/ and its text. */
function homeProblems(files: Record<string, string>): string[] {
  const problems: string[] = [];
  for (const [path, text] of Object.entries(files)) {
    if (path === HOME_MODULE) continue;
    const rel = posix.relative(posix.dirname(path), HOME_MODULE);
    const wanted = `import '${rel.startsWith('.') ? rel : `./${rel}`}';`;
    const lines = text.split('\n');
    const first = lines.find((line) => line.startsWith('import '));
    if (first !== wanted) problems.push(`test/${path}: the first import must be ${wanted}`);
    lines.forEach((line, i) => {
      if (!RUNS_CHILD.test(line)) return;
      for (const match of line.matchAll(/\benv: \{/g)) {
        const env = literalAt(line, (match.index ?? 0) + match[0].length - 1);
        if (!/\bHOME\b|\.\.\./.test(env)) problems.push(`test/${path}:${i + 1}: a child process gets an env with no HOME`);
      }
    });
  }
  return problems;
}

test('home: the scan finds a test file that loads the temp home late, and a child env with no HOME (#356)', () => {
  const call = 'spawnSync'; // a variable, so this file's own scan does not read the fixtures as calls
  const good = "// A test.\nimport '../repo/home.ts';\nimport assert from 'node:assert/strict';\n";
  assert.deepEqual(homeProblems({
    'run/good.test.ts': `${good}${call}('node', [CLI], { env: { ...sandbox.env, X: '1' } });\n${call}('node', [], { env: { PATH: '', HOME: temp } });\n`,
    'repo/helpers.ts': "import './home.ts';\n",
    'agents/runtimes/x.test.ts': "import '../../repo/home.ts';\n",
    'repo/home.ts': 'no imports needed\n',
  }), []);
  assert.deepEqual(homeProblems({
    'run/late.test.ts': "import assert from 'node:assert/strict';\nimport '../repo/home.ts';\n",
    'run/none.test.ts': "import { test } from 'node:test';\n",
    'run/bare.test.ts': `${good}const out = ${call}('node', [CLI, 'doctor'], { env: { PATH: process.env.PATH, TZ: 'UTC' }, encoding: 'utf8' });\n`,
  }), [
    "test/run/late.test.ts: the first import must be import '../repo/home.ts';",
    "test/run/none.test.ts: the first import must be import '../repo/home.ts';",
    'test/run/bare.test.ts:4: a child process gets an env with no HOME',
  ]);
});

test('home: every test file loads the temp home first, and no child gets an env with no HOME (#356)', () => {
  const files = Object.fromEntries(filesUnder(join(ROOT, 'test')).filter((path) => path.endsWith('.ts')).map((path) => [path, readFileSync(join(ROOT, 'test', path), 'utf8')]));
  assert.ok(Object.keys(files).length > 10, 'the test file scan found too few files; it is broken');
  assert.deepEqual(homeProblems(files), [], 'import test/repo/home.ts first; give a child process HOME, or spread an env that has it');
});

test('home: in src, only privacy/home.ts asks the system for the home folder (#356)', () => {
  const found = filesUnder(SRC).filter((path) => /\bhomedir\(|userInfo\(\)\.homedir/.test(readFileSync(join(SRC, path), 'utf8')));
  assert.deepEqual(found, ['rules/privacy/home.ts'], 'read the home folder from env.HOME (homeOf or homeIn); the CLI entry fills it in');
});

test('home: a test that reads the home folder gets the empty temp one, not the real one (#356)', () => {
  // The positive control: the plain lookups a careless test would use.
  assert.equal(homedir(), TEST_HOME);
  assert.equal(process.env.HOME, TEST_HOME);
  assert.ok(TEST_HOME.startsWith(tmpdir()), 'the test home is in the temp folder');
  let real = '';
  try {
    real = userInfo().homedir;
  } catch {
    // No password entry (some containers): there is no other home to compare with.
  }
  if (real) assert.notEqual(homedir(), real, 'homedir() in a test must not be the real home folder');
  assert.equal(existsSync(join(homedir(), '.config', 'yokoten')), false, 'the test home starts empty');
  // A child process with no env of its own inherits it.
  const child = spawnSync(process.execPath, ['-e', "process.stdout.write(require('node:os').homedir())"], { encoding: 'utf8' });
  assert.equal(child.stdout, TEST_HOME);
});

test('session: the suite clears yokoten variables before a test can read them (#712)', () => {
  const sample: NodeJS.ProcessEnv = { PATH: '/usr/bin', HOME: '/tmp/home', YOKOTEN_ROLE: 'worker', YOKOTEN_DESK: '/desk', YOKOTEN_TEAM: '/team', YOKOTEN_FIX_TASK: '1' };
  clearYokotenEnv(sample);
  assert.deepEqual(sample, { PATH: '/usr/bin', HOME: '/tmp/home' });
  assert.deepEqual(Object.keys(process.env).filter((name) => name.startsWith('YOKOTEN_')), []);
  // A child starts with the session's variables set, then loads the same module every test loads first.
  const childEnv = { ...process.env, YOKOTEN_ROLE: 'worker', YOKOTEN_DESK: '/desk', YOKOTEN_TEAM: '/team' };
  delete childEnv.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', "import './test/repo/home.ts'; process.stdout.write(Object.keys(process.env).some((name) => name.startsWith('YOKOTEN_')) ? 'seen' : 'clear')"], {
    cwd: ROOT,
    env: childEnv,
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, 'clear');
});

// ---- The process, read once (#475) ----
//
// bin/main.ts's runFromProcess makes the one Invocation from the process. Below it, a module
// reads the command line, env, folder and streams from there, so every command can run in
// this process in a test. Comments may name them; code may not.
const PROCESS_READS = new Set(['argv', 'env', 'cwd', 'stdin', 'stdout', 'stderr']);

/**
 * Each `process.<argv|env|cwd|stdin|stdout|stderr>`, `readFileSync(0` / `readSync(0` and `/dev/stdin` in the code, as
 * "line: what". So no read slips past by another road, `process` used as a value (`= process`,
 * `process[...]`) and an import of `node:process` count too.
 */
function processReads(text: string): string[] {
  const tokens = tokenize(text);
  const found: string[] = [];
  tokens.forEach((token, index) => {
    const next = tokens[index + 1];
    const after = tokens[index + 2];
    if (token.text === 'process' && (next?.text === '.' || next?.text === '?.') && after && PROCESS_READS.has(after.text)) found.push(`${token.line}: process.${after.text}`);
    if ((token.text === 'readFileSync' || token.text === 'readSync') && next?.text === '(' && after?.text === '0') found.push(`${token.line}: ${token.text}(0`);
    const before = tokens[index - 1];
    const member = before?.text === '.' || before?.text === '?.';
    if (token.kind === 'name' && token.text === 'process' && !member && next?.text !== '.' && next?.text !== '?.') found.push(`${token.line}: process as a value`);
    if (token.kind === 'string' && /^['"`](?:node:)?process['"`]$/.test(token.text)) found.push(`${token.line}: node:process`);
    if (token.kind === 'string' && token.text.slice(1, -1) === '/dev/stdin') found.push(`${token.line}: /dev/stdin`);
  });
  return found;
}

test('process: the scan finds each read of the process, and not one in a comment or a string (#475)', () => {
  const text = [
    "// process.env in a comment, and readSync(0 too",
    "const said = 'process.cwd()';",
    'const home = process.env.HOME;',
    'const here = process.cwd();',
    'process.stdin.on("data", () => {});',
    'const all = readFileSync(0, "utf8");',
    'readSync(0, buffer);',
    'const exit = process.exitCode;',
    'const { env } = process;',
    "import { cwd } from 'node:process';",
    "const home = process['env'];",
    "const all = readFileSync('/dev/stdin', 'utf8');",
    'const kind = options.process;',
  ].join('\n');
  assert.deepEqual(processReads(text), ['3: process.env', '4: process.cwd', '5: process.stdin', '6: readFileSync(0', '7: readSync(0', '9: process as a value', '10: node:process', '11: process as a value', '12: /dev/stdin']);
});

test('process: below bin/main.ts, src/ reads no env, folder or stream of the process (#475)', () => {
  const found = filesUnder(SRC)
    .filter((path) => path.endsWith('.ts'))
    .flatMap((path) => processReads(readFileSync(join(SRC, path), 'utf8')).map((read) => `src/${path}:${read}`));
  assert.deepEqual(found, [], 'read it from the Invocation (bin/main.ts makes it), or pass it in as an argument');
});

// ---- Which system: one place to ask (record 0040) ----
//
// The first native Windows run found real bugs, all in code that asked `process.platform`
// in place. Record 0040 moves every such read into src/platform/. Until then, these files may
// keep the reads they have: a new file with a read, or one more read in a listed file,
// fails. When a read moves out, lower its count here, so the list only gets shorter.
const PLATFORM_READS: [string, number][] = [
  ['agents/copilot.ts', 1],
  ['agents/desk/desk.ts', 1],
  ['agents/desk/start.ts', 1],
  ['agents/runtimes/small/deepseek-harness.ts', 1],
  ['commands/kanban/server.ts', 1],
  ['commands/more/check.ts', 1],
  ['commands/hook.ts', 1],
  ['commands/more/merge/train.ts', 1],
  ['commands/more/setup.ts', 2],
  ['host/light.ts', 1],
  ['rules/guards/commands/no-wipe.ts', 2],
  ['rules/guards/hooks/read.ts', 1],
  ['rules/guards/lead-only/edit.ts', 2],
  ['rules/privacy.ts', 1],
  ['run/hook.ts', 5],
  ['setup/advice/unsaved.ts', 5],
  ['setup/doctor/checks.ts', 2],
  ['setup/init.ts', 1],
  ['setup/install.ts', 10],
  ['setup/road.ts', 1],
];

/** How many times `text` reads `process.platform`, outside comments and strings. */
function platformReads(text: string): number {
  const tokens = tokenize(text);
  return tokens.filter((token, index) => token.text === 'process' && (tokens[index + 1]?.text === '.' || tokens[index + 1]?.text === '?.') && tokens[index + 2]?.text === 'platform').length;
}

test('platform: the scan counts process.platform, and not one in a comment or a string (record 0040)', () => {
  const text = ["// process.platform in a comment", "const said = 'process.platform';", 'const os = process.platform;', 'const win = process?.platform === "win32";', 'const kind = options.platform;'].join('\n');
  assert.equal(platformReads(text), 2);
});

// A ratchet: `found` is what a scan counts in each file, `allowed` today's list. A file over
// its count, or not on the list, fails with `fix`; a listed file under its count fails too, so
// the list only gets shorter. `where` is the folder the paths are in, for the message.
function ratchetProblems(found: Map<string, number>, allowed: [string, number][], where: string, list: string, fix: string): string[] {
  const most = new Map(allowed);
  const problems: string[] = [];
  for (const [path, count] of found) if (count > (most.get(path) ?? 0)) problems.push(`${where}${path}: ${count} found, ${most.get(path) ?? 0} allowed. ${fix}`);
  for (const [path, listed] of allowed) {
    const count = found.get(path) ?? 0;
    if (count < listed) problems.push(count === 0 ? `${where}${path}: none left. Remove it from ${list} (test/repo/architecture.test.ts).` : `${where}${path}: ${count} now, ${listed} listed. Lower its count in ${list} (test/repo/architecture.test.ts).`);
  }
  return problems;
}

const PLATFORM_RULE = 'Rule: only src/platform/ reads process.platform (record 0040, docs/records/0040-one-codebase-platform-layer.md; the move is issue #1000).';
const PLATFORM_FIX = 'Take the platform as an argument, from the caller.';

test('platform: a new read, a read past the count, and a moved read are each caught (record 0040)', () => {
  const found = new Map([['rules/new.ts', 1], ['setup/kept.ts', 2], ['run/moved.ts', 0], ['host/fewer.ts', 1]]);
  const allowed: [string, number][] = [['setup/kept.ts', 1], ['run/moved.ts', 1], ['host/fewer.ts', 3], ['agents/gone.ts', 1]];
  assert.deepEqual(ratchetProblems(found, allowed, 'src/', 'PLATFORM_READS', PLATFORM_FIX), [
    `src/rules/new.ts: 1 found, 0 allowed. ${PLATFORM_FIX}`,
    `src/setup/kept.ts: 2 found, 1 allowed. ${PLATFORM_FIX}`,
    'src/run/moved.ts: none left. Remove it from PLATFORM_READS (test/repo/architecture.test.ts).',
    'src/host/fewer.ts: 1 now, 3 listed. Lower its count in PLATFORM_READS (test/repo/architecture.test.ts).',
    'src/agents/gone.ts: none left. Remove it from PLATFORM_READS (test/repo/architecture.test.ts).',
  ]);
  assert.deepEqual(ratchetProblems(new Map([['setup/kept.ts', 1]]), [['setup/kept.ts', 1]], 'src/', 'PLATFORM_READS', PLATFORM_FIX), [], 'a file at its count passes');
});

test('platform: no new process.platform read outside the list, and the list only shrinks (record 0040)', () => {
  const found = new Map<string, number>();
  for (const path of filesUnder(SRC).filter((file) => file.endsWith('.ts') && !file.startsWith('platform/'))) found.set(path, platformReads(readFileSync(join(SRC, path), 'utf8')));
  assert.ok([...found.values()].some((count) => count > 0), 'the scan found no read; it is broken');
  assert.deepEqual(ratchetProblems(found, PLATFORM_READS, 'src/', 'PLATFORM_READS', PLATFORM_FIX), [], PLATFORM_RULE);
});

// ---- Kanban reaches outside code through one port (issue #1091) ----
//
// The kanban area (src/commands/kanban/) uses no old code directly. Its files import only
// each other, src/platform/ and node: modules. Everything else goes through ports.ts, which
// names its own functions and shapes and re-exports nothing. These are the outside modules
// ports.ts imports today. Replacing one removes its line, so the list only gets shorter: it
// is the to-do list of old code still behind the port.
const KANBAN_PORTS = [
  'commands/more/advice/schedule.ts',
  'commands/more/check.ts',
  'commands/shared.ts',
  'host/github/index.ts',
  'rules/text/message.ts',
  'rules/privacy.ts',
  'run/hook.ts',
  'run/learn.ts',
  'setup/files.ts',
  'setup/install.ts',
  'setup/plan.ts',
];

const KANBAN_AREA = 'commands/kanban/';
const KANBAN_PORT_FILE = 'commands/kanban/ports.ts';
const KANBAN_RULE = 'Rule: the kanban area reaches outside code only through src/commands/kanban/ports.ts (issue #1091).';
const KANBAN_FIX = 'Add a port in src/commands/kanban/ports.ts, with its own name and shape, and import that.';

/** One module a file names in an `import` or `export ... from`, or a form the scan refuses. */
type ModuleUse = { line: number; spec: string; isReExport: boolean } | { line: number; refused: string };

/** The tokens of an import's or export's names, before `from`: `type`, `{ a as b, c }`, `* as d`. */
const isNameListToken = (token: Token): boolean => token.kind === 'name' || ['{', '}', ',', '*'].includes(token.text);

/**
 * Each module `text` names, on tokens, so a comment or a string is never read as code.
 * Fail closed: `import(`, `require`, `node:child_process`, `import.meta` and any import
 * shape not read here (`import x = ...`) come back refused.
 */
function findModuleUses(text: string): ModuleUse[] {
  const tokens = tokenize(text);
  const uses: ModuleUse[] = [];
  // From `at`, the names up to `from '<module>'` (or the module at once, for `import './x'`): the module's token index, or -1.
  const moduleAfter = (at: number, isBare: boolean): number => {
    let index = at;
    if (isBare && tokens[index]?.kind === 'string') return index;
    while (tokens[index] && isNameListToken(tokens[index]) && !(tokens[index].text === 'from' && tokens[index + 1]?.kind === 'string')) index += 1;
    return tokens[index]?.text === 'from' && tokens[index + 1]?.kind === 'string' ? index + 1 : -1;
  };
  tokens.forEach((token, index) => {
    const { line } = token;
    const member = ['.', '?.'].includes(tokens[index - 1]?.text);
    if (token.kind === 'string' && /^(?:node:)?child_process$/.test(token.text.slice(1, -1))) uses.push({ line, refused: 'node:child_process' });
    if (token.kind !== 'name' || member) return;
    if (token.text === 'require' || token.text === 'createRequire') uses.push({ line, refused: token.text });
    if (token.text === 'import') {
      if (tokens[index + 1]?.text === '(') return void uses.push({ line, refused: 'import(' });
      const at = moduleAfter(index + 1, true);
      if (at < 0) return void uses.push({ line, refused: 'an import the scan cannot read' });
      uses.push({ line, spec: tokens[at].text.slice(1, -1), isReExport: false });
    }
    if (token.text === 'export') {
      let next = index + 1;
      if (tokens[next]?.text === 'type') next += 1;
      if (tokens[next]?.text === '*') {
        const at = moduleAfter(next, false);
        if (at < 0) return void uses.push({ line, refused: 'an export the scan cannot read' });
        return void uses.push({ line, spec: tokens[at].text.slice(1, -1), isReExport: true });
      }
      if (tokens[next]?.text !== '{') return;
      let close = next;
      while (tokens[close] && tokens[close].text !== '}') close += 1;
      // `export { a, b }` lists names of this file; with `from '<module>'` after it, it passes another module's on.
      if (tokens[close + 1]?.text === 'from' && tokens[close + 2]?.kind === 'string') uses.push({ line, spec: tokens[close + 2].text.slice(1, -1), isReExport: true });
    }
  });
  return uses;
}

/**
 * What breaks the kanban rule in `files` (path under src/ → text): an import out of the
 * area from any file but ports.ts, a refused form, a re-export in ports.ts, and a module
 * ports.ts imports that is not on `ports`, or one on `ports` it no longer imports.
 */
function findKanbanProblems(files: Map<string, string>, ports: string[]): string[] {
  const problems: string[] = [];
  const reached = new Set<string>();
  for (const [path, text] of files) {
    if (!path.startsWith(KANBAN_AREA)) continue;
    const isPort = path === KANBAN_PORT_FILE;
    for (const use of findModuleUses(text)) {
      const place = `src/${path}:${use.line}`;
      if ('refused' in use) {
        problems.push(`${place}: ${use.refused} is refused in the kanban area. A child process goes through src/platform/; anything else, ${KANBAN_FIX}`);
        continue;
      }
      if (isPort && use.isReExport) problems.push(`${place}: ports.ts re-exports '${use.spec}'. Write the port as a function or a type of its own.`);
      if (use.spec.startsWith('node:')) continue;
      if (!use.spec.startsWith('./') && !use.spec.startsWith('../')) {
        problems.push(`${place}: imports '${use.spec}', which the scan cannot place. Name a node: module or a relative .ts file.`);
        continue;
      }
      const target = posix.normalize(posix.join(posix.dirname(path), use.spec));
      if (target.startsWith(KANBAN_AREA) || target.startsWith('platform/')) continue;
      if (isPort) reached.add(target);
      else problems.push(`${place}: imports '${use.spec}', outside the kanban area. ${KANBAN_FIX}`);
    }
  }
  for (const target of [...reached].sort()) if (!ports.includes(target)) problems.push(`src/${KANBAN_PORT_FILE} imports src/${target}, which is not on KANBAN_PORTS. Reach it through a module already on the list, or ask the owner to add it (test/repo/architecture.test.ts).`);
  for (const target of ports) if (!reached.has(target)) problems.push(`src/${target}: ports.ts no longer imports it. Remove it from KANBAN_PORTS (test/repo/architecture.test.ts).`);
  return problems;
}

test('kanban port: the scan reads imports on tokens, and refuses what it cannot read (issue #1091)', () => {
  const text = [
    "// import { a } from '../../rules/a.ts'",
    "const said = \"import { b } from '../../rules/b.ts'\";",
    "import { c } from './c.ts';",
    'import {',
    '  type D,',
    '  e as f,',
    "} from '../../rules/d.ts';",
    "import * as g from 'node:path';",
    "import './side.ts';",
    "const h = await import('./h.ts');",
    "const i = require('./i.ts');",
    "import j = require('./j.ts');",
    "import { spawn } from 'node:child_process';",
    'const k = import.meta.url;',
    "export { l };",
    "export { m } from './m.ts';",
    "export type * from './n.ts';",
    'const fromHere = options.import;',
  ].join('\n');
  assert.deepEqual(findModuleUses(text), [
    { line: 3, spec: './c.ts', isReExport: false },
    { line: 4, spec: '../../rules/d.ts', isReExport: false },
    { line: 8, spec: 'node:path', isReExport: false },
    { line: 9, spec: './side.ts', isReExport: false },
    { line: 10, refused: 'import(' },
    { line: 11, refused: 'require' },
    { line: 12, refused: 'an import the scan cannot read' },
    { line: 12, refused: 'require' },
    { line: 13, spec: 'node:child_process', isReExport: false },
    { line: 13, refused: 'node:child_process' },
    { line: 14, refused: 'an import the scan cannot read' },
    { line: 16, spec: './m.ts', isReExport: true },
    { line: 17, spec: './n.ts', isReExport: true },
  ]);
});

test('kanban port: an import out of the area, a refused form, a re-export, and a list out of step are each caught (issue #1091)', () => {
  const files = new Map([
    ['commands/kanban/view.ts', ["import { a } from './ports.ts';", "import { b } from '../../platform/process.ts';", "import { join } from 'node:path';", "import { c } from '../../rules/config.ts';"].join('\n')],
    ['commands/kanban/feed/read.ts', ["import type { D } from '../../shared.ts';", "const e = await import('../ports.ts');", "import f from 'fs';"].join('\n')],
    ['commands/kanban/server.ts', "import { spawn } from 'node:child_process';"],
    ['commands/kanban/ports.ts', ["import { g } from '../../rules/listed.ts';", "import { h } from '../../setup/new.ts';", "export * from '../../rules/listed.ts';", "export { i } from './inside.ts';"].join('\n')],
    ['commands/more/check.ts', "import { j } from '../../rules/anything.ts';"],
  ]);
  const ports = ['rules/listed.ts', 'run/gone.ts'];
  assert.deepEqual(findKanbanProblems(files, ports), [
    `src/commands/kanban/view.ts:4: imports '../../rules/config.ts', outside the kanban area. ${KANBAN_FIX}`,
    `src/commands/kanban/feed/read.ts:1: imports '../../shared.ts', outside the kanban area. ${KANBAN_FIX}`,
    `src/commands/kanban/feed/read.ts:2: import( is refused in the kanban area. A child process goes through src/platform/; anything else, ${KANBAN_FIX}`,
    "src/commands/kanban/feed/read.ts:3: imports 'fs', which the scan cannot place. Name a node: module or a relative .ts file.",
    `src/commands/kanban/server.ts:1: node:child_process is refused in the kanban area. A child process goes through src/platform/; anything else, ${KANBAN_FIX}`,
    "src/commands/kanban/ports.ts:3: ports.ts re-exports '../../rules/listed.ts'. Write the port as a function or a type of its own.",
    "src/commands/kanban/ports.ts:4: ports.ts re-exports './inside.ts'. Write the port as a function or a type of its own.",
    'src/commands/kanban/ports.ts imports src/setup/new.ts, which is not on KANBAN_PORTS. Reach it through a module already on the list, or ask the owner to add it (test/repo/architecture.test.ts).',
    'src/run/gone.ts: ports.ts no longer imports it. Remove it from KANBAN_PORTS (test/repo/architecture.test.ts).',
  ]);
  const clean = new Map([
    ['commands/kanban/view.ts', "import { a } from './ports.ts';"],
    ['commands/kanban/ports.ts', "import { g } from '../../rules/listed.ts';"],
  ]);
  assert.deepEqual(findKanbanProblems(clean, ['rules/listed.ts']), [], 'a kanban file that imports the port, and a port on the list, pass');
});

test('kanban port: only ports.ts reaches outside the area, and KANBAN_PORTS matches what it imports (issue #1091)', () => {
  const files = new Map(filesUnder(join(SRC, 'commands', 'kanban')).map((path) => [`${KANBAN_AREA}${path}`, readFileSync(join(SRC, 'commands', 'kanban', path), 'utf8')]));
  assert.ok(files.has(KANBAN_PORT_FILE), 'src/commands/kanban/ports.ts is missing');
  assert.ok(findModuleUses(files.get(KANBAN_PORT_FILE) ?? '').length >= KANBAN_PORTS.length, 'the scan found no import in ports.ts; it is broken');
  assert.deepEqual(findKanbanProblems(files, KANBAN_PORTS), [], KANBAN_RULE);
});

// ---- A test does not skip itself on Windows (#1078) ----
//
// A test that asks `process.platform === 'win32'` to skip or cut itself short hides its
// Windows gap in its own file, where no one counts it. A platform skip belongs in the one
// per-OS table, TEST_AREAS in scripts/time/windows-known.ts (issue #1068, PR #1076), with a
// reason. These test files branch on Windows today; the count only goes down. The scan
// counts direct comparisons and the usual helper names only: a reviewer catches the rest.
const WINDOWS_BRANCHES: [string, number][] = [
  ['agents/desk/network/bridge.test.ts', 1],
  ['agents/desk/network/proxy.test.ts', 1],
  ['agents/hooks-file.test.ts', 1],
  ['commands/more/advice/messages.test.ts', 1],
  ['commands/hook.test.ts', 10],
  ['host/light.test.ts', 1],
  ['repo/architecture.test.ts', 1],
  ['rules/guards/hooks/read.test.ts', 2],
  ['rules/guards/lead-only/targets.test.ts', 1],
  ['rules/guards/worker/box.test.ts', 3],
  ['rules/guards/worker/config-command.test.ts', 1],
  ['rules/guards/worker/config.test.ts', 1],
  ['rules/guards/worker/mark.test.ts', 4],
  ['rules/privacy.test.ts', 3],
  ['run/check.test.ts', 2],
  ['run/hook.test.ts', 14],
  ['run/notes/translations.test.ts', 1],
  ['setup/doctor/checks.test.ts', 3],
  ['setup/doctor/machine.test.ts', 1],
  ['setup/doctor/report.test.ts', 2],
  ['setup/init.test.ts', 5],
];

const WINDOWS_NAMES = new Set(['isWindows', 'IS_WINDOWS', 'isWin', 'IS_WIN']);
const COMPARES = new Set(['===', '!==', '==', '!=']);

/**
 * How many times `text` compares the running system with 'win32' (`process.platform` or
 * `platform()`, on either side), or names an isWindows-style helper, outside comments and
 * strings. A `platform` given as an argument is not counted: that is the right way.
 */
function windowsBranches(text: string): number {
  const tokens = tokenize(text);
  const isRunning = (at: number) =>
    (tokens[at]?.text === 'platform' && tokens[at - 1]?.text === '.' && tokens[at - 2]?.text === 'process')
    || (tokens[at]?.text === ')' && tokens[at - 1]?.text === '(' && tokens[at - 2]?.text === 'platform');
  const isRunningFrom = (at: number) =>
    (tokens[at]?.text === 'process' && tokens[at + 1]?.text === '.' && tokens[at + 2]?.text === 'platform')
    || (tokens[at]?.text === 'platform' && tokens[at + 1]?.text === '(' && tokens[at + 2]?.text === ')');
  let count = 0;
  tokens.forEach((token, index) => {
    if (token.kind === 'name' && WINDOWS_NAMES.has(token.text)) count += 1;
    if (token.kind !== 'string' || token.text.slice(1, -1) !== 'win32') return;
    if (COMPARES.has(tokens[index - 1]?.text) && isRunning(index - 2)) count += 1;
    else if (COMPARES.has(tokens[index + 1]?.text) && isRunningFrom(index + 2)) count += 1;
  });
  return count;
}

const WINDOWS_RULE = 'Rule: a test does not skip itself on Windows; its skip goes in TEST_AREAS, scripts/time/windows-known.ts (issue #1068, record 0040).';
const WINDOWS_FIX = 'Put the skip, with its reason, in TEST_AREAS (scripts/time/windows-known.ts), or pass the platform in as an argument.';

test('windows skips: the scan counts each test that asks for win32, and not a platform argument, a comment or a string (#1078)', () => {
  const text = [
    "// process.platform === 'win32' in a comment",
    "const said = \"process.platform === 'win32'\";",
    "test('a', { skip: process.platform === 'win32' && 'no exec bit' }, () => {});",
    "if (process.platform !== 'win32') check();",
    "const shell = 'win32' === process.platform ? 'cmd' : 'sh';",
    "if (platform() === 'win32') return;",
    "const NO_LINK = isWindows && 'no symlink';",
    "assert.equal(readTrust(root, env, 'win32').state, 'trusted');",
    "for (const platform of PLATFORMS) if (platform === 'win32') wide();",
    "const darwin = process.platform === 'darwin';",
  ].join('\n');
  assert.equal(windowsBranches(text), 5);
  assert.deepEqual(ratchetProblems(new Map([['run/new.test.ts', windowsBranches(text)]]), [], 'test/', 'WINDOWS_BRANCHES', WINDOWS_FIX), [`test/run/new.test.ts: 5 found, 0 allowed. ${WINDOWS_FIX}`], 'a new test file that skips on win32 is caught');
});

test('windows skips: no new test skips itself on win32, and the list only shrinks (#1078)', () => {
  const tests = join(ROOT, 'test');
  const found = new Map<string, number>();
  for (const path of filesUnder(tests).filter((file) => file.endsWith('.ts'))) found.set(path, windowsBranches(readFileSync(join(tests, path), 'utf8')));
  assert.ok([...found.values()].some((count) => count > 0), 'the scan found no win32 branch; it is broken');
  assert.deepEqual(ratchetProblems(found, WINDOWS_BRANCHES, 'test/', 'WINDOWS_BRANCHES', WINDOWS_FIX), [], WINDOWS_RULE);
});

// ---- Code given to node -e (#329) ----
//
// Code built from values is code injection waiting for a hostile value (CodeQL
// js/bad-code-sanitization). The code a test gives `node -e` is fixed text: string literals,
// maybe joined. Values go in on stdin or as arguments, which the child reads as data.
const EVAL_FLAGS = new Set(['-e', '--eval', '-p', '--print']);
const OPENERS = new Set(['(', '[', '{', '${']);
const CLOSERS = new Set([')', ']', '}']);
const FIXED_PUNCTUATION = new Set(['[', ']', ',', '(', ')', '+', '.']);

/** The tokens of the argument that starts at `from`: up to a `,`, `)` or `]` at its own depth. */
function argumentAt(tokens: Token[], from: number): Token[] {
  let depth = 0;
  let end = from;
  for (; end < tokens.length; end++) {
    const text = tokens[end].text;
    if (depth === 0 && [',', ')', ']'].includes(text)) break;
    if (OPENERS.has(text)) depth++;
    else if (CLOSERS.has(text)) depth--;
  }
  return tokens.slice(from, end);
}

/** Whether `code` is only string literals, joined; a name is read through its `const`. */
function isFixedCode(tokens: Token[], code: Token[], before: number): boolean {
  if (code.length === 1 && code[0].kind === 'name') {
    const declared = tokens.findLastIndex((token, index) => index < before && token.text === 'const' && tokens[index + 1]?.text === code[0].text && tokens[index + 2]?.text === '=');
    if (declared === -1) return false;
    let end = declared + 3;
    let depth = 0;
    for (; end < tokens.length && !(depth === 0 && tokens[end].text === ';'); end++) {
      if (OPENERS.has(tokens[end].text)) depth++;
      else if (CLOSERS.has(tokens[end].text)) depth--;
    }
    return isFixedCode(tokens, tokens.slice(declared + 3, end), -1);
  }
  return code.length > 0 && code.every((token) => token.kind === 'string' || (token.kind === 'punct' && FIXED_PUNCTUATION.has(token.text)) || (token.kind === 'name' && token.text === 'join'));
}

/** The lines of `text` that run node with -e, --eval, -p or --print, and how many give code built from values. */
function findSplicedCode(text: string): { checked: number; lines: number[] } {
  const tokens = tokenize(text);
  const lines: number[] = [];
  let checked = 0;
  tokens.forEach((token, index) => {
    if (token.kind !== 'string' || !EVAL_FLAGS.has(token.text.replace(/^['"]|['"]$/g, '')) || tokens[index + 1]?.text !== ',') return;
    // Node reads the flag only before a script, so the flag's array holds only flags before
    // it: `[execPath, 'script.ts', '-p', ...]` is the script's -p.
    let open = index - 1;
    while (open >= 0 && (tokens[open].text === ',' || (tokens[open].kind === 'string' && /^['"]-/.test(tokens[open].text)))) open--;
    if (tokens[open]?.text !== '[' || tokens[open - 1]?.text !== ',') return;
    // Back to the `(` of the call the array is an argument of: it runs node.
    let start = open - 1;
    for (let depth = 0; start > 0; start--) {
      const text = tokens[start - 1].text;
      if (text === ';') return;
      if (CLOSERS.has(text)) depth++;
      else if (OPENERS.has(text) && depth > 0) depth--;
      else if (text === '(') break;
    }
    const runsNode = tokens.slice(start, open).some((before) => before.text === 'execPath' || /^['"]?node['"]?$/.test(before.text));
    if (!runsNode) return;
    checked++;
    if (!isFixedCode(tokens, argumentAt(tokens, index + 2), index)) lines.push(token.line);
  });
  return { checked, lines };
}

test('node -e: the reader passes fixed code and catches code built from values (#329)', () => {
  const good = [
    "spawnSync(process.execPath, ['-e', 'console.log(1)']);",
    "spawnSync(process.execPath, ['--input-type=module', '-e', 'import(process.argv[1])', pathToFileURL(path).href]);",
    "const code = ['const input = 1;', `console.log(input)`].join('\\n');",
    "spawnSync(process.execPath, ['--eval', code], { input: JSON.stringify({ path }) });",
    "execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`]);",
    "const shown = ['-e', `${value}`];",
  ].join('\n');
  assert.deepEqual(findSplicedCode(good), { checked: 3, lines: [] });
  const bad = [
    "spawnSync(process.execPath, ['-e', `import(${JSON.stringify(path)})`]);",
    "execFileSync('node', ['--eval', 'import(' + JSON.stringify(path) + ')']);",
    'const code = `const path = ${JSON.stringify(path)};`;',
    "spawnSync(process.execPath, ['-p', code]);",
    "const lines = ['const a = 1;', JSON.stringify(path)].join('\\n');",
    "spawnSync(process.execPath, ['--print', lines]);",
    "spawnSync(process.execPath, ['-e', options.code]);",
  ].join('\n');
  assert.deepEqual(findSplicedCode(bad), { checked: 5, lines: [1, 2, 4, 6, 7] });
});

test('node -e: bin, src, scripts and test give node fixed code; values go on stdin or argv (#329)', () => {
  const found: string[] = [];
  let checked = 0;
  for (const path of execFileSync('git', ['ls-files', 'bin', 'src', 'scripts', 'test'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter((file) => file.endsWith('.ts'))) {
    const result = findSplicedCode(readFileSync(join(ROOT, path), 'utf8'));
    checked += result.checked;
    for (const line of result.lines) found.push(`${path}:${line}`);
  }
  assert.ok(checked >= 2, `only ${checked} node -e calls found; the reader is broken`);
  assert.deepEqual(found, [], 'make the code fixed text; pass each value on stdin or as an argument, and import a path with import(pathToFileURL(path).href)');
});

// ---- Child processes per test file (#475) ----
//
// A child node costs a start and a strip of every file's types; sandbox.call runs the same
// command in this process for neither. With a child per command test the suite took about
// 365 s summed on CI; with most of them in-process, about 58 s. So a test file starts few:
// one or two entry tests per command, each with a comment saying why it needs the child.
// A child is a sandbox's .run(, a spawn of node or process.execPath, a spawn that names the
// CLI or a yokoten.ts, or a call of a function that wraps one: a local runCopy, or one that
// helpers.ts exports.
const CHILD_STARTERS = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'runChild', 'fork']);

/** Whether the call whose `(` is at `open` starts a node: node or process.execPath first, or the CLI or a yokoten.ts in its arguments. */
function startsNode(tokens: Token[], open: number): boolean {
  const first = argumentAt(tokens, open + 1).map((token) => token.text).join('');
  if (first === "'node'" || first === '"node"' || first === 'process.execPath') return true;
  let depth = 0;
  for (let index = open; index < tokens.length; index++) {
    const token = tokens[index];
    if (OPENERS.has(token.text)) depth++;
    else if (CLOSERS.has(token.text) && --depth === 0) return false;
    if ((token.kind === 'name' && token.text === 'CLI') || (token.kind === 'string' && /yokoten\.(?:ts|mjs)/.test(token.text))) return true;
  }
  return false;
}

/** The name of the `const NAME = (...) =>` that the token at `at` is in, if any: then each call of NAME starts the child. */
function wrapperAt(tokens: Token[], at: number): { name: string; exported: boolean; from: number; to: number } | undefined {
  let depth = 0;
  let start = at;
  for (; start > 0; start--) {
    const text = tokens[start - 1].text;
    if (CLOSERS.has(text)) depth++;
    else if (OPENERS.has(text) && depth > 0) depth--;
    else if (OPENERS.has(text) && (text === '{' || text === '${') && tokens[start - 2]?.text !== '=>') break;
    else if (depth === 0 && (text === ';' || text === 'const' || text === 'let')) {
      if (text !== ';') start--;
      break;
    }
  }
  const [keyword, name, equals] = tokens.slice(start, start + 3);
  if (!['const', 'let'].includes(keyword?.text) || name?.kind !== 'name' || equals?.text !== '=') return undefined;
  if (!tokens.slice(start + 3, at).some((token) => token.text === '=>')) return undefined;
  // Its calls are the ones in its own block: another test may give its own wrapper the name.
  let to = start;
  for (let depth = 0; to < tokens.length; to++) {
    if (OPENERS.has(tokens[to].text)) depth++;
    else if (CLOSERS.has(tokens[to].text) && --depth < 0) break;
  }
  return { name: name.text, exported: tokens[start - 1]?.text === 'export', from: start + 2, to };
}

/** The lines of `text` that start a child node, a wrapper's calls in place of its body; and the wrappers it exports. */
function childStarts(text: string, imported: string[] = []): { lines: number[]; wrappers: string[] } {
  const tokens = tokenize(text);
  const sites: number[] = [];
  tokens.forEach((token, index) => {
    const open = tokens[index + 1]?.text === '(';
    if (token.text === 'run' && tokens[index - 1]?.text === '.' && open) sites.push(index);
    else if (CHILD_STARTERS.has(token.text) && open && tokens[index - 1]?.text !== 'function' && startsNode(tokens, index + 1)) sites.push(index);
  });
  const lines: number[] = [];
  const scopes = new Map(imported.map((name) => [name, { name, from: 0, to: tokens.length }]));
  const wrappers: string[] = [];
  for (const site of sites) {
    const wrapper = wrapperAt(tokens, site);
    if (!wrapper) lines.push(tokens[site].line);
    else scopes.set(`${wrapper.name}@${wrapper.from}`, wrapper);
    if (wrapper?.exported) wrappers.push(wrapper.name);
  }
  for (const { name, from, to } of scopes.values()) {
    for (let index = from; index < to; index++) {
      const before = tokens[index - 1]?.text;
      if (tokens[index].text === name && tokens[index + 1]?.text === '(' && !['.', '?.', 'function'].includes(before)) lines.push(tokens[index].line);
    }
  }
  return { lines: lines.sort((a, b) => a - b), wrappers };
}

/** The most child processes a test file starts, but the few on CHILD_ALLOWANCE: a command's one or two entry tests. */
const CHILD_CAP = 4;
// Files that need more, each at its count: the count may only go down. Keep it short; a
// file leaves the table once it is at CHILD_CAP or under.
const CHILD_ALLOWANCE: Record<string, { cap: number; reason: string }> = {
  'test/commands/more/check.test.ts': { cap: 8, reason: 'the entries of two commands, check --pr and redact; redact also runs in a shell pipe and on an 8 MB stream, as its hook runs it' },
  'test/commands/more/learn.test.ts': { cap: 15, reason: 'the full lesson loop runs two other copies of yokoten (the clone and .yokoten/), and the system-home fallback is in the CLI entry' },
  'test/repo/architecture.test.ts': { cap: 8, reason: 'it checks child processes themselves: a killed child, the split tool, the test home, the session variables and the report node --test writes' },
  'test/run/cli.test.ts': { cap: 9, reason: 'it tests bin/yokoten.ts itself: the entry, its compile cache, the demo loop and --help through the real entry' },
  'test/setup/init.test.ts': { cap: 12, reason: 'the entries of init, doctor, update and install, and the copies of yokoten that init writes (.yokoten/) or a clone holds' },
  'test/setup/install.test.ts': { cap: 7, reason: 'it runs the copy that install writes, from its own path, which is other code than this checkout' },
};
const CHILD_FIX = 'use sandbox.call in place of sandbox.run, or call the function; keep a child only for the entry, with a comment saying why';

/** What is wrong with the child processes of `files` (test path to source), given the wrappers helpers.ts exports. */
function childProblems(files: Record<string, string>, helpers: string[], allowance = CHILD_ALLOWANCE): string[] {
  const problems: string[] = [];
  for (const [path, text] of Object.entries(files)) {
    const { lines } = childStarts(text, helpers);
    const allowed = allowance[path];
    const cap = allowed?.cap ?? CHILD_CAP;
    if (lines.length > cap) problems.push(`${path} starts ${lines.length} child processes (lines ${lines.join(', ')}), over its cap of ${cap}: ${CHILD_FIX}`);
    else if (allowed && lines.length < cap) problems.push(`${path} starts ${lines.length} child processes, under its allowance of ${cap}: lower it in CHILD_ALLOWANCE to ${lines.length}${lines.length <= CHILD_CAP ? ', or take the file off it' : ''}`);
  }
  for (const path of Object.keys(allowance)) if (!(path in files)) problems.push(`CHILD_ALLOWANCE names ${path}, which is not a test file`);
  return problems;
}

test('child processes: the count finds each child node, through a wrapper too, and not git, a comment or another test\'s wrapper (#475)', () => {
  const text = [
    "// sandbox.run(['init']) in a comment, and spawnSync('node') too",
    "const said = \"sandbox.run(['doctor'])\";",
    "const result = sandbox.run(['init']);",
    "spawnSync('git', ['init', '-q']);",
    "const child = spawnSync('node', ['-e', '']);",
    "runChild(process.execPath, [script]);",
    "execFileSync(launcher, [CLI, 'doctor']);",
    "spawnSync('node', ['.yokoten/bin/yokoten.ts', 'init']);",
    "test('a', () => {",
    "  const hook = (command: string) => sandbox.run(['hook'], { input: command });",
    "  hook('git status');",
    "  hook('git push');",
    "});",
    "test('b', async () => {",
    "  const hook = (command: string) => sandbox.call(['hook'], { input: command });",
    "  await hook('git status');",
    "  assert.equal(readMark(sandbox, 'rules'), 'done');",
    "});",
    "function runChild(command: string, args: string[]) {",
    "  return spawnSync(command, args);",
    "}",
  ].join('\n');
  assert.deepEqual(childStarts(text, ['readMark']), { lines: [3, 5, 6, 7, 8, 11, 12, 17], wrappers: [] });
  assert.deepEqual(childStarts("export const mark = (sandbox: Sandbox) =>\n  JSON.parse(sandbox.run(['doctor', '--json']).stdout);\nconst run = () => runChild('node', [CLI]);\n").wrappers, ['mark'], 'an exported wrapper counts where it is called; a local one only where it is');
});

test('child processes: a test file over its cap fails with the fix, one at it passes, and an allowance only goes down (#475)', () => {
  const runs = (count: number) => Array.from({ length: count }, (_, index) => `sandbox.run(['doctor', '${index}']);`).join('\n');
  assert.deepEqual(childProblems({ 'test/a.test.ts': runs(CHILD_CAP), 'test/b.test.ts': '' }, [], {}), []);
  assert.deepEqual(childProblems({ 'test/a.test.ts': runs(CHILD_CAP + 1) }, [], {}), [
    `test/a.test.ts starts ${CHILD_CAP + 1} child processes (lines ${Array.from({ length: CHILD_CAP + 1 }, (_, index) => index + 1).join(', ')}), over its cap of ${CHILD_CAP}: ${CHILD_FIX}`,
  ]);
  const allowance = { 'test/a.test.ts': { cap: 10, reason: 'r' }, 'test/gone.test.ts': { cap: 9, reason: 'r' } };
  assert.deepEqual(childProblems({ 'test/a.test.ts': runs(10) }, [], { 'test/a.test.ts': allowance['test/a.test.ts'] }), []);
  assert.deepEqual(childProblems({ 'test/a.test.ts': runs(9) }, [], allowance), [
    'test/a.test.ts starts 9 child processes, under its allowance of 10: lower it in CHILD_ALLOWANCE to 9',
    'CHILD_ALLOWANCE names test/gone.test.ts, which is not a test file',
  ]);
  assert.match(childProblems({ 'test/a.test.ts': runs(2) }, [], allowance)[0], /to 2, or take the file off it$/);
});

test('child processes: each test file starts at most CHILD_CAP, or its allowance (#475)', () => {
  const helpers = childStarts(readFileSync(join(ROOT, 'test/repo/helpers.ts'), 'utf8')).wrappers;
  assert.deepEqual(helpers, [], 'no helper starts a child now; a new one counts in each file where it is called');
  const paths = execFileSync('git', ['ls-files', 'test'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter((path) => path.endsWith('.test.ts'));
  const files = Object.fromEntries(paths.map((path) => [path, readFileSync(join(ROOT, path), 'utf8')]));
  assert.ok(childStarts(files['test/setup/install.test.ts'] ?? '', helpers).lines.length > 0, 'no child found in install.test.ts; the count is broken');
  assert.deepEqual(childProblems(files, helpers), []);
});

// ---- The suite's time budget (#475) ----
//
// CI checks each shard's run time against a budget with scripts/time/suite.ts, from a TAP
// copy of the report. The budget is far above a slow runner; the child cap above is the
// stable check.
const tapReport = (ms: number) => [
  'TAP version 13',
  '# Subtest: install: the copy runs',
  '    # Subtest: inner step',
  '    ok 1 - inner step',
  '      ---',
  '      duration_ms: 99999',
  '      ...',
  'ok 1 - install: the copy runs',
  '  ---',
  '  duration_ms: 4200.5',
  "  type: 'test'",
  '  ...',
  'ok 2 - names: a \\# in a name # SKIP not on this platform',
  '  ---',
  '  duration_ms: 0.4',
  '  ...',
  'not ok 3 - check: a slow one',
  '  ---',
  '  duration_ms: 12000',
  '  ...',
  '1..3',
  '# tests 3',
  `# duration_ms ${ms}`,
  '',
].join('\n');

test('suite time: a run over the budget fails and says why; one under passes; the slowest tests are named (#475)', () => {
  assert.deepEqual(readReport(tapReport(30_000)), { ms: 30_000, tests: [{ name: 'install: the copy runs', ms: 4200.5 }, { name: 'names: a # in a name', ms: 0.4 }, { name: 'check: a slow one', ms: 12_000 }] });
  const under = judgeSuite(tapReport(30_000));
  assert.equal(under.isOver, false);
  assert.equal(under.text, `The tests took 30.0 s, under the budget of ${SUITE_BUDGET} s.\n\nThe slowest tests:\n- 12.0 s: check: a slow one\n- 4.2 s: install: the copy runs\n- 0.0 s: names: a # in a name\n`);
  const over = judgeSuite(tapReport(SUITE_BUDGET * 1000 * 1.5 + 1));
  assert.equal(over.isOver, true);
  assert.match(over.text, new RegExp(`^The tests took ${SUITE_BUDGET * 1.5}\\.0 s, over the budget of ${SUITE_BUDGET} s by ${SUITE_BUDGET * 0.5}\\.0 s, past the room a busy runner needs \\(50%\\)\\. Find what made them slow: .*use sandbox\\.call`));
  assert.equal(judgeSuite(tapReport(140_000), 90).text.split('\n')[0], 'The tests took 140.0 s, over the budget of 90 s by 50.0 s, past the room a busy runner needs (50%). Find what made them slow: most often a new child process per test (use sandbox.call), or a large stress input.', 'a budget of its own');
  assert.throws(() => readReport('TAP version 13\nok 1 - cut off\n'), /no \'# duration_ms\' line/);
});

test('suite time: a busy runner gets 50% more time for the same work, and a child per test still fails the cap (#783)', () => {
  // The same report, 20% slower: the runner was busy, not the tests.
  const slowRunner = judgeSuite(tapReport(SUITE_BUDGET * 1000 * 1.2));
  assert.equal(slowRunner.isOver, false);
  assert.match(slowRunner.text, /inside the room a busy runner needs \(50%\)/);

  // One child process per test is work, not load: the cap still catches it.
  const childPerTest = Array.from({ length: 5 }, (_, index) => `test('case ${index}', () => {\n  sandbox.run(['doctor']);\n});`).join('\n');
  assert.match(childProblems({ 'test/a.test.ts': childPerTest }, [], {})[0], /starts 5 child processes.*over its cap of 4/);
});

test('suite time: --warn-only reports a run over the budget and passes; without it, the run fails (PR #1112)', () => {
  assert.deepEqual(verdictOf(false, false), { code: 0 });
  assert.deepEqual(verdictOf(false, true), { code: 0 }, 'a run under the budget says nothing more');
  assert.deepEqual(verdictOf(true, false), { code: 1 }, 'the budget fails a run over it');
  const warned = verdictOf(true, true);
  assert.equal(warned.code, 0);
  assert.match(warned.warning ?? '', /^::warning title=Test time::.*only warns/);
});

test('suite time: it reads the report node --test writes on this Node (#475)', () => {
  const dir = makeTempDir('yokoten-suite-');
  writeFileSync(join(dir, 'one.test.ts'), "import { test } from 'node:test';\ntest('one: it runs', () => {});\n");
  const report = join(dir, 'report.tap');
  // A child: the report is node --test's own output. Without NODE_TEST_CONTEXT, or it reports to this run.
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = runChild(process.execPath, ['--test', '--test-reporter=tap', `--test-reporter-destination=${report}`, join(dir, 'one.test.ts')], { env });
  assert.equal(run.status, 0, run.stderr);
  const { ms, tests } = readReport(readFileSync(report, 'utf8'));
  assert.ok(ms > 0);
  assert.deepEqual(tests.map((test) => test.name), ['one: it runs']);
});

// ---- The Windows job's known failures (record 0040) ----

test('windows known: a failure is named by its test file and name, and a file past its cap by the time-out', () => {
  const tap = [
    'TAP version 13',
    '# Subtest: install: the copy runs',
    'ok 1 - install: the copy runs',
    '    not ok 1 - a subtest is its parent',
    'not ok 2 - install: writes ~/.claude',
    '  ---',
    '  ...',
    'not ok 3 - names: a \\# in a name # TODO later',
  ].join('\r\n');
  assert.deepEqual(readFailures(tap), ['install: writes ~/.claude', 'names: a # in a name']);
  assert.deepEqual(entriesOf('test\\setup\\install.test.ts', tap, true), [
    'test/setup/install.test.ts :: install: writes ~/.claude',
    'test/setup/install.test.ts :: names: a # in a name',
    `test/setup/install.test.ts :: ${TIMED_OUT}`,
  ]);
  // Positive control: a passing file in time has no entry.
  assert.deepEqual(entriesOf('test/a.test.ts', 'TAP version 13\nok 1 - fine\n', false), []);
});

test('windows known: a new failure and a fixed entry both fail the job; a flaky entry may do either', () => {
  const known = readKnown(['# a comment', '', 'test/a.test.ts :: still broken', 'test/a.test.ts :: fixed now', '? test/b.test.ts :: flaky'].join('\n'));
  assert.deepEqual(known, { required: ['test/a.test.ts :: still broken', 'test/a.test.ts :: fixed now'], flaky: ['test/b.test.ts :: flaky'] });
  assert.deepEqual(judgeKnown(['test/a.test.ts :: still broken', 'test/c.test.ts :: new'], known), { added: ['test/c.test.ts :: new'], fixed: ['test/a.test.ts :: fixed now'] });
  // Positive control: the list matches the run, with the flaky test passing or failing.
  for (const flaky of [[], ['test/b.test.ts :: flaky']]) {
    assert.deepEqual(judgeKnown(['test/a.test.ts :: still broken', 'test/a.test.ts :: fixed now', ...flaky], known), { added: [], fixed: [] });
  }
});

test('windows known: a slow file gets twice its last time over the cap; a file that timed out fixes nothing (2026-10-26)', () => {
  const times = readTimes('177 test/run/check.test.ts\n10 test/a.test.ts\n');
  assert.equal(capOf('test/run/check.test.ts', times, 240), 354);
  assert.equal(capOf('test\\run\\check.test.ts', times, 240), 354, 'a Windows path');
  assert.equal(capOf('test/a.test.ts', times, 240), 240, 'a fast file keeps the cap');
  assert.equal(capOf('test/new.test.ts', times, 240), 240, 'a file with no time keeps the cap');
  const known = readKnown('test/a.test.ts :: waived\ntest/b.test.ts :: fixed now\n');
  assert.deepEqual(judgeKnown([`test/a.test.ts :: ${TIMED_OUT}`], known), { added: [`test/a.test.ts :: ${TIMED_OUT}`], fixed: ['test/b.test.ts :: fixed now'] }, "the time-out is new; its file's waiver is not fixed; another file's is");
});

test('windows known: each failure keeps the first line of its error, with folders hidden, counted by kind', () => {
  const tap = [
    'TAP version 13',
    'not ok 1 - quoted error',
    '  ---',
    "  error: 'spawn sh ENOENT'",
    '  code: ENOENT',
    '  ...',
    'not ok 2 - block error',
    '  ---',
    '  error: |-',
    '    Expected values to be strictly equal:',
    '    + actual - expected',
    '  ...',
    'not ok 3 - no error line',
    'ok 4 - fine',
    'not ok 5 - another spawn',
    '  ---',
    "  error: 'spawn sh ENOENT'",
    '  ...',
  ].join('\r\n');
  assert.deepEqual([...readReasons(tap)], [['quoted error', 'spawn sh ENOENT'], ['block error', 'Expected values to be strictly equal:'], ['another spawn', 'spawn sh ENOENT']]);
  // The repo, the home and any other user folder never reach the public log.
  const folders = { root: 'D:\\a\\yokoten', home: 'C:\\Users\\sample' };
  for (const [raw, shown] of [
    ['ENOENT D:\\a\\yokoten\\test\\x.ts', 'ENOENT .\\test\\x.ts'],
    ['open D:/a/yokoten/x', 'open ./x'],
    ['cannot read C:\\Users\\sample\\AppData\\x', 'cannot read ~\\AppData\\x'],
    ['cannot read C:\\Users\\other\\x', 'cannot read C:\\Users\\~\\x'],
    ['cannot read /home/other/x', 'cannot read ~/x'],
    ['no folder named here', 'no folder named here'],
  ]) assert.equal(maskReason(raw, folders), shown, raw);
  assert.equal(maskReason('x'.repeat(300), folders).length, 200);
  // The out file puts each reason above its entry, as a comment the list reader skips.
  const text = knownText(['test/a.test.ts :: one', 'test/a.test.ts :: two'], new Map([['test/a.test.ts :: one', 'spawn sh ENOENT']]));
  assert.match(text, /# why: spawn sh ENOENT\ntest\/a\.test\.ts :: one\ntest\/a\.test\.ts :: two\n$/);
  assert.deepEqual(readKnown(text).required, ['test/a.test.ts :: one', 'test/a.test.ts :: two']);
  // Counts group a cause across tests: numbers and quoted parts do not split it.
  assert.deepEqual(reasonCounts(["spawn sh ENOENT", "spawn sh ENOENT", "timed out after 120 ms", "timed out after 300 ms", "got 'a'"]), ['   2  spawn sh ENOENT', '   2  timed out after N ms', "   1  got …"]);
});

test('windows known: shards split the files by seconds, longest first, and each judges only its own', () => {
  const files = [['a', 90], ['b', 50], ['c', 40], ['d', 30], ['e', 20], ['f', 10]].map(([name, weight]) => ({ name: `test/${name}.test.ts`, weight: Number(weight) }));
  const shards = [1, 2, 3].map((index) => shardOf(files, index, 3));
  assert.deepEqual(shards, [['test/a.test.ts'], ['test/b.test.ts', 'test/e.test.ts', 'test/f.test.ts'], ['test/c.test.ts', 'test/d.test.ts']]);
  // Every file runs once, in exactly one shard; one shard is the whole suite.
  assert.deepEqual(shards.flat().sort(), files.map((file) => file.name).sort());
  assert.deepEqual(shardOf(files, 1, 1), files.map((file) => file.name));
  assert.deepEqual(shardOf(files, 4, 3), []);
  // A shard's list holds only its files' entries, so an entry of another shard is not "fixed".
  const known = readKnown(['test/a.test.ts :: broken', 'test/c.test.ts :: broken', '? test/b.test.ts :: flaky'].join('\n'));
  assert.deepEqual(knownFor(known, ['test\\c.test.ts', 'test/d.test.ts']), { required: ['test/c.test.ts :: broken'], flaky: [] });
  assert.deepEqual(judgeKnown([], knownFor(known, shards[1])), { added: [], fixed: [] });
  // The times file gives each file its weight; a new file counts as the median, so it still runs.
  const times = readTimes(['# a comment', '240 test/setup/init.test.ts', '3 test/a.test.ts', '5 test/b.test.ts', 'not a line'].join('\r\n'));
  assert.deepEqual([...times], [['test/setup/init.test.ts', 240], ['test/a.test.ts', 3], ['test/b.test.ts', 5]]);
  assert.deepEqual(weightsOf(['test\\setup\\init.test.ts', 'test/new.test.ts'], times), [{ name: 'test\\setup\\init.test.ts', weight: 240 }, { name: 'test/new.test.ts', weight: 5 }]);
  assert.deepEqual(weightsOf(['test/a.test.ts'], new Map()), [{ name: 'test/a.test.ts', weight: 1 }]);
});

test('windows known: each file says ok, waived, NEW or FIXED, so a waiver reads apart from a new failure', () => {
  const known = readKnown(['test/a.test.ts :: old', 'test/a.test.ts :: gone', '? test/b.test.ts :: flaky', 'test/c.test.ts :: old'].join('\n'));
  for (const [file, found, line] of [
    ['test/d.test.ts', [], 'ok      test/d.test.ts (3 s)'],
    ['test/c.test.ts', ['test/c.test.ts :: old'], 'waived  test/c.test.ts (3 s, 1 waived)'],
    ['test/b.test.ts', ['test/b.test.ts :: flaky'], 'waived  test/b.test.ts (3 s, 1 waived)'],
    ['test/b.test.ts', [], 'ok      test/b.test.ts (3 s)'],
    ['test/a.test.ts', ['test/a.test.ts :: old'], 'FIXED   test/a.test.ts (3 s, 1 on the list passes now, 1 waived)'],
    ['test\\c.test.ts', ['test/c.test.ts :: old', 'test/c.test.ts :: brand new'], 'NEW     test/c.test.ts (3 s, 1 new: brand new, 1 waived)'],
  ] as const) assert.equal(fileLine(file, [...found], known, 3), line, line);
});

test('windows known: the log shows progress, then the verdict first, with passed files folded in Actions (#1119)', () => {
  assert.equal(progressLine('test\\setup\\init.test.ts', 54, 62, 480), '[54/62] test/setup/init.test.ts (cap 480 s)');
  assert.equal(slowLine('test/setup/init.test.ts', 120, 480), 'still running test/setup/init.test.ts: 120 s / 480 s');
  const times = [{ name: 'a', seconds: 3 }, { name: 'c', seconds: 90 }, { name: 'b', seconds: 90 }, { name: 'd', seconds: 1 }];
  assert.deepEqual(slowestFiles(times, 3), [{ name: 'b', seconds: 90 }, { name: 'c', seconds: 90 }, { name: 'a', seconds: 3 }]);
  const verdict = ['windows-known: win32, shard 1/1, 3 files, 1 failing (0 waived), 1 new, 0 fixed, 0 flaky, 0 skipped.'];
  const fileLines = ['ok      test/a.test.ts (3 s)', 'NEW     test/b.test.ts (4 s, 1 new: x)', 'ok      test/c.test.ts (1 s)'];
  const details = ['Nothing is skipped on win32.'];
  for (const [isActions, expected] of [
    [false, [...verdict, fileLines[1], ...details, fileLines[0], fileLines[2]]],
    [true, [...verdict, fileLines[1], ...details, '::group::passed files (2)', fileLines[0], fileLines[2], '::endgroup::']],
  ] as const) {
    const lines = reportLines(verdict, details, fileLines, isActions);
    assert.deepEqual(lines, expected);
    assert.ok(lines[0].startsWith('windows-known:'), 'the verdict is the first line');
  }
  assert.equal(summaryTable({ added: 1, fixed: 0, waived: 5 }, [{ name: 'test/a.test.ts', seconds: 90 }]), '### Windows known failures\n\n| | Count |\n|---|---|\n| New failures | 1 |\n| Fixed (remove from the list) | 0 |\n| Waived | 5 |\n\n| Slowest files | Seconds |\n|---|---|\n| test/a.test.ts | 90 |\n');
  assert.ok(!summaryTable({ added: 0, fixed: 0, waived: 0 }, []).includes('Slowest'));
});

test('windows scope: native Windows skips the desk, its fence and the kanban server, each with its reason (#1068)', () => {
  const files = testFiles();
  const windows = scopeFor(files, 'win32');
  const skippedAreas = new Set(windows.skipped.map((entry) => entry.area));
  assert.deepEqual([...skippedAreas].sort(), ['desk', 'desk fence', 'kanban server']);
  for (const entry of windows.skipped) assert.equal(entry.reason, 'the desk runs in WSL on Windows (record 0043)', entry.file);
  assert.ok(windows.skipped.some((entry) => entry.file === 'test/agents/desk/fence/bwrap.test.ts' && entry.area === 'desk fence'), 'the fence is its own area');
  assert.ok(windows.skipped.some((entry) => entry.file === 'test/commands/kanban/server.test.ts'));
  // The desk command's tests run git and shell filters in the fence: the desk area, not a skip inside a test (#1056).
  assert.ok(windows.skipped.some((entry) => entry.file === 'test/commands/desk/finish.test.ts' && entry.area === 'desk'), 'test/commands/desk/ is in the desk area');
  // The CLI, the guard hooks and install still run there.
  for (const kept of ['test/commands/more/check.test.ts', 'test/rules/guards/bash/read/run.test.ts', 'test/setup/install.test.ts', 'test/host/github/server.test.ts']) {
    assert.ok(windows.run.some((file) => file.replace(/\\/g, '/') === kept), kept);
  }
  assert.equal(windows.run.length + windows.skipped.length, files.length, 'every file either runs or is skipped with a reason');
  assert.match(skippedLines(windows.skipped).join('\n'), /^desk fence \(\d+ files\): the desk runs in WSL on Windows/m);
  // Linux and macOS run every file.
  for (const platform of ['linux', 'darwin'] as const) assert.deepEqual(scopeFor(files, platform).skipped, [], platform);
  // Fail closed: an unknown system is refused, and so is a table path that names no test file.
  assert.throws(() => platformOf('aix'), /no test scope for the system "aix"/);
  assert.throws(() => scopeFor(files, 'win32', [...TEST_AREAS, { area: 'gone', paths: ['test/gone/'], skip: { win32: 'x' } }]), /gone: test\/gone\//);
  // No waiver stays on the list for a file that does not run on Windows.
  const known = readKnown(readFileSync(join(ROOT, 'scripts/time/windows-known.txt'), 'utf8'));
  assert.deepEqual(staleKnown(known, windows.skipped.map((entry) => entry.file)), []);
  // Positive control: such a waiver is caught.
  assert.deepEqual(staleKnown(readKnown('test/agents/desk/desk.test.ts :: planDesk\ntest/a.test.ts :: b\n'), ['test\\agents\\desk\\desk.test.ts']), ['test/agents/desk/desk.test.ts :: planDesk']);
});

test('windows known: a crashed file runs once more; a second run that gets through is flaky, and both keep stderr (#1068)', async () => {
  const file = 'test\\a\\crash.test.ts';
  const crash: FileRun = { tap: 'TAP version 13\n# boom on stderr\n# Subtest: test\\a\\crash.test.ts\nnot ok 1 - test\\a\\crash.test.ts\n  ---\n  error: \'test failed\'\n  ...\n# tests 1\n# fail 1\n', stderr: 'Error: at D:\\a\\yokoten\\x.ts\n', code: 1, timedOut: false };
  const pass: FileRun = { tap: 'TAP version 13\nok 1 - fine\n', stderr: '', code: 0, timedOut: false };
  const fail: FileRun = { tap: 'TAP version 13\nnot ok 1 - a real failure\n', stderr: '', code: 1, timedOut: false };
  // A crash is the file named as its own failure, or a non-zero exit with no test line at all.
  assert.equal(isCrash(file, crash), true);
  assert.equal(isCrash(file, { tap: '', stderr: 'node: bad option', code: 9, timedOut: false }), true);
  assert.equal(isCrash(file, pass), false);
  assert.equal(isCrash(file, fail), false, 'a failing test is not a crash');
  assert.equal(isCrash(file, { ...crash, timedOut: true }), false, 'a time-out is not run again');
  assert.deepEqual(entriesOf(file, crash.tap, false), [`test/a/crash.test.ts :: ${CRASHED}`]);
  // Node's TAP on Windows escapes each backslash in the file's name (CI, 2026-10-26).
  const escaped: FileRun = { ...crash, tap: crash.tap.replaceAll('test\\a\\crash', 'test\\\\a\\\\crash') };
  assert.equal(isCrash(file, escaped), true, 'a crash named with escaped backslashes is a crash');
  assert.deepEqual(entriesOf(file, escaped.tap, false), [`test/a/crash.test.ts :: ${CRASHED}`]);
  const runs = (...answers: FileRun[]) => {
    const calls: string[] = [];
    return { calls, run: async (path: string) => (calls.push(path), answers[calls.length - 1]) };
  };
  const flaky = runs(crash, pass);
  const once = await runWithRetry(file, flaky.run);
  assert.deepEqual([flaky.calls.length, once.isFlaky, once.first, once.last], [2, true, crash, pass]);
  const twice = runs(crash, crash);
  const again = await runWithRetry(file, twice.run);
  assert.deepEqual([twice.calls.length, again.isFlaky, entriesOf(file, again.last.tap, false)], [2, false, [`test/a/crash.test.ts :: ${CRASHED}`]]);
  // Positive control: a plain failure runs once and is judged as it is.
  const plain = runs(fail);
  assert.deepEqual([(await runWithRetry(file, plain.run)).first, plain.calls.length], [undefined, 1]);
  // The crash's words reach the log, folders hidden; the TAP totals do not.
  const said = crashLines(crash, { root: 'D:\\a\\yokoten', home: 'C:\\Users\\sample' });
  assert.deepEqual(said, ['      | boom on stderr', '      | Error: at .\\x.ts']);
  assert.deepEqual(crashLines({ ...pass, tap: '' }, { root: '/r', home: '/h' }), ['      | (no stderr and no output)']);
});

test('windows known: --list shows the skipped areas with their reasons, then the files (#1068)', () => {
  const windows = scopeFor(testFiles(), 'win32');
  const text = listLines('win32', '1/1', windows.run, windows.skipped).join('\n');
  assert.match(text, /^Skipped on win32, by area:$/m);
  for (const area of ['desk', 'desk fence', 'kanban server']) assert.match(text, new RegExp(`^  ${area} \\(\\d+ files?\\): the desk runs in WSL on Windows`, 'm'));
  assert.match(text, /^ {2}skip {2}test\/agents\/desk\/start\.test\.ts \(desk\)$/m);
  assert.match(text, /^ {2}run {3}test\/commands\/more\/check\.test\.ts$/m);
  assert.doesNotMatch(text, /^ {2}run {3}test\/agents\/desk\//m);
  assert.deepEqual(listLines('linux', '1/1', [], []).slice(1), ['Nothing is skipped on linux.']);
});

test('the release workflow publishes the tarball as a file, not a GitHub repo name', () => {
  // `npm publish package/x.tgz` reads `package/x.tgz` as a GitHub `user/repo` and clones it:
  // the v0.1.0 publish failed so. A path starting with `./` is a file.
  const workflow = readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8');
  const publish = workflow.split('\n').filter((line) => /\bnpm publish\b/.test(line) && !line.trim().startsWith('#'));
  assert.ok(publish.length > 0, 'the release workflow runs npm publish');
  for (const line of publish) assert.match(line, /npm publish \.\//, line.trim());
});

// A test that names the current version breaks at every release bump (10-25: three update
// tests said 0.1.0 and failed a release pull request). Read VERSION from src/setup/files.ts.
/** The lines of `text` that name `version` as it is, or escaped for a regular expression. */
function versionLines(text: string, version: string): number[] {
  const dotted = version.replaceAll('.', '\\.');
  const escaped = version.replaceAll('.', '\\\\\\.');
  const named = new RegExp(`(^|[^0-9.])(${dotted}|${escaped})($|[^0-9])`);
  return text.split('\n').flatMap((line, index) => (named.test(line) ? [index + 1] : []));
}

test('tests: none names the current version; they read VERSION, so a release needs no test edits', () => {
  assert.deepEqual(versionLines("assert.match(out, /yokoten 1\\.2\\.3's/);\nconst x = 'yokoten 1.2.3';\nconst y = '1.2.30';", '1.2.3'), [1, 2], 'a written version, plain or escaped, was not caught');
  const found: string[] = [];
  for (const path of filesUnder(join(ROOT, 'test')).filter((file) => file.endsWith('.ts'))) {
    for (const line of versionLines(readFileSync(join(ROOT, 'test', path), 'utf8'), VERSION)) found.push(`test/${path}:${line}`);
  }
  assert.deepEqual(found, [], `use VERSION from src/setup/files.ts instead of ${VERSION} at: ${found.join(', ')}`);
});
