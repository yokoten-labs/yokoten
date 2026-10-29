// Tests for src/run/changelog.ts.

import '../repo/home.ts';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeTempDir } from '../repo/helpers.ts';
import {
  changelogProblemsScreen,
  changelogScreen,
  formatChanges,
  mergeChanges,
  parseChange,
  readChanges,
  writeChanges,
  releaseNotes,
} from '../../src/run/changelog.ts';
import { finding } from '../../src/rules/text/message.ts';

// ---- Change files (#132) ----

const CHANGELOG = [
  '# Changelog',
  '',
  '## [Unreleased]',
  '',
  '### Added',
  '',
  '- An old entry,',
  '  wrapped.',
  '',
  '### Fixed',
  '',
  '- An old fix.',
  '',
  '## [0.1.0] - 2026-10-18',
  '',
  '### Added',
  '',
  '- The first release.',
  '',
].join('\n');

/** A folder with CHANGELOG.md and the change files given, by name. */
function makeRepo(files: Record<string, string>): string {
  const root = makeTempDir();
  mkdirSync(join(root, 'changes'));
  writeFileSync(join(root, 'CHANGELOG.md'), CHANGELOG);
  writeFileSync(join(root, 'changes', 'README.md'), '# Change files\n\nNot a change.\n');
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, 'changes', name), content);
  return root;
}

test('changes: a file is a section, a blank line, then the entry; a bullet is added when missing', () => {
  assert.deepEqual(parseChange('changes/1-a.md', 'Fixed\n\nA crash,\nwhen empty.\n'), { change: { file: 'changes/1-a.md', section: 'Fixed', lines: ['- A crash,', '  when empty.'] }, problems: [] });
  assert.deepEqual(parseChange('changes/1-a.md', 'added\r\n\r\n- One.\r\n- Two.\r\n').change?.lines, ['- One.', '- Two.'], 'several bullets, CRLF, any case');
  const bad = (content: string, file = 'changes/1-a.md') => parseChange(file, content).problems.map((problem) => `${problem.line ?? '-'}: ${problem.what}`);
  assert.deepEqual(bad('Improved\n\nA thing.\n'), ['1: line 1 is not a section']);
  assert.deepEqual(bad('Added\nA thing.\n'), ['2: line 2 is not blank']);
  assert.deepEqual(bad('Added\n\n\n'), ['1: no entry after the section']);
  assert.deepEqual(bad('Added\n'), ['1: no entry after the section']);
  assert.deepEqual(bad('Added\n\nA thing.\n', 'changes/1-a.txt'), ['-: a change file is not Markdown']);
  // A heading would go into CHANGELOG.md as is, even a fake version (#281).
  assert.deepEqual(bad('Added\n\n- A thing.\n## 9.9.9\n'), ['4: line 4 is a heading']);
  assert.deepEqual(bad('Added\n\n### Fixed\n'), ['3: line 3 is a heading']);
  assert.deepEqual(bad('Added\n\nA thing,\n#281 and more.\n'), [], 'an issue number is not a heading');
  assert.equal(parseChange('changes/1-a.md', 'Improved\n\nsecret words\n').problems.every((problem) => !JSON.stringify(problem).includes('secret words')), true, 'the text is never printed back');
});

test('changes: the collector groups and orders the sections, and skips README.md', () => {
  const root = makeRepo({ '132-b.md': 'Fixed\n\nB.\n', '9-a.md': 'Internal\n\nA.\n', '10-c.md': 'Added\n\nC.\n', '200-d.md': 'Fixed\n\nD.\n' });
  const { changes, problems } = readChanges(root);
  assert.deepEqual(problems, []);
  assert.deepEqual(changes.map((change) => change.file), ['changes/9-a.md', 'changes/10-c.md', 'changes/132-b.md', 'changes/200-d.md'], 'by issue number');
  assert.deepEqual(formatChanges(changes), ['### Added', '', '- C.', '', '### Fixed', '', '- B.', '- D.', '', '### Internal', '', '- A.']);
  assert.deepEqual(readChanges(makeTempDir()), { changes: [], problems: [] }, 'no changes/ folder');
});

test('changes: a link in changes/, dangling or not, is a finding, never a crash (#281)', () => {
  const root = makeRepo({ '1-good.md': 'Added\n\nGood.\n' });
  symlinkSync(join(root, 'changes', '1-good.md'), join(root, 'changes', '2-link.md'));
  symlinkSync(join(root, 'nowhere.md'), join(root, 'changes', '3-dangling.md'));
  const { changes, problems } = readChanges(root);
  assert.deepEqual(changes.map((change) => change.file), ['changes/1-good.md']);
  assert.deepEqual(problems.map((problem) => [problem.id, problem.file]), [['change-file', 'changes/2-link.md'], ['change-file', 'changes/3-dangling.md']]);
});

test('changes: a bad file is refused, and nothing is written or deleted', () => {
  const root = makeRepo({ '1-good.md': 'Added\n\nGood.\n', '2-bad.md': 'Improved\n\nBad.\n' });
  const { changes, problems } = writeChanges(root);
  assert.deepEqual(changes, []);
  assert.deepEqual(problems.map((problem) => [problem.id, problem.file, problem.line]), [['change-file', 'changes/2-bad.md', 1]]);
  assert.equal(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), CHANGELOG);
  assert.ok(existsSync(join(root, 'changes', '1-good.md')) && existsSync(join(root, 'changes', '2-bad.md')));
  // No Unreleased heading: refused too.
  writeFileSync(join(root, 'changes', '2-bad.md'), 'Fixed\n\nNow good.\n');
  writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n\n## [0.1.0]\n');
  assert.match(writeChanges(root).problems[0]?.what ?? '', /no `## \[Unreleased\]` heading/);
  assert.ok(existsSync(join(root, 'changes', '1-good.md')));
});

