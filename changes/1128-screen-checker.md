Internal

The screen checker now catches any absolute path of the machine (`/bin/sh`, `/Library/...`, a UNC path, `C:\` and `C:/`), counts only a backticked command as a next step or a fix (not a file name or a flag), ends a run of prose at a `- ` list item, and needs a waiver's reason to name the rule the screen breaks; a `Next:` line that is a sentence ends with a full stop, and the reporter's GitHub Actions branch has a test (#1128).
