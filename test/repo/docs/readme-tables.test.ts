// The READMEs show a short copy of the guide's "Works with" table (#960), and the
// refusal sample is the hook's output to the word. The four copies drift when they are
// fixed by hand, so a test holds each one to the source: the guide's table, and the
// refusal the guard writes for `git push origin v1.2.0`.

import '../home.ts';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { GUIDE_AGENTS, worksWithTable } from '../../../src/agents/runtimes/runtime.ts';
import { checkCommand } from '../../../src/rules/guards/commands/check.ts';
import { formatRefusal } from '../../../src/rules/text/message.ts';
import { VERSION } from '../../../src/setup/files.ts';
import { ROOT } from '../helpers.ts';

const FILES = ['README.md', 'docs/i18n/zh-CN/README.md', 'docs/i18n/zh-TW/README.md', 'docs/i18n/ja/README.md'];
const HEADINGS = new Map<string, string>([
  ['README.md', '## Works with'],
  ['docs/i18n/zh-CN/README.md', '## 支持哪些工具'],
  ['docs/i18n/zh-TW/README.md', '## 支援範圍'],
  ['docs/i18n/ja/README.md', '## 対応しているもの'],
]);

const read = (file: string): string => readFileSync(join(ROOT, file), 'utf8');
/** The cells of one Markdown table row. */
const cellsOf = (line: string): string[] => line.slice(1, line.endsWith('|') ? -1 : undefined).split('|').map((cell) => cell.trim());

/**
 * The rows of the first table after the heading `text` names: one array of cells per
 * row, the header and the separator dropped, until a line outside the table.
 */
function tableAfterHeading(text: string, heading: string): string[][] {
  const lines = text.split('\n');
  const at = lines.findIndex((line) => line === heading);
  assert.ok(at >= 0, `no ${heading} heading found`);
  const start = lines.findIndex((line, index) => index > at && line.startsWith('|'));
  assert.ok(start >= 0, 'no table under the heading');
  const rows: string[][] = [];
  for (const line of lines.slice(start)) {
    if (!line.startsWith('|')) break;
    if (/^\|[-| ]+\|?$/.test(line)) continue;
    rows.push(cellsOf(line));
  }
  return rows;
}

