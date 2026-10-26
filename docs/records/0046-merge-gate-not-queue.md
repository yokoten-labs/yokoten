# 0046 yokoten gates merges; the host's queue does the merging

Status: accepted
Date: 2026-10-26 (UTC)

## Context

v0.1.1 had `train`, a merge queue written by hand: it ordered pull requests and
merged them one by one. On 2026-10-26 the repository turned on GitHub's merge queue.
GitHub then tested and merged several pull requests together. `train` did the same
job, less well.

A merge queue only checks that the merged result stays green. An AI team needs more
before that:

- whether another model reviewed the work (record 0045);
- whether the owner approved a tier A change;
- what order helps the next work.

On 2026-10-26 the v0.1.2 merges showed this order mattered. The safety fixes went in
first, so the folder move did not conflict with them.

Not every developer has a merge queue. GitHub offers it only for some repository
owners and plans; check GitHub's docs for the current list. Gitea and Forgejo have
none. A beginner often has a personal repository.

The owner said on 2026-10-26: build only the gap that others leave ("借势"), and bring
this to every developer.

## Decision

1. **yokoten does not build a merge queue.** Where the host has one, yokoten hands
   the pull request to it. Where it has none, yokoten merges one pull request at a
   time, after the checks pass on the newest main.
2. **yokoten builds the gate in front of the queue:**
   - **Ready:** the checks are green, another model reviewed it, and tier A has the
     owner's approval.
   - **Order:** first what helps the next work, last what moves files.
   - **Hand-off:** the pull request goes to the host.
3. **No new command and no new layer.**
   - The readiness rules live in `src/rules/`.
   - The hand-off lives in the host adapter (`src/host/github.ts`).
   - `kanban` shows which pull requests wait on the person, and why (`KanbanPull`).
   - `desk <n> --pr` hands in an agent's work.
4. `train` stays folded and gets no new features.
5. The work is issue #1060, in v0.1.3.

## Options not taken

- **Keep and grow `train`.** It copies what the host does, and it falls behind the
  host's queue.
- **A `merge` command.** Record 0043 keeps three commands. The owner said merging
  is not worth a command.
- **Require a host with a merge queue.** That leaves out personal repositories and
  Gitea, which are where many beginners start.

## Consequences

- **Easier:** less code to keep. Where the host has a queue, it does the merging.
- **Easier:** one gate for every developer, with or without a queue.
- **Harder:** the hand-off differs per host, so each host adapter needs it.
- **To check:**
  - a pull request with no review by another model is never handed off;
  - tier A is never handed off without the owner's approval;
  - without a queue, nothing merges unless the checks passed on the newest main.
