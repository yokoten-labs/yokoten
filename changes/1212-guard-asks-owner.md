Security

The guard now asks the owner before the lead changes a settings file that holds an
agent's hooks, permissions, sandbox or fence, such as `.claude/settings.json`,
`.codex/config.toml`, `yokoten.json` or `~/.claude/settings.json`. Skills, agents and
commands are not asked about. It also asks before a Claude Code shell call that leaves
the sandbox. A worker is refused both. Where no one can answer, the question becomes a
refusal that says the owner's yes is needed: in a Claude Code cloud session, and in an
agent whose hook can't ask, such as Codex. This holds for the low-disk heavy-job question
too (#1212, #1215).
