// The check names a workflow's jobs report (#1376), so doctor and `check --pr` can say when
// a branch ruleset requires a name that no job reports. A green pull request then waits
// for that check forever, and nothing says why.
//
// GitHub names a job's check by its `name:`, else its id. A matrix job adds its values, as
// `tests (ubuntu-latest, 22)`, unless the name holds a `${{ matrix.* }}` expression. A job
// that calls another workflow reports `caller / called`. This is a small reader with
// Node's standard library only, not a YAML parser. A name it can't work out becomes a
// prefix: any required name that starts with it counts as reported, so it never warns
// about what it can't read.

/** The check names one workflow reports, and the prefixes of names it can't work out. */
export interface WorkflowChecks {
  names: string[];
  prefixes: string[];
}

/** More matrix rows than this are not listed: the job becomes a prefix. */
const MOST_ROWS = 256;

const indentOf = (line: string): number => line.length - line.trimStart().length;
const unquote = (text: string): string => {
  const value = text.trim();
  if (value.length > 1 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
  if (value.length > 1 && value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
  return value;
};

/** A line without its YAML comment: a `#` after a space, outside a quoted value. */
function uncommented(line: string): string {
  let quote = '';
  let before = ''; // the last non-space character outside quotes: a quote opens a value only after one of `:-[,{`
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quote) {
      if (char === "'" && quote === "'" && line[i + 1] === "'") i++; // `''` is a quote inside '...'
      else if (char === quote) quote = '';
    } else if ((char === '"' || char === "'") && ':-[,{'.includes(before)) quote = char;
    else if (char === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
    if (!quote && !/\s/.test(char)) before = char;
  }
  return line;
}

/** The lines under `lines[start]` that sit deeper than it, up to the first that does not. */
function blockUnder(lines: string[], start: number): string[] {
  const indent = indentOf(lines[start]);
  const block: string[] = [];
  for (let i = start + 1; i < lines.length && (lines[i].trim() === '' || indentOf(lines[i]) > indent); i++) block.push(lines[i]);
  return block;
}

/** Each `key:` at the top indent of `block`, with its value text and the lines under it. */
function keysOf(block: string[]): { key: string; value: string; under: string[] }[] {
  const first = block.find((line) => line.trim() !== '');
  if (first === undefined) return [];
  const indent = indentOf(first);
  const keys: { key: string; value: string; under: string[] }[] = [];
  block.forEach((line, i) => {
    if (line.trim() === '' || indentOf(line) !== indent) return;
    const found = /^\s*("[^"]*"|'[^']*'|[^\s:'"][^:]*?):(?:\s+(.*))?$/.exec(line);
    if (found) keys.push({ key: unquote(found[1]), value: (found[2] ?? '').trim(), under: blockUnder(block, i) });
  });
  return keys;
}

/** A matrix as its keys and values in order, or null when a value is not a plain list. */
function readMatrix(value: string, under: string[]): [string, string[]][] | null {
  if (value !== '') return null; // `matrix: ${{ fromJSON(...) }}`
  const rows: [string, string[]][] = [];
  for (const { key, value: list, under: items } of keysOf(under)) {
    if (key === 'include' || key === 'exclude' || list.includes('${{')) return null;
    if (list.startsWith('[') && list.endsWith(']')) rows.push([key, list.slice(1, -1).split(',').map(unquote).filter(Boolean)]);
    else if (list === '') {
      const values = items.filter((line) => line.trim() !== '').map((line) => /^\s*-\s+(.*)$/.exec(line)?.[1]);
      if (values.some((item) => item === undefined || /^[\w-]+:(\s|$)/.test(item))) return null;
      rows.push([key, values.map((item) => unquote(item as string))]);
    } else return null;
  }
  return rows;
}

/** Every row of a matrix, as its values in key order; null past MOST_ROWS. */
function matrixRows(matrix: [string, string[]][]): Record<string, string>[] | null {
  let rows: Record<string, string>[] = [{}];
  for (const [key, values] of matrix) {
    rows = rows.flatMap((row) => values.map((value) => ({ ...row, [key]: value })));
    if (rows.length > MOST_ROWS) return null;
  }
  return rows;
}

/** The check names the jobs of one workflow report (#1376). */
export function workflowCheckNames(workflow: string): WorkflowChecks {
  const lines = workflow.split(/\r?\n/).map((line) => uncommented(line).trimEnd());
  const result: WorkflowChecks = { names: [], prefixes: [] };
  const top = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (top === -1) return result;
  for (const job of keysOf(blockUnder(lines, top))) {
    const keys = new Map(keysOf(job.under).map((entry) => [entry.key, entry]));
    const name = keys.has('name') ? unquote(keys.get('name')?.value ?? '') : job.key;
    if (/^[>|]/.test(name)) {
      result.prefixes.push(''); // a block scalar name: unsure, so never a warning
      continue;
    }
    if (keys.has('uses')) {
      result.prefixes.push(`${name} / `, `${name} (`); // a matrix caller reports `caller (v) / called`
      continue;
    }
    const strategy = keys.get('strategy');
    const matrixKey = strategy ? keysOf(strategy.under).find((entry) => entry.key === 'matrix') : undefined;
    const matrix = matrixKey ? readMatrix(matrixKey.value, matrixKey.under) : [];
    const rows = matrix && matrix.length ? matrixRows(matrix) : matrix ? [] : null;
    // Not `\s*([^}]*?)\s*`: those overlap, and an unclosed `${{` and many spaces take cubic time.
    const expressions = [...name.matchAll(/\$\{\{([^}]*)\}\}/g)].map((found) => found[1].trim());
    if (!expressions.length && rows && !rows.length) result.names.push(name);
    else if (!expressions.length && rows) result.names.push(...rows.map((row) => `${name} (${Object.values(row).join(', ')})`));
    else if (!expressions.length) result.prefixes.push(`${name} (`);
    else if (rows?.length && expressions.every((found) => /^matrix\.[\w-]+$/.test(found) && found.slice(7) in rows[0])) {
      result.names.push(...rows.map((row) => name.replace(/\$\{\{\s*matrix\.([\w-]+)\s*\}\}/g, (_, key: string) => row[key] ?? '')));
    } else result.prefixes.push(name.slice(0, name.indexOf('${{')));
  }
  return result;
}

/** Whether a check named `required` is reported by one of `workflows`, or may be. */
const isReported = (checks: WorkflowChecks[], required: string): boolean =>
  checks.some((one) => one.names.includes(required) || one.prefixes.some((prefix) => required.startsWith(prefix)));

/** The required check names that no job in `workflows` reports (#1376). */
export function unreportedChecks(required: readonly string[], workflows: readonly string[]): string[] {
  const checks = workflows.map(workflowCheckNames);
  return required.filter((name) => !isReported(checks, name));
}

/** The required check names that the `before` workflows report and the `after` ones no longer do (#1376). */
export function droppedChecks(required: readonly string[], before: readonly string[], after: readonly string[]): string[] {
  const was = before.map(workflowCheckNames);
  const now = after.map(workflowCheckNames);
  return required.filter((name) => isReported(was, name) && !isReported(now, name));
}
