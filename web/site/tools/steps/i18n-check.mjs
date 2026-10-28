// Checks that the built pages laid out from page data (home, road, about, and the docs' quick start and stop page), in the four languages, have the same shape: the owner's rule is one layout for
// every language. Run it after `npm run build`; it reads dist/ and compares a skeleton of each page:
// the sequence of sections (by id), the headings (h1-h4) and how deep they sit, the number of list
// items (li, or dt in a definition list) in each list, the <details> and <pre> blocks, and the links in each section. The words are not compared.
// It fails with the first difference: the file, the section, and what differs.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(fileURLToPath(new URL('../..', import.meta.url)), 'dist');
const LANG_DIRS = [['en', ''], ['zh', 'zh/'], ['tw', 'zh-tw/'], ['ja', 'ja/']];
/** The pages laid out from page data, as dist/ files; the home page is index.html. */
export const SLUGS = ['index', 'how', 'road', 'about', 'docs', 'docs/stopped'];
/** The docs pages: their words are the repo's docs, whose translations differ in length, so only that each exists (with its .md) is checked.
 * The guide's chapters, dist/docs/guide/<chapter>.html, are added from the English build: every language has every chapter. */
export const DOC_SLUGS = ['docs/overview', 'docs/road', 'docs/guide'];
export const PAGES = SLUGS.flatMap((slug) => LANG_DIRS.map(([lang, dir]) => [lang, `${dir}${slug}.html`, slug]));

const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'source', 'track', 'path', 'circle', 'rect', 'line', 'ellipse', 'stop', 'use']);
const LISTS = new Set(['ul', 'ol', 'dl']);

/** Reads the <main> of a page into [{ name, items: ['h2 d1', 'ul 3', 'pre', ...] }]. */
export function skeleton(html) {
  const from = html.indexOf('<main');
  const to = html.indexOf('</main>');
  if (from < 0 || to < 0) throw new Error('no <main> in the page');
  const body = html.slice(from, to).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/g, '');
  const sections = [];
  const stack = []; // open tags: { tag, section?, list? }
  let anon = 0;
  let current = null;
  const add = (what) => current && current.items.push(what);
  for (const m of body.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*?)(\/?)>/g)) {
    const [, close, rawTag, attrs, selfClose] = m;
    const tag = rawTag.toLowerCase();
    if (close) {
      let i = stack.length - 1;
      while (i >= 0 && stack[i].tag !== tag) i--;
      if (i < 0) continue;
      const entry = stack[i];
      stack.length = i;
      if (entry.section) current = stack.map((e) => e.section).filter(Boolean).pop() ?? null;
      if (entry.list) add(`${tag} ${entry.list.count}`);
      continue;
    }
    const entry = { tag };
    if (tag === 'section') {
      const id = /\bid="([^"]*)"/.exec(attrs)?.[1];
      // Ids carry the language prefix of the page, if any: compare the part after it.
      const name = id ? id.replace(/^(zh-tw|zh|tw|ja|en)[-:_]/, '') : `section#${++anon}`;
      entry.section = { name, items: [] };
      sections.push(entry.section);
      current = entry.section;
    } else if (/^h[1-4]$/.test(tag)) {
      add(`${tag} depth ${stack.filter((e) => e.tag === 'section' || LISTS.has(e.tag)).length}`);
    } else if (LISTS.has(tag)) {
      entry.list = { count: 0 };
    } else if (tag === 'li' || tag === 'dt') {
      const parent = [...stack].reverse().find((e) => e.list);
      if (parent) parent.list.count++;
    } else if (tag === 'details') {
      add('details');
    } else if (tag === 'pre') {
      add('pre');
    } else if (tag === 'a') {
      add('a');
    }
    if (!selfClose && !VOID.has(tag)) stack.push(entry);
  }
  // Links are counted per section, not by position: the same number, anywhere in the section.
  return sections.map((s) => ({
    name: s.name,
    items: s.items.filter((i) => i !== 'a'),
    links: s.items.filter((i) => i === 'a').length,
  }));
}

