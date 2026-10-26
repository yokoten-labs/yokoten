// A session's live output (#694): `GET /api/sessions/<id>/stream`. The id is a hash of the
// desk's path, and the stream sends a cursor with each part. Every item passes the
// same masks as `yokoten redact`: secrets, private email addresses, the home folder, the
// private marks and this machine's own names. When the masks can't be built, the stream fails
// closed: it sends nothing.

import { type Env } from '../../../rules/config.ts';
import { hideHome, loadMarks, makeRedactor } from '../../../rules/privacy.ts';
import { machineMarks, machineUserNames } from '../../../setup/install.ts';
import { readBoardAgents, readBoardWorktrees, sessionId } from '../agents.ts';
import { makeStreamStore, readStream, type StreamAnswer, type StreamStore } from './tail.ts';

/** How long the masks stand before the marks are read again, so a new mark counts soon. */
const MASK_AGAIN_MS = 60000;

/** The masks for every line the stream sends. Throws when the marks can't be read: the caller sends nothing then. */
export function makeFeedMask(env: Env, root: string): (text: string) => string {
  const found = machineMarks(env, { cwd: root });
  return makeRedactor(
    {
      marks: loadMarks(env),
      owners: [...found.filter((mark) => mark.kind === 'git name' || mark.kind === 'git email').map((mark) => mark.value), ...machineUserNames(env)],
      hosts: found.filter((mark) => mark.kind === 'private remote host').map((mark) => mark.value),
    },
    env,
  );
}

/**
 * The mask for agent text in /api/state. When the marks cannot be read, every field is
 * empty, so a home path or a private word never leaves.
 */
export function makeBoardMask(env: Env, root: string): (text: string) => string {
  try {
    const mask = makeFeedMask(env, root);
    return (text) => (text ? mask(text) : '');
  } catch {
    return () => '';
  }
}

/** The board's streams, with masks read again every MASK_AGAIN_MS. Tests pass their own mask. */
export function makeFeedStreams(env: Env, root: string, mask?: (text: string) => string): StreamStore {
  let built: { mask: (text: string) => string; at: number } | null = null;
  const current = (text: string) => {
    if (mask) return mask(text);
    if (!built || Date.now() - built.at > MASK_AGAIN_MS) built = { mask: makeFeedMask(env, root), at: Date.now() };
    return built.mask(text);
  };
  return makeStreamStore(env, current);
}

/**
 * The next part of session `id`'s output (`GET /api/sessions/<id>/stream`), from `cursor`
 * on, or null when no session has that id. The status file's vendor says which runtime's
 * log to read.
 */
export function sessionAnswer(streams: StreamStore, root: string, env: Env, id: string, cursor: string): StreamAnswer | null {
  const trees = readBoardWorktrees(root, env);
  if (typeof trees === 'string') return null;
  const found = readBoardAgents(trees).find(({ tree }) => sessionId(hideHome(tree.path, env)) === id);
  if (!found) return null;
  // The masks are built before any line is read, so a failure sends nothing.
  streams.mask('');
  return readStream(streams, hideHome(found.tree.path, env), found.tree.path, found.agent.vendor, cursor, Date.now(), found.agent.log);
}
