Changed

`yokoten bot` now checks the body it sends. It reads each body file and note file as it sends, after the shell has written it, and runs the privacy check on it. A file it can't read is never sent. The guard leaves these files to the bot, so you may write a body file and post it with `yokoten bot` in one command. A bare `gh` with a body file works as before (#1077).
