Fixed

main no longer goes red when a runner is slow or late (#1114). A slow Windows test file gets twice its last time before it is stopped, and a file that timed out no longer says its waived tests pass. A push to main runs no macOS jobs: the pull request ran them, and the daily run keeps all three shards. A pull request runs macOS in two shards, about four minutes instead of seven to ten, and its time budget only warns there; it still fails on Linux and on the daily run.
