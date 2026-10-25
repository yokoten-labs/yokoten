# 0040 One codebase, with adapters for where an agent runs

Status: accepted
Date: 2026-10-25 (UTC)

## Context

yokoten runs on Linux, macOS and Windows. Before the v0.1.1 release, the whole test suite
ran on native Windows for the first time: 175 failures in about 50 files. A triage found
that most were test setup (POSIX paths, a fake `gh` with no extension, a PATH joined with
`:`). The real bugs all came from code that decides the platform by itself, in place:

- the wipe guard split paths on `/` only, so on Windows it let `rm -rf ~` through (#999);
- `yokoten upgrade` ran `claude.cmd`, but the native installer puts only `claude.exe` on
  the PATH (#1002);
- the Copilot trust check kept only folders that start with `/` (#1003).

`process.platform` appears in 18 files under `src/`, and path and process handling is
written again in each place that needs it.

Big cross-platform projects keep one codebase. Git puts the differences in `compat/`.
Node's libuv has `src/unix/` and `src/win/` under one interface. VS Code answers "which
system" in one module, `platform.ts`, but branches on it all over its code. Each one keeps
the mechanisms in one place, and none of them bans every branch elsewhere.

## Decision

1. **One codebase for all three platforms.** No fork and no per-platform package.
2. **A place descriptor.** Where an agent runs is a *place*: the system (Linux, macOS,
   Windows, and WSL as its own case), the agent's shell, the sandbox, and the machine
   (local, container, remote, CI). The entry point works it out once and passes it down.
   Nothing below the entry point detects it again.
3. **Four kinds of adapters, each behind one interface:**
   - `src/platform/`: paths (separators, case, drive letters, Git Bash `/c/...`, the
     home and system folders) and processes (finding a program through PATHEXT, starting
     it without a shell, killing a process tree). This is the only place that reads
     `process.platform`, and the only place that imports `node:child_process`.
   - shell readers, in the guard: bash now, PowerShell and cmd later. The reader is chosen
     by the agent's shell, not by the system: Claude Code runs Git Bash on Windows.
   - agent runtimes (`src/agents/runtimes/`): each one states which shell runs its hooks
     on each system, and where its config lives.
   - desk sandboxes (`src/agents/desk/`): bwrap, seatbelt, and later Windows.
4. **Rules are pure.** Code under `src/rules/` reads no disk, starts no program and does
   not detect the system. It takes the read command, paths in one form, and the config.
   Other code may branch on the place it is given, for example to word a doctor line for
   Windows.
5. **Tests hold the shape:**
   - an architecture test fails on `process.platform` outside `src/platform/`, on
     `node:child_process` outside its process module, and on `node:fs` under `src/rules/`;
   - each platform function takes the platform as an argument, so Linux CI tests the
     Windows logic;
   - one table of refuse-and-allow cases runs for every system and every shell reader;
   - each adapter passes a shared contract test before it merges.
6. **Fail closed.** A command, path or shell the guard cannot read is refused. A helper
   that cannot start (for example the redact filter) does not let output through.
7. **Speed.** No child process on the guard's hot path. Only the adapters for the place
   are loaded. Windows CI keeps the guard's time budget too.
8. **Native Windows CI is required.** It starts in v0.1.1 with a list of known failures
   that may only shrink.

## Options not taken

- **A codebase per platform.** Every rule would be written three times, and a rule could
  hold on Linux and let a command through on Windows. For a guard, that is the worst
  failure.
- **Linux and macOS only, with Windows through WSL.** Most new programmers are on
  Windows, and many of their agents run PowerShell (issue #332).
- **Banning every platform branch outside the layer.** Stricter than Git, Node or VS
  Code, and it would force odd wrappers for plain choices such as a doctor line's wording.
- **A cross-platform framework.** yokoten keeps no runtime dependencies. A small
  permissive library may be copied into `src/platform/` with its notice, if the work shows
  a need.

## Consequences

- A platform bug gets fixed in one place, and the fix reaches every caller.
- A new system, shell, agent tool or sandbox is one adapter plus the contract test; the
  rules do not change.
- The move is a refactor across about 18 files, in small pull requests (issue #1000):
  paths and processes in v0.1.2, the rest in v0.2.0. Record 0041 places it in the larger
  plan.
- v0.1.1 ships with WSL fully supported and native Windows in beta. The real bugs above
  are fixed in place for v0.1.1 and move into the layer in v0.1.2.
