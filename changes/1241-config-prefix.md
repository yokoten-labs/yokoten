Fixed

The worker guard no longer reads a folder whose name only starts with `yokoten` as yokoten's config folder (#1241). `~/.config/yokoten-mac` and `~/.config/yokoten.bak` are other folders now. The name still counts when it ends at the end of the text, a separator, a quote, a glob, a brace, `$`, a shell character, a `:` or trailing dots, so every path that can reach `~/.config/yokoten` is still refused. The worker rule for any command that changes something under `~/.config` is unchanged.
