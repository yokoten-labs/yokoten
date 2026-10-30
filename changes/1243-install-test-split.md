Internal

The install tests, one file that took 241 s of the Windows job's 240 s cap, are six files by area in `test/setup/install/`, with the same 73 tests. The Windows times check now fails for any test file over 75% of the cap and names it, so a file is split before it times out at random (#1243).
