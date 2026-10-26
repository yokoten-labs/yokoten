Changed

A merge queue group now reads its changed files the way a pull request does, so a docs-only change skips the heavy CI jobs in the queue too. `yokoten init` updates a project's unchanged workflow (#1068).
