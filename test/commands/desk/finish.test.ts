// Tests for src/commands/desk/finish.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeSandbox, makeTempDir, runChild } from '../../repo/helpers.ts';
import { runWith } from '../../../src/commands/desk/clone.ts';
import { commitsSince, deskGitProblem, dirtyFiles, endingOf, endingScreen, type Evidence, moveAside, openPullRequest, testCommand } from '../../../src/commands/desk/finish.ts';
import type { DeskRecord } from '../../../src/commands/desk/list.ts';

const evidence = (over: Partial<Evidence> = {}): Evidence => ({ check: 'pass', test: 'pass', tail: { check: [], test: [] }, commits: ['abc1234 fix: say hello'], dirty: 0, unpushed: true, head: 'f'.repeat(40), ...over });
const record: DeskRecord = { name: '14', task: { kind: 'issue', number: 14, title: 'fix the greeting' }, agent: 'claude-code', branch: 'desk/14', base: 'abc', pid: 1, startedAt: '', activeAt: '', state: 'kept' };

test('desk finish: three endings: failed, unpushed work, clean (#1054)', () => {
  assert.equal(endingOf(evidence({ test: 'fail' })), 'failed');
  assert.equal(endingOf(evidence({ check: 'fail', unpushed: false, commits: [] })), 'failed');
  assert.equal(endingOf(evidence()), 'unpushed');
  assert.equal(endingOf(evidence({ commits: [], dirty: 2 })), 'unpushed');
  assert.equal(endingOf(evidence({ unpushed: false })), 'clean');
  assert.equal(endingOf(evidence({ commits: [] })), 'clean');
});

test('desk finish: each ending is one screen of at most 80 columns, with its one next step (#1054)', () => {
  const long = `FAIL ${'x'.repeat(200)}`;
  const screens = {
    failed: endingScreen('14', 'failed', evidence({ test: 'fail', tail: { check: [], test: ['not ok 3 - greets', long] } }), '../repo-desks/14'),
    unpushed: endingScreen('14', 'unpushed', evidence({ test: 'none' }), '../repo-desks/14'),
    clean: endingScreen('14', 'clean', evidence({ unpushed: false }), '../repo-desks/14'),
  };
  assert.equal(screens.failed[0], 'yokoten desk · desk 14 failed its checks');
  assert.match(screens.failed.join('\n'), /MISSING +tests +failed\n +not ok 3 - greets\n +FAIL x+…\n/);
  assert.equal(screens.failed.at(-1), 'Next: `yokoten desk 14`');
  assert.equal(screens.unpushed[0], 'yokoten desk · desk 14 has work that is not pushed');
  assert.match(screens.unpushed.join('\n'), /skipped +tests +none here/);
  assert.match(screens.unpushed.join('\n'), /next +work +1 commit, last: fix: say hello; not pushed/);
  assert.equal(screens.unpushed.at(-1), 'Next: `yokoten desk 14 --pr`');
  assert.equal(screens.clean[0], 'yokoten desk · desk 14 is clean: nothing left to push');
  assert.doesNotMatch(screens.clean.join('\n'), /kept/);
  assert.equal(screens.clean.at(-1), 'Next: `yokoten desk`');
  for (const screen of Object.values(screens)) {
    assert.ok(screen.length <= 24, 'one screen');
    for (const line of screen) assert.ok(line.length <= 80, line);
  }
});

