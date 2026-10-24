Added

`yokoten upgrade` brings yokoten itself to the newest version in one command. It updates the Claude Code marketplace, then the plugin, with git told to fetch github.com over HTTPS for those calls. No GitHub SSH key is needed, and it adds or removes nothing (#950).

`doctor` and the start of a session note when Claude Code fetches the yokoten marketplace over SSH. The fix they name is `npx yokoten@latest upgrade` (#950).