test('changes: --write puts each entry after its section, deletes the files, and keeps released versions', () => {
  const root = makeRepo({ '5-a.md': 'Added\n\nNew A.\n', '6-b.md': 'Changed\n\nNew B,\nwrapped.\n', '7-c.md': 'Internal\n\nNew C.\n', '8-d.md': 'Fixed\n\nNew D.\n' });
  const { changes, problems } = writeChanges(root);
  assert.deepEqual(problems, []);
  assert.equal(changes.length, 4);
  const written = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
  const [unreleased, released] = written.split('## [0.1.0]');
  assert.equal(`## [0.1.0]${released}`, CHANGELOG.slice(CHANGELOG.indexOf('## [0.1.0]')), 'released versions are not touched');
  assert.equal(
    unreleased,
    ['# Changelog', '', '## [Unreleased]', '', '### Added', '', '- An old entry,', '  wrapped.', '- New A.', '', '### Changed', '', '- New B,', '  wrapped.', '', '### Fixed', '', '- An old fix.', '- New D.', '', '### Internal', '', '- New C.', '', ''].join('\n'),
  );
  assert.deepEqual(readChanges(root), { changes: [], problems: [] }, 'the used files are gone');
  assert.ok(existsSync(join(root, 'changes', 'README.md')), 'the README stays');
  // An empty Unreleased gets its first heading.
  const merged = mergeChanges('# Changelog\n\n## [Unreleased]\n\n## [0.1.0]\n', changes.slice(0, 1));
  assert.equal(merged, '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- New A.\n\n## [0.1.0]\n');
  // A CRLF file stays CRLF (#281).
  const crlf = mergeChanges(CHANGELOG.replaceAll('\n', '\r\n'), changes);
  assert.equal(crlf, written.replaceAll('\n', '\r\n'));
  // One stray CRLF line: the file is still read, and its lines keep their bytes (#281).
  const [firstLine, ...otherLines] = CHANGELOG.split('\n');
  const mixed = mergeChanges([`${firstLine}\r`, ...otherLines].join('\n'), changes);
  assert.equal(typeof mixed, 'string', 'a stray CRLF line still has an Unreleased heading');
  assert.ok((mixed as string).startsWith(CHANGELOG.split('\n')[0] + '\r\n'), 'the CRLF line is kept');
});

// Release notes come from the CHANGELOG section, never typed twice (#980).
test('changelog --notes: the opening of a version section, and a link to all of it', () => {
  const log = '# Changelog\n\n## [Unreleased]\n\n## [1.2.0] - 2026-01-02\n\nThe big one.\n\n- **New:** a thing.\n\n### Added\n\n- A long list.\n\n## [1.1.0] - 2025-12-01\n\nOld.\n';
  assert.equal(
    releaseNotes(log, '1.2.0', 'https://github.com/o/r'),
    'The big one.\n\n- **New:** a thing.\n\n## Everything in 1.2.0\n\nThe full list, with every change, is in the [changelog](https://github.com/o/r/blob/v1.2.0/CHANGELOG.md#120---2026-01-02).\n',
  );
  assert.ok(!releaseNotes(log, '1.2.0', null)?.includes('A long list'), 'the full list stays out of the notes');
  assert.match(releaseNotes(log, '1.2.0', null) ?? '', /\]\(CHANGELOG\.md#120---2026-01-02\)/, 'off GitHub the link is the file');
  assert.equal(releaseNotes(log, '9.9.9', null), null, 'a version with no section');
  assert.match(releaseNotes(log, '1.1.0', null) ?? '', /^Old\.\n/, 'the last section ends at the end of the file');
});

test('changelogScreen: rows through table(), the problems screen ends with a Next line', () => {
  const lines = changelogScreen([{ file: 'changes/1-a.md', section: 'Added', lines: ['- A thing.', '  over two lines'] }], false);
  assert.deepEqual(lines, ['yokoten changelog · 1 entry for the next release', '', '  Added  A thing. over two lines', '', 'More: before a release: `yokoten changelog --write`']);
  assert.deepEqual(changelogScreen([], true), ['yokoten changelog · no change files in changes/, nothing to add']);
  const problems = changelogProblemsScreen([finding('change-file', 'no entry after the section', 'write the entry', { file: 'changes/3-c.md', line: 1 })]);
  assert.equal(problems.at(-1), 'Next: `yokoten changelog`');
  assert.match(problems.join('\n'), /1 problem; nothing was written/);
});

// #1239: a problem with a place and one without start their text in one column.
test('changelogProblemsScreen: a problem with no place and one with a place share one text column (#1239)', () => {
  const lines = changelogProblemsScreen([
    finding('change-file', 'no entry after the section', 'write the entry', { file: 'changes/3-c.md', line: 1 }),
    finding('change-file', 'two sections', 'keep one'),
  ]);
  const at = (text: string) => lines.find((line) => line.includes(text))?.search(/\S/g) ?? -1;
  const column = (text: string) => (lines.find((line) => line.includes(text)) ?? '').indexOf(text);
  assert.equal(column('two sections'), 26, lines.join('\n'));
  assert.equal(column('no entry after the section'), 26, lines.join('\n'));
  assert.equal(column('keep one'), 26);
  assert.ok(at('write the entry') >= 0);
});
