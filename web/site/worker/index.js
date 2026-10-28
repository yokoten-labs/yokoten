// The site's Worker. Files are served as static assets without it; it runs first for the routes in
// run_worker_first (wrangler.jsonc), and for any path with no file (not_found_handling: none):
// - /video/*: byte ranges for the promo video (worker/video-ranges.js);
// - a path with no file: the HTML 404 page (dist/404.html) with status 404, or for an agent (as below)
//   a 404 in Markdown;
// - the HTML pages: served as they are, and each visit counted (below). A request whose Accept header
//   prefers text/markdown, or that comes from a known AI agent's User-Agent, gets the page's Markdown
//   version instead (site/integrations/markdown.mjs writes it next to the HTML; worker/markdown.js), so every
//   page answer carries Vary: Accept, User-Agent, and a Link header to /llms.txt and the other form.
import { serveVideo } from './video-ranges.js';
import { isAgent, markdownNotFound, markdownPath, pageLinks, serveMarkdown, VARY, wantsMarkdown } from './markdown.js';

// Where visitors come from, without personal data. One Analytics Engine data point per page view:
//   blob1 path (no query)           blob2 referrer origin ('' when none or this site)
//   blob3 ?from= tag ([a-z0-9-])    blob4 page language
//   blob5 country (from Cloudflare) blob6 'bot' or 'human'
// No IP address, no user agent, no cookie, nothing that tells one person from another.
// `npm run visits` reads it back (tools/stats/visits.mjs).
//
// How long a page stayed on screen: the page sends POST /stay once, when the visitor first leaves
// it or hides it (site/public/js/theme.js). One data point in yokoten_stays:
//   blob1 path   blob2 page language   blob3 country   double1 seconds on screen (0 to 3600)
// Same rule: nothing that tells one person from another. `npm run stays` reads it back.

// Folder → language (hreflang), as in LANG_INFO in site/src/lib/i18n.ts.
const LANG_DIRS = { zh: 'zh-CN', 'zh-tw': 'zh-TW', ja: 'ja' };
const BOT = /bot|crawl|spider|curl|python|headless/i;

function originOf(referer, host) {
  try {
    const url = new URL(referer);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    if (url.hostname === host || url.hostname === 'yokoten.app' || url.hostname === 'www.yokoten.app') return '';
    return url.origin;
  } catch {
    return '';
  }
}

function record(request, env, url) {
  const from = url.searchParams.get('from') ?? '';
  const first = url.pathname.split('/')[1]?.toLowerCase() ?? '';
  env.VISITS.writeDataPoint({
    blobs: [
      url.pathname.slice(0, 200),
      originOf(request.headers.get('Referer') ?? '', url.hostname),
      /^[a-z0-9-]{1,32}$/.test(from) ? from : '',
      LANG_DIRS[first] ?? 'en',
      request.cf?.country ?? '',
      BOT.test(request.headers.get('User-Agent') ?? '') ? 'bot' : 'human',
    ],
    doubles: [1],
  });
}

// POST /stay: {"p": path, "s": seconds}. Always 204, so a bad body tells a sender nothing.
async function recordStay(request, env, url) {
  try {
    const body = await request.text();
    if (body.length > 300) return;
    const { p, s } = JSON.parse(body);
    if (typeof p !== 'string' || !/^\/[a-z0-9\-/]{0,100}$/.test(p) || typeof s !== 'number' || !Number.isFinite(s) || s < 0) return;
    if (BOT.test(request.headers.get('User-Agent') ?? '')) return;
    const first = p.split('/')[1] ?? '';
    env.STAYS.writeDataPoint({
      blobs: [p, LANG_DIRS[first] ?? 'en', request.cf?.country ?? ''],
      doubles: [Math.min(Math.round(s), 3600)],
    });
  } catch {
    /* not counted */
  }
}

// The HTML 404 page, which the assets no longer serve by themselves (not_found_handling: none).
// Asked for as /404: /404.html would be redirected there (html_handling). A plain GET or HEAD, so no
// conditional header turns it into a 304.
async function notFoundPage(request, env, url) {
  const page = await env.ASSETS.fetch(new Request(new URL('/404', url), { method: request.method === 'HEAD' ? 'HEAD' : 'GET' }));
  return new Response(page.body, { status: 404, statusText: 'Not Found', headers: page.headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/video/')) return serveVideo(request, env);
    if (url.pathname === '/stay') {
      if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
      await recordStay(request, env, url);
      return new Response(null, { status: 204 });
    }

    const forAgent =
      (request.method === 'GET' || request.method === 'HEAD') &&
      (wantsMarkdown(request.headers.get('Accept') ?? '') || isAgent(request.headers.get('User-Agent') ?? ''));
    if (forAgent) {
      const md = await serveMarkdown(request, env, url);
      if (md) return md;
    }

    let asset = await env.ASSETS.fetch(request);
    if (asset.status === 404) {
      asset.body?.cancel();
      if (forAgent) return markdownNotFound(request);
      asset = await notFoundPage(request, env, url);
    }
    // The same URL answers HTML or Markdown by the Accept and User-Agent headers, so caches must keep them apart.
    const res = new Response(asset.body, asset);
    res.headers.append('Vary', VARY);
    const mdPath = res.status === 200 && (res.headers.get('Content-Type') ?? '').startsWith('text/html') ? markdownPath(url.pathname) : null;
    if (mdPath) res.headers.set('Link', pageLinks(`<${mdPath}>; rel="alternate"; type="text/markdown"`));
    // Counting must never break or slow the page: writeDataPoint does not wait, and any error is dropped.
    try {
      if (request.method === 'GET' && res.status === 200 && (res.headers.get('Content-Type') ?? '').startsWith('text/html')) {
        record(request, env, url);
      }
    } catch {
      /* not counted */
    }
    return res;
  },
};
