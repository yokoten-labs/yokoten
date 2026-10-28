// Tests for src/agents/desk/network/proxy.ts.

import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { connect, createServer } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { isAllowedTarget, type ProxyEvent, readConnectTarget, startProxy } from '../../../../src/agents/desk/network/proxy.ts';
import { makeTempDir } from '../../../repo/helpers.ts';

// The proxy listens on a Unix socket in the Linux and macOS desk. A desk on native Windows
// is not ready (#669), and a socket path there never connects, so the test hung for an hour.
const desksOnly = { skip: process.platform === 'win32' && 'the desk proxy runs in the Linux and macOS desk only (#669)' };

test('readConnectTarget: a CONNECT line with a host name and a port; nothing else', () => {
  assert.deepEqual(readConnectTarget('CONNECT API.Example.com.:443 HTTP/1.1\r\nHost: x'), { host: 'api.example.com', port: 443 });
  assert.equal(readConnectTarget('GET http://example.com/ HTTP/1.1'), null);
  assert.equal(readConnectTarget('CONNECT [::1]:443 HTTP/1.1'), null);
  assert.equal(readConnectTarget('CONNECT example.com HTTP/1.1'), null);
  assert.equal(readConnectTarget('CONNECT a b:443 HTTP/1.1'), null);
});

test('isAllowedTarget: the exact host on 443, or the port its entry names', () => {
  const hosts = ['api.example.com', 'localhost:8443'];
  assert.ok(isAllowedTarget({ host: 'api.example.com', port: 443 }, hosts));
  assert.ok(isAllowedTarget({ host: 'localhost', port: 8443 }, hosts));
  // Positive controls: each near miss is refused.
  assert.ok(!isAllowedTarget({ host: 'api.example.com', port: 22 }, hosts));
  assert.ok(!isAllowedTarget({ host: 'evil.api.example.com', port: 443 }, hosts));
  assert.ok(!isAllowedTarget({ host: 'example.com', port: 443 }, hosts));
  assert.ok(!isAllowedTarget({ host: 'localhost', port: 443 }, hosts));
});

/** Send `text` to the socket at `path`, and read until `until` shows or the socket closes. */
const talk = (path: string, text: string, until = '\u0000') =>
  new Promise<string>((resolve) => {
    let got = '';
    const socket = connect(path, () => socket.write(text));
    socket.on('data', (chunk) => {
      got += chunk;
      if (got.includes(until)) socket.destroy();
    });
    socket.on('close', () => resolve(got));
    socket.on('error', () => resolve(got));
  });

test('startProxy: tunnels to an allowed host, refuses others and anything not CONNECT', desksOnly, async () => {
  const echo = createServer((socket) => socket.on('data', (chunk) => socket.end(`echo:${chunk}`)));
  await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve));
  const port = (echo.address() as { port: number }).port;
  const events: ProxyEvent[] = [];
  const path = join(makeTempDir('proxy-'), 'proxy.sock');
  const proxy = await startProxy(path, [`localhost:${port}`], (event) => events.push(event));
  try {
    const allowed = await talk(path, `CONNECT localhost:${port} HTTP/1.1\r\n\r\nhi`, 'echo:hi');
    assert.match(allowed, /^HTTP\/1\.1 200 Connection Established\r\n\r\necho:hi$/);
    assert.match(await talk(path, 'CONNECT example.com:443 HTTP/1.1\r\n\r\n'), /^HTTP\/1\.1 403/);
    assert.match(await talk(path, 'GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n'), /^HTTP\/1\.1 405/);
    assert.match(await talk(path, `CONNECT localhost:${port} HTTP/1.1\r\n${'x'.repeat(9000)}`), /^HTTP\/1\.1 431/);
    assert.deepEqual(events, [
      { target: `localhost:${port}`, isAllowed: true },
      { target: 'example.com:443', isAllowed: false },
      { target: 'GET http://example.com/', isAllowed: false },
    ]);
  } finally {
    await proxy.close();
    echo.close();
  }
});

test('startProxy: listens on a port too, for a backend that has no socket', desksOnly, async () => {
  const proxy = await startProxy(0, []);
  try {
    const address = proxy.server.address() as { address: string; port: number };
    assert.equal(address.address, '127.0.0.1');
    assert.ok(address.port > 0);
  } finally {
    await proxy.close();
  }
});

test('startProxy: past the tunnel cap a CONNECT is refused; a still tunnel is closed', desksOnly, async () => {
  const echo = createServer((socket) => socket.on('data', (chunk) => socket.write(`echo:${chunk}`)));
  await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve));
  const port = (echo.address() as { port: number }).port;
  const path = join(makeTempDir('proxy-'), 'proxy.sock');
  const proxy = await startProxy(path, [`localhost:${port}`], () => {}, { maxTunnels: 1, idleMs: 100 });
  try {
    // The first tunnel stays open and still; the second is over the cap.
    const first = connect(path, () => first.write(`CONNECT localhost:${port} HTTP/1.1\r\n\r\n`));
    const closed = new Promise<number>((resolve) => {
      const opened = Date.now();
      first.on('close', () => resolve(Date.now() - opened));
    });
    await new Promise((resolve) => first.once('data', resolve));
    assert.match(await talk(path, `CONNECT localhost:${port} HTTP/1.1\r\n\r\n`), /^HTTP\/1\.1 503/);
    assert.ok((await closed) >= 60, 'the still tunnel is closed after its idle time');
  } finally {
    await proxy.close();
    echo.close();
  }
});

