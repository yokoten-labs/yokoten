// Tests for src/agents/desk/start.ts, and the desk contract on this system (#637).
//
// The contract test starts a real desk with the backend this system has (bwrap on Linux
// and WSL2, sandbox-exec on macOS), runs a probe inside as the "agent", and checks each
// rule of the contract by what the probe could and could not do. It never names a
// backend's own words, so the same test holds every backend. It is skipped, with the
// reason, where the backend can't run.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { type DeskBackend, planDesk } from '../../../src/agents/desk/desk.ts';
import { appendMessage } from '../../../src/agents/desk/team/outbox.ts';
import { LEAD, prepareDeskTeam } from '../../../src/agents/desk/team/team.ts';
import { chooseBackend, signalEnd, startDesk } from '../../../src/agents/desk/start.ts';
import { markWorktree } from '../../../src/commands/hook.ts';
import { CLI, makeTempDir } from '../../repo/helpers.ts';

test('chooseBackend: native Windows is sent to WSL, an unknown system or fence is named', () => {
  const windows = chooseBackend('win32', {}, []) as string;
  assert.match(windows, /does not run on native Windows\. Run yokoten in WSL/);
  assert.match(chooseBackend('aix', {}, []) as string, /not on aix/);
  assert.match(chooseBackend('linux', { YOKOTEN_FENCE: 'none' }, []) as string, /YOKOTEN_FENCE is "none"; it can only be "own"/);
});

test('signalEnd: the real signal number, the signal named, and the sandbox hint when quiet', () => {
  const abort = signalEnd('SIGABRT', 'darwin', true);
  assert.equal(abort.code, 134);
  assert.match(abort.lines[0], /SIGABRT \(exit 134\)/);
  assert.match(abort.lines.join('\n'), /sandbox may have stopped it/);
  assert.match(abort.lines.join('\n'), /log show --last 1m --predicate 'eventMessage CONTAINS "deny"'/);
  assert.equal(signalEnd('SIGKILL', 'linux', false).code, 137);
  assert.deepEqual(signalEnd('SIGTERM', 'linux', false).lines, ['yokoten desk · the agent was ended by SIGTERM (exit 143)']);
  const linux = signalEnd('SIGABRT', 'linux', true).lines.join('\n');
  assert.match(linux, /sandbox may have stopped it/);
  assert.doesNotMatch(linux, /log show/);
});

