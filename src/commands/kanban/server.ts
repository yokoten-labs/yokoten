// `yokoten kanban` (#601, #603, record 0044): serves the team's kanban on this machine only.
//
// Read only. Two routes carry data: `GET /api/state` answers one KanbanState (state.ts), and
// `GET /api/sessions/<id>/stream` sends one session's output as server-sent events, masked.
// `/` and `/assets/*` serve the built page from web/kanban/dist; without it, `/` says in one
// line that the page is not built. Any method but GET and HEAD gets a 405: nothing here
// starts, stops or changes work. gh reads in the background, one read at a time, and
// /api/state serves its last lists (#688). `kanban --text` prints the same state. A request
// needs the right Host and the kanban's cookie. The first visit, with ?token=, sets that
// cookie and redirects. The token goes only to the browser: it is never printed (#1045).

import { spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { basename, extname, join } from 'node:path';
import { ghIn, ghLaterIn, type GhLater, readBoardPulls, readBoardPullsLater, repoOf } from '../../host/github/index.ts';
import { type Env } from '../../rules/config.ts';
import { HOME_DIR } from '../../setup/files.ts';
import { readOriginUrl } from '../../setup/plan.ts';
import { actionsRunPage, actionsRunsQuery, type HealthRun, healthReadFailed, readActionsRuns, readDefaultBranch } from '../more/check.ts';
import { type Invocation, parse, print, requireRoot, usage } from '../shared.ts';
import { BOARD_READ_TIMEOUT_MS } from './agents.ts';
import { makeBoardMask, makeFeedStreams, sessionAnswer } from './feed/route.ts';
import { type StreamAnswer } from './feed/tail.ts';
import { collectState, renderStateText } from './state.ts';
import type { KanbanState } from './types.ts';
import { BOARD_NO_REMOTE_PULLS, BOARD_READING_GITHUB, type BoardGitHub, createBoardGitHub, refreshBoardGitHub } from './view.ts';

/** How many random bytes the link's token holds. */
const BOARD_TOKEN_BYTES = 16;

/** The cookie that carries the token after the first visit (#693). */
const BOARD_COOKIE = 'yokoten-board';

/** Ports the kanban tries first: a high range, stable for one repo path. */
const BOARD_PORT_BASE = 28416;

/** How many ports share that range. A taken port tries the next few, then any free port. */
const BOARD_PORT_SPAN = 4000;

/** How many ports past the stable one to try before asking the system for any port. */
const BOARD_PORT_TRIES = 32;

/** How often GitHub is read again, at most: the page reads /api/state every 15 seconds. */
const GITHUB_EVERY_MS = 15_000;

/** How often an open stream looks for new output. */
const STREAM_EVERY_MS = 2_000;

/** Paths a first visit may return to. Anything else returns to `/`. */
const BOARD_PATHS = new Set(['/', '/api/state']);

/** The built page, in the package (record 0044). */
export const KANBAN_PAGE_DIR = join(HOME_DIR, 'web', 'kanban', 'dist');

/** What `/` says when the page is not built. */
export const PAGE_NOT_BUILT = 'The kanban page is not built: run `npm --prefix web/kanban run build`. /api/state works now.';

/** The kinds of file the page folder serves. Any other file is not found. */
const PAGE_KINDS: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
};

/** A file name in /assets: letters, digits, dot, dash and underscore, and no leading dot. */
const ASSET_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;

/** The content policy: nothing loads from outside, and only the page's own scripts run. */
const CONTENT_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** One answer of the server: the status, the kind, and the body. Nothing is stored, and the page sends no referrer. */
function serveText(res: ServerResponse, status: number, kind: string, body: string | Buffer, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': kind,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

/** A JSON error answer: one plain sentence. */
function serveError(res: ServerResponse, status: number, error: string): void {
  serveText(res, status, 'application/json; charset=utf-8', JSON.stringify({ error }));
}

/**
 * The repo folder as one hostname label (#693). Letters and digits stay.
 * Anything else becomes a hyphen. An empty label is `board`.
 */
export function boardHostName(root: string): string {
  const label = basename(root).normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63).replace(/-+$/g, '');
  return label || 'board';
}

/** The first port this repo asks for: a stable hash of its real path, in a high range. */
export function boardPort(root: string): number {
  let path = root;
  try {
    path = realpathSync(root);
  } catch {
    // The folder is not there yet: hash the path as given.
  }
  const hash = createHash('sha256').update(path).digest();
  return BOARD_PORT_BASE + (hash.readUInt32BE(0) % BOARD_PORT_SPAN);
}

