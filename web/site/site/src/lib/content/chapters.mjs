// The guide, one page per chapter. The yokoten guide is one long Markdown file
// (generated/docs/guide/<lang>.md): the site shows its intro on /docs/guide and each `##` chapter on
// /docs/guide/<slug>, with the chapter's `###` sections one level up. content.config.ts renders the
// chapters and integrations/markdown.mjs writes their Markdown twins; both split the guide here, so
// the pages and the Markdown never differ.
//
// A chapter's slug is the English chapter's heading id, in every language: the translations leave
// some chapters out, so each translated chapter is matched to its English one by the commands, paths
// and links they share, in order. A link to an anchor in the old one-page guide (#privacy) becomes a
// link to its chapter and section, and `anchors` keeps every old anchor for the /docs/guide page,
// which sends an old link (/docs/guide#privacy) to the right chapter.
import GithubSlugger from 'github-slugger';

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;

/** A heading's words as its id is made from them (Astro slugs the heading's text content). */
export const plain = (s) =>
  s
    .replace(/<[^>]+>/g, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`+([^`]*?)`+/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_](\S(?:.*?\S)?)[*_](?![\w*])/g, '$1$2')
    .replace(/\\([\\`*_{}[\]()#+\-.!|])/g, '$1')
    .trim();

/** Each line of a document, with whether it sits inside a code fence (fence lines count as inside). */
function marked(md) {
  let open = null;
  return md.split('\n').map((line) => {
    const f = FENCE.exec(line);
    if (open) {
      if (f && f[1][0] === open[0] && f[1].length >= open.length && line.trim() === f[1].trim()) open = null;
      return { line, code: true };
    }
    if (f) {
      open = f[1];
      return { line, code: true };
    }
    return { line, code: false };
  });
}

/** What a chapter is about, in words no translation changes: its code, paths, links and numbers. */
function fingerprint(body) {
  const set = new Set();
  for (const { line, code } of marked(body)) {
    if (code) {
      if (!FENCE.test(line) && line.trim()) set.add(`pre:${line.trim()}`);
      continue;
    }
    for (const [, c] of line.matchAll(/`([^`]+)`/g)) set.add(`code:${c}`);
    for (const [, u] of line.matchAll(/\]\((https?:[^)\s]+)\)/g)) set.add(`url:${u.replace(/\/i18n\/[^/]+\//, '/')}`);
  }
  return set;
}
const similarity = (a, b) => {
  if (!a.size || !b.size) return 0;
  let both = 0;
  for (const x of a) if (b.has(x)) both++;
  return both / (a.size + b.size - both);
};

/**
 * Matches a translation's chapters to the English ones, in order: the match that pairs the most
 * chapters, and among those the most alike. Returns, for each translated chapter, its English index.
 */
export function align(en, other) {
  const n = en.length;
  const m = other.length;
  const PAIR = 1; // pairing two chapters is worth more than any likeness
  const score = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      score[i][j] = Math.max(score[i + 1][j], score[i][j + 1], PAIR + similarity(en[i].print, other[j].print) + score[i + 1][j + 1]);
    }
  }
  const out = new Array(m).fill(-1);
  for (let i = 0, j = 0; i < n && j < m; ) {
    const pair = PAIR + similarity(en[i].print, other[j].print) + score[i + 1][j + 1];
    if (score[i][j] === pair) out[j++] = i++;
    else if (score[i][j] === score[i + 1][j]) i++;
    else j++;
  }
  return out;
}

/**
 * Splits a guide (its Markdown body, without front matter) into the intro and the chapters.
 * Every heading keeps the id it had in the whole guide (`full`) and gets the one it has on its
 * chapter's page (`local`).
 */
