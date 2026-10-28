# yokoten-site

The website for [yokoten](https://github.com/yokoten-labs/yokoten), served at <https://yokoten.app>. It lives in the yokoten repository under `web/site/` (record 0055), with its own `package.json`; nothing here goes into the npm package.

Five pages (home, start, guard, road, about) in four languages (en, zh, zh-tw, ja), built by [Astro](https://astro.build) with Tailwind 4 and IBM Plex into static files. A Cloudflare Worker serves them as static assets, answers byte-range requests for the promo video, counts page views (no personal data) and serves the Markdown version of each page to AI agents. The only script a page ships is `js/theme.js` (theme, language, and how long the page was on screen).

```sh
npm install
npm run dev       # local preview of site/
npm run build     # facts, then astro build into dist/, then the language check
npm run deploy    # build, then wrangler deploy (worker/wrangler.jsonc)
```

## Where things live

- `site/src/content/pages/<page>/<lang>.json`: the words of each page, one file per language. `site/src/content.config.ts` holds one schema per page, the same for every language: strict keys and fixed list lengths, so a translation that drifts fails `astro build`. Text fields take `code` and `[a link](https://...)`; nothing else.
- `site/src/content/generated/`: the facts (`facts/`: commands, rules, road, agents, screens, version), the docs (`docs/<doc>/<lang>.md`) and the How it works picture (`how/`). `tools/steps/from-package.mjs` reads them from the yokoten package at its newest release tag (`YOKOTEN_SRC`, default this repository, two folders up; screens from `YOKOTEN_SCREENS`, the CI capture) and `npm run build` runs it first. The files are committed, so a build without the package keeps them. Do not edit them by hand.
- `site/src/pages/[...lang]/*.astro`: the layout of each page, shared by all four languages. `site/src/components/` (`brand/`, `frame/`, `blocks/`), `site/src/lib/` (`content/`, `page/`, `terminal/`), `site/src/layouts/`, `site/src/styles/`: the parts and the look.
- `site/integrations/markdown.mjs`: at build it writes each page's Markdown next to its HTML (`/start.md`, `/zh/index.md`), plus `llms.txt` (and one per language), `llms-full.txt`, `sitemap.xml` and `.well-known/security.txt`, from the same page data. `worker/markdown.js` serves them.
- `site/public/`: `_headers` (the CSP), `_redirects` (old URLs, 301), `agents.md`, `robots.txt`, `js/` (`theme.js`, `guide-anchors.js`), `images/` (the favicon and the share images `og-en.png`, `og-zh.png`), `video/` (the promo: `light/`, `dark/`, `captions/`), and fonts (written by the build, not in git).
- `worker/`: the Worker, and `wrangler.jsonc`: the assets directory is `dist/`.
- `tools/`: `steps/` (the steps `npm run build` runs), `images/` (share images, screenshots, a local preview), `stats/` (visits and stays), `promo/` (the promo video), and `tsconfig.json` for the plain JavaScript.

## The i18n rule

Every language has the same layout: the same sections, the same number and order of list items, the same components. The English meaning is fixed first; zh, zh-tw and ja say the same thing in natural idiom. Two nets hold it:

1. the schema, at `astro build`: a missing key, an extra key or a wrong list length fails the build;
2. `npm run i18n` (`tools/steps/i18n-check.mjs`), after the build: it reads the built HTML of all five pages in all four languages and compares sections, headings, list lengths, code blocks and links against English, and checks that every page has its `.md` twin. It fails with the first difference. `npm run build` runs it last.

To add or change text, change all four `<lang>.json` files of the page in the same commit.

## Other scripts

- `node tools/images/og-images.mjs` makes `site/public/images/og-en.png` and `og-zh.png` (1200×630) from `tools/images/social-preview.mjs`; `node tools/images/og-images.mjs github <out.png>` makes the 1280×640 GitHub preview.
- `node tools/steps/video-sizes.mjs` records the promo video's sizes for the Worker (`npm run build` runs it).
- `npm run visits` and `npm run stays` read the page-view and time-on-page numbers from Cloudflare.
- `npm run check` runs `tsc --noEmit -p tools` over the tools, the Worker and the integrations (a syntax check; the folder has no type packages).
- The promo video's source is in `tools/promo/`.
