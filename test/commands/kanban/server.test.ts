// Tests for src/commands/kanban/server.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { CLI, makeSandbox, makeTempDir, ROOT } from '../../repo/helpers.ts';
import { sessionId } from '../../../src/commands/kanban/agents.ts';
import { EMPTY_DESK } from '../../../src/commands/kanban/feed/read/desk.ts';
import { boardHostName, boardPort, browserCommand, PAGE_NOT_BUILT, printableLink, startBoardServer } from '../../../src/commands/kanban/server.ts';
import { stateOf } from '../../../src/commands/kanban/state.ts';
import { createBoardGitHub } from '../../../src/commands/kanban/view.ts';
import { type GhLater, ghLaterIn } from '../../../src/host/github/index.ts';

/** `*.localhost` is loopback in a browser. This machine's DNS does not resolve it, so tests dial 127.0.0.1 and send the Host header. */
function boardDial(hostname: string): string {
  return hostname === 'localhost' || hostname.endsWith('.localhost') ? '127.0.0.1' : hostname;
}

interface Answer {
  status: number;
  kind: string;
  headers: Record<string, string>;
  text: string;
}

/** The status line, headers and body of a raw answer. */
function readAnswer(answer: Buffer): Answer {
  const split = answer.indexOf('\r\n\r\n');
  const [statusLine, ...rows] = answer.subarray(0, split).toString('utf8').split('\r\n');
  const found: Record<string, string> = {};
  for (const row of rows) {
    const at = row.indexOf(':');
    if (at > 0) found[row.slice(0, at).trim().toLowerCase()] = row.slice(at + 1).trim();
  }
  return { status: Number(statusLine.split(' ')[1]), kind: found['content-type'] ?? '', headers: found, text: answer.subarray(split + 4).toString('utf8') };
}

