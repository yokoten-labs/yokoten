Fixed

`yokoten doctor` now sees a Windows folder that Copilot CLI trusts. Before, it only read folders that start with `/`, so it kept saying Copilot skips the hooks even after `yokoten trust`. It now reads `C:\...` folders, and ignores case and a `\` or `/` at the end (#1003).
