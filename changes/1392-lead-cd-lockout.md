Fixed

The guard refuses a lead's command line that ends in a marked worktree, which moved the lead's session there and made it a worker's. A worker refusal from the mark now names the one unmark command the owner runs, from a shell or from Windows PowerShell on WSL. Each worker rule now reads the program after `wsl.exe`, so a worker can't unmark, push or post through it (#1392).
