// The host's own proxy, for the desk's door (#1172). On some networks the model API hosts
// are reached only through the proxy the host names in HTTPS_PROXY; a desk that connects
// to them directly gets `403 Request not allowed`. So the desk's proxy (proxy.ts), and
// sandbox-runtime's (fence/srt.ts), chain an allowed tunnel through that proxy. The
// allowlist does not change: a host off the list is refused before the upstream hears of it.
//
// The proxy URL may hold a user name and password. They go only into the
// `Proxy-Authorization` header sent to the upstream, or into srt's own environment (srt
// sets the agent's proxy names to itself). What the desk prints is `shown`, host and port.
// Pure: it reads the names it is given, never `process.env`.

import type { Env } from '../../../rules/config.ts';

/** The host's proxy, as the desk dials it. */
export interface UpstreamProxy {
  /** The proxy's host name or address, without brackets. */
  host: string;
  port: number;
  /** The `Proxy-Authorization` value, or null when the URL names no user. Never printed. */
  authorization: string | null;
  /** The proxy as a plain `http://` URL, user and password included, for srt's own environment. Never printed. */
  url: string;
  /** The NO_PROXY entries, lower case, without a port: a host that matches one is dialled directly. */
  noProxy: string[];
  /** What the desk may print: `host:port`, never the user or password. */
  shown: string;
}

/** What the desk takes from the host's environment: the proxy, or the plain reason one set there is not used. */
export interface UpstreamChoice {
  proxy: UpstreamProxy | null;
  /** One line, naming the variable but never its value (it may hold a password). Null when all is well. */
  problem: string | null;
}

/** The names read for the upstream, in order: curl reads these for an https:// address. */
const PROXY_NAMES = ['HTTPS_PROXY', 'https_proxy'] as const;

/** The NO_PROXY entries, as `bypassesUpstream` compares them. */
export function readNoProxy(raw: string): string[] {
  const entries: string[] = [];
  for (const part of raw.split(',')) {
    let entry = part.trim().toLowerCase();
    if (!entry) continue;
    const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(entry);
    if (bracketed) entry = bracketed[1];
    else if (!entry.includes('::')) entry = entry.replace(/:\d+$/, '');
    entries.push(entry.replace(/^\*\./, '.').replace(/\.$/, ''));
  }
  return entries;
}

/**
 * The host's proxy from `env` (HTTPS_PROXY, else https_proxy), with NO_PROXY (else no_proxy).
 * Only an `http://` proxy (or a bare `host:port`) is used; any other value is set aside with
 * a reason, and the desk dials directly, as it did before. The reason never holds the value.
 */
export function readHostProxy(env: Env): UpstreamChoice {
  const name = PROXY_NAMES.find((key) => (env[key] ?? '').trim() !== '');
  if (!name) return { proxy: null, problem: null };
  const raw = (env[name] as string).trim();
  const unused = (why: string): UpstreamChoice => ({ proxy: null, problem: `${name} is set but not used: ${why}. The desk connects to its API hosts directly.` });
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch {
    return unused('it is not a URL');
  }
  if (url.protocol !== 'http:') return unused('the desk speaks only to an http:// proxy');
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  if (!host) return unused('it names no host');
  const port = url.port ? Number(url.port) : 80;
  let authorization: string | null = null;
  if (url.username || url.password) {
    let user: string;
    let password: string;
    try {
      user = decodeURIComponent(url.username);
      password = decodeURIComponent(url.password);
    } catch {
      return unused('its user name or password is not valid URL text');
    }
    authorization = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
  }
  const userinfo = url.username || url.password ? `${url.username}:${url.password}@` : '';
  const authority = host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
  const noProxy = readNoProxy(env.NO_PROXY ?? env.no_proxy ?? '');
  return { proxy: { host, port, authorization, url: `http://${userinfo}${authority}`, noProxy, shown: authority }, problem: null };
}

/** True for a name that means this machine: those are never sent to the upstream. */
const isLoopback = (host: string): boolean => host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);

/**
 * Whether a tunnel to `host` skips the upstream and is dialled directly: a loopback name,
 * or a NO_PROXY match (`*`, the host itself, or a domain it is under).
 */
export function bypassesUpstream(proxy: UpstreamProxy, host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, '');
  if (isLoopback(name)) return true;
  return proxy.noProxy.some((entry) => {
    if (entry === '*') return true;
    const domain = entry.replace(/^\./, '');
    return domain !== '' && (name === domain || name.endsWith(`.${domain}`));
  });
}