// #601: one request over a raw socket, with any method, headers and body, so no proxy
// setting can send it elsewhere. Each server test closes its server in a finally.
function boardSend(target: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Answer> {
  const url = new URL(target);
  const method = options.method ?? 'GET';
  return new Promise((done, failed) => {
    const socket = connect(Number(url.port), boardDial(url.hostname), () => {
      const rows = [`${method} ${url.pathname}${url.search} HTTP/1.1`, `Host: ${options.headers?.host ?? url.host}`, 'Connection: close'];
      for (const [key, value] of Object.entries(options.headers ?? {})) if (key.toLowerCase() !== 'host') rows.push(`${key}: ${value}`);
      if (options.body !== undefined) rows.push(`Content-Length: ${Buffer.byteLength(options.body)}`);
      socket.write(`${rows.join('\r\n')}\r\n\r\n${options.body ?? ''}`);
    });
    const parts: Buffer[] = [];
    socket.on('data', (chunk) => parts.push(chunk));
    socket.on('end', () => done(readAnswer(Buffer.concat(parts))));
    socket.on('error', failed);
  });
}

const boardGet = (target: string, headers: Record<string, string> = {}) => boardSend(target, { headers });

/** The cookie from the first visit. The link's token sets it and redirects; the body stays behind the cookie. */
async function boardCookie(url: string): Promise<string> {
  const first = await boardGet(url);
  assert.equal(first.status, 303, first.text);
  const match = /^yokoten-board=([0-9a-f]{32}); HttpOnly; Secure; SameSite=Strict; Path=\/$/.exec(first.headers['set-cookie'] ?? '');
  assert.ok(match, 'the first visit sets an HttpOnly Secure SameSite=Strict cookie');
  assert.equal(first.headers.location?.includes('token'), false, 'the redirect drops the token');
  return `yokoten-board=${match?.[1] ?? ''}`;
}

/** The first event of a stream: the headers and the first part, then the socket closes. */
function boardStreamFirst(target: string, cookie: string): Promise<Answer> {
  const url = new URL(target);
  return new Promise((done, failed) => {
    const socket = connect(Number(url.port), boardDial(url.hostname), () => {
      socket.write(`GET ${url.pathname} HTTP/1.1\r\nHost: ${url.host}\r\nCookie: ${cookie}\r\n\r\n`);
    });
    const parts: Buffer[] = [];
    socket.on('data', (chunk) => {
      parts.push(chunk);
      const text = Buffer.concat(parts).toString('utf8');
      const body = text.indexOf('\r\n\r\n');
      if (body >= 0 && (text.slice(body + 4).includes('\n\n') || !text.startsWith('HTTP/1.1 200'))) {
        socket.destroy();
        done(readAnswer(Buffer.concat(parts)));
      }
    });
    socket.on('error', failed);
  });
}

const closeServer = (server: { close: (done: () => void) => void; closeAllConnections?: () => void }) =>
  new Promise<void>((done) => {
    server.close(() => done());
    server.closeAllConnections?.();
  });

/** Every required key of each interface in types.ts, read from the file, so a new key cannot skip the check. */
function requiredKeys(name: string): string[] {
  const types = readFileSync(join(ROOT, 'src/commands/kanban/types.ts'), 'utf8');
  const body = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(types)?.[1];
  assert.ok(body, `types.ts has ${name}`);
  return [...body.matchAll(/^ {2}(\w+):/gm)].map((match) => match[1]);
}

/** Throws unless `value` has every required key of `name`; each nested shape is checked too. */
function assertShape(value: unknown, name: string, at = name): void {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `${at} is an object`);
  const fields = value as Record<string, unknown>;
  for (const key of requiredKeys(name)) assert.ok(key in fields && fields[key] !== undefined, `${at} has ${key}`);
  const inline: Record<string, [string, string[]][]> = {
    KanbanSession: [['task', ['kind', 'title']], ['cost', ['tokens', 'usd']]],
    KanbanActions: [['main', ['state']]],
  };
  for (const [key, keys] of inline[name] ?? []) for (const one of keys) assert.ok(one in (fields[key] as object), `${at}.${key} has ${one}`);
  const nested: Record<string, [string, string][]> = {
    KanbanState: [['actions', 'KanbanActions'], ['usage', 'KanbanUsage']],
    KanbanSession: [['evidence', 'KanbanEvidence']],
  };
  for (const [key, type] of nested[name] ?? []) assertShape(fields[key], type, `${at}.${key}`);
  const lists: Record<string, [string, string | string[]][]> = {
    KanbanState: [['sessions', 'KanbanSession'], ['pulls', 'KanbanPull'], ['problems', []]],
    KanbanUsage: [['quotas', 'KanbanQuota'], ['costs', 'KanbanCost']],
    KanbanEvidence: [['platforms', ['name', 'state']]],
    KanbanActions: [['queuedOver15Min', ['name', 'minutes', 'url']], ['flaky', ['name', 'passFailLast10', 'url']]],
  };
  for (const [key, shape] of lists[name] ?? []) {
    assert.ok(Array.isArray(fields[key]), `${at}.${key} is a list`);
    for (const [index, item] of (fields[key] as unknown[]).entries()) {
      if (typeof shape === 'string') assertShape(item, shape, `${at}.${key}[${index}]`);
      else for (const one of shape) assert.ok(one in (item as object), `${at}.${key}[${index}] has ${one}`);
    }
  }
  if (name === 'KanbanState' && fields.repo !== null) for (const one of ['name', 'url']) assert.ok(one in (fields.repo as object), `${at}.repo has ${one}`);
}

/** A fake gh for the background read: pull requests, Actions runs and the default branch. */
function fakeGitHub(now: number): GhLater {
  const ago = (minutes: number) => new Date(now - minutes * 60000).toISOString();
  const open = { number: 7, title: 'team page', headRefName: 'board', url: 'https://example.com/pull/7', state: 'OPEN', reviewDecision: 'REVIEW_REQUIRED', isDraft: false, statusCheckRollup: [{ conclusion: 'SUCCESS', status: 'COMPLETED' }], labels: [{ name: 'tier A' }] };
  const run = (id: number, fields: Record<string, unknown>) => ({ id, name: 'CI', event: 'push', head_branch: 'main', status: 'completed', conclusion: 'success', created_at: ago(id * 10), run_started_at: ago(id * 10), updated_at: ago(id * 10 - 1), html_url: `https://example.com/run/${id}`, ...fields });
  const runs = [run(1, { status: 'queued', conclusion: null, created_at: ago(30) }), run(2, { conclusion: 'failure' }), run(3, {}), run(4, { conclusion: 'failure' })];
  return (args) => {
    if (args[0] === 'api') return JSON.stringify({ workflow_runs: runs });
    if (args[0] === 'repo') return 'main\n';
    return JSON.stringify(args.includes('open') ? [open] : []);
  };
}

