Fixed

`yokoten install` now asks before it changes your git config. It lists git's global `mailmap.file` in its plan and sets it only when you say yes; with no terminal, it prints the command to run. `yokoten uninstall` now removes only the folders and git config file that install made, so an empty folder you had before stays. On Windows, the merge train's test step runs again (#985).
