# 0056 The ruleset: a floor, defaults with a reason, and three asks

Status: accepted
Date: 2026-10-29 (UTC)

## Context

On 2026-10-29 the owner asked to settle the ruleset before more development. The facts,
read that day:

- 132 rules live in code (`src/rules/text/message.ts`). Each has the same standing: none
  says whether a user may turn it off. The config can only add to them (`privacy.allow`,
  `commands.block`) or skip a road step (`notNow`).
- The guard's log held 630 stops since 2026-10-24: 506 refused, 124 unreadable, and
  **none asked the owner**. The guard can answer "ask" (`src/run/protocol.ts`), but only the
  low-disk heavy-job check uses it.
- One lead session's 559 subagent transcripts held 481 guard stops; 283 of them were
  `worker-mark` (110 a `cd` in a pipe or subshell, 39 `git -C`, about 34 variables). The
  command shapes were written only in the dispatch skill, and on 2026-10-29 the lead's own
  brief told a worker to use a refused form, so the worker never reached its worktree.
- Record 0054 set three layers (a floor, shipped defaults, each user's overrides) and said
  the owner holds the keys. This record fills them in. Record 0039 said not to adopt CEL
  until the rules outgrow the config.

The owner agreed to each answer below in the lead's chat, one question at a time.

## Decision

1. **A floor, defaults, and notes.** A rule is in the floor when any of four holds: it
   can't be undone; it harms others; it leaks; or it bypasses the checks themselves (role
   boundaries and unreadable commands included). The floor changes only by a maintainer,
   with a record.
   - A default may be turned off in `yokoten.json`, with a reason, on the user's own
     machine: `"rules": { "pr-made-with": "off: <reason>" }`. No reason, no effect. A floor
     rule written there is ignored, and doctor says so. doctor lists every rule turned off.
     (issue #1151, issue #1153)
   - A note never blocks.
   - Three that were in doubt: `time-zone` is a default (UTC commits are this project's
     taste, and a local time harms no one); `email` and `ip` are floor, with `privacy.allow`
     as the way to allow one value; `unreadable-command` is floor, and its friction is
     fixed by teaching (decision 2), not by letting unread commands run.
2. **A worker learns one command shape, and needs almost none.**
   - The worker starts in its own worktree, so plain commands work (issue #1210). This
     comes first.
   - The shapes live in `worker.md` itself; each refusal shows the command to run instead;
     dispatch puts the shapes into every brief by itself (issue #1211, issue #1146).
   - `git -C` and `env -C` are allowed when the path is the worker's own worktree: one path
     compared, no new shell grammar (issue #1190).
   - Unchanged: no `cd` in a subshell, pipe or background; the variable allow list.
3. **The guard refuses the floor, asks for three, and never asks a worker.**
   - Refuse, for everyone: releases and tags, force pushes, erasing history, wiping
     folders, leaking keys. The owner does these outside the agent.
   - Ask the owner, for the lead: a change to guard, hook, sandbox or fence settings
     (record 0054 decision 2); leaving the sandbox (issue #1163); a heavy job on a low disk.
     (issue #1212)
   - A worker gets "refuse" for the same three: no one is there to answer, so it hands the
     decision to the lead.
   - A vendor whose hook can't ask gets "refuse", saying the owner's yes is needed. Claude
     Code's own permission dialog is the one confirmed: the agent can't answer it.
   - Asks stay rare, or they get clicked through.
4. **No rule language yet.** Decisions 1 to 3 fit `yokoten.json` and code, so record 0039
   stands. The floor stays in code, whatever format the defaults later take. doctor makes
   0039's signal checkable: a note when three projects need the same rule (issue #1213).

## Options not taken

- **Every rule can be turned off.** Simple and fair-sounding, but the floor exists for the
  moment a user, or an agent writing their config, wants it gone.
- **Nothing can be turned off.** Today's state. A rule that is only this project's taste
  then blocks every user, and they leave rather than argue.
- **Let unreadable commands run, with a warning.** It removes the most common friction, but
  the guard would pass what it did not read. Teaching the shape removes the friction too.
- **Loosen the worker rules (pipes after `cd`, any `-C`).** Each one is new shell grammar
  for the guard to get right; starting the worker in its worktree makes most of them
  unneeded.
- **Ask the owner about the floor too.** The owner would approve releases and force pushes
  inside an agent's flow, one click from routine; the floor is done outside the agent.
- **Adopt CEL now.** Nothing decided here needs a condition across two fields.

## Consequences

- Easier: a user can drop a rule that is only our taste, with the reason on record; a
  worker can do its task without learning the guard by hitting it; the owner is asked only
  about the three things that are his call.
- Harder: each of the 132 rules needs a group (floor, default or note), and the group must
  be tested, so a rule can't drift from floor to default unseen. The lead loses the free
  edit of its own settings.
- To check: whether Claude Code's `bypassPermissions` mode still shows a hook's "ask"
  (issue #1212); which other vendors' hooks can ask; the stop counts after decision 2
  ships, against the 283 `worker-mark` stops above.
