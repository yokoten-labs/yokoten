Added

`yokoten upgrade` brings yokoten itself to the newest version in one command. It updates the Claude Code marketplace, then the plugin. A marketplace that fetches over SSH moves to the HTTPS address, so no GitHub SSH key is needed. If the move fails, the old marketplace is put back (#950).

`doctor` and the start of a session note a marketplace that fetches over SSH. The fix they name is `npx yokoten@latest upgrade`, run once (#950).
