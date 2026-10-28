Fixed

The CI workflow `yokoten init` adds no longer treats a moved file as docs-only. A pull request that moves a code file into `docs/` used to list only the new path, so it skipped the tests; now both paths count, and it runs in full (#1188).
