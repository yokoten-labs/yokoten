// ---- Screens: one layout for everything a person reads in a terminal (record 0049, issue #1099) ----
//
// A screen is a title line, short sections under headings, rows, and the one command to type
// next, wrapped once at SCREEN_WIDTH. A help page is built from a HelpSpec: usage, a summary of
// one or two lines, examples, options, then sections of rows. The rules a screen keeps, and the
// code that measures them, are a development tool: test/repo/docs/screen-rules.ts (issue #1115).
// Everything here is pure: text in, lines out. The terminal is the platform a screen runs on,
// so this is the lowest layer, and the guard's refusal text in src/rules/ can use it too.

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
const TABLE_COLUMN = 35;

/** The label column that fits every label given, two spaces after the widest, up to TABLE_COLUMN. */
export const columnFor = (labels: readonly string[]): number => Math.min(Math.max(0, ...labels.map((label) => label.length)) + 2, TABLE_COLUMN);

/**
 * Items one under the other. When any item wraps onto a second line, a blank line goes between
 * every two, so a wrapped item and the next never read as one (issue #1115).
 */
export const spaced = (items: readonly (readonly string[])[]): string[] => {
  const isLoose = items.length > 1 && items.some((item) => item.length > 1);
  return items.flatMap((item, index) => (isLoose && index ? ['', ...item] : [...item]));
};

/**
 * Rows of a table under a heading: labels in one column, each text wrapped under itself. The
 * column fits the widest label up to TABLE_COLUMN, or is given, so every table of one screen
 * starts its text in the same column (issue #1115). A label past it stands on its own line.
 */
export function table(rows: readonly TableRow[], column = columnFor(rows.map(([label]) => label))): string[] {
  return spaced(
    rows.map(([label, text]) => {
      if (label.length + 2 > column) return [`  ${label}`, ...wrap(' '.repeat(2 + column), text)];
      return wrap(`  ${label.padEnd(column)}`, text);
    }),
  );
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
  const examples: TableRow[] = spec.examples.length > 1 ? spec.examples.map((example) => [example.command, example.text]) : [];
  const sections = spec.sections ?? [];
  // One text column for the whole page: examples, options and every section (issue #1115).
  const column = columnFor([...examples, ...spec.options, ...sections.flatMap((part) => part.rows)].map(([label]) => label));
  return screen(
    wrap('Usage: ', spec.usage),
    ...spec.summary.map((paragraph) => wrap('', paragraph)),
    section(spec.examples.length > 1 ? 'Examples' : 'Example', spec.examples.length > 1 ? table(examples, column) : spec.examples.map((example) => `  ${example.command}`)),
    section('Options', table(spec.options, column)),
    ...sections.map((part) => section(part.heading, table(part.rows, column))),
    spec.more === undefined ? [] : moreLine(spec.more),
  );
}