// #693: the address is the folder name on localhost, and the port stays with the repo path.
test('kanban address: the host name is safe, and the port stays with the repo', () => {
  const sandbox = makeSandbox();
  assert.equal(boardHostName(sandbox.repo), 'repo');
  assert.equal(boardHostName(join(sandbox.home, 'My Repo')), 'my-repo');
  assert.equal(boardHostName(join(sandbox.home, 'A_B.C')), 'a-b-c');
  assert.equal(boardHostName(join(sandbox.home, '---')), 'board');
  assert.equal(boardHostName(join(sandbox.home, 'Ａb')), 'ab', 'a fullwidth letter becomes the plain letter');
  assert.equal(boardHostName(join(sandbox.home, 'x'.repeat(80))), 'x'.repeat(63), 'a label stays within 63 letters');
  const port = boardPort(sandbox.repo);
  assert.equal(boardPort(sandbox.repo), port, 'the same path asks for the same port');
  assert.ok(port >= 28416 && port < 28416 + 4000, `the port stays in the high range: ${port}`);
  const link = join(sandbox.home, 'same-repo');
  symlinkSync(sandbox.repo, link);
  assert.equal(boardPort(link), port, 'two paths to one repo share a port');
});

// Record 0044: the kanban is read only. Every method but GET and HEAD gets a 405 on every
// path, with or without the cookie, so no request can start, stop or change work.
test('kanban server: POST, PUT, PATCH and DELETE get a 405 everywhere', async () => {
  const sandbox = makeSandbox();
  const { server, url } = await startBoardServer(sandbox.repo, sandbox.env, () => '[]', { pageDir: makeTempDir() });
  try {
    const base = url.split('?')[0];
    const cookie = await boardCookie(url);
    const paths = ['', 'api/state', `api/sessions/${'0'.repeat(16)}/stream`, 'agents/start', 'agents/stop', 'agents/limits', 'data', 'feed', 'nothing', `?token=${new URL(url).searchParams.get('token')}`];
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      for (const path of paths) {
        for (const headers of [{ cookie, 'content-type': 'application/json' }, {}] as Record<string, string>[]) {
          const answer = await boardSend(`${base}${path}`, { method, headers, body: '{"issue":"1","vendor":"claude-code"}' });
          assert.equal(answer.status, 405, `${method} /${path}`);
          assert.equal(answer.headers.allow, 'GET, HEAD');
        }
      }
    }
    // A positive control: the same paths read with GET are not refused for the method.
    assert.equal((await boardGet(`${base}api/state`, { cookie })).status, 200);
    const head = await boardSend(`${base}api/state`, { method: 'HEAD', headers: { cookie } });
    assert.equal(head.status, 200, 'HEAD reads too');
    assert.equal(head.text, '', 'with no body');
    assert.equal((await boardGet(`${base}agents/start`, { cookie })).status, 404, 'the old write routes are gone');
  } finally {
    await closeServer(server);
  }
});

