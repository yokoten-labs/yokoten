// The suite's time budget (#475, #783). The test job writes a TAP copy of node --test's
// report to a file; this reads how long the run took and its slowest tests, adds them to
// the job summary, and exits 1 when the run took longer than the budget plus the room a
// busy runner needs.
//
//   node scripts/time/suite.ts <tap file>                against the budget, 180 s
//   node scripts/time/suite.ts <tap file> --budget 90    another budget, in seconds
//   node scripts/time/suite.ts <tap file> --warn-only    over the budget warns, exit 0
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
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/** The budget of one CI shard, in seconds, on a quiet runner. */
export const SUITE_BUDGET = 180;

/** How much longer the same work may take on a busy runner before the run fails. */
export const LOAD_ROOM = 1.5;

/** How many of the slowest tests the summary names. */
const SLOWEST = 5;

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
  const { values: options, positionals } = parseArgs({ allowPositionals: true, options: { budget: { type: 'string', default: String(SUITE_BUDGET) }, 'warn-only': { type: 'boolean', default: false } } });
  const budget = Number(options.budget);
  try {
    if (positionals.length !== 1) throw new Error('give it one file: the TAP report of node --test');
    if (!(budget > 0)) throw new Error(`--budget needs a number of seconds above 0, not ${options.budget}`);
    const { isOver, text } = judgeSuite(readFileSync(positionals[0], 'utf8'), budget);
    const { code, warning } = verdictOf(isOver, options['warn-only']);
    process.stdout.write(text);
    if (warning) process.stdout.write(`${warning}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Test time\n\n${text}`);
    process.exitCode = code;
  } catch (err) {
    process.stderr.write(`yokoten suite time: ${(err as Error).message}\n`);
    process.exitCode = 1;
  }
}
