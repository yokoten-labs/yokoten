// Tests for src/rules/text/screen.ts: a line breaks only between words (#1268).

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GUIDE_AGENTS } from '../../../src/agents/runtimes/runtime.ts';
import { field, KEPT_NAMES, LABEL_COLUMN, row, table, wrap } from '../../../src/rules/text/screen.ts';

// A path, an ID with hyphens and a slash, a command and an agent name: none may be split.
const PATH = 'src/commands/kanban/page/browser/a-long-module-name.ts';
const MODEL_ID = 'opencode-go/deepseek-v4.1-flash';
const COMMAND = '`yokoten worker mark <dir>`';
const NAME = 'GitHub Copilot CLI';
const TEXT = `The guard read ${PATH} for ${NAME} on ${MODEL_ID}, then ran ${COMMAND} and stopped, and Claude Code saw it.`;
const WHOLE = [PATH, MODEL_ID, COMMAND, NAME, 'Claude Code'];

/** The items (WHOLE by default) that no line of `lines` holds whole. */
const splitItems = (lines: readonly string[], items = WHOLE): string[] => items.filter((item) => !lines.some((line) => line.includes(item)));

test('wrap: at every width, a path, an ID, a command and a name stay on one line (#1268)', () => {
  for (let width = 20; width <= 80; width++) {
    const lines = wrap('  note: ', TEXT, width);
    assert.deepEqual(splitItems(lines), [], `width ${width}:\n${lines.join('\n')}`);
    // Breaks fall between words: the words read back as the text.
    assert.equal(lines.map((line) => line.trim()).join(' ').replace(/^note: /, ''), TEXT, `width ${width}`);
  }
});

test('wrap: a word longer than the room left starts the next line, whole (#1268)', () => {
  assert.deepEqual(wrap('    ', `see ${PATH}`, 30), ['    see', `    ${PATH}`]);
});

test('row, field and table: a value too long for its column takes its own line (#1268)', () => {
  const long = 'GitHub Copilot';
  assert.ok(long.length > LABEL_COLUMN - 1);
  assert.equal(row('note', 'waits', long)[0]?.trimEnd(), `  note         ${long}`, 'row: the label stands alone');
  assert.deepEqual(field(long, 'waits for you'), [`  ${long}`, `${' '.repeat(2 + LABEL_COLUMN)}waits for you`], 'field: the label stands alone');
  assert.deepEqual(field('exactly12chr', 'text')[0], '  exactly12chr', 'field: a label as wide as its column does not run into its text');
  assert.deepEqual(field('short', 'text'), ['  short       text']);
  const rows = table([[PATH, `${MODEL_ID} ${COMMAND}`], ['ok', NAME]], 12);
  assert.deepEqual(splitItems(rows, [PATH, MODEL_ID, COMMAND, NAME]), []);
  assert.equal(rows[0], `  ${PATH}`, 'table: the long label stands alone');
});

// Known-bad input: the names the wrap keeps are the guide's agents, so a new agent's name is kept too.
test('KEPT_NAMES holds every agent name of more than one word in the guide (#1268)', () => {
  const missing = GUIDE_AGENTS.map((entry) => entry.label).filter((label) => label.includes(' ') && !(KEPT_NAMES as readonly string[]).includes(label));
  assert.deepEqual(missing, [], 'add the name to KEPT_NAMES in src/rules/text/screen.ts');
  // Positive control: without the kept name, a narrow width splits it.
  const lines = wrap('', 'xxxxxxxxxxxx GitHub Copilot CLI', 20);
  assert.deepEqual(lines, ['xxxxxxxxxxxx', 'GitHub Copilot CLI']);
  const plain = wrap('', 'xxxxxxxxxxxx GitHub Copilet CLI', 20);
  assert.deepEqual(plain, ['xxxxxxxxxxxx GitHub', 'Copilet CLI'], 'a name not on the list wraps as plain words');
});
