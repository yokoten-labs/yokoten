// The layout rules. First: no folder below the root holds more than `maxEntries` entries, so the
// tree stays something a person (or an agent) can read at a glance. When a folder is
// full, the fix is a new level that names a group, not one more file. Second: no build output or binaries in a commit.

import { posix } from 'node:path';
import type { Config } from './config.ts';
import { matcher } from './config.ts';
import { type Finding, finding, layoutFoldNote } from './text/message.ts';
import { CHANGES_DIR, codeOwnersWords, compileCodeOwnersPattern, isCodeOwnersHeader } from './pr.ts';

export { codeOwnersPatternMatches } from './pr.ts';

/**
 * The folder at the root that holds worker worktrees, one per issue (#571): inside the
 * project, git-ignored, where a restart can't wipe them. The layout check skips it, and
 * the guard reads a path under it from the worktree it is in.
 */
export const WORKTREES_DIR = '.worktrees';

// A folder in layout.exempt may grow: a log (records, root-cause reports), or a third-party
// fixture set kept under its upstream names, with its NOTICE beside it (#381). Each entry is
// a folder from the root, or a glob of whole segments: `*` is one folder, `**` any number
// of folders (none too). Nothing else is special, so `crates/*/tests/data` is one entry for
// every crate of a Rust workspace. Each entry is still written by hand.

const trimFolder = (entry: string): string => posix.normalize(entry).replace(/\/$/, '');

/** A test for an exempt glob, or none when the entry is an exact folder. */
function compileExemptGlob(folder: string): RegExp | undefined {
  const parts = folder.split('/');
  if (!parts.some((part) => part === '*' || part === '**')) return undefined;
  // Matched against "/" + the folder path, so each segment carries its own slash.
  const escape = (part: string) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = parts.map((part) => (part === '**' ? '(?:/[^/]+)*' : part === '*' ? '/[^/]+' : `/${escape(part)}`)).join('');
  return new RegExp(`^${body}$`);
}

const EXEMPT_FIX = 'or add it to layout.exempt in yokoten.json if it may grow: a log, or a third-party fixture set kept under its upstream names with its NOTICE beside it';

/** Whether a folder is, or is inside, a folder of fetched files. The build output check names those (#521); counting their entries only repeats it. */
const isFetched = (dir: string): boolean => dir.split('/').some((part) => FETCHED_DIRS.includes(part));

/**
 * Problems for a list of file paths (relative, forward slashes), one per folder over the cap.
 * With `notes`, each exempt glob that matches no folder adds a note, so a stale entry shows.
 */
export function checkLayout(files: string[], { layout }: Pick<Config, 'layout'>, notes?: Finding[]): Finding[] {
  // Worker worktrees are whole checkouts, not the project's folders (#571).
  files = files.filter((file) => file !== WORKTREES_DIR && !file.startsWith(`${WORKTREES_DIR}/`));
  const children = new Map<string, Set<string>>();
  for (const file of files) {
    const parts = file.split('/');
    for (let depth = 1; depth < parts.length; depth++) {
      const dir = parts.slice(0, depth).join('/');
      let names = children.get(dir);
      if (!names) children.set(dir, (names = new Set()));
      names.add(parts[depth]);
    }
  }
  // The change files wait in one folder until a release empties it (#132), so it may grow.
  // Exact folders are one set lookup; each glob is compiled once per run.
  const exact = new Set([CHANGES_DIR]);
  const globs: { entry: string; pattern: RegExp; isUsed: boolean }[] = [];
  for (const entry of layout.exempt) {
    const folder = trimFolder(entry);
    const pattern = compileExemptGlob(folder);
    if (pattern) globs.push({ entry, pattern, isUsed: false });
    else exact.add(folder);
  }
  // Every glob is tried on every folder, so a glob that matches nothing is known at the end.
  const isExempt = (dir: string): boolean => {
    let isMatched = exact.has(dir);
    for (const glob of globs) {
      if (glob.pattern.test(`/${dir}`)) isMatched = glob.isUsed = true;
    }
    return isMatched;
  };
  const problems: Finding[] = [];
  for (const [dir, names] of [...children].sort(([a], [b]) => a.localeCompare(b))) {
    if (isFetched(dir) || isExempt(dir) || names.size <= layout.maxEntries) continue;
    problems.push(
      finding('layout', `${names.size} entries, over the cap of ${layout.maxEntries}: ${[...names].sort().join(', ')}`, `group them into a new folder, ${EXEMPT_FIX}`, { file: `${dir}/` }),
    );
  }
  for (const glob of globs.filter((glob) => !glob.isUsed)) {
    notes?.push(
      finding('layout', `layout.exempt "${glob.entry}" matches no folder`, 'fix the glob, or remove it if those folders are gone', {
        file: 'yokoten.json',
        why: 'a stale entry lets a folder made later with that path grow unseen',
      }),
    );
  }
  return problems;
}

