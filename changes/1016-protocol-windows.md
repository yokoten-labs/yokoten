Fixed

Tools that speak the guard protocol now work on Windows. Before, every call was refused with "project must be an absolute folder", because only folders that start with `/` passed. Now `C:\work\app`, `C:/work/app` and network folders such as `\\server\share\app` are accepted on Windows. Git Bash paths like `/c/work/app` are still refused there for now (#1016).
