Internal

The plugin hooks test now runs the copy in this checkout, even on a machine with an
installed yokoten plugin (#902). The test adds `--account-home <folder>` to the hook
command it writes, and the launcher reads that flag from its own command line. No
environment variable names the account home, so a session's environment cannot move
which plugin copy the hook runs. `HOME` alone still never moves the lookup.
