Internal

The release's checks run on every pull request, from the same file a release tag runs, so a tag never meets a step for the first time. No test reporter writes to `/dev/null`, which failed the first v0.1.2 release run (#1149).
