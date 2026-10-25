# 0042 The docs site: Starlight in website/, text in docs/

Status: proposed; the owner accepts or refuses
Date: 2026-10-25 (UTC)
Issue: #631

## Context

The owner decided on 2026-10-22 to build the docs site with Astro Starlight. It lives in a
new `website/` folder of this repo, with its own `package.json`. It merges after the v0.1.1
release. The languages are English, 简体中文, 繁體中文 and 日本語 (2026-10-25: exactly the
same layout, sections, pages and order in every language; only the words differ). This
record keeps the choices made while building the skeleton, so the next issue about the
site does not argue them again.

What the site is for: a reader who has never used yokoten finds the command and the four
sections (Start, Guides, Reference, Ideas). Each question has one answer, in their own
language. The text stays in `docs/`, so a pull request changes code and docs together.

## What was chosen

**Starlight 0.42.7 on Astro 7.4.2, versions exact, lockfile committed.** Exact pins
mean the site build never moves under a PR; the lockfile is what CI builds from.
Nothing in `website/` shares the root `package.json`, and `scripts/package/package-contents.ts`
fails the package if any `website/` path would ship.

**The text lives in `docs/site/`, not under `website/`.** One collection: English at
`docs/site/`, every other language beside it in its own folder (`zh-cn/`, `zh-tw/`,
`ja/`), sections as folders inside (`start/`, `guides/`, `reference/`, `ideas/`). The
loader in `website/src/content.config.ts` is Starlight's own docs loader pointed one
floor up (Astro's `glob` loader, `base '../docs/site'`, same file pattern and slug
rules). The alternative, a copy under `website/src/content/docs/`, was dropped: a copy
goes stale, and the two trees then disagree about which language is behind.

**One sidebar, in the config, for every language.** Starlight picks the group label by
`lang` from the `translations` of each group. It also rewrites each `slug` with the locale
prefix itself (`utils/navigation.js` adds `zh-cn/` and friends). So one array holds all
four languages and cannot drift out of order. There are no per-locale sidebar objects.
That form of `sidebar` no longer parses in Starlight 0.42, which wants an array with
`translations`.

**Search, light and dark, phone layout: the defaults.** Pagefind ships inside
Starlight, offline, no outside service. The brand is one indigo hue family
(`--sl-hue: 253`, `--sl-hue-accent: 264` in `website/src/styles/custom.css`) plus the
favicon. It was chosen to read in both themes. The exact colour is the owner's to change.

**The home page is a Starlight splash doc, in content, not in code.** It holds one install
command (`cd your-project` then `npx yokoten`) and the claim. It also holds a placeholder
board SVG (`website/public/board.svg`). The real screenshot replaces it in the copy phase.

**Translation-behind notices** are not built this far. Starlight's frontmatter holds
nothing for it. It matters only once the real pages exist. The practical shape is
`updatedAt` or a custom banner component, compared with the git history of the English
source. That is a decision for the copy issues, not the skeleton issue.

## What is still open

The layout guard caps a folder at 7 entries, and both folders the site touches are
over it. `docs/` already held exactly 7 entries (assets/, facts.json, guide.md,
i18n/, records/, server.md, standard.md). The site adds `docs/site`, which itself
needs 9 top entries. These are home and 404 at the root, four section folders and three
language folders. Starlight's slugs require this shape, because a nested `langs/` folder
would break Starlight's slug-to-locale mapping. The checker's own remedy fits.
`layout.exempt` takes `docs/site` (an upstream structure the files must keep) and `docs`.
Or, as the lead chooses, one existing docs file moves into an exempt or grouped folder.
The skeleton cannot commit until that decision lands, because the commit check fails the
tree. The work is staged and described below.

The workflow job that builds the site on each pull request is drafted but not written
into `.github/workflows/yokoten.yml`: `.github/**` is lead-only, so the lead applies
it. Everything it needs is in `website/` (`npm run build`, then `npm run links`,
which fails on a broken internal link; the build is offline, and nothing fetches the
outside).

The 404 override (`docs/site/404.mdx`) works through Starlight's own injected route,
but the build logs one warning: the `[...slug]` route also tries to render the same
entry and loses to the injected `/404` route. Page and localized copies render right;
the warning looks like an upstream bug to file if it stays.

## Costs

The site adds one dev-time build, its own `npm ci` in `website/`, and one guard to the
package check (already in). It adds no runtime dependency to yokoten: the package ships
`bin/`, `src/`, `kit/`, `dist/`, `package.json`, `README.md` and `LICENSE`, unchanged.
