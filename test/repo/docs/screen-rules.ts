// The rules every screen keeps, and the code that measures them (record 0049, issue #1115). A
// development tool, as TEST_LIMITS is: nothing here ships in the package. The layout that
// builds a screen is src/rules/text/screen.ts; this file checks what it prints.
import '../home.ts';
import { MARK_COLUMN, ROW_INDENT, SCREEN_WIDTH } from '../../../src/rules/text/screen.ts';

/**
 * A pattern with `{COL}` where a line under a row's text is indented: the column of a `Fix:` line
 * and a wrapped line of a row with no label. The number is the layout's (ROW_INDENT + MARK_COLUMN),
 * never typed in a test (#1128).
 */
export const underMark = (pattern: RegExp): RegExp => new RegExp(pattern.source.replaceAll('{COL}', `{${ROW_INDENT + MARK_COLUMN}}`), pattern.flags);

// ---- The rules (record 0049, issue #1115) ----
//
// Each rule is a row of data: what it measures, the most it allows, why, and where it came
// from (the TEST_LIMITS shape, scripts/time/suite.ts). screenProblems measures every row; the
// screen test runs it on every screen the command list reaches. A rule changes here, in one
// row, and nowhere else. Checked against clig.dev and Google's error-message course (owner,
// 2026-10-27); what no rule can measure (plain words, the value the user typed) is a review.

/** One rule of a screen: what is counted, the most allowed, and why. */
export interface ScreenRule {
  id: string;
  what: string;
  limit: number;
  unit: string;
  reason: string;
  source: string;
}

export const SCREEN_RULES = [
  { id: 'width', what: 'lines wider than SCREEN_WIDTH (80 columns)', limit: 1, unit: 'lines', reason: 'a narrow terminal breaks a wide line in the middle; one line may run over, for a link that cannot break', source: 'record 0049; Heroku CLI style guide' },
  { id: 'widest', what: 'the widest line', limit: 100, unit: 'columns', reason: 'the one line that runs over stays short enough to read', source: 'record 0049' },
  { id: 'prose', what: 'lines of prose in a row at the left edge, with no heading, row or blank line between', limit: 4, unit: 'lines', reason: 'a wall of text is skipped; a heading or rows break it up', source: "record 0049; Google's error-message course: long messages" },
  { id: 'help-summary', what: "lines of a help page's summary, between the usage and the first heading", limit: 2, unit: 'lines', reason: 'a newcomer reads what the command does in one look, then the examples', source: 'record 0049; clig.dev: lead with examples' },
  { id: 'next-step', what: 'failed screens whose last item names no next step', limit: 0, unit: 'screens', reason: 'after a failure the person knows what to type next', source: 'record 0049; clig.dev: suggest what to do when there is an error' },
  { id: 'colour', what: 'colour codes in text that did not go to a terminal', limit: 0, unit: 'codes', reason: 'a pipe, a file or an agent reads the escape codes as noise', source: 'record 0049; clig.dev: disable colour when not a TTY' },
  { id: 'label-columns', what: 'columns where the text of a two-column row starts, in one screen', limit: 1, unit: 'columns', reason: 'each section sizing its own label column gave one screen three or four text columns', source: 'issue #1115, owner on S008 to S044' },
  { id: 'wrapped-example', what: 'examples whose text is pushed to the line under the command', limit: 0, unit: 'examples', reason: 'a long example gets a shorter form, or moves to the More link; its text stays beside it', source: 'issue #1115, owner on S008; clig.dev: lead with examples' },
  { id: 'spaced-items', what: 'items in a block with a wrapped item and no blank line between them', limit: 0, unit: 'items', reason: 'a wrapped item and the next one read as one', source: "issue #1115, owner on S004, S005, S041 to S072; Google's error-message course: a wall of text is skipped" },
  { id: 'fix-line', what: 'problem items whose command to run is not on a Fix line of its own, as the item\'s last line', limit: 0, unit: 'items', reason: 'the fix stands out instead of sitting inside a sentence or a pasted tool message', source: "issue #1115, owner on S004, S067 to S072; clig.dev: rewrite errors for humans, important information last; Google: explain the fix" },
  { id: 'same-fix-once', what: 'times one Fix line shows in a screen', limit: 1, unit: 'times', reason: 'the same fix said twice is noise; problems with one fix go under it once', source: 'clig.dev: signal-to-noise, group errors of one type under one header' },
  { id: 'no-internal-path', what: 'absolute paths outside the home folder (~) and links', limit: 0, unit: 'paths', reason: 'a temp folder or a machine path means nothing to the reader, and may show private names', source: "issue #1115, owner on S050 to S057; Google's error-message course: write for the audience" },
] as const satisfies readonly ScreenRule[];

