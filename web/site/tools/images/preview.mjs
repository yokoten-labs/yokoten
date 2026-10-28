// A local look at the built site with no Worker: serves dist/ with the clean URLs Cloudflare gives
// (/guard → guard.html, /zh/ → zh/index.html) and the 301s of public/_redirects, so a page can be
// read in a browser before a deploy. No dependency. `node tools/images/preview.mjs [port]` (default 4173).
import { createServer } from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('../..', import.meta.url)), 'dist');
const port = Number(process.argv[2]) || 4173;
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.mp4': 'video/mp4', '.webm': 'video/webm', '.vtt': 'text/vtt; charset=utf-8', '.ico': 'image/x-icon', '.xml': 'application/xml' };
const redirects = existsSync(join(root, '_redirects'))
  ? readFileSync(join(root, '_redirects'), 'utf8').split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#')).map((line) => line.split(/\s+/))
  : [];

function fileFor(pathname) {
  const clean = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  const candidates = clean.endsWith('/') ? [join(clean, 'index.html')] : [clean, `${clean}.html`, join(clean, 'index.html')];
  for (const candidate of candidates) {
    const file = join(root, candidate);
    if (file.startsWith(root) && existsSync(file) && statSync(file).isFile()) return file;
  }
  return null;
}

createServer((req, res) => {
  const { pathname } = new URL(req.url ?? '/', `http://localhost:${port}`);
  const rule = redirects.find(([from]) => from === pathname || from === pathname.replace(/\/$/, ''));
  if (rule) {
    res.writeHead(Number(rule[2]) || 301, { Location: rule[1] });
    res.end();
    return;
  }
  const file = fileFor(pathname);
  if (!file) {
    const notFound = join(root, '404.html');
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(existsSync(notFound) ? readFileSync(notFound) : 'not found');
    return;
  }
  // A byte range, as the Worker answers one, so the film can seek and the browser stops loading.
  const type = TYPES[extname(file)] ?? 'application/octet-stream';
  const size = statSync(file).size;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      res.end();
      return;
    }
    res.writeHead(206, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': size });
  res.end(readFileSync(file));
}).listen(port, '127.0.0.1', () => console.log(`preview: http://localhost:${port}/ (dist/, clean URLs and _redirects, no Worker)`));
