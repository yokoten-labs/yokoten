// What every command uses: the command line, the parser, the repo root, and the output.
// Everything yokoten prints goes through `print`, `say` or `printJson` (core rule 11).

import { appendFileSync, existsSync, readFileSync, readSync } from 'node:fs';
import { isatty } from 'node:tty';
import { annotations, isGitHubActions, stepSummary } from '../host/github/index.ts';
import { failure, field, isDoneMark, type Mark, MARKS, nextLine, noteLine, ROW_INDENT, ROW_TEXT_COLUMN, MARK_COLUMN, row, screen, spaced, wrap } from '../rules/text/screen.ts';
import type { Env } from '../rules/config.ts';
import { finding, type Finding, fixCommand, formatFinding, notRepoFinding } from '../rules/text/message.ts';
import { hideHome } from '../rules/privacy.ts';
import { shownValue } from '../rules/text/terminal.ts';
import { gitRoot } from '../run/check.ts';
import { closestWord, findCommand, HELP_OPTIONS } from '../run/cli.ts';

/** A stream a command writes to: the process's own, or a test's stand-in. A real stream has its `fd`. */
export type Output = NodeJS.WritableStream & { isTTY?: boolean; fd?: number };

/**
 * A command's standard input (#475): `fd` 0 for the process, `text` for a test. `stream` is
 * the same input as a stream, for a command that reads it as it comes (redact) or asks
 * whether it is a terminal. The process's stream is made only when a command reads it:
 * making it puts a pipe in non-blocking mode, and costs a guard call time (#408).
 */
export interface Input {
  fd: number | null;
  text: string | null;
  readonly stream: NodeJS.ReadableStream & { isTTY?: boolean };
}

/** True when stdin is a terminal: someone typed the command by hand. The process's stream is made only when no fd is known (#1053). */
export const isTerminal = (input: Input): boolean => (input.text === null && input.fd !== null ? isatty(input.fd) : input.text === '' && input.stream.isTTY === true);

/** All of stdin as text: the test's, or the process's read to its end. */
export const readInput = ({ fd, text }: Input): string => text ?? (fd === null ? '' : readFileSync(fd, 'utf8'));

/**
 * One run of one command, as plain data (#475). bin/main.ts makes it from the process once;
 * a test makes its own. Below bin/main.ts, nothing reads process.argv, process.env,
 * process.cwd() or the process's streams: a command reads them from here. It holds values only,
 * never a method or a cache, so it cannot grow into a bag every module reaches into. The one
 * exception is `stdin.stream`, a getter, so the process's stdin is made only when read: never
 * spread or copy `stdin`, or the hook makes it and fd 0 turns non-blocking (see Input).
 */
export interface Invocation {
  /** The first word after `yokoten`, or undefined when there is none. */
  command: string | undefined;
  /** The words after the command. */
  args: string[];
  /** HOME is set when the system has one (#356): every module below reads it from here. */
  env: Env;
  cwd: string;
  stdout: Output;
  stderr: Output;
  stdin: Input;
  /** The path of the yokoten entry that runs, for a command that runs yokoten again (the redact wrapper). */
  script: string;
  /** The system, read once in bin/main.ts (record 0040). Missing means a POSIX system. */
  platform?: NodeJS.Platform;
}

/** The command line, read strictly: an unknown option is refused, never ignored. */
export interface Parsed {
  flags: Set<string>;
  values: Record<string, string>;
  positional: string[];
}
/** Reads the words by the options and argument the command's help lists, nothing else. */
export function parse(name: string, words: string[]): Parsed | string {
  const command = findCommand(name);
  if (!command) throw new Error(`no help entry for ${name}`);
  const known = new Map(command.options.map((option) => [option.name, option]));
  const parsed: Parsed = { flags: new Set(), values: {}, positional: [] };
  for (let i = 0; i < words.length; i++) {
    const a = words[i];
    const option = known.get(a);
    if (option?.value) {
      const value = words[++i];
      if (value === undefined || value.startsWith('--')) return `${a} needs a value`;
      parsed.values[a] = value;
    } else if (option) parsed.flags.add(a);
    else if (a.startsWith('-')) {
      const near = closestWord(a, [...known.keys(), HELP_OPTIONS[0]]);
      return `unknown option ${shownValue(a)}${near ? `. Did you mean ${near}?` : ''}`;
    } else parsed.positional.push(a);
  }
  const allowed = command.many ? Infinity : command.arguments?.length ?? (command.argument ? 1 : 0);
  if (parsed.positional.length > allowed) return `unexpected argument ${shownValue(parsed.positional[allowed] ?? '')}`;
  return parsed;
}

