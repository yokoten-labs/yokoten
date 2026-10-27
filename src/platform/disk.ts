// ---- Files on each system (record 0040) ----
//
// Windows refuses a rename for a moment while another program holds a file open: most often
// the virus scanner reading the files just written. A folder copied and then renamed into
// place failed about once in 70 runs of init where Defender scans the temp folder (#1109).
// Every other system renames at once, so only Windows waits and tries again.

import { renameSync } from 'node:fs';

/** The errors Windows gives while another program holds a file: the rename may work a moment later. */
const BUSY_CODES = ['EPERM', 'EACCES', 'EBUSY'];

/** The waits between tries on Windows, in ms: about 3 s in all, then the error stands. */
export const RENAME_WAITS_MS = [10, 20, 50, 100, 200, 400, 800, 1600];

/** Stop this thread for `ms`; renames run in sync code, so there is no event loop to wait on. */
const pause = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * Rename `from` to `to`. On Windows a busy-file error is tried again after each wait in
 * RENAME_WAITS_MS; any other error, or any error on another system, is thrown at once.
 * `rename` and `wait` are there for a test.
 */
export function renameRetrying(from: string, to: string, platform: NodeJS.Platform | undefined, { rename = renameSync, wait = pause }: { rename?: (from: string, to: string) => void; wait?: (ms: number) => void } = {}): void {
  for (const ms of platform === 'win32' ? RENAME_WAITS_MS : []) {
    try {
      rename(from, to);
      return;
    } catch (error) {
      if (!BUSY_CODES.includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      wait(ms);
    }
  }
  rename(from, to);
}
