// Runs a yokoten command in this process, as `node bin/yokoten.ts <words>` would, but with
// no child process (#475): a child strips the types of every file it loads again, and costs
// far more than the command. The command gets its words, env, folder and stdin from the
// caller, and writes to two buffers. Keep one or two real child-process tests per command for the entry.
//
// No state crosses from one call to the next: the env is a copy, and a call that changes
// process.exitCode or the process's folder fails, since the next call would inherit it.
//
// Every render is checked (#1115): after main() returns, the text a person reads goes
// through screenProblems, the rules of record 0049. A screen built before the layout kit
// that still breaks a rule is on RENDER_WAIVED, keyed by its command and flags; the list
// only shrinks. With RENDER_REPORT set to a file, each render's problems are written there
// as JSON lines instead, and nothing is asserted: the way the first list was measured.

import './home.ts';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { main } from '../../bin/main.ts';
import type { Env } from '../../src/rules/config.ts';
import { screenProblems, type ScreenRuleId } from './docs/screen-rules.ts';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'yokoten.ts');

/** What a command did: its exit code and everything it wrote. */
export interface Invoked {
  code: number;
  stdout: string;
  stderr: string;
  /** Both streams in the order they were written, as a terminal shows them (#1115). */
  output: string;
}

/** A stream that keeps what is written to it, and adds it to `both` too. */
function collect(both: string[]): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    decodeStrings: false,
    write(chunk: string | Buffer, _, done) {
      chunks.push(String(chunk));
      both.push(String(chunk));
      done();
    },
  });
  return { stream, text: () => chunks.join('') };
}

// ---- Every render, checked (#1115) ----

/** A screen built before the layout kit that still breaks a rule: the rules it may break, and why. */
export interface RenderWaiver {
  rules: readonly ScreenRuleId[];
  reason: string;
}

/** How many keys RENDER_WAIVED may hold. Only the integrator changes it, and only down. */
export const RENDER_WAIVED_MOST = 19;

/**
 * Old screens that break a rule today, keyed by renderKey (`<command> <sorted flags>`). The
 * list only shrinks, and a new screen is never waived. A render may break only the rules its
 * key lists. Whether a key healed is read over the whole suite (healedWaivers): run
 * `RENDER_REPORT=<file> nice npm test`, then `node test/repo/invoke.ts <file>`.
 */
