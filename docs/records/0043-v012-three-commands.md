# 0043 v0.1.2: three commands: desk, kanban, tidy

Status: accepted
Date: 2026-10-26 (UTC)

## Context

v0.1.1 shipped on 2026-10-25. The next day the owner ran every command by hand, as a
new user would. In about an hour that walk-through found some 30 problems, filed as
issues #1037 to #1046. Three of them are safety problems:

- a bare `yokoten train` merges every open pull request in the conflict map (issue #1042);
- a bare `yokoten ci-health` writes to a GitHub issue (issue #1046);
- `yokoten board` prints its access token on the terminal (issue #1045).

yokoten has 32 commands. Most of them were built for our own agent pipeline and then
shipped as product. The owner restated who the product is for: **a new coder who uses
AI, or a group of AIs, should meet as little friction as possible**. This covers someone
who already has an AI tool, and someone yokoten helps get one.

The owner asked that every part of the product start from a pain we really had. The
evidence:

- `failure-modes.md`: 26 process failures;
- the guard's stop log: 104 stops in two days, 22 of them the same `--body-file` shape;
- the fix commits: 45 guard fixes across v0.1.0 and v0.1.1, most of them new ways
  around the guard;
- the walk-through issues;
- a clean-up on 2026-10-26 (below).

The pains that came up most often:

1. **An AI says "done" and it isn't.** Tests passed only on Linux. A Windows check that
   never reached Windows reported success. A package check was not run before a push.
2. **An AI is stuck and nobody notices.** A quota ran out and 6 rounds did nothing. An
   empty review desk counted as "in flight" for 180 minutes.
3. **Several AIs change the same files.** We had 28 collisions and redo rounds. An
   approval during a merge pass did not wake the merge loop.
4. **An agent hits the same refusal again and again.**
5. **Commands act without being asked.** These are the three safety issues above.
6. **Old work piles up and nobody dares remove it.** The clean-up on 2026-10-26 found:
   - on the machine: 877 desk clones (about 13 GB), 64 old worktrees, 256 local
     branches, and 21 stale lock and backup files;
   - on GitHub: 33 open pull requests, most of them conflicted, and 22 branches with no
     pull request.

   Nobody could tell which of them still held work. A desk never removed itself
   (issue #708).

## Decision

1. **A new coder sees three commands.** `help` lists only these, plus one line:
   `--help · --version · help --all`. Besides `yokoten` itself:

   | Command | What it does | Commands folded in |
   |---|---|---|
   | `yokoten` | sets up what is missing, then one screen: where you are, what waits on you, the next step | install, init, doctor, trust, update |
   | `desk` | give one task to one AI, in its own fenced desk | worker, msg |
   | `kanban` | a live, read-only web view of every AI session, its proof and its CI | board (old name) |
   | `tidy` | find old work, keep a copy, and move it out of the way | — |

   The owner chose these three, and decided that merging is not worth a command. A
   person approves and merges a pull request on GitHub, where they already do. yokoten
   only shows what waits on them.

2. **Hiding is not deleting.** The other commands stay in the code and keep working.
   They are left out of `help` and are listed by `help --all`.
   - **Folded commands**: when someone runs one, it says which command it moved to.
   - **Hidden commands**: hook, redact, marks, mcp, bot, changelog, learn, borrowed,
     adopt, ci-health, check, test, explain, stops, uninstall, upgrade, and the merge
     group (train, pr, conflicts, provenance, anchor). Agents, the commit check and CI
     still call them.
   - **Shown only when needed**:
     - `uninstall` is on the Undo line after setup;
     - `upgrade` is on the Next line when a newer version exists.
   - **`help` and `version`** are also `--help` and `--version`.
   - **One new command**, `tidy`. `kanban` is `board` under a new name.

3. **A bare command only reads.** A command that changes something must be given its
   arguments:
   - `train` with no numbers shows the plan and merges nothing;
   - `ci-health` with no flag writes nothing;
   - `tidy` with no flag lists what is old and changes nothing;
   - a command that reads stdin (`hook`, `redact`) prints its purpose and exits when
     stdin is a terminal.

4. **Proof and the reason for a stop come to the person; they are not commands.**
   - The commit check and CI produce the evidence. The kanban shows it on each session:
     each platform's checks pass or fail, and a session with no evidence is marked
     "not proven".
   - A refusal carries its reason and the fix. When the same rule stops an agent a second
     time, the refusal gives the right shape of the command.

5. **The kanban is the first web view in v0.1.x.** The owner allowed it: read-only. It is
   laid out like the Cloud v5 sessions page:
   - left: sessions grouped by state: working, stuck (for how long), waiting on you, done;
   - middle: the selected session's live output;
   - right: its evidence, quota and cost.

   It never prints its access token on the terminal.

   **The name is `kanban`** (the owner, 2026-10-26): the Toyota word for the signboard
   that shows the state of work, from the same production system as the word yokoten.
   `board` stays as a hidden old name that still works.

   **The kanban shows pull requests and GitHub Actions too.** The work splits by what
   GitHub holds:
   - `desk` takes issues;
   - the person merges pull requests on GitHub; the kanban shows which ones wait on
     them, and why a pull request is not ready;
   - the kanban watches Actions.

   CI runs by itself, so the person only needs to know its state and that someone acts
   on a failure. The kanban shows, read-only:
   - a failure on main, first, because it blocks every pull request;
   - each pull request's CI, which is part of its evidence;
   - a run queued for more than 15 minutes, or much slower than usual;
   - a test that passes and fails by turns.

   This is the job of the hidden `ci-health` and of our Actions check. It moves to the
   kanban and writes nothing to GitHub. A failure goes on from there:
   - **main fails, or a test is flaky:** yokoten opens an issue, and `desk` gives it to
     an AI;
   - **a pull request's CI fails:** the kanban marks it not ready, and its desk gets the
     failure;
   - **a run is stuck:** the bot reruns it once (the owner allowed reruns on
     2026-10-22) and the kanban notes it. A second failure opens an issue.

   The release workflow is the one exception. Only the owner approves it, on GitHub, and
   no command touches it.

6. **`desk` gives one task to one AI, with no setup by hand.** Today a person makes a
   clone, writes a brief and types the agent's own start command. `yokoten desk 1029`
   is enough:
   - yokoten makes the clone, writes the brief from the issue and picks an agent;
   - it opens the sandbox, runs the commit check when the agent is done, and shows the
     result on the kanban;
   - when the pull request merges or the issue closes, the desk moves itself out of the
     way, as `tidy` does (issue #708);
   - with no issue number, `desk` lists which AI works on what, and changes nothing.

   It folds in `worker` and `msg`. Our own dispatch scripts (`deepseek-worker.sh`,
   `dispatch-queue.sh`) already run this flow, so they are the model. OpenCode joins the
   agents a desk can start. The desk's own help screen gets the one screen shape of item 8.

7. **`tidy` finds old work, keeps a copy, and moves it out of the way.** It is the
   backstop for what desks leave behind.
   - `yokoten tidy` lists what is old, why, and what it would do. It changes nothing.
   - `yokoten tidy --local` first keeps a copy of anything not on GitHub: unpushed
     commits as a git bundle, uncommitted changes as a patch, worker reports as files.
     Then it moves the old folders, worktrees and branches into a trash folder. It
     deletes nothing.
   - `yokoten tidy --empty` deletes trash older than 7 days.
   - Old pull requests, issues and branches on GitHub are listed with their links. In
     v0.1.2 `tidy` does not close or delete them.
   - It never touches a desk whose agent still runs, or a user's config file. If the
     copy fails, nothing moves.
   - When old work piles up, the `yokoten` screen says so on its Next line.

8. **Every screen keeps one shape.**
   - A title line that says what is true now, at most 10 rows, then the `Next` line and
     the `More` line.
   - No word a beginner can't read (worktree, tier, hooksPath); these go under `--all`
     or into plain words.
   - A command to copy stays whole on its own line.
   - Every line fits 80 columns. The `help` screen of 0.1.1 is the model.

   From magpie's CLI (yetone/magpie, MIT), which the lead used on 2026-10-26:
   - **Every switch says its state and turns off.** For each thing yokoten does by itself
     (a rerun, an issue it opens, the stop log):
     - `<switch> on|off` changes it;
     - `<switch>` alone says whether it is on;
     - an environment variable turns it off for one run.
   - **A screen explains its own signs.** A last small line says what a symbol means, and
     that `--json` is for scripts.
   - **A secret shows only its ends**, such as `sk-8…2af8`. The person can tell which key
     it is, and the key does not leak. It is never shown whole.
   - **A plan or a fallback fits one line with an arrow**, such as
     `1207 → 1209 → 1211` for pull requests that wait on each other.
   - **An error says what failed and the ways out, in one sentence.**
   - **Only what is installed is listed.** Setup and the agent list show only the AI tools
     on this machine.
   - **`--help` anywhere only prints help** and does nothing else. A test holds it for
     every command.

9. **Order of work.**
   1. The three safety issues (#1042, #1046, #1045).
   2. Hide and fold the commands.
   3. `desk`, `kanban` and `tidy`.
   4. The first-screen issues (#1037 to #1040, #1043, #1044).
   5. The README (issue #1035) in all four languages.

10. **A walk-through gates the release.** Before the tag, a new user goes through yokoten
    on Windows, macOS and Linux. That user is the owner, or a weak model playing a new
    coder. The release waits until the problems found are fixed. Time pressure does not
    skip this.

11. **Undo of an AI's change moves to v0.1.3.** A new coder needs "take back what the AI
    just did". It gets its own record when it is built. It will use one word for "back to
    before", the same after every command, as magpie's `default` does.

12. **Getting an AI is not built.** For a new coder with no AI, yokoten points to an
    existing model gateway (magpie, MIT) that the person installs and controls. yokoten
    does not bundle it or edit any agent's config for it.

13. **Every new feature cites its pain**: a `failure-modes.md` row or an issue.

## Options not taken

- **Six new commands** (`run`, `watch`, `prove`, `land`, `why`, `undo`). Each name was
  clearer on its own. But six new commands mean new docs, guides, tests and skills in four
  languages, the area where we break things most. The existing names carry the same jobs.
- **A `merge` command for the merge queue.** It was in the first version of this record.
  The owner decided it is not worth a command: GitHub already has the approve and merge
  buttons, and its own merge queue where the repository allows one. Our own queue was
  where `train` merged without being asked. The code stays as the hidden `train`.
- **Delete the commands nobody new uses.** The owner chose to hide them. Agents, CI and
  our own pipeline still use them, and deleting code is hard to take back.
- **Keep `check` and `explain` visible.** Proof that a person has to ask for is proof a
  new coder never sees. The kanban and the refusal already bring it to them.
- **A `tidy` that deletes.** The clean-up on 2026-10-26 found unpushed commits in 232
  desk clones. A delete would have lost them. Moving to trash after a copy can be undone.
- **Polish all 32 screens one by one.** It costs the most and leaves the structure as it
  is.
- **Build the model gateway into yokoten.** It would be a large project in another
  language. It also edits agent configs and reads subscription sign-ins, which clashes
  with never overwriting user config.

## Consequences

- **Easier:** a narrow scope makes the work light (the owner: "缩小范围我们可以轻松").
  - the first screen and `help` fit a beginner;
  - the three commands that acted on their own become safe;
  - old work no longer piles up out of sight;
  - the work has an order.
- **Harder:**
  - every hidden command still needs its tests;
  - folded commands need a "moved to" line, with a test;
  - docs must stop teaching the hidden names;
  - `tidy` must work the same on Windows, macOS and Linux, long paths included.
- **To check:**
  - `help` lists exactly the three commands;
  - each folded command names its new home;
  - no bare command writes, merges or posts (a test per command);
  - `tidy --local` moves nothing when the copy fails, and a test restores a branch from
    its bundle;
  - the kanban prints no token;
  - the release walk-through finds zero problems before the tag.
