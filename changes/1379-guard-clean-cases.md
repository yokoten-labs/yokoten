Fixed

The guard no longer refuses two safe cleanups (#1379, #1380). `git reset --hard <ref>` passes when it is the whole command, with any `-C` folder written plainly, and loses nothing, read from the top of the repo: no uncommitted change or untracked file, no ignored file in the way, and every dropped commit on another branch, tag or remote branch. Its refusal now names `git switch -C <branch> <ref>` and `git branch -f <branch> <ref>`. `rm` or `unlink` of one plain `*.md` or `*.txt` file right under `.git`, such as a PR body, passes; the rest of `.git` stays refused.