// Record 0044: /api/state answers one KanbanState, with every required key of types.ts.
test('kanban server: /api/state has every required key of the types', async () => {
  const sandbox = makeSandbox();
  // The git name "Test" is a word in `yokoten-test-…`, so the mask would hide every path.
  assert.equal(sandbox.git('config', 'user.name', 'Plover').status, 0);
  sandbox.git('remote', 'add', 'origin', 'git@github.com:octo/demo.git');
  writeFileSync(join(sandbox.repo, '.yokoten-agent.json'), JSON.stringify({ name: 'w', vendor: 'muse', task: 'issue 4 docs', updated: new Date().toISOString(), checks: 'passing' }));
  const github = createBoardGitHub();
  const { server, url } = await startBoardServer(sandbox.repo, sandbox.env, fakeGitHub(Date.now()), { github, pageDir: makeTempDir() });
  try {
    await github.reading;
    const answer = await boardGet(`${url.split('?')[0]}api/state`, { cookie: await boardCookie(url) });
    assert.equal(answer.status, 200);
    assert.equal(answer.kind, 'application/json; charset=utf-8');
    assert.equal(answer.headers['cache-control'], 'no-store');
    const state = JSON.parse(answer.text) as Record<string, unknown> & { sessions: { state: string }[]; pulls: { number: number; waitsOnYou: boolean }[]; actions: { main: { state: string }; queuedOver15Min: unknown[]; flaky: unknown[] } };
    assertShape(state, 'KanbanState');
    assert.deepEqual(state.sessions.map((one) => one.state), ['working']);
    assert.deepEqual(state.pulls.map((one) => [one.number, one.waitsOnYou]), [[7, true]]);
    assert.equal(state.actions.main.state, 'fail');
    assert.equal(state.actions.queuedOver15Min.length, 1);
    assert.equal(state.actions.flaky.length, 1);
    // The shapes the server leaves empty here: usage rows, checked on a snapshot that has them.
    const cell = { agent: 'w', vendor: 'Muse', model: 'm', role: '', day: new Date().toISOString().slice(0, 10), input: 1, cached: 2, output: 3, usd: null, isPartial: true, isLocal: false };
    const board = { repo: '', repoName: 'r', repoUrl: '', agents: [], needs: [], pulls: [], merged: [], worktrees: [], desk: EMPTY_DESK, updated: '', usage: { cells: [cell], days: [], partial: [], checked: '', sources: [] } };
    const withUsage = stateOf(board, { remote: null, pulls: [], runs: [], defaultBranch: 'main' }, new Set(), Date.now());
    withUsage.usage.quotas.push({ agent: 'Claude', window: '5-hour', usedPercent: 10, resetsAt: '' });
    assertShape(JSON.parse(JSON.stringify(withUsage)), 'KanbanState');
    assert.deepEqual(withUsage.usage.costs, [{ agent: 'Muse', sessions: 1, tokens: 6, usd: null, onPlan: false }]);
    // A positive control: a missing key, at the top or nested, fails the assertion.
    for (const drop of [(copy: Record<string, unknown>) => delete copy.problems, (copy: Record<string, unknown>) => delete (copy.sessions as Record<string, unknown>[])[0].evidence, (copy: Record<string, unknown>) => delete (copy.actions as Record<string, Record<string, unknown>>).main.state]) {
      const copy = JSON.parse(answer.text) as Record<string, unknown>;
      drop(copy);
      assert.throws(() => assertShape(copy, 'KanbanState'));
    }
    assert.deepEqual(requiredKeys('KanbanState'), ['version', 'readAt', 'repo', 'sessions', 'pulls', 'actions', 'usage', 'problems'], 'the keys come from types.ts');
  } finally {
    await closeServer(server);
  }
});

// #688: /api/state never waits for gh. A real child gh that sleeps 10 s: it still answers at once.
test('kanban server: /api/state answers at once while gh sleeps', async () => {
  const sandbox = makeSandbox();
  sandbox.git('remote', 'add', 'origin', 'git@github.com:octo/demo.git');
  writeFileSync(join(sandbox.repo, '.yokoten-agent.json'), JSON.stringify({ name: 'w', vendor: 'muse' }));
  const bin = join(sandbox.home, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), "#!/usr/bin/env node\nsetTimeout(() => console.log('[]'), 10000);\n");
  chmodSync(join(bin, 'gh'), 0o755);
  const env = { ...sandbox.env, PATH: `${bin}:${process.env.PATH}` };
  const github = createBoardGitHub();
  const { server, url } = await startBoardServer(sandbox.repo, env, ghLaterIn(sandbox.repo, env, 20000), { github, pageDir: makeTempDir() });
  try {
    assert.ok(github.reading, 'the first read starts with the server');
    const cookie = await boardCookie(url);
    const asked = performance.now();
    const answer = await boardGet(`${url.split('?')[0]}api/state`, { cookie });
    const took = performance.now() - asked;
    assert.equal(answer.status, 200);
    assert.ok(took < 5000, `/api/state took ${took.toFixed(0)} ms while gh sleeps`);
    const shown = JSON.parse(answer.text) as { sessions: unknown[]; problems: string[] };
    assert.equal(shown.sessions.length, 1, 'the sessions show at once');
    assert.deepEqual(shown.problems, ['reading GitHub…']);
  } finally {
    await closeServer(server);
  }
});

