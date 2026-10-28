Fixed

A desk now works on a network that reaches the model only through a proxy: when
`HTTPS_PROXY` is set, the desk's proxy sends each allowed host through it, and a host off
the list still never leaves. The start screen names the proxy by host and port only, never
its password. Each desk also gets its own writable temp folder (`TMPDIR`, `TEMP`, `TMP`)
instead of the caller's, so an agent started from a Claude Code shell no longer fails on a
read-only `/tmp/claude` (#1172).
