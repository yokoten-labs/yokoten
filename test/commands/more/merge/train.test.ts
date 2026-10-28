// Tests for src/commands/more/merge/train.ts.

import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { linesAfter, npmTestSpawn, planLines, type PullRequest, resumeCommand, runQueue, stepRow, type TrainApi, type TrainStep, verifyInWorktree } from '../../../../src/commands/more/merge/train.ts';
import type { Change, ConflictMap } from '../../../../src/commands/more/merge/conflicts/types.ts';
import { screenProblems } from '../../../repo/docs/screen-rules.ts';
import { CLI, makeSandbox } from '../../../repo/helpers.ts';

/** A pull request the fake host holds. Its branches live in the sandbox repo. */
interface FakePull {
  number: number;
  baseBranch: string;
  headBranch: string;
  approved: boolean;
  checks: PullRequest['checks'];
  merged: boolean;
  draft: boolean;
}

/** The sandbox, by the type makeSandbox returns. */
type Sandbox = ReturnType<typeof makeSandbox>;

const headOf = (sandbox: Sandbox, name: string) => sandbox.git('rev-parse', `refs/heads/${name}`).stdout.trim();

/** Write `text` at `path` and commit it; the commit's id. */
function commit(sandbox: Sandbox, path: string, text: string, message: string): string {
  sandbox.write(path, text);
  sandbox.git('add', '-A');
  sandbox.git('commit', '-q', '-m', message);
  return sandbox.git('rev-parse', 'HEAD').stdout.trim();
}

/**
 * The host and its branches, on this machine: the pull request's branches are local, a
 * push moves the head branch, and a merge is the squash GitHub would make. `pushes` holds
 * the merge commits the train pushed, and `merges` the pull requests it merged.
 */
function fakeApi(sandbox: Sandbox, pulls: FakePull[], verify: (commit: string) => Promise<string | null>) {
  const byNumber = new Map(pulls.map((pull) => [pull.number, pull]));
  const pushes: string[] = [];
  const merges: number[] = [];
  const read = async (number: number): Promise<PullRequest | string> => {
    const pull = byNumber.get(number);
    if (!pull) return `pull request ${number} is not on this host`;
    const base = headOf(sandbox, pull.baseBranch);
    const head = headOf(sandbox, pull.headBranch);
    if (!base || !head) return `pull request ${number} lost a branch`;
    return {
      number,
      baseBranch: pull.baseBranch,
      baseOid: base,
      headBranch: pull.headBranch,
      headOid: head,
      approved: pull.approved,
      checks: pull.checks,
      merged: pull.merged,
      draft: pull.draft,
    };
  };
  const prepare = async () => null;
  const push = async (state: PullRequest, commitId: string) => {
    sandbox.git('update-ref', `refs/heads/${state.headBranch}`, commitId);
    pushes.push(commitId);
    return null;
  };
  const waitForChecks = async () => null;
  const squashMerge = async (state: PullRequest) => {
    const pull = byNumber.get(state.number);
    if (!pull) return `pull request ${state.number} is not on this host`;
    const base = headOf(sandbox, pull.baseBranch);
    const tree = sandbox.git('rev-parse', `${headOf(sandbox, pull.headBranch)}^{tree}`).stdout.trim();
    const squash = sandbox.git('commit-tree', tree, '-p', base, '-m', `squash ${pull.number}`).stdout.trim();
    sandbox.git('update-ref', `refs/heads/${pull.baseBranch}`, squash);
    sandbox.git('update-ref', '-d', `refs/heads/${pull.headBranch}`);
    pull.merged = true;
    merges.push(pull.number);
    // GitHub retargets a stacked pull request to the branch its base landed on.
    for (const other of pulls) if (other.baseBranch === pull.headBranch) other.baseBranch = pull.baseBranch;
    return null;
  };
  const api: TrainApi = { read, prepare, push, waitForChecks, squashMerge, verify };
  return { api, pushes, merges };
}

