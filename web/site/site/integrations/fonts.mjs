// The site's fonts, from @fontsource-variable.
//
// Before a build or the dev server: each family's CSS and the files it names are copied into
// public/fonts/<family>/ (not in git): Inter and JetBrains Mono for every page, and one of Noto
// Sans SC, TC and JP per language (the English pages link JP, for the 横展 in the wordmark).
// font-display becomes `fallback`: a cached font arrives inside its 100 ms wait, so a refresh
// never paints the stand-in font first.
//
// After a build: the Noto families are cut down, page by page, to the characters each page uses.
// A family's hundred-odd range files hold far more than a page says (264 characters on the
// Chinese home page cost 12 files, 693 KB), so each range file a page touches is subset to that
// page's characters in it, weights 400 to 700, under a hashed name that pages with the same text
// share. The page preloads those files and carries their @font-face rules inline, so its CJK
// text, like its Latin, is drawn once, in its own font. The full copies are left out of dist.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import subsetFont from 'subset-font';

const here = dirname(fileURLToPath(import.meta.url));
const publicFonts = join(here, '..', 'public/fonts');
const LATIN = ['inter', 'jetbrains-mono'];
/** A family whose stylesheet is not index.css: none now (the footer note is in the body font). */
const SHEETS = {};
const CJK = ['noto-sans-sc', 'noto-sans-tc', 'noto-sans-jp'];
/** The weights the site sets; the subsets keep this slice of the variable axis. */
const WEIGHTS = { min: 400, max: 700 };

/** What Noto draws: CJK and its punctuation, and the symbols Inter lacks. Inter draws Latin, Greek
 * and Cyrillic first, so Noto's copies of them would only cost bytes. */
const cjk = (cp) => cp >= 0x2e80 || (cp >= 0x2600 && cp <= 0x27bf);

const pkgDir = (family) => dirname(createRequire(import.meta.url).resolve(`@fontsource-variable/${family}/package.json`));

function copyFamilies() {
  for (const family of [...LATIN, ...Object.keys(SHEETS), ...CJK]) {
    const pkg = pkgDir(family);
    const out = join(publicFonts, family);
    mkdirSync(join(out, 'files'), { recursive: true });
    const css = readFileSync(join(pkg, SHEETS[family] ?? 'index.css'), 'utf8');
    writeFileSync(join(out, 'index.css'), css.replaceAll('font-display: swap', 'font-display: fallback'));
    // only the files the CSS names: the packages also ship italics and other axes the site never uses
    for (const [, f] of css.matchAll(/url\(\.\/files\/([^)]+\.woff2)\)/g)) {
      if (!existsSync(join(out, 'files', f))) copyFileSync(join(pkg, 'files', f), join(out, 'files', f));
    }
  }
}

const htmlFiles = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? htmlFiles(join(dir, e.name)) : e.name.endsWith('.html') ? [join(dir, e.name)] : [],
  );

/** `U+4E00-9FFF, U+3000` as [from, to] pairs. */
const parseRange = (r) =>
  r.split(',').map((p) => {
    const [a, b] = p.trim().replace(/^U\+/i, '').split('-').map((x) => parseInt(x, 16));
    return [a, b ?? a];
  });

/** Code points as the shortest unicode-range: runs become U+a-b. */
function toRange(cps) {
  const sorted = [...cps].sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    const hex = (n) => n.toString(16).toUpperCase();
    parts.push(i === j ? `U+${hex(sorted[i])}` : `U+${hex(sorted[i])}-${hex(sorted[j])}`);
    i = j + 1;
  }
  return parts.join(', ');
}

async function subsetFamilies(dist) {
  const linkOf = (family) => `<link rel="stylesheet" href="/fonts/${family}/index.css">`;
  /** The range files of each family: its name in CSS, the file, and the code points it covers. */
  const ranges = Object.fromEntries(
    CJK.map((family) => [
      family,
      readFileSync(join(pkgDir(family), 'index.css'), 'utf8')
        .split('@font-face')
        .slice(1)
        .map((block) => ({
          name: block.match(/font-family:\s*'([^']+)'/)?.[1],
          src: block.match(/url\(\.\/files\/([^)]+\.woff2)\)/)?.[1],
          pairs: parseRange(block.match(/unicode-range:\s*([^;]+);/)?.[1] ?? ''),
        }))
        .filter((r) => r.name && r.src),
    ]),
  );
  /** Pages with the same characters share files: one subset per (family, range file, characters). */
  const made = new Map();
  mkdirSync(join(dist, 'fonts/cjk'), { recursive: true });

  for (const file of htmlFiles(dist)) {
    const html = readFileSync(file, 'utf8');
    const family = CJK.find((f) => html.includes(linkOf(f)));
    if (!family) continue;
    const used = [...new Set([...html].map((c) => c.codePointAt(0)).filter(cjk))];
    const preloads = [];
    const rules = [];
    for (const r of ranges[family]) {
      const cps = used.filter((c) => r.pairs.some(([a, b]) => c >= a && c <= b)).sort((a, b) => a - b);
      if (!cps.length) continue;
      const key = `${family}/${r.src}/${cps.join(',')}`;
      if (!made.has(key)) {
        const font = await subsetFont(readFileSync(join(pkgDir(family), 'files', r.src)), String.fromCodePoint(...cps), {
          targetFormat: 'woff2',
          variationAxes: { wght: WEIGHTS },
        });
        const name = `${family}.${createHash('sha256').update(font).digest('hex').slice(0, 8)}.woff2`;
        writeFileSync(join(dist, 'fonts/cjk', name), font);
        made.set(key, `/fonts/cjk/${name}`);
      }
      const href = made.get(key);
      preloads.push(`<link rel="preload" href="${href}" as="font" type="font/woff2" crossorigin>`);
      rules.push(
        `@font-face{font-family:'${r.name}';font-style:normal;font-display:fallback;font-weight:${WEIGHTS.min} ${WEIGHTS.max};` +
          `src:url(${href}) format('woff2');unicode-range:${toRange(cps)}}`,
      );
    }
    writeFileSync(file, html.replace(linkOf(family), preloads.join('') + `<style>${rules.join('')}</style>`));
  }
  for (const family of CJK) rmSync(join(dist, 'fonts', family), { recursive: true, force: true });
  // a page that still links a full family would load nothing now: fail the build instead
  for (const file of htmlFiles(dist)) {
    const html = readFileSync(file, 'utf8');
    for (const f of CJK) if (html.includes(linkOf(f))) throw new Error(`${relative(dist, file)} still links /fonts/${f}/`);
  }
}

export default function fonts() {
  return {
    name: 'yokoten:fonts',
    hooks: {
      'astro:config:setup': copyFamilies,
      'astro:build:done': ({ dir }) => subsetFamilies(fileURLToPath(dir)),
    },
  };
}