/** The first difference between two skeletons, as a sentence, or null. */
export function firstDifference(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    if (!x || !y) return `section ${i + 1}: ${x ? `"${x.name}" is missing here` : `an extra section "${y.name}"`}`;
    if (x.name !== y.name) return `section ${i + 1}: "${x.name}" there, "${y.name}" here`;
    const m = Math.max(x.items.length, y.items.length);
    for (let j = 0; j < m; j++) {
      if (x.items[j] !== y.items[j]) {
        return `section "${x.name}", item ${j + 1}: "${x.items[j] ?? '(none)'}" there, "${y.items[j] ?? '(none)'}" here`;
      }
    }
    if (x.links !== y.links) return `section "${x.name}": ${x.links} links there, ${y.links} here`;
  }
  return null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const read = (file) => {
    try {
      return readFileSync(join(dist, file), 'utf8');
    } catch {
      console.error(`i18n-check: dist/${file} is missing; run npm run build first`);
      process.exit(1);
    }
  };
  let pages = 0;
  let sections = 0;
  for (const slug of SLUGS) {
    const group = PAGES.filter((p) => p[2] === slug).map(([lang, file]) => {
      read(file.replace(/\.html$/, '.md')); // every page has its Markdown twin
      const html = read(file);
      const h1s = (html.match(/<h1[\s>]/g) ?? []).length;
      if (h1s !== 1) { console.error(`i18n-check: dist/${file} has ${h1s} <h1>, not one`); process.exit(1); }
      // The home hero is the headline (h1), then the one line under it, then the action.
      if (slug === 'index' && !/<h1[^>]*>[^<]+<\/h1>\s*<p class="sub"/.test(html)) { console.error(`i18n-check: dist/${file}: the hero is not headline (h1) then its line`); process.exit(1); }
      return { lang, file, sk: skeleton(html) };
    });
    const [base, ...rest] = group;
    for (const other of rest) {
      const diff = firstDifference(base.sk, other.sk);
      if (diff) {
        console.error(`i18n-check: dist/${other.file} differs from dist/${base.file}\n  ${diff}`);
        process.exit(1);
      }
    }
    pages += group.length;
    sections += base.sk.length;
  }
  let chapters = [];
  try {
    chapters = readdirSync(join(dist, 'docs/guide')).filter((f) => f.endsWith('.html')).map((f) => `docs/guide/${f.replace(/\.html$/, '')}`);
  } catch {}
  if (!chapters.length) { console.error('i18n-check: dist/docs/guide/ has no chapter pages'); process.exit(1); }
  const docSlugs = [...DOC_SLUGS, ...chapters];
  /** Every link on a docs page to a guide chapter must find the chapter, and a #section its heading. */
  const ids = new Map();
  const idsOf = (file) => {
    if (!ids.has(file)) ids.set(file, new Set([...read(file).matchAll(/\bid="([^"]+)"/g)].map((m) => m[1])));
    return ids.get(file);
  };
  let links = 0;
  for (const slug of docSlugs) {
    for (const [, dir] of LANG_DIRS) {
      read(`${dir}${slug}.md`);
      const html = read(`${dir}${slug}.html`);
      const h1s = (html.match(/<h1[\s>]/g) ?? []).length;
      if (h1s !== 1) { console.error(`i18n-check: dist/${dir}${slug}.html has ${h1s} <h1>, not one`); process.exit(1); }
      const main = html.slice(html.indexOf('<main'), html.indexOf('</main>'));
      for (const [, url, hash] of main.matchAll(/href="\/((?:zh-tw\/|zh\/|ja\/)?docs\/guide\/[^"#]+)(?:#([^"]+))?"/g)) {
        const id = hash && decodeURIComponent(hash.replace(/&amp;/g, '&'));
        if (id && !idsOf(`${url}.html`).has(id)) { console.error(`i18n-check: dist/${dir}${slug}.html links /${url}#${id}, which has no such section`); process.exit(1); }
        links++;
      }
    }
  }
  console.log(`i18n-check: ${SLUGS.length} pages in ${LANG_DIRS.length} languages (${pages} files, ${sections} sections), same layout, each with its .md; ${docSlugs.length} docs pages in each language (${chapters.length} guide chapters), ${links} links to chapters, each found`);
}