// ---- The project size (owner rule, 2026-11-27) ----
//
// A project one person wrote keeps its own code at or under "size.maxLines" lines. Tests,
// benches, vendored, fetched and borrowed code don't count, nor the folders in "size.exempt",
// written as layout.exempt is. The run reads the line counts; this part only judges them.

/** Folders, at any depth, whose code is not the project's own source. */
const SIZE_SKIPPED_DIRS = ['test', 'tests', '__tests__', 'benches', 'vendor'];
/** Test files by their name, in any folder. */
const SIZE_TEST_NAME = /\.(?:test|spec)\.[^/]+$|_test\.[^/]+$/;
/** How many of the biggest files a size finding names. */
const SIZE_LISTED = 5;

/** A test for exempt entries, as layout.exempt reads them: whether a path is one of them or inside one. */
function compileExemptTest(entries: string[]): (path: string) => boolean {
  const exact = new Set<string>();
  const globs: RegExp[] = [];
  for (const entry of entries) {
    const folder = trimFolder(entry);
    const pattern = compileExemptGlob(folder);
    if (pattern) globs.push(pattern);
    else exact.add(folder);
  }
  return (path) => {
    const parts = path.split('/');
    for (let depth = 1; depth <= parts.length; depth++) {
      const dir = parts.slice(0, depth).join('/');
      if (exact.has(dir) || globs.some((glob) => glob.test(`/${dir}`))) return true;
    }
    return false;
  };
}

/** What the size rule asks of the run: which paths hold code, and which are borrowed. */
export interface SizeReads {
  isCode: (path: string) => boolean;
  isBorrowed: (path: string) => boolean;
}

/** The paths among `files` whose lines count toward the cap. */
export function sizeCountedFiles(files: string[], { size }: Pick<Config, 'size'>, { isCode, isBorrowed }: SizeReads): string[] {
  const isExempt = compileExemptTest(size.exempt);
  return files.filter((path) => {
    const dirs = path.split('/').slice(0, -1);
    if (!isCode(path) || isBorrowed(path) || SIZE_TEST_NAME.test(path) || dirs[0] === WORKTREES_DIR) return false;
    return !dirs.some((dir) => SIZE_SKIPPED_DIRS.includes(dir) || FETCHED_DIRS.includes(dir)) && !isExempt(path);
  });
}

/**
 * The size problem, when the counted code is over the cap, else none. The count is a note
 * within 10% of the cap, for a fork, and when the repo has not chosen the cap (`isChosen`).
 * `countLines` gives a counted file's physical lines.
 */
export function checkSize(files: string[], countLines: (path: string) => number, { size }: Pick<Config, 'size'>, reads: SizeReads & { isChosen: boolean }, notes: Finding[]): Finding[] {
  const counts = sizeCountedFiles(files, { size }, reads).map((path) => ({ path, lines: countLines(path) }));
  const total = counts.reduce((sum, file) => sum + file.lines, 0);
  if (total === 0) return [];
  const biggest = counts.sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path)).slice(0, SIZE_LISTED);
  const named = biggest.map((file) => `${file.path} (${file.lines})`).join(', ');
  const what = `${total} lines of the project's own code`;
  if (!reads.isChosen) {
    // A repo already over the default starts at its own count, rounded up, so the key passes.
    const start = Math.max(size.maxLines, Math.ceil(total / 100) * 100);
    notes.push(finding('size', `${what}; no cap is set`, `to hold this repo to a cap, add \`"size": { "maxLines": ${start} }\` to yokoten.json`, { why: 'the size cap is a rule a repo chooses; this one has no "size" key in yokoten.json, so its count is a note' }));
  } else if (size.fork) {
    notes.push(finding('size', `${what}; a fork, so the cap of ${size.maxLines} is not held`, 'nothing to do while this repo is a fork', { why: 'a fork carries code its upstream wrote' }));
  } else if (total > size.maxLines) {
    return [finding('size', `${what}, over the cap of ${size.maxLines}; the biggest: ${named}`, 'cut code until the count is under the cap; for a fork, set `"size": { "fork": true }` in yokoten.json')];
  } else if (total * 10 > size.maxLines * 9) {
    notes.push(finding('size', `${what}, within 10% of the cap of ${size.maxLines}; the biggest: ${named}`, 'cut code before the count reaches the cap'));
  }
  return [];
}

