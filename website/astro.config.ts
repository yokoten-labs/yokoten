// The docs site (#631): Astro Starlight in website/, its own package.json, nothing
// of it ships in the npm package (scripts/package/package-contents.ts holds the
// guard). The text itself stays in docs/ (site step 3); this config is the shape.
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// The repo: always https://github.com/yokoten-labs/yokoten (#587). Never a fork.
const GITHUB = 'https://github.com/yokoten-labs/yokoten';

// The four languages (owner 2026-10-22). `lang` is the Starlight locale code and
// the key that picks sidebar and search translations.
const LANGS = {
  'zh-cn': { lang: 'zh-CN', label: '简体中文' },
  'zh-tw': { lang: 'zh-TW', label: '繁體中文' },
  'ja': { lang: 'ja', label: '日本語' },
} as const;

// Four sections, by the reader's first question (owner 2026-10-22). Every language
// has the same sections, pages and order; only the words differ. The sidebar is one
// array: `label` is English, `translations` maps every other `lang` code to its words.
const SECTIONS = {
  start: { 'en': 'Start', 'zh-CN': '开始', 'zh-TW': '開始', 'ja': '始める' },
  guides: { 'en': 'Guides', 'zh-CN': '指南', 'zh-TW': '指南', 'ja': 'ガイド' },
  reference: { 'en': 'Reference', 'zh-CN': '参考', 'zh-TW': '參考', 'ja': 'リファレンス' },
  ideas: { 'en': 'Ideas', 'zh-CN': '理念', 'zh-TW': '理念', 'ja': '考え方' },
} as const;

const sidebar = Object.entries(SECTIONS).map(([slug, labels]) => {
  const { en, ...translations } = labels;
  return {
    label: en,
    translations,
    // Pages live under one folder per section; Starlight lists, orders and
    // localizes them, so the sidebar needs no change when a section grows.
    items: [{ autogenerate: { directory: slug } }],
  };
});

export default defineConfig({
  // The docs subdomain on Cloudflare (owner 2026-10-22), not the main site. The
  // exact name is the owner's to confirm; docs.yokoten.app is the working guess.
  site: 'https://docs.yokoten.app',
  integrations: [
    starlight({
      title: 'yokoten',
      description: 'Every AI agent. One set of rules.',
      // The offline search index is built into Starlight (no outside service).
      // Light and dark, and the phone layout, come with the default theme.
      locales: {
        root: { label: 'English', lang: 'en' },
        ...LANGS,
      },
      defaultLocale: 'root',
      sidebar: sidebar,
      social: [{ icon: 'github', href: GITHUB, label: 'GitHub' }],
      customCss: ['./src/styles/custom.css'],
    }),
  ],
});
