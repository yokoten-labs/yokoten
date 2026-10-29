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

/**
 * The usage line as units that never break in two: the words of one `|` alternative, and a bracket
 * group with its content, so a line never ends in `allow` with its `<mark>` on the next one (#1239).
 * A `|` stays at the end of its unit.
 */
function usageUnits(usage: string): string[] {
  const hasTopPipe = / \| /.test(usage.replace(/\[[^\]]*(?:\[[^\]]*\][^\]]*)*\]/g, ''));
  const units: string[] = [];
  let unit = '';
  let depth = 0;
  let isQuoted = false;
  for (const char of usage) {
    if (char === '"') isQuoted = !isQuoted;
    else if (!isQuoted && char === '[') depth++;
    else if (!isQuoted && char === ']') depth = Math.max(0, depth - 1);
    if (char === ' ' && !isQuoted && unit !== '' && (unit.endsWith('|') || (depth === 0 && !hasTopPipe))) {
      units.push(unit);
      unit = '';
    } else unit += char;
  }
  if (unit !== '') units.push(unit);
  return units;
}

/** The usage line, wrapped at `width` between its units (see usageUnits). */
export function wrapUsage(prefix: string, usage: string, width = SCREEN_WIDTH): string[] {
  const lines: string[] = [];
  const indent = ' '.repeat(prefix.length);
  let line = prefix;
  let isEmpty = true;
  for (const unit of usageUnits(usage)) {
    if (!isEmpty && line.length + 1 + unit.length > width) {
      lines.push(line);
      line = indent + unit;
    } else line += isEmpty ? unit : ` ${unit}`;
    isEmpty = false;
  }
  lines.push(line);
  return lines;
}

/** A screen's first line: `yokoten <command> · <what is true now>`. */
export const title = (command: string, summary: string): string[] => wrap(`yokoten ${command} · `, summary);

// A title's first line, as `title` and `failure` make it: `yokoten · ` for the bare command.
const TITLE_HEAD = /^yokoten(?: [a-z][a-z -]*)? · /;

/** How many lines of `block` are its title (the first line and the lines wrapped under it), 0 when it has none. */
function titleLength(block: readonly string[]): number {
  const head = TITLE_HEAD.exec(block[0] ?? '');
  if (!head) return 0;
  const indent = ' '.repeat(head[0].length);
  let length = 1;
  while (length < block.length && (block[length] ?? '').startsWith(indent) && /^\S/.test((block[length] ?? '').slice(indent.length))) length++;
  return length;
}

// ---- Marks and columns (record 0049, issue #1115) ----

// The state words a row starts with. `print` draws ✔ ● ✘ ⚠ ? for them on a terminal.
const ROW_MARKS = ['ok', 'done', 'next', 'to do', 'MISSING', 'note', "can't check", 'skipped'] as const;
// What a setup step did to one file or setting, and `not now` for a step left for later.
const CHANGE_MARKS = ['wrote', 'updated', 'linked', 'added', 'removed', 'kept', 'not now'] as const;

/**
 * Every word a line may start with as its mark: the ones `row` takes, then the change states.
 * The one list: `styleLine` reads its marks from here, and so does the kanban's state.
 */
export const MARKS = [...ROW_MARKS, ...CHANGE_MARKS] as const;
/** Any mark of MARKS. */
export type Mark = (typeof MARKS)[number];
/** The state words a row starts with. */
export type RowMark = (typeof ROW_MARKS)[number];
/** What a setup step did, as the mark its row starts with. */
export type ChangeMark = (typeof CHANGE_MARKS)[number];

/** Whether a mark says a thing is done and fine (`print` draws it green): `ok`, `done`, and a change that was made. */
export const isDoneMark = (mark: Mark): boolean => mark === 'ok' || mark === 'done' || ((CHANGE_MARKS as readonly string[]).includes(mark) && mark !== 'not now');

/** Where a row starts: two spaces in from the left edge. */
export const ROW_INDENT = 2;
/** The mark's field: the widest mark, `can't check`, and one space. */
export const MARK_COLUMN = 12;
/** A label's field, after the mark or alone in a `field` row. */
export const LABEL_COLUMN = 12;
/** Where a labelled row's text starts, so every text of one screen starts in one column. */
export const ROW_TEXT_COLUMN = ROW_INDENT + MARK_COLUMN + LABEL_COLUMN;

/** One row: the mark, an optional label in a 12-column field, then the text, wrapped under itself. */
export function row(mark: RowMark, text: string, label?: string): string[] {
  const indent = ' '.repeat(ROW_INDENT);
  const marked = `${indent}${mark.padEnd(MARK_COLUMN - 1)} `;
  // A label wider than its column (a long path) takes its own line, so every text starts in one column.
  if (label !== undefined && label.length > LABEL_COLUMN - 1) return [`${marked}${label}`, ...underRow(text)];
  return wrap(`${marked}${label === undefined ? '' : `${label.padEnd(LABEL_COLUMN - 1)} `}`, text);
}

