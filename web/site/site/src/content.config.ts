// One schema per page, the same for every language (the owner's 2026-10-25 rule as a type).
// Each page is a folder of data files, one per language: src/content/pages/<page>/<lang>.json.
// Objects are strict (no key more, none less) and every list the layout lays out has a fixed
// length, so a translation that drifts fails `astro build`. tools/steps/i18n-check.mjs is the
// second net, on the built HTML.
//
// Text fields take two marks: `code` and [a link](https://...). Facts (commands, rules, stages,
// screens, agents, version) are not here: they come from src/content/generated/, which
// tools/steps/from-package.mjs reads from the yokoten package, and so do the docs (the README and the
// guide, as Markdown, in generated/docs/).
import { defineCollection } from 'astro:content';
import { glob, type Loader } from 'astro/loaders';
import { z } from 'astro/zod';
import { guide, parseDoc, relink } from './lib/content/chapters.mjs';
import { buildLangs, href } from './lib/i18n';

const text = z.string().trim().min(1);
/** A mono label in caps, over a section: "WHAT IT STOPS". */
const label = text.max(48);
/** A label and its short items: the hero's agents and systems, one row each. */
const named = z.strictObject({ label: text.max(20), items: z.array(text.max(40)).min(1) });
const meta = z.strictObject({ title: text.max(70), description: text.max(200) });
/** The head of a section: its label, its heading, and an optional line under it. */
const head = { label, title: text };
const list = <T extends z.ZodType>(item: T, length: number) => z.array(item).length(length);
/** The screens a page may show, by their key in generated/facts/screens.json. */
const screen = z.enum(['first run', 'guard, force push', 'guard, wipe home', 'guard, tag push', 'session start']);

const pages = (page: string) => glob({ pattern: '*.json', base: `./src/content/pages/${page}` });

/** The header and footer every page shares. */
const site = defineCollection({
  loader: pages('site'),
  schema: z.strictObject({
    skip: text,
    home: text,
    nav: z.strictObject({ label: text, how: text, docs: text, road: text, about: text }),
    /**
     * The docs pages: the sidebar's three groups, each page's name (by its page key) and description,
     * the guide's chapter list and the links between chapters, the phone's fold, and the note on a
     * page shown in English.
     */
    docs: z.strictObject({
      label: text,
      onPage: text.max(30),
      groups: z.strictObject({ start: text.max(30), learn: text.max(30), reference: text.max(30) }),
      docs: text.max(40),
      stopped: text.max(40),
      overview: text.max(40),
      docsRoad: text.max(40),
      guide: text.max(40),
      docsDescription: text.max(200),
      stoppedDescription: text.max(200),
      overviewDescription: text.max(200),
      docsRoadDescription: text.max(200),
      guideDescription: text.max(200),
      /** A chapter page's description: "{chapter}: a chapter of the yokoten guide." */
      chapterDescription: text.max(200).includes('{chapter}'),
      chapters: text,
      previous: text,
      next: text,
      onThisPage: text,
      untranslated: text,
      source: text,
    }),
    language: text,
    theme: z.strictObject({ label: text, system: text, light: text, dark: text }),
    // The security notice above the header, on every page, until it is taken out of the code.
    notice: z.strictObject({ text: text }),
    /** The footer, as on the live site: the name note, a Project column and a More column (links to GitHub, with a screen-reader note). */
    footer: z.strictObject({
      note: text,
      project: z.strictObject({ title: text, docs: text, about: text, contact: text, privacy: text }),
      more: z.strictObject({ title: text, contribute: text, board: text, github: text, onGithub: text }),
    }),
    terminal: z.strictObject({ stopped: text, firstRun: text, exit: text }),
    /** The copy button beside `npx yokoten`: its label, and what it says once the command is copied. */
    copy: z.strictObject({ label: text, done: text }),
  }),
});

const home = defineCollection({
  loader: pages('home'),
  schema: z.strictObject({
    meta,
    hero: z.strictObject({ headline: text.max(80), sub: text, works: named, platforms: named, tags: list(text.max(20), 1) }),
    stops: z.strictObject({ ...head, cards: list(z.strictObject({ screen, caption: text }), 3), more: text }),
    firstMinute: z.strictObject({ ...head, callouts: list(text, 3) }),
    questions: z.strictObject({ ...head, items: list(z.strictObject({ q: text, a: text }), 3) }),
  }),
});

