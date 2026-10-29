Security

A worker subagent can no longer work in a checkout that has no worker mark. The commit check knows a worker only by `YOKOTEN_ROLE` or the mark, so its commits there, made by any route, used to pass as the lead's. The tool guard now stops every shell command and edit such a worker makes in an unmarked checkout. In a worktree it tells the lead to run `yokoten worker mark <worktree>`; in the lead's own checkout it asks for a worktree of its own (#1225).
