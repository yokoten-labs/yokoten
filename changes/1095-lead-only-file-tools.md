Security

A worker can no longer write a lead-only file, such as a workflow or CODEOWNERS, with Write, Edit or NotebookEdit where only the user-level or plugin guard runs. That guard now runs on the file tools too, not only on shell commands; `yokoten install` updates it (#1095).