/** The model names a cell holds: backticked spans with no space, keeping a short note in brackets. */
function modelsOf(cell: string): string[] {
  const models: string[] = [];
  // A bare word in backticks, with no dash and no digit (such as `init`), or a command
  // over more than one word (`muse exec --trust-workspace`), is not a model.
  const nonModel = (token: string): boolean => token.includes(' ') || !/[-0-9]/.test(token);
  for (const match of cell.matchAll(/`([^`]+)`(\s*\([^)]{1,12}\))?/g)) {
    if (!nonModel(match[1])) models.push(match[0].replace(/\s+/g, ' ').trim());
  }
  if (models.length > 0) return models;
  const named = /default[^,]*/.exec(cell);
  return named ? [`the ${named[0].trim()}`] : [];
}

/** The end-to-end mark the guide keeps: `yes, <date and how>` or `not run end to end`. */
const endToEndOf = (cell: string): string => (cell.startsWith('yes') ? 'yes' : cell.startsWith('not run end to end') ? 'not yet' : `unreadable: ${cell}`);

export interface AgentFacts {
  label: string;
  endToEnd: string;
  trust: string;
  models: string[];
}

const isHeaderRow = (cells: string[]): boolean => cells[0] === 'Agent' || cells[0] === 'エージェント';

/** The guide's facts, one per agent row: the only list the READMEs are read against. */
function guideFacts(guide: string): AgentFacts[] {
  return tableAfterHeading(guide, '## Works with')
    .filter((cells) => !isHeaderRow(cells) && cells[0] !== 'Any other agent')
    .map((cells) => ({
      label: cells[0],
      endToEnd: endToEndOf(cells[4]),
      trust: cells[5].includes('`yokoten trust`') ? 'yes' : 'no',
      models: modelsOf(cells[4]),
    }));
}

/** The agents table of a README, by the same shape the guide's rows keep. */
function readmeFacts(readme: string, heading: string): AgentFacts[] {
  return tableAfterHeading(readme, heading)
    .filter((cells) => !isHeaderRow(cells))
    .map((cells) => ({
    label: cells[0],
    // A verified row shows a green mark before `yes` (owner 2026-10-25), so the eye finds them.
    endToEnd: cells[1] === "✅ yes" ? "yes" : cells[1] === "yes" ? "unmarked yes" : cells[1],
    trust: cells[2],
    models: modelsOf(cells[3]),
  }));
}

/** What makes a README's agents table differ from the guide's, one problem per row part. */
function tableProblems(facts: AgentFacts[], guide: AgentFacts[]): string[] {
  if (facts.length !== guide.length) return [`row count: ${facts.length} rows, the guide holds ${guide.length}`];
  return facts.flatMap((shown, index) => {
    const row = guide[index];
    if (shown.label !== row.label) return [`row ${index + 1}: the agent is ${shown.label}, the guide has ${row.label}`];
    if (shown.endToEnd !== row.endToEnd) return [`${row.label}: verified end to end is ${shown.endToEnd}, the guide says ${row.endToEnd}`];
    if (shown.trust !== row.trust) return [`${row.label}: needs npx yokoten trust is ${shown.trust}, the guide says ${row.trust}`];
    if (shown.models.join('|') !== row.models.join('|')) return [`${row.label}: models are ${shown.models.join(', ')}, the guide says ${row.models.join(', ')}`];
    return [];
  });
}

test('the READMEs copy the guide agents table, row for row', () => {
  const guide = guideFacts(read('docs/guide.md'));
  assert.ok(guide.length >= 9, `the guide holds ${guide.length} agent rows, fewer than today's nine`);
  const problems = FILES.flatMap((file) => tableProblems(readmeFacts(read(file), HEADINGS.get(file) ?? ''), guide).map((one) => `${file}: ${one}`));
  assert.deepEqual(problems, []);
});

// A known-bad input, to show the test catches a README row that differs from the guide:
// one model renamed here.
test('control: a README agents row that differs from the guide is caught', () => {
  const guide = guideFacts(read('docs/guide.md'));
  const doctored = read('README.md').replace('`deepseek-flash`', '`other-model`').replace('| Codex&nbsp;CLI | ✅ yes | yes |', '| Codex&nbsp;CLI | ✅ yes | no |');
  assert.ok(tableProblems(readmeFacts(doctored, '## Works with'), guide).some((one) => one.includes('other-model')), 'a changed model in a README row was not caught');
  const drifted = read('README.md').replace('| Codex&nbsp;CLI | ✅ yes | yes |', '| Codex&nbsp;CLI | ✅ yes | no |');
  assert.ok(tableProblems(readmeFacts(drifted, '## Works with'), guide).some((one) => one.startsWith('Codex&nbsp;CLI')), 'a changed trust value in a README row was not caught');
});

// #1268: on GitHub a narrow column broke "GitHub Copilot / CLI" and split a model ID at its
// hyphen. An agent's name opens a row with &nbsp; between its words, so a narrow column wraps
// only between whole names. (A README may not use `<br>`, #832, so a models cell keeps its commas.)
const GUIDES = ['docs/guide.md', 'docs/i18n/zh-CN/guide.md', 'docs/i18n/ja/guide.md'];
/** The multi-word agent names a table may open a row with: the guide's labels, and Copilot's short name. */
const AGENT_NAMES = [...GUIDE_AGENTS.map((entry) => entry.label), 'Copilot CLI'].filter((name) => name.includes(' '));

/** Each table row of `text` whose first cell starts with an agent name written with a plain space (`Claude Code (…)` too). */
function brokenNameRows(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .map((line) => cellsOf(line)[0] ?? '')
    .filter((cell) => AGENT_NAMES.some((name) => cell.startsWith(name)));
}