// #601, #693: the server answers only its own Host and its cookie. The query token only starts a visit.
test('kanban server: a wrong Host, cookie or token gets a 403', async () => {
  const sandbox = makeSandbox();
  const { server, url } = await startBoardServer(sandbox.repo, sandbox.env, () => '[]', { pageDir: makeTempDir() });
  try {
    const port = (server.address() as { port: number }).port;
    const base = url.split('?')[0];
    const token = new URL(url).searchParams.get('token') ?? '';
    const flipped = `${token.slice(0, -1)}${token.endsWith('0') ? '1' : '0'}`;
    const cookie = await boardCookie(url);
    for (const host of [`evil.example:${port}`, `127.0.0.1:${port}.evil.example`, '127.0.0.1', `other.localhost:${port}`]) {
      assert.equal((await boardGet(`${base}api/state`, { cookie, host })).status, 403, `wrong Host: ${host}`);
    }
    for (const path of ['', 'api/state', `api/sessions/${'0'.repeat(16)}/stream`, 'assets/index.js']) {
      assert.equal((await boardGet(`${base}${path}`)).status, 403, `/${path} without a cookie`);
      assert.equal((await boardGet(`${base}${path}`, { cookie: `yokoten-board=${flipped}` })).status, 403, `/${path} with a cookie one digit off`);
    }
    const wrong = await boardGet(`${base}?token=${flipped}`);
    assert.equal(wrong.status, 403);
    assert.equal(wrong.headers['set-cookie'], undefined, 'a wrong token sets no cookie');
    const first = await boardGet(`${base}api/state?token=${token}&x=1`);
    assert.equal(first.headers.location, '/api/state?x=1', 'other query words stay, the token does not');
    const sneak = await boardGet(`${base}..%2F..%2Fetc?token=${token}`);
    assert.equal(sneak.headers.location, '/', 'a strange path returns to the page');
    // localhost and 127.0.0.1 name the same server, so those Host headers are welcome too.
    assert.equal((await boardGet(`${base}api/state`, { cookie, host: `localhost:${port}` })).status, 200);
    for (const answer of [first, await boardGet(`${base}api/state`, { cookie })]) assert.equal(answer.text.includes(token), false, 'no answer holds the token');
  } finally {
    await closeServer(server);
  }
});

// Record 0044: / serves the built page, and /assets its files. Without a build, one plain line.
test('kanban server: the built page, its assets, and one line when it is not built', async () => {
  const sandbox = makeSandbox();
  const dist = makeTempDir();
  const { server, url } = await startBoardServer(sandbox.repo, sandbox.env, () => '[]', { pageDir: dist });
  try {
    const base = url.split('?')[0];
    const cookie = await boardCookie(url);
    const bare = await boardGet(base, { cookie });
    assert.equal(bare.status, 200);
    assert.equal(bare.kind, 'text/plain; charset=utf-8');
    assert.equal(bare.text, `${PAGE_NOT_BUILT}\n`, 'one plain line');
    mkdirSync(join(dist, 'assets'));
    writeFileSync(join(dist, 'index.html'), '<!doctype html><script type="module" src="/assets/index-1.js"></script>');
    writeFileSync(join(dist, 'assets', 'index-1.js'), 'console.log(1)');
    writeFileSync(join(dist, 'secret.txt'), 'not served');
    const page = await boardGet(base, { cookie });
    assert.equal(page.status, 200);
    assert.equal(page.kind, 'text/html; charset=utf-8');
    assert.match(page.headers['content-security-policy'] ?? '', /^default-src 'none'; script-src 'self';/);
    assert.match(page.headers['content-security-policy'] ?? '', /frame-ancestors 'none'/);
    const script = await boardGet(`${base}assets/index-1.js`, { cookie });
    assert.equal(script.status, 200);
    assert.equal(script.kind, 'text/javascript; charset=utf-8');
    assert.equal(script.text, 'console.log(1)');
    for (const path of ['assets/missing.js', 'assets/..%2Fsecret.txt', 'assets/../secret.txt', 'assets/.hidden.js', 'secret.txt', 'assets/x.txt']) {
      assert.equal((await boardGet(`${base}${path}`, { cookie })).status, 404, path);
    }
  } finally {
    await closeServer(server);
  }
});

