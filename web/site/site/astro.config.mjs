// The new yokoten.app (stage S2 of site-update-plan.md): static pages, content as data checked
// against one schema per page, no client JavaScript but public/js/theme.js. It lives in site/ until
// the cut-over; `npm run site:build` builds it into site/dist.
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import fonts from './integrations/fonts.mjs';
import markdown from './integrations/markdown.mjs';
import noInlineScripts from './integrations/no-inline-scripts.mjs';

export default defineConfig({
  site: 'https://yokoten.app',
  outDir: '../dist',
  trailingSlash: 'never',
  // /start.html, served at /start: the URLs today's site has.
  build: { format: 'file', inlineStylesheets: 'never' },
  // en at the root; the others under their folder (src/lib/i18n.ts holds the table).
  i18n: {
    locales: ['en', 'zh', 'zh-tw', 'ja'],
    defaultLocale: 'en',
    routing: { prefixDefaultLocale: false },
  },
  devToolbar: { enabled: false },
  // fonts after markdown: it rewrites the finished pages, after markdown has moved them;
  // the script check last, on the pages as they ship
  integrations: [markdown(), fonts(), noInlineScripts()],
  // The docs' code blocks are set on the terminal's ink by the site's own styles, not by a highlighter.
  markdown: { syntaxHighlight: false },
  // assetsInlineLimit 0: Astro writes even a small script to its own file, which the policy allows
  vite: { plugins: [tailwindcss()], build: { assetsInlineLimit: 0 } },
});
