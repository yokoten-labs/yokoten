Fixed

On Windows, a done-when check stops programs it left running after `cmd.exe` exits (#735). On Linux, a check that ends also stops a program in a new process group in its session. A program that has already started its own session, such as `setsid`, is still left running. If Windows PowerShell is not there, or cannot compile its script, the check runs `cmd.exe` and says nothing. If PowerShell cannot start, or Windows will not take the job, the check says why on stderr and runs without one. A program it leaves running can then keep running.
