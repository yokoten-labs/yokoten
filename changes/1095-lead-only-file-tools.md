Security

A worker can no longer write a lead-only file, such as a workflow or CODEOWNERS, with Write, Edit or NotebookEdit where only the user-level or plugin guard runs. That guard now runs on the file tools too, not only on shell commands; `yokoten install` updates it. A shell write into a repo with no yokoten.json now follows the default lead-only list too, as an edit already did. If yokoten's own guard is broken, file tools are refused like commands until `yokoten doctor` is run (#1095).
