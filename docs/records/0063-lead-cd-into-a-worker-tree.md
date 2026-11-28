# 0063 A lead's cd into a marked worktree, and the way out

Status: accepted
Date: 2026-11-28 (UTC)

## Context

A worktree the lead marks makes every agent in it a worker (issue #555, issue #566).
The guard knows the role from the session's folder. The agent runtime keeps the folder that a
command line ends in. So `cd <marked worktree> && …`, run by the lead, moves the lead's
session into the worktree, and from then on the guard treats the lead as a worker.

This happened on 2026-11-27 (issue #1392). The lead could not push, could not `cd` back, and
could not unmark the worktree. The owner tried to unmark it by hand three times and failed:
PowerShell has no yokoten, and in `wsl -- bash -lc` yokoten is not on PATH. Only a restart of
the session moved the folder back.

The issue offered two ways out: let a `cd` out of a marked worktree to the main checkout
through, or name the one command the owner runs to unlock it.

## Decision

1. **The guard refuses a lead's line that ends in a marked worktree.** The guard follows
   each `cd` and `pushd` at the top level of the line, also after `builtin`, `command`,
   `then`, `do` and `else`. A `cd` inside `( … )` or `$( … )`, or with a `|` or a
   background `&` next to it, moves nothing. If the line ends in a marked worktree, it is
   refused, so `cd <wt> && git status && cd <main>` passes. The message names `git -C`,
   `env -C` and a subshell instead.
2. **No `cd` out for a session in a marked worktree.** The guard can't tell a lead that came
   in by mistake from a worker. Some runtimes pass a worker no YOKOTEN_ROLE (Muse Code passes
   none). For such a worker the mark is the only sign of its role. A `cd` out to the main
   checkout would make it the lead there: it could push, run the bot and unmark itself.
3. **The refusal names the owner's one command.** When the role comes from the mark, the
   note on each worker refusal ends with the unmark command, for a lead that came in by a
   `cd`. The command names node and the yokoten script by full path, so it needs no PATH.
   On WSL it runs through `wsl.exe -d <distro> -e`, so it runs as it is from Windows
   PowerShell, with no shell and no quoting.

## Options not taken

- **Allow a `cd` back to the main checkout.** It is the escape in point 2. YOKOTEN_ROLE
  can't close it, because the runtimes that leave the role out are the ones the mark is for.
- **Unmark on the lead's own request from inside the worktree.** The same escape: a worker
  could unmark its own worktree, which issue #1392 keeps out of scope.
- **Read the runtime's folder after each call.** The guard sees only the command, before it
  runs; it has no say in where the runtime keeps the session.

## Consequences

- Point 1 makes the mistake rare; point 3 makes it cost one command from the owner, not a
  session restart.
- A worker reads the unlock line too. It says the line is for a lead that came in by a
  `cd`; a worker that asks the owner to run it is asking, not escaping.
- Point 1 guards against a mistake, not an attack. These are not read, and pass: `eval`,
  `bash -c`, a `cd` inside `case … esac`, a target that is not plain text (`"$X"`,
  `$(…)`, a glob, `cd -`, `~-`), a CDPATH search, and a `(` after a `#` comment. The
  lead's mistake is a plain `cd <path>`; reading more would refuse good lines for little
  gain.
- Each worker rule reads the program after `wsl.exe` (`-d`, `--cd`, `-u`, `-e`, `--exec`,
  `--`, and a lone `~`), as after `env` or `sudo`. So a worker can't run the unlock command
  through it.
- The worker rules do not yet read through `powershell` or `pwsh` with `-c` or `-Command`.
  A worker could run the unlock command that way. Yokoten issue #1393 tracks it.
