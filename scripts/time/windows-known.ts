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
//
// Speed (owner 2026-10-25: a fast answer is worth more, even a failing one): the job runs on
// several machines at once, each with a share of the files by size, and each machine starts
// with its biggest files, so no long file is left to run alone at the end.
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
export const TIMED_OUT = '(timed out)';

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

/** One file's entries: each failed test, and the time-out when the file passed its cap. */
export function entriesOf(file: string, tap: string, timedOut: boolean): string[] {
  const name = file.replace(/\\/g, '/');
  return [...readFailures(tap).map((test) => `${name} :: ${test}`), ...(timedOut ? [`${name} :: ${TIMED_OUT}`] : [])];
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

/** Every `*.test.ts` under test/, from the repo root, sorted. */
function testFiles(dir = join(ROOT, 'test')): string[] {
  return readdirSync(dir)
    .flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? testFiles(path) : name.endsWith('.test.ts') ? [relative(ROOT, path)] : [];
    })
    .sort();
}

/**
 * Shard `index` of `count` (from 1): files dealt by size, biggest first, each to the shard
 * with the least so far, so the shards take about the same time. Each shard's files come
 * biggest first, so the long ones start at once. Every file is in exactly one shard.
 */
export function shardOf(files: { name: string; size: number }[], index: number, count: number): string[] {
  const shards = Array.from({ length: count }, () => ({ size: 0, names: [] as string[] }));
  const bySize = [...files].sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));
  for (const file of bySize) {
    const least = shards.reduce((min, shard) => (shard.size < min.size ? shard : min));
    least.size += file.size;
    least.names.push(file.name);
  }
  return shards[index - 1]?.names ?? [];
}

/** The list's entries whose test file this run covered: a shard judges only its own files. */
export function knownFor(known: { required: string[]; flaky: string[] }, files: string[]): { required: string[]; flaky: string[] } {
  const ran = new Set(files.map((file) => file.replace(/\\/g, '/')));
  const covered = (entry: string) => ran.has(entry.split(' :: ')[0]);
  return { required: known.required.filter(covered), flaky: known.flaky.filter(covered) };
}

/** Run one test file with a cap; a file past it is killed with its children. */
function runFile(file: string, capMs: number): Promise<{ tap: string; timedOut: boolean }> {
  return new Promise((done) => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap', file], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let tap = '';
    let timedOut = false;
    child.stdout.on('data', (chunk: Buffer) => (tap += chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      // The test files start git and node children of their own: stop the whole tree.
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
      else child.kill('SIGKILL');
    }, capMs);
    child.on('close', () => {
      clearTimeout(timer);
      done({ tap, timedOut });
    });
  });
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { out: { type: 'string' }, cap: { type: 'string', default: '240' }, jobs: { type: 'string', default: '4' }, shard: { type: 'string', default: '1/1' } } });
  const [index, count] = values.shard.split('/').map(Number);
  if (!(count >= 1 && index >= 1 && index <= count)) throw new Error(`--shard takes <index>/<count>, such as 2/3, not ${values.shard}`);
  const files = shardOf(testFiles().map((name) => ({ name, size: statSync(join(ROOT, name)).size })), index, count);
  const failures: string[] = [];
  const reasons = new Map<string, string>();
  const folders = { root: ROOT, home: homedir() };
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const file = files[next++];
      const started = Date.now();
      const { tap, timedOut } = await runFile(file, Number(values.cap) * 1000);
      const found = entriesOf(file, tap, timedOut);
      failures.push(...found);
      const name = file.replace(/\\/g, '/');
      for (const [test, reason] of readReasons(tap)) reasons.set(`${name} :: ${test}`, maskReason(reason, folders));
      process.stdout.write(`${found.length ? 'fail' : 'ok  '} ${file.replace(/\\/g, '/')} (${Math.round((Date.now() - started) / 1000)} s${found.length ? `, ${found.length} failing` : ''})\n`);
    }
  };
  await Promise.all(Array.from({ length: Number(values.jobs) }, worker));
  failures.sort();
  if (values.out) writeFileSync(values.out, knownText(failures, reasons));
  const { added, fixed } = judgeKnown(failures, knownFor(readKnown(readFileSync(KNOWN_FILE, 'utf8')), files));
  const lines = [`windows-known: shard ${index}/${count}, ${files.length} files, ${failures.length} failing, ${added.length} new, ${fixed.length} fixed.`];
  if (reasons.size) lines.push('Failures by reason (first line of the error):', ...reasonCounts(reasons.values()));
  if (added.length) lines.push('New failures on Windows. Fix them, or skip a test that cannot run there on win32, with the reason:', ...added.map((a) => `  ${a}${reasons.has(a) ? `\n      why: ${reasons.get(a)}` : ''}`));
  if (fixed.length) lines.push('These pass now. Remove their lines from scripts/time/windows-known.txt:', ...fixed.map((f) => `  ${f}`));
  process.stdout.write(`${lines.join('\n')}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Windows known failures\n\n${lines.join('\n')}\n`);
  return added.length || fixed.length ? 1 : 0;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) process.exitCode = await main();