test('train: a stacked pull request merges clean after its base is squash-merged (#320)', async () => {
  const sandbox = makeSandbox();
  const original = commit(sandbox, 'f.txt', 'a\nb\n', 'base');
  sandbox.git('switch', '-q', '-c', 'feature-base');
  const baseTip = commit(sandbox, 'f.txt', 'A\nb\n', 'the base changes the line');
  sandbox.git('switch', '-q', '-c', 'stacked');
  commit(sandbox, 'f.txt', 'AA\nb\n', 'the stacked pull request changes the same line');
  sandbox.git('switch', '-q', 'main');
  // What a squash of feature-base onto main looks like: the same change, one new commit.
  sandbox.git('switch', '-q', '-c', 'squashed-simulation', 'main');
  sandbox.git('merge', '--squash', '-q', 'feature-base');
  sandbox.git('commit', '-q', '-m', 'squash feature-base');
  const squashed = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  sandbox.git('switch', '-q', 'main');
  // The positive control: git's own default base conflicts, the shared base does not.
  assert.equal(sandbox.git('merge-tree', '--write-tree', '--no-messages', squashed, 'stacked').status, 1);
  assert.equal(sandbox.git('merge-tree', '--write-tree', '--no-messages', `--merge-base=${baseTip}`, squashed, 'stacked').status, 0);
  assert.equal(sandbox.git('rev-parse', `refs/heads/main`).stdout.trim(), original);

  const pulls: FakePull[] = [
    { number: 20, baseBranch: 'main', headBranch: 'feature-base', approved: true, checks: 'green', merged: false, draft: false },
    { number: 21, baseBranch: 'feature-base', headBranch: 'stacked', approved: true, checks: 'green', merged: false, draft: false },
  ];
  const fake = fakeApi(sandbox, pulls, async () => null);
  const result = await runQueue({ root: sandbox.repo, env: sandbox.env, prs: [20, 21], api: fake.api, say: () => {} });

  assert.equal(result.stopped, null);
  assert.deepEqual(result.merged, [20, 21]);
  assert.deepEqual(fake.merges, [20, 21]);
  // The merged tree holds the stacked change once, not the base's block twice.
  assert.equal(sandbox.git('show', 'main:f.txt').stdout, 'AA\nb\n');
  // The merge the train pushed is the bot's, in UTC.
  assert.equal(fake.pushes.length, 1);
  const author = sandbox.git('show', '-s', '--format=%an|%ae|%cd', '--date=format:%z', fake.pushes[0]).stdout.trim();
  assert.equal(author, 'yokoten-bot|yokoten-bot@users.noreply.github.com|+0000');
});

test('train: an import-only conflict takes the union, and a real conflict stops the train (#320)', async () => {
  const sandbox = makeSandbox();
  commit(sandbox, 'test/shared.test.ts', "import { a } from './helpers.ts';\n\nexport const first = a;\n", 'shared test');
  sandbox.git('switch', '-q', '-c', 'add-b');
  commit(sandbox, 'test/shared.test.ts', "import { a, b } from './helpers.ts';\n\nexport const first = a;\n", 'adds b');
  sandbox.git('switch', '-q', 'main');
  sandbox.git('switch', '-q', '-c', 'add-c');
  commit(sandbox, 'test/shared.test.ts', "import { a, c } from './helpers.ts';\n\nexport const first = a;\n", 'adds c');
  sandbox.git('switch', '-q', 'main');

  const pulls: FakePull[] = [
    { number: 30, baseBranch: 'main', headBranch: 'add-b', approved: true, checks: 'green', merged: false, draft: false },
    { number: 31, baseBranch: 'main', headBranch: 'add-c', approved: true, checks: 'green', merged: false, draft: false },
  ];
  const fake = fakeApi(sandbox, pulls, async () => null);
  const result = await runQueue({ root: sandbox.repo, env: sandbox.env, prs: [30, 31], api: fake.api, say: () => {} });

  assert.equal(result.stopped, null);
  assert.deepEqual(result.merged, [30, 31]);
  assert.match(sandbox.git('show', 'main:test/shared.test.ts').stdout, /^import \{ a, b, c \} from '\.\/helpers\.ts';$/m);
  assert.equal(fake.pushes.length, 1, 'the union was pushed for CI');

  // A conflict on a line that is not an import is a decision for a person.
  const other = makeSandbox();
  commit(other, 'src/x.ts', 'export const x = 1;\n', 'x is one');
  other.git('switch', '-q', '-c', 'set-two');
  commit(other, 'src/x.ts', 'export const x = 2;\n', 'x is two');
  other.git('switch', '-q', 'main');
  other.git('switch', '-q', '-c', 'set-three');
  commit(other, 'src/x.ts', 'export const x = 3;\n', 'x is three');
  other.git('switch', '-q', 'main');
  const conflictPulls: FakePull[] = [
    { number: 40, baseBranch: 'main', headBranch: 'set-two', approved: true, checks: 'green', merged: false, draft: false },
    { number: 41, baseBranch: 'main', headBranch: 'set-three', approved: true, checks: 'green', merged: false, draft: false },
  ];
  const conflict = fakeApi(other, conflictPulls, async () => null);
  const stopped = await runQueue({ root: other.repo, env: other.env, prs: [40, 41], api: conflict.api, say: () => {} });

  assert.deepEqual(stopped.merged, [40]);
  assert.equal(stopped.stopped?.number, 41);
  assert.match(stopped.stopped?.why ?? '', /real conflict in src\/x\.ts/);
  assert.equal(conflict.merges.includes(41), false);
  assert.equal(other.git('show', 'main:src/x.ts').stdout, 'export const x = 2;\n');
});

