// The site's content layout (#631). The pages live in the repo's docs/ folder,
// next to guide.md, NOT copied under website/: a pull request then changes code
// and docs together. Only the UI-word overrides stay in src/content/i18n.
import { defineCollection } from 'astro:content';
import { docsSchema, i18nSchema } from '@astrojs/starlight/schema';
import { i18nLoader } from '@astrojs/starlight/loaders';
import { glob } from 'astro/loaders';

// Starlight's docs loader, pointed one floor up: same file pattern, and glob's
// own slug rules, which are the ones Starlight builds its routes from. English
// sits at docs/site/ and every other language in its folder beside it, so every
// language has the same layout, sections, pages and order (owner 2026-10-25).
const siteDocs: {
  name: string;
  load: (context: { config: unknown }) => Promise<void>;
} = {
  name: 'site-docs-loader',
  load: (context: { config: { root: URL } }) =>
    // The base resolves against the project root, so ../docs/site is docs/ in the repo.
    glob({
      base: '../docs/site',
      pattern: '**/[^_]*.{md,mdx}',
    }).load(context),
};

const docs = defineCollection({ loader: siteDocs, schema: docsSchema() });
const i18n = defineCollection({ loader: i18nLoader(), schema: i18nSchema() });

export const collections = { docs, i18n };