test('desk finish: reading the desk outside the fence runs no fsmonitor program it names (#1054)', () => {
  const sandbox = makeSandbox();
  sandbox.git('commit', '-q', '--allow-empty', '-m', 'start');
  const marker = join(sandbox.home, 'ran');
  const program = join(sandbox.home, 'monitor.sh');
  writeFileSync(program, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  sandbox.git('config', 'core.fsmonitor', program);
  sandbox.write('new.txt', 'x');
  assert.deepEqual(dirtyFiles(runWith(sandbox.env), sandbox.repo), ['?? new.txt']);
  assert.ok(!existsSync(marker), 'dirtyFiles ran the fsmonitor program');
  // The positive control: a plain git status runs it.
  sandbox.git('status', '--porcelain');
  assert.ok(existsSync(marker), 'plain git status did not run it; the control is broken');
});

test('desk finish: git never runs outside the fence in a desk whose .git points at another config (#1054)', () => {
  const sandbox = makeSandbox();
  sandbox.git('commit', '-q', '--allow-empty', '-m', 'start');
  const base = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  const marker = join(sandbox.home, 'ran-outside-fence');
  const program = join(sandbox.home, 'filter.sh');
  writeFileSync(program, `#!/bin/sh\ntouch '${marker}'\ncat\n`, { mode: 0o755 });
  // What the AI can write: .git/config stays locked, so it plants a second repo and points commondir at it.
  const git = join(sandbox.repo, '.git');
  const evil = join(sandbox.home, 'evil');
  runChild('git', ['init', '-q', '--bare', evil], { env: sandbox.env });
  writeFileSync(join(evil, 'config'), `[core]\n\trepositoryformatversion = 0\n\tbare = false\n[filter "x"]\n\tclean = ${program}\n`);
  writeFileSync(join(git, 'commondir'), `${evil}\n`);
  sandbox.write('.gitattributes', '* filter=x\n');
  sandbox.write('f.txt', 'x');
  assert.match(deskGitProblem(sandbox.repo) ?? '', /commondir is there/);
  const run = runWith(sandbox.env);
  assert.match(JSON.stringify(dirtyFiles(run, sandbox.repo)), /git does not run in this desk outside the fence: .*commondir is there/);
  assert.deepEqual(commitsSince(run, sandbox.repo, base), []);
  assert.ok('problem' in moveAside(run, join(sandbox.repo, '..'), 'repo', new Date('2026-10-26T12:00:00Z')), 'a refused desk is not bundled or moved');
  const pull = openPullRequest({ run, root: sandbox.repo, desk: sandbox.repo, record, bot: null, evidence: evidence() });
  assert.match(JSON.stringify(pull), /git does not run in this desk outside the fence/);
  assert.ok(!existsSync(marker), 'a desk git read ran the planted filter');
  // A .git that is a file (a linked worktree) is refused too.
  const linked = join(makeTempDir(), 'linked');
  mkdirSync(linked);
  writeFileSync(join(linked, '.git'), `gitdir: ${git}\n`);
  assert.match(deskGitProblem(linked) ?? '', /is not a real folder/);
  // The positive control: the plant is live, so a plain git run outside the fence runs the filter as the person (a spare index keeps the desk's).
  runChild('git', ['-c', 'core.fsmonitor=false', 'add', 'f.txt'], { cwd: sandbox.repo, env: { ...sandbox.env, GIT_INDEX_FILE: join(sandbox.home, 'spare-index') } });
  assert.ok(existsSync(marker), 'plain git add did not run the filter; the control is broken');
  // With commondir gone, deskGit reads the desk again, from its own .git only.
  rmSync(join(git, 'commondir'));
  rmSync(marker);
  assert.equal(deskGitProblem(sandbox.repo), null);
  // gitdir and config.worktree are refused the same way.
  for (const part of ['gitdir', 'config.worktree']) {
    writeFileSync(join(git, part), 'x');
    assert.match(deskGitProblem(sandbox.repo) ?? '', new RegExp(`${part.replace('.', '\\.')} is there`));
    rmSync(join(git, part));
  }
  assert.deepEqual(dirtyFiles(run, sandbox.repo), ['?? .gitattributes', '?? f.txt']);
  assert.ok(!existsSync(marker));
});

test('desk finish: the test command is the project\'s own, or none (#1054)', () => {
  const desk = makeTempDir();
  assert.equal(testCommand(desk), null);
  writeFileSync(join(desk, 'package.json'), JSON.stringify({ scripts: { build: 'tsc' } }));
  assert.equal(testCommand(desk), null);
  writeFileSync(join(desk, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  assert.deepEqual(testCommand(desk), ['npm', 'test']);
});

test('desk finish: a clean desk is bundled, then moved aside with an index; a failed bundle moves nothing (#1054)', () => {
  const sandbox = makeSandbox();
  sandbox.git('commit', '-q', '--allow-empty', '-m', 'start');
  const home = join(makeTempDir(), 'repo-desks');
  mkdirSync(home);
  const desk = join(home, '14');
  runChild('git', ['clone', '-q', sandbox.repo, desk], { env: sandbox.env });
  mkdirSync(`${desk}.state`);
  writeFileSync(join(home, '14.json'), '{}');
  writeFileSync(join(home, '14.brief.md'), 'brief');
  const now = new Date('2026-10-26T12:00:00Z');
  // The positive control first: no bundle, so nothing moves.
  const failed = moveAside(() => ({ status: 128, stdout: '', stderr: 'fatal: no space\n' }), home, '14', now);
  assert.deepEqual(failed, { problem: 'the desk was kept: its bundle could not be made (fatal: no space)' });
  assert.ok(existsSync(desk));
  const moved = moveAside(runWith(sandbox.env), home, '14', now);
  const trash = join(home, 'trash', '2026-10-26');
  assert.deepEqual(moved, { to: join(trash, '14') });
  for (const gone of [desk, `${desk}.state`, join(home, '14.json'), join(home, '14.brief.md')]) assert.ok(!existsSync(gone), gone);
  for (const kept of ['14.bundle', '14', '14.state', '14.json', '14.brief.md', 'index.json']) assert.ok(existsSync(join(trash, kept)), kept);
  assert.match(runChild('git', ['bundle', 'list-heads', join(trash, '14.bundle')], { env: sandbox.env }).stdout, /refs\/heads\/main/);
  const index = JSON.parse(readFileSync(join(trash, 'index.json'), 'utf8')) as { reason: string; moved: { from: string }[] }[];
  assert.equal(index[0]?.reason, 'desk finished clean');
  assert.equal(index[0]?.moved[0]?.from, desk);
});

test('desk finish: --pr pushes from the project\'s checkout, as the bot when it is set up (#1054)', () => {
  const calls: { line: string; cwd: string }[] = [];
  const run = (file: string, args: string[], cwd: string) => {
    calls.push({ line: [file, ...args].join(' '), cwd });
    return { status: 0, stdout: file === 'gh' || args.includes('gh') ? 'https://github.com/octo/demo/pull/57\n' : '', stderr: '' };
  };
  // A real desk folder: openPullRequest refuses one whose .git is not a plain folder.
  const desk = join(makeTempDir(), '14');
  runChild('git', ['init', '-q', desk]);
  const done = openPullRequest({ run, root: '/repo', desk, record, bot: ['node', 'yokoten.ts', 'bot', '--'], evidence: evidence() });
  assert.deepEqual(done, { url: 'https://github.com/octo/demo/pull/57' });
  assert.deepEqual(calls.map((call) => call.cwd), ['/repo', '/repo', '/repo']);
  assert.equal(calls[0]?.line, `git fetch -q ${desk} desk/14`);
  assert.equal(calls[1]?.line, `node yokoten.ts bot -- git push -q origin ${'f'.repeat(40)}:refs/heads/desk/14`);
  assert.match(calls[2]?.line ?? '', /^node yokoten\.ts bot -- gh pr create --head desk\/14 --title fix the greeting --body Closes #14\n\nMade in a yokoten desk by claude-code\. Check: passed; tests: passed\.\n\n- abc1234 fix: say hello$/);
  // Without a bot, the person's own login; a failed push opens nothing.
  calls.length = 0;
  const refused = openPullRequest({ run: (file, args, cwd) => (args[0] === 'push' ? { status: 1, stdout: '', stderr: 'denied\n' } : run(file, args, cwd)), root: '/repo', desk, record, bot: null, evidence: evidence() });
  assert.deepEqual(refused, { problem: 'git push failed: denied' });
  assert.ok(!calls.some((call) => call.line.startsWith('gh')));
});
