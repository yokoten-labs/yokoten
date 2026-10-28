// The desk's network door (#637). Commands in a desk get no network; the agent program
// reaches its model's API through this proxy, which runs outside the desk. It takes HTTP
// CONNECT only, to a host on the list and port 443 (or the port the entry names), and
// refuses everything else. It never
// reads what passes through the tunnel: the agent speaks TLS to the API host itself.
//
// When the host names its own proxy (HTTPS_PROXY, upstream.ts), an allowed tunnel goes
// through it, with one CONNECT of its own; the list is checked first, so a host off the
// list never reaches the upstream (#1172).
//
// It listens on whatever Node's `net` takes: a Unix socket path, a Windows pipe name, or a
// TCP port. So it holds no code for one system; each desk backend chooses the address.

import { connect, createServer, type Server, type Socket } from 'node:net';
import { bypassesUpstream, type UpstreamProxy } from './upstream.ts';

/** The longest request head the proxy reads before it refuses: a CONNECT line is short. */
const MAX_HEAD_BYTES = 8 * 1024;

/** How long a client has to send its request head. */
const HEAD_TIMEOUT_MS = 10_000;

/** The most tunnels open at once. One agent needs a few; more is a command trying its luck. */
export const MAX_TUNNELS = 64;

/** A tunnel with no bytes either way for this long is closed. */
export const IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/** The one port a tunnel may reach: HTTPS. */
const ALLOWED_PORT = 443;

/** One line a proxy writes for each request it saw: what was asked, and if it was let through. */
export interface ProxyEvent {
  target: string;
  isAllowed: boolean;
}

/** How many tunnels may be open at once, and how long one may sit still. */
export interface ProxyLimits {
  maxTunnels: number;
  idleMs: number;
}

/** A proxy that runs until `close`. */
export interface DeskProxy {
  server: Server;
  close: () => Promise<void>;
}

/** A host name as the proxy compares it: lower case, with no trailing dot. */
const normalHost = (host: string): string => host.toLowerCase().replace(/\.$/, '');

/**
 * The host and port a CONNECT request names, or null when the head is not a CONNECT
 * line with a plain `host:443`. A bracketed IPv6 address or a raw IP is not a host name
 * on the list, so it is refused here too.
 */
export function readConnectTarget(head: string): { host: string; port: number } | null {
  const line = head.split('\r\n', 1)[0];
  const match = /^CONNECT ([A-Za-z0-9.-]+):(\d{1,5}) HTTP\/1\.[01]$/.exec(line);
  if (!match) return null;
  return { host: normalHost(match[1]), port: Number(match[2]) };
}

/**
 * Whether a tunnel to `host:port` is allowed: a host on the list, exactly, and port 443.
 * An entry may name its own port (`host:8443`); then only that port.
 */
export function isAllowedTarget(target: { host: string; port: number }, hosts: readonly string[]): boolean {
  return hosts.some((entry) => {
    const match = /^(.*):(\d{1,5})$/.exec(entry);
    const [host, port] = match ? [match[1], Number(match[2])] : [entry, ALLOWED_PORT];
    return normalHost(host) === target.host && port === target.port;
  });
}

/** Refuse a client with a short HTTP answer, then close. */
function refuse(client: Socket, status: string): void {
  client.end(`HTTP/1.1 ${status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
}

/**
 * Open the connection a tunnel to `target` runs on: straight to the host, or through the
 * host's proxy with a CONNECT. `onReady` gets the bytes the upstream sent after its answer;
 * `onRefused` is called when the upstream answers with anything but 2xx, says too much, or
 * says nothing in time. The upstream's answer is never passed on or logged: only its status
 * is read.
 */
export function openRemote(target: { host: string; port: number }, upstream: UpstreamProxy | null, onReady: (early: Buffer) => void, onRefused: () => void): Socket {
  if (!upstream || bypassesUpstream(upstream, target.host)) {
    const direct = connect({ host: target.host, port: target.port });
    direct.on('connect', () => onReady(Buffer.alloc(0)));
    return direct;
  }
  const via = connect({ host: upstream.host, port: upstream.port });
  let answer = Buffer.alloc(0);
  const stop = (ready?: Buffer) => {
    clearTimeout(timer);
    via.off('data', onAnswer);
    if (ready) onReady(ready);
    else onRefused();
  };
  const timer = setTimeout(() => stop(), HEAD_TIMEOUT_MS);
  const onAnswer = (chunk: Buffer) => {
    answer = Buffer.concat([answer, chunk]);
    const end = answer.indexOf('\r\n\r\n');
    if (end === -1) {
      if (answer.length > MAX_HEAD_BYTES) stop();
      return;
    }
    const status = answer.subarray(0, answer.indexOf('\r\n')).toString('latin1');
    if (/^HTTP\/1\.[01] 2\d\d(?: |$)/.test(status)) stop(answer.subarray(end + 4));
    else stop();
  };
  via.on('connect', () => {
    // The host was checked by readConnectTarget: letters, digits, dots and dashes only.
    const authority = `${target.host}:${target.port}`;
    const auth = upstream.authorization ? `Proxy-Authorization: ${upstream.authorization}\r\n` : '';
    via.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth}\r\n`);
    via.on('data', onAnswer);
  });
  via.on('close', () => clearTimeout(timer));
  return via;
}

