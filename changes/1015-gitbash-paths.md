Security

On Windows, the guard now reads Git Bash paths as Windows does. `/c/Users/...` (or `/C/...`) is `C:\Users\...`, and `/tmp/...` is your temp folder. Before, a worker could write a lead-only file such as `AGENTS.md` or a workflow by its `/c/...` path. It could also move or remove its own desk, so the desk lost its worker mark (#1015).

- A worker's write to a lead-only file by its Git Bash path (`echo >`, `cp`, `sed -i`, `rm`, `git -C`, `cd /c/... &&`) is refused, as the `C:\...` form already was.
- A worker's `mv` or `rm -rf` of its desk, or of a folder that holds it, by its Git Bash path is refused.
- A path Git Bash keeps for itself (`/usr/...`, `/etc/...`), or a relative path that climbs past the drive root, is refused as unsure. `/dev/null` still works.
- The same reading applies to the config-folder, hooks-path, commit-scan, lose-work and post-body checks.
