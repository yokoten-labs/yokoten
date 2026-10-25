Fixed

`yokoten upgrade` now finds Claude Code on native Windows. Claude Code's own installer puts only `claude.exe` on the PATH, but yokoten looked only for `claude.cmd`, so the upgrade stopped with "'claude.cmd' is not recognized". It now looks for `claude.exe` first, then `claude.cmd` (#1002).
