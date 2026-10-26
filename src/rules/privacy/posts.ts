// The gh posting forms whose text the checks can read, as data (#1104). A posting command
// in any other form is refused, never parsed: the guard sends it to `yokoten bot`, and the
// bot refuses a form whose text it can't read. The tables are short on purpose.

/** The gh commands that post text the checks read, by group and subcommand (`new` is gh's alias for `create`). */
export const POSTS: Record<string, string[]> = {
  issue: ['create', 'new', 'comment', 'edit', 'close'],
  pr: ['create', 'new', 'comment', 'edit', 'review', 'merge', 'close'],
  release: ['create', 'new', 'edit'],
};

/** gh commands that post files the checks don't read (#1104): refused, whatever their options. */
export const UNREAD_POSTS: Record<string, string[]> = {
  gist: ['create', 'new', 'edit'],
  release: ['upload'],
};

/** gh's global option that takes a value before the subcommand: `gh -R o/r issue create`. */
export const GLOBAL_VALUES = new Set(['-R', '--repo']);

/** Options that make gh read text from a file the checks don't know (#1104): `--recover` holds a title and body. */
const UNREAD_OPTIONS = ['--recover'];

/**
 * The short letters that take text or a text file in a posting command (#1077, #1104):
 * `-F` body file, `-b` body, `-t` title or subject, `-n` notes, `-c` a close comment.
 */
const TEXT_LETTERS = /[Fbtnc]/;

/**
 * The first letters of a short word that is one option with its value joined on, such as
 * `-bText` or `-Ro/r`. `c` holds a value only in `close`; in `pr review` it is a switch.
 */
const VALUE_FIRST = /^-[FbtnR]/;
const CLOSE_VALUE_FIRST = /^-[FbtnRc]/;

/** `release create <tag>`: the options gh takes, as data. Any other word with `-` is refused. */
const RELEASE_VALUES = new Set(['--notes', '-n', '--notes-file', '-F', '--title', '-t', '--target', '--discussion-category', '--notes-start-tag', '--repo', '-R']);
const RELEASE_SWITCHES = new Set(['--draft', '-d', '--prerelease', '-p', '--generate-notes', '--latest', '--verify-tag', '--fail-on-no-commits', '--notes-from-tag', '--help', '-h']);

/** The group and subcommand of a gh command: the first two words that are not options. */
function groupAndSub(args: string[]): [string | undefined, string | undefined] {
  const plain: string[] = [];
  for (let index = 0; index < args.length && plain.length < 2; index++) {
    if (GLOBAL_VALUES.has(args[index])) index++;
    else if (!args[index].startsWith('-')) plain.push(args[index]);
  }
  return [plain[0], plain[1]];
}

/** The group and subcommand of a gh command that posts text the checks read, or null. */
export function postKind(args: string[]): { group: string; sub: string; isApi: boolean } | null {
  const [group, sub] = groupAndSub(args);
  if (group === undefined) return null;
  const isApi = group === 'api';
  return isApi || (sub !== undefined && POSTS[group]?.includes(sub)) ? { group, sub: sub ?? '', isApi } : null;
}

/** Whether a gh command posts, in a form the checks read or not. */
export function isPosting(args: string[]): boolean {
  const [group, sub] = groupAndSub(args);
  return postKind(args) !== null || (group !== undefined && sub !== undefined && !!UNREAD_POSTS[group]?.includes(sub));
}

/** The long options that carry a post's text, or a file or field holding it. */
const TEXT_OPTIONS = new Set(['--body', '--body-file', '--title', '--notes', '--notes-file', '--comment', '--subject', '--recover', '--input', '--field', '--raw-field', '-f']);

/**
 * Whether words after a program the guard can't name may be part of a post (#1104): any post
 * group or subcommand word, or any option that carries text. A word list, not gh's grammar,
 * so `G="gh issue"; $G comment 3 -b …` counts too.
 */
