Fixed

A subagent worker keeps its own count of refusals. Before, every subagent shared the lead session's count, so after a few refusals in one worker, another worker was stopped on its first call. The dispatch skill now says to start a subagent worker inside its own worktree (`isolation: "worktree"` in Claude Code) and to put the issue text in its brief (#990).
