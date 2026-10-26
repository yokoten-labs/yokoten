// The Windows test job, with its list of known failures (record 0040, owner 2026-10-25).
// The whole suite first ran on native Windows before the 0.1.1 release and failed in about
// 170 tests, most of them test setup (POSIX paths, fake programs with no extension, a PATH
// joined with `:`). A few test files also never ended there, so one `node --test` run of the
// suite waited past the job's limit. So this runs each test file on its own, four at a time,
// each with a time cap, and compares the failures with the list:
//   - a failure that is not on the list fails the job: a new Windows bug;
//   - a listed failure that passes now fails the job too, and names the line to remove, so
//     the list only gets shorter. A line that starts with `? ` may pass or fail (flaky).
//
//   node scripts/time/windows-known.ts                     run, compare with the list
//   node scripts/time/windows-known.ts --out <file>        also write this run's failures
//   node scripts/time/windows-known.ts --cap 240 --jobs 4  seconds per file, files at once
//   node scripts/time/windows-known.ts --shard 2/3         this machine's third of the files
//   node scripts/time/windows-known.ts --list              the files that run, and the skipped areas
//   node scripts/time/windows-known.ts --platform win32    judge as that system (default: this one)
//
// Scope (issue #1068): only the areas native Windows supports run. TEST_AREAS below
// is the table; each skipped area is printed with its reason, and a list entry for a file that
// does not run here fails the job as stale, so the list never keeps a waiver nobody checks.
//
// A crash (a file that dies outside its tests, or a run with no test result at all) is run once
// more. If the second run gets through, the job goes on and names the file as FLAKY, with the
// first run's stderr; if it crashes again, its stderr is printed and it fails as a new failure
// unless listed. A time-out is not run again: the cap is minutes.
//
// Speed (owner 2026-10-25: a fast answer is worth more, even a failing one): the job runs on
// several machines at once, each with a share of the files by the seconds they took last time
// (scripts/time/windows-times.txt), and each machine starts with its longest files, so no long
// file is left to run alone at the end. `--times <file>` writes this run's seconds; copy the
// shards' files together over windows-times.txt when the shards drift apart.
//
// Each entry in the --out file has its reason above it, as a `# why:` comment: the first
// line of the test's error, with the home and the repo folders hidden. The job's summary counts
// the failures by reason, so a cause shared by many tests shows at the top (owner 2026-10-25).
//
// An entry is `<test file> :: <test name>`, the file from `test/` on with `/`. A file that
// passed its cap is `<test file> :: (timed out)`. To write the list from a run, join the shards'
// `--out` files (the `windows-failures-N` artifacts) into scripts/time/windows-known.txt.
import { spawn } from 'node:child_process';
import { appendFileSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const KNOWN_FILE = join(ROOT, 'scripts', 'time', 'windows-known.txt');
export const TIMES_FILE = join(ROOT, 'scripts', 'time', 'windows-times.txt');
export const TIMED_OUT = '(timed out)';
export const CRASHED = '(crashed)';

// ---- Which test areas run on which system (issue #1068) ----
//
// Record 0040: platform as an argument, one case table per OS, fail closed. Native Windows
// runs the CLI, the guard hooks and install; the desk runs in WSL there (record 0043, owner
// 2026-10-26), so its tests, its fence's and the kanban server's run on Linux and macOS
// only. A skip names its reason, and the job prints it, so a skipped area never reads as a
// passing one. The table is plain data with pure helpers: `scopeOf(file, platform)` takes
// the system as an argument, so a test helper may read it too.

/** The systems the table speaks for. Any other system is refused, not guessed (fail closed). */
export const PLATFORMS = ['linux', 'darwin', 'win32'] as const;
export type Platform = (typeof PLATFORMS)[number];

export interface TestArea {
  /** A short name for the log. */
  area: string;
  /** Test files or folders (ending in `/`), from the repo root with `/`. */
  paths: readonly string[];
  /** Per system: why the area does not run there. A system not named runs it. */
  skip: Partial<Record<Platform, string>>;
}

const DESK_IN_WSL = 'the desk runs in WSL on Windows (record 0043)';

/** First match wins, so a narrower area comes before the folder that holds it. */
export const TEST_AREAS: readonly TestArea[] = [
  { area: 'desk fence', paths: ['test/agents/desk/fence/', 'test/agents/desk/network/'], skip: { win32: DESK_IN_WSL } },
  { area: 'desk', paths: ['test/agents/desk/', 'test/commands/desk/'], skip: { win32: DESK_IN_WSL } },
  { area: 'kanban server', paths: ['test/commands/kanban/server.test.ts', 'test/commands/kanban/feed/route.test.ts'], skip: { win32: DESK_IN_WSL } },
];

/** `value` as a Platform, or an error that names the systems the table knows. */
export function platformOf(value: string): Platform {
  if ((PLATFORMS as readonly string[]).includes(value)) return value as Platform;
  throw new Error(`no test scope for the system "${value}"; the table knows ${PLATFORMS.join(', ')} (TEST_AREAS in scripts/time/windows-known.ts)`);
}

const slashed = (file: string) => file.replace(/\\/g, '/');
const covers = (path: string, file: string) => (path.endsWith('/') ? file.startsWith(path) : file === path);

/** The area a test file belongs to, or null when no area names it. */
export function areaOf(file: string, areas: readonly TestArea[] = TEST_AREAS): TestArea | null {
  const name = slashed(file);
  return areas.find((area) => area.paths.some((path) => covers(path, name))) ?? null;
}

/** Why `file` does not run on `platform`, with its area, or null when it runs there. */
export function scopeOf(file: string, platform: Platform, areas: readonly TestArea[] = TEST_AREAS): { area: string; reason: string } | null {
  const area = areaOf(file, areas);
  const reason = area?.skip[platform];
  return area && reason ? { area: area.area, reason } : null;
}

/**
 * The files that run on `platform`, and the ones skipped there with their area and reason.
 * A path in the table that names no test file throws: a stale table would skip nothing and
 * say nothing, so it is refused (fail closed).
 */
export function scopeFor(files: string[], platform: Platform, areas: readonly TestArea[] = TEST_AREAS): { run: string[]; skipped: { file: string; area: string; reason: string }[] } {
  const names = files.map(slashed);
  const stale = areas.flatMap((area) => area.paths.filter((path) => !names.some((name) => covers(path, name))).map((path) => `${area.area}: ${path}`));
  if (stale.length) throw new Error(`these test areas name no test file; fix TEST_AREAS in scripts/time/windows-known.ts: ${stale.join('; ')}`);
  const run: string[] = [];
  const skipped: { file: string; area: string; reason: string }[] = [];
  for (const file of files) {
    const scope = scopeOf(file, platform, areas);
    if (scope) skipped.push({ file: slashed(file), ...scope });
    else run.push(file);
  }
  return { run, skipped };
}

/** The skipped files counted by area, one line each: `<area> (<n> files): <reason>`. */
export function skippedLines(skipped: { area: string; reason: string }[]): string[] {
  const byArea = new Map<string, { reason: string; count: number }>();
  for (const { area, reason } of skipped) byArea.set(area, { reason, count: (byArea.get(area)?.count ?? 0) + 1 });
  return [...byArea].map(([area, { reason, count }]) => `${area} (${count} ${count === 1 ? 'file' : 'files'}): ${reason}`);
}

// ---- The runner ----

const HEADER = [
  '# Tests known to fail on native Windows (scripts/time/windows-known.ts, record 0040).',
  '# Fix a test, then remove its line: the Windows job fails while a listed test passes.',
  '# `? ` before a line: the test may pass or fail.',
];

/** The names of the failed top-level tests in one file's TAP report, once each. */
export function readFailures(tap: string): string[] {
  const names = new Set<string>();
  for (const line of tap.split(/\r?\n/)) {
    const failed = /^not ok \d+ - (.*?)(?: # .*)?$/.exec(line);
    if (failed) names.add(failed[1].replace(/\\#/g, '#'));
  }
  return [...names];
}

/**
 * Each failed top-level test's reason: the first line of its error in the TAP YAML block
 * (`error: 'text'` or `error: |-` and the next line). A test with no error line has none.
 */
export function readReasons(tap: string): Map<string, string> {
  const reasons = new Map<string, string>();
  const lines = tap.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const failed = /^not ok \d+ - (.*?)(?: # .*)?$/.exec(lines[i]);
    if (!failed) continue;
    const name = failed[1].replace(/\\#/g, '#');
    for (let j = i + 1; j < lines.length && /^\s/.test(lines[j]); j++) {
      const error = /^ {2}error: (.*)$/.exec(lines[j]);
      if (!error) continue;
      const value = /^[|>][-+]?$/.test(error[1].trim()) ? (lines[j + 1] ?? '').trim() : error[1].trim().replace(/^(['"])(.*)\1$/, '$2');
      if (value && !reasons.has(name)) reasons.set(name, value);
      break;
    }
  }
  return reasons;
}

/**
 * A reason as it may be shown in a public CI log: the repo folder as `.`, the home folder
 * and any `Users\<name>` or `/home/<name>` as `~`, and at most 200 characters.
 */
export function maskReason(reason: string, folders: { root: string; home: string }): string {
  let text = reason;
  for (const [folder, mark] of [[folders.root, '.'], [folders.home, '~']] as const) {
    if (folder.length < 2) continue;
    for (const form of new Set([folder, folder.replace(/\\/g, '/'), folder.replace(/\\/g, '\\\\')])) text = text.split(form).join(mark);
  }
  text = text.replace(/([\\/])Users([\\/]+)[^\\/\s'"`]+/gi, '$1Users$2~').replace(/\/home\/[^/\s'"`]+/g, '~');
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

/** A reason's kind, for counting: numbers and quoted text taken out, so the same cause groups. */
export function reasonKind(reason: string): string {
  return reason.replace(/(['"`]).*?\1/g, '…').replace(/\d+/g, 'N').slice(0, 120);
}

/** The --out file's text: each entry with its reason above it as a `# why:` comment. */
export function knownText(entries: string[], reasons: Map<string, string>): string {
  const body = entries.flatMap((entry) => (reasons.has(entry) ? [`# why: ${reasons.get(entry)}`, entry] : [entry]));
  return `${[...HEADER, ...body].join('\n')}\n`;
}

/** The reasons counted by kind, most first, as summary lines. */
export function reasonCounts(reasons: Iterable<string>, top = 15): string[] {
  const counts = new Map<string, number>();
  for (const reason of reasons) counts.set(reasonKind(reason), (counts.get(reasonKind(reason)) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, top).map(([kind, n]) => `${String(n).padStart(4)}  ${kind}`);
}

/**
 * One file's entries: each failed test, and the time-out when the file passed its cap. A
 * failure named by the file itself is Node's report of a file that died outside its tests:
 * it is the file's crash.
 */
export function entriesOf(file: string, tap: string, timedOut: boolean): string[] {
  const name = file.replace(/\\/g, '/');
  const tests = readFailures(tap).map((test) => (test.replace(/\\+/g, '/') === name ? CRASHED : test));
  return [...tests.map((test) => `${name} :: ${test}`), ...(timedOut ? [`${name} :: ${TIMED_OUT}`] : [])];
}

/** One run of one test file: its TAP report, its stderr, its exit code, and if it passed its cap. */
export interface FileRun {
  tap: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

/**
 * Whether a run crashed: it did not time out, and either Node reported the file itself as
 * failed (it died outside its tests), or it exited non-zero with no test result at all.
 */
export function isCrash(file: string, run: FileRun): boolean {
  if (run.timedOut) return false;
  const name = file.replace(/\\/g, '/');
  if (readFailures(run.tap).some((test) => test.replace(/\\+/g, '/') === name)) return true;
  return run.code !== 0 && !/^(?:not )?ok \d+ - /m.test(run.tap);
}

/**
 * Run a file, and once more when the first run crashed. `first` is the crashed run, kept for
 * its stderr; `isFlaky` is true when the second run neither crashed nor timed out. A crash is never hidden:
 * the caller prints both runs.
 */
export async function runWithRetry(file: string, run: (file: string) => Promise<FileRun>): Promise<{ last: FileRun; first?: FileRun; isFlaky: boolean }> {
  const once = await run(file);
  if (!isCrash(file, once)) return { last: once, isFlaky: false };
  const again = await run(file);
  return { last: again, first: once, isFlaky: !again.timedOut && !isCrash(file, again) };
}

/**
 * What a crashed run said, for the log: the last lines of its stderr and of the TAP comments
 * (Node puts a test file's own stderr there), with the folders hidden as in the reasons.
 */
export function crashLines(run: FileRun, folders: { root: string; home: string }, max = 20): string[] {
  const summary = /^# (?:Subtest|tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\b/;
  const comments = run.tap.split(/\r?\n/).filter((line) => line.startsWith('# ') && !summary.test(line)).map((line) => line.slice(2));
  const stderr = run.stderr.split(/\r?\n/).filter((line) => line.trim() !== '');
  const lines = [...comments, ...stderr].slice(-max).map((line) => maskReason(line, folders));
  return lines.length ? lines.map((line) => `      | ${line}`) : ['      | (no stderr and no output)'];
}

/** The list's entries for files that do not run on this system: stale waivers, to remove. */
export function staleKnown(known: { required: string[]; flaky: string[] }, skipped: string[]): string[] {
  const out = new Set(skipped.map((file) => file.replace(/\\/g, '/')));
  return [...known.required, ...known.flaky].filter((entry) => out.has(entry.split(' :: ')[0]));
}

/** The list file's entries: required ones, and `? ` ones that may pass. */
export function readKnown(text: string): { required: string[]; flaky: string[] } {
  const required: string[] = [];
  const flaky: string[] = [];
  for (const line of text.split(/\r?\n/).map((l) => l.trim())) {
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('? ')) flaky.push(line.slice(2));
    else required.push(line);
  }
  return { required, flaky };
}

/** New failures (not on the list) and fixed ones (on the list, now passing). Both fail the job. */
export function judgeKnown(failures: string[], known: { required: string[]; flaky: string[] }): { added: string[]; fixed: string[] } {
  const failing = new Set(failures);
  const listed = new Set([...known.required, ...known.flaky]);
  return {
    added: failures.filter((f) => !listed.has(f)),
    fixed: known.required.filter((k) => !failing.has(k)),
  };
}

/**
 * One file's line in the log, so a reader tells a waived failure from a new one at a glance
 * (owner 2026-10-25: "目前的CI，看不出哪些是waiver"):
 *   ok      every test passed
 *   waived  it failed, and every failure is on the list (a waiver)
 *   NEW     a failure that is not on the list: this fails the job
 *   FIXED   a listed failure passes now: this fails the job too, until its line goes
 */
export function fileLine(file: string, found: string[], known: { required: string[]; flaky: string[] }, seconds: number): string {
  const name = file.replace(/\\/g, '/');
  const { added, fixed } = judgeKnown(found, knownFor(known, [name]));
  const waived = found.length - added.length;
  const parts = [`${seconds} s`];
  if (added.length) parts.push(`${added.length} new: ${added.map((entry) => entry.split(' :: ')[1]).join('; ')}`);
  if (fixed.length) parts.push(`${fixed.length} on the list ${fixed.length === 1 ? 'passes' : 'pass'} now`);
  if (waived) parts.push(`${waived} waived`);
  const word = added.length ? 'NEW' : fixed.length ? 'FIXED' : found.length ? 'waived' : 'ok';
  return `${word.padEnd(7)} ${name} (${parts.join(', ')})`;
}

/** Every `*.test.ts` under test/, from the repo root, sorted. */
export function testFiles(dir = join(ROOT, 'test')): string[] {
  return readdirSync(dir)
    .flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? testFiles(path) : name.endsWith('.test.ts') ? [relative(ROOT, path)] : [];
    })
    .sort();
}

/**
 * Shard `index` of `count` (from 1): files dealt by weight (seconds), heaviest first, each
 * to the shard with the least so far, so the shards take about the same time. Each shard's
 * files come heaviest first, so the long ones start at once. Every file is in exactly one shard.
 */
export function shardOf(files: { name: string; weight: number }[], index: number, count: number): string[] {
  const shards = Array.from({ length: count }, () => ({ weight: 0, names: [] as string[] }));
  const byWeight = [...files].sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name));
  for (const file of byWeight) {
    const least = shards.reduce((min, shard) => (shard.weight < min.weight ? shard : min));
    least.weight += file.weight;
    least.names.push(file.name);
  }
  return shards[index - 1]?.names ?? [];
}

/** The times file: `<seconds> <test file>` per line; `#` lines are comments. */
export function readTimes(text: string): Map<string, number> {
  const times = new Map<string, number>();
  for (const line of text.split(/\r?\n/)) {
    const entry = /^(\d+(?:\.\d+)?) +(\S+)$/.exec(line.trim());
    if (entry) times.set(entry[2], Number(entry[1]));
  }
  return times;
}

/** Each file's weight: its last time, or the median of the known times for a new file (1 with none). */
export function weightsOf(files: string[], times: Map<string, number>): { name: string; weight: number }[] {
  const known = [...times.values()].sort((a, b) => a - b);
  const median = known.length ? known[Math.floor(known.length / 2)] : 1;
  return files.map((name) => ({ name, weight: times.get(name.replace(/\\/g, '/')) ?? median }));
}

/** The list's entries whose test file this run covered: a shard judges only its own files. */
export function knownFor(known: { required: string[]; flaky: string[] }, files: string[]): { required: string[]; flaky: string[] } {
  const ran = new Set(files.map((file) => file.replace(/\\/g, '/')));
  const covered = (entry: string) => ran.has(entry.split(' :: ')[0]);
  return { required: known.required.filter(covered), flaky: known.flaky.filter(covered) };
}

/** Run one test file with a cap; a file past it is killed with its children. */
function runFile(file: string, capMs: number): Promise<FileRun> {
  return new Promise((done) => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    // stderr is kept: a file that crashes in 0 s says why only there (issue #1068).
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap', file], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let tap = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (chunk: Buffer) => (tap += chunk));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      // The test files start git and node children of their own: stop the whole tree.
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
      else child.kill('SIGKILL');
    }, capMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ tap, stderr, code, timedOut });
    });
  });
}

/** The skipped areas with their reasons, as the log's heading. */
export function skippedHeading(platform: Platform, skipped: { area: string; reason: string }[]): string[] {
  return skipped.length ? [`Skipped on ${platform}, by area:`, ...skippedLines(skipped).map((line) => `  ${line}`)] : [`Nothing is skipped on ${platform}.`];
}

/** What `--list` prints: the skipped areas, each skipped file, then each file that would run. */
export function listLines(platform: Platform, shard: string, files: string[], skipped: { file: string; area: string; reason: string }[]): string[] {
  const lines = [`windows-known --list: ${platform}, shard ${shard}, ${files.length} files run, ${skipped.length} skipped.`, ...skippedHeading(platform, skipped)];
  for (const { file, area } of skipped) lines.push(`  skip  ${file} (${area})`);
  for (const file of files) lines.push(`  run   ${file.replace(/\\/g, '/')}`);
  return lines;
}

const HELP = `Run the test suite as the Windows job does: each file on its own, judged against
scripts/time/windows-known.txt. Areas this system does not support are skipped, with the reason
(TEST_AREAS in scripts/time/windows-known.ts). A file that crashes runs once more; if it then gets through,
it is named as flaky.

  --list               print the skipped areas and the files that would run; run nothing
  --platform <name>    judge as linux, darwin or win32 (default: this system)
  --shard <i>/<n>      this machine's share of the files (default 1/1)
  --cap <seconds>      time cap per file (default 240)
  --jobs <n>           files at once (default 4)
  --out <file>         write this run's failures in the list's form
  --times <file>       write this run's seconds per file
`;

async function main(): Promise<number> {
  const options = {
    out: { type: 'string' },
    cap: { type: 'string', default: '240' },
    jobs: { type: 'string', default: '4' },
    shard: { type: 'string', default: '1/1' },
    times: { type: 'string' },
    platform: { type: 'string', default: process.platform },
    list: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  } as const;
  const { values } = parseArgs({ options });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const platform: Platform = platformOf(values.platform);
  const [index, count] = values.shard.split('/').map(Number);
  if (!(count >= 1 && index >= 1 && index <= count)) throw new Error(`--shard takes <index>/<count>, such as 2/3, not ${values.shard}`);
  let times = new Map<string, number>();
  try {
    times = readTimes(readFileSync(TIMES_FILE, 'utf8'));
  } catch {
    // No times yet: every file weighs the same, and the shards still cover every file once.
  }
  const scope = scopeFor(testFiles(), platform);
  const skippedHead = skippedHeading(platform, scope.skipped);
  const files = shardOf(weightsOf(scope.run, times), index, count);
  if (values.list) {
    process.stdout.write(`${listLines(platform, `${index}/${count}`, files, scope.skipped).join('\n')}\n`);
    return 0;
  }
  process.stdout.write(`${skippedHead.join('\n')}\n`);
  const took: string[] = [];
  const failures: string[] = [];
  const flakyFiles: string[] = [];
  const reasons = new Map<string, string>();
  const folders = { root: ROOT, home: homedir() };
  const known = readKnown(readFileSync(KNOWN_FILE, 'utf8'));
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const file = files[next++];
      const name = file.replace(/\\/g, '/');
      const started = Date.now();
      const { last, first, isFlaky } = await runWithRetry(file, (path) => runFile(path, Number(values.cap) * 1000));
      const { tap, timedOut } = last;
      if (first) {
        // Never hidden: the crash's own words, and whether the second run got through.
        if (isFlaky) flakyFiles.push(name);
        const said = [`${isFlaky ? 'FLAKY  ' : 'CRASHED'} ${name}: crashed, ran once more, ${isFlaky ? 'and the second run did not crash (its test results count as usual)' : 'and the second run crashed or timed out'}. The first run said:`, ...crashLines(first, folders)];
        if (!isFlaky) said.push('    The second run said:', ...crashLines(last, folders));
        process.stdout.write(`${said.join('\n')}\n`);
      }
      const found = entriesOf(file, tap, timedOut);
      failures.push(...found);
      took.push(`${Math.max(1, Math.round((Date.now() - started) / 1000))} ${name}`);
      for (const [test, reason] of readReasons(tap)) reasons.set(`${name} :: ${test}`, maskReason(reason, folders));
      process.stdout.write(`${fileLine(file, found, known, Math.round((Date.now() - started) / 1000))}\n`);
    }
  };
  await Promise.all(Array.from({ length: Number(values.jobs) }, worker));
  failures.sort();
  if (values.out) writeFileSync(values.out, knownText(failures, reasons));
  if (values.times) writeFileSync(values.times, `${took.sort((a, b) => a.split(' ')[1].localeCompare(b.split(' ')[1])).join('\n')}\n`);
  const { added, fixed } = judgeKnown(failures, knownFor(known, files));
  const stale = staleKnown(known, scope.skipped.map((entry) => entry.file));
  const lines = [`windows-known: ${platform}, shard ${index}/${count}, ${files.length} files, ${failures.length} failing (${failures.length - added.length} waived), ${added.length} new, ${fixed.length} fixed, ${flakyFiles.length} flaky, ${scope.skipped.length} skipped.`, ...skippedHead];
  if (flakyFiles.length) lines.push('Flaky: these crashed, then got through their second run. The job goes on; each crash is in the log above:', ...flakyFiles.sort().map((file) => `  ${file}`));
  if (reasons.size) lines.push('Failures by reason (first line of the error):', ...reasonCounts(reasons.values()));
  if (added.length) lines.push('New failures on Windows. Fix them, or skip a test that cannot run there on win32, with the reason:', ...added.map((a) => `  ${a}${reasons.has(a) ? `\n      why: ${reasons.get(a)}` : ''}`));
  if (fixed.length) lines.push('These pass now. Remove their lines from scripts/time/windows-known.txt:', ...fixed.map((f) => `  ${f}`));
  if (stale.length) lines.push(`These test files do not run on ${platform}, so their waivers are stale. Remove their lines from scripts/time/windows-known.txt:`, ...stale.map((f) => `  ${f}`));
  process.stdout.write(`${lines.join('\n')}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Windows known failures\n\n${lines.join('\n')}\n`);
  return added.length || fixed.length || stale.length ? 1 : 0;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) process.exitCode = await main();
