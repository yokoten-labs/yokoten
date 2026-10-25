Security

On Windows, the guard now refuses `rm -rf ~` and other wipes of the home folder. It reads `C:\Users\<name>`, `C:\Program Files`, `C:\Program Files (x86)` and `C:\ProgramData` as system folders. Paths with `\` or `/`, any letter case, and Git Bash's `/c/...` now count as the same folder. A POSIX-style project path such as `/app/dist` is no longer refused on Windows (#999).
