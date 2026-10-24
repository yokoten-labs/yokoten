Security

The guard now refuses code bash runs but the guard cannot read. This covers a PS4 or PROMPT_COMMAND substitution, a `((…))` or `let` expression, and an indirect or subscript expansion from a hidden name. It also covers a loop variable set from hidden text. And it covers a glob that a file name could turn into a writing option such as `git log *`. Write the program as a plain name and the value as plain text (#457).

A differential test holds the guard against real bash. A recorded sandbox reports every program bash runs and every file it writes. The test fails when the guard allowed something it did not see. A fixed corpus and seed keep CI reproducible. `YOKOTEN_DIFF_CASES` runs a longer local or nightly set (#457).
