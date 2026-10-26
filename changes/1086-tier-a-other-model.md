Changed

A tier A pull request with no hard-line file and no looser change now merges when an area lead of another model than every writer approves the head commit. Before, the lead had to come from another vendor. Hard-line files still need the owner, so the release pull request does too (#1086).

The provenance check in `check --pr` is stricter: a reviewer of the writer's own model family, such as Opus 5.6 for Opus 5.5, no longer counts, and a model name with no known family counts as the writer's own (#1086).