/**
 * True when the Host header names this server: `<repo>.localhost:<port>`,
 * `127.0.0.1:<port>` or `localhost:<port>`. Any other host gets a 403.
 */
function isBoardHost(host: string | undefined, port: number, name: string): boolean {
  const clean = (host ?? '').trim().toLowerCase();
  return clean === `${name}.localhost:${port}` || clean === `127.0.0.1:${port}` || clean === `localhost:${port}`;
}

/** True when the given token matches, compared in constant time. A missing token, or one of another length, never reaches the compare. */
function isBoardToken(given: string | null, token: string): boolean {
  if (given === null) return false;
  const guess = Buffer.from(given, 'utf8');
  const want = Buffer.from(token, 'utf8');
  return guess.length === want.length && timingSafeEqual(guess, want);
}

/**
 * The cookie the first visit sets. The token is hex, so it needs no extra encoding.
 * No Domain, so it stays on this host. Secure is stored on *.localhost, a secure context.
 */
function boardSetCookie(token: string): string {
  return `${BOARD_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/`;
}

/** The cookie's token, or null when the cookie is missing. */
function boardCookieToken(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const cut = part.trim();
    const eq = cut.indexOf('=');
    if (eq > 0 && cut.slice(0, eq) === BOARD_COOKIE) return cut.slice(eq + 1);
  }
  return null;
}

/**
 * Where a first visit returns, with the token removed. Only the kanban's own paths
 * are kept, so a token cannot turn into an open redirect.
 */
function boardReturnPath(path: string, query: URLSearchParams): string {
  const safe = BOARD_PATHS.has(path) ? path : '/';
  query.delete('token');
  const rest = query.toString();
  return rest ? `${safe}?${rest}` : safe;
}

/** What the options carry. Tests pass their own. */
export interface BoardServerOptions {
  github?: BoardGitHub;
  /** The mask for the stream. Tests pass their own; the kanban builds it from the private marks. */
  feedMask?: (text: string) => string;
  /** The built page's folder. Tests pass their own. */
  pageDir?: string;
  /** How often a stream looks for new output, in ms. Tests pass a short one. */
  streamEveryMs?: number;
}

/**
 * Every string value in a payload, masked once. Keys stay, so the page can
 * still read them. A new field cannot skip this walk.
 */
export function maskBoardPayload(value: unknown, mask: (text: string) => string): unknown {
  if (typeof value === 'string') return mask(value);
  if (Array.isArray(value)) return value.map((item) => maskBoardPayload(item, mask));
  if (value !== null && typeof value === 'object') {
    const masked: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) masked[key] = maskBoardPayload(item, mask);
    return masked;
  }
  return value;
}

/** The /api/state body. Every string is masked at this boundary, then sent as JSON. */
export function boardDataBody(env: Env, root: string, payload: unknown): string {
  return JSON.stringify(maskBoardPayload(payload, makeBoardMask(env, root)));
}

/** One file of the built page, or null when the name is not one it serves. */
function pageFile(dir: string, name: string): { kind: string; body: Buffer } | null {
  const kind = PAGE_KINDS[extname(name).toLowerCase()];
  if (!kind) return null;
  try {
    return { kind, body: readFileSync(join(dir, name)) };
  } catch {
    return null;
  }
}

