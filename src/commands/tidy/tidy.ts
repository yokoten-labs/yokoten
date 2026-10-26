// `yokoten tidy` (record 0043, issue #1054): one of the three commands up front. A later
// pull request makes it find old branches, worktrees and desks. Until then it says it is
// not ready and writes nothing.

import { type Invocation, parse, print, usage } from '../shared.ts';

/** The one line `yokoten tidy` prints until the real one lands. */
export const TIDY_NOT_READY = 'yokoten tidy: not ready yet; it comes later in this release. Nothing was changed.';

export function runTidy(invocation: Invocation): number {
  const options = parse('tidy', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  print(invocation, [TIDY_NOT_READY]);
  return 0;
}