/**
 * --json among the command's own words, for a command that takes it (#280). It is read
 * before the parser, so a usage error and a crash are JSON too. For `bot`, the words after
 * `--` belong to the command it runs.
 */
function isJsonAsked({ command: name, args }: Invocation): boolean {
  const command = name === undefined ? undefined : findCommand(name);
  if (!command?.options.some((option) => option.name === '--json')) return false;
  const end = args.indexOf('--');
  return (end === -1 ? args : args.slice(0, end)).includes('--json');
}

/** With --json, an error as data on stdout too: `{ command, ok: false, error }`, one line. */
export function printJsonError(invocation: Invocation, error: string): void {
  if (isJsonAsked(invocation)) printJson(invocation, { command: invocation.command, ok: false, error });
}

/** A usage error: said on stderr, exit 1, as for an unknown command. With --json, also on stdout. */
export function usage(invocation: Invocation, error: string): number {
  const { command } = invocation;
  printJsonError(invocation, error);
  // The error with the word typed, what the command does in one line, then the command to run last (record 0049, #1115).
  const entry = command ? findCommand(command) : undefined;
  print(invocation, screen(failure(command || undefined, error), entry ? field(entry.name, entry.summary) : [], nextLine(command ? `yokoten ${command} --help` : 'yokoten help')), invocation.stderr);
  return 1;
}

const GIT_MISSING = 'git is not installed';

// A git call that fails because git itself was not found, not because of the folder.
const isGitMissingError = (err: unknown, dir: string): boolean => (err as NodeJS.ErrnoException).code === 'ENOENT' && existsSync(dir);

export const rootOf = (dir: string, env: Env): string | null => {
  try {
    return gitRoot(dir, env);
  } catch {
    return null;
  }
};

/**
 * Why there is no repo root: git is missing, or the folder is not in a repo. Call it after
 * rootOf. It asks git once more, so no state is kept from one command to the next.
 */
export function noRootFinding(dir: string, env: Env): Finding {
  let isGitMissing = false;
  try {
    gitRoot(dir, env);
  } catch (err) {
    isGitMissing = isGitMissingError(err, dir);
  }
  return isGitMissing ? finding('not-a-repo', `${GIT_MISSING} (or not on PATH); yokoten needs git`, 'install git, or add it to PATH') : notRepoFinding(dir);
}

/**
 * The repo root, or null after one plain finding on stderr (#205): a command that needs a
 * repo calls this before it writes anything. With --json, `json` shapes the output.
 */
export function requireRoot(invocation: Invocation, dir: string, json?: (missing: Finding) => unknown): string | null {
  const root = rootOf(dir, invocation.env);
  if (root) return root;
  const missing = noRootFinding(dir, invocation.env);
  if (json) printJson(invocation, json(missing));
  else print(invocation, noRootScreen(invocation.command, missing), invocation.stderr);
  return null;
}

/**
 * The screen for "no repo here": what is wrong on the first line, the one step last. The
 * finding keeps its full text for JSON and the guard; a person at a terminal reads this.
 * `command` is the word after `yokoten`, or undefined for the bare `yokoten`.
 */
export function noRootScreen(command: string | undefined, missing: Finding): string[] {
  const words = command === undefined ? 'yokoten' : `yokoten ${command}`;
  // What happened in the reader's words, with no path: the folder is the one they are in (issue #1115).
  if (missing.what.startsWith(GIT_MISSING)) return failure(command, missing.what, `install git, or add it to PATH, then run \`${words}\` again`);
  return failure(command, 'this folder is not in a git repo', "go to your project's folder, or start one here with `git init`");
}

