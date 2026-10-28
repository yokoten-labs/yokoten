Fixed

On macOS, an agent in a desk can again start git and other programs by name when a
folder early on its PATH is a link into a hidden folder, such as `~/bin` linked to
dotfiles. Every desk now gives the agent a PATH of only the folders it can walk, each by
its real path, on every system (#1181).
