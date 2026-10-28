// The site's policy (public/_headers) runs only scripts from files: `script-src 'self'`. A script
// written into the page is dropped without a word in production, while the dev server runs it,
// so a finished page that still holds one fails the build here.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const htmlFiles = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? htmlFiles(join(dir, e.name)) : e.name.endsWith('.html') ? [join(dir, e.name)] : [],
  );

/** A <script> with a body runs inline; one with src or a data type (JSON-LD) does not. */
const inline = /<script(?![^>]*\bsrc=)(?![^>]*type="application\/(?:ld\+)?json")[^>]*>\s*[^<\s]/;

export default function noInlineScripts() {
  return {
    name: 'yokoten:no-inline-scripts',
    hooks: {
      'astro:build:done': ({ dir }) => {
        const dist = fileURLToPath(dir);
        const bad = htmlFiles(dist).filter((f) => inline.test(readFileSync(f, 'utf8')));
        if (bad.length) throw new Error(`inline <script> the policy blocks: ${bad.map((f) => relative(dist, f)).join(', ')}`);
      },
    },
  };
}