export function mayPost(words: string[]): boolean {
  const postWords = new Set(['api', ...Object.keys(POSTS), ...Object.values(POSTS).flat(), ...Object.keys(UNREAD_POSTS), ...Object.values(UNREAD_POSTS).flat()]);
  return words.some((word) => {
    if (postWords.has(word)) return true;
    if (TEXT_OPTIONS.has(word.startsWith('--') && word.includes('=') ? word.slice(0, word.indexOf('=')) : word)) return true;
    return /^-[A-Za-z]/.test(word) && TEXT_LETTERS.test(/^-[A-Za-z]+/.exec(word)?.[0].slice(1) ?? '');
  });
}

/** Why the checks can't read what a posting gh command sends, with the bot's fix; null when its form is known (#1104). */
export type UnreadPost = { what: string; fix: string };

/**
 * The first part of a posting gh command that the allowlist above does not cover, or null.
 * Only options before `--` count: after it gh reads words as they are.
 */
export function unreadPost(args: string[]): UnreadPost | null {
  const [group, sub] = groupAndSub(args);
  if (group !== undefined && sub !== undefined && UNREAD_POSTS[group]?.includes(sub)) {
    return { what: `\`gh ${group} ${sub}\` sends files that the privacy check does not read`, fix: 'post the text as an issue or pull request comment with `--body-file` instead' };
  }
  const kind = postKind(args);
  if (!kind || kind.isApi) return null;
  const end = args.indexOf('--');
  const words = end === -1 ? args : args.slice(0, end);
  const valueFirst = kind.sub === 'close' ? CLOSE_VALUE_FIRST : VALUE_FIRST;
  const cluster = words.find((word) => /^-[A-Za-z]/.test(word) && !valueFirst.test(word) && TEXT_LETTERS.test(/^-[A-Za-z]+/.exec(word)?.[0].slice(2) ?? ''));
  if (cluster !== undefined) {
    return {
      what: 'this gh command joins short options with one that takes the body or other text (`-F`, `-b`, `-t`, `-n` or `-c`), so yokoten cannot tell which text it sends',
      fix: 'write each short option as its own word, such as `-d -t title`, or use the long names, such as `--title`',
    };
  }
  const option = words.find((word) => UNREAD_OPTIONS.some((name) => word === name || word.startsWith(`${name}=`)));
  if (option !== undefined) return { what: '`--recover` reads a title and body from a file that the privacy check does not read', fix: 'leave out `--recover`, and give the text with `--title` and `--body-file`' };
  // A release reads all its words: each one after `--` is a file to upload.
  if (kind.group === 'release' && (kind.sub === 'create' || kind.sub === 'new')) return unreadRelease(args);
  return null;
}

// `release create <tag>` with only the options in the tables: a second plain word is a file to
// upload, and an option the tables don't name may take one, so either is refused. gh reads each
// word after `--` as a file too: `release create v1 -F n.md -- a.zip` uploads a.zip.
function unreadRelease(words: string[]): UnreadPost | null {
  const plain: string[] = [];
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    if (word === '--') {
      plain.push(...words.slice(index + 1));
      break;
    }
    const name = word.startsWith('--') && word.includes('=') ? word.slice(0, word.indexOf('=')) : word;
    if (RELEASE_VALUES.has(name)) {
      if (name === word) index++;
    } else if (RELEASE_SWITCHES.has(name)) continue;
    else if (word.startsWith('-')) {
      // A short option with its value joined on, such as `-Fnotes.md`, is that option.
      if (!/^-[A-Za-z]./.test(word) || !RELEASE_VALUES.has(word.slice(0, 2))) return { what: `yokoten does not know the option ${name} of \`gh release create\`, so it cannot tell what it sends`, fix: 'use only the options in `gh release create --help` that yokoten reads: the tag, `--title`, `--notes-file`, and switches such as `--draft`' };
    } else plain.push(word);
  }
  if (plain.length > 3) return { what: '`gh release create` here uploads files that the privacy check does not read', fix: 'create the release with its tag and `--notes-file` only, and upload files by hand' };
  return null;
}