export type ScreenRuleId = (typeof SCREEN_RULES)[number]['id'];

/** The limit of the rule with this id. */
export const limitOf = (id: ScreenRuleId): number => SCREEN_RULES.find((rule) => rule.id === id)!.limit;

// A heading stands alone and ends in a colon: `Options:`, `In the fence:`.
const HEADING = /^[A-Z][^:]*:$/;
// The next step: a Next line, the Instead row of a refusal, a Fix line, or a command in backticks (see commandsIn).
const NEXT_STEP = /^Next: |^ {2}Instead /;
// A heading, then a list: a `- ` item at the left edge ends a run of prose, as a row does.
const LIST_ITEM = /^[-*] /;
// A More line or row: a pointer, so the next step may come just before it.
const MORE = /^(?:More: | {2}More {6}| {2}docs: )/;
const ESCAPE = /\u001b\[/;
// A line wrapped under a row's or a title's text: deeper than a row's two spaces.
const CONTINUED = /^ {3,}\S/;
// A two-column row: two spaces, a label, two or more spaces, then its text.
const TWO_COLUMNS = /^ {2}(\S(?:.*?\S)?) {2,}(?=\S)/;
// A row with a mark and then a label (`row('ok', text, 'main')`): its text starts after the label.
const MARK_LABEL = /^ {2}(?:ok|done|next|to do|MISSING|note|can't check|skipped) +\S+(?: \S+)* {2,}(?=\S)/;
// The mark words a problem row starts with (RowMark), and a list item under a `Not read:` heading.
const PROBLEM_ROW = /^ {2}(?:MISSING|can't check) /;
const PROBLEM_HEADINGS = new Set(['Not read:', 'Problems:']);
// The fix of a problem: its own line, `Fix: ` and the command.
const FIX_LINE = /^\s*Fix: /;
// An absolute path on this machine, any root (#1128): `/` and two or more parts (`/bin/sh`, `/dev/null`,
// `/Library/x`), or one part of a known root folder (`/tmp`); a Windows drive with either slash
// (`C:\`, `C:/`) or in Git Bash's form (`/c/Users/...`); a UNC path (`\\server\share`). Not a link, not ~,
// and not the path of an API call after its verb (`GET /api/state`). What may come before a path that is
// NOT a machine path is listed, not what may come before one that is: a path glued to a word, `~`, `.`,
// `/` or `-` is part of a link, a home path or a relative path; a path after a `<name>` placeholder
// (`<project>/src/a.ts`) is relative; `2>/dev/null` is a redirect, and only that one path. Anything
// A shebang (`#!/bin/sh`) and a glob (`crates/*/x`) are not machine paths either. Anything
// else before it (`[`, `<`, `,`, `;`, `{`, `|`, `:`, `>`, a space) is a path of this machine.
const PART = /[^\s`'")\]}<>,;|]/.source;
const MACHINE_PATH = new RegExp(
  [
    `${/(?<![\w~./*-])\/(?!\/)/.source}${PART}+(?:\\/${PART}*)+`,
    /(?<![\w~./*-])\/(?:tmp|var|private|home|Users|mnt|opt|usr|root|run|srv|Volumes|etc|bin|dev|Library|proc|sys)(?![\w/-])/.source,
    `${/(?<![\w~./*-])[A-Za-z]:[\\/]/.source}${PART}*`,
    `${/(?<![\w~./\\-])\\\\+[^\s\\`'")]+\\+/.source}${PART}*`,
  ].join('|'),
  'g',
);
const API_CALL = /\b(?:GET|POST|PUT|PATCH|DELETE|HEAD) $/;
const PLACEHOLDER = /<[\w-]+>$/;
const REDIRECT = /\d*>$/;
const SHEBANG = /#!$/;
// A CODEOWNERS pattern is a path inside the repo, and the finding names it as it is written (`/docs/x` and `docs/x` differ there):
// the path that "matches no file" is not a path of this machine.
const CODEOWNERS_PATTERN = /^ matches no file/;
// A command in backticks is not a file name (`AGENTS.md`, `src/a.ts`) or a flag (`--write`).
const BACKTICKED = /`([^`]+)`/g;
// A command to run named without backticks, as in `run gh auth login` (#1115).
const COMMAND_WORDS = 'yokoten|gh|git|npm|npx|node|pnpm|yarn|export|cd|sudo|brew|winget|claude|codex|muse|gemini|grok|opencode|wsl|bash|sh|rm|mv|cp|mkdir|chmod|ln|echo|cat|curl';
const RUN_WORD = new RegExp(`\\b[Rr]un (?:(?:${COMMAND_WORDS})\\b|${/`/.source})`);
const COMMAND_START = new RegExp(`^(?:(?:${COMMAND_WORDS})\\s+\\S|\\./)`);

/**
 * The commands a line names in backticks: text whose first word is a known command word and has
 * something after it (`git commit`), or that starts with `./` (`./install.sh`). A file name
 * (`CODEOWNERS`, `Makefile`, `AGENTS.md`), a word (`main`, `git`) and a flag (`--write`) are not.
 */
export const commandsIn = (line: string): string[] =>
  [...line.matchAll(BACKTICKED)].map((found) => (found[1] ?? '').trim()).filter((text) => COMMAND_START.test(text));

/** Whether a line is a Fix line with a command: `Fix: \`<command>\``. */
const isFixLine = (line: string): boolean => FIX_LINE.test(line) && commandsIn(line).length > 0;

/** Whether a line has a command to run in backticks, or names one with `run`. */
const showsCommand = (line: string): boolean => commandsIn(line).length > 0 || RUN_WORD.test(line);

/** The absolute paths on this machine that a text shows (the no-internal-path rule): not ~, not a link. */
export function machinePathsIn(text: string): string[] {
  return [...text.matchAll(MACHINE_PATH)]
    .filter((found) => {
      const before = text.slice(0, found.index);
      const path = found[0];
      if (API_CALL.test(before)) return !path.startsWith('/api/');
      if (PLACEHOLDER.test(before) || SHEBANG.test(before) || CODEOWNERS_PATTERN.test(text.slice((found.index ?? 0) + path.length))) return false;
      if (REDIRECT.test(before)) return !/^\/dev\/null(?![\w/-])/.test(path);
      return true;
    })
    .map((found) => found[0]);
}

/** What a screen is for the limits: its text as a person reads it, and whether the command failed. */
export interface ScreenText {
  text: string;
  /** The exit code was not 0: the screen must end with the next step. */
  isFailure?: boolean;
  /** A help page: its summary is held to the help-summary rule. */
  isHelp?: boolean;
}

/** A block's items: each top-level line with the lines wrapped under it. */
function itemsOf(block: readonly string[]): string[][] {
  const items: string[][] = [];
  for (const line of block) {
    if (CONTINUED.test(line) && items.length) items.at(-1)?.push(line);
    else items.push([line]);
  }
  return items;
}

/** The blocks of a screen: the lines between blank lines. */
function blocksOf(lines: readonly string[]): string[][] {
  const blocks: string[][] = [[]];
  for (const line of lines) {
    if (line.trim() === '') blocks.push([]);
    else blocks.at(-1)?.push(line);
  }
  return blocks.filter((block) => block.length);
}

/** Each rule of SCREEN_RULES the screen breaks, as a short sentence that names the rule; none when it keeps them all. */
export function screenProblems({ text, isFailure = false, isHelp = false }: ScreenText): string[] {
  const lines = text.replace(/\n+$/, '').split('\n');
  const problems: string[] = [];
  const width = (line: string) => [...line].length;
  if (ESCAPE.test(text)) problems.push('it has a colour code, but it was not shown on a terminal [colour]');
  const wide = lines.filter((line) => width(line) > SCREEN_WIDTH);
  const widest = Math.max(0, ...lines.map(width));
  if (wide.length > limitOf('width')) problems.push(`${wide.length} lines are wider than ${SCREEN_WIDTH} columns; ${limitOf('width')} may be, for a link [width]`);
  if (widest > limitOf('widest')) problems.push(`a line is ${widest} columns wide; the most is ${limitOf('widest')} [widest]`);
  let run = 0;
  let longest = 0;
  for (const line of lines) {
    run = line.trim() === '' || /^\s/.test(line) || HEADING.test(line) || LIST_ITEM.test(line) ? 0 : run + 1;
    longest = Math.max(longest, run);
  }
  if (longest > limitOf('prose')) problems.push(`${longest} lines of prose in a row; the most is ${limitOf('prose')}, then a heading or rows [prose]`);
  if (isHelp) {
    const usageEnd = lines.indexOf('');
    const firstHeading = lines.findIndex((line) => HEADING.test(line));
    const summary = lines.slice(usageEnd + 1, firstHeading === -1 ? lines.length : firstHeading).filter((line) => line.trim() !== '');
    if (summary.length > limitOf('help-summary')) problems.push(`the help's summary is ${summary.length} lines; the most is ${limitOf('help-summary')} [help-summary]`);
  }
  const blocks = blocksOf(lines);
  if (isFailure) {
    // An item is a line and the lines wrapped under it, so a wrapped row is still one row.
    const items = blocks.flatMap(itemsOf);
    const tail = items.length > 1 && MORE.test(items.at(-1)?.[0] ?? '') ? items.slice(-2) : items.slice(-1);
    if (!tail.flat().some((line) => NEXT_STEP.test(line) || commandsIn(line).length > 0)) problems.push('it failed, but its last line does not say what to do next [next-step]');
  }
  // Where a row's text starts: past the label of a row with a mark and a label, else past its first label (#1115).
  const columns = new Set(lines.map((line) => (MARK_LABEL.exec(line) ?? TWO_COLUMNS.exec(line))?.[0].length).filter((column) => column !== undefined));
  if (columns.size > limitOf('label-columns')) problems.push(`its rows start their text in ${columns.size} columns (${[...columns].sort((a, b) => a - b).join(', ')}); the most is ${limitOf('label-columns')} [label-columns]`);
  let wrappedExamples = 0;
  let spaced = 0;
  let fixes = 0;
  let heading = '';
  const fixLines = new Map<string, number>();
  for (const block of blocks) {
    const items = itemsOf(block);
    if (HEADING.test(items[0]?.[0] ?? '')) heading = items[0][0];
    const body = HEADING.test(items[0]?.[0] ?? '') ? items.slice(1) : items;
    if (/^Examples?:$/.test(heading)) wrappedExamples += body.filter((item) => item.length > 1 && !TWO_COLUMNS.test(item[0])).length;
    if (body.length > 1 && body.some((item) => item.length > 1)) spaced += body.length - 1;
    for (const item of body) {
      const isProblem = PROBLEM_ROW.test(item[0]) || (PROBLEM_HEADINGS.has(heading) && /^(?:- | {2}\S)/.test(item[0]));
      if (isProblem && item.some((line) => showsCommand(line) && !isFixLine(line))) fixes += 1;
      if (isProblem && item.length > 1 && item.slice(0, -1).some(isFixLine)) fixes += 1;
    }
    for (const line of block.filter(isFixLine)) fixLines.set(line.trim(), (fixLines.get(line.trim()) ?? 0) + 1);
  }
  if (wrappedExamples > limitOf('wrapped-example')) problems.push(`${wrappedExamples} examples have their text on the next line; shorten them [wrapped-example]`);
  if (spaced > limitOf('spaced-items')) problems.push(`${spaced} items touch a wrapped item; put a blank line between them [spaced-items]`);
  if (fixes > limitOf('fix-line')) problems.push(`${fixes} problems keep their fix inside the text; give it a last line \`Fix: <command>\` [fix-line]`);
  const repeated = [...fixLines].filter(([, count]) => count > limitOf('same-fix-once'));
  if (repeated.length) problems.push(`${repeated.map(([line, count]) => `"${line}" ${count} times`).join(', ')}; say a fix once, under the problems it fixes [same-fix-once]`);
  const paths = machinePathsIn(text);
  if (paths.length > limitOf('no-internal-path')) problems.push(`${paths.length} paths on this machine show; say what they are, or use ~ [no-internal-path]`);
  return problems;
}

// ---- The screens' source (issue #1115, plan 6.5) ----
//
// The ratchets of screens.test.ts count what a screen built by hand leaves in src/: a literal
// `yokoten <command>: ` prefix, a column number, a blank line typed as '', a raw write, a
// regex that reads a screen's own lines back, an isTTY read. They read the code, not the
// comments or the import lines, so a comment that names a pattern is not counted.

/** One file's source, measured: the code with comments and imports gone and strings shortened, and the text of each string. */
export interface SourceText {
  /** The code, line for line: comments and import statements are spaces, a string's text is `_` unless it is only spaces. */
  code: string;
  /** The text of every string and template literal, outside `${}`. */
  strings: string[];
  /** The line (from 1) each string starts on, one per entry of `strings`. */
  stringLines: number[];
}

const KEYWORDS_BEFORE_REGEX = new Set(['return', 'typeof', 'case', 'in', 'of', 'void', 'yield', 'await', 'delete', 'instanceof', 'new', 'else', 'do']);

/** Split TypeScript source into code and string text, as the ratchets read it. Newlines stay where they were. */
export function readSource(source: string): SourceText {
  let code = '';
  const strings: string[] = [];
  const stringLines: number[] = [];
  // Where each line starts, to tell on which line a string begins.
  const lineStarts = [0];
  for (let index = source.indexOf('\n'); index !== -1; index = source.indexOf('\n', index + 1)) lineStarts.push(index + 1);
  const lineAt = (position: number): number => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if ((lineStarts[middle] ?? 0) <= position) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
  // Each open template literal remembers how deep the braces of its `${}` are.
  const templates: number[] = [];
  let depth = 0;
  let last = '';
  let word = '';
  const keepLines = (text: string) => text.replace(/[^\n]/g, ' ');
  // A string's text in the code: as it is when it is only spaces, else `_`, keeping its newlines.
  const shorten = (text: string) => (/^ *$/.test(text) ? text : `_${text.replace(/[^\n]/g, '')}`);
  // Read string or template text from `start` up to an unescaped `end` (or `${` in a template).
  const readText = (start: number, end: string): [string, number] => {
    let at = start;
    let text = '';
    while (at < source.length && source[at] !== end && !(end === '`' && source.startsWith('${', at))) {
      if (source[at] === '\\') {
        text += source.slice(at, at + 2);
        at += 2;
      } else text += source[at++];
    }
    return [text, at];
  };
  let at = 0;
  while (at < source.length) {
    const char = source[at];
    if (char === '/' && source[at + 1] === '/') {
      const stop = source.indexOf('\n', at);
      const end = stop === -1 ? source.length : stop;
      code += keepLines(source.slice(at, end));
      at = end;
    } else if (char === '/' && source[at + 1] === '*') {
      const stop = source.indexOf('*/', at + 2);
      const end = stop === -1 ? source.length : stop + 2;
      code += keepLines(source.slice(at, end));
      at = end;
    } else if (char === '/' && (!/[\w$)\]]/.test(last) || KEYWORDS_BEFORE_REGEX.has(word))) {
      // A regex literal: up to the `/` outside a class, then its flags.
      let end = at + 1;
      let isClass = false;
      while (end < source.length && source[end] !== '\n' && (isClass || source[end] !== '/')) {
        if (source[end] === '\\') end += 1;
        else if (source[end] === '[') isClass = true;
        else if (source[end] === ']') isClass = false;
        end += 1;
      }
      end += 1;
      while (/[a-z]/.test(source[end] ?? '')) end += 1;
      code += source.slice(at, end);
      at = end;
      last = '/';
      word = '';
    } else if (char === "'" || char === '"') {
      const [text, end] = readText(at + 1, char);
      strings.push(text);
      stringLines.push(lineAt(at));
      code += `${char}${shorten(text)}${char}`;
      at = end + 1;
      last = char;
      word = '';
    } else if (char === '`' || (char === '}' && templates.length && depth === templates.at(-1))) {
      // A template starts, or one of its `${}` ends: read its text up to the next `${` or its end.
      if (char === '}') templates.pop();
      const [text, end] = readText(at + 1, '`');
      strings.push(text);
      stringLines.push(lineAt(at));
      code += `${char}${shorten(text)}`;
      if (source.startsWith('${', end)) {
        templates.push(depth);
        code += '${';
        at = end + 2;
      } else {
        code += '`';
        at = end + 1;
      }
      last = '`';
      word = '';
    } else {
      if (char === '{') depth += 1;
      if (char === '}') depth -= 1;
      code += char;
      if (/\S/.test(char)) {
        word = /[\w$]/.test(char) ? (/[\w$]/.test(last) ? word + char : char) : '';
        last = char;
      }
      at += 1;
    }
  }
  // Import statements, which name files and not screens: from `import` to the module's string.
  code = code.replace(/^import\b[^;]*?'[^']*';?/gm, keepLines);
  return { code, strings, stringLines };
}

/** A file of src/: its path from the repo root, with `/`, and its text. */
export interface SourceFile {
  path: string;
  source: string;
}

/** What each ratchet counts, by id; R4 is an allow-list, not a count. */
export const RATCHETS = {
  R1: 'strings of src/ that start a line with the old `yokoten <command>: ` prefix',
  R2: 'column numbers outside src/rules/text/: padEnd(N), padStart(N), a repeated space, fit(…, N)',
  R3: "blank lines typed by hand in screen code outside src/rules/text/ (see isScreenCode): '' as an array item, push('') or unshift('')",
  R4: 'raw stdout.write and stderr.write outside src/commands/shared.ts',
  R5: 'regexes in src/commands/ that read a lines array back: .test(line) or .exec(line) inside lines.filter((line) => …) and its kin',
  R6: '.isTTY reads outside src/commands/shared.ts',
} as const;

export type RatchetId = keyof typeof RATCHETS;

const OUTSIDE_TEXT = (path: string) => !path.startsWith('src/rules/text/');

/**
 * Files that are not screens although they sit where screens are built: each holds a '' that is
 * data (an empty argument, a state, a word in a list, a line of a document for an agent or a
 * pull request), never a blank line on a person's terminal. A file here keeps at least one such hit,
 * so the list cannot go stale (screens.test.ts), and a screen added to it is not counted: do not.
 */
export const NOT_SCREEN: Readonly<Record<string, string>> = {
  'src/commands/kanban/view.ts': "a card's state tuple: '' is no state, not a blank line",
  'src/commands/kanban/server.ts': "the empty body of a redirect response",
  'src/commands/kanban/feed/read/usage.ts': "'' is one word of the list of role names",
  'src/commands/kanban/page/browser/desk.ts': "'' is an argument to the bar placement, not a screen",
  'src/commands/more/advice/mcp.ts': "'' is the path argument of the schema walker",
  'src/commands/tidy/find.ts': "'' is an argument to the unpushed count",
  'src/commands/desk/brief.ts': "a Markdown brief for an agent, a document not a screen",
  'src/commands/desk/finish.ts': "the text of a pull request body, a document not a screen",
  'src/agents/desk/team/team.ts': "path parts and an empty outbox file, data not a screen",
};

/**
 * Whether a file builds text a person reads on a terminal: the commands, the desk, the help and
 * the hook's own text, and bin/. The setup, host, platform and rules code builds file contents,
 * git arguments and data; a `yokoten x: ` line start is counted everywhere (R1), but a '' there is not a screen blank line.
 */
export const isScreenCode = (path: string): boolean =>
  (path.startsWith('src/commands/') || path.startsWith('src/agents/desk/') || path.startsWith('bin/') || path === 'src/run/cli.ts' || path === 'src/run/hook.ts') && !(path in NOT_SCREEN);

/** Where R3's pattern hits in one file, without the screen-code scope: for the NOT_SCREEN list to stay honest. */
export const blankHitsIn = (source: string): number => readSource(source).code.split('\n').reduce((total, line) => total + (line.match(BLANK_LINE)?.length ?? 0), 0);

const BLANK_LINE = /[[,]\s*''(?=\s*[,\]])|\.(?:push|unshift)\(''\)/g;
const OUTSIDE_SHARED = (path: string) => path !== 'src/commands/shared.ts';
// Per ratchet: which files it reads, and what it counts in a line of code (R1 reads the strings instead).
const COUNTED: Record<Exclude<RatchetId, 'R1' | 'R4'>, { isIn: (path: string) => boolean; pattern: RegExp; onlyWhere?: RegExp }> = {
  R2: { isIn: OUTSIDE_TEXT, pattern: /\.pad(?:End|Start)\(\s*\d+\s*\)|' +'\.repeat\(\s*\d+\s*\)|\bfit\([^()]*,\s*\d+\s*\)/g },
  R3: { isIn: (path) => OUTSIDE_TEXT(path) && isScreenCode(path), pattern: BLANK_LINE },
  R5: { isIn: (path) => path.startsWith('src/commands/'), pattern: /\.(?:test|exec)\(line\)/g, onlyWhere: /\blines\.(?:filter|find|findIndex|some|every|map|flatMap)\(\(line\b/ },
  R6: { isIn: OUTSIDE_SHARED, pattern: /\.isTTY\b/g },
};
const RAW_WRITE = /\b(?:stdout|stderr)\.write\(/;

/**
 * Where each ratchet finds its pattern in src/, as `path:line` once per hit; R4 as
 * `path: <the line, trimmed>`, the form of its allow-list.
 */
export function ratchetsOf(files: readonly SourceFile[]): Record<RatchetId, string[]> {
  const found: Record<RatchetId, string[]> = { R1: [], R2: [], R3: [], R4: [], R5: [], R6: [] };
  for (const { path, source } of files) {
    const { code, strings, stringLines } = readSource(source);
    // The old form is a line that starts with it; a comment in a file's text or a sentence that names yokoten is not.
    strings.forEach((text, index) => found.R1.push(...Array<string>(text.match(/(?:^|\n)yokoten [a-z-]+: /g)?.length ?? 0).fill(`${path}:${stringLines[index]}`)));
    const sourceLines = source.split('\n');
    code.split('\n').forEach((line, at) => {
      for (const [id, { isIn, pattern, onlyWhere }] of Object.entries(COUNTED) as [keyof typeof COUNTED, (typeof COUNTED)[keyof typeof COUNTED]][]) {
        if (!isIn(path) || (onlyWhere && !onlyWhere.test(line))) continue;
        found[id].push(...Array<string>(line.match(pattern)?.length ?? 0).fill(`${path}:${at + 1}`));
      }
      if (OUTSIDE_SHARED(path) && RAW_WRITE.test(line)) found.R4.push(`${path}: ${sourceLines[at]?.trim()}`);
    });
  }
  return found;
}
