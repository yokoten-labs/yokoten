// Tests for src/commands/desk/desk.ts. git is real; gh, the fence and the AI are stand-ins,
// and every program run is recorded, so a push shows.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Writable } from 'node:stream';
import { test } from 'node:test';
import { makeSandbox, runChild } from '../../repo/helpers.ts';
import { DESK_USE_WSL, type DeskDeps, runDesk, stoppedDesksScreen } from '../../../src/commands/desk/desk.ts';
import { runWith } from '../../../src/commands/desk/clone.ts';
import { readRecord, writeRecord } from '../../../src/commands/desk/list.ts';
import type { Look } from '../../../src/commands/desk/stall.ts';
import { isStalled } from '../../../src/commands/desk/stall.ts';
import type { Invocation } from '../../../src/commands/shared.ts';

type Agent = (desk: string, brief: string, world: { look: () => Look; tick: (minutes: number) => void }) => void;

/** A project with a remote, and a world where gh answers issue 14, `claude` is installed and the AI is `agent`. */
function makeWorld(agent: Agent, { check = 0, installed = true, alive = () => true }: { check?: number; installed?: boolean; alive?: (pid: number) => boolean } = {}) {
  const sandbox = makeSandbox();
  sandbox.git('commit', '-q', '--allow-empty', '-m', 'start');
  const remote = join(dirname(sandbox.repo), 'remote.git');
  runChild('git', ['init', '-q', '--bare', '-b', 'main', remote], { env: sandbox.env });
  sandbox.git('remote', 'add', 'origin', remote);
  sandbox.git('push', '-q', 'origin', 'main');
  sandbox.git('config', 'core.hooksPath', '.githooks');
  const calls: string[] = [];
  const real = runWith(sandbox.env);
  // Real time at the start: the stall is judged from the files' own times.
  let clock = Date.now();
  let look: Look | null = null;
  const world: DeskDeps = {
    run: (file, args, cwd, extra) => {
      calls.push([file, ...args].join(' '));
      if (file === 'gh' && args[0] === 'issue') return { status: 0, stdout: JSON.stringify({ number: 14, title: 'fix the greeting', body: 'Say hello, not hi.' }), stderr: '' };
      if (file === 'gh') return { status: 0, stdout: 'https://github.com/octo/demo/pull/57\n', stderr: '' };
      return real(file, args, cwd, extra);
    },
    fenced: async (desk, _, command, stdio) => {
      calls.push(`fenced ${command.slice(0, 3).join(' ')}`);
      if (stdio === 'inherit') {
        agent(desk, command[1] ?? '', { look: () => look as Look, tick: (minutes) => { clock += minutes * 60_000; } });
        return { status: 0, stdout: '', stderr: '' };
      }
      if (command[2] === 'check') return { status: check, stdout: check ? 'MISSING  a token in src/x.ts' : '', stderr: '' };
      const ran = spawnSync(command[0] ?? '', command.slice(1), { cwd: desk, env: sandbox.env, encoding: 'utf8' });
      return { status: ran.status ?? 1, stdout: ran.stdout, stderr: ran.stderr };
    },
    isInstalled: (program) => installed && program === 'claude',
    alive,
    now: () => new Date(clock),
    pid: 4242,
    bot: null,
    watch: (given) => {
      look = given;
      return () => {};
    },
  };
  const call = async (args: string[], platform: NodeJS.Platform = 'linux') => {
    const out: string[] = [];
    const err: string[] = [];
    const sink = (into: string[]) => new Writable({ write: (chunk, _, done) => { into.push(String(chunk)); done(); } });
    const invocation: Invocation = { command: 'desk', args, env: sandbox.env, cwd: sandbox.repo, stdout: sink(out), stderr: sink(err), stdin: { fd: null, text: '', stream: process.stdin }, script: 'yokoten.ts', platform };
    const status = await runDesk(invocation, world);
    return { status, stdout: out.join(''), stderr: err.join('') };
  };
  const home = join(dirname(sandbox.repo), 'repo-desks');
  const commit = (desk: string, file: string, message: string) => {
    writeFileSync(join(desk, file), `${message}\n`);
    runChild('git', ['add', file], { cwd: desk, env: sandbox.env });
    runChild('git', ['commit', '-q', '-m', message], { cwd: desk, env: sandbox.env });
  };
  return { sandbox, remote, calls, call, home, commit, world };
}

