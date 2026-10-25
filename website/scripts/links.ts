// The link check (#631): after `astro build`, every internal link in the built HTML
// must land on a real file in dist/. A pull request then fails on a broken link.
// The external web is not opened: the site must build offline, and a CI run on the
// deploy host decides about the outside later.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DIST = join(import.meta.dirname, '..', 'dist');
const SKIP = /^(https?:|mailto:|javascript:|tel:|#)/;

/** Every file under `dir`, as a path from `dir`. */
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

const html = files(DIST).filter((file) => file.endsWith('.html'));
const assets = new Set(files(DIST).map((file) => file.slice(DIST.length)));

/** Whether `link` lands on a real file in dist/ (directory format, with a `.html` fallback). */
function resolves(link: string): boolean {
  const path = decodeURI(new URL(link, 'https://example.test/').pathname).replace(/\/+$/, '');
  const withIndex = path === '' ? '/index.html' : `${path}/index.html`;
  return assets.has(withIndex) || assets.has(`${path}.html`) || assets.has(path);
}

const broken: string[] = [];
for (const file of html) {
  const page = file.slice(DIST.length);
  const links = readFileSync(file, 'utf8').matchAll(/\b(?:href|src)="([^"]+)"/g);
  for (const [, link] of links) {
    if (SKIP.test(link) || resolves(link)) continue;
    broken.push(`${page}: ${link}`);
  }
}

if (broken.length > 0) {
  process.stderr.write(`check-links: ${broken.length} broken link(s):\n${broken.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`check-links: ok, ${html.length} pages\n`);