// A person's terminal output (#707): colour and a shape that reads at a glance, like
// `node -h`. An agent reads plain text, so a hook answer, a log and a file never get a
// code. Colour is for a terminal only, and `NO_COLOR` turns it off (no-color.org).
const BOLD = '1';
const GREEN = '32';
const YELLOW = '33';
const RED = '31';
const CYAN = '36';

/** `text` in a colour code, or as it is when colour is off. */
export const paint = (text: string, code: string, isColour: boolean): string => (isColour ? `\u001b[${code}m${text}\u001b[0m` : text);

/**
 * Whether a stream gets colour: a terminal, and `NO_COLOR` is not set. `TERM=dumb` is a
 * terminal that can't show it either.
 */
export const isColourTerminal = (env: Env, stream: { isTTY?: boolean }): boolean => stream.isTTY === true && env.NO_COLOR === undefined && env.TERM !== 'dumb';

// A mark at the start of a line, padded to the column the next word starts in. The words are
// MARKS, the one list (issue #1115), longest first; `note:` is the older note line's form.
const markWords = [...MARKS].sort((a, b) => b.length - a.length).map((mark) => (mark === 'note' ? 'note:?' : mark.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
const MARK = new RegExp(`^(\\s*)(${markWords.join('|')})(\\s+)(.*)$`);
const GREEN_MARKS: ReadonlySet<string> = new Set(MARKS.filter(isDoneMark));
// The ways a `kept` line says the file stays the user's, because they changed it: `describeWrite`'s
// `kept (your edit) …` and `kept … (yours, not yokoten's)`, and init's `kept your <sandbox> in …`,
// `kept your <hooks file>: …` and `kept <file>: it has your changes …` (#964).
const KEPT_YOURS = /^(?:\(your edit\)|your\b)|\(yours, not yokoten's\)$|: it has your changes\b/;
// The glyph for each state (owner 2026-10-24): ✔ done, ✘ missing, ● next, ⚠ note,
// ? can't check. A terminal gets it; a pipe, a file or an agent keeps the word alone,
// so an old console never shows a broken glyph. `not now` and `skipped` are not among
// the five states, so they keep their word only.
const MARK_GLYPH: Record<string, string> = {
  ...Object.fromEntries(MARKS.filter(isDoneMark).map((mark: Mark) => [mark, '✔'])),
  MISSING: '✘', next: '●', 'to do': '●', note: '⚠', 'note:': '⚠', "can't check": '?',
};
// log-symbols' fallbacks (issue #1027, R11): the classic Windows console draws these from its code page.
const ASCII_GLYPH: Record<string, string> = { '✔': '√', '✘': '×', '●': '*', '⚠': '‼', '?': '?' };

/**
 * Whether the terminal draws Unicode marks (is-unicode-supported's rules): every system but
 * Windows, except the Linux console; on Windows only the terminals known to (record 0040: the
 * system is passed in).
 */
export function isUnicodeTerminal(env: Env, platform: NodeJS.Platform = 'linux'): boolean {
  if (platform !== 'win32') return env.TERM !== 'linux';
  return Boolean(env.WT_SESSION) || Boolean(env.TERMINUS_SUBLIME) || env.ConEmuTask === '{cmd::Cmder}' || env.TERM_PROGRAM === 'Terminus-Sublime' || env.TERM_PROGRAM === 'vscode' || env.TERM === 'xterm-256color' || env.TERM === 'alacritty' || env.TERM === 'rxvt-unicode' || env.TERMINAL_EMULATOR === 'JetBrains-JediTerm';
}

/** The padding after a mark, two columns shorter, so the text after it keeps its column. */
const trimMarkPadding = (padding: string): string => padding.slice(Math.min(2, Math.max(0, padding.length - 1)));

/**
 * The text after a mark, `short` columns narrower when it starts with a label and a gap of
 * three or more spaces: the gap keeps one space at least. Any other text is left as it is.
 */
function keepTextColumn(rest: string, short: number): string {
  if (short >= 0) return rest;
  const labelled = /^(\S+(?: \S+)*)( {3,})(\S.*)$/.exec(rest);
  if (!labelled) return rest;
  const gap = labelled[2] ?? '';
  return `${labelled[1] ?? ''}${gap.slice(Math.min(-short, gap.length - 1))}${labelled[3] ?? ''}`;
}
const HEADING = /^(?:yokoten \d|yokoten [a-z][a-z-]*:|yokoten [a-z][a-z -]* · |yokoten stopped this:|the road:|project:|machine:|unsaved work|server \(|Usage:|Start:|Exit codes:|Options:|Example:|Merge next:|More:|Instead:|Why:)|^[A-Z][a-z]*(?: [a-z]+)*:$/;
// The last form is a title alone on its line, such as a group in `yokoten help` (#944).
const STAGE = /^\s+\d+\. \S/;
const COMMAND = /`[^`\n]+`/g;
// One row of `yokoten help`: two spaces, the command's name, then its summary.
const COMMAND_ROW = /^(\s{2})([a-z][a-z-]*)(\s{2,})(.*)$/;

/**
 * One line of a person's output: a mark in its colour, a heading in bold, a refusal in
 * red, a command in cyan. Everything else stays as it is. The columns do not move: the
 * code goes around the mark, not in place of its padding.
 */
export function styleLine(line: string, isColour: boolean, isUnicode = true): string {
  if (!isColour) return line;
  const mark = MARK.exec(line);
  // The style of the whole line, when one covers it. A command's reset would end that
  // style for the rest of the line, so it is opened again after each command (#707).
  let outer: string | undefined;
  let styled = line;
  if (line.startsWith('yokoten stopped this: ')) {
    outer = `${BOLD};${RED}`;
  } else if (mark) {
    const word = mark[2] ?? '';
    // A file kept because the user changed it was not updated: a note, not done (#964).
    const yours = word === 'kept' && KEPT_YOURS.test(mark[4] ?? '');
    const colour = GREEN_MARKS.has(word) && !yours ? GREEN : word === 'MISSING' ? RED : YELLOW;
    const drawn = yours ? MARK_GLYPH.note : MARK_GLYPH[word];
    const glyph = drawn === undefined || isUnicode ? drawn : ASCII_GLYPH[drawn] ?? drawn;
    let said = glyph === undefined ? word : `${glyph} ${word}`;
    let padding = glyph === undefined ? mark[3] ?? '' : trimMarkPadding(mark[3] ?? '');
    // A long mark (`can't check`) has no padding to give the glyph: a label's gap gives the
    // rest, so the row's text keeps the column of the rows above and below it (#1115).
    let rest = keepTextColumn(mark[4] ?? '', (mark[3] ?? '').length - padding.length - (said.length - word.length));
    // With no label there is no gap to give: the row keeps its word and its colour, without the
    // glyph, so its text still starts in the column of every other row (#1160).
    const isInColumn = word.length + (mark[3] ?? '').length === MARK_COLUMN;
    if (isInColumn && glyph !== undefined && (mark[3] ?? '').length - padding.length < said.length - word.length && rest === (mark[4] ?? '')) {
      said = word;
      padding = mark[3] ?? '';
      rest = mark[4] ?? '';
    }
    styled = `${mark[1] ?? ''}${paint(said, colour, true)}${padding}${rest}`;
  } else if (HEADING.test(line) || STAGE.test(line)) {
    outer = BOLD;
  } else {
    const row = COMMAND_ROW.exec(line);
    if (row && findCommand(row[2] ?? '') !== undefined) styled = `${row[1] ?? ''}${paint(row[2] ?? '', CYAN, true)}${row[3] ?? ''}${row[4] ?? ''}`;
  }
  // A command's own help names it in the usage line, which is bold: the name goes cyan and
  // the bold is opened again after it, as for a command at the start of a line (#929).
  const usage = /^(Usage: yokoten )([a-z][a-z-]*)(.*)$/.exec(styled);
  if (usage && findCommand(usage[2] ?? '') !== undefined) {
    styled = `${usage[1] ?? ''}${paint(usage[2] ?? '', CYAN, true)}${usage[3] ? `\u001b[${BOLD}m` : ''}${usage[3] ?? ''}`;
  }
  const painted = styled.replace(COMMAND, (command, offset: number) =>
    `${paint(command, CYAN, true)}${outer !== undefined && offset + command.length < styled.length ? `\u001b[${outer}m` : ''}`,
  );
  return outer === undefined ? painted : paint(painted, outer, true);
}

/** A whole text, line by line. */
export const styleText = (text: string, isColour: boolean, isUnicode = true): string => (isColour ? text.split('\n').map((line) => styleLine(line, true, isUnicode)).join('\n') : text);

/**
 * Whether a command may colour its text on this stream (#707): a terminal, no `NO_COLOR`,
 * and never the hook, whose answer an agent reads.
 */
export const canColour = (invocation: Invocation, stream: Output): boolean => invocation.command !== 'hook' && isColourTerminal(invocation.env, stream);

// Everything yokoten prints goes through here or `say`, never straight to a stream: the
// output lands in transcripts and CI logs, so the home folder is shown as ~ (core rule 11).
// Colour is added here only, and only on a terminal, so an agent or a file never sees it.
export function print(invocation: Invocation, lines: string[], stream: Output = invocation.stdout): void {
  if (!lines.length) return;
  const text = lines.join('\n');
  say(invocation, `${canColour(invocation, stream) ? styleText(text, true, isUnicodeTerminal(invocation.env, invocation.platform)) : text}\n`, stream);
}
export function say(invocation: Invocation, text: string, stream: Output): void {
  stream.write(hideHome(text, invocation.env));
}

/** A screen on stdout: `print` by its plain name, for a command's result (issue #1115). */
export const show = (invocation: Invocation, lines: string[]): void => print(invocation, lines);

/**
 * A failure to run, a refusal or a usage error, on stderr (issue #1115): the title says what is
 * wrong, one `Next:` line says what to do. With --json, the error is on stdout as data too,
 * as for `usage`. Returns 1, the exit code, so a runner ends with `return fail(...)`.
 */
export function fail(invocation: Invocation, what: string, next?: string): 1 {
  printJsonError(invocation, what);
  print(invocation, failure(invocation.command, what, next), invocation.stderr);
  return 1;
}

/**
 * What the terminal around a command allows, read in one place (gh's IOStreams, issue #1115):
 * `isPerson` someone typed it and reads stdout, `canAsk` a question can be read back from
 * them, `colour` stdout gets colour. A pipe, a hook and CI are none of them.
 */
export interface Terminal {
  isPerson: boolean;
  canAsk: boolean;
  colour: boolean;
}

/** The terminal facts of one run. It reads stdin's stream, so the hook, which must not make it, never calls it. */
export function terminalOf(invocation: Invocation): Terminal {
  const { stdin, stdout } = invocation;
  const isPerson = stdin.stream.isTTY === true && stdout.isTTY === true;
  return { isPerson, canAsk: isPerson && stdin.fd !== null, colour: canColour(invocation, stdout) };
}

/**
 * Ask one question on the terminal and read one line back, or null at end of input. Install
 * is synchronous, so it reads stdin a byte at a time; it is used only when stdin is a terminal
 * (`terminalOf(invocation).canAsk`). It is the one place that writes a question to a stream.
 */
export const askOnTerminal = (stdout: Output, fd: number): ((question: string) => string | null) => (question) => {
  stdout.write(`${question} `);
  const byte = Buffer.alloc(1);
  const bytes: number[] = [];
  for (;;) {
    let count: number;
    try {
      count = readSync(fd, byte, 0, 1, null);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EAGAIN') continue;
      return null;
    }
    if (count === 0) return bytes.length ? Buffer.from(bytes).toString('utf8') : null;
    if (byte[0] === 10) return Buffer.from(bytes).toString('utf8').replace(/\r$/, '');
    bytes.push(byte[0]);
  }
};

// --json: stdout holds the JSON and nothing else. The home folder is hidden in every
// string before it is encoded, as in the text form.
export function printJson(invocation: Invocation, data: unknown): void {
  const hide = (v: unknown): unknown =>
    typeof v === 'string' ? hideHome(v, invocation.env) : Array.isArray(v) ? v.map(hide) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, hide(x)])) : v;
  invocation.stdout.write(`${JSON.stringify(hide(data), null, 2)}\n`);
}

