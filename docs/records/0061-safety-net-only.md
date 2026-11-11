# 0061 The public yokoten is the safety net only

Status: accepted; read with [0062](0062-the-gate-and-the-hard-lines.md)
Date: 2026-11-11 (UTC)

## Context

Record [0035](0035-the-safeguard-is-the-mvp.md) said the safeguard is the MVP. Record
[0043](0043-v012-three-commands.md) cut the front to three commands. The code kept growing
after both. The numbers on 2026-11-11:

- 167 issues are open. A bot opened 165 of them.
- `src/` has about 61,500 lines, and the tests about 57,000.
- Since 2026-10-01, `main` got 217 `fix` commits and 166 `feat` commits.
- The repository has 0 stars. No outside user has reported anything.
- The guard stopped 1,100 calls in 16 days. 714 were `worker-mark` or
  `unreadable-command`: the guard could not tell who ran the command, or could not read it.
- The guard did not stop a real wipe (issue #1342). It was installed and running.

The guard decides by reading shell text. Shell has no end of forms, so each fix adds a
new form and a new way around it. Record 0043 counted 45 such fixes in two versions. Of
the open issues, 34 are about the hook, and 21 of those are bugs or security.

The owner chose each point below on 2026-11-11.

## Decision

1. **One product.** The public yokoten does one thing: it stops an AI coding agent from
   making the mistake you can't undo.
2. **The sandbox is the safeguard.** Every agent runs in the sandbox by default, the
   lead's session too. A user who wants an agent outside it says so.
3. **The guard stops reading shell.** It keeps a short list of hard lines. A new shell
   form is never a reason to add guard code.
4. **The commit check stays:** privacy, secrets and layout, before a commit and in CI.
5. **Four runtimes:** Claude Code, Grok, Muse and OpenCode. The other adapters go. A
   vendor can still follow the guard protocol (record [0039](0039-the-guard-protocol.md)).
6. **Windows through WSL only.** Native Windows support goes.
7. **`train` and the conflict map go.** The host's queue merges (record
   [0046](0046-merge-gate-not-queue.md)); yokoten keeps the gate.
8. **The process code leaves the core:** dispatch, the bot, the merge gate and the kanban.
   It moves to a repository of its own and is not deleted.
9. **`doctor` stays.** It may leave the core, and it must work on its own.
10. **Cut in place.** Each pull request removes or moves one part, and the tests stay
    green. The sandbox default lands before the guard code goes.
11. **One accepted plan, one pull request.** The plan is in an issue, and the owner
    accepts it first. An agent writes follow-up work into that issue. It opens a new
    issue only for an incident.

Done when both are true:

- A test replays the wipe of issue #1342 inside the sandbox, with a command and with a
  script. Every file outside the project is still there.
- Three people from outside installed yokoten and said what happened.

The work stops for a review on 2026-12-20, done or not. Points 5 to 8 wait for that
review. Points 2, 3 and the README come first.

## Options not taken

- **Rewrite the whole project on a new structure.** The old code holds the lessons of
  217 fixes, and a rewrite carries the same scope over. The size is the problem.
- **Keep the guard and write a real shell parser.** It would stop more forms, and the
  forms still have no end. A script that deletes files never shows in the command.
- **Keep fixing issue by issue.** This is what made 167 open issues.
- **Sandbox only for workers.** The session a person talks to can wipe a folder too.
- **Keep the whole method in one product.** It cannot be said in ten seconds, and no
  outside user came.

## Consequences

- Easier: one sentence says what yokoten is. Most hook issues close with point 3, with
  no fix. A delete inside a script is stopped the same way as a delete in a command.
- Harder: a sandboxed agent cannot write to another repository or install a global tool
  until the user allows it. Some users will find this slow.
- The sandbox has open bugs of its own: issues #1029, #771 and #1097. They come first.
- `AGENTS.md` still says native Windows runs the CLI and the guard, and names four
  strengths. Each pull request that makes a point true changes that text with it.
- Record 0043's front of `desk`, `kanban` and `tidy` becomes `desk` and `tidy` when the
  kanban moves.
- Check on 2026-12-20: the replay test, the count of outside installs, and the count of
  open issues.
