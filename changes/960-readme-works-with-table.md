Changed

The "Works with" part of every README is a table now: one row per agent, with what is
verified end to end, whether `npx yokoten trust` is needed first, and the models each
run used. The first line says any AI model works. A test keeps each README's table and
its refusal sample equal to the guide's table and the hook's output, so they cannot
drift by hand again (#960).
