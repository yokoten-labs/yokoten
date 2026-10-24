Fixed

The guard reads a very long command that is not a commit again, and does not refuse it. The new commit scan (#824) now skips any command with no `commit` word (#926).