/** Every Markdown file under docs/ but the records, which are history and never rewritten. */
const DOCS = (function walk(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return path === 'docs/records' ? [] : walk(path);
    return path.endsWith('.md') ? [path] : [];
  });
})('docs');

test('tables: an agent name never breaks inside itself (#1268)', () => {
  assert.ok(AGENT_NAMES.includes('GitHub Copilot CLI') && AGENT_NAMES.length >= 8, 'the agent names are not read from the guide');
  assert.match(worksWithTable(), /^\| GitHub&nbsp;Copilot&nbsp;CLI \|/m, 'the generated table keeps the name whole');
  const names = [...new Set([...FILES, ...GUIDES, ...DOCS])].flatMap((file) => brokenNameRows(read(file)).map((cell) => `${file}: ${cell}`));
  assert.deepEqual(names, [], 'write the name with &nbsp; between its words');
});

// Known-bad input: a plain space in a name is caught.
test('control: a name with a plain space is caught (#1268)', () => {
  assert.deepEqual(brokenNameRows('| Agent | Note |\n|---|---|\n| GitHub Copilot CLI | x |\n| Codex&nbsp;CLI | y |\n| Any other agent | z |\n| Claude Code (cloud) | w |'), ['GitHub Copilot CLI', 'Claude Code (cloud)']);
});

// The site shows the same tables: a code span in a cell stays on one line, and the table scrolls.
test('site: a code span in a docs table cell does not wrap (#1268)', () => {
  const shell = read('web/site/site/src/components/frame/DocsShell.astro');
  assert.match(shell, /\.prose td code\) \{ white-space: nowrap; \}/, 'DocsShell.astro: keep `white-space: nowrap` on `.prose td code`');
  assert.match(shell, /\.prose table\) \{[^}]*display: block;[^}]*max-width: 100%;[^}]*overflow-x: auto;/, 'DocsShell.astro: a wide table must scroll in its own box, or a nowrap cell overflows a phone');
});

/** The refusal sample of a README: the fenced block that starts with the refusal title. */
function refusalSample(text: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.startsWith('yokoten stopped this: '));
  assert.ok(start >= 0, 'no refusal sample found');
  const end = lines.findIndex((line, index) => index > start && line === '```');
  return lines.slice(start, end).join('\n');
}

/** What makes a README refusal sample differ from the hook's output, for one README. */
function refusalProblems(text: string): string[] {
  const found = checkCommand('git push origin v1.2.0', { cwd: process.cwd(), env: {} });
  assert.ok(found, 'the guard does not refuse `git push origin v1.2.0` any more');
  const expected = formatRefusal(found);
  return refusalSample(text) === expected ? [] : [`the sample differs from the hook's output:\n  expected: ${expected.split('\n').join('\n  ')}\n  actual:   ${refusalSample(text).split('\n').join('\n  ')}`];
}

test('the README refusal sample is the hook output for `git push origin v1.2.0`', () => {
  const problems = FILES.flatMap((file) => refusalProblems(read(file)).map((one) => `${file}: ${one}`));
  assert.deepEqual(problems, []);
});

// A known-bad input, to show the test catches a sample with one word changed.
test('control: a refusal sample with one word changed is caught', () => {
  const doctored = read('README.md').replace('Only the owner decides when to release.', 'Only the agent decides when to release.');
  assert.ok(refusalProblems(doctored).length > 0, 'a changed refusal sample was not caught');
});

