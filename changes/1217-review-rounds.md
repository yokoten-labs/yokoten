Changed

A review now ends in three rounds (issue #1217). The `reviewer` agent, the `inspect` skill and the DeepSeek review read only the diff since the last reviewed commit after a clean round (the whole diff after a change request), never list an earlier finding again while a blocking one still blocks, and tag each one Important, Nit or Pre-existing. The first line gives the count, or says "Nothing to fix". From the fourth review, one that asks for changes lists only what blocks and asks the author to reconsider the approach.
