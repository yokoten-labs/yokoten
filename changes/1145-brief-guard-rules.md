Changed

The `dispatch` skill and the guide now tell the lead how a worker runs commands under the guard: `cd <worktree> && cmd && cmd`, no pipe after the `cd`, no `git -C`, and no `VAR=value` prefix except the few allowed names, so a brief is one a worker can run (#1145).
