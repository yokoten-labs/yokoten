Fixed

`yokoten bot -- gh pr merge` refusals now say what to do next (#1381). A missing Approve names the GitHub steps: Files changed, Review changes, Approve, Submit review. An owner review that a push dismissed, or that requested changes, is named with its commit and the head to approve again. A repo with no CODEOWNERS file covering the pull request is told to add a line that names the owner. Each of these refusals also says not to merge in the browser, since that commit gets local time, not UTC.
