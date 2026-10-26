Security

The user-level guards of Grok CLI, Muse Code and Copilot CLI now run on the same tools as their project hooks, the edit tools too, so a worker can't write a lead-only file with its edit tool in a session with no project hook. `yokoten doctor` says when the installed Claude Code guard is older and skips a file tool, and `yokoten install` fixes it (#1100).