/** How many folders the folded note names before it says how many more. */
const FOLDED_NAMES = 5;

/**
 * The folder hits of a repo that has not chosen the cap (#1169), as one note, or null when
 * there are none. The cap is a yokoten house rule: a repo that only runs `check` is told
 * once, not failed once per folder.
 */
export function foldLayoutHits(hits: Finding[], { layout }: Pick<Config, 'layout'>): Finding | null {
  const folders = hits.filter((hit) => hit.id === 'layout').map((hit) => hit.file ?? '');
  if (!folders.length) return null;
  const named = folders.slice(0, FOLDED_NAMES).join(', ');
  const more = folders.length > FOLDED_NAMES ? `, and ${folders.length - FOLDED_NAMES} more` : '';
  const { what, fix, why } = layoutFoldNote(folders.length, layout.maxEntries, `${named}${more}`);
  return finding('layout', what, fix, { why });
}

// Build output and binaries (#56). Build output is made from the source, so a copy in the
// repo only goes stale. A reviewer can't read a binary. Images and fonts are binary too,
// but docs and sites need them, so they pass.
/** The folders a build writes to, at any depth. */
export const BUILD_DIRS = ['dist', 'build', 'out'];
const MEDIA = /\.(?:png|jpe?g|gif|webp|svg|ico|woff2?)$/i;
/** Files that are built, whatever git thinks of their bytes. */
export const BUILT = /\.(?:exe|dll|so|dylib|zip|tar|gz|tgz|jar|class|o|a|wasm|pyc|node)$/i;

const SOURCE_NAME = /^(?:dockerfile|containerfile|makefile|gnumakefile)(?:[-._].*)?$|\.(?:sh|mk|md|cmake|dockerfile)$/i;

/**
 * A source file in a folder called build (#1167): docker/build/Dockerfile, build/Makefile, build/release.sh.
 * A build does not make these. Only a build/ folder is exempt, not dist/ or out/, and a binary by its name is still output.
 */
export function isBuildSource(path: string): boolean {
  const parts = path.split('/');
  const dirs = parts.slice(0, -1);
  if (!dirs.includes('build') || dirs.some((dir) => dir !== 'build' && BUILD_DIRS.includes(dir))) return false;
  return !BUILT.test(path) && SOURCE_NAME.test(parts[parts.length - 1] ?? '');
}

/** Whether a path is build output: under a build folder, or a built file by its name. */
export function isBuildOutput(path: string, allow: (path: string) => boolean = () => false): boolean {
  if (allow(path) || isBuildSource(path)) return false;
  return path.split('/').slice(0, -1).some((dir) => BUILD_DIRS.includes(dir)) || BUILT.test(path);
}

const fix = (path: string) => `remove it with \`git rm --cached ${path}\` and add it to .gitignore, or list the path in allowBuild in yokoten.json`;

/** Folders that hold fetched or generated files, not the project's own (#521). One finding covers the folder. */
export const DEPENDENCY_DIRS = ['node_modules', 'vendor', '.venv', 'venv', 'target', '__pycache__'];

/** The dependency folders no project commits, so every file in them counts. A committed vendor/ (Go) can be on purpose. */
const FETCHED_DIRS = ['node_modules', '.venv', 'venv', '__pycache__'];

const folderFix = (folder: string) =>
  `run \`git rm -r --cached ${folder}\` (it stays on disk) and add \`${folder}/\` to .gitignore, or list the path in allowBuild in yokoten.json`;

