Added

`check` counts the lines of the project's own code, without tests, benches or vendored code. A repo with a `"size": { "maxLines": N }` key in yokoten.json fails over the cap; any other repo gets the count as one note. `check --pr` fails a pull request that raises the cap.
