Fixed

A post run in another repo by `env -C <repo>` or `cd <repo> &&` gets that repo's `marks allow --here`, and never the session's; a folder the guard cannot place gets no allow. `env -C <repo> yokoten bot -- git push` reads its tags in that repo, as the post does. `marks allow --here` in a repo with a second remote now says to remove it with `git remote remove <name>` (#1377).
