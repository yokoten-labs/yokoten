Fixed

On Windows, `yokoten init` no longer copies itself into its own folder until the path is too long, when the project's path has a short name (`RUNNER~1`) or a folder Windows redirects (#1109). A rename the virus scanner holds up for a moment is tried again for a few seconds, so init and install no longer fail at random. On native Windows, `yokoten desk` keeps its lines short and puts the next step on its own line.
