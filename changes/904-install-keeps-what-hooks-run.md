Fixed

With the plugin on, `yokoten install` takes the Claude Code hooks out before it removes the runtime, and keeps the runtime while a hook still runs it: a settings file it cannot read, or a hook of your own that calls yokoten. A link of yours in `~/.agents/skills` under a skill's name stays (#904).
