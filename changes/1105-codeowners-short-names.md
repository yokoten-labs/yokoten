Security

A `CODEOWNERS` file at the root or in `docs/` is now lead-only by default, as `.github/CODEOWNERS` was, so a worker can't change who must approve; the CODEOWNERS that `init` writes names both. A project's own `leadOnly` list stays as it is. A worker's shell write by a Windows short folder name, such as `GITHUB~1/workflows/x.yml`, is read by its long name before the guard compares it (#1105).