/**
 * Problems for the files a commit adds or changes, each with whether git sees it as binary.
 * Files under one dependency folder, or two or more under one build folder, make one finding
 * for the folder; its file is the folder (#521).
 */
export function checkBuildOutput(files: { path: string; binary: boolean }[], { allowBuild }: Pick<Config, 'allowBuild'>): Finding[] {
  const allow = matcher(allowBuild);
  const flagged: { path: string; id: 'build-output' | 'binary'; folder?: string; isDependency: boolean; dir?: string }[] = [];
  for (const { path, binary } of files) {
    if (allow(path)) continue;
    const parts = path.split('/').slice(0, -1);
    const at = parts.findIndex((d) => DEPENDENCY_DIRS.includes(d) || BUILD_DIRS.includes(d));
    const dir = isBuildSource(path) ? undefined : parts.find((d) => BUILD_DIRS.includes(d));
    const isBuild = dir !== undefined;
    const isDependency = at >= 0 && DEPENDENCY_DIRS.includes(parts[at]);
    const isFetchedFile = isDependency && FETCHED_DIRS.includes(parts[at]);
    if (!isFetchedFile && !isBuild && !BUILT.test(path) && !(binary && !MEDIA.test(path))) continue;
    flagged.push({ path, id: isBuild ? 'build-output' : 'binary', folder: at >= 0 ? parts.slice(0, at + 1).join('/') : undefined, isDependency, dir });
  }
  const count = new Map<string, number>();
  for (const { folder } of flagged) if (folder) count.set(folder, (count.get(folder) ?? 0) + 1);
  const problems: Finding[] = [];
  const seen = new Set<string>();
  for (const { path, id, folder, isDependency, dir } of flagged) {
    const isGrouped = folder !== undefined && (isDependency || (count.get(folder) ?? 0) > 1);
    if (isGrouped) {
      if (seen.has(folder)) continue;
      seen.add(folder);
      const n = count.get(folder);
      const what = isDependency
        ? `a dependency folder, with ${n} of its files in the commit`
        : `build output, with ${n} files in a ${dir}/ folder`;
      problems.push(finding(isDependency ? 'build-output' : id, what, folderFix(folder), { file: `${folder}/` }));
    } else if (id === 'build-output') problems.push(finding(id, `build output, in a ${dir}/ folder`, fix(path), { file: path }));
    else problems.push(finding(id, 'a binary file', fix(path), { file: path }));
  }
  return problems;
}

// ---- CODEOWNERS (#667) ----
//
// A CODEOWNERS line whose path matches no file protects nothing: a move or a rename leaves
// the old path behind, so the new path has no owner review, and nothing else says so.

/** The places GitHub reads CODEOWNERS from, first first. */
export const CODEOWNERS_PLACES = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];

/** A lead-only glob as the CODEOWNERS path init writes: `x/**` is the folder `/x/`. */
export const codeOwnersPath = (glob: string): string => `/${glob.replace(/\/\*\*$/, '/')}`;

/**
 * Problems for the rule lines of a CODEOWNERS file whose path matches none of `files`.
 * `file` is the place the file was read from, for the message. A path in `reserved` is a
 * lead-only path init writes before it exists, a guard for the future, not a stale line.
 */
export function checkCodeOwners(files: string[], text: string, file: string = CODEOWNERS_PLACES[0] as string, reserved: ReadonlySet<string> = new Set()): Finding[] {
  const problems: Finding[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    // A blank line, a comment and a section header name no path, as on GitHub.
    if (isCodeOwnersHeader(line.trim())) return;
    const pattern = codeOwnersWords(line)[0];
    if (!pattern || reserved.has(pattern)) return;
    const matcher = compileCodeOwnersPattern(pattern);
    if (files.some((path) => matcher.test(path))) return;
    problems.push(finding('stale-codeowners', `${pattern} matches no file: this rule protects nothing; point it at the new path`, `ask the lead or owner to change it in ${file}`, {
      file,
      line: index + 1,
      why: 'a moved or renamed file leaves its CODEOWNERS line behind, so the new path has no owner review',
    }));
  });
  return problems;
}
