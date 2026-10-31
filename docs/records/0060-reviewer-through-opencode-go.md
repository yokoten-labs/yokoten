# 0060 The reviewer calls DeepSeek through OpenCode Go

Status: accepted
Date: 2026-10-31 (UTC)

## Context

Record [0048](0048-reviewer-identity.md) runs the reviewer as a GitHub App. Its job called DeepSeek's own API with `deepseek-flash`. The owner chose to move the call to OpenCode Go. He ruled out Muse and Claude as the model, which left `deepseek-v4.1-flash` and `glm-5.3-flash`.

We compared the two on 2026-10-31 with this reviewer's prompt, through the OpenCode CLI: 3 diffs, 2 runs each, effort `high`. DeepSeek found all 6 seeded defects in both runs; GLM found 6 and 5. DeepSeek gave plain JSON in 6 of 6 answers; GLM in 3 of 6. GLM was faster on the smaller diffs. This is a small sample, and the CLI did not send `response_format`.

## Decision

The reviewer calls `deepseek-v4.1-flash` through `https://opencode.ai/inference/go/openai/v1/chat/completions`, with the key `OPENCODE_API_KEY` in the `reviewer` environment. It sends `reasoning_effort: high`, its own `User-Agent` and a stable `x-opencode-session` for each review.

The App, the login, the approval line and the rule on model families do not change. A pull request a DeepSeek worker wrote still needs another model's approval or the owner's.

## Options not taken

- **`glm-5.3-flash`:** the merge check knows no GLM family and fails closed, so its approval would not count until `src/rules/pr.ts` learns it. It also found less in this comparison.
- **Muse or Claude:** ruled out by the owner.

## Consequences

- `pull_request_target` runs the reviewer as it is on `main`, so the pull request that makes this change is reviewed the old way. The new call first runs on the next pull request.
- An error or a missing key posts a comment, never an approval.
- Not proved: that `reasoning_effort` takes effect, that `response_format` and `max_tokens` are accepted for this model, and how long a large diff takes on this route. OpenCode's docs do not mention CI use. Check these on the first real reviews.
