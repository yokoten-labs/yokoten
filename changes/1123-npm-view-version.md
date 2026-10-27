Fixed

The guard no longer reads `npm view <package> version` (or `info`, `show`) as a release: `version` counts only when it is npm's subcommand, so `npm version patch` is still refused (#1123, #1034).