/** The quick start, /docs: three steps, then what a stop is and where to read on. The commands, the Node
 * version and the screen come from the facts; {node}, {stages} and {steps} are filled in from them. */
const quickstart = defineCollection({
  loader: pages('quickstart'),
  schema: z.strictObject({
    intro: z.strictObject({ ...head, body: text }),
    node: z.strictObject({ title: text, body: text, after: text.includes('{node}') }),
    run: z.strictObject({ title: text, body: text, after: text }),
    /** The promo film beside the run step: its caption, and what its player and its fallback say. */
    video: z.strictObject({
      title: text, body: text, play: text, fallback: text, download: text,
      // the film's own toolbar: button names, read by screen readers and shown as tooltips
      controls: z.strictObject({ play: text, pause: text, mute: text, unmute: text, fullscreen: text, captions: text, off: text, seek: text }),
    }),
    /** The first screen: what its marks mean (ok; MISSING and Fix; next and to do; Next), then the loop. */
    next: z.strictObject({ title: text, body: text, marks: list(text, 4), after: text.includes('{stages}').includes('{steps}'), more: text }),
    stops: z.strictObject({ title: text, body: text, more: text }),
    /** One line under each of the three pages to read next: overview, road, guide. */
    where: z.strictObject({ title: text, items: list(text, 3) }),
  }),
});

/** When it stops something, /docs/stopped: a real stop, its four parts, what to do, the five protections, and a stop that looks wrong. */
const stopped = defineCollection({
  loader: pages('stopped'),
  schema: z.strictObject({
    intro: z.strictObject({ ...head, body: text }),
    /** The four parts, in the screen's order: the first line, Why, Instead, More. */
    read: z.strictObject({ title: text, body: text, parts: list(text, 4) }),
    tell: z.strictObject({ title: text, body: text, only: text }),
    /** The README's "What it stops", in this language's README words. */
    protects: z.strictObject({ title: text, body: text, items: list(z.strictObject({ title: text, body: text }), 5) }),
    wrong: z.strictObject({ title: text, body: text, link: text }),
  }),
});

/** The docs: generated/docs/<doc>/<lang>.md, one file per doc in each language it has (guide.tw is missing
 * until the yokoten repo has it, and road is English only; the page then shows the English one). The id is the doc and the language: guide.en. */
const docs = defineCollection({
  loader: glob({ pattern: '*/*.md', base: './src/content/generated/docs', generateId: ({ entry }) => entry.replace(/\.md$/, '').replace('/', '.') }),
  schema: z.strictObject({
    title: text,
    doc: z.enum(['start', 'road', 'guide']),
    lang: z.enum(['en', 'zh', 'tw', 'ja']),
    /** The file on GitHub, at the tag the facts were read from. */
    source: z.url(),
    ref: text,
  }),
});

const road = defineCollection({
  loader: pages('road'),
  schema: z.strictObject({
    meta,
    intro: z.strictObject({ ...head, body: text }),
    /** The five stages as cards: "Stage 1", the name, "{n} steps"; then "All {n} steps", to the road doc. */
    stages: z.strictObject({ ...head, stage: text, steps: text.includes('{n}'), all: text.includes('{n}') }),
    /** Desk and kanban: one plain sentence or two, and a link to their section in the guide. */
    desk: z.strictObject({ ...head, body: text, more: text, tag: text.max(20) }),
    kanban: z.strictObject({ ...head, body: text, more: text, tag: text.max(20) }),
  }),
});

/** How it works: one task as a step-by-step picture (tools/steps/how-flow.mjs draws it), and three questions on the sandbox. */
const how = defineCollection({
  loader: pages('how'),
  schema: z.strictObject({
    meta,
    intro: z.strictObject({ ...head, body: text }),
    player: z.strictObject({
      label: text, count: text.includes('{n}').includes('{total}'), ready: text,
      play: text, pause: text, replay: text, prev: text, next: text, restart: text, speed: text,
      all: text, legend: text, data: text, red: text, green: text,
    }),
    /** One line per step of the picture, in its order (generated/how/flow.json has the same count). */
    steps: list(text, 18),
    questions: z.strictObject({ ...head, items: list(z.strictObject({ q: text, a: text }), 3), note: text }),
  }),
});