// #694: a session's output is server-sent events at /api/sessions/<id>/stream; the id is a hash of the path.
test('kanban server: a session streams as server-sent events, by its hashed id', async () => {
  const sandbox = makeSandbox();
  assert.equal(sandbox.git('config', 'user.name', 'Plover').status, 0);
  writeFileSync(join(sandbox.repo, '.yokoten-agent.json'), JSON.stringify({ name: 'w', vendor: 'muse', doing: 'writing tests' }));
  const { server, url } = await startBoardServer(sandbox.repo, sandbox.env, () => '[]', { pageDir: makeTempDir(), feedMask: (text) => text });
  try {
    const base = url.split('?')[0];
    const cookie = await boardCookie(url);
    const state = JSON.parse((await boardGet(`${base}api/state`, { cookie })).text) as { sessions: { id: string }[] };
    const id = state.sessions[0]?.id ?? '';
    assert.match(id, /^[0-9a-f]{16}$/);
    assert.equal(id, sessionId(realpathSync(sandbox.repo)), 'the hash of the shown path, never the path');
    const first = await boardStreamFirst(`${base}api/sessions/${id}/stream`, cookie);
    assert.equal(first.status, 200);
    assert.equal(first.kind, 'text/event-stream; charset=utf-8');
    assert.equal(first.headers['cache-control'], 'no-store');
    const event = /^id: ([^\n]*)\ndata: (.*)\n\n/.exec(first.text.replace(/^[0-9a-f]+\r\n/, ''));
    assert.ok(event, `one event: ${first.text}`);
    const sent = JSON.parse(event[2]) as { source: string; reset: boolean; items: unknown[] };
    assert.equal(sent.source, 'doing', 'no log yet: the answer says so');
    assert.equal(sent.reset, true);
    assert.equal((await boardGet(`${base}api/sessions/${'f'.repeat(16)}/stream`, { cookie })).status, 404, 'no session with that id');
    assert.equal((await boardGet(`${base}api/sessions/${encodeURIComponent(sandbox.repo)}/stream`, { cookie })).status, 404, 'a path is no id');
  } finally {
    await closeServer(server);
  }
});

