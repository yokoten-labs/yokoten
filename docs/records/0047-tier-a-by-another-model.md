# 0047 Tier A merges after another model approves; hard lines keep the owner

Status: accepted
Date: 2026-10-26 (UTC)

## Context

Record [0026](0026-the-owner-is-the-board.md) lets an area lead approve a tier A pull
request when the path is not a hard line and the change is not looser. The merge check
counted that approval only when the lead came from another vendor than the writer.

Record [0045](0045-review-by-another-model.md) changed the review rule from another
vendor to another model, because v0.1.2 is built with Claude Opus 5.5 and Claude Sonnet
5.5 only. The approval rule was not changed with it. Every lead approval came from the
writer's vendor, so the owner had to approve every tier A pull request. On 2026-10-26 he
approved PR #1079 three times in one hour, once after each new commit.

The owner chose "option A" on 2026-10-26.

## Decision

1. **A lead approval counts when its model is different from every writer's model.**
   The writers are the ones the `Made with` line names, as in record 0045. The lead's
   model is the one on the review's last line,
   `Approved by area lead NAME (VENDOR, MODEL)`. A lead from another vendor still counts.
2. **Another model means another model family, and the check fails closed.** yokoten
   keeps one small table of model families: `opus`, `sonnet`, `haiku`, `grok`, `gpt`, the
   o-series, `gemini`, `deepseek`, `qwen`, `muse`, `llama` and a few more. It finds the
   family in squashed names too, such as `opus5.5` or `claude-opus-5-5`. Two names are
   other models only when both have a known family and the families differ. So:
   - two names of one family are the same model: `Opus 5.6` is refused for `Opus 5.5`;
   - a name with no known family, such as `Claude`, `5.5` or `latest`, counts as the
     writer's own model, and the fix line says to name the model;
   - the vendor is not read: `Grok 4.7` is another model for `claude-opus-5-5`, whoever
     runs it.
   The `check --pr` provenance check (record 0045) uses the same judgement.
3. **Fail closed.** When the `Made with` line names no writer, the merge check refuses
   and says how to fix the line.
4. **Hard lines keep the owner.** A file that `.github/CODEOWNERS` owns, or a looser
   change, still needs the owner's approval, exactly as before. CODEOWNERS does not
   change. It includes `package.json`, so the release pull request needs the owner.
5. **The approval must be fresh,** as before: on the head commit, or followed only by
   base merges that leave the pull request's own diff the same.
6. **Every check is green** before the merge, as record
   [0046](0046-merge-gate-not-queue.md) says.

This replaces the vendor point of record 0026 rule 2 ("never its own vendor's work").
The rest of 0026 stands.

## Options not taken

- **The owner approves every tier A pull request.** That is what happened on PR #1079:
  approvals the owner gives without new judgement, against record 0026's aim of freeing
  him from that work.
- **Make these changes tier B.** Tier says how hard a change is to undo, not who
  approves it. Lowering the tier would hide that risk from reviewers and the labels.

## Consequences

- **Easier:** the owner approves tier A once per release, on the release pull request.
  Other tier A pull requests merge when a lead of another model approves the head and
  every check is green.
- **Unchanged:** hard-line files and looser changes still need the owner.
- **Harder:** two models of one vendor share more blind spots than two vendors. Record
  0045's "Later" still holds: when other vendors' agents come back, prefer one of them.
- **Trust root:** the lead approval is text that a review declares about itself. Any
  login that can post a review can claim any model. In this repo every agent posts
  through the same bot login. So the model check stops honest mistakes, not a lying
  agent. The hard lines, the checks and the owner's release approval are the backstop
  that remains. The real fix is a separate identity for each reviewer, such as its own
  GitHub App or token; issue #1088 tracks it.
- **To check:** a lead of a writer's own model family is refused however the model is
  spelled; a model name with no known family is refused;
  a hard-line file still needs the owner; a stale approval is refused; a `Made with` line
  with no writer is refused.
