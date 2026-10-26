# 0043 v0.1.2: four commands: the agent works, the human decides, the board watches

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
- the walk-through issues.

The pains that came up most often:

1. **An AI says "done" and it isn't.** Tests passed only on Linux. A Windows check that
   never reached Windows reported success. A package check was not run before a push.
2. **An AI is stuck and nobody notices.** A quota ran out and 6 rounds did nothing. An
   empty review desk counted as "in flight" for 180 minutes.
3. **Several AIs change the same files.** We had 28 collisions and redo rounds. An
   approval during a merge pass did not wake the merge loop.
4. **An agent hits the same refusal again and again.**
5. **Commands act without being asked.** These are the three safety issues above.

## Decision

1. **A new coder sees four commands.** `help` lists only these, plus one line:
   `--help · --version · help --all`. Besides `yokoten` itself, there is one command per
   role, as the owner put it:
   - the agent works: `desk`;
   - the human decides: `merge`, where the person approves what lands;
   - both are watched: `board`.

   | Command | What it does | Commands folded in |
   |---|---|---|
   | `yokoten` | sets up what is missing, then one screen: where you are, what waits on you, the next step | install, init, doctor, trust, update |
   | `board` | a live, read-only web board of every AI session | — |
   | `merge` | the pull request merge queue | train, pr, conflicts, provenance, anchor |
   | `desk` | give one task to one AI, in its own fenced desk | worker, msg |

2. **Hiding is not deleting.** The other 30 commands stay in the code and keep working.
   They are left out of `help` and are listed by `help --all`.
   - **Folded commands** (12): when someone runs one, it says which command it moved to.
   - **Hidden commands** (16): hook, redact, marks, mcp, bot, changelog, learn,
     borrowed, adopt, ci-health, check, test, explain, stops, uninstall, upgrade. Agents,
     the commit check and CI still call them.
   - **Shown only when needed**:
     - `uninstall` is on the Undo line after setup;
     - `upgrade` is on the Next line when a newer version exists.
   - **`help` and `version`** are also `--help` and `--version`.
   - **No new command** is added in v0.1.2: `merge` is `train` under a clearer name.

3. **A bare command only reads.** A command that changes something must be given its
   arguments:
   - `merge` (and its old name `train`) with no numbers shows the plan and merges nothing;
   - `ci-health` with no flag writes nothing;
   - a command that reads stdin (`hook`, `redact`) prints its purpose and exits when
     stdin is a terminal.

4. **Proof and the reason for a stop come to the person; they are not commands.**
   - The commit check and CI produce the evidence. The board shows it on each session:
     each platform's checks pass or fail, and a session with no evidence is marked
     "not proven".
   - A refusal carries its reason and the fix. When the same rule stops an agent a second
     time, the refusal gives the right shape of the command.

5. **The board is the first web view in v0.1.x.** The owner allowed it: read-only. It is
   laid out like the Cloud v5 sessions page:
   - left: sessions grouped by state: working, stuck (for how long), waiting on you, done;
   - middle: the selected session's live output;
   - right: its evidence, quota and cost.

   It never prints its access token on the terminal.

6. **`desk` gives one task to one AI, with no setup by hand.** Today a person makes a
   clone, writes a brief and types the agent's own start command. `yokoten desk 1029`
   is enough:
   - yokoten makes the clone, writes the brief from the issue and picks an agent;
   - it opens the sandbox, runs the commit check when the agent is done, and shows the
     result on the board;
   - with no issue number, `desk` lists which AI works on what, and changes nothing.

   It folds in `worker` and `msg`. Our own dispatch scripts (`deepseek-worker.sh`,
   `dispatch-queue.sh`) already run this flow, so they are the model. OpenCode joins the
   agents a desk can start. The desk's own help screen gets the one screen shape of item 8.

7. **`merge` is the merge queue.** The owner chose the name: "train" said nothing about
   merging. `train` stays as a hidden old name that still works.
   - Use GitHub's own merge queue where the repository allows it; ours only where it
     doesn't.
   - A merge needs three things: a review by another vendor's AI, the evidence, and the
     owner's approval for tier A.
   - A conflicted pull request is rebuilt on the latest main, never forced.
   - The queue shows on the board.

8. **Every screen keeps one shape.**
   - A title line that says what is true now, at most 10 rows, then the `Next` line and
     the `More` line.
   - No word a beginner can't read (worktree, tier, hooksPath); these go under `--all`
     or into plain words.
   - A command to copy stays whole on its own line.
   - Every line fits 80 columns. The `help` screen of 0.1.1 is the model.

9. **Order of work.**
   1. The three safety issues (#1042, #1046, #1045).
   2. Hide and fold the commands.
   3. `merge`, `board` and `desk`.
   4. The first-screen issues (#1037 to #1040, #1043, #1044).
   5. The README (issue #1035) in all four languages.

10. **A walk-through gates the release.** Before the tag, a new user goes through yokoten
    on Windows, macOS and Linux. That user is the owner, or a weak model playing a new
    coder. The release waits until the problems found are fixed. Time pressure does not
    skip this.

11. **Undo of an AI's change moves to v0.1.3.** A new coder needs "take back what the AI
    just did". It gets its own record when it is built.

12. **Getting an AI is not built.** For a new coder with no AI, yokoten points to an
    existing model gateway (magpie, MIT) that the person installs and controls. yokoten
    does not bundle it or edit any agent's config for it.

13. **Every new feature cites its pain**: a `failure-modes.md` row or an issue.

## Options not taken

- **Six new commands** (`run`, `watch`, `prove`, `land`, `why`, `undo`). Each name was
  clearer on its own. But six new commands mean new docs, guides, tests and skills in four
  languages, the area where we break things most. The existing names carry the same jobs.
- **Delete the commands nobody new uses.** The owner chose to hide them. Agents, CI and
  our own pipeline still use them, and deleting code is hard to take back.
- **Keep `check` and `explain` visible.** Proof that a person has to ask for is proof a
  new coder never sees. The board and the refusal already bring it to them.
- **Polish all 32 screens one by one.** It costs the most and leaves the structure as it
  is.
- **Build the model gateway into yokoten.** It would be a large project in another
  language. It also edits agent configs and reads subscription sign-ins, which clashes
  with never overwriting user config.

## Consequences

- **Easier:** a narrow scope makes the work light (the owner: "缩小范围我们可以轻松").
  - the first screen and `help` fit a beginner;
  - the three commands that acted on their own become safe;
  - the work has an order.
- **Harder:**
  - every hidden command still needs its tests;
  - folded commands need a "moved to" line, with a test;
  - docs must stop teaching the hidden names.
- **To check:**
  - `help` lists exactly the four commands;
  - each folded command names its new home;
  - no bare command writes, merges or posts (a test per command);
  - the board prints no token;
  - the release walk-through finds zero problems before the tag.
