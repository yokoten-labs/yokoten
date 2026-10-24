Changed

A colour terminal now shows a mark and a word for each state: `✔ done`, `✘ missing`, `● next`, `⚠ note`, `? can't check` (#946). A pipe, a file and an agent keep the word alone, so no old console shows a broken glyph.

Full doctor now says the stage and the next step first. Each stage, `project` and `machine` gets its own block. The done steps of a stage share one line, except in the stage that holds the next step, where each keeps its own line. Steps and findings that share a reason share one line too (#946). `--json` is unchanged.
