Fixed

`yokoten doctor` no longer calls a working setup missing. `forge test` (Foundry) counts as a
test runner. A Renovate config counts as dependency updates. A `.changeset/` folder counts as
a changelog. A license inside a `licenses/` or `LICENSES/` folder counts. A Dockerfile, a
Makefile or a script inside a `build/` folder is source, not build output. A CLAUDE.md with no
AGENTS.md now says the rules exist but only Claude Code reads them, and the fix says to move
them to AGENTS.md and import them (#1167).
