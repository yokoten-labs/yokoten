Security

The tool-call guard now stops a command that asks for root. That is `sudo`, `doas`, `su`, `pkexec`, `runas` and `Start-Process -Verb RunAs`. It does this for every person and every agent, with no setting.

It stops a recursive delete, and a recursive mode or owner change, on `/`, the home folder or a top-level system folder. That covers `rm -r`, `rmdir`, `find` with `-delete` or `-exec`, `Remove-Item -Recurse`, `rd /s`, `del /s`, `erase /s`, `chmod -R` and `chown -R`. A glob over one of them counts too. The folder the command runs in counts as the project, so `rm -rf dist` passes at `/app` as it does deeper down. A target the guard cannot read is refused too. A `$(pwd)` form counts as one it cannot read, so name the folder with a plain path. A target that arrives on stdin (`echo dist | xargs rm -rf`) is not read, and stays allowed.

It stops disk commands too: `mkfs*`, `wipefs`, `fdisk`, `parted`, `diskutil`, `hdparm`, `sgdisk`, `nvme`, `blkdiscard`, and `shred` onto a disk. It stops `dd` into `/dev`, a redirect into `/dev`, `format` and `diskpart`. A disk tool is refused even when it only reads, such as `diskutil list`.

The wipe and disk refusals say: tell the owner, who runs what needs root or touches a disk. A rule that names an exact case may answer first (#969, by GLM glm-5.3-flash, fixes by DeepSeek deepseek-v4.1-flash).