export const bullets = (findings: Finding[]) => findings.map((f) => `- ${formatFinding(f)}`);

/**
 * In a GitHub Actions job, the findings of a check also go on the pull request page
 * (#91): annotations on stdout, and a job summary. Outside Actions, nothing. With
 * --json, stdout holds only the JSON, so there are no annotations; the summary is a file.
 * A summary that can't be written is said on stderr; it never changes the result.
 */
export function showOnPullRequest(invocation: Invocation, name: string, problems: Finding[], notes: Finding[], { json, isPlaceAFile }: { json: boolean; isPlaceAFile: boolean }): void {
  const { env } = invocation;
  if (!isGitHubActions(env)) return;
  if (!json) print(invocation, annotations(problems, notes, isPlaceAFile));
  if (!env.GITHUB_STEP_SUMMARY) return;
  try {
    appendFileSync(env.GITHUB_STEP_SUMMARY, hideHome(stepSummary(name, problems, notes), env));
  } catch (err) {
    print(invocation, noteLine(`${name}: the job summary was not written: ${((err as Error).message ?? String(err)).split('\n')[0]}`), invocation.stderr);
  }
}

// One screen per command (issue #1027, the CLI design the owner approved 2026-10-25): a title line,
// groups of rows, and the command to type last. The layout itself is src/rules/text/screen.ts
// (record 0049, issue #1099): every screen, the guard's refusals in src/rules/ too, builds on it,
// so these are its names, not a second copy. Rows carry the mark words `styleLine` already draws:
// a terminal sees a coloured glyph, an agent or a pipe the word. Persons and agents read the same text.
export {
  askLine, type ChangeMark, failure, field, LABEL_COLUMN, type Mark, MARK_COLUMN, MARKS, moreLine, nextLine, noteLine, row, ROW_TEXT_COLUMN, type RowMark,
  screen, SCREEN_WIDTH, spaced, summaryLine, title, underRow, wrap,
} from '../rules/text/screen.ts';