const snapshot = (folder: string) => readdirSync(folder, { recursive: true }).map(String).filter((path) => !path.includes('.git/')).sort();
const pushes = (calls: string[]) => calls.filter((line) => !line.startsWith('fenced ') && /\bpush\b/.test(line));
const widest = (text: string) => Math.max(...text.split('\n').map((line) => line.length));

test('desk: bare desk lists the desks and writes nothing (#1054)', async () => {
  const { sandbox, call, home } = makeWorld(() => {});
  const before = [sandbox.git('status', '--porcelain', '--ignored').stdout, snapshot(dirname(sandbox.repo))];
  const bare = await call([]);
  assert.equal(bare.status, 0);
  assert.match(bare.stdout, /^yokoten desk · no desks yet\n\nA desk gives one task to one AI, in its own fenced clone\.\n\nNext: `yokoten desk <issue>`\n$/);
  assert.deepEqual([sandbox.git('status', '--porcelain', '--ignored').stdout, snapshot(dirname(sandbox.repo))], before, 'bare desk writes nothing');
  assert.ok(!existsSync(home));
  // The positive control: the old form still runs, and names what is missing.
  const words = await sandbox.call(['desk', 'claude-code', sandbox.repo]);
  assert.equal(words.status, 1);
  assert.match(words.stderr, /name the agent, the folder and the command/);
});

test('desk --json: the desks as the screen is built from them, and nothing else on stdout (#1115)', async () => {
  const { call, home } = makeWorld(() => {});
  assert.deepEqual(JSON.parse((await call(['--json'])).stdout), { desks: [] });
  mkdirSync(home, { recursive: true });
  writeRecord(home, { name: '9', task: { kind: 'text', title: 'tidy up' }, agent: 'claude-code', branch: 'desk/9', base: 'abc', pid: 1, startedAt: '2026-10-26T10:00:00Z', activeAt: '2026-10-26T11:00:00Z', state: 'kept' });
  const listed = await call(['--json']);
  assert.equal(listed.status, 0);
  assert.deepEqual(JSON.parse(listed.stdout), { desks: [{ name: '9', task: { kind: 'text', title: 'tidy up' }, agent: 'claude-code', branch: 'desk/9', startedAt: '2026-10-26T10:00:00Z', activeAt: '2026-10-26T11:00:00Z', state: 'kept', commits: [] }] });
  const withTask = await call(['14', '--json']);
  assert.equal(withTask.status, 1, '--json goes with the list only');
  assert.equal(JSON.parse(withTask.stdout).ok, false);
});

test('desk <issue>: its own clone, a brief from the issue, the AI in the fence, never a push (#1054)', async () => {
  let seen = '';
  const { sandbox, remote, calls, call, home, commit } = makeWorld((desk, brief) => {
    seen = brief;
    commit(desk, 'hello.txt', 'fix: say hello');
  });
  const result = await call(['14']);
  const desk = join(home, '14');
  const git = (...args: string[]) => runChild('git', args, { cwd: desk, env: sandbox.env }).stdout.trim();
  assert.equal(git('branch', '--show-current'), 'desk/14');
  assert.equal(git('config', 'core.hooksPath'), '.githooks');
  assert.equal(git('remote', 'get-url', 'origin'), remote);
  assert.match(readFileSync(join(desk, '.git', 'info', 'exclude'), 'utf8'), /^\.yokoten-agent\.json$/m);
  assert.match(seen, /^Issue #14: fix the greeting\n\nSay hello, not hi\./);
  assert.match(seen, /Never push/);
  assert.equal(readFileSync(join(home, '14.brief.md'), 'utf8'), seen, 'the brief is kept next to the desk, outside it');
  assert.ok(calls.some((line) => line.startsWith('fenced claude Issue #14: fix the greeting')), 'the AI starts in the fence, with the brief');
  assert.deepEqual(pushes(calls), [], 'no push without --pr');
  assert.equal(runChild('git', ['ls-remote', remote, 'refs/heads/desk/14'], { env: sandbox.env }).stdout, '');
  // The unpushed-work ending, on one screen.
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^yokoten desk · desk 14 has work that is not pushed\n/);
  assert.match(result.stdout, /1 commit, last: fix: say hello; not pushed/);
  assert.match(result.stdout, /Next: `yokoten desk 14 --pr`\n$/);
  assert.ok(widest(result.stdout) <= 80);
  assert.equal(readRecord(home, '14')?.state, 'kept');
});