/** The Actions runs and the branch merges land on, without blocking. A failed read says why. */
async function readActionsLater(gh: GhLater, repo: string, signal: AbortSignal): Promise<{ runs: HealthRun[] | string; defaultBranch: string }> {
  const [runs, branch] = await Promise.all([
    (async () => {
      try {
        const page = actionsRunPage(await gh(actionsRunsQuery(repo), signal));
        return typeof page === 'string' ? page : page.runs;
      } catch (err) {
        return healthReadFailed(err, 'Actions runs');
      }
    })(),
    (async () => {
      try {
        return (await gh(['repo', 'view', repo, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'], signal)).trim() || 'main';
      } catch {
        return 'main';
      }
    })(),
  ]);
  return { runs, defaultBranch: branch };
}

/**
 * Start the kanban on 127.0.0.1. The link is `http://<repo>.localhost:<port>/?token=...`,
 * and the port stays with the repo path. The first visit sets a cookie and redirects to
 * the address without the token. Later requests must send that cookie. A wrong Host, a
 * missing cookie or a wrong cookie gets a 403; any method but GET and HEAD gets a 405.
 * gh reads in the background: the first read starts now, and /api/state never waits for it.
 */
export function startBoardServer(root: string, env: Env, gh: GhLater, options: BoardServerOptions = {}): Promise<{ server: Server; url: string }> {
  const token = randomBytes(BOARD_TOKEN_BYTES).toString('hex');
  const hostName = boardHostName(root);
  const pageDir = options.pageDir ?? KANBAN_PAGE_DIR;
  const github = options.github ?? createBoardGitHub();
  let actions: { runs: HealthRun[] | string; defaultBranch: string } = { runs: BOARD_READING_GITHUB, defaultBranch: 'main' };
  const stopReads = new AbortController();
  const streamTimers = new Set<NodeJS.Timeout>();
  // The GitHub repo, or null without a GitHub remote. Starts a background read when the lists are old.
  const refreshGitHub = (): string | null => {
    const remote = repoOf(readOriginUrl(root, env));
    if (!remote) return null;
    const read = async () => {
      const [pulls, health] = await Promise.all([readBoardPullsLater(gh, remote, stopReads.signal), readActionsLater(gh, remote, stopReads.signal)]);
      if (typeof health.runs !== 'string' || typeof actions.runs === 'string') actions = health;
      return { pulls, issues: [] };
    };
    refreshBoardGitHub(github, remote, read, GITHUB_EVERY_MS);
    return remote;
  };
  const streams = makeFeedStreams(env, root, options.feedMask);
  const server = createServer((req, res) => {
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    if (!isBoardHost(req.headers.host, port, hostName)) return serveText(res, 403, 'text/plain; charset=utf-8', 'forbidden');
    // Read only (record 0044): no route changes anything, so every other method is refused.
    if (req.method !== 'GET' && req.method !== 'HEAD') return serveText(res, 405, 'text/plain; charset=utf-8', 'the kanban is read only', { allow: 'GET, HEAD' });
    const [path, queryText] = (req.url ?? '').split('?');
    const query = new URLSearchParams(queryText ?? '');
    // The query token only starts a visit. It never authorizes a request.
    const fromLink = query.get('token');
    if (fromLink !== null) {
      if (!isBoardToken(fromLink, token)) return serveText(res, 403, 'text/plain; charset=utf-8', 'forbidden');
      return serveText(res, 303, 'text/plain; charset=utf-8', '', { location: boardReturnPath(path || '/', query), 'set-cookie': boardSetCookie(token) });
    }
    if (!isBoardToken(boardCookieToken(req.headers.cookie), token)) return serveText(res, 403, 'text/plain; charset=utf-8', 'forbidden');
    if (path === '/') {
      const page = existsSync(join(pageDir, 'index.html')) ? pageFile(pageDir, 'index.html') : null;
      if (!page) return serveText(res, 200, 'text/plain; charset=utf-8', `${PAGE_NOT_BUILT}\n`);
      return serveText(res, 200, page.kind, page.body, { 'content-security-policy': CONTENT_POLICY });
    }
    if (path.startsWith('/assets/')) {
      const name = path.slice('/assets/'.length);
      const file = ASSET_NAME.test(name) ? pageFile(join(pageDir, 'assets'), name) : null;
      if (!file) return serveText(res, 404, 'text/plain; charset=utf-8', 'not found');
      return serveText(res, 200, file.kind, file.body);
    }
    if (path === '/api/state') {
      try {
        const remote = refreshGitHub();
        const sources = remote
          ? { remote, pulls: github.pulls, runs: actions.runs, defaultBranch: actions.defaultBranch }
          : { remote: null, pulls: BOARD_NO_REMOTE_PULLS, runs: [], defaultBranch: 'main' };
        return serveText(res, 200, 'application/json; charset=utf-8', boardDataBody(env, root, collectState(root, env, sources)));
      } catch {
        return serveError(res, 500, 'the kanban could not be read: run it again');
      }
    }
    const stream = /^\/api\/sessions\/([0-9a-f]{16})\/stream$/.exec(path);
    if (stream) {
      const id = stream[1];
      let cursor = String(req.headers['last-event-id'] ?? '');
      const next = () => sessionAnswer(streams, root, env, id, cursor);
      let first: StreamAnswer | null = null;
      try {
        first = next();
      } catch {
        return serveError(res, 500, 'the kanban could not read that log safely: run it again');
      }
      if (!first) return serveError(res, 404, 'no session with that id');
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
      if (req.method === 'HEAD') return res.end();
      const send = (answer: StreamAnswer) => {
        cursor = answer.next;
        res.write(`id: ${answer.next}\ndata: ${JSON.stringify(answer)}\n\n`);
      };
      send(first);
      const timer = setInterval(() => {
        try {
          const answer = next();
          if (!answer) {
            res.end('event: gone\ndata: {}\n\n');
            return stop();
          }
          if (answer.items.length || answer.reset) send(answer);
          else res.write(': still here\n\n');
        } catch {
          // A mask that cannot be built sends nothing more.
          res.end('event: failed\ndata: {}\n\n');
          stop();
        }
      }, options.streamEveryMs ?? STREAM_EVERY_MS);
      const stop = () => {
        clearInterval(timer);
        streamTimers.delete(timer);
      };
      streamTimers.add(timer);
      // The answer closes when the page goes; the request may close as soon as it is read.
      res.on('close', stop);
      return;
    }
    return serveText(res, 404, 'text/plain; charset=utf-8', 'not found');
  });
  server.on('close', () => {
    stopReads.abort();
    for (const timer of streamTimers) clearInterval(timer);
  });
  return new Promise((done, failed) => {
    const first = boardPort(root);
    let attempt = 0;
    let hasTriedAnyPort = false;
    const listenAt = (port: number) => {
      const onError = (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EADDRINUSE') {
          failed(error);
          return;
        }
        if (attempt < BOARD_PORT_TRIES) {
          attempt += 1;
          listenAt(first + attempt);
          return;
        }
        if (!hasTriedAnyPort) {
          hasTriedAnyPort = true;
          listenAt(0);
          return;
        }
        failed(error);
      };
      server.once('error', onError);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', onError);
        // A later error is handled, so it never becomes an uncaught throw.
        server.on('error', () => {});
        try {
          refreshGitHub();
        } catch {
          // The first /api/state starts the read instead.
        }
        const address = server.address();
        const bound = typeof address === 'object' && address !== null ? address.port : 0;
        done({ server, url: `http://${hostName}.localhost:${bound}/?token=${token}` });
      });
    };
    listenAt(first);
  });
}

