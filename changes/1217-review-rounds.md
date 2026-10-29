Changed

A review now ends in three rounds (issue #1217). The `reviewer` agent, the `inspect` skill and the DeepSeek review read only the diff since the last reviewed commit, never repeat an earlier finding, and tag each one Important, Nit or Pre-existing. The first line gives the count, or says "Nothing to fix". The fourth review asks the author to reconsider the approach instead of listing new findings.
