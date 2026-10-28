Fixed

`yokoten doctor` no longer says yokoten is BROKEN when the machine has no usable temp folder, for example when the disk is full. It says in one line that the self-test could not set up, names the temp folder (the home folder shown as `~`), and says to free space there. A check that really fails is still BROKEN (#1108).