test('desk <issue>: no AI installed is one line, and nothing is written (#1054)', async () => {
  const { call, home, calls, world } = makeWorld(() => {}, { installed: false });
  const result = await call(['14']);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, 'yokoten desk · no AI to start: neither Claude Code nor Codex is installed\n\nNext: install Claude Code with `npm install -g @anthropic-ai/claude-code`, then\n      run this again.\n');
  assert.ok(!existsSync(home));
  assert.ok(!calls.some((line) => line.startsWith('git clone')));
  // The positive control: installed, the same call makes the desk.
  world.isInstalled = (program) => program === 'claude';
  assert.match((await call(['14'])).stdout, /^yokoten desk · desk 14 is clean: nothing left to push\n/);
  assert.ok(existsSync(join(home, 'trash')), 'the desk was made, then moved aside');
});

test('desk <issue> --pr: pushes from the project, opens the pull request, then the clean desk moves aside (#1054)', async () => {
  const { remote, calls, call, home, commit, sandbox } = makeWorld((desk) => commit(desk, 'hello.txt', 'fix: say hello'));
  await call(['14']);
  assert.deepEqual(pushes(calls), []);
  const result = await call(['14', '--pr']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls.filter((line) => line.startsWith('fenced claude')).length, 1, '--pr starts no AI');
  assert.equal(pushes(calls).length, 1);
  assert.match(pushes(calls)[0] ?? '', /^git push -q origin [0-9a-f]{40}:refs\/heads\/desk\/14$/);
  assert.match(runChild('git', ['ls-remote', remote, 'refs/heads/desk/14'], { env: sandbox.env }).stdout, /refs\/heads\/desk\/14/);
  assert.ok(calls.some((line) => line.startsWith('gh pr create --head desk/14 --title fix the greeting --body Closes #14')));
  assert.match(result.stdout, /^yokoten desk · desk 14 is clean: nothing left to push\n/);
  assert.match(result.stdout.replace(/\s+/g, ' '), /https:\/\/github\.com\/octo\/demo\/pull\/57 \(with your gh login\)/);
  assert.ok(widest(result.stdout) <= 80);
  assert.ok(!existsSync(join(home, '14')), 'the clean desk moved aside');
  const [day] = readdirSync(join(home, 'trash'));
  assert.ok(existsSync(join(home, 'trash', day ?? '', '14.bundle')));
  assert.ok(existsSync(join(home, 'trash', day ?? '', '14', '.git')));
});

test('desk <issue>: a failed check is the failed ending, and --pr then pushes nothing (#1054)', async () => {
  const { calls, call, commit } = makeWorld((desk) => commit(desk, 'hello.txt', 'fix: say hello'), { check: 1 });
  const result = await call(['14']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^yokoten desk · desk 14 failed its checks\n/);
  assert.match(result.stdout, /MISSING +check +failed\n +MISSING a token in src\/x\.ts\n/);
  assert.match(result.stdout, /Next: `yokoten desk 14`\n$/);
  const pr = await call(['14', '--pr']);
  assert.equal(pr.status, 1);
  assert.match(pr.stdout, /nothing was pushed: the checks failed/);
  assert.deepEqual(pushes(calls), []);
});

