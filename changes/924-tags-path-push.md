Fixed

The tool guard treats `tags/<name>` as a tag, because git resolves it to `refs/tags/<name>`. A delete or a move of a remote tag is now refused (#924).
