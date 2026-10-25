import nodePath, { posix, win32 } from 'node:path';
import { tmpdir } from 'node:os';

// ---- Paths on each system (record 0040) ----
//
// The first piece of the platform layer: how a path an agent writes reads on the system the
// command runs on. Claude Code runs Git Bash on Windows, and Git Bash writes `C:\Users\x` as
// `/c/Users/x` and the temp folder as `/tmp`. Node on Windows reads `/c/Users/x` as
// `C:\c\Users\x`, outside every repo, so a guard that took it as written found nothing to
// guard (#1015). The helpers here are pure: the system and the temp folder come from the
// caller, so Linux CI tests the Windows logic.

/** Where a command's paths are read: the system, and the folder Git Bash calls `/tmp`. */
export type PathPlace = { platform: NodeJS.Platform; tmp: string };

/**
 * This machine's place, for an entry point to pass down. The only read of the system and the
 * temp folder here; nothing below the entry point calls it again.
 */
export function hostPathPlace(): PathPlace {
  return { platform: process.platform, tmp: tmpdir() };
}

/** Git Bash's drive form, `/c` or `/c/...`, one letter of either case, as `C:\...`; null for any other path. */
export function gitBashDrive(path: string): string | null {
  const drive = /^\/([A-Za-z])(?=\/|$)/.exec(path);
  if (!drive) return null;
  return `${drive[1].toUpperCase()}:\\${path.slice(2).replace(/^\/+/, '').replace(/\//g, '\\')}`;
}

/**
 * A path as the system reads it. On Windows a Git Bash `/c/...` is `C:\...`, and `/tmp/...` is
 * in `tmp`, the folder Git Bash mounts there. Any other path from one `/` (`/usr/x`, `/etc`)
 * is a folder of the Git install that the guard cannot place: null, which the caller reads as
 * unsure and refuses. A device (`/dev/null`, `/dev/stderr`) stays as written: it is no file.
 * A `//` path and every path on other systems are returned unchanged.
 */
export function fromGitBash(path: string, platform: NodeJS.Platform, tmp: string): string | null {
  if (platform !== 'win32' || !path.startsWith('/') || path.startsWith('//')) return path;
  // Git Bash reads `..` from its own root: `/c/../d/x` is `D:\x`, `/dev/../c/x` is `C:\x`.
  const plain = posix.normalize(path);
  const drive = gitBashDrive(plain);
  if (drive !== null) return drive;
  if (plain === '/tmp' || plain.startsWith('/tmp/')) return tmp + plain.slice('/tmp'.length);
  if (plain.startsWith('/dev/')) return plain;
  return null;
}

/**
 * Whether a relative `path` from `folder` climbs past the folder's drive root on Windows.
 * Windows stops at `C:\`, but Git Bash goes on to its own root `/`, so
 * `../../c/x` from `C:\a` is `C:\x` to bash and `C:\c\x` to Node. The caller reads it as
 * unsure. Always false on other systems.
 */
export function climbsPastDrive(folder: string, path: string, platform: NodeJS.Platform): boolean {
  if (platform !== 'win32') return false;
  // The drive (`C:`) is the first part, so the drive root is depth 0.
  let depth = folder.split(/[\\/]+/).filter(Boolean).length - 1;
  for (const part of path.split(/[\\/]+/)) {
    if (part === '..') {
      if (--depth < 0) return true;
    } else if (part !== '' && part !== '.') depth++;
  }
  return false;
}

/** The path functions for `platform`, so a Windows path reads as Windows reads it on any machine. */
export function pathsFor(platform: NodeJS.Platform): typeof posix {
  return platform === 'win32' ? win32 : posix;
}

/** Whether `platform` reads paths as this machine does, so its paths can be looked up on this disk. */
export function isHostPaths(platform: NodeJS.Platform): boolean {
  return pathsFor(platform) === nodePath;
}
