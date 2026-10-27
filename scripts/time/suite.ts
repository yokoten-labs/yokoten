// The suite's time budget (#475, #783). The test job writes a TAP copy of node --test's
// report to a file; this reads how long the run took and its slowest tests, adds them to
// the job summary, and exits 1 when the run took longer than the budget plus the room a
// busy runner needs.
//
//   node scripts/time/suite.ts <tap file>                against the budget, 180 s
//   node scripts/time/suite.ts <tap file> --budget 90    another budget, in seconds
//   node scripts/time/suite.ts <tap file> --warn-only    over the budget warns, exit 0
//   node scripts/time/suite.ts --files <file>           each file against TEST_LIMITS
//
// The --files report comes from this module as a test reporter (its default export):
// node --test --test-reporter=./scripts/time/suite.ts --test-reporter-destination=<file>
//
// The budget is for one CI shard on a quiet runner: a third of the test files, four at a
// time. A shared runner is sometimes busy, and the same work then takes longer: 365 s and
// 302.7 s against 300 s on macOS, twice on 2026-10-23 (#783). So a run may take LOAD_ROOM
// more before it fails. That wall clock is only a backstop. The stable checks count work:
// the child-process cap in test/repo/architecture.test.ts, and the guard's work budget. A
// new child process per test still fails the cap, however much room the clock is given.
//
// --warn-only is for runners whose speed swings past that room: a pull request's macOS jobs,
// where the same tests took 454 s and 629 s on 2026-10-26 (PR #1112). The time and the
// slowest tests still go in the summary, with a warning. The budget fails where the runners
// are steady: Linux, and macOS on main's daily run.
import { appendFileSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/** The budget of one CI shard, in seconds, on a quiet runner. */
export const SUITE_BUDGET = 180;

/** How much longer the same work may take on a busy runner before the run fails. */
export const LOAD_ROOM = 1.5;

/** How many of the slowest tests the summary names. */
const SLOWEST = 5;

/**
 * A limit the tests are held to (record 0051, rule 1). One row per rule, read the same way:
 * what is measured, the limit, why, and where it was decided. The fields leave room for an
 * `expression` that decides, should rules outgrow plain numbers (issue #899).
 */
export type TestLimit = { id: string; what: string; limit: number; unit: 's' | 'runs'; reason: string; source: string };

export const TEST_LIMITS = [
  { id: 'file-seconds', what: "one test file's tests, added up, on a Linux CI shard", limit: 60, unit: 's', reason: 'the slowest file is the shortest a shard can be, and on Windows a file runs alone under its cap: init.test.ts took 240 s there before issue #1109', source: 'issue #1109; record 0051' },
  { id: 'full-runs', what: 'whole doctor or init runs one test file writes, through sandbox.call or sandbox.run', limit: 4, unit: 'runs', reason: 'a whole run costs 50 to 400 ms; a decision is tested by calling its function, and one whole run is kept for each setting the command passes on', source: 'issue #1109; record 0051' },
] as const satisfies readonly TestLimit[];

/** The row of TEST_LIMITS with this id. */
export const limitOf = (id: (typeof TEST_LIMITS)[number]['id']): TestLimit => TEST_LIMITS.find((row) => row.id === id)!;

/** One event of node --test, as a reporter reads it. */
type TestEvent = { type: string; data: { nesting: number; name?: string; file?: string; skip?: unknown; details?: { duration_ms?: number; error?: unknown } } };

/** How many lines of a failing test's error the log shows under it. */
const ERROR_LINES = 20;

/**
 * The test log of every CI test job (#1125): when a file finishes, `[n/N] <file>` and under
 * it, each of its tests lined up under the file name, a failing one with its error indented under it.
 * The whole block prints at once, so a file's tests never mix with another's. `still running`
 * shows once a minute while a file runs past a minute.
 * node --test announces each file as a top-level test named by its path; it announces all of
 * them early, so N is whole by the time the first file finishes.
 */
export function fileProgress() {
  const started = new Map<string, number>();
  const results = new Map<string, { lines: string[]; fails: number }>();
  let total = 0;
  let done = 0;
  const isFile = (data: TestEvent['data']) => data.nesting === 0 && !!data.file && !!data.name && /\.test\.ts$/.test(data.name) && data.file.replace(/\\/g, '/').endsWith(data.name.replace(/\\/g, '/'));
  const seconds = (from: number, now: number) => Math.round((now - from) / 1000);
  const errorLines = (error: unknown): string[] => {
    const cause = (error as { cause?: unknown } | undefined)?.cause ?? error;
    const text = cause instanceof Error ? cause.message : cause === undefined ? '' : String(cause);
    const lines = text.split('\n').filter((line) => line.trim() !== '');
    return [...lines.slice(0, ERROR_LINES), ...(lines.length > ERROR_LINES ? [`… ${lines.length - ERROR_LINES} more lines in the TAP report`] : [])].map((line) => `    ${line}`);
  };
  return {
    /** The lines this event prints, if any. */
    see(event: TestEvent, now: number): string[] {
      const name = (event.data.name ?? '').replace(/\\/g, '/');
      if (!isFile(event.data)) {
        if ((event.type === 'test:pass' || event.type === 'test:fail') && event.data.nesting === 0 && event.data.file) {
          const at = event.data.file.replace(/\\/g, '/');
          const file = [...started.keys()].find((key) => at.endsWith(key));
          if (file === undefined) return [];
          const entry = results.get(file) ?? { lines: [], fails: 0 };
          const isFail = event.type === 'test:fail';
          const mark = isFail ? '✖' : event.data.skip ? '-' : '✔';
          const ms = event.data.details?.duration_ms;
          entry.lines.push(`${mark} ${name}${ms === undefined ? '' : ` (${ms.toFixed(1)} ms)`}`, ...(isFail ? errorLines(event.data.details?.error) : []));
          if (isFail) entry.fails += 1;
          results.set(file, entry);
        }
        return [];
      }
      if (event.type === 'test:enqueue') total += 1;
      if (event.type === 'test:dequeue') started.set(name, now);
      if (event.type !== 'test:complete') return [];
      done += 1;
      const { lines, fails } = results.get(name) ?? { lines: [], fails: 0 };
      const head = `[${done}/${total}] ${name} ${seconds(started.get(name) ?? now, now)} s${fails ? `, ${fails} failing` : ''}`;
      started.delete(name);
      results.delete(name);
      // The tests sit under the file name, with the [n/N] column left blank.
      const pad = ' '.repeat(`[${done}/${total}] `.length);
      return [head, ...lines.map((line) => pad + line)];
    },
    /** One line for each file running a minute or more. */
    slow(now: number): string[] {
      return [...started].filter(([, from]) => now - from >= 60_000).map(([file, from]) => `still running ${file}: ${seconds(from, now)} s`);
    },
  };
}

/** The test reporter behind --files: one JSON line per test file, its top-level tests' time added up. On GitHub Actions it also prints each file's progress. */
export default async function* fileTimes(source: AsyncIterable<TestEvent>): AsyncGenerator<string> {
  const times = new Map<string, number>();
  const progress = process.env.GITHUB_ACTIONS === 'true' ? fileProgress() : null;
  const write = (lines: string[]) => lines.length && process.stdout.write(`${lines.join('\n')}\n`);
  const timer = progress && setInterval(() => write(progress.slow(Date.now())), 60_000).unref();
  try {
    for await (const event of source) {
      if (progress) write(progress.see(event, Date.now()));
      if ((event.type !== 'test:pass' && event.type !== 'test:fail') || event.data.nesting !== 0 || !event.data.file) continue;
      const file = relative(process.cwd(), event.data.file).replace(/\\/g, '/');
      times.set(file, (times.get(file) ?? 0) + (event.data.details?.duration_ms ?? 0));
    }
  } finally {
    if (timer) clearInterval(timer);
  }
  for (const [file, ms] of times) yield `${JSON.stringify({ file, ms: Math.round(ms) })}\n`;
}

/** Each file over the file-seconds limit, slowest first, and the lines for the summary. */
export function judgeFiles(report: string, limit = limitOf('file-seconds')): { isOver: boolean; text: string } {
  const files = report.split('\n').filter(Boolean).map((line) => JSON.parse(line) as { file: string; ms: number }).toSorted((a, b) => b.ms - a.ms);
  const over = files.filter((entry) => entry.ms > limit.limit * 1000);
  const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
  const text = [
    over.length
      ? `${over.length} test file${over.length === 1 ? '' : 's'} took longer than ${limit.limit} s (${limit.id}): split the file, or test its decisions by calling their functions. Why: ${limit.reason}.`
      : `Every test file took ${limit.limit} s or less.`,
    '',
    'The slowest files:',
    ...files.slice(0, SLOWEST).map((entry) => `- ${seconds(entry.ms)}: ${entry.file}${entry.ms > limit.limit * 1000 ? ' (over)' : ''}`),
  ].join('\n');
  return { isOver: over.length > 0, text: `${text}\n` };
}

/** The run's duration and each top-level test's, in ms, from a TAP report of node --test. */
export function readReport(tap: string): { ms: number; tests: { name: string; ms: number }[] } {
  const lines = tap.split('\n');
  const tests: { name: string; ms: number }[] = [];
  let ms: number | undefined;
  lines.forEach((line, index) => {
    const total = /^# duration_ms ([\d.]+)$/.exec(line);
    if (total) ms = Number(total[1]);
    const result = /^(?:not )?ok \d+ - (.*?)(?: # (?:SKIP|TODO)\b.*)?$/.exec(line);
    if (!result || lines[index + 1] !== '  ---') return;
    for (let at = index + 2; at < lines.length && lines[at] !== '  ...'; at++) {
      const own = /^ {2}duration_ms: ([\d.]+)$/.exec(lines[at]);
      if (own) tests.push({ name: result[1].replace(/\\(.)/g, '$1'), ms: Number(own[1]) });
    }
  });
  if (ms === undefined) throw new Error("the report has no '# duration_ms' line: write it with --test-reporter=tap --test-reporter-destination=<file>, and let the run finish");
  return { ms, tests };
}

/** Whether the run in `tap` is over `budget` seconds, and the summary to print. */
export function judgeSuite(tap: string, budget = SUITE_BUDGET): { isOver: boolean; text: string } {
  const { ms, tests } = readReport(tap);
  const seconds = (value: number) => `${(value / 1000).toFixed(1)} s`;
  const isOver = ms > budget * 1000 * LOAD_ROOM;
  const room = Math.round((LOAD_ROOM - 1) * 100);
  const slowest = tests.toSorted((a, b) => b.ms - a.ms).slice(0, SLOWEST);
  const text = [
    isOver
      ? `The tests took ${seconds(ms)}, over the budget of ${budget} s by ${seconds(ms - budget * 1000)}, past the room a busy runner needs (${room}%). Find what made them slow: most often a new child process per test (use sandbox.call), or a large stress input.`
      : ms > budget * 1000
        ? `The tests took ${seconds(ms)}, over the budget of ${budget} s by ${seconds(ms - budget * 1000)}, inside the room a busy runner needs (${room}%).`
        : `The tests took ${seconds(ms)}, under the budget of ${budget} s.`,
    ...(slowest.length ? ['', 'The slowest tests:', ...slowest.map((test) => `- ${seconds(test.ms)}: ${test.name}`)] : []),
  ].join('\n');
  return { isOver, text: `${text}\n` };
}

/** The exit code, and the warning for the log when a run over the budget only warns. */
export function verdictOf(isOver: boolean, warnOnly: boolean): { code: number; warning?: string } {
  if (!isOver) return { code: 0 };
  if (!warnOnly) return { code: 1 };
  return { code: 0, warning: "::warning title=Test time::The tests took longer than the budget and its room for a busy runner. This job only warns; the budget fails on Linux and on main's daily macOS run." };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values: options, positionals } = parseArgs({ allowPositionals: true, options: { budget: { type: 'string', default: String(SUITE_BUDGET) }, 'warn-only': { type: 'boolean', default: false }, files: { type: 'string' } } });
  const budget = Number(options.budget);
  try {
    // --files alone is the per-file check, in its own step on the runners whose speed is steady.
    const isFilesOnly = options.files !== undefined && positionals.length === 0;
    if (options.files !== undefined && positionals.length > 0) throw new Error('give --files on its own, without the TAP report');
    if (!isFilesOnly && positionals.length !== 1) throw new Error('give it one file: the TAP report of node --test, or only --files <file>');
    if (!(budget > 0)) throw new Error(`--budget needs a number of seconds above 0, not ${options.budget}`);
    const { isOver, text } = isFilesOnly ? judgeFiles(readFileSync(options.files!, 'utf8')) : judgeSuite(readFileSync(positionals[0], 'utf8'), budget);
    const { code, warning } = isFilesOnly ? { code: isOver ? 1 : 0, warning: undefined } : verdictOf(isOver, options['warn-only']);
    process.stdout.write(text);
    if (warning) process.stdout.write(`${warning}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${isFilesOnly ? 'Test file time' : 'Test time'}\n\n${text}`);
    process.exitCode = code;
  } catch (err) {
    process.stderr.write(`yokoten suite time: ${(err as Error).message}\n`);
    process.exitCode = 1;
  }
}