export function split(md) {
  const whole = new GithubSlugger();
  const intro = [];
  const chapters = [];
  let local = null;
  for (const { line, code } of marked(md)) {
    const h = code ? null : HEADING.exec(line);
    if (h && h[1].length === 2) {
      local = new GithubSlugger();
      chapters.push({ title: h[2], full: whole.slug(plain(h[2])), lines: [], headings: [] });
      continue;
    }
    const chapter = chapters.at(-1);
    if (!h) {
      (chapter ? chapter.lines : intro).push(line);
      continue;
    }
    const full = whole.slug(plain(h[2]));
    if (!chapter) {
      intro.push(line);
      continue;
    }
    // a chapter's ### sections are its page's ## sections
    const depth = h[1].length > 2 ? h[1].length - 1 : h[1].length;
    chapter.headings.push({ depth, text: plain(h[2]), full, local: local.slug(plain(h[2])) });
    chapter.lines.push(`${'#'.repeat(depth)} ${h[2]}`);
  }
  return {
    intro: intro.join('\n').trim(),
    chapters: chapters.map((c) => ({ title: c.title, full: c.full, body: c.lines.join('\n').trim(), headings: c.headings, print: fingerprint(c.lines.join('\n')) })),
  };
}

/**
 * A guide as one language shows it: the intro and every English chapter, each in this language
 * when the translation has it (`translated`) and in English when it does not, under the English
 * chapter's slug; and `anchors`, every heading id of the old one-page guide (the translation's and
 * the English one's) to [chapter slug, section id on that chapter's page, '' for its top].
 * `md` is the translation's body: the English body for English, null for a language with no guide.
 * A translated chapter with no English one to match is left out, with a warning: it would have no URL.
 */
export function guide(enMd, md) {
  const en = split(enMd);
  const own = md === enMd ? en : md ? split(md) : null;
  const mine = new Map();
  if (own) {
    const match = own === en ? own.chapters.map((_, i) => i) : align(en.chapters, own.chapters);
    own.chapters.forEach((c, j) => {
      // English is the source: a chapter it dropped is one the translation has not caught up on yet
      if (match[j] < 0) return console.warn(`chapters: the guide chapter "## ${c.title}" has no English chapter to match, so the site leaves it out`);
      mine.set(match[j], c);
    });
  }
  const anchors = {};
  en.chapters.forEach((e, i) => {
    // an English section id still finds its chapter; its id on a translated page is another one
    anchors[e.full] = [e.full, ''];
    for (const h of e.headings) anchors[h.full] = [e.full, mine.has(i) && own !== en ? '' : h.local];
  });
  if (own && own !== en) {
    en.chapters.forEach((e, i) => {
      const c = mine.get(i);
      if (!c) return;
      anchors[c.full] = [e.full, ''];
      for (const h of c.headings) anchors[h.full] = [e.full, h.local];
    });
  }
  const chapters = en.chapters.map((e, i) => {
    const c = mine.get(i) ?? e;
    return { slug: e.full, title: plain(c.title), body: c.body, headings: c.headings.map(({ depth, text, local }) => ({ depth, text, slug: local })), translated: mine.has(i) };
  });
  return { intro: own ? own.intro : en.intro, translated: !!own, chapters, anchors };
}

/** Rewrites the guide's links to its own anchors, `](#x)`, with `to(chapter, section)`. An unknown anchor goes to the guide's index with it. */
export function relink(body, anchors, to) {
  return marked(body)
    .map(({ line, code }) =>
      code
        ? line
        : line.replace(/\]\(#([^)\s]+)\)/g, (_, raw) => {
            let id = raw;
            try {
              id = decodeURIComponent(raw);
            } catch {}
            const hit = anchors[id];
            return `](${hit ? to(hit[0], hit[1]) : to('', id)})`;
          }),
    )
    .join('\n');
}

/**
 * A generated doc's front matter and body: tools/steps/from-package.mjs writes strings as JSON, and doc and lang bare.
 * @param {string} text
 * @returns {{ data: Record<string, string>, body: string }}
 */
export function parseDoc(text) {
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!fm) throw new Error('a generated doc has no front matter');
  /** @type {Record<string, string>} */
  const data = {};
  for (const line of fm[1].split('\n')) {
    const m = /^(\w+): (.*)$/.exec(line);
    if (m) data[m[1]] = m[2].startsWith('"') ? JSON.parse(m[2]) : m[2];
  }
  return { data, body: text.slice(fm[0].length).trim() };
}