export const RENDER_WAIVED: Record<string, RenderWaiver> = {
  'check': { rules: ['width', 'widest', 'fix-line'], reason: 'test/commands/more/check.test.ts renders rows over 80 and 100 columns (width, widest) and a Fix inside the problem text (fix-line); test/run/check.test.ts the fix-line too (#1115)' },
  'check --all --pr': { rules: ['width', 'widest', 'fix-line'], reason: 'test/commands/more/check.test.ts renders rows over 80 and 100 columns and a Fix inside the text; the bot tests the fix-line too; breaks width, widest, fix-line (#1115)' },
  'check --history': { rules: ['widest', 'fix-line'], reason: 'test/run/check.test.ts renders a row over 100 columns (widest) and a Fix inside the text (fix-line) (#1115)' },
  'check --pr': { rules: ['width', 'widest', 'fix-line'], reason: 'test/run/check.test.ts renders rows over 80 and 100 columns and a Fix inside the text; breaks width, widest, fix-line (#1115)' },
  'check --staged': { rules: ['fix-line'], reason: 'test/run/check.test.ts renders a Fix inside the text (fix-line) (#1115)' },
  'doctor --agent --session': { rules: ['width', 'widest', 'spaced-items'], reason: 'the Muse runtime test renders rows over 80 columns and the doctor tests over 100 (width, widest); test/commands/hook.test.ts a wrapped item touching the next (spaced-items) (#1115)' },
  'doctor --all': { rules: ['width', 'widest', 'next-step', 'fix-line'], reason: 'the agent runtime, doctor, start and cli tests render rows over 100 columns (widest) and a Fix inside the text (fix-line); width and next-step were not seen in the files run on 2026-10-28, so the full report decides them (#1115)' },
  'doctor --session': { rules: ['width', 'widest', 'spaced-items', 'no-internal-path'], reason: 'test/commands/hook.test.ts renders a wrapped item touching the next (spaced-items); width, widest and no-internal-path were not seen in the files run on 2026-10-28, so the full report decides them (#1115)' },
  'hook': { rules: ['width', 'widest', 'spaced-items', 'no-internal-path'], reason: 'test/commands/hook.test.ts renders rows over 80 and 100 columns and a path of this machine (no-internal-path); test/run/hook.test.ts a wrapped item touching the next (spaced-items); breaks width, widest, spaced-items, no-internal-path (#1115)' },
  'hook --agent': { rules: ['width', 'widest', 'no-internal-path'], reason: 'test/commands/hook.test.ts renders rows over 80 and 100 columns and a path of this machine; the Codex and OpenCode tests rows over 100 columns; breaks width, widest, no-internal-path (#1115)' },
  'hook --agent --commands-only': { rules: ['width', 'widest', 'next-step', 'spaced-items', 'no-internal-path'], reason: 'test/commands/hook.test.ts renders rows over 80 and 100 columns, no Next line, a wrapped item touching the next and a path of this machine; breaks width, widest, next-step, spaced-items, no-internal-path (#1115)' },
  'hook --agent --stop': { rules: ['next-step'], reason: 'test/commands/hook.test.ts and the msg tests render a Stop answer with no Next line (next-step) (#1115)' },
  'hook --stop': { rules: ['next-step'], reason: 'test/commands/hook.test.ts and the msg tests render a Stop answer with no Next line (next-step) (#1115)' },
  'learn --export': { rules: ['width', 'widest', 'spaced-items'], reason: 'test/commands/more/learn.test.ts renders rows over 80 and 100 columns and wrapped items touching; breaks width, widest, spaced-items (#1115)' },
  'learn --import': { rules: ['width', 'widest', 'prose'], reason: 'test/commands/more/learn.test.ts renders rows over 80 and 100 columns and lines of prose; breaks width, widest, prose (#1115)' },
  'msg': { rules: ['width'], reason: 'test/commands/more/advice/messages.test.ts renders a row over 80 columns; breaks width (#1115)' },
  'tidy': { rules: ['width', 'widest', 'no-internal-path'], reason: 'test/commands/tidy/tidy.test.ts renders rows over 80 and 100 columns and a path of this machine; breaks width, widest, no-internal-path (#1115)' },
  'tidy --empty': { rules: ['spaced-items'], reason: 'test/commands/tidy/tidy.test.ts renders a wrapped item touching the next; breaks spaced-items (#1115)' },
  'tidy --local': { rules: ['width', 'widest', 'no-internal-path'], reason: 'test/commands/tidy/tidy.test.ts renders rows over 80 and 100 columns and a path of this machine; breaks width, widest, no-internal-path (#1115)' },
};

/** The key of a render: the command, then its flags sorted, values and words after `--` left out. */
export function renderKey(words: readonly string[]): string {
  const [command = '', ...args] = words;
  const end = args.indexOf('--');
  const flags = (end === -1 ? args : args.slice(0, end)).filter((word) => /^-[^-]|^--./.test(word)).map((word) => word.replace(/=.*$/, ''));
  return [command || '(none)', ...[...new Set(flags)].sort()].join(' ');
}

/**
 * The text a person reads from one render, or null when no person reads it: `--json` is for a
 * program, redact passes a stream through, and `bot … -- <command>` prints the child's own
 * output. For hook only stderr is read: stdout is the JSON answer to the agent.
 */
export function readText(words: readonly string[], done: Pick<Invoked, 'stdout' | 'stderr' | 'output'>): string | null {
  const [command] = words;
  if (words.includes('--json') || command === 'redact' || (command === 'bot' && words.includes('--'))) return null;
  return command === 'hook' ? done.stderr : done.output;
}

/** The rule ids a problem sentence of screenProblems ends with. */
const ruleOf = (problem: string): string => /\[([a-z-]+)\]$/.exec(problem)?.[1] ?? problem;

/**
 * What is wrong with one render, as sentences; none when it keeps the rules or its waiver
 * covers it. A colour code on a terminal is what the person sees, so on a terminal the codes go.
 */
