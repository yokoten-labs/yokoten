// The four languages and the pages. public/js/theme.js and site/integrations/markdown.mjs keep the same
// table: change all three together.

export const LANGS = ['en', 'zh', 'tw', 'ja'] as const;
export type Lang = (typeof LANGS)[number];

export const LANG_INFO: Record<Lang, { dir: string; html: string; name: string; og: 'en' | 'zh' }> = {
  en: { dir: '', html: 'en', name: 'English', og: 'en' },
  zh: { dir: 'zh', html: 'zh-CN', name: '简体中文', og: 'zh' },
  tw: { dir: 'zh-tw', html: 'zh-Hant-TW', name: '繁體中文', og: 'zh' },
  ja: { dir: 'ja', html: 'ja', name: '日本語', og: 'en' },
};

/** The pages: home, road and about, and the docs' quick start (docs) and stop page (stopped), are laid out
 * from page data; overview (the README), docsRoad (every step of the road) and guide (the guide's
 * chapters, one page each under it) are the repo's docs. */
export const PAGES = ['home', 'how', 'docs', 'stopped', 'overview', 'docsRoad', 'guide', 'road', 'about'] as const;
export type Page = (typeof PAGES)[number];
const SLUGS: Record<Page, string> = {
  home: '',
  how: 'how',
  docs: 'docs',
  stopped: 'docs/stopped',
  overview: 'docs/overview',
  docsRoad: 'docs/road',
  guide: 'docs/guide',
  road: 'road',
  about: 'about',
};

/** The docs pages, as the header marks them. */
export const DOCS_PAGES: readonly Page[] = ['docs', 'stopped', 'overview', 'docsRoad', 'guide'];

/** The repo's docs shown whole, as generated/docs names them, and the page each one is. */
export const DOCS = ['start', 'road'] as const;
export type Doc = (typeof DOCS)[number];
export const DOC_PAGE: Record<Doc, Page> = { start: 'overview', road: 'docsRoad' };

/** The URL of a page in a language: /, /docs, /docs/road, /zh/, /zh/docs; `sub` is a page under it, a guide chapter: /docs/guide/privacy. */
export function href(page: Page, lang: Lang, hash = '', sub = ''): string {
  const dir = LANG_INFO[lang].dir;
  const slug = SLUGS[page] + (sub ? `/${sub}` : '');
  return (dir ? `/${dir}/${slug}` : `/${slug}`) + hash;
}

/**
 * The languages this build makes. All four, always, for a real build: a language with no data
 * fails it. SITE_LANGS=en builds the English pages alone, for stage S2 part 1, before the
 * translations exist; it is never set for a deploy.
 */
export function buildLangs(): Lang[] {
  const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
  const asked = (env.SITE_LANGS ?? '').split(',').map((s: string) => s.trim()).filter(Boolean);
  if (!asked.length) return [...LANGS];
  const bad = asked.filter((l) => !(LANGS as readonly string[]).includes(l));
  if (bad.length) throw new Error(`SITE_LANGS names unknown languages: ${bad.join(', ')}`);
  return asked as Lang[];
}

/** getStaticPaths for a page: one path per language, English at the root. */
export const langPaths = () => buildLangs().map((lang) => ({ params: { lang: LANG_INFO[lang].dir || undefined }, props: { lang } }));