test("startDesk: the agent's own sandbox goes off for the run; the clone's settings stay byte for byte (#1171)", async () => {
  const projects = makeTempDir('projects-');
  const origin = join(projects, 'origin');
  execFileSync('git', ['init', '-q', origin]);
  // The project's own sandbox on, as `yokoten init` writes it, committed so the clone carries it.
  const claudeSettings = '{\n  "sandbox": { "enabled": true },\n  "hooks": { "PreToolUse": [] }\n}\n';
  const codexConfig = 'sandbox_mode = "workspace-write"\napproval_policy = "on-request"\n\n[sandbox_workspace_write]\nnetwork_access = false\n';
  mkdirSync(join(origin, '.claude'));
  mkdirSync(join(origin, '.codex'));
  writeFileSync(join(origin, '.claude', 'settings.json'), claudeSettings);
  writeFileSync(join(origin, '.codex', 'config.toml'), codexConfig);
  execFileSync('git', ['-C', origin, 'add', '.']);
  execFileSync('git', ['-C', origin, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'start']);
  const desk = join(projects, 'desk');
  execFileSync('git', ['clone', '-q', origin, desk]);
  // Stand-ins for the agents: each writes the words it was started with.
  const programs = makeTempDir('agents-');
  for (const name of ['claude', 'codex']) writeFileSync(join(programs, name), `#!${process.execPath}\nrequire('node:fs').writeFileSync('started-${name}.json', JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o755 });
  // No fence: this test is about the words and the files, and runs where no backend can.
  const direct: DeskBackend = { name: 'direct', problem: () => null, proxyAddress: () => null, fence: (plan) => ({ file: plan.command[0], args: plan.command.slice(1), env: plan.env }) };
  for (const [runtime, name, words] of [['claude-code', 'claude', ['--settings', '{"sandbox":{"enabled":false}}']], ['codex', 'codex', ['-c', 'sandbox_mode="danger-full-access"']]] as const) {
    const plan = planDesk({ runtime, desk, command: [join(programs, name), 'the brief'], env: { ...process.env }, markDesk: (folder) => markWorktree(origin, folder, process.env) });
    const result = await startDesk(plan, direct, { stdio: 'pipe' });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(desk, `started-${name}.json`), 'utf8')), [...words, 'the brief'], `${name} starts with its own sandbox off`);
  }
  assert.equal(readFileSync(join(desk, '.claude', 'settings.json'), 'utf8'), claudeSettings, "the clone's .claude/settings.json is unchanged");
  assert.equal(readFileSync(join(desk, '.codex', 'config.toml'), 'utf8'), codexConfig, "the clone's .codex/config.toml is unchanged");
  assert.equal(execFileSync('git', ['-C', desk, 'status', '--porcelain', '--', '.claude', '.codex'], { encoding: 'utf8' }), '', 'git sees no change there either');
});

// The probe runs inside the desk. Each check is one line of its JSON answer. It is plain
// JavaScript written into the desk, so it needs nothing but Node.
const PROBE = String.raw`
const fs = require('node:fs');
const net = require('node:net');
const { spawnSync } = require('node:child_process');
const [cli, outsideFile, otherProject, echoPort, team] = process.argv.slice(2);
const answer = {};
const tryIt = (fn) => { try { return fn(); } catch (error) { return 'failed: ' + (error.code || error.message); } };
answer.deskWrite = tryIt(() => { fs.writeFileSync('written.txt', 'x'); return 'ok'; });
const git = (...args) => spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { encoding: 'utf8' });
git('add', 'written.txt');
const committed = git('commit', '-qm', 'desk');
answer.commit = committed.status;
answer.commitError = (committed.stderr || '').trim().slice(-500);
answer.outsideWrite = tryIt(() => { fs.writeFileSync(outsideFile, 'x'); return 'ok'; });
answer.homeWrite = tryIt(() => { fs.writeFileSync(process.env.HOME + '/outside.txt', 'x'); return 'ok'; });
answer.otherList = tryIt(() => fs.readdirSync(otherProject).join(','));
answer.otherRead = tryIt(() => fs.readFileSync(otherProject + '/notes.txt', 'utf8'));
const piped = spawnSync(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { input: 'through a pipe', encoding: 'utf8' });
const lead = process.env.HOME + '/.claude';
answer.leadProjects = tryIt(() => fs.readdirSync(lead + '/projects').join(','));
answer.leadHistory = tryIt(() => fs.readFileSync(lead + '/history.jsonl', 'utf8'));
answer.leadSettingsRead = tryIt(() => fs.readFileSync(lead + '/settings.json', 'utf8'));
answer.leadSettingsWrite = tryIt(() => { fs.writeFileSync(lead + '/settings.json', '{}'); return 'ok'; });
const own = process.env.CLAUDE_CONFIG_DIR;
answer.ownLogin = tryIt(() => fs.readFileSync(own + '/.credentials.json', 'utf8'));
answer.ownWrite = tryIt(() => { fs.writeFileSync(own + '/settings.json', '{}'); return 'ok'; });
answer.gitConfigWrite = tryIt(() => { fs.appendFileSync('.git/config', '[alias]\n'); return 'ok'; });
answer.gitHookWrite = tryIt(() => { fs.writeFileSync('.git/hooks/post-checkout', '#!/bin/sh\n'); return 'ok'; });
answer.gitConfigCommand = spawnSync('git', ['config', 'alias.st', 'status'], { encoding: 'utf8' }).status;
answer.hostDoors = ['/run/WSL', '/run/user', '/var/run/docker.sock'].filter((path) => fs.existsSync(path));
answer.pipes = piped.error ? 'failed: ' + piped.error.code : piped.stdout;
answer.temp = [process.env.TMPDIR, process.env.TEMP, process.env.TMP];
answer.tempWrite = tryIt(() => { const file = require('node:os').tmpdir() + '/probe.txt'; fs.writeFileSync(file, 'x'); fs.rmSync(file); return 'ok'; });
answer.role = process.env.YOKOTEN_ROLE;
answer.tz = process.env.TZ;
answer.token = process.env.GH_TOKEN === undefined ? 'absent' : 'present';
const msg = (...words) => spawnSync(process.execPath, [cli, 'msg', ...words], { encoding: 'utf8' });
const sent = msg('send', 'lead', 'hello from the desk');
answer.msgSend = sent.status + ' ' + sent.stderr.trim();
answer.msgInbox = msg('inbox').stdout;
answer.msgLog = msg('log').status;
answer.leadOutboxWrite = tryIt(() => { fs.appendFileSync(team + '/outbox/lead.jsonl', '{}\n'); return 'ok'; });
answer.otherOutboxWrite = tryIt(() => { fs.appendFileSync(team + '/outbox/other.jsonl', '{}\n'); return 'ok'; });
answer.otherOutboxRemove = tryIt(() => { fs.rmSync(team + '/outbox/other.jsonl'); return 'ok'; });
answer.teamNewFile = tryIt(() => { fs.writeFileSync(team + '/outbox/new.jsonl', '{}\n'); return 'ok'; });
answer.rosterWrite = tryIt(() => { fs.writeFileSync(team + '/agents/probe.json', '{}'); return 'ok'; });
answer.deskFileWrite = tryIt(() => { fs.writeFileSync('.git/yokoten-desk.json', '{}'); return 'ok'; });
const guard = spawnSync(process.execPath, [cli, 'hook'], { input: JSON.stringify({ tool_input: { command: 'git -c core.hooksPath=/dev/null commit -m x' } }), encoding: 'utf8' });
answer.guard = guard.status;
// #672: Muse Code passes its hooks no YOKOTEN_ROLE; the mark in the desk's .git still makes a worker.
const { YOKOTEN_ROLE, ...museEnv } = process.env;
const muse = spawnSync(process.execPath, [cli, 'hook', '--agent', 'muse'], { env: museEnv, input: JSON.stringify({ cwd: process.cwd(), tool_name: 'write_file', tool_input: { path: 'AGENTS.md', content: 'x' } }), encoding: 'utf8' });
answer.markedGuard = muse.status;
answer.markWrite = tryIt(() => { fs.writeFileSync('.git/yokoten-worker', ''); return 'ok'; });
answer.mark = fs.existsSync('.git/yokoten-worker');
const proxy = new URL(process.env.HTTPS_PROXY);
// A proxy URL with a user and password wants them, as a real client sends them.
const auth = proxy.username ? 'Proxy-Authorization: Basic ' + Buffer.from(decodeURIComponent(proxy.username) + ':' + decodeURIComponent(proxy.password)).toString('base64') + '\r\n' : '';
const connectTo = (host, port, send) => new Promise((resolve) => {
  const socket = net.connect({ host, port }, () => socket.write(send));
  let text = '';
  socket.setTimeout(5000, () => { socket.destroy(); resolve(text || 'failed: timeout'); });
  socket.on('data', (chunk) => { text += chunk; if (text.includes('hello back')) { socket.destroy(); resolve(text); } });
  socket.on('error', (error) => resolve('failed: ' + error.code));
  socket.on('close', () => resolve(text || 'failed: closed'));
});
(async () => {
  answer.direct = await connectTo('127.0.0.1', Number(echoPort), 'hello');
  answer.allowed = await connectTo(proxy.hostname, Number(proxy.port), 'CONNECT localhost:' + echoPort + ' HTTP/1.1\r\nHost: localhost\r\n' + auth + '\r\nhello');
  answer.refused = await connectTo(proxy.hostname, Number(proxy.port), 'CONNECT example.com:443 HTTP/1.1\r\nHost: example.com\r\n' + auth + '\r\n');
  console.log(JSON.stringify(answer));
})();
`;

/** The contract, checked by what a probe inside the desk could and could not do. */
async function holdsContract(backend: DeskBackend): Promise<void> {
  const projects = makeTempDir('projects-');
  const origin = join(projects, 'origin');
  mkdirSync(origin);
  execFileSync('git', ['init', '-q', origin]);
  execFileSync('git', ['-C', origin, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', 'start']);
  const desk = join(projects, 'desk');
  execFileSync('git', ['clone', '-q', origin, desk]);
  const other = join(projects, 'other-project');
  mkdirSync(other);
  writeFileSync(join(other, 'notes.txt'), 'not for the desk');
  writeFileSync(join(desk, 'probe.cjs'), PROBE);
  // The lead's own Claude Code state, in the test home: none of it may show in the desk.
  const lead = join(process.env.HOME ?? '', '.claude');
  mkdirSync(join(lead, 'projects', 'some-project'), { recursive: true });
  writeFileSync(join(lead, 'history.jsonl'), '{"display": "a past prompt"}\n');
  writeFileSync(join(lead, 'settings.json'), '{"hooks": {}}');
  writeFileSync(join(lead, '.credentials.json'), 'not-a-real-login');
  // A server outside the desk: reached through the proxy, never straight.
  const echo = createServer((socket) => socket.on('data', () => socket.end('hello back')));
  await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve));
  const echoPort = (echo.address() as { port: number }).port;
  const outsideFile = join(dirname(desk), 'outside.txt');
  // The team (#674): another agent's outbox, and a message from the lead for this desk's agent, 'probe'.
  const team = join(projects, 'origin.team');
  const otherDesk = join(projects, 'other-desk');
  mkdirSync(join(otherDesk, '.git'), { recursive: true });
  prepareDeskTeam({ team, name: 'other', runtime: 'codex', model: 'gpt-5.5', desk: otherDesk });
  appendMessage({ name: LEAD, team, readState: join(team, 'lead', 'read.json'), inDesk: false }, 'probe', 'hello from the lead', new Date());
  try {
    const plan = planDesk({
      runtime: 'claude-code',
      desk,
      command: [process.execPath, 'probe.cjs', CLI, outsideFile, other, String(echoPort), team],
      // A Claude Code shell's TMPDIR, read-only in the fence (#1172): the desk must give its own.
      env: { ...process.env, GH_TOKEN: 'not-a-real-token', TMPDIR: '/tmp/claude', TEMP: '/tmp/claude', TMP: '/tmp/claude' },
      extraHosts: [`localhost:${echoPort}`],
      team: { folder: team, name: 'probe' },
      markDesk: (folder) => markWorktree(origin, folder, process.env),
    });
    const result = await startDesk(plan, backend, { stdio: 'pipe' });
    assert.equal(result.code, 0, result.stderr);
    const answer = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}');
    assert.equal(answer.deskWrite, 'ok', 'a write in the desk works');
    assert.equal(answer.commit, 0, `git commit works in the desk: ${answer.commitError}`);
    // A hidden folder is read-only (bwrap, sandbox-exec) or a new empty folder in memory
    // (sandbox-runtime on Linux). Either way a write there, next to the desk or in the home
    // folder, never reaches the disk.
    assert.ok(!existsSync(outsideFile) && !existsSync(join(process.env.HOME ?? '', 'outside.txt')), 'nothing was written outside');
    // Not listed: an error, or an empty folder in its place (sandbox-runtime on Linux).
    assert.match(answer.otherList, /^(failed|$)/, 'another project is not listed');
    assert.match(answer.otherRead, /^failed/, "another project's file is not read");
    assert.match(answer.leadProjects, /^(failed|$)/, "the lead's projects are not listed");
    assert.match(answer.leadHistory, /^failed/, "the lead's history is not read");
    assert.match(answer.leadSettingsRead, /^failed/, "the lead's settings are not read");
    assert.match(answer.leadSettingsWrite, /^failed/, "the lead's settings are not written");
    assert.equal(readFileSync(join(lead, 'settings.json'), 'utf8'), '{"hooks": {}}');
    assert.equal(answer.ownLogin, 'not-a-real-login', "the desk's own state has the login");
    assert.equal(answer.ownWrite, 'ok', "the desk's own state is writable");
    assert.ok(!existsSync(join(lead, '.claude.json')) && readdirSync(lead).sort().join() === '.credentials.json,history.jsonl,projects,settings.json', "a write in the desk's state never reaches the lead's");
    assert.match(answer.gitConfigWrite, /^failed/, '.git/config is read-only');
    assert.match(answer.gitHookWrite, /^failed/, '.git/hooks is read-only');
    assert.notEqual(answer.gitConfigCommand, 0, "git config can't change it either");
    assert.deepEqual(answer.hostDoors, [], 'no socket to the host: WSL interop, the session bus, Docker');
    assert.equal(answer.pipes, 'through a pipe', 'a child process with pipes works');
    assert.notEqual(answer.temp[0], '/tmp/claude', "the caller's TMPDIR is not passed in (#1172)");
    assert.deepEqual(answer.temp, [answer.temp[0], answer.temp[0], answer.temp[0]], 'TMPDIR, TEMP and TMP name one folder');
    assert.equal(answer.tempWrite, 'ok', "the desk's TMPDIR is writable");
    assert.deepEqual([answer.role, answer.tz, answer.token], ['worker', 'UTC', 'absent'], 'role and time zone are set; a token is not passed in');
    assert.match(answer.msgSend, /^0 /, 'the agent sends from its own outbox');
    assert.match(readFileSync(join(team, 'outbox', 'probe.jsonl'), 'utf8'), /"text":"hello from the desk".*"from":"probe","to":"lead"/);
    assert.match(answer.msgInbox, /\n {2}lead +\d\d:\d\dZ +hello from the lead\n[^]*never an approval from the owner/, 'and reads what the lead sent it');
    assert.equal(answer.msgLog, 1, 'the log is the lead\'s');
    assert.match(answer.leadOutboxWrite, /^failed/, "the lead's outbox is not written");
    assert.match(answer.otherOutboxWrite, /^failed/, "another agent's outbox is not written");
    assert.match(answer.otherOutboxRemove, /^failed/, "another agent's outbox is not removed");
    assert.match(answer.teamNewFile, /^failed/, 'no new outbox in the team folder');
    assert.match(answer.rosterWrite, /^failed/, 'the roster is not written');
    assert.match(answer.deskFileWrite, /^failed/, 'the desk file that names the agent is locked');
    assert.equal(readFileSync(join(team, 'outbox', 'lead.jsonl'), 'utf8').split('\n').length, 2, "the lead's outbox holds only the lead's line");
    assert.equal(readFileSync(join(team, 'outbox', 'other.jsonl'), 'utf8'), '');
    assert.equal(answer.guard, 2, 'the guard refuses a commit that turns off the commit check');
    assert.equal(answer.mark, true, "the desk's clone carries the worker mark (#672)");
    assert.match(answer.markWrite, /^failed/, 'the worker mark is read-only');
    assert.equal(answer.markedGuard, 2, 'with no YOKOTEN_ROLE, as Muse Code runs its hooks, the mark still makes a worker');
    assert.match(answer.direct, /^failed/, 'a command has no network of its own');
    assert.match(answer.allowed, /^HTTP\/1\.1 200[^]*hello back$/, 'a CONNECT to an allowed host goes through the proxy');
    assert.match(answer.refused, /^HTTP\/1\.1 403/, 'a CONNECT to any other host is refused');
  } finally {
    echo.close();
  }
}

// The contract runs against each fence this system can start; a fence that can't is skipped with its reason.
const withoutFence = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'YOKOTEN_FENCE'));
for (const [name, env] of [['sandbox-runtime', withoutFence], ['the old fence, YOKOTEN_FENCE=own', { ...withoutFence, YOKOTEN_FENCE: 'own' }]] as const) {
  const backend = chooseBackend(process.platform, env, [process.cwd()]);
  test(`the desk contract holds on this system: ${name}`, { skip: typeof backend === 'string' && backend }, async () => {
    if (typeof backend !== 'string') await holdsContract(backend);
  });
}
