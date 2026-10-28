// Markdown for AI agents. A page request whose Accept header prefers text/markdown, or that comes
// from a known AI agent (AGENT_UA), gets the page's Markdown version (site/integrations/markdown.mjs writes
// dist/index.md, dist/zh/start.md … next to the HTML). No async work besides one asset fetch: the
// Free plan allows 10 ms of CPU.

// The language folders, as in LANG_INFO in site/src/lib/i18n.ts.
const LANG_DIRS = new Set(['zh', 'zh-tw', 'ja']);

// Does the Accept header rank text/markdown at least as high as text/html? Browsers never ask for it.
export function wantsMarkdown(accept) {
  let md = 0;
  let html = 0;
  for (const part of accept.toLowerCase().split(',')) {
    const [type, ...params] = part.split(';').map((p) => p.trim());
    const qp = params.find((p) => p.startsWith('q='));
    const q = qp ? Number(qp.slice(2)) : 1;
    if (!(q > 0)) continue;
    if (type === 'text/markdown' || type === 'text/x-markdown') md = Math.max(md, q);
    else if (type === 'text/html') html = Math.max(html, q);
  }
  return md > 0 && md >= html;
}

// AI agents that fetch pages for a person or an index, by the name in their User-Agent. A short, explicit
// list: no browser sends these names, so a browser always gets HTML.
const AGENT_UA =
  /\b(?:ClaudeBot|Claude-User|Claude-SearchBot|Claude-Web|anthropic-ai|GPTBot|ChatGPT-User|OAI-SearchBot|PerplexityBot|Perplexity-User|MistralAI-User|DuckAssistBot)\b/i;

export const isAgent = (userAgent) => AGENT_UA.test(userAgent);

// Every page answer depends on both headers, so caches must keep the answers apart.
export const VARY = 'Accept, User-Agent';

// The Link header (RFC 8288) of a page: the site index for agents, the other form of the page, the sitemap.
export const pageLinks = (alternate) =>
  `</llms.txt>; rel="describedby"; type="text/plain", ${alternate}, </sitemap.xml>; rel="sitemap"`;

// A page's Markdown file, as mdOf in site/integrations/markdown.mjs: / → /index.md, /zh/ (or /zh) → /zh/index.md,
// /ja/start → /ja/start.md. Null for a path that names a file (it has an extension).
export function markdownPath(path) {
  if (path.endsWith('/')) return path + 'index.md';
  const last = path.slice(path.lastIndexOf('/') + 1);
  if (last.includes('.')) return null;
  return LANG_DIRS.has(last.toLowerCase()) && path === '/' + last ? path + '/index.md' : path + '.md';
}

export async function serveMarkdown(request, env, url) {
  const path = markdownPath(url.pathname);
  if (!path) return null;
  const res = await env.ASSETS.fetch(new Request(new URL(path, url), request));
  if (res.status !== 200 && res.status !== 304) {
    res.body?.cancel();
    return null; // no Markdown version: serve the page as usual
  }
  const headers = new Headers(res.headers);
  headers.set('Content-Type', 'text/markdown; charset=utf-8');
  headers.set('Content-Location', path);
  headers.set('Vary', VARY);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Link', pageLinks(`<${url.pathname}>; rel="canonical"; type="text/html"`));
  return new Response(res.body, { status: res.status, headers });
}

// A path with no page, asked for as Markdown: a 404 in Markdown, with where to go instead. A browser
// still gets the HTML 404 page (dist/404.html). One fixed string, so no extra work.
const NOT_FOUND = `# Page not found

There is no page at this address on yokoten.app.

- [llms.txt](https://yokoten.app/llms.txt): the site's index for AI agents, with every page in Markdown
- [sitemap.xml](https://yokoten.app/sitemap.xml): every page
- [Home page](https://yokoten.app/)
`;

export function markdownNotFound(request) {
  return new Response(request.method === 'HEAD' ? null : NOT_FOUND, {
    status: 404,
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      Vary: VARY,
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff',
      Link: '</llms.txt>; rel="describedby"; type="text/plain", </sitemap.xml>; rel="sitemap"',
    },
  });
}
