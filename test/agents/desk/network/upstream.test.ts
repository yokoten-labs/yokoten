// Tests for src/agents/desk/network/upstream.ts: the host's proxy, as the desk reads it (#1172).

import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bypassesUpstream, readHostProxy, readNoProxy } from '../../../../src/agents/desk/network/upstream.ts';

test('readHostProxy: HTTPS_PROXY, else https_proxy; host and port shown, the password only in the header (case table)', () => {
  const cases: { env: Record<string, string>; shown: string | null; authorization?: string | null }[] = [
    { env: {}, shown: null },
    { env: { HTTPS_PROXY: '  ' }, shown: null },
    { env: { HTTPS_PROXY: 'http://example.com:3128' }, shown: 'example.com:3128', authorization: null },
    { env: { https_proxy: 'example.com:8080' }, shown: 'example.com:8080', authorization: null },
    { env: { HTTPS_PROXY: 'http://example.com' }, shown: 'example.com:80', authorization: null },
    { env: { HTTPS_PROXY: 'http://a:1', https_proxy: 'http://b:2' }, shown: 'a:1' },
    { env: { HTTPS_PROXY: 'http://[::1]:3128' }, shown: '[::1]:3128' },
    { env: { HTTPS_PROXY: 'http://us%40er:p%3Ass@example.com:3128/' }, shown: 'example.com:3128', authorization: `Basic ${Buffer.from('us@er:p:ss').toString('base64')}` },
    // HTTP_PROXY alone is not read: curl does not use it for an https:// address either.
    { env: { HTTP_PROXY: 'http://example.com:3128' }, shown: null },
  ];
  for (const { env, shown, authorization } of cases) {
    const { proxy, problem } = readHostProxy(env);
    assert.equal(problem, null, JSON.stringify(env));
    assert.equal(proxy?.shown ?? null, shown, JSON.stringify(env));
    if (authorization !== undefined) assert.equal(proxy?.authorization, authorization, JSON.stringify(env));
    if (proxy) assert.ok(!proxy.shown.includes('@') && !proxy.shown.includes('ss'), 'shown holds no user or password');
  }
  assert.equal(readHostProxy({ HTTPS_PROXY: 'http://u:pw@h:1' }).proxy?.url, 'http://u:pw@h:1');
});

test('readHostProxy: a value it cannot use is set aside with a reason that never holds the value', () => {
  for (const value of ['https://user:s3cret@example.com:443', 'socks5://user:s3cret@example.com:1080', 'http://user:s3cret@:99999', 'http://user:%E0%A4%A@example.com:1']) {
    const { proxy, problem } = readHostProxy({ HTTPS_PROXY: value });
    assert.equal(proxy, null, value);
    assert.match(problem ?? '', /^HTTPS_PROXY is set but not used: .*connects to its API hosts directly\.$/, value);
    assert.ok(!(problem ?? '').includes('s3cret') && !(problem ?? '').includes('example.com'), `the reason hides the value: ${problem}`);
  }
});

test('bypassesUpstream: loopback and NO_PROXY matches go direct; every other host goes through (case table)', () => {
  const proxy = readHostProxy({ HTTPS_PROXY: 'http://example.com:3128', NO_PROXY: ' .Internal.example, exact.example:443 ,*.wild.example,' }).proxy;
  assert.ok(proxy);
  assert.deepEqual(proxy.noProxy, ['.internal.example', 'exact.example', '.wild.example']);
  const cases: [string, boolean][] = [
    ['localhost', true],
    ['127.0.0.1', true],
    ['a.internal.example', true],
    ['internal.example', true],
    ['exact.example', true],
    ['sub.exact.example', true],
    ['x.wild.example', true],
    ['api.anthropic.com', false],
    ['notinternal.example', false],
    ['exact.example.evil', false],
  ];
  for (const [host, direct] of cases) assert.equal(bypassesUpstream(proxy, host), direct, host);
  const all = readHostProxy({ HTTPS_PROXY: 'http://p:1', no_proxy: '*' }).proxy;
  assert.ok(all && bypassesUpstream(all, 'api.anthropic.com'));
  assert.deepEqual(readNoProxy('[::1]:80,192.0.2.1'), ['::1', '192.0.2.1']);
});