// npm shows package.json's description in search and the README on the page: one text,
// kept in the README (10-25: the description still said an old line at a release tag).
/** The README's opening: its first two paragraphs after the title and the badges, joined as one line. */
function readmeOpening(readme: string): string {
  const paragraphs = readme.split(/\n\s*\n/).map((part) => part.trim()).filter((part) => part !== '' && !/^\[!\[/.test(part));
  return paragraphs.slice(1, 3).join(' ');
}

test('npm: package.json describes yokoten in the README\'s own opening words', () => {
  assert.equal(readmeOpening('# x · y\n\nA guard.\n\nIt stops mistakes.\n\n- a list\n'), 'A guard. It stops mistakes.');
  assert.equal(readmeOpening('# x · y\n\n[![npm](b.svg)](n)\n[![ci](c.svg)](c)\n\nA guard.\n\nIt stops mistakes.\n'), 'A guard. It stops mistakes.', 'the badges are not the opening');
  const description: string = JSON.parse(read('package.json')).description;
  assert.notEqual(description, 'A guard. It stops mistakes.', 'positive control: a different text is not equal');
  assert.equal(description, readmeOpening(read('README.md')), 'copy the README\'s first two paragraphs into package.json "description"');
});

// The Claude plugin directory lists .claude-plugin/plugin.json: its description is the same
// one sentence (#1223). It has no version on purpose: the marketplace ref is the version (#632).
test('plugin: plugin.json says the README opening (#1223)', () => {
  const plugin = JSON.parse(read('.claude-plugin/plugin.json')) as { description: string };
  assert.equal(plugin.description, readmeOpening(read('README.md')), 'copy the opening of README.md into .claude-plugin/plugin.json "description"');
});

// The site's facts come from the newest release tag, so its brand list must name each agent as
// either README does: an older one wrote `Antigravity CLI (agy)`, later ones `Antigravity CLI` (#1268).
test('site: every home-page brand finds its agent in the released and the current README', () => {
  const brands = read('web/site/site/src/lib/page/brands.ts');
  const agentName = (name: string): string => name.replace(/\s*\([^)]*\)$/, '').trim();
  assert.match(brands, /agentName\(a\.agent\) === agentName\(brand\.readme\)/, 'brandsFor compares names without a bracketed note');
  const names = [...brands.matchAll(/readme: '([^']+)'/g)].map((match) => match[1]);
  assert.ok(names.length >= 8, 'the brand list is read');
  const released = (JSON.parse(read('web/site/site/src/content/generated/facts/agents.json')) as { agent: string }[]).map((entry) => agentName(entry.agent));
  const current = tableAfterHeading(read('README.md'), '## Works with').map((cells) => agentName(cells[0].replace(/&nbsp;/g, ' ')));
  for (const name of names) {
    assert.ok(released.includes(agentName(name)), `${name}: not in the released agents.json`);
    assert.ok(current.includes(agentName(name)), `${name}: not in the README's Works with table`);
  }
  assert.equal(agentName('Antigravity CLI (agy)'), 'Antigravity CLI', 'positive control: the note goes');
});

// #1282: PR #1245 wrote a planned version into the sample, and the release carried it to npm.
/** The version the first-run sample of a README shows; null with no sample. */
const sampleVersion = (text: string) => /^yokoten (\S+) · set up;/m.exec(text)?.[1] ?? null;
/** The major and minor the status line of a guide shows; null with none. */
const statusVersion = (text: string) => /^(?:Version|バージョン|版本) (\d+\.\d+)。?\.?/m.exec(text)?.[1] ?? null;

test('versions: the first-run sample and the guide status line follow package.json; a release updates them (#1282)', () => {
  for (const path of ['README.md', 'docs/i18n/ja/README.md', 'docs/i18n/zh-CN/README.md', 'docs/i18n/zh-TW/README.md']) {
    assert.equal(sampleVersion(read(path)), VERSION, `${path}: the first-run sample names another version`);
  }
  for (const path of ['docs/guide.md', 'docs/i18n/ja/guide.md', 'docs/i18n/zh-CN/guide.md']) {
    assert.equal(statusVersion(read(path)), VERSION.split('.').slice(0, 2).join('.'), `${path}: the status line names another version`);
  }
});

test('control: a sample or a status line with another version is read as that version (#1282)', () => {
  assert.equal(sampleVersion('text\nyokoten 9.9.9 · set up; stage 1 of 5, safety net\n'), '9.9.9');
  assert.equal(sampleVersion('no sample here\n'), null);
  assert.equal(statusVersion('Version 9.9. The decisions\n'), '9.9');
  assert.equal(statusVersion('版本 9.9。背后的决定\n'), '9.9');
});