test('train: a failing test stops it before the merge is pushed (#320)', async () => {
  const sandbox = makeSandbox();
  commit(sandbox, 'ok.txt', 'ok\n', 'the tree');
  sandbox.git('switch', '-q', '-c', 'good');
  commit(sandbox, 'good.txt', 'good\n', 'a good change');
  sandbox.git('switch', '-q', 'main');
  sandbox.git('switch', '-q', '-c', 'bad');
  commit(sandbox, 'bad.txt', 'bad\n', 'a breaking change');
  sandbox.git('switch', '-q', 'main');

  const pulls: FakePull[] = [
    { number: 50, baseBranch: 'main', headBranch: 'good', approved: true, checks: 'green', merged: false, draft: false },
    { number: 51, baseBranch: 'main', headBranch: 'bad', approved: true, checks: 'green', merged: false, draft: false },
  ];
  // The project's test fails on any tree that holds bad.txt, as a real suite would.
  const fake = fakeApi(sandbox, pulls, async (commitId) => (sandbox.git('show', `${commitId}:bad.txt`).status === 0 ? "the project's tests fail: 1 test failed" : null));
  const result = await runQueue({ root: sandbox.repo, env: sandbox.env, prs: [50, 51], api: fake.api, say: () => {} });

  assert.deepEqual(result.merged, [50]);
  assert.equal(result.stopped?.number, 51);
  assert.match(result.stopped?.why ?? '', /tests fail/);
  assert.equal(fake.merges.includes(51), false);
  assert.equal(fake.pushes.length, 0, 'a broken merge is never pushed');
  assert.equal(sandbox.git('show', 'main:bad.txt').status === 0, false);
});

test('train: a missing approval stops it before anything merges (#320)', async () => {
  const sandbox = makeSandbox();
  commit(sandbox, 'a.txt', 'a\n', 'the tree');
  sandbox.git('switch', '-q', '-c', 'waiting');
  commit(sandbox, 'b.txt', 'b\n', 'the change');
  sandbox.git('switch', '-q', 'main');
  const pulls: FakePull[] = [{ number: 60, baseBranch: 'main', headBranch: 'waiting', approved: false, checks: 'green', merged: false, draft: false }];
  const fake = fakeApi(sandbox, pulls, async () => null);
  const result = await runQueue({ root: sandbox.repo, env: sandbox.env, prs: [60], api: fake.api, say: () => {} });

  assert.deepEqual(result.merged, []);
  assert.equal(result.stopped?.number, 60);
  assert.match(result.stopped?.why ?? '', /approving review/);
  assert.deepEqual(fake.merges, []);
});

