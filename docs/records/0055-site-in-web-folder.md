# 0055 The website lives in the main repository, under web/site

Status: accepted
Date: 2026-10-29 (UTC)

## Context

The website (yokoten.app) was built in a private repository on the owner's own host, with
about 80 commits of history. Its pages read their facts from a yokoten checkout next to it
(`../yokoten`), and every screen it shows is captured from yokoten's own tests. The owner had
said the site moves into the main repository; on 2026-10-29 he asked to start.

Facts from the move:

- The site is 147 files, about 10 MB, of which the four promo videos are 8 MB.
- A scan of every file found no private information. The one email it flags,
  `conduct@yokoten.app`, is the project's public address and is already in
  `privacy.allow`.
- Eight of its folders hold more than 7 entries, the cap this repository keeps.
- The site has its own dependencies (Astro, sharp) and a Cloudflare Worker.

Record 0044 already put the kanban page in its own web package, `web/kanban/`, with its
own build, and kept the folder cap and the naming rules for it.

## Decision

1. **The site is `web/site/`**, beside `web/kanban/` (record 0044). Anything that runs in a
   browser lives under `web/`.
2. **The npm package does not change.** `files` in `package.json` stays `bin`, `src`, `kit`,
   `dist`; nothing under `web/` reaches a user's install, and the core keeps zero run-time
   dependencies. The site keeps its own `package.json` and lock file.
3. **CI by path.** A pull request that changes only `web/site/**` builds and checks the site
   and does not run the core suite; one that changes only the core does not build the site.
   A change to both runs both.
4. **The site reads yokoten from this repository**, not from a checkout next to it.
5. **Folders of 7 hold in `web/site/`** as everywhere else (as record 0044 says for the kanban
   page): its folders are regrouped, not exempted.
6. **One commit, not the history.** The site arrives as one commit of its current files. Its
   history stays in the private repository as an archive, so nothing from early commits
   reaches the public repository.
7. **The videos stay in the repository for now** (8 MB). Each new render adds to git history
   for good, so after the hackathon they move to object storage, with the Worker reading
   them from there.
8. **Only the owner deploys**, as before; the deploy command runs in `web/site/`.

## Options not taken

- **A repository of its own for the site.** Two places to keep in step for every docs and
  screen change; the site reads facts straight from the code, so one repository is simpler.
- **Exempting `web/site/` from the folder cap.** Less work now, but it contradicts record
  0044 and opens a hole in a rule this project asks every adopter to keep.
- **Bringing the history across.** It would need a full privacy rewrite of 80 commits for no
  user value.
- **Videos out of git now.** Right in the long run, but it changes the Worker before the
  hackathon.

## Consequences

- Docs and the site change in one pull request; a screen change and its page land together.
- CI needs path filters and a site job; the required checks must still be green for a
  site-only pull request (a skipped core job counts as passed there).
- The yokoten-doctor hackathon entry is not part of this: it lives in the owner's personal
  repository for now and links to the docs only.
- To check: the package size stays the same after the move (`npm pack --dry-run`), and a
  site-only pull request runs only the site job.
