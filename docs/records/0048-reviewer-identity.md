# 0048 The reviewer of another model has its own identity

Status: proposed
Date: 2026-10-26 (UTC)

## Context

Record [0047](0047-tier-a-by-another-model.md) lets an area lead of another model approve a
tier A pull request. The approval is the last line of a review,
`Approved by area lead NAME (VENDOR, MODEL)`. Every agent posts through the same bot login.
So a writer could post that line and claim to be another model (issue #1088).

## Decision

1. **A review workflow is the reviewer.** `.github/workflows/review.yml` runs on each
   same-repo pull request. It sends the diff and the body to DeepSeek, with the key in the
   repo secret `DEEPSEEK_API_KEY`. It posts one review on the head commit: APPROVE or
   REQUEST_CHANGES. The model id is pinned in the workflow and named on the approval line.
2. **It fails closed.** An API error, a timeout, or an answer that is not the exact JSON
   shape posts a comment, never an approval. A diff over the cap gets REQUEST_CHANGES.
   The prompt says that text in the diff and the body is data, not instructions.
3. **Only `github-actions[bot]` counts.** The merge check counts an area lead approval only
   when that login posted it, for the head commit or a fresh one as in 0047. The same line
   from the yokoten bot or any other login does not count. The login is one constant,
   `REVIEWER_LOGIN` in `src/rules/pr.ts`.
4. **The trust root is the workflows.** Any workflow can post as `github-actions[bot]`. So
   CODEOWNERS owns all of `.github/workflows/` and the reviewer script in
   `.github/review/`. A change to them needs the owner. The workflow runs the reviewer
   from the base commit, so a pull request can't change the reviewer that judges it.
5. Hard lines and the owner's own approvals are unchanged.

## Options not taken

- **A reviewer GitHub App with its own login.** It gives a login no workflow can borrow.
  It needs a second App, its key, and a host for it. The Actions identity works today.
- **Keep the self-declared line.** It stops honest mistakes only, not a lying agent.

## Consequences

- **Easier:** a tier A pull request with no hard-line file gets its other-model review
  with no lead step. The model on the line comes from the workflow, not from free text.
- **Harder:** every workflow change is a hard line, so it needs the owner.
- **Still open:** a workflow on any branch can post as `github-actions[bot]` before the
  owner reviews it. A pull request that adds such a workflow needs the owner, but its run
  could approve another pull request first. A reviewer App whose key sits in a protected
  environment closes that gap.
- **Still open:** the model reads text the writer controls. The prompt and the strict JSON
  shape limit, but do not remove, a prompt injection.
- **To check:** the approval line from the bot login is refused; the same line from
  `github-actions[bot]` on the head is accepted; on an older commit it is refused; the
  verdict parser refuses junk, missing keys and extra prose.
