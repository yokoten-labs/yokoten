Internal

The plugin launcher now reads a test-only `YOKOTEN_TEST_ACCOUNT_HOME` from the hook
environment when no explicit account home is given (#902). The plugin hooks test then
runs the copy in the checkout, even on a machine with an installed yokoten plugin.
Setting the variable in a real session moves which plugin copy the hook runs. Leave it
unset, and leave `HOME` alone: neither moves the lookup on its own.
