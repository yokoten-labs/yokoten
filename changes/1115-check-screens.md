Changed

`check`, `ci-health`, `provenance`, `marks`, `borrowed`, `pr sync`, `redact` and `test` each print one screen that fits 80 columns: notes fold into one row, `ci-health` shows its report as rows and tables, and every failure ends with one `Next:` line (#1115).
`yokoten test` runs only the test files git lists, so a build folder such as `dist/` is never tested, and a passing run takes a few lines (#1044).
