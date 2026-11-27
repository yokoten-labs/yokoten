Fixed

The post check no longer reads a users folder with no name after it as a user name: `C:\Users\` or `/Users/` followed by a backtick, a `<`, a space or the line end passes. A real name, with or without spaces, is still refused (#1382).
