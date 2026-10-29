Security

The guard now asks the owner before the lead changes a guard, hook or sandbox settings
file of any agent, such as `.claude/settings.json`, `.codex/`, `yokoten.json` or
`~/.claude/settings.json`. It also asks before a Claude Code shell call with
`dangerouslyDisableSandbox`. A worker is refused both. Where no one can answer, the
question becomes a refusal that says the owner's yes is needed: in a cloud session
(`CLAUDE_CODE_REMOTE` set), and in an agent whose hook can't ask, such as Codex. This
holds for the low-disk heavy-job question too (#1212, #1215).
