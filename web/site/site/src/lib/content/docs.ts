// The docs pages' Markdown: the README and the road from the docs collection (generated/docs/<doc>/<lang>.md),
// the guide from the chapters collection. A doc with no translation in a language is shown in English,
// with a note: `translated` says which.
import { getCollection, type CollectionEntry } from 'astro:content';
import { href, type Doc, type Lang } from '../i18n';

export async function docEntry(doc: Doc, lang: Lang): Promise<{ entry: CollectionEntry<'docs'>; translated: boolean }> {
  // getCollection, not getEntry: a missing translation is expected, and getEntry warns about it.
  const all = await getCollection('docs');
  const own = all.find((e) => e.id === `${doc}.${lang}`);
  if (own) return { entry: own, translated: true };
  const en = all.find((e) => e.id === `${doc}.en`);
  if (!en) throw new Error(`site/src/content/generated/docs/${doc}/en.md is missing: run npm run site:facts`);
  return { entry: en, translated: lang === 'en' };
}

/** A language's guide: its index entry and its chapters, in the guide's order. */
export async function guideOf(lang: Lang): Promise<{ index: CollectionEntry<'chapters'>; chapters: CollectionEntry<'chapters'>[] }> {
  const all = (await getCollection('chapters')).filter((e) => e.data.lang === lang).sort((a, b) => a.data.order - b.data.order);
  const [index, ...chapters] = all;
  if (!index || index.data.slug !== '') throw new Error(`the guide has no index entry for ${lang}`);
  return { index, chapters };
}

/** The guide's sections other pages link to, by their heading in each language's guide (tw has no guide yet: it shows the English one). */
const SECTIONS = {
  /** From the home page's "Every rule": a chapter. */
  coreRules: { text: { en: 'The core rules', zh: '核心规则', tw: '核心規則', ja: '核心ルール' } },
  /** From the road page: sections of a chapter. */
  desk: { text: { en: 'The desk', zh: '工位', tw: '工位', ja: 'デスク' } },
  teamBoard: { text: { en: 'The kanban', zh: '看板', tw: '看板', ja: 'カンバン' } },
} as const satisfies Record<string, { text: Record<Lang, string> }>;

/** The link to a chapter, or a section in it, of the guide this language shows. A renamed heading fails the build. */
export async function guideLink(lang: Lang, section: keyof typeof SECTIONS): Promise<string> {
  const { chapters } = await guideOf(lang);
  for (const c of chapters) {
    const want = SECTIONS[section].text[c.data.translated ? lang : 'en'];
    if (c.data.title === want) return href('guide', lang, '', c.data.slug);
    const s = c.data.sections.find((h) => h.text === want);
    if (s) return href('guide', lang, `#${s.slug}`, c.data.slug);
  }
  throw new Error(`the ${lang} guide has no chapter or section "${SECTIONS[section].text[lang]}": a page links to it`);
}
