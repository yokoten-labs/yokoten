Added

`yokoten doctor --all --json` now gives every step its `how` (how yokoten judges it) and `why`, the done steps too, so a tool that shows the report can say how each step was judged. The JSON of `doctor --all --json` and `check --json` is now pinned by a test: keys may be added, never renamed or removed (#1202, #1203).
