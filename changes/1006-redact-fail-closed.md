Security

When the guard sends `git log`, `git config user.email` and similar reads through `yokoten redact`, and redact cannot start or stops partway, the output is now hidden instead of printed as it is. One line on stderr says so and tells you to run `yokoten doctor`. The exit code is the command's when it failed, and 1 when only redact failed (#1006).
