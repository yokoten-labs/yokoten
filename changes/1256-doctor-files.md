Added

`yokoten doctor --files` judges the project only from the files in the checkout. It reads no code host, starts no `gh`, uses no network and says nothing about the machine, so it gives the same answer on every machine. A step judged from the code host or the machine is left out, not shown as "can't check". With `--json`, the report has the same keys as `doctor --all --json`. Each step in `--json` now also says what it is judged from (`"source": "files"`, `"host"` or `"machine"`) and gives its plain task title (`"title"`) (#1256).