// #601: `kanban --text` prints the same state as the page, and `board` still names it.
test('kanban --text: the sessions, pull requests and Actions, and the usage errors', async () => {
  const sandbox = makeSandbox();
  const started = sandbox.run(['kanban', '--text']);
  assert.equal(started.status, 0, started.stderr);
  assert.match(started.stdout, /^yokoten kanban: this repo \(preview: read only\)\n\nSessions:\n- none yet\. [^\n]+\n\nPull requests:\n- none waits on you\.\n\nActions: main unknown\n\nNot read:\n- this repo has no GitHub remote, so the board shows no pull requests\n$/);
  writeFileSync(join(sandbox.repo, '.yokoten-agent.json'), JSON.stringify({ name: 'w', vendor: 'claude', model: 'opus', task: 'issue 601 board', updated: new Date().toISOString() }));
  const joined = await sandbox.call(['board', '--text']);
  assert.equal(joined.status, 0, joined.stderr);
  assert.match(joined.stdout, /\nWorking:\n- Claude \(opus\): issue #601 board\n/);
  assert.equal((await sandbox.call(['kanban', '--bogus'])).status, 1, 'an unknown option is refused');
  assert.equal((await sandbox.call(['kanban', '--text', '--all'])).status, 1, 'the old --all is gone');
  const outside = await sandbox.call(['kanban', '--text'], { cwd: sandbox.home });
  assert.equal(outside.status, 1, 'outside a repo it says so');
});

// #601: with a GitHub remote, --text reads gh once per list. A fake gh first on PATH answers.
test('kanban --text: pull requests and Actions from gh', async () => {
  const sandbox = makeSandbox();
  assert.equal(sandbox.git('remote', 'add', 'origin', 'https://github.com/octo/demo.git').status, 0);
  const bin = join(sandbox.home, 'bin');
  mkdirSync(bin);
  const pulls = [{ number: 7, title: 'team page', headRefName: 'board', url: 'https://example.com/pull/7', state: 'OPEN', reviewDecision: 'REVIEW_REQUIRED', isDraft: false, statusCheckRollup: [{ conclusion: 'FAILURE', status: 'COMPLETED' }], labels: [{ name: 'tier A' }] }];
  const runs = { workflow_runs: [{ id: 1, name: 'CI', event: 'push', head_branch: 'main', status: 'completed', conclusion: 'failure', created_at: '2026-10-26T10:00:00Z', run_started_at: '2026-10-26T10:00:00Z', updated_at: '2026-10-26T10:05:00Z', html_url: 'https://example.com/run/1' }] };
  const script = `const args = process.argv.slice(2);\nif (args[0] === 'api') console.log(${JSON.stringify(JSON.stringify(runs))});\nelse if (args[0] === 'repo') console.log('main');\nelse console.log(args.includes('open') ? ${JSON.stringify(JSON.stringify(pulls))} : '[]');\n`;
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node\n${script}`);
  chmodSync(join(bin, 'gh'), 0o755);
  const result = await sandbox.call(['kanban', '--text'], { extra: { PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^yokoten kanban: repo \(preview: read only\)\n/);
  assert.match(result.stdout, /\nPull requests:\n- #7 team page: checks failing\n/);
  assert.match(result.stdout, /\nActions: main fail since 2026-10-26T10:00:00Z\n/);
});

// #1045: the access key goes only to the browser; the screen shows the link without it.
test('kanban: the access key is never printed, and the browser gets it', async () => {
  const sandbox = makeSandbox();
  const bin = join(sandbox.home, 'bin');
  mkdirSync(bin);
  const opened = join(sandbox.home, 'opened.txt');
  for (const name of ['xdg-open', 'open']) {
    writeFileSync(join(bin, name), `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(opened)}, process.argv.slice(2).join(' '));\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const env: NodeJS.ProcessEnv = { ...sandbox.env, PATH: `${bin}:${process.env.PATH}` };
  delete env.WSL_DISTRO_NAME;
  const child = spawn(process.execPath, [CLI, 'kanban'], { cwd: sandbox.repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  try {
    await new Promise<void>((done, failed) => {
      const timer = setTimeout(() => failed(new Error(`no start line: ${out}`)), 20000);
      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf8');
        if (out.includes('Ctrl-C')) {
          clearTimeout(timer);
          done();
        }
      });
    });
    for (let tries = 0; tries < 100 && !existsSync(opened); tries++) await new Promise((wait) => setTimeout(wait, 50));
  } finally {
    child.kill();
  }
  assert.match(out, /The team is live at http:\/\/repo\.localhost:\d+\/\n/);
  assert.equal(/token|[0-9a-f]{32}/.test(out), false, `no key on the screen: ${out}`);
  // A positive control: the key exists, and only the browser got it.
  assert.match(readFileSync(opened, 'utf8'), /^http:\/\/repo\.localhost:\d+\/\?token=[0-9a-f]{32}$/);
  assert.equal(printableLink('http://repo.localhost:9/?token=abc'), 'http://repo.localhost:9/');
});

// #685: the browser opener for each system. The link is one word, never through a shell.
test('kanban: the browser opener for each system', () => {
  const url = 'http://repo.localhost:9/?token=abc';
  assert.deepEqual(browserCommand(url, 'darwin', {}), ['open', url]);
  assert.deepEqual(browserCommand(url, 'linux', {}), ['xdg-open', url]);
  assert.deepEqual(browserCommand(url, 'linux', { WSL_DISTRO_NAME: 'Ubuntu' }), ['explorer.exe', url], 'WSL opens the Windows browser');
  assert.deepEqual(browserCommand(url, 'win32', {}), ['rundll32', 'url.dll,FileProtocolHandler', url]);
  assert.equal(browserCommand(url, 'aix', {}), null);
});
