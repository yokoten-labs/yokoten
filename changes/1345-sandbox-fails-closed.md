Security

`init` now writes a Claude Code sandbox that fails closed: `sandbox.failIfUnavailable` is `true` and `sandbox.allowUnsandboxedCommands` is `false`, next to `sandbox.enabled`. Claude Code stops when the sandbox can't start, and no command runs again outside it. A value you set stays, and `doctor` names what differs. On Linux the sandbox needs `bubblewrap` and `socat`; `doctor --all` says when one is missing. A session that starts in your home folder, or in a folder that holds two or more git repositories, now hears one line: a sandbox there protects none of those projects (#1345).
