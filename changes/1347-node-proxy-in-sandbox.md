Fixed

`init` sets `NODE_USE_ENV_PROXY=1` for agent sessions in `.claude/settings.json`. Without it, a Node program that uses `fetch` could not reach the network inside the Claude Code sandbox. A value you set stays (#1347).