test('desk <issue>: a stall is marked and its work saved; the stop shows next time, and desk <n> goes on (#1056)', async () => {
  let isDead = false;
  let briefs: string[] = [];
  const { sandbox, call, home, commit, world } = makeWorld((desk, brief, { look, tick }) => {
    briefs.push(brief);
    if (briefs.length > 1) return commit(desk, 'done.txt', 'feat: finish the greeting');
    commit(desk, 'hello.txt', 'fix: say hello');
    writeFileSync(join(desk, 'half.txt'), 'half done\n');
    // Quiet for half an hour, alive: the watcher marks the stall.
    tick(30);
    const watcher = look();
    assert.ok(isStalled(watcher.activity(), watcher.now(), watcher.waiting(), 20));
    watcher.onChange('stalled', watcher.activity());
    // Then the session behind it ends: the desk's process is gone, mid-task.
    isDead = true;
    throw new Error('the session ended');
  }, { alive: () => !isDead });
  await assert.rejects(call(['14']), /the session ended/);
  const desk = join(home, '14');
  assert.equal(readRecord(home, '14')?.state, 'stalled');
  const log = runChild('git', ['log', '--format=%s', 'desk/14'], { cwd: desk, env: sandbox.env }).stdout;
  assert.match(log, /^chore\(desk\): save work in progress on #14\nfix: say hello\n/, 'the work is on its branch');
  // The next look sees it stopped, with what it did.
  const list = await call([]);
  assert.match(list.stdout, /^yokoten desk · 1 desk, 1 stopped mid-task\n/);
  assert.match(list.stdout.replace(/\s+/g, ' '), /note desk 14 stopped 30 min ago · claude-code · fix the greeting · 2 commits, last: [0-9a-f]+ chore\(desk\)/);
  assert.match(list.stdout, /Next: `yokoten desk 14`\n$/);
  // desk 14 goes on in the same clone, from its brief and what it did.
  world.pid = 4343;
  const resumed = await call(['14']);
  assert.equal(briefs.length, 2);
  assert.match(briefs[1] ?? '', /^Issue #14: fix the greeting\n/);
  assert.match(briefs[1] ?? '', /## Done so far \(you stopped; go on from here\)\n\n- [0-9a-f]+ chore\(desk\): save work in progress on #14\n- [0-9a-f]+ fix: say hello\n/);
  assert.match(resumed.stdout, /desk 14 has work that is not pushed/);
  assert.match(resumed.stdout, /3 commits, last: feat: finish the greeting/);
  briefs = [];
});

test('desk <issue>: a desk whose .git points at a planted config is refused; no git runs outside the fence (#1054)', async () => {
  let marker = '';
  const { sandbox, calls, call, home } = makeWorld((desk) => {
    // The AI, steered by a hostile issue: .git/config is locked, so it points commondir at its own config.
    marker = join(sandbox.home, 'ran-outside-fence');
    const program = join(sandbox.home, 'filter.sh');
    writeFileSync(program, `#!/bin/sh\ntouch '${marker}'\ncat\n`, { mode: 0o755 });
    const evil = join(sandbox.home, 'evil');
    runChild('git', ['init', '-q', '--bare', evil], { env: sandbox.env });
    writeFileSync(join(evil, 'config'), `[core]\n\trepositoryformatversion = 0\n\tbare = false\n[filter "x"]\n\tclean = ${program}\n`);
    writeFileSync(join(desk, '.git', 'commondir'), `${evil}\n`);
    writeFileSync(join(desk, '.gitattributes'), '* filter=x\n');
    writeFileSync(join(desk, 'f.txt'), 'x');
  });
  const result = await call(['14']);
  assert.equal(result.status, 1);
  assert.match(result.stderr.replace(/\s+/g, ' '), /yokoten desk · git does not run in this desk outside the fence: .*commondir is there: it would point git at a config the desk wrote Next: look at the desk by hand: it is kept in `[^`]+`\.? ?$/);
  assert.ok(!existsSync(marker), 'finish ran the planted filter outside the fence');
  assert.ok(existsSync(join(home, '14', '.git')), 'the desk is kept');
  assert.equal(readRecord(home, '14')?.state, 'kept');
  assert.deepEqual(pushes(calls), []);
  assert.ok(!calls.some((line) => line.startsWith('fenced git')), 'nothing was saved from the refused desk');
  // Going on, or --pr, is refused the same way.
  for (const args of [['14'], ['14', '--pr']]) {
    const again = await call(args);
    assert.equal(again.status, 1);
    assert.match(again.stderr, /git does not run in this desk outside the fence/);
  }
  assert.ok(!existsSync(marker));
  assert.deepEqual(pushes(calls), []);
});

test('desk: a running desk is not started twice (#1056)', async () => {
  const { call, home, commit } = makeWorld((desk) => commit(desk, 'a.txt', 'fix: a'));
  await call(['14']);
  const record = JSON.parse(readFileSync(join(home, '14.json'), 'utf8')) as Record<string, unknown>;
  writeFileSync(join(home, '14.json'), JSON.stringify({ ...record, state: 'working' }));
  const again = await call(['14']);
  assert.equal(again.status, 1);
  assert.equal(again.stderr, 'yokoten desk · desk 14 is running in another terminal (working)\n\nNext: stop it there, then run `yokoten desk 14` again.\n');
});

test('desk: on native Windows, one line to use WSL, and nothing starts (#1054)', async () => {
  const { call, home, calls } = makeWorld(() => {});
  for (const args of [[], ['14']]) {
    const result = await call(args, 'win32');
    assert.deepEqual([result.status, result.stdout, result.stderr], [1, '', `${DESK_USE_WSL.join('\n')}\n`]);
  }
  assert.deepEqual(calls, []);
  assert.ok(!existsSync(home));
  // The positive control: on Linux the same call starts the desk.
  assert.match((await call(['14'])).stdout, /^yokoten desk · desk 14 is clean: nothing left to push\n/);
  assert.ok(existsSync(join(home, 'trash')), 'the desk was made, then moved aside');
});

// The guard's hot path is src/commands/hook.ts: it never loads the desk (step 5 of the refactor plan).
const STATIC_DESK_IMPORT = /^import [^;]*from '\.\/desk\//m;

test('desk: the guard\'s module never loads the desk statically (#1054)', () => {
  // The positive control: the pattern catches a static import.
  assert.match("import { runDesk } from './desk/desk.ts';", STATIC_DESK_IMPORT);
  assert.doesNotMatch(readFileSync(join(import.meta.dirname, '..', '..', '..', 'src', 'commands', 'hook.ts'), 'utf8'), STATIC_DESK_IMPORT);
});

// Plan D1: the desks that stopped, shown before a start, are a pure screen of the list (#1115).
test('stoppedDesksScreen: one row each, then the first one to go on with; Windows is one failure (#1056, #1115)', () => {
  const desk = (name: string, commits: string[]) => ({ name, task: { kind: 'text' as const, title: `task ${name}` }, agent: 'claude-code', branch: `desk/${name}`, startedAt: '2026-10-26T10:00:00Z', activeAt: '2026-10-26T11:00:00Z', state: 'stopped' as const, commits });
  const now = new Date('2026-10-26T12:00:00Z');
  assert.deepEqual(stoppedDesksScreen([desk('7', ['f00ba12 fix: a']), desk('8', [])], now), [
    'yokoten desk · 2 other desks stopped mid-task',
    '',
    '  note        desk 7      stopped 1 h ago · claude-code · task 7 · 1 commit,',
    '                          last: f00ba12 fix: a',
    '',
    '  note        desk 8      stopped 1 h ago · claude-code · task 8 · no commits',
    '                          yet',
    '',
    'Next: `yokoten desk 7`',
  ]);
  assert.match(stoppedDesksScreen([desk('9', [])], now)[0] ?? '', /· 1 other desk stopped mid-task$/);
  assert.deepEqual(DESK_USE_WSL, ['yokoten desk · on Windows, a desk runs in WSL, where it has a sandbox; nothing', '               was started', '', 'Next: open WSL and run `yokoten desk` there.']);
});
