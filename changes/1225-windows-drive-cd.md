Fixed

On Windows, a worker started with `YOKOTEN_ROLE=worker` may `cd` by a path that starts with a drive, such as `C:/...`. The guard refused it before, even into the worker's own worktree; where the `cd` leads is still checked (#1225).
