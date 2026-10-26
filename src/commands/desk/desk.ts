// `yokoten desk` (record 0043, issue #1054): one of the three commands up front. A later
// pull request makes the bare command list and start desks. Until then, bare `desk` says
// it is not ready and writes nothing; `desk <agent> <folder> -- <command>` starts a fenced
// desk as before, from the guard's module, which loads only then.

import { type Invocation, print } from '../shared.ts';

/** The one line bare `yokoten desk` prints until the new desk lands. */
export const DESK_NOT_READY = 'yokoten desk: not ready yet; it comes later in this release. Nothing was started or written.';

export function runDesk(invocation: Invocation): number | Promise<number> {
  if (invocation.args.length === 0) {
    print(invocation, [DESK_NOT_READY]);
    return 0;
  }
  return import('../hook.ts').then((m) => m.runDesk(invocation));
}
