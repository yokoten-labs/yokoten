Fixed

`install`, `init` and `uninstall` are safer with your agent tools' settings files (#984). A settings file that is a link to your dotfiles stays a link. A write that fails half way leaves your file as it was. The first time yokoten changes a file of yours, it keeps a copy next to it as `<file>.before-yokoten`, and it never overwrites that copy. A hook you wrote yourself that runs `npx yokoten`, such as `npx yokoten hook`, now stays: yokoten changes and removes only the hooks it wrote.