/**
 * More text under a row's text, wrapped under it: under a labelled row's text, or with
 * `hasLabel` false under the text of a row with no label (a why, a fix, a path).
 */
export const underRow = (text: string, hasLabel = true): string[] => wrap(' '.repeat(hasLabel ? ROW_TEXT_COLUMN : ROW_INDENT + MARK_COLUMN), text);

/** One row with no mark: a label, then the text, wrapped under itself (#1027). */
export function field(label: string, text: string): string[] {
  return wrap(`${' '.repeat(ROW_INDENT)}${label.padEnd(LABEL_COLUMN)}`, text);
}

/** An ISO stamp as `YYYY-MM-DD HH:MM UTC`, the one way a screen shows a time. A stamp that does not parse comes through as it is. */
export function utcText(stamp: string): string {
  const time = Date.parse(stamp);
  return Number.isNaN(time) ? stamp : `${new Date(time).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** The last line: the one command to type next. */
export const nextLine = (command: string): string[] => wrap('Next: ', `\`${command}\``);

/** Where the rest is: the flag that shows it all. */
export const moreLine = (text: string): string[] => wrap('More: ', text);

/** A note to the person, on stderr: `note: <text>`, wrapped under its text. */
export const noteLine = (text: string): string[] => wrap('note: ', text);

/** A count or a total at the left edge under rows (`28 files written`), a block of its own on a screen. */
export const summaryLine = (text: string): string[] => wrap('', text);

/** The one question form: the question, then `[Y/n]` (Enter alone is yes). A question already ending in it is kept. */
export const askLine = (question: string): string => (/\[Y\/n\]$/.test(question.trimEnd()) ? question.trimEnd() : `${question.trimEnd()} [Y/n]`);

/**
 * A failure to run, a refusal or a usage error (record 0052 draft, issue #1115): the title says
 * what is wrong, then one `Next:` line, a blank line between. `command` is the word after
 * `yokoten`, undefined for the bare command. `next` is the command to type, or a sentence that
 * holds its command in backticks; with no `next`, the title stands alone.
 */
export function failure(command: string | undefined, what: string, next?: string): string[] {
  const head = wrap(command === undefined || command === '' ? 'yokoten · ' : `yokoten ${command} · `, what.trim().replace(/\.$/, ''));
  if (next === undefined || next.trim() === '') return head;
  return screen(head, next.includes('`') ? wrap('Next: ', next.trim()) : nextLine(next.trim()));
}

/** A label and its text, as a table row. */
export type TableRow = readonly [label: string, text: string];

/** The widest label column a table gives; a longer label takes its own line. */
const TABLE_COLUMN = 35;

/** The label column that fits every label given, two spaces after the widest, up to TABLE_COLUMN. */
export const columnFor = (labels: readonly string[]): number => Math.min(Math.max(0, ...labels.map((label) => label.length)) + 2, TABLE_COLUMN);

/**
 * Items one under the other. When any item wraps onto a second line, a blank line goes between
 * every two, so a wrapped item and the next never read as one (issue #1115). A title item is
 * always followed by a blank line: a title never reads as one of the rows under it.
 */
export const spaced = (items: readonly (readonly string[])[]): string[] => {
  const isLoose = items.length > 1 && items.some((item) => item.length > 1);
  return items.flatMap((item, index) => (index && (isLoose || titleLength(items[index - 1] ?? []) > 0) ? ['', ...item] : [...item]));
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

/**
 * A block that starts with a title, split into the title and the rest, so the rest is a block
 * of its own: a caller that passes a title and its rows as one block still gets the blank line.
 * A block whose title is already followed by a blank line is left as it is.
 */
function titleApart(block: readonly string[]): (readonly string[])[] {
  const length = titleLength(block);
  if (length === 0 || length === block.length || block[length] === '') return [block];
  return [block.slice(0, length), block.slice(length)];
}

/**
 * A whole screen from its blocks, one blank line between them; an empty block is left out. A
 * title is a block of its own, even when it came in one block with its rows (issue #1115).
 */
export const screen = (...blocks: readonly (readonly string[])[]): string[] =>
  blocks
    .filter((block) => block.length)
    .flatMap(titleApart)
    .flatMap((block, index) => (index ? ['', ...block] : [...block]));

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
    wrapUsage('Usage: ', spec.usage),
    ...spec.summary.map((paragraph) => wrap('', paragraph)),
    section(spec.examples.length > 1 ? 'Examples' : 'Example', spec.examples.length > 1 ? table(examples, column) : spec.examples.map((example) => `  ${example.command}`)),
    section('Options', table(spec.options, column)),
    ...sections.map((part) => section(part.heading, table(part.rows, column))),
    spec.more === undefined ? [] : moreLine(spec.more),
  );
}
