Fixed

In a linked worktree, where workers run, the guard refuses a `find` that deletes from the top of the worktree. Before, it let that `find` delete the `.git` file that links the worktree to its history, so the worktree broke (#994).
