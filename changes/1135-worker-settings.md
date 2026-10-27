Added

A project can now let its workers set its own test settings, such as `SCREENS_OUT=out.txt node --test`, by listing them in yokoten.json `"worker": { "settings": [...] }`; a name that moves a folder or runs other code (`PATH`, `GIT_*`, `LD_*`, `NODE_OPTIONS` and the like) is refused when the file loads. The guide now says plainly that the guard reads settings only on the command line, and that a script a worker writes is out of its reach (#1135).