/** The link without its token: the only form of it the kanban prints (#1045). */
export function printableLink(url: string): string {
  const link = new URL(url);
  link.search = '';
  return link.toString();
}

/**
 * The program that opens a link in the default browser (#685), as a command and its words,
 * or null where none is known. WSL opens the Windows browser. The link goes as one word,
 * never through a shell.
 */
export function browserCommand(url: string, platform: NodeJS.Platform, env: Env): string[] | null {
  if (platform === 'darwin') return ['open', url];
  if (platform === 'win32') return ['rundll32', 'url.dll,FileProtocolHandler', url];
  if (platform === 'linux') return env.WSL_DISTRO_NAME ? ['explorer.exe', url] : ['xdg-open', url];
  return null;
}

/** Open the link in the browser, and never wait or fail. */
function openInBrowser(url: string, env: Env): void {
  const command = browserCommand(url, process.platform, env);
  if (!command) return;
  try {
    const child = spawn(command[0], command.slice(1), { detached: true, stdio: 'ignore', env });
    child.on('error', () => {});
    child.unref();
  } catch {
    // No browser to open: the printed line says how to try again.
  }
}

export function runBoard(invocation: Invocation, options: BoardServerOptions = {}): number | Promise<number> {
  const parsed = parse('kanban', invocation.args);
  if (typeof parsed === 'string') return usage(invocation, parsed);
  const root = requireRoot(invocation, invocation.cwd);
  if (!root) return 1;
  if (parsed.flags.has('--text')) {
    const gh = ghIn(root, invocation.env, BOARD_READ_TIMEOUT_MS);
    const remote = repoOf(readOriginUrl(root, invocation.env));
    const sources = remote
      ? { remote, pulls: readBoardPulls(gh, remote), runs: readActionsRuns(gh, remote, 100), defaultBranch: readDefaultBranch(gh, remote) }
      : { remote: null, pulls: BOARD_NO_REMOTE_PULLS, runs: [], defaultBranch: 'main' };
    const state = maskBoardPayload(collectState(root, invocation.env, sources), makeBoardMask(invocation.env, root));
    print(invocation, renderStateText(state as KanbanState));
    return 0;
  }
  return startBoardServer(root, invocation.env, ghLaterIn(root, invocation.env, BOARD_READ_TIMEOUT_MS), options).then(
    ({ url }) => {
      const isOpening = !parsed.flags.has('--no-open');
      // The link with its token goes only to the browser; the screen shows it without (#1045).
      print(invocation, [
        'yokoten kanban: preview, read only. It may change.',
        `The team is live at ${printableLink(url)}`,
        isOpening ? 'It opens in your browser now, signed in. Stop it with Ctrl-C.' : 'The sign-in link goes only to your browser: run `yokoten kanban` without --no-open to open it. Stop it with Ctrl-C.',
      ]);
      if (isOpening) openInBrowser(url, invocation.env);
      return new Promise<number>(() => {});
    },
    () => {
      print(invocation, ['yokoten kanban: the page could not start: run it again.'], invocation.stderr);
      return 1;
    },
  );
}
