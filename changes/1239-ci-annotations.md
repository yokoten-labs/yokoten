Fixed

In a CI run, each line of the `check` step now starts with its file and line, as the terminal does, and shows at the right level: a problem as an error, a warning as a warning, and a plain note as a notice. The count on the check screen ("6 notes, 1 warning among them") now matches the annotations. A test value such as `PRIVATE-MESSAGE-TEXT-MUST-NOT-LEAVE` is no longer reported as a secret, and a value that is reported says what matched in plain words, with `[not sure]` in place of `[unknown]` (#1239).
