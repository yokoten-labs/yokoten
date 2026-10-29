---
name: inspect
description: Review a pull request or a diff before it merges, with the reviewer and verifier agents. Use before asking the owner to approve, or when the user asks for a review.
---
<!-- managed by yokoten; `yokoten install` updates this file, and keeps your edits -->

> **Skills-only copy?** `npx skills add` copies the skills alone: no guard and no session
> doctor. When `yokoten` is not on PATH and the Claude Code plugin is not enabled, say one
> line. Then carry on: "This copy has the skills only; run `npx yokoten install` to add the guard."

# Inspect a change before it merges

Inspection is a station on the line, not an opinion. It has a fixed order, a fixed
grading, and it looks at one exact commit.

## 1. Pin the commit

Write down the SHA under review: `git rev-parse HEAD` on the branch. The review is for
that commit only. If the branch gets a new commit, the review starts again for the new
SHA. Say the SHA in the review comment.

## 2. Three passes, in order

Give the diff to the `reviewer` agent (it reads only) for:

1. **Bugs**: logic errors, edge cases, code that does not do what the PR says.
2. **Security**: tokens and secrets, auth, every new outbound request and where it
   goes, install scripts, the source of every new or bumped dependency.
3. **Compliance**: does the diff do what its issue and record say, no more and no less?
   Does it break a core rule in `AGENTS.md`? Does it break the project's architecture rules
   (an `Architecture` section in `AGENTS.md`, if there is one)? An architecture break is
   high: it blocks, so no person has to ask whether the change fits.

Each reviewer that read the diff goes on the pull request's last line, after the worker
and before the lead, in one part with at most two reviewers:
`🤖 Made with worker <X> (<model>), reviewed by <Y> (<model>) and <Z> (<model>), lead Claude Code (<model>)`.
One reviewer is `reviewed by <Y> (<model>)`. Add them when you write or edit the line.

Give it to the `verifier` agent (it runs, never fixes) to run the tests and the "done
when" command from the issue, and paste the output.

## 3. Grade

- **High**: true now on a path a user takes, or cannot be taken back (a leaked secret,
  lost data, a lock-out).
- **Medium**: breaks behaviour someone depends on, or goes against a recorded decision.
- **Low**: everything else. List at most five.

High and medium findings each get an issue. Only a high finding blocks the merge,
and only when this PR causes it or makes it worse; medium and low pass, since no code
is perfect. A defect that was already there is
**pre-existing**: it gets its issue, and does not block, unless it makes this PR's
own promise false.

## 4. How a finding is written

The `reviewer` agent's Output section is the one layout: a one-page report, the
verdict and the SHA first, one item of at most 25 words per finding that names the fix,
the evidence folded, and what was not checked last. A reviewer decides; it never asks.

Tag each finding **Important** (high or medium), **Nit** (low) or **Pre-existing**. The
first line states the count, for example "2 Important, 1 Nit", and says "Nothing to fix"
when there is none.

## 5. Rounds

A review ends in three rounds. After a clean round, give the `reviewer` only the diff since
the last reviewed commit; after changes were asked for, the whole diff again. Give it the
findings already posted: it does not list them again, but a blocking one it finds again is
still open and still blocks. It names the bug class so every instance is fixed. From
the fourth review, one that asks for changes lists only the blocking findings and asks
the author to reconsider the approach; one that approves lists everything.

## 6. Hand over

Post the findings on the pull request. Only the owner approves. Never approve with
the owner's account, and never merge a SHA other than the one reviewed.

## How you name an issue

Write `issue #N` or `PR #N`. A bare `#N` is not a name.