export function renderProblems(words: readonly string[], done: Pick<Invoked, 'code' | 'stdout' | 'stderr' | 'output'>, { isTTY = false, waived = RENDER_WAIVED }: { isTTY?: boolean; waived?: Record<string, RenderWaiver> } = {}): string[] {
  const read = readText(words, done);
  if (read === null || read.trim() === '') return [];
  const text = isTTY ? read.replace(/\u001b\[[0-9;]*m/g, '') : read;
  const [command] = words;
  const problems = screenProblems({ text, isFailure: done.code !== 0, isHelp: words.includes('--help') || command === 'help' });
  const key = renderKey(words);
  const allowed: readonly string[] = waived[key]?.rules ?? [];
  return problems.filter((problem) => !allowed.includes(ruleOf(problem)));
}

/** One line of a RENDER_REPORT file: a render's key, its test file, and the rules it broke. */
export interface ReportedRender {
  key: string;
  file: string;
  checked: boolean;
  rules: string[];
}

/**
 * What RENDER_WAIVED should lose, judged on a report of the whole suite: a key no render
 * broke any listed rule of ("take it off"), and a listed rule no render of its key broke.
 * One key covers renders in many test files, some of which pass, so healing is read over
 * every render at once, never one render at a time (#1115).
 */
export function healedWaivers(report: readonly ReportedRender[], waived: Record<string, RenderWaiver> = RENDER_WAIVED): string[] {
  const healed: string[] = [];
  for (const [key, waiver] of Object.entries(waived)) {
    const broken = new Set(report.filter((render) => render.key === key).flatMap((render) => render.rules));
    const kept = waiver.rules.filter((rule) => !broken.has(rule));
    if (kept.length === waiver.rules.length) healed.push(`${key}: it keeps ${waiver.rules.join(", ")} now; take it off RENDER_WAIVED`);
    else if (kept.length) healed.push(`${key}: it keeps ${kept.join(", ")} now; take ${kept.length === 1 ? "that rule" : "those rules"} off its waiver`);
  }
  return healed;
}

/** With RENDER_REPORT set, each render's key and broken rules go to that file, and nothing is asserted. */
const REPORT_FILE = process.env.RENDER_REPORT;

/**
 * Run `yokoten <words>` in this process, in `cwd`, with `env` as the whole environment and
 * `stdin` as all of its standard input (none by default): never the test runner's own. The
 * system is this one, as bin/main.ts passes it, so a Windows-only step runs here too (#1109).
 */
export async function invoke(words: string[], { env, cwd, stdin = '', isTTY }: { env: Env; cwd: string; stdin?: string; isTTY?: boolean }): Promise<Invoked> {
  const [command, ...args] = words;
  const both: string[] = [];
  const stdout = collect(both);
  const stderr = collect(both);
  const input = Readable.from([stdin], { objectMode: false });
  if (isTTY !== undefined) {
    (stdout.stream as typeof stdout.stream & { isTTY?: boolean }).isTTY = isTTY;
    (stderr.stream as typeof stderr.stream & { isTTY?: boolean }).isTTY = isTTY;
    (input as typeof input & { isTTY?: boolean }).isTTY = isTTY;
  }
  const exitCode = process.exitCode;
  const folder = process.cwd();
  const code = await main({ command, args, env: { ...env }, cwd, stdout: stdout.stream, stderr: stderr.stream, stdin: { fd: null, text: stdin, stream: input }, script: SCRIPT, platform: process.platform });
  assert.equal(process.exitCode, exitCode, `yokoten ${words.join(' ')} set process.exitCode; it must only return its code`);
  assert.equal(process.cwd(), folder, `yokoten ${words.join(' ')} changed the process's folder`);
  const done = { code, stdout: stdout.text(), stderr: stderr.text(), output: both.join('') };
  if (REPORT_FILE) {
    const read = readText(words, done);
    const problems = read === null || read.trim() === '' ? [] : renderProblems(words, done, { isTTY, waived: {} });
    appendFileSync(REPORT_FILE, `${JSON.stringify({ key: renderKey(words), file: process.argv[1], checked: read !== null && read.trim() !== '', rules: problems.map(ruleOf) })}\n`);
  } else {
    const problems = renderProblems(words, done, { isTTY });
    assert.deepEqual(problems, [], `yokoten ${words.join(' ')} prints a screen that breaks the rules of record 0049; build it with src/rules/text/screen.ts (#1115)`);
  }
  return done;
}

// `node test/repo/invoke.ts <report>`: what healed in a RENDER_REPORT of the whole suite, for
// the integrator to take off. Exit 1 when RENDER_WAIVED is not exact for the report.
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2]) {
  const report = readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as ReportedRender);
  const healed = healedWaivers(report);
  process.stdout.write(healed.length ? `${healed.join('\n')}\n` : `RENDER_WAIVED is exact: ${Object.keys(RENDER_WAIVED).length} keys, all still needed\n`);
  if (healed.length) process.exitCode = 1;
}
