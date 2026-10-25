Fixed

`yokoten upgrade` now finds Claude Code on native Windows. Before, it only looked for `claude.cmd`, and Claude Code's own installer puts only `claude.exe` on the PATH, so the upgrade stopped with "'claude.cmd' is not recognized". It now looks for `claude.exe` first, then `claude.cmd` (#1002).