/** Where a problem's text starts: `row`'s mark and label columns, so its why and fix sit under it. */
function textColumn(where: string | undefined): number {
  return where === undefined ? ROW_INDENT + MARK_COLUMN : ROW_TEXT_COLUMN;
}

/** A part of a finding as a sentence: a capital first, a full stop last. */
const asSentence = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}${/[.!?]$/.test(text) ? '' : '.'}`;

/** The place a problem names, as editors and agents read it: `path:line`, with no colon after. */
function locationOf(problem: Finding): string | undefined {
  if (problem.file === undefined) return undefined;
  return `${problem.file}${problem.line === undefined ? '' : `:${problem.line}`}`;
}

/**
 * One MISSING row per problem, with its why and fix under it: check's screen and bot's refusal
 * (#1027). A fix that starts with a command ends the row on its own line, `Fix: \`<command>\``,
 * said once under the last problem it fixes (#1115). A blank line goes between rows that wrap.
 */
export function problemRows(problems: Finding[]): string[] {
  const commands = problems.map((problem) => fixCommand(problem.fix));
  return spaced(
    problems.map((problem, at) => {
      const where = locationOf(problem);
      const indent = ' '.repeat(textColumn(where));
      const command = commands[at];
      if (!command) return [...row('MISSING', problem.what, where), ...wrap(indent, `${asSentence(problem.why)} ${asSentence(problem.fix)}`)];
      const isLast = commands.findLastIndex((other) => other?.command === command.command) === at;
      return [
        ...row('MISSING', problem.what, where),
        ...wrap(indent, command.then ? `${asSentence(problem.why)} ${asSentence(command.then)}` : asSentence(problem.why)),
        ...(isLast ? [`${indent}Fix: \`${command.command}\``] : []),
      ];
    }),
  );
}

/** "1 file", "3 files": a count with its noun in the right number. */
export const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
