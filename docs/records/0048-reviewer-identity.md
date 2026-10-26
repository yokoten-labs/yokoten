# 0048 The reviewer of another model has its own identity

Status: proposed
Date: 2026-10-26 (UTC)

## Context

Record [0047](0047-tier-a-by-another-model.md) lets an area lead of another model approve a
tier A pull request. The approval is the last line of a review,
`Approved by area lead NAME (VENDOR, MODEL)`. Every agent posts through the same bot login.
So a writer could post that line and claim to be another model (issue #1088).

## Decision

1. **A GitHub App is the reviewer.** Its name is `yokoten-reviewer`, and its login is
   `yokoten-reviewer[bot]`. The merge check counts an area lead approval only from that
   login, for the head commit or a fresh one as in 0047. The same line from the yokoten bot,
   from `github-actions[bot]` or from any other login does not count. The login is one
   constant, `REVIEWER_LOGIN` in `src/rules/pr.ts`. GitHub logins ignore case, and so does
   the check.
2. **A review workflow runs it.** `.github/workflows/review.yml` runs on
   `pull_request_target` for each same-repo pull request that is not a draft. It sends the
   diff and the body to DeepSeek, and posts one review on the head commit: APPROVE or
   REQUEST_CHANGES. The model id is pinned in the workflow and named on the approval line.
3. **The App's key stays on main.** The job uses the `reviewer` environment, which the
   owner limits to the main branch. The environment holds `REVIEWER_APP_ID`,
   `REVIEWER_APP_KEY` and `DEEPSEEK_API_KEY`. The job mints a short-lived App token and
   posts the review with it. The job's own token only reads.
4. **The pull request is data.** `pull_request_target` runs the workflow and the reviewer
   as they are on main. The job checks out the base commit only. It reads the diff and the
   body through the API, and never checks out or runs the pull request's code. The prompt
   says that text in the diff and the body is not instructions.
5. **It fails closed.** An API error, a timeout, or an answer that is not the exact JSON
   shape posts a comment, never an approval. A diff over the cap gets REQUEST_CHANGES.
6. **The trust root** is the App's key in an environment limited to main, and CODEOWNERS
   on `.github/workflows/` and `.github/review/`. A change to either needs the owner.
   Hard lines and the owner's own approvals are unchanged.

## How this closes the gap 0047 left

Any workflow can post as `github-actions[bot]`, even one on a branch nobody has reviewed.
So that login can't prove who reviewed. The App's token can only be minted with its key.
The key is in an environment that a run on a branch other than main can't use. A workflow
added on a branch, or by a pull request, runs on that branch, so it gets no key. Only the
review workflow as it is on main can post as `yokoten-reviewer[bot]`.

## Options not taken

- **`github-actions[bot]` as the reviewer.** It needs no App, but any workflow on any
  branch can post as it, before the owner reviews that workflow.
- **Keep the self-declared line.** It stops honest mistakes only, not a lying agent.

## Consequences

- **Easier:** a tier A pull request with no hard-line file gets its other-model review
  with no lead step. The model on the line comes from the workflow, not from free text.
- **Harder:** every workflow change is a hard line, so it needs the owner. The owner keeps
  one more App and one more environment.
- **Still open:** the model reads text the writer controls. The prompt and the strict JSON
  shape limit a prompt injection, but do not remove it.
- **Still open:** `deepseek-flash` is a name DeepSeek moves to newer models. The approval
  line names the alias, not one fixed model.
- **To check:** an approval line from the bot login, from `github-actions[bot]`, from a
  person or from a look-alike login is refused; the same line from `yokoten-reviewer[bot]`
  on the head is accepted; on an older commit it is refused; the verdict parser refuses
  junk, missing keys and extra prose; the workflow runs on `pull_request_target` in the
  `reviewer` environment, checks out only the base, and pins the App token action.
