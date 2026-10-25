Security

A Windows home folder that bash ran together is now hidden too. Bash drops the backslashes of an unquoted Windows path, so `C:\Users\<name>\AppData` became `C:Users<name>AppData`. That text showed the user name in guard messages, `yokoten redact` output and other printed text. Now it shows as `~AppData`. The privacy check also finds a private mark inside such a path (#1017).