/**
 * A fake upstream proxy, as a host's corporate proxy: it notes each CONNECT head it gets,
 * wants the right Proxy-Authorization, and then acts as the far host itself (an echo), so
 * the allowed host name never has to resolve.
 */
async function fakeUpstream(authorization: string) {
  const heads: string[] = [];
  let connections = 0;
  const server = createServer((socket) => {
    connections++;
    let head = '';
    const onData = (chunk: Buffer) => {
      head += chunk.toString('latin1');
      const end = head.indexOf('\r\n\r\n');
      if (end === -1) return;
      socket.off('data', onData);
      heads.push(head.slice(0, end));
      if (!head.includes(`\r\nProxy-Authorization: ${authorization}\r\n`)) return socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\n\r\n');
      socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
      const early = head.slice(end + 4);
      if (early) socket.end(`echo:${early}`);
      else socket.once('data', (data) => socket.end(`echo:${data}`));
    };
    socket.on('data', onData);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, heads, port: (server.address() as { port: number }).port, connections: () => connections };
}

test('startProxy: with the host proxy set, an allowed host goes through it; an off-list host never reaches it; the password is never shown (#1172)', desksOnly, async () => {
  const password = 's3cret-pass';
  const authorization = `Basic ${Buffer.from(`desk-user:${password}`).toString('base64')}`;
  const upstream = await fakeUpstream(authorization);
  const { readHostProxy } = await import('../../../../src/agents/desk/network/upstream.ts');
  const choice = readHostProxy({ HTTPS_PROXY: `http://desk-user:${password}@127.0.0.1:${upstream.port}`, NO_PROXY: 'direct.example.test' });
  assert.ok(choice.proxy);
  assert.equal(choice.proxy.shown, `127.0.0.1:${upstream.port}`, 'the start screen gets host and port only');
  const events: ProxyEvent[] = [];
  const path = join(makeTempDir('proxy-'), 'proxy.sock');
  const proxy = await startProxy(path, ['api.example.test', 'direct.example.test'], (event) => events.push(event), undefined, choice.proxy);
  try {
    const allowed = await talk(path, 'CONNECT api.example.test:443 HTTP/1.1\r\nHost: api.example.test:443\r\n\r\nhi', 'echo:hi');
    assert.match(allowed, /^HTTP\/1\.1 200 Connection Established\r\n\r\necho:hi$/, 'the tunnel runs through the upstream');
    assert.deepEqual(upstream.heads, [`CONNECT api.example.test:443 HTTP/1.1\r\nHost: api.example.test:443\r\nProxy-Authorization: ${authorization}`], 'one CONNECT, with the login, to the allowed host');
    assert.equal(upstream.connections(), 1);
    // Off the list: refused here, before any upstream call.
    assert.match(await talk(path, 'CONNECT evil.example.test:443 HTTP/1.1\r\n\r\n'), /^HTTP\/1\.1 403/);
    assert.match(await talk(path, 'CONNECT api.example.test:22 HTTP/1.1\r\n\r\n'), /^HTTP\/1\.1 403/);
    assert.equal(upstream.connections(), 1, 'the upstream never heard of an off-list host');
    // NO_PROXY: dialled directly, so the upstream sees nothing (the name does not resolve, so the tunnel fails: 502).
    assert.match(await talk(path, 'CONNECT direct.example.test:443 HTTP/1.1\r\n\r\n'), /^HTTP\/1\.1 502/);
    assert.equal(upstream.connections(), 1, 'a NO_PROXY host is not sent to the upstream');
    const shown = JSON.stringify(events) + allowed;
    assert.ok(!shown.includes(password) && !shown.includes(authorization), 'no password in what the desk hears or shows');
  } finally {
    await proxy.close();
    upstream.server.close();
  }
});

test('startProxy: an upstream that refuses the tunnel gives the client 502 and nothing of its answer (#1172)', desksOnly, async () => {
  const upstream = await fakeUpstream('Basic right');
  const { readHostProxy } = await import('../../../../src/agents/desk/network/upstream.ts');
  const choice = readHostProxy({ HTTPS_PROXY: `http://wrong:login@127.0.0.1:${upstream.port}` });
  const path = join(makeTempDir('proxy-'), 'proxy.sock');
  const proxy = await startProxy(path, ['api.example.test'], () => {}, undefined, choice.proxy);
  try {
    const answer = await talk(path, 'CONNECT api.example.test:443 HTTP/1.1\r\n\r\n');
    assert.match(answer, /^HTTP\/1\.1 502 Bad Gateway\r\n/);
    assert.ok(!answer.includes('407') && !answer.includes('Proxy-Authenticate'), "the upstream's answer is not passed on");
  } finally {
    await proxy.close();
    upstream.server.close();
  }
});
