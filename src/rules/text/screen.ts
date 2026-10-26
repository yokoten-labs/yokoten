// ---- Screens: one layout for everything a person reads in a terminal (record 0049, issue #1099) ----
//
// A screen is a title line, short sections under headings, rows, and the one command to type
// next, wrapped once at SCREEN_WIDTH. A help page is built from a HelpSpec: usage, a summary of
// one or two lines, examples, options, then sections of rows. `screenProblems` holds the
// measurable limits of record 0049; the screen test (test/repo/docs/screens.test.ts) runs it on
// every screen the command list reaches. Everything here is pure: text in, lines out. The
// terminal is the platform a screen runs on, so this is the lowest layer, and the guard's
// refusal text in src/rules/ can use it too.

/** The widest line a screen prints (Heroku's CLI style guide; Claude Code's help wraps here too). */
export const SCREEN_WIDTH = 80;

/** One text as lines no wider than `width`; later lines start under the first line's text. */
export function wrap(prefix: string, text: string, width = SCREEN_WIDTH): string[] {
  const lines: string[] = [];
  const indent = ' '.repeat(prefix.length);
  let line = prefix;
  let isEmpty = true;
  // A command in backticks is one word, so a line never breaks it in two (#1027), also
  // after an opening bracket: `(\`git push -u origin --all\`)` stays whole (#1099).
  for (const word of text.match(/[^\s`]*`[^`]*`\S*|\S+/g) ?? []) {
    if (!isEmpty && line.length + 1 + word.length > width) {
      lines.push(line);
      line = indent + word;
    } else line += isEmpty ? word : ` ${word}`;
    isEmpty = false;
  }
  lines.push(line);
  return lines;
}

/** A screen's first line: `yokoten <command> · <what is true now>`. */
export const title = (command: string, summary: string): string[] => wrap(`yokoten ${command} · `, summary);

/** The state words a row starts with; `print` draws ✔ ● ✘ ⚠ ? for them on a terminal. */
export type RowMark = 'ok' | 'done' | 'next' | 'to do' | 'MISSING' | 'note' | "can't check" | 'skipped';

/** One row: the mark, an optional label in a 12-column field, then the text, wrapped under itself. */
export function row(mark: RowMark, text: string, label?: string): string[] {
  // A label wider than its column (a long path) takes its own line, so every text starts in one column.
  if (label !== undefined && label.length > 11) return [`  ${mark.padEnd(11)} ${label}`, ...wrap(' '.repeat(26), text)];
  const head = `  ${mark.padEnd(11)} ${label === undefined ? '' : `${label.padEnd(11)} `}`;
  return wrap(head, text);
}

/** One row with no mark: a label, then the text, wrapped under itself (#1027). */
export function field(label: string, text: string): string[] {
  return wrap(`  ${label.padEnd(12)}`, text);
}

/** The last line: the one command to type next. */
export const nextLine = (command: string): string[] => wrap('Next: ', `\`${command}\``);

/** Where the rest is: the flag that shows it all. */
export const moreLine = (text: string): string[] => wrap('More: ', text);

/** A label and its text, as a table row. */
export type TableRow = readonly [label: string, text: string];

/** The widest label column a table gives; a longer label takes its own line. */
const TABLE_COLUMN = 24;

/**
 * Rows of a table under a heading: labels in one column, each text wrapped under itself. The
 * column fits the widest label up to TABLE_COLUMN; a label past it stands on its own line.
 */
export function table(rows: readonly TableRow[]): string[] {
  const column = Math.min(Math.max(0, ...rows.map(([label]) => label.length)) + 2, TABLE_COLUMN);
  return rows.flatMap(([label, text]) => {
    const head = `  ${label}`;
    if (head.length + 1 > 2 + column) return [head, ...wrap(' '.repeat(2 + column), text)];
    return wrap(`  ${label.padEnd(column)}`, text);
  });
}

/** A section: its heading on a line of its own, then its lines. Empty when it has none. */
export const section = (heading: string, lines: readonly string[]): string[] => (lines.length ? [`${heading}:`, ...lines] : []);

/** A whole screen from its blocks, one blank line between them; an empty block is left out. */
export const screen = (...blocks: readonly (readonly string[])[]): string[] => blocks.filter((block) => block.length).flatMap((block, index) => (index ? ['', ...block] : [...block]));

/** One example of a help page: the command, and what it does. */
export interface HelpExample {
  command: string;
  /** What it does, in a few words. */
  text: string;
}

/** A section of a help page past the options: a heading, then rows. */
export interface HelpSection {
  heading: string;
  rows: readonly TableRow[];
}

/**
 * A help page as data (record 0049). `summary` is one or two lines once wrapped: what the
 * command does, and the one thing a newcomer must know. Examples come before options
 * (clig.dev: lead with examples), the common case first.
 */
export interface HelpSpec {
  /** The whole usage, from `yokoten`. */
  usage: string;
  /** Paragraphs, each wrapped once. A spec keeps it to one paragraph of two lines at most. */
  summary: readonly string[];
  examples: readonly HelpExample[];
  options: readonly TableRow[];
  sections?: readonly HelpSection[];
  /** Where to read more: a command in backticks or a link. */
  more?: string;
}

/** The lines of a help page: usage, summary, examples, options, sections, then More. */
export function helpScreen(spec: HelpSpec): string[] {
  return screen(
    wrap('Usage: ', spec.usage),
    ...spec.summary.map((paragraph) => wrap('', paragraph)),
    section(spec.examples.length > 1 ? 'Examples' : 'Example', spec.examples.length > 1 ? table(spec.examples.map((example) => [example.command, example.text])) : spec.examples.map((example) => `  ${example.command}`)),
    section('Options', table(spec.options)),
    ...(spec.sections ?? []).map((part) => section(part.heading, table(part.rows))),
    spec.more === undefined ? [] : moreLine(spec.more),
  );
}

// ---- The limits (record 0049) ----

/** The measurable limits of a screen, as record 0049 sets them. */
export const SCREEN_LIMITS = {
  /** A line fits this many columns... */
  width: SCREEN_WIDTH,
  /** ...but this many lines per screen may run over, for a link that cannot break... */
  overflowLines: 1,
  /** ...and none past this. */
  widest: 100,
  /** Lines of prose in a row, at the left edge, with no heading or blank line between. */
  prose: 4,
  /** Lines of summary on a help page, between the usage and the first heading. */
  helpSummary: 2,
} as const;

// A heading stands alone and ends in a colon: `Options:`, `In the fence:`.
const HEADING = /^[A-Z][^:]*:$/;
// The next step: a Next line, the Instead row of a refusal, or a command in backticks.
const NEXT_STEP = /^Next: |^ {2}Instead |`[^`]+`/;
// A More line or row: a pointer, so the next step may come just before it.
const MORE = /^(?:More: | {2}More {6}| {2}docs: )/;
const ESCAPE = /\u001b\[/;
// A line wrapped under a row's or a title's text: deeper than a row's two spaces.
const CONTINUED = /^ {3,}\S/;

/** What a screen is for the limits: its text as a person reads it, and whether the command failed. */
export interface ScreenText {
  text: string;
  /** The exit code was not 0: the screen must end with the next step. */
  isFailure?: boolean;
  /** A help page: its summary is held to SCREEN_LIMITS.helpSummary. */
  isHelp?: boolean;
}

/** Each limit of record 0049 the screen breaks, as a short sentence; none when it keeps them all. */
export function screenProblems({ text, isFailure = false, isHelp = false }: ScreenText): string[] {
  const lines = text.replace(/\n+$/, '').split('\n');
  const problems: string[] = [];
  const width = (line: string) => [...line].length;
  if (ESCAPE.test(text)) problems.push('it has a colour code, but it was not shown on a terminal');
  const wide = lines.filter((line) => width(line) > SCREEN_LIMITS.width);
  const widest = Math.max(0, ...lines.map(width));
  if (wide.length > SCREEN_LIMITS.overflowLines) problems.push(`${wide.length} lines are wider than ${SCREEN_LIMITS.width} columns; ${SCREEN_LIMITS.overflowLines} may be, for a link`);
  if (widest > SCREEN_LIMITS.widest) problems.push(`a line is ${widest} columns wide; the most is ${SCREEN_LIMITS.widest}`);
  let run = 0;
  let longest = 0;
  for (const line of lines) {
    run = line.trim() === '' || /^\s/.test(line) || HEADING.test(line) ? 0 : run + 1;
    longest = Math.max(longest, run);
  }
  if (longest > SCREEN_LIMITS.prose) problems.push(`${longest} lines of prose in a row; the most is ${SCREEN_LIMITS.prose}, then a heading or rows`);
  if (isHelp) {
    const usageEnd = lines.indexOf('');
    const firstHeading = lines.findIndex((line) => HEADING.test(line));
    const summary = lines.slice(usageEnd + 1, firstHeading === -1 ? lines.length : firstHeading).filter((line) => line.trim() !== '');
    if (summary.length > SCREEN_LIMITS.helpSummary) problems.push(`the help's summary is ${summary.length} lines; the most is ${SCREEN_LIMITS.helpSummary}`);
  }
  if (isFailure) {
    // An item is a line and the lines wrapped under it, so a wrapped row is still one row.
    const items: string[][] = [];
    for (const line of lines.filter((each) => each.trim() !== '')) {
      if (CONTINUED.test(line) && items.length) items.at(-1)?.push(line);
      else items.push([line]);
    }
    const tail = items.length > 1 && MORE.test(items.at(-1)?.[0] ?? '') ? items.slice(-2) : items.slice(-1);
    if (!tail.flat().some((line) => NEXT_STEP.test(line))) problems.push('it failed, but its last line does not say what to do next');
  }
  return problems;
}
