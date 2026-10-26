Changed

A bare `yokoten train` now only shows the plan: the order, which pull request is next, and the command that merges them. It merges only the pull requests you name (#1042). A bare `yokoten ci-health` now only prints its report; `--write` updates the pinned "CI health" issue, and the kit workflow passes it (#1046).
