Fixed

A subagent worker keeps its own count of refusals. Before, every subagent shared the count of the lead's session. After a few refusals in one worker, another worker was stopped on its first call. The dispatch skill now says to start a subagent worker inside its own worktree, with `isolation: "worktree"` in Claude Code. Put the issue text in its brief (#990).