const about = defineCollection({
  loader: pages('about'),
  schema: z.strictObject({
    meta,
    intro: z.strictObject({ ...head, body: text }),
    built: z.strictObject({ ...head, body: text, facts: z.strictObject({ mergedPrs: text, records: text, testFiles: text, version: text }) }),
    privacy: z.strictObject({ ...head, items: list(z.strictObject({ title: text, body: text }), 4) }),
    contact: z.strictObject({ ...head, items: list(z.strictObject({ title: text, body: text }), 3) }),
    license: z.strictObject({ ...head, body: text }),
  }),
});

/** The guides as text, by file: read through Vite, so a new translation is picked up with no list to change. */
const GUIDES = import.meta.glob<string>('./content/generated/docs/guide/*.md', { query: '?raw', import: 'default', eager: true });

/**
 * The guide, one entry per chapter and language (id `<lang>/<slug>`) and one for its index page
 * (id `<lang>`), split by lib/content/chapters.mjs from generated/docs/guide/<lang>.md. A language with no
 * guide, and a chapter its guide leaves out, show the English one. The guide's links to its own
 * anchors point at the chapter pages. Each chapter's section ids are checked against the ones
 * Astro gives its headings, so the index page's old anchors always land.
 */
const chapterLoader: Loader = {
  name: 'yokoten:guide-chapters',
  load: async ({ store, parseData, renderMarkdown, generateDigest }) => {
    store.clear();
    const text = (lang: string) => GUIDES[`./content/generated/docs/guide/${lang}.md`];
    if (!text('en')) throw new Error('site/src/content/generated/docs/guide/en.md is missing: run npm run site:facts');
    const en = parseDoc(text('en'));
    for (const lang of buildLangs()) {
      const own = lang === 'en' ? en : text(lang) ? parseDoc(text(lang)) : null;
      const g = guide(en.body, own === en ? en.body : (own?.body ?? null));
      const doc = (own ?? en).data;
      const to = (chapter: string, section: string) => (chapter ? href('guide', lang, section ? `#${section}` : '', chapter) : href('guide', lang, `#${section}`));
      const put = async (id: string, raw: Record<string, unknown>, body: string) => {
        const data = await parseData({ id, data: raw });
        const rendered = await renderMarkdown(body);
        store.set({ id, data, body, rendered, digest: generateDigest({ data, body }) });
        return rendered;
      };
      const base = { lang, guideTitle: doc.title, source: doc.source, ref: doc.ref };
      await put(lang, { ...base, slug: '', order: 0, title: doc.title, translated: g.translated, sections: [], anchors: g.anchors }, relink(g.intro, g.anchors, to));
      for (const [i, c] of g.chapters.entries()) {
        const rendered = await put(`${lang}/${c.slug}`, { ...base, slug: c.slug, order: i + 1, title: c.title, translated: c.translated, sections: c.headings, anchors: {} }, relink(c.body, g.anchors, to));
        const got = (rendered.metadata?.headings ?? []).map((h: { slug: string }) => h.slug).join(' ');
        const want = c.headings.map((h: { slug: string }) => h.slug).join(' ');
        if (got !== want) throw new Error(`guide chapter ${lang}/${c.slug}: its section ids are "${got}", lib/content/chapters.mjs made "${want}"`);
      }
    }
  },
};
const chapters = defineCollection({
  loader: chapterLoader,
  schema: z.strictObject({
    lang: z.enum(['en', 'zh', 'tw', 'ja']),
    /** The chapter's slug, the English heading's id in every language; '' for the index page. */
    slug: z.string(),
    order: z.number().int().min(0),
    title: text,
    /** Shown in the page's language; false: the English chapter, with the note. */
    translated: z.boolean(),
    sections: z.array(z.strictObject({ depth: z.number().int().min(2).max(5), text, slug: text })),
    /** The index page only: every heading id of the old one-page guide, to [chapter, section]. */
    anchors: z.record(z.string(), z.tuple([z.string(), z.string()])),
    guideTitle: text,
    source: z.url(),
    ref: text,
  }),
});

export const collections = { site, home, quickstart, stopped, docs, chapters, how, road, about };
