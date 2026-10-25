Fixed

`install`, `uninstall`, `doctor` and the session cleanup use the folder Claude Code reads when `CLAUDE_CONFIG_DIR` is set, and Codex's hooks follow `CODEX_HOME`, as its trust already did. Before, the hooks went to `~/.claude` or `~/.codex`, where the tool never read them, so the guard was off. A relative `XDG_CONFIG_HOME` or `XDG_CACHE_HOME` is now ignored, as the XDG spec says. `init` keeps a `TZ` you set in `.claude/settings.json`, and says how to set UTC (#988).
