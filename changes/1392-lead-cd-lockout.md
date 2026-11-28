Fixed

The guard refuses a lead's plain `cd` into a marked worktree, which moved the lead's session there and made it a worker's. A worker refusal from the mark now names the one unmark command the owner runs, from a shell or from Windows PowerShell on WSL (#1392).
