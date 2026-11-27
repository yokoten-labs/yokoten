// Tests for src/setup/init.ts: the git hook init writes, and how it keeps the hooks a clone already has.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { at, CLI, makeSandbox, rowsText, runChild, shareGuardMeasure, shareSelfTest, stepMark } from '../../repo/helpers.ts';
import { changeText, checkLines, handOffLines, HOOKS_PATH, placeHandOff } from '../../../src/setup/init.ts';
import { initIn, has, noted, said, leadsWithHookOn } from './helpers.ts';

shareGuardMeasure();
shareSelfTest();

// A clone's own hooks in .git/hooks (lefthook, the pre-commit framework, a hand-written
// one) must not be switched off when init points git at .githooks (#256).
const NO_EXEC_BIT = process.platform === 'win32' && 'Windows has no execute bit';

const SHELLS = ['sh', 'dash'].filter((shell) => spawnSync(shell, ['-c', 'true']).status === 0);

test("init: husky keeps its hooks folder; .husky/pre-commit gets the check and keeps its own lines (#206)", async () => {
  const sandbox = makeSandbox();
  sandbox.write('.husky/pre-commit', '#!/bin/sh\ntouch own-hook-ran\n');
  chmodSync(join(sandbox.repo, '.husky/pre-commit'), 0o755);
  sandbox.git('config', 'core.hooksPath', '.husky');
  const result = initIn(sandbox);
  assert.ok(result.ok, said(result));
  assert.ok(has(result, 'updated', /^\.husky\/pre-commit: the commit check \(kept core\.hooksPath \(husky\).*\(added the check\)$/));
  assert.ok(has(result, 'wrote', /^\.husky\/pre-merge-commit: the commit check \(kept core\.hooksPath \(husky\)/), 'a merge commit is checked too (#239)');
  assert.equal(readFileSync(join(sandbox.repo, '.husky/pre-merge-commit'), 'utf8'), `#!/bin/sh\n${checkLines('.yokoten/bin/yokoten.ts').join('\n')}\n`);
  assert.ok(statSync(join(sandbox.repo, '.husky/pre-merge-commit')).mode & 0o100, 'executable');
  assert.doesNotMatch(said(result), /git hook: on/);
  assert.match(changeText(result.changes[0]!), /^updated \.husky\/pre-commit: .*\(added the check\)$/, 'the commit check leads (#654)');
  assert.equal(sandbox.git('config', 'core.hooksPath').stdout.trim(), '.husky', 'the project\'s hooks folder stays');
  assert.ok(!existsSync(join(sandbox.repo, '.githooks')), 'no second hooks folder that git never runs');
  const hook = readFileSync(join(sandbox.repo, '.husky/pre-commit'), 'utf8');
  assert.equal(hook, `#!/bin/sh\n${checkLines('.yokoten/bin/yokoten.ts').join('\n')}\ntouch own-hook-ran\n`);
  assert.match(hook, /\n\[ -f "\.yokoten\/bin\/yokoten\.ts" \] 2>\/dev\/null \|\| \{ echo [^\n]* >&2; exit 1; \}; node "\.yokoten\/bin\/yokoten\.ts" check --staged \|\| exit 1\n/);
  assert.equal(await stepMark(sandbox, 'commit-check'), 'done');
  // One real commit runs both: the yokoten check, then the project's own hook. A second
  // init keeping a hook that runs yokoten is in the next test; a hook without the runtime
  // is in test/run/cli.test.ts.
  sandbox.git('add', '.');
  const commit = sandbox.git('commit', '-qm', 'adopt yokoten');
  assert.equal(commit.status, 0, commit.stderr);
  assert.match(commit.stderr, /yokoten check --staged · clean/, 'the check ran');
  assert.ok(existsSync(join(sandbox.repo, 'own-hook-ran')), 'the project\'s own hook still runs');
  sandbox.write('leak.md', `me${at}gmail.com\n`);
  sandbox.git('add', 'leak.md');
  assert.notEqual(sandbox.git('commit', '-qm', 'leak').status, 0, 'the check in .husky/pre-commit refuses a leak');
});

test('init: husky not yet installed in this clone; init leaves core.hooksPath unset and says to run npm install (#206)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('.husky/pre-commit', 'npm test\n');
  const result = initIn(sandbox);
  assert.ok(result.ok, said(result));
  assert.ok(has(result, 'updated', /^\.husky\/pre-commit.*\(added the check\)$/));
  assert.equal(noted(result, /^husky is not set up in this clone yet/)?.fix, 'npm install');
  assert.equal(sandbox.git('config', 'core.hooksPath').stdout.trim(), '');
  assert.match(readFileSync(join(sandbox.repo, '.husky/pre-commit'), 'utf8'), /^# yokoten: [^\n]*\n\[ -f [^\n]*; node [^\n]*\nnpm test\n$/);
  // A hook that init changed before the runtime guard (#204) already runs the check.
  const before = '# yokoten: the commit check\nnode ".yokoten/bin/yokoten.ts" check --staged || exit 1\nnpm test\n';
  sandbox.write('.husky/pre-commit', before);
  assert.ok(has(initIn(sandbox), 'kept', /^\.husky\/pre-commit/));
  assert.equal(readFileSync(join(sandbox.repo, '.husky/pre-commit'), 'utf8'), before);
  assert.notEqual(await stepMark(sandbox, 'commit-check'), 'done', 'git runs no hook yet');
  assert.match(rowsText((await sandbox.call(['doctor', '--all'])).stdout), /run `npm install` so husky sets core\.hooksPath/);
  sandbox.git('config', 'core.hooksPath', '.husky/_');
  assert.equal(await stepMark(sandbox, 'commit-check'), 'done', "husky 9's folder runs .husky/pre-commit");
});

// git runs pre-merge-commit, not pre-commit, for a merge it commits itself (#239).
test('init: a merge commit runs the commit check too (#239)', async () => {
  const sandbox = makeSandbox();
  let result = initIn(sandbox);
  assert.ok(result.ok, said(result));
  assert.ok(has(result, 'wrote', /^\.githooks\/pre-merge-commit/));
  const mergeHook = join(sandbox.repo, '.githooks', 'pre-merge-commit');
  const hook = readFileSync(mergeHook, 'utf8');
  assert.equal(hook, readFileSync(join(sandbox.repo, '.githooks', 'pre-commit'), 'utf8'), 'the same check as pre-commit');
  assert.ok(statSync(mergeHook).mode & 0o100, 'executable');
  assert.equal(await stepMark(sandbox, 'commit-check'), 'done');
  // Again: nothing changes.
  result = initIn(sandbox);
  assert.ok(has(result, 'kept', /^\.githooks\/pre-merge-commit/));
  assert.equal(readFileSync(mergeHook, 'utf8'), hook);
  sandbox.git('add', '.');
  assert.equal(sandbox.git('commit', '-qm', 'adopt yokoten').status, 0);
  sandbox.git('checkout', '-qb', 'topic');
  sandbox.write('topic.md', 'fine\n');
  sandbox.git('add', 'topic.md');
  assert.equal(sandbox.git('commit', '-qm', 'topic').status, 0);
  sandbox.git('checkout', '-q', 'main');
  const merge = (zone: string) => spawnSync('git', ['merge', '--no-ff', '-q', '-m', 'merge topic', 'topic'], { cwd: sandbox.repo, env: { ...sandbox.env, TZ: zone }, encoding: 'utf8' });
  // A merge with the author's time zone is refused, and the zone is never printed.
  // A POSIX zone: Git for Windows reads `Asia/Tokyo` as UTC.
  const zoned = merge('JST-9');
  assert.notEqual(zoned.status, 0, 'the merge commit is checked');
  assert.match(zoned.stderr, /carries your time zone/);
  assert.doesNotMatch(zoned.stderr, /\+0900/);
  assert.equal(sandbox.git('rev-list', '--count', '--merges', 'HEAD').stdout.trim(), '0');
  sandbox.git('merge', '--abort');
  const plain = merge('UTC');
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(sandbox.git('rev-list', '--count', '--merges', 'HEAD').stdout.trim(), '1');
  // Doctor names a missing pre-merge-commit, and init writes it back.
  rmSync(mergeHook);
  assert.notEqual(await stepMark(sandbox, 'commit-check'), 'done');
  const doctor = rowsText((await sandbox.call(['doctor', '--all'])).stdout);
  // Ordinary commits are still checked; only merge commits are not.
  assert.match(doctor, /merge commits are not checked: there is no \.githooks\/pre-merge-commit/);
  assert.doesNotMatch(doctor, /(?<!merge )commits are not checked/);
  assert.doesNotMatch(doctor, /\.githooks\/pre-commit/);
  assert.match(doctor, /`yokoten init` sets up \.githooks\/pre-merge-commit/);
  // A pre-merge-commit of the project's own keeps its lines and gets the check.
  writeFileSync(mergeHook, '#!/bin/sh\necho own\n');
  result = initIn(sandbox);
  assert.ok(has(result, 'updated', /^\.githooks\/pre-merge-commit.*\(added the check\)$/));
  assert.equal(readFileSync(mergeHook, 'utf8'), `#!/bin/sh\n${checkLines('.yokoten/bin/yokoten.ts').join('\n')}\necho own\n`);
  assert.equal(await stepMark(sandbox, 'commit-check'), 'done');
});

test('init: a core.hooksPath outside the repo is kept, and the advice is the line init would write (#204)', async () => {
  const sandbox = makeSandbox();
  sandbox.git('config', 'core.hooksPath', join(sandbox.home, 'hooks'));
  const result = initIn(sandbox);
  assert.ok(result.ok, said(result));
  const [, checkLine] = checkLines('.yokoten/bin/yokoten.ts');
  assert.ok(!result.changes.some((change) => change.path === HOOKS_PATH), 'core.hooksPath is kept');
  assert.equal(noted(result, /^core\.hooksPath is outside this repo/)?.what, `core.hooksPath is outside this repo, so yokoten did not change it; add this line to its pre-commit and pre-merge-commit by hand: ${checkLine}`);
});

test("init: another core.hooksPath is kept, and its pre-commit is made with the check (#206)", async () => {
  const sandbox = makeSandbox();
  sandbox.write('tools/hooks/commit-msg', '#!/bin/sh\n');
  sandbox.git('config', 'core.hooksPath', 'tools/hooks');
  const doctor = rowsText((await sandbox.call(['doctor', '--all'])).stdout);
  assert.match(doctor, /commit-check \(OSPS-BR-07\.01\): commits are not checked: there is no tools\/hooks\/pre-commit; there is no tools\/hooks\/pre-merge-commit/);
  // The advice shows the line init writes, runtime guard included (#204). A new file needs
  // a `#!` line and the execute bit, or git skips it (#239).
  const [, checkLine] = checkLines('.yokoten/bin/yokoten.ts');
  assert.ok(doctor.includes(`or do it yourself: make tools/hooks/pre-commit and tools/hooks/pre-merge-commit with \`#!/bin/sh\` as the first line and the line below after it; run \`chmod +x tools/hooks/pre-commit tools/hooks/pre-merge-commit\`. The line: ${checkLine}`), doctor);
  const result = initIn(sandbox);
  assert.ok(result.ok, said(result));
  assert.ok(has(result, 'wrote', /^tools\/hooks\/pre-commit: the commit check \(kept core\.hooksPath \(tools\/hooks\)/));
  assert.ok(has(result, 'wrote', /^tools\/hooks\/pre-merge-commit: the commit check \(kept core\.hooksPath \(tools\/hooks\)/));
  assert.equal(sandbox.git('config', 'core.hooksPath').stdout.trim(), 'tools/hooks');
  for (const hook of ['pre-commit', 'pre-merge-commit']) {
    const path = join(sandbox.repo, 'tools/hooks', hook);
    assert.equal(readFileSync(path, 'utf8'), `#!/bin/sh\n${checkLines('.yokoten/bin/yokoten.ts').join('\n')}\n`, hook);
    assert.ok(statSync(path).mode & 0o100, `${hook} is executable`);
  }
  assert.equal(await stepMark(sandbox, 'commit-check'), 'done');
  sandbox.git('add', '.');
  assert.equal(sandbox.git('commit', '-qm', 'adopt yokoten').status, 0);
  sandbox.write('leak.md', `me${at}gmail.com\n`);
  sandbox.git('add', 'leak.md');
  assert.notEqual(sandbox.git('commit', '-qm', 'leak').status, 0, 'the check runs from the project\'s folder');
  // tools/hooks/pre-merge-commit is the same file as pre-commit (checked above); a real
  // merge through that file is in the merge commit test above (#239).
});

test('init: a pre-commit in .git/hooks keeps running, after the check, from .githooks (#256)', { skip: NO_EXEC_BIT }, async () => {
  const sandbox = makeSandbox();
  const gitDir = join(sandbox.repo, '.git');
  // The old hooks leave a mark in .git, and the pre-commit fails while .git/block-me is there.
  writeFileSync(join(gitDir, 'hooks', 'pre-commit'), '#!/bin/sh\ndir="$(git rev-parse --git-dir)"\ntouch "$dir/old-hook-ran"\n[ ! -f "$dir/block-me" ]\n', { mode: 0o755 });
  writeFileSync(join(gitDir, 'hooks', 'pre-merge-commit'), '#!/bin/sh\ntouch "$(git rev-parse --git-dir)/old-merge-hook-ran"\n', { mode: 0o755 });
  sandbox.write('lefthook.yml', 'pre-commit:\n  commands:\n    lint:\n      run: echo lint\n');
  let result = initIn(sandbox);
  assert.ok(result.ok, said(result));
  assert.ok(has(result, 'kept', /^your \.git\/hooks\/pre-commit: \.githooks\/pre-commit runs it after the check$/));
  assert.ok(has(result, 'kept', /^your \.git\/hooks\/pre-merge-commit: \.githooks\/pre-merge-commit runs it after the check$/));
  assert.ok(noted(result, /^lefthook\.yml is here; \.githooks runs these hooks in \.git\/hooks: \.git\/hooks\/pre-commit \(after the check\), \.git\/hooks\/pre-merge-commit \(after the check\)\. /), said(result));
  assert.ok(leadsWithHookOn(result), said(result));
  assert.equal(sandbox.git('config', 'core.hooksPath').stdout.trim(), '.githooks');
  assert.ok(existsSync(join(gitDir, 'hooks', 'pre-commit')), 'the old hook stays where it was');
  assert.equal(await stepMark(sandbox, 'commit-check'), 'done');
  // A real commit runs the check, then the old hook.
  sandbox.git('add', '.');
  let commit = sandbox.git('commit', '-qm', 'adopt yokoten');
  assert.equal(commit.status, 0, commit.stderr);
  assert.ok(existsSync(join(gitDir, 'old-hook-ran')), 'the old pre-commit ran');
  // The old hook's failure stops the commit.
  writeFileSync(join(gitDir, 'block-me'), '');
  sandbox.write('a.md', 'fine\n');
  sandbox.git('add', 'a.md');
  assert.notEqual(sandbox.git('commit', '-qm', 'blocked').status, 0, 'the old hook can still refuse a commit');
  rmSync(join(gitDir, 'block-me'));
  // The check comes first: when it refuses, the old hook does not run.
  rmSync(join(gitDir, 'old-hook-ran'));
  sandbox.write('leak.md', `me${at}gmail.com\n`);
  sandbox.git('add', 'leak.md');
  commit = sandbox.git('commit', '-qm', 'leak');
  assert.notEqual(commit.status, 0, 'the check runs');
  assert.ok(!existsSync(join(gitDir, 'old-hook-ran')), 'the check runs before the old hook');
  sandbox.git('rm', '-q', '--cached', 'leak.md');
  rmSync(join(sandbox.repo, 'leak.md'));
  assert.equal(sandbox.git('commit', '-qm', 'a').status, 0);
  // .githooks/pre-merge-commit runs the old one the same way: the sh and dash part of the
  // next test runs it, with its arguments and stdin.
  // A clone that ran an older init: .githooks/pre-commit without the hand-off drops the old hook, and doctor says so.
  const kitHook = readFileSync(join(CLI, '..', '..', 'kit', 'project', '.githooks', 'pre-commit'), 'utf8').replaceAll('{{cli}}', '.yokoten/bin/yokoten.ts');
  writeFileSync(join(sandbox.repo, '.githooks', 'pre-commit'), kitHook);
  assert.notEqual(await stepMark(sandbox, 'commit-check'), 'done', 'the old pre-commit would be dropped');
  const doctor = rowsText((await sandbox.call(['doctor', '--all'])).stdout);
  assert.match(doctor, /commit-check \(OSPS-BR-07\.01\): a hook this clone had is switched off: \.git\/hooks\/pre-commit no longer runs: \.githooks\/pre-commit does not run it; `yokoten init` makes \.githooks\/pre-commit run \.git\/hooks\/pre-commit after the check/);
  result = initIn(sandbox);
  assert.ok(has(result, 'updated', /^\.githooks\/pre-commit$/));
  assert.equal(await stepMark(sandbox, 'commit-check'), 'done');
  const hook = readFileSync(join(sandbox.repo, '.githooks', 'pre-commit'), 'utf8');
  assert.match(hook, /^node "\.yokoten\/bin\/yokoten\.ts" check --staged \|\| exit 1\n# yokoten: then the pre-commit/m, 'the kit\'s `exec` goes, so the hand-off runs after the check');
  rmSync(join(gitDir, 'old-hook-ran'));
  sandbox.write('b.md', 'fine\n');
  sandbox.git('add', 'b.md');
  assert.equal(sandbox.git('commit', '-qm', 'b').status, 0);
  assert.ok(existsSync(join(gitDir, 'old-hook-ran')), 'the old pre-commit runs again');
});

test('init: a pre-commit in .git/hooks that git skips does not hold the check back; init says how to keep it (#256)', { skip: NO_EXEC_BIT }, async () => {
  const sandbox = makeSandbox();
  writeFileSync(join(sandbox.repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o644 });
  chmodSync(join(sandbox.repo, '.git', 'hooks', 'pre-commit'), 0o644);
  const note = '.git/hooks/pre-commit is not executable, so git skips it today; `chmod +x .git/hooks/pre-commit` and run `yokoten init` again to keep it running';
  const doctor = rowsText((await sandbox.call(['doctor', '--all'])).stdout);
  assert.ok(doctor.includes(`commit-check (OSPS-BR-07.01): commits are not checked: core.hooksPath is not set; \`yokoten init\` sets it up; note: ${note}\n`), doctor);
  const result = initIn(sandbox);
  assert.ok(result.ok, said(result));
  assert.ok(leadsWithHookOn(result), said(result));
  assert.deepEqual(result.notes.filter((each) => each.id === 'git-hooks').map((each) => each.what), [note]);
  assert.doesNotMatch(said(result), /kept your/);
  assert.equal(sandbox.git('config', 'core.hooksPath').stdout.trim(), '.githooks');
  assert.equal(await stepMark(sandbox, 'commit-check'), 'done', 'a hook git skipped is not dropped');
  // Made executable, the next init hands off to it.
  chmodSync(join(sandbox.repo, '.git', 'hooks', 'pre-commit'), 0o755);
  assert.notEqual(await stepMark(sandbox, 'commit-check'), 'done', 'now it would be dropped');
  assert.ok(has(initIn(sandbox), 'kept', /^your \.git\/hooks\/pre-commit: \.githooks\/pre-commit runs it after the check$/));
  assert.equal(await stepMark(sandbox, 'commit-check'), 'done');
});

test('init: every other hook in .git/hooks keeps running from .githooks, with its arguments and stdin (#256)', { skip: NO_EXEC_BIT }, async () => {
  const sandbox = makeSandbox();
  const hooks = join(sandbox.repo, '.git', 'hooks');
  // Each old hook leaves a mark in .git with its arguments.
  const marker = (name: string) => `#!/bin/sh\necho "$*" > "$(git rev-parse --git-common-dir)/${name}-ran"\n`;
  writeFileSync(join(hooks, 'commit-msg'), marker('commit-msg'), { mode: 0o755 });
  writeFileSync(join(hooks, 'post-commit'), marker('post-commit'), { mode: 0o755 });
  // pre-push and pre-merge-commit save their arguments and stdin, and fail with their own code.
  const saver = (name: string, code: number) => `#!/bin/sh\nprintf "%s|" "$@" > "$(git rev-parse --git-common-dir)/${name}-args"; cat > "$(git rev-parse --git-common-dir)/${name}-ran"; exit ${code}\n`;
  writeFileSync(join(hooks, 'pre-push'), saver('pre-push', 4), { mode: 0o755 });
  writeFileSync(join(hooks, 'pre-merge-commit'), saver('pre-merge-commit', 5), { mode: 0o755 });
  writeFileSync(join(hooks, 'post-checkout'), marker('post-checkout'), { mode: 0o644 });
  chmodSync(join(hooks, 'post-checkout'), 0o644);
  writeFileSync(join(hooks, 'pre-commit.old'), marker('old'), { mode: 0o755 });
  // A hook of the project's own in .githooks gets the hand-off after its `#!` line.
  sandbox.write('.githooks/prepare-commit-msg', '#!/bin/sh\necho own >> "$1"\n');
  chmodSync(join(sandbox.repo, '.githooks', 'prepare-commit-msg'), 0o755);
  writeFileSync(join(hooks, 'prepare-commit-msg'), marker('prepare-commit-msg'), { mode: 0o755 });
  sandbox.write('lefthook.yml', 'commit-msg:\n  commands:\n    lint:\n      run: echo lint\n');
  const result = initIn(sandbox);
  assert.ok(result.ok, said(result));
  for (const hook of ['commit-msg', 'post-commit', 'pre-push']) {
    assert.ok(has(result, 'wrote', new RegExp(`^\\.githooks/${hook}$`)), hook);
    assert.ok(has(result, 'kept', new RegExp(`^your \\.git/hooks/${hook}: \\.githooks/${hook} runs it$`)), hook);
  }
  assert.ok(has(result, 'updated', /^\.githooks\/prepare-commit-msg$/));
  assert.ok(has(result, 'kept', /^your \.git\/hooks\/pre-merge-commit: \.githooks\/pre-merge-commit runs it after the check$/));
  assert.ok(said(result).includes('\nlefthook.yml is here; .githooks runs these hooks in .git/hooks: .git/hooks/commit-msg, .git/hooks/post-commit, .git/hooks/pre-merge-commit (after the check), .git/hooks/pre-push, .git/hooks/prepare-commit-msg. A hook it installs later'), said(result));
  assert.ok(noted(result, /^\.git\/hooks\/post-checkout is not executable, so git skips it today/), said(result));
  assert.ok(!existsSync(join(sandbox.repo, '.githooks', 'post-checkout')), 'a hook git skips gets no .githooks file');
  assert.ok(!existsSync(join(sandbox.repo, '.githooks', 'pre-commit.old')), 'a file git never runs is not a hook');
  assert.equal(readFileSync(join(sandbox.repo, '.githooks', 'prepare-commit-msg'), 'utf8'), ['#!/bin/sh', ...handOffLines('prepare-commit-msg'), 'echo own >> "$1"', ''].join('\n'));
  assert.equal(sandbox.git('config', 'core.hooksPath').stdout.trim(), '.githooks');
  assert.equal(await stepMark(sandbox, 'commit-check'), 'done');
  // The hooks init writes run under sh and dash, with the arguments and stdin: a commit
  // hook after the check, and any other hook as it is.
  for (const shell of SHELLS) {
    for (const [hook, code] of [['pre-merge-commit', 5], ['pre-push', 4]] as const) {
      const run = spawnSync(shell, [`.githooks/${hook}`, 'a b', 'c'], { cwd: sandbox.repo, env: sandbox.env, input: 'line in\n', encoding: 'utf8' });
      assert.equal(run.status, code, `${shell} ${hook}: ${run.stderr}`);
      assert.equal(readFileSync(join(sandbox.repo, '.git', `${hook}-args`), 'utf8'), 'a b|c|', `${shell} ${hook}`);
      assert.equal(readFileSync(join(sandbox.repo, '.git', `${hook}-ran`), 'utf8'), 'line in\n', `${shell} ${hook}`);
    }
  }
  // A real commit runs them, with git's arguments.
  sandbox.git('add', '.');
  const commit = sandbox.git('commit', '-qm', 'adopt yokoten');
  assert.equal(commit.status, 0, commit.stderr);
  assert.equal(readFileSync(join(sandbox.repo, '.git', 'commit-msg-ran'), 'utf8'), '.git/COMMIT_EDITMSG\n');
  assert.ok(existsSync(join(sandbox.repo, '.git', 'post-commit-ran')));
  assert.match(readFileSync(join(sandbox.repo, '.git', 'prepare-commit-msg-ran'), 'utf8'), /COMMIT_EDITMSG message/);
  assert.match(sandbox.git('log', '-1', '--format=%B').stdout, /own/, 'the project\'s own lines still run');
  // pre-push gets git's stdin, and its failure stops the push.
  const remote = join(sandbox.home, 'remote.git');
  spawnSync('git', ['init', '-q', '--bare', remote], { env: sandbox.env });
  const push = sandbox.git('push', '-q', remote, 'main');
  assert.notEqual(push.status, 0, 'the old pre-push can still refuse a push');
  assert.match(readFileSync(join(sandbox.repo, '.git', 'pre-push-ran'), 'utf8'), /^refs\/heads\/main [0-9a-f]{40} refs\/heads\/main /);
  // A clone that ran an older init: no .githooks/commit-msg, so the old one is dropped, and doctor counts it.
  rmSync(join(sandbox.repo, '.githooks', 'commit-msg'));
  assert.notEqual(await stepMark(sandbox, 'commit-check'), 'done');
  const doctor = rowsText((await sandbox.call(['doctor', '--all'])).stdout);
  assert.match(doctor, /commit-check \(OSPS-BR-07\.01\): a hook this clone had is switched off: \.git\/hooks\/commit-msg no longer runs: \.githooks\/commit-msg does not run it; `yokoten init` makes \.githooks\/commit-msg run \.git\/hooks\/commit-msg\n/);
  assert.ok(has(initIn(sandbox), 'wrote', /^\.githooks\/commit-msg$/));
  assert.equal(await stepMark(sandbox, 'commit-check'), 'done');
});

test('init: an old hook that reads stdin, next to a .githooks one of the project\'s own, is left to the owner (#256)', { skip: NO_EXEC_BIT }, async () => {
  const sandbox = makeSandbox();
  writeFileSync(join(sandbox.repo, '.git', 'hooks', 'pre-push'), '#!/bin/sh\ncat >/dev/null\n', { mode: 0o755 });
  sandbox.write('.githooks/pre-push', '#!/bin/sh\nwhile read line; do echo "$line"; done\n');
  const before = readFileSync(join(sandbox.repo, '.githooks', 'pre-push'), 'utf8');
  const result = initIn(sandbox);
  assert.ok(result.ok, said(result));
  assert.match(noted(result, /^left core\.hooksPath unset/)?.what ?? '', /^left core\.hooksPath unset, so the commit check is not on yet: \.githooks\/pre-push is the project's own and reads stdin, as \.git\/hooks\/pre-push does, so yokoten can't run both from one file\. To keep \.git\/hooks\/pre-push, make \.githooks\/pre-push save stdin to a file and give it to both: its own lines, and \.git\/hooks\/pre-push with the same arguments; then run `git config core\.hooksPath \.githooks`$/m);
  assert.ok(!result.changes.some((change) => change.path === HOOKS_PATH), 'core.hooksPath stays unset');
  assert.doesNotMatch(said(result), /git hook: on/);
  assert.equal(readFileSync(join(sandbox.repo, '.githooks', 'pre-push'), 'utf8'), before);
  assert.equal(sandbox.git('config', 'core.hooksPath').stdout.trim(), '');
  assert.match(rowsText((await sandbox.call(['doctor', '--all'])).stdout), /commits are not checked: core\.hooksPath is not set; \.githooks\/pre-push is the project's own and reads stdin/);
});

test('init: the hand-off has no switch, and a .git/hooks link to .githooks does not loop (#256)', { skip: NO_EXEC_BIT }, async () => {
  const sandbox = makeSandbox();
  const gitDir = join(sandbox.repo, '.git');
  writeFileSync(join(gitDir, 'hooks', 'pre-commit'), '#!/bin/sh\necho x >> "$(git rev-parse --git-dir)/old-hook-ran"\n', { mode: 0o755 });
  assert.ok(initIn(sandbox).ok);
  sandbox.git('add', '.');
  const commit = (message: string, extra: Record<string, string> = {}) =>
    runChild('git', ['commit', '-qm', message], { cwd: sandbox.repo, env: { ...sandbox.env, ...extra } });
  let result = commit('adopt yokoten', { YOKOTEN_OLD_HOOK: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(gitDir, 'old-hook-ran'), 'utf8'), 'x\n', 'YOKOTEN_OLD_HOOK=1 does not skip the old hook');
  // .git/hooks/pre-commit as a link to .githooks/pre-commit: the hand-off sees it is the same file.
  rmSync(join(gitDir, 'hooks', 'pre-commit'));
  symlinkSync(join(sandbox.repo, '.githooks', 'pre-commit'), join(gitDir, 'hooks', 'pre-commit'));
  sandbox.write('a.md', 'fine\n');
  sandbox.git('add', 'a.md');
  result = commit('a');
  assert.equal(result.status, 0, `${result.stderr} ${result.error ?? ''}`);
  assert.equal((result.stderr.match(/yokoten check --staged · clean/g) ?? []).length, 1, 'the check ran once');
  // The same for the file run with sh, or dash, from a relative path.
  sandbox.write('b.md', 'fine\n');
  sandbox.git('add', 'b.md');
  for (const shell of SHELLS) {
    const run = runChild(shell, ['.git/hooks/pre-commit'], { cwd: sandbox.repo, env: sandbox.env });
    assert.equal(run.status, 0, `${shell}: ${run.stderr}`);
    assert.equal((`${run.stdout}${run.stderr}`.match(/yokoten check --staged · clean/g) ?? []).length, 1, `${shell}: the check ran once`);
  }
});

test('init: the hand-off goes only after a check at column 0, and the kit\'s exec line only when it is last (#256)', () => {
  const hook = 'pre-commit';
  // The reviewer's hook: the check sits in an `if`, and more lines follow.
  const nested = '#!/bin/sh\nif [ -n "$FAST" ]; then\n  exec node ".yokoten/bin/yokoten.ts" check --staged\nfi\nnpm run lint\n';
  assert.equal(placeHandOff(nested, hook), null);
  assert.equal(placeHandOff('#!/bin/sh\nexec node ".yokoten/bin/yokoten.ts" check --staged\nnpm run lint\n', hook), null, 'exec, then more lines');
  assert.equal(placeHandOff('#!/bin/sh\n  exec node ".yokoten/bin/yokoten.ts" check --staged\n', hook), null, 'exec, indented');
  assert.equal(placeHandOff('#!/bin/sh\ncheck() {\n  node ".yokoten/bin/yokoten.ts" check --staged || exit 1\n}\ncheck\n', hook), null, 'a check inside a function');
  assert.equal(placeHandOff('#!/bin/sh\nexec node  ".yokoten/bin/yokoten.ts"  check --staged\n\n', hook), ['#!/bin/sh', 'node  ".yokoten/bin/yokoten.ts"  check --staged || exit 1', ...handOffLines(hook), '', ''].join('\n'));
  assert.equal(placeHandOff('#!/bin/sh\nnode ".yokoten/bin/yokoten.ts" check --staged || exit 1\nnpm run lint\n', hook), ['#!/bin/sh', 'node ".yokoten/bin/yokoten.ts" check --staged || exit 1', ...handOffLines(hook), 'npm run lint', ''].join('\n'));
});

test('init: the reviewer\'s own hook with the check in an `if` is kept as it is, with the steps to do by hand (#256)', { skip: NO_EXEC_BIT }, async () => {
  const sandbox = makeSandbox();
  const own = '#!/bin/sh\nif [ -n "$FAST" ]; then\n  exec node ".yokoten/bin/yokoten.ts" check --staged\nfi\nnpm run lint\n';
  sandbox.write('.githooks/pre-commit', own);
  chmodSync(join(sandbox.repo, '.githooks', 'pre-commit'), 0o755);
  writeFileSync(join(sandbox.repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  sandbox.git('config', 'core.hooksPath', '.githooks');
  const result = initIn(sandbox);
  assert.ok(result.ok, said(result));
  assert.equal(readFileSync(join(sandbox.repo, '.githooks', 'pre-commit'), 'utf8'), own);
  assert.match(noted(result, /^a hook this clone had is switched off/)?.what ?? '', /^a hook this clone had is switched off: \.githooks\/pre-commit is the project's own, and yokoten can't tell where its check ends\. To keep \.git\/hooks\/pre-commit, add this line after the check: yokoten_old=/m);
  assert.ok(!result.changes.some((change) => change.path === HOOKS_PATH && change.state !== 'kept'), 'core.hooksPath is not set again');
  assert.doesNotMatch(said(result), /git hook: on/);
});

test('init: with a global core.hooksPath, the files in .git/hooks are dead and are not handed off to (#256)', { skip: NO_EXEC_BIT }, async () => {
  const sandbox = makeSandbox();
  const global = join(sandbox.home, 'global-hooks');
  mkdirSync(global);
  // Written with fs: the guard on a machine may stop `git config --global` in a shell.
  writeFileSync(sandbox.env.GIT_CONFIG_GLOBAL, `[core]\n\thooksPath = ${global}\n`);
  for (const hook of ['pre-commit', 'commit-msg']) writeFileSync(join(sandbox.repo, '.git', 'hooks', hook), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  // A clone an older init set up: core.hooksPath is .githooks here, and the global one decided before.
  sandbox.git('config', 'core.hooksPath', '.githooks');
  assert.ok(initIn(sandbox).ok);
  assert.equal(await stepMark(sandbox, 'commit-check'), 'done', 'a dead hook is not dropped');
  sandbox.git('config', '--unset', 'core.hooksPath');
  rmSync(join(sandbox.repo, '.githooks'), { recursive: true });
  const result = initIn(sandbox);
  assert.ok(result.ok, said(result));
  assert.doesNotMatch(said(result), /kept your|note:/);
  assert.ok(leadsWithHookOn(result), said(result));
  assert.doesNotMatch(readFileSync(join(sandbox.repo, '.githooks', 'pre-commit'), 'utf8'), /git-common-dir/);
  assert.ok(!existsSync(join(sandbox.repo, '.githooks', 'commit-msg')));
  sandbox.git('add', '.');
  const commit = sandbox.git('commit', '-qm', 'adopt yokoten');
  assert.equal(commit.status, 0, commit.stderr);
  assert.equal(await stepMark(sandbox, 'commit-check'), 'done');
});

// doctor's advice must be true: when it says init sets it up, init does (#256).
test('init: a .githooks/pre-commit of the project\'s own gets the check, and a kept one keeps its mode (#256)', { skip: NO_EXEC_BIT }, async () => {
  const sandbox = makeSandbox();
  sandbox.write('.githooks/pre-commit', '#!/bin/sh\necho own\n');
  chmodSync(join(sandbox.repo, '.githooks/pre-commit'), 0o700);
  sandbox.git('config', 'core.hooksPath', '.githooks');
  assert.match(rowsText((await sandbox.call(['doctor', '--all'])).stdout), /commits are not checked: \.githooks\/pre-commit does not run yokoten[^\n]*; `yokoten init` sets it up/);
  let result = initIn(sandbox);
  assert.ok(result.ok, said(result));
  assert.ok(has(result, 'updated', /^\.githooks\/pre-commit.*\(added the check\)$/));
  const path = join(sandbox.repo, '.githooks/pre-commit');
  const hook = readFileSync(path, 'utf8');
  assert.equal(hook, `#!/bin/sh\n${checkLines('.yokoten/bin/yokoten.ts').join('\n')}\necho own\n`);
  assert.equal(await stepMark(sandbox, 'commit-check'), 'done');
  const mode = statSync(path).mode & 0o777;
  // Again: the file is kept as it is, mode too.
  result = initIn(sandbox);
  assert.ok(has(result, 'kept', /^\.githooks\/pre-commit$/));
  assert.equal(readFileSync(path, 'utf8'), hook);
  assert.equal(statSync(path).mode & 0o777, mode, 'no chmod on a file init did not change');
});

test('init: a file under .husky/ keeps its mode; husky 9 runs it with sh (#256)', { skip: NO_EXEC_BIT }, async () => {
  const sandbox = makeSandbox();
  sandbox.write('.husky/pre-commit', 'npm test\n');
  sandbox.write('.husky/pre-merge-commit', 'npm test\n');
  for (const hook of ['pre-commit', 'pre-merge-commit']) chmodSync(join(sandbox.repo, '.husky', hook), 0o644);
  sandbox.write('.husky/_/h', '#!/bin/sh\n');
  sandbox.git('config', 'core.hooksPath', '.husky/_');
  const result = initIn(sandbox);
  assert.ok(result.ok, said(result));
  assert.ok(has(result, 'updated', /^\.husky\/pre-commit.*\(added the check\)$/));
  for (const hook of ['pre-commit', 'pre-merge-commit']) {
    assert.equal(statSync(join(sandbox.repo, '.husky', hook)).mode & 0o777, 0o644, `.husky/${hook} keeps its mode`);
  }
  assert.equal(await stepMark(sandbox, 'commit-check'), 'done', 'husky 9 needs no execute bit on .husky/pre-commit');
});
