Security

On Windows, the guard now reads Git Bash paths as Windows does. `/c/Users/...` (or `/C/...`) is `C:\Users\...`, and `/tmp/...` is your temp folder. Before, a worker could write a lead-only file such as `AGENTS.md` or a workflow by its `/c/...` path. It could also move or remove its own desk, so the desk lost its worker mark (#1015).

- A worker's write to a lead-only file by its Git Bash path is refused, as the `C:\...` form already was. This covers `echo >`, `cp`, `sed -i`, `rm`, `git -C` and `cd /c/... &&`.
- A worker's `mv` or `rm -rf` of its desk, or of a folder that holds it, by its Git Bash path is refused.
- A path Git Bash keeps for itself (`/usr/...`, `/etc/...`), or a relative path that climbs past the drive root, is refused as unsure. `/dev/null` still works.
- The same reading applies to the config-folder, lose-work and post-body checks.
- The secret scan of a commit now runs when the repo is named as `git -C /c/...` or `cd /c/... &&`. A commit in a folder that is not there, or with `GIT_DIR=` or `GIT_WORK_TREE=` before git, is refused as unknown.
- A tag push from a repo named by a Git Bash path (`-C`, `--git-dir`, `GIT_DIR=`, `cd`) is refused. So is a push with `push.followTags` set. The same holds for a push that deletes the default branch.
- A push from a repo that git can't open is refused, because its tags can't be read.
- A write to `.git/hooks` or `.git/config` by a Git Bash path is refused.
- `cmd /c` (and `cmd //c`, `cmd.exe`) is read as a program that runs commands. A worker's `cmd /c del` of its git folder is refused, and `cmd /c rd /s` of home is refused as a wipe.
