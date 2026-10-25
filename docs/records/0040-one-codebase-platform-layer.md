# 0040 One codebase, with a platform layer

Status: accepted
Date: 2026-10-25 (UTC)

## Context

yokoten runs on Linux, macOS and Windows. Before the v0.1.1 release, the whole test suite
ran on native Windows for the first time: 175 failures in about 50 files. A triage of the
failures found that most were test setup (POSIX paths, a fake `gh` with no extension, a
PATH joined with `:`). A few were real bugs, and all of those came from code that decides
the platform by itself, in place:

- the wipe guard split paths on `/` only, so on Windows it missed the home folder;
- `yokoten upgrade` ran `claude.cmd`, but the native Claude Code installer puts only
  `claude.exe` on the PATH;
- the Copilot trust check kept only folders that start with `/`.

`process.platform` appears in 18 files under `src/`. Path and process handling is written
again in each place that needs it.

## Decision

1. **One codebase for all three platforms.** No fork and no per-platform package.
2. **A platform layer in `src/platform/`.** It is the only place that may ask which
   system it runs on. It holds:
   - starting a program: `.cmd` and `.exe`, quoting, killing a process tree;
   - paths: separators, case, drive letters, Git Bash `/c/...` paths, PATHEXT;
   - reading a command for the guard: the bash reader now, a PowerShell reader later;
   - the desk sandbox: bwrap on Linux, seatbelt on macOS, Windows later.
3. **Each platform function takes the platform as an argument**, as `isInside(path,
   folder, platform)` already does. Linux CI then tests the Windows logic too.
4. **An architecture test** fails when code outside `src/platform/` reads
   `process.platform` or builds a path with a literal separator. It works like the test
   that keeps `process.env` out of `src/`.
5. **The guard picks the reader for the agent's shell.** A command it cannot read is
   refused, never allowed.
6. **Native Windows CI is required.** It starts in v0.1.1 with a list of known failures
   that may only shrink.

## Options not taken

- **A codebase per platform.** Every rule would be written three times, and a rule could
  hold on Linux and let a command through on Windows. For a guard, that is the worst
  failure.
- **Linux and macOS only, with Windows through WSL.** Most new programmers are on
  Windows, and many of their agents run PowerShell (issue #332).
- **A cross-platform framework.** yokoten keeps no runtime dependencies. A small
  permissive library (for example cross-spawn) may be copied into `src/platform/` with its
  notice, if the work shows a need.

## Consequences

- Platform bugs get fixed in one place, and a fix reaches every caller.
- The move is a refactor across about 18 files (issue #1000). It is the first step of full native
  Windows support in v0.1.2, before the remaining Windows bug fixes.
- v0.1.1 ships with WSL fully supported and native Windows in beta. The real bugs above
  that affect normal use are fixed in place for v0.1.1, and move into the layer in v0.1.2.
- Every new test that touches paths or processes has to pass on Windows CI.
