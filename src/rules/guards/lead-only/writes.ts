import nodePath from 'node:path';
import { finding, type Finding } from '../../text/message.ts';
import { type Env } from '../../config.ts';
import { stripWorktreeRoot, LEAD_ONLY_FIX, isLeadOnly, isGranted } from './edit.ts';
import { base, commandPlace, placedPath } from '../bash/read/words.ts';
import { UNSURE_FOLDER_FIX, writeTargets, commitTargets, type WriteTarget, type FileRules } from './targets.ts';
import { pathsFor } from '../../../platform/paths.ts';

// A `/` path Git Bash reads as one of its own folders (`/usr/x`, `/etc/x`): on Windows the
// guard can't tell which file that is, so it is refused as unsure (#1015).
const UNPLACED_FIX = 'write the path with its drive, as `C:/...` or `/c/...`, or relative to your worktree';

/** Why the guard can't tell which file a target is: `folder` (relative, from an unknown folder), `place` (a Git Bash path), or null. */
function unsureTarget(target: WriteTarget, env: Env): 'folder' | 'place' | null {
  if (target.path === '' || target.path === '-') return null;
  const paths = commandPlace.current ? pathsFor(commandPlace.current.platform) : nodePath;
  const placed = placedPath(/^~(?=\/|$)/.test(target.path) && env.HOME ? paths.join(env.HOME, target.path.slice(1)) : target.path, target.from);
  if (placed === null) return 'place';
  return target.from === null && !paths.isAbsolute(placed) ? 'folder' : null;
}

function unsureFinding(target: WriteTarget, env: Env, does: string): Finding | null {
  const unsure = unsureTarget(target, env);
  if (unsure === 'place') return finding('lead-only', `${does} ${target.path}, a Git Bash path yokoten can't place on Windows`, UNPLACED_FIX);
  if (unsure === 'folder') return finding('lead-only', `${does} ${target.path}, and yokoten can't tell which file that is from an unknown folder`, UNSURE_FOLDER_FIX);
  return null;
}

export function checkLeadOnlyWrites(words: string[], { env, rules, folder }: { env: Env; rules: FileRules; folder: string | null }): Finding | null {
  // A folder counts when a lead-only file may be in it: `rm -r .github`.
  // A file in a worker worktree matches from that worktree (#571), as an edit does; the message keeps the full path.
  const stopped = (target: WriteTarget): string | null => {
    const ruled = rules.ruled(target, env);
    if (!ruled) return null;
    const inWorktree = stripWorktreeRoot(ruled.path);
    const matches = (path: string) => isLeadOnly(path, ruled.leadOnly);
    return (matches(inWorktree) || matches(`${inWorktree}/-`)) && !isGranted(inWorktree, env) ? ruled.path : null;
  };
  for (const target of writeTargets(words, folder, rules.rootOf)) {
    if (target.isUnread) {
      if (target.from === null && target.path !== '' && target.path !== '-') {
        return finding('lead-only', `this command applies ${target.path}, and yokoten can't tell which files it changes from an unknown folder`, UNSURE_FOLDER_FIX);
      }
      if (target.from !== null && rules.isRuled(target.from)) {
        return finding('lead-only', `this command applies ${base(target.path)}, and yokoten can't read which files it changes`, `apply a patch file under 1 MB, so the guard can read it, or ${LEAD_ONLY_FIX}`);
      }
      continue;
    }
    const unsure = unsureFinding(target, env, 'this command writes');
    if (unsure) return unsure;
    const path = stopped(target);
    if (path !== null) return finding('lead-only', `this command writes ${path}, which is lead-only (yokoten.json "leadOnly")`, LEAD_ONLY_FIX);
  }
  for (const target of commitTargets(words, folder, rules.rootOf, env)) {
    const unsure = unsureFinding(target, env, 'this commit changes');
    if (unsure) return unsure;
    const path = stopped(target);
    if (path !== null) return finding('lead-only', `this commit changes ${path}, which is lead-only (yokoten.json "leadOnly")`, `unstage it with \`git restore --staged ${path}\`, then ${LEAD_ONLY_FIX}`);
  }
  return null;
}
