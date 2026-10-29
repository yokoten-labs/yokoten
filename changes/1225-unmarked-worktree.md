Security

A worker subagent can no longer commit in a worktree that has no worker mark. The commit check knows a worker only by `YOKOTEN_ROLE` or the mark, so such a commit used to pass as the lead's. The tool guard now stops it and tells the lead to run `yokoten worker mark <worktree>` (#1225).
