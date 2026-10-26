# 0045 A reviewer of another model is enough

Status: accepted
Date: 2026-10-26 (UTC)

## Context

Record [0021](0021-ai-checks-ai.md) says one agent writes and an agent from another
vendor reviews. `check --pr` reads that from the Made-with line: a reviewer from the
writer's vendor is a `pr-provenance` finding.

On 2026-10-26 the owner chose to build v0.1.2 with only two models, Claude Opus 5.5 and
Claude Sonnet 5.5, each reviewing the other's work. Both come from one vendor, so the
check failed PR #1061, #1062 and #1063, which were reviewed as he asked (issue #1064).
His reason: the two "are not the same model". They are trained and sized differently,
so one finds what the other misses.

## Decision

1. **The reviewer must be another model, not another vendor.** `check --pr` passes when
   at least one reviewer on the Made-with line is a different model from the writer. The
   model is the name in parentheses, such as `claude-opus-5-5` and `claude-sonnet-5-5`.
2. **More reviewers of the writer's own model may be listed.** For example, a fresh Opus
   session that also reviews security work. They do not fail the check while one other
   model reviews too.
3. **Only the writer's own model fails.** When every reviewer is the writer's model,
   `pr-provenance` is a finding.
4. **Another vendor still passes.** A reviewer from another vendor is always another
   model.

This record replaces the vendor point of record 0021 (rule 1, "an agent from another
vendor reviews"). The rest of 0021 stands: three hands on every change, security work
gets the strongest reviewer, every role is on the record.

## Options not taken

- **Keep the vendor rule and mark these pull requests by hand.** A manual step on every
  pull request of the release, against the owner's choice of team.
- **Drop the reviewer check.** A writer could then review its own work unseen.

## Later

Cross-vendor review stays the stronger option. Models of one vendor share more of their
training and blind spots. When other vendors' agents come back to the team, a reviewer
from another vendor is preferred again, and 0021 rule 2 (reviews cross vendors when three
or more are in use) still applies.
