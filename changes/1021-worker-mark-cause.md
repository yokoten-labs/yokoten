Fixed

When the guard refuses a worker's command because it runs code and names a git folder, the refusal now quotes the word that named it (such as `.git`, `GIT_DIR` or the worker mark), so the agent knows what to change (#1021).