test('train: only the lead runs it; a worker is refused before any read (#320)', async () => {
  const sandbox = makeSandbox();
  const result = await sandbox.call(['train', '1'], { extra: { YOKOTEN_ROLE: 'worker' } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /only the lead runs the train/);
});

test('train: verify runs the project script and check in a worktree (#320)', () => {
  const sandbox = makeSandbox();
  sandbox.write('package.json', JSON.stringify({ scripts: { test: 'false' } }));
  const failing = commit(sandbox, 'a.txt', 'a\n', 'tests fail');
  const why = verifyInWorktree({ root: sandbox.repo, commit: failing, env: sandbox.env, script: CLI, cwd: sandbox.repo, platform: process.platform });
  assert.match(why ?? '', /tests fail/);

  sandbox.write('package.json', JSON.stringify({ scripts: { test: 'true' } }));
  const passing = commit(sandbox, 'a.txt', 'b\n', 'tests pass');
  assert.equal(verifyInWorktree({ root: sandbox.repo, commit: passing, env: sandbox.env, script: CLI, cwd: sandbox.repo, platform: process.platform }), null);
});

/** Whether Node refuses this spawn on Windows (EINVAL since 18.20.2 and 20.12.2): a .cmd or .bat file with no shell. */
const isRefusedOnWindows = (spawn: { command: string; options: object }): boolean => /\.(cmd|bat)$/i.test(spawn.command) && !('shell' in spawn.options && spawn.options.shell);

test('train: on Windows npm test runs through cmd.exe, never npm.cmd alone (#985)', () => {
  // Positive control: the old spawn, npm.cmd with no shell, is the shape Node refuses.
  assert.equal(isRefusedOnWindows({ command: 'npm.cmd', options: {} }), true);
  const windows = npmTestSpawn('win32');
  assert.equal(isRefusedOnWindows(windows), false);
  assert.equal(windows.command, 'cmd.exe');
  // Fixed text only: no folder or other value goes on the command line.
  assert.deepEqual(windows.args, ['/d', '/s', '/c', 'npm test']);
  assert.equal(windows.options.windowsVerbatimArguments, true);
  assert.deepEqual(npmTestSpawn('linux'), { command: 'npm', args: ['test'], options: {} });
});

/** A map of open pull requests, by number, with the collisions given. */
function planMap(numbers: number[], collisions: [number, number][] = []): ConflictMap {
  const changes: Change[] = numbers.map((number) => ({ id: `pr:${number}`, label: `PR #${number}`, branch: `b${number}`, head: '0'.repeat(8), draft: false, files: [`src/${number}.ts`], moves: [], mainConflicts: [] }));
  return { version: 1, builtAt: new Date().toISOString(), main: '0'.repeat(8), changes, collisions: collisions.map(([first, second]) => ({ first: `pr:${first}`, second: `pr:${second}`, files: ['src/app.ts'] })), leased: {}, hot: [] };
}

test('train: the bare plan is rows, the order as a field, and the command that merges them last (#1115)', () => {
  const lines = planLines(planMap([12, 15, 20]));
  assert.deepEqual(lines, [
    'yokoten train · the plan for 3 pull requests; nothing merged',
    '',
    '  next        PR #12: it collides with no other open change',
    '  to do       PR #15: it collides with no other open change',
    '  to do       PR #20: it collides with no other open change',
    '',
    '  Order       #12 → #15 → #20',
    '',
    'Next: `yokoten train 12 15 20`',
  ]);
  assert.deepEqual(screenProblems({ text: lines.join('\n') }), []);
  const long = planLines(planMap(Array.from({ length: 12 }, (_, index) => index + 1)));
  assert.ok(long.includes('4 more pull requests, in the order below'), long.join('\n'));
  assert.equal(long.at(-1), 'Next: `yokoten train 1 2 3 4 5 6 7 8`', 'the command merges the rows shown');
  assert.deepEqual(screenProblems({ text: long.join('\n') }), []);
});

test('train: each step is a row under the title, and a wrapped one is spaced from its neighbours (#1115)', () => {
  const steps: TrainStep[] = [
    { number: 20, mark: 'ok', text: 'approved and green on 0123456789ab' },
    { number: 20, mark: 'done', text: 'took the union of the import lines in src/commands/more/merge/train.ts, src/commands/shared.ts' },
    { number: 20, mark: 'done', text: 'squash-merged' },
  ];
  assert.deepEqual(stepRow(steps[0]), ['  ok          #20         approved and green on 0123456789ab']);
  let shown = ['yokoten train · merging 1 pull request in this order: #20'];
  const printed = [...shown];
  for (const step of steps) {
    printed.push(...linesAfter(shown, stepRow(step)));
    shown = stepRow(step);
  }
  printed.push(...linesAfter(shown, ['merged 1 of 1 pull request'], true));
  assert.deepEqual(printed.filter((line) => line === '').length, 4, 'a blank under the title, around the wrapped row, and before the total');
  assert.deepEqual(screenProblems({ text: printed.join('\n') }), []);
  assert.deepEqual(linesAfter([], ['a']), ['a'], 'the first block is shown as it is');
});

test('train: a stop says where to go on from (#1115)', () => {
  assert.equal(resumeCommand([40, 41, 42], 41), 'yokoten train 41 42');
  assert.equal(resumeCommand([40], 99), 'yokoten train 40', 'an unknown number goes on from the start');
});
