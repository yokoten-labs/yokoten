Fixed

`gh api -X PUT repos/o/r/actions/workflows/<id>/disable`, in the `repositories/<id>` and shell-variable forms too, is refused with `workflow-disable`, like `gh workflow disable` (#956).
