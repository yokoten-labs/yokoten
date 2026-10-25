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
//
// An entry is `<test file> :: <test name>`, the file from `test/` on with `/`. A file that
// passed its cap is `<test file> :: (timed out)`. To write the list from a run, copy its
// `--out` file over scripts/time/windows-known.txt.
import { spawn } from 'node:child_process';
import { appendFileSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
  const { values } = parseArgs({ options: { out: { type: 'string' }, cap: { type: 'string', default: '240' }, jobs: { type: 'string', default: '4' } } });
  const files = testFiles();
  const failures: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const file = files[next++];
      const started = Date.now();
      const { tap, timedOut } = await runFile(file, Number(values.cap) * 1000);
      const found = entriesOf(file, tap, timedOut);
      failures.push(...found);
      process.stdout.write(`${found.length ? 'fail' : 'ok  '} ${file.replace(/\\/g, '/')} (${Math.round((Date.now() - started) / 1000)} s${found.length ? `, ${found.length} failing` : ''})\n`);
    }
  };
  await Promise.all(Array.from({ length: Number(values.jobs) }, worker));
  failures.sort();
  if (values.out) writeFileSync(values.out, `${[...HEADER, ...failures].join('\n')}\n`);
  const { added, fixed } = judgeKnown(failures, readKnown(readFileSync(KNOWN_FILE, 'utf8')));
  const lines = [`windows-known: ${files.length} files, ${failures.length} failing, ${added.length} new, ${fixed.length} fixed.`];
  if (added.length) lines.push('New failures on Windows. Fix them, or skip a test that cannot run there on win32, with the reason:', ...added.map((a) => `  ${a}`));
  if (fixed.length) lines.push('These pass now. Remove their lines from scripts/time/windows-known.txt:', ...fixed.map((f) => `  ${f}`));
  process.stdout.write(`${lines.join('\n')}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Windows known failures\n\n${lines.join('\n')}\n`);
  return added.length || fixed.length ? 1 : 0;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) process.exitCode = await main();