/** Handle one client: read the head, check it, then open the tunnel or refuse. */
function handleClient(client: Socket, hosts: readonly string[], onEvent: (event: ProxyEvent) => void, tunnels: Set<Socket>, limits: ProxyLimits, upstreamProxy: UpstreamProxy | null): void {
  let head = Buffer.alloc(0);
  client.setTimeout(HEAD_TIMEOUT_MS, () => client.destroy());
  client.on('error', () => client.destroy());
  const onData = (chunk: Buffer) => {
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf('\r\n\r\n');
    if (end === -1) {
      if (head.length > MAX_HEAD_BYTES) refuse(client, '431 Request Header Fields Too Large');
      return;
    }
    client.off('data', onData);
    client.setTimeout(0);
    const text = head.subarray(0, end).toString('latin1');
    const target = readConnectTarget(text);
    const label = target ? `${target.host}:${target.port}` : (text.split('\r\n', 1)[0].split(' ', 2).join(' ') || '(empty)');
    if (!target || !isAllowedTarget(target, hosts)) {
      onEvent({ target: label, isAllowed: false });
      refuse(client, target ? '403 Forbidden' : '405 Method Not Allowed');
      return;
    }
    if (tunnels.size >= limits.maxTunnels) {
      onEvent({ target: `${label} (too many tunnels)`, isAllowed: false });
      refuse(client, '503 Service Unavailable');
      return;
    }
    onEvent({ target: label, isAllowed: true });
    // Bytes the client sent after the head (a TLS hello sent early) go on to the host.
    const rest = head.subarray(end + 4);
    let isRefused = false;
    const upstream = openRemote(
      target,
      upstreamProxy,
      (early) => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (early.length) client.write(early);
        if (rest.length) upstream.write(rest);
        client.pipe(upstream);
        upstream.pipe(client);
      },
      () => {
        isRefused = true;
        refuse(client, '502 Bad Gateway');
        upstream.destroy();
      },
    );
    tunnels.add(upstream);
    upstream.on('close', () => tunnels.delete(upstream));
    // A tunnel that sits still is closed, so a stuck one does not hold a place for ever.
    for (const socket of [client, upstream]) socket.setTimeout(limits.idleMs, () => {
      client.destroy();
      upstream.destroy();
    });
    upstream.on('error', () => {
      if (!client.destroyed && client.bytesWritten === 0) refuse(client, '502 Bad Gateway');
      else client.destroy();
    });
    client.on('close', () => upstream.destroy());
    // A refused tunnel lets its 502 go out: `refuse` ends the client itself.
    upstream.on('close', () => {
      if (!isRefused) client.destroy();
    });
  };
  client.on('data', onData);
}

/**
 * Start the proxy on `address` (a socket path, a pipe name or a port). It lets through a
 * CONNECT to a host on `hosts` and port 443, and nothing else. `onEvent` hears of every
 * request, for the desk's log line; it never gets a byte of a tunnel. With `upstream` (the
 * host's proxy, upstream.ts), an allowed tunnel goes through it unless NO_PROXY says not.
 */
export function startProxy(
  address: string | number,
  hosts: readonly string[],
  onEvent: (event: ProxyEvent) => void = () => {},
  limits: ProxyLimits = { maxTunnels: MAX_TUNNELS, idleMs: IDLE_TIMEOUT_MS },
  upstream: UpstreamProxy | null = null,
): Promise<DeskProxy> {
  const sockets = new Set<Socket>();
  const tunnels = new Set<Socket>();
  const server = createServer((client) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    handleClient(client, hosts, onEvent, tunnels, limits, upstream);
  });
  const close = () =>
    new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    const done = () => {
      server.off('error', reject);
      resolve({ server, close });
    };
    if (typeof address === 'number') server.listen(address, '127.0.0.1', done);
    else server.listen(address, done);
  });
}
