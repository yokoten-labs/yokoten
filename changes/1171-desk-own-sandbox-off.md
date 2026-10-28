Fixed

A desk now starts each agent with its own sandbox off, for that run only. The agent's own
sandbox can't start inside a desk, so shell commands failed when the project turned it on.
The desk's fence is the sandbox there. Claude Code gets `--settings`, Codex gets
`-c sandbox_mode="danger-full-access"`, Grok gets `--sandbox off`, and Muse Code gets
`--disable-sandbox`. No settings file changes. A command that asks for the agent's own
sandbox is refused, and the start screen says why the sandbox is off (#1171).
