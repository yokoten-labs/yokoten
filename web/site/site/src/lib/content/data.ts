// A page's data in one language. A language with no data file fails the build, with its name.
import { getEntry, type CollectionEntry, type CollectionKey } from 'astro:content';
import type { Lang } from '../i18n';

export async function pageData<C extends CollectionKey>(collection: C, lang: Lang): Promise<CollectionEntry<C>['data']> {
  const entry = (await getEntry(collection, lang)) as CollectionEntry<C> | undefined;
  if (!entry) throw new Error(`site/src/content/pages/${collection}/${lang}.json is missing: every page needs all four languages (en, zh, tw, ja)`);
  return entry.data;
}
