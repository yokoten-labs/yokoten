# 0044 The kanban page is its own web package; the CLI core stays as it is

Status: accepted
Date: 2026-10-26 (UTC)

## Context

Record 0017 chose a plain page for the board: HTML, CSS and JavaScript, no framework,
no new dependency. Record 0043 renamed the board to `kanban` and made it the one web
view of v0.1.x.

The plain page was hard to build, and v0.1.1 shipped it half done:

- The board is about 6,700 lines in 26 files under `src/commands/advice/board/`.
- About 3,000 of them are page code (`page/` and `view.ts`). `page.ts` copies the
  browser functions into the page as text, so each may call only the others: no
  imports, no library.
- Live output, the login cookie, columns and redraws are all written by hand.
- The page lives under every rule of the core: no dependency, no build, `.ts` only,
  folders of 7, four languages.

Those rules are right for the core. The core goes into every user's project, and the
guard runs on every tool call, so it must start fast and install nothing. A page in a
browser has none of these limits.

On 2026-10-26 the owner said: most users prefer a GUI, the CLI is the infrastructure
under it, and the framework is too heavy to develop in. He agreed to a mixed layout:
the kanban page as its own web package, the CLI core unchanged.

## Decision

1. **Two parts, one repository, one npm package.**

   | | The core (`src/`, `bin/`) | The kanban page (`web/kanban/`) |
   |---|---|---|
   | Language | TypeScript that Node runs as it is | TypeScript and TSX |
   | Libraries | none at run time | React, built with Vite |
   | Build | none (only `npm pack`) | `vite build` into static files |
   | Tests | `node --test` | `node --test` on the built page, and the API tests |

   The page's libraries are build-time dependencies only. The built files go into the
   npm package, so `npx yokoten kanban` still installs nothing else. The published
   package keeps zero run-time dependencies.

2. **The core serves data; the page only reads it.** `yokoten kanban` starts the local
   server on 127.0.0.1, as record 0017 says, and serves the built page. The page talks
   to the core through a small read-only API:
   - `GET /api/state`: one snapshot of what the page shows: every AI session and its
     state, the pull requests that wait on the person and why, and the GitHub Actions
     state of record 0043;
   - `GET /api/sessions/<id>/stream`: one session's live output (server-sent events).

   The API has no write route: any other method gets 405. The shapes of its answers are TypeScript types in one
   file that both parts import, so the two sides cannot disagree.

3. **The data code stays in the core.** Reading desks, logs, usage and GitHub
   (`feed/`, `server.ts`, `board-pulls.ts`) stays where it is and keeps its tests. The
   page code (`page/`, `page/browser/`, `view.ts`, `words.ts`, `phrases.ts`) is rebuilt
   in `web/kanban/`. The old page stays until the new one passes the release
   walk-through, then it is removed in the next release (the change file says so).
   `controls.ts` (buttons that act) is not carried over: the kanban is read-only.

4. **Which rules apply where.**
   - **Everywhere (hard lines):** security, privacy (the commit check scans `web/` too),
     the guard, UTC, no force push, no token in the page or the terminal, read-only.
   - **The core and `kit/` only:** no run-time dependency, no build step, `.ts` only,
     the 500-line cap.
   - **`web/kanban/` instead:** a lock file with exact versions, Dependabot, and CI that
     builds the page and checks its size. Folders of 7 and the names rules still hold.
   - **Languages:** the page starts in English. It gets the other three languages when
     its layout is stable, all four with the same layout (the site rule of 2026-10-25).

5. **Why React.** The site already uses React. The models we work with, weaker ones
   included, write React more reliably than any other web library. That counts more
   than a smaller bundle.

6. **Order.** First the API types and routes with tests, then the page with its three
   panes (record 0043, item 5), then `yokoten kanban` serves it. Each is one pull
   request.

This record replaces two points of record 0017: "the first view is a plain page" and
"a web framework for the page" (an option not taken). The rest of 0017 stands: the
local server on 127.0.0.1, read-only first, the `--text` view, and Tauri 2 before
Electron when a desktop shell comes.

## Options not taken

- **Keep the plain page.** v0.1.1 showed its cost: the board shipped half done.
- **Preact, Svelte or Solid.** Smaller bundles, but fewer examples for our models to
  follow, and the site would use a second library.
- **Next.js or another server framework.** It needs its own Node server and run-time
  dependencies. The core already serves the page.
- **A desktop app now (Tauri 2, or Wails as magpie uses).** v0.1.x is CLI only (owner,
  2026-10-24). The web page can be wrapped later without a rewrite.
- **A separate repository for the page.** One pull request could no longer change the
  API and the page together, and their versions would drift.
- **Rewrite the core in Go for one binary, as magpie does.** The hard parts on Windows
  are the sandbox, paths and shells, not the language. A rewrite would stop all other
  work for weeks.

## Consequences

- **Easier:** the page is a normal React project. A pane is a component, live output is
  a hook, and the type check sees all of it.
- **Easier:** the person sees a GUI with `npx yokoten kanban` and nothing to install.
- **Harder:** the repository now has build-time dependencies to watch: supply chain,
  updates, and a build in CI.
- **Harder:** two sets of rules. This record is where to look for which one holds.
- **To check:**
  - the published package has no `dependencies`;
  - the API answers no write method (a test sends POST, PUT and DELETE and expects 405);
  - the page and the terminal never show the access token;
  - the built page stays under a size budget set in CI.
