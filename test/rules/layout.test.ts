// Tests for src/rules/layout.ts.

import '../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULTS } from '../../src/rules/config.ts';
import {
  checkBuildOutput,
  checkCodeOwners,
  checkLayout,
  checkSize,
  codeOwnersPatternMatches,
  foldLayoutHits,
  isBuildOutput,
  isBuildSource,
  sizeCountedFiles,
} from '../../src/rules/layout.ts';
import { isBorrowedFile } from '../../src/run/check.ts';
import { type Finding, formatFinding } from '../../src/rules/text/message.ts';

test('layout: a folder over the cap is reported once, the root never', () => {
  const eight = Array.from({ length: 8 }, (_, i) => `docs/f${i}.md`);
  const rootFiles = Array.from({ length: 20 }, (_, i) => `r${i}`);
  const problems = checkLayout([...eight, ...rootFiles, 'docs/sub/a.md'], DEFAULTS);
  assert.equal(problems.length, 1);
  assert.match(formatFinding(problems[0]), /^docs\/: 9 entries, over the cap of 7/);
  assert.deepEqual(checkLayout(eight.slice(0, 7), DEFAULTS), []);
});

test('layout: an exempt folder may grow', () => {
  const records = Array.from({ length: 30 }, (_, i) => `docs/records/${i}.md`);
  assert.deepEqual(checkLayout(records, { layout: { maxEntries: 7, exempt: ['docs/records/'] } }), []);
});

test('layout: the message offers exempt for a log or a fixture set, not only a log (#381)', () => {
  const problems = checkLayout(Array.from({ length: 8 }, (_, i) => `fixtures/f${i}.xls`), DEFAULTS);
  assert.match(formatFinding(problems[0]), /layout\.exempt in yokoten\.json if it may grow: a log, or a third-party fixture set/);
});

const many = (dir: string, count = 9) => Array.from({ length: count }, (_, i) => `${dir}/f${i}.xls`);

test('layout: an exempt glob covers every crate of a Rust workspace, one segment per * (#381)', () => {
  const files = [...many('crates/app-core/tests/data'), ...many('crates/app-csv/tests/data')];
  const notes: Finding[] = [];
  assert.deepEqual(checkLayout(files, { layout: { maxEntries: 7, exempt: ['crates/*/tests/data'] } }, notes), []);
  assert.deepEqual(notes, []);
  // `*` is one whole folder: it does not reach two levels down, nor match part of a name.
  const deeper = checkLayout(many('crates/app-core/extra/tests/data'), { layout: { maxEntries: 7, exempt: ['crates/*/tests/data'] } });
  assert.equal(deeper.length, 1);
  assert.equal(checkLayout(many('crates/app-core/tests/data'), { layout: { maxEntries: 7, exempt: ['crates/app-*/tests/data'] } }).length, 1);
});

test('layout: ** in an exempt glob is any number of folders, none too (#381)', () => {
  const exempt = { layout: { maxEntries: 7, exempt: ['vendor/**/fixtures'] } };
  assert.deepEqual(checkLayout([...many('vendor/fixtures'), ...many('vendor/a/b/c/fixtures')], exempt), []);
  // The folders on the way stay counted.
  assert.equal(checkLayout(many('vendor/a'), exempt).length, 1);
});

test('layout: a near miss of an exempt glob is still counted (#381)', () => {
  const exempt = { layout: { maxEntries: 7, exempt: ['crates/*/tests/data'] } };
  for (const dir of ['crates/app-core/tests/data2', 'crates/app-core/test/data', 'crates/tests/data', 'other/app-core/tests/data', 'crates/app-core/tests']) {
    assert.equal(checkLayout(many(dir), exempt).length, 1, dir);
  }
  // A dot is a dot, not any character.
  assert.equal(checkLayout(many('docsxrecords'), { layout: { maxEntries: 7, exempt: ['docs.records'] } }).length, 1);
});

test('layout: an exempt glob that matches no folder is a note, an exact path is not (#381)', () => {
  const notes: Finding[] = [];
  const problems = checkLayout(many('docs/records'), { layout: { maxEntries: 7, exempt: ['docs/records', 'crates/*/tests/data', 'docs/old'] } }, notes);
  assert.deepEqual(problems, []);
  assert.equal(notes.length, 1);
  assert.match(formatFinding(notes[0]), /^yokoten\.json: layout\.exempt "crates\/\*\/tests\/data" matches no folder/);
  // Without a notes list, nothing is noted and nothing fails.
  assert.deepEqual(checkLayout([], { layout: { maxEntries: 7, exempt: ['crates/*/tests/data'] } }), []);
});

test('layout: exact exempt paths work as before, with or without a trailing slash (#381)', () => {
  assert.deepEqual(checkLayout(many('docs/records'), { layout: { maxEntries: 7, exempt: ['docs/records'] } }), []);
  assert.deepEqual(checkLayout(many('docs/records'), { layout: { maxEntries: 7, exempt: ['./docs/records/'] } }), []);
  assert.equal(checkLayout(many('a/docs/records'), { layout: { maxEntries: 7, exempt: ['docs/records'] } }).length, 1, 'anchored at the root');
});

test('layout: changes/ may grow, since a release empties it (#132)', () => {
  const changes = Array.from({ length: 12 }, (_, index) => `changes/${index}-a.md`);
  assert.deepEqual(checkLayout(changes, DEFAULTS), []);
  assert.equal(checkLayout(changes.map((file) => `docs/${file}`), DEFAULTS).length, 1, 'only the changes/ folder at the root');
});

test('layout: .worktrees/ is skipped, whole checkouts and all (#571)', () => {
  const trees = [...Array.from({ length: 12 }, (_, i) => `.worktrees/${i}-x/AGENTS.md`), ...many('.worktrees/571-x/src')];
  assert.deepEqual(checkLayout(trees, DEFAULTS), []);
  // A miss by one letter still counts.
  assert.equal(checkLayout(many('worktrees'), DEFAULTS).length, 1);
});

test('build output: build folders and binaries are refused, images, fonts and allowed paths pass (#56)', () => {
  const files = (...paths: string[]) => paths.map((path) => ({ path, binary: !/\.(js|ts|md|svg)$/.test(path) }));
  const problems = checkBuildOutput(files('dist/app.js', 'pkg/build/x.js', 'out/a.md', 'tool.exe', 'lib.wasm', 'data.bin'), DEFAULTS);
  assert.equal(problems.length, 6);
  assert.match(formatFinding(problems[0]), /^dist\/app\.js: build output, in a dist\/ folder\..*git rm --cached dist\/app\.js.*allowBuild in yokoten\.json/);
  assert.match(formatFinding(problems[3]), /^tool\.exe: a binary file\./);
  // Text whose name says built still counts; images and fonts do not.
  assert.equal(checkBuildOutput([{ path: 'lib.wasm', binary: false }], DEFAULTS).length, 1);
  assert.deepEqual(checkBuildOutput(files('docs/a.png', 'site/logo.svg', 'fonts/x.woff2', 'src/output.ts', 'distance.js'), DEFAULTS), []);
  assert.deepEqual(checkBuildOutput(files('dist/app.js', 'vendor/tool.zip'), { allowBuild: ['dist/**', '*.zip'] }), []);
  assert.ok(isBuildOutput('a/dist/b.js') && !isBuildOutput('a/dist/b.js', () => true) && !isBuildOutput('dist.md'));
});

test('build output: source in a build/ folder passes the gate; built files and other output folders do not (#1167)', () => {
  const files = (...paths: string[]) => paths.map((path) => ({ path, binary: false }));
  assert.deepEqual(checkBuildOutput(files('docker/build/Dockerfile', 'build/Makefile', 'build/release.sh', 'build/Dockerfile.dev'), DEFAULTS), []);
  // The controls: built files, a binary by its name, and source in dist/ or out/ stay refused.
  assert.equal(checkBuildOutput(files('build/out.js', 'docker/build/Dockerfile', 'build/tool.so'), DEFAULTS).length, 1, 'both are in build/, so one folder finding');
  assert.equal(checkBuildOutput(files('dist/Makefile', 'out/run.sh', 'dist/build/Dockerfile'), DEFAULTS).length, 2, 'dist is one folder finding, out another');
  assert.ok(isBuildSource('docker/build/Dockerfile') && !isBuildSource('build/out.js') && !isBuildSource('build/tool.so') && !isBuildSource('dist/Makefile'));
  assert.ok(!isBuildOutput('docker/build/Dockerfile') && isBuildOutput('build/out.js'));
});

test('build output: many files under one folder make one finding for the folder (#521)', () => {
  const files = (...paths: string[]) => paths.map((path) => ({ path, binary: false }));
  // A dependency folder: one finding, however many files, and one file alone too.
  const modules = Array.from({ length: 48 }, (_, i) => `node_modules/pkg/dist/f${i}.js`);
  const problems = checkBuildOutput(files(...modules, 'src/a.ts'), DEFAULTS);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].file, 'node_modules/');
  assert.match(formatFinding(problems[0]), /^node_modules\/: a dependency folder, with 48 of its files in the commit\..*git rm -r --cached node_modules.*stays on disk.*add `node_modules\/` to .gitignore/);
  assert.equal(checkBuildOutput(files('web/node_modules/a/dist/x.js'), DEFAULTS)[0].file, 'web/node_modules/');
  // A build folder: two files group, one file keeps its own line.
  const built = checkBuildOutput(files('dist/a.js', 'dist/b.js', 'out/c.js'), DEFAULTS);
  assert.deepEqual(built.map((problem) => problem.file), ['dist/', 'out/c.js']);
  assert.match(formatFinding(built[0]), /^dist\/: build output, with 2 files in a dist\/ folder\..*git rm -r --cached dist/);
  // Every file in node_modules counts, not only built ones; a vendor/ file only when it is built.
  assert.match(formatFinding(checkBuildOutput(files('node_modules/a/index.js', 'node_modules/a/package.json'), DEFAULTS)[0]), /with 2 of its files/);
  assert.deepEqual(checkBuildOutput(files('vendor/lib/a.go'), DEFAULTS), []);
  // allowBuild still lets a path through.
  assert.deepEqual(checkBuildOutput(files('node_modules/a.js'), { allowBuild: ['node_modules/**'] }), []);
});

// ---- CODEOWNERS (#667) ----

const OWNED_FILES = ['.github/CODEOWNERS', 'docs/guide.md', 'src/app.ts', 'src/host/github/index.ts'];

test('codeowners: a line that names a removed file is reported (#667)', () => {
  const found = checkCodeOwners(OWNED_FILES, '# the owners\nsrc/host/github.ts @lead\n');
  assert.equal(found.length, 1);
  assert.equal(found[0]?.id, 'stale-codeowners');
  assert.equal(found[0]?.file, '.github/CODEOWNERS');
  assert.equal(found[0]?.line, 2);
  assert.match(found[0]?.what ?? '', /^src\/host\/github\.ts matches no file: this rule protects nothing; point it at the new path$/);
  assert.match(found[0]?.fix ?? '', /ask the lead or owner to change it in \.github\/CODEOWNERS/);
});

test('codeowners: a folder, a glob and a file that exist are not reported (#667)', () => {
  assert.deepEqual(checkCodeOwners(OWNED_FILES, '/docs/ @lead\nsrc/**/*.ts @lead\n/.github/CODEOWNERS @lead\n* @lead\n'), []);
});

test('codeowners: an empty file, or none, is quiet (#667)', () => {
  assert.deepEqual(checkCodeOwners(OWNED_FILES, ''), []);
  assert.deepEqual(checkCodeOwners(OWNED_FILES, '# nothing is owned yet\n\n'), []);
});

test('codeowners: a lead-only path init wrote before it exists is a guard, not a stale line (#667)', () => {
  assert.deepEqual(checkCodeOwners(OWNED_FILES, '/.codex/ @lead\n', '.github/CODEOWNERS', new Set(['/.codex/'])), []);
  assert.equal(checkCodeOwners(OWNED_FILES, '/.codex/ @lead\n').length, 1);
});

test('codeowners: a pattern with * matches when any file does (#667)', () => {
  assert.equal(codeOwnersPatternMatches('src/*/index.ts', 'src/host/index.ts'), true);
  assert.equal(codeOwnersPatternMatches('src/*/index.ts', 'src/host/github/index.ts'), false);
  assert.equal(codeOwnersPatternMatches('docs/', 'docs/a/b.md'), true);
  assert.equal(codeOwnersPatternMatches('*.md', 'deep/a/b.md'), true);
  assert.equal(codeOwnersPatternMatches('docs/**/a.md', 'docs/a.md'), true);
});

test('codeowners: a section header names no path and is not reported (#667)', () => {
  assert.deepEqual(checkCodeOwners(OWNED_FILES, '[Documentation]\n^[Security]\n[Docs][2]\n[Docs] @docs-team\n/docs/ @lead\n'), []);
  assert.equal(codeOwnersPatternMatches('/docs/', 'docs'), false, 'a folder pattern needs something inside it');
});

test('codeowners: a [class] matches one character, not the brackets (#667)', () => {
  assert.deepEqual(checkCodeOwners(OWNED_FILES, 'src/*.[jt]s @lead\n'), []);
  assert.equal(codeOwnersPatternMatches('src/*.[jt]s', 'src/app.ts'), true);
  assert.equal(codeOwnersPatternMatches('src/*.[jt]s', 'src/app.tsx'), false);
});

test('codeowners: a [class] that cannot compile is a stale line, not a crash (#667)', () => {
  const found = checkCodeOwners(OWNED_FILES, 'src/[z-a].ts @lead\n');
  assert.equal(found.length, 1, 'one malformed line does not throw or hide the other lines');
  assert.equal(found[0]?.id, 'stale-codeowners');
  assert.equal(found[0]?.line, 1);
  assert.equal(codeOwnersPatternMatches('src/[z-a].ts', 'src/z.ts'), false, 'the class is read as its own text, not a range');
  assert.equal(codeOwnersPatternMatches('src/[z-a].ts', 'src/[z-a].ts'), true);
});

test('codeowners: an escaped star matches no checkout file, so the line is stale (#790)', () => {
  const found = checkCodeOwners(OWNED_FILES, '\\* @lead\n');
  assert.equal(found.length, 1, 'the escaped star does not match every file');
  assert.equal(found[0]?.id, 'stale-codeowners');
  assert.deepEqual(checkCodeOwners(['*'], '\\* @lead\n'), [], 'a file called star is a match');
  assert.equal(codeOwnersPatternMatches('\\*', 'src/a.ts'), false);
});

test('codeowners: an escaped space stays inside the pattern (#667)', () => {
  const files = [...OWNED_FILES, 'docs/my file.md'];
  assert.deepEqual(checkCodeOwners(files, 'docs/my\\ file.md @lead\n'), []);
  assert.equal(codeOwnersPatternMatches('docs/my\\ file.md', 'docs/my file.md'), true);
});

// #1169: a repo that has not chosen the cap gets its folder hits as one note.
test('layout: the hits of a repo that has not chosen the cap fold into one note (#1169)', () => {
  const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].flatMap((dir) => Array.from({ length: 9 }, (_, i) => `${dir}/${i}.md`));
  const hits = checkLayout(files, DEFAULTS);
  assert.equal(hits.length, 7);
  const note = foldLayoutHits(hits, DEFAULTS);
  assert.equal(note?.id, 'layout');
  assert.equal(note?.what, '7 folders hold more than 7 entries: a/, b/, c/, d/, e/, and 2 more');
  assert.match(note?.fix ?? '', /add `"layout": { "maxEntries": 7 }` to yokoten\.json/);
  assert.equal(foldLayoutHits(hits.slice(0, 1), DEFAULTS)?.what, '1 folder holds more than 7 entries: a/');
  assert.equal(foldLayoutHits([], DEFAULTS), null);
});

// ---- The project size ----

const sizeReads = { isBorrowed: isBorrowedFile };
const sizeConfig = (size: Partial<typeof DEFAULTS.size> = {}) => ({ size: { ...DEFAULTS.size, ...size } });

test("size: the project's own code counts; tests, benches, vendored, fetched and borrowed code don't", () => {
  const cases: [string, boolean][] = [
    ['src/a.ts', true],
    ['bin/main.ts', true],
    ['web/app.tsx', true],
    ['scripts/build.mjs', true],
    ['src/a.md', false],
    ['src/a.json', false],
    ['test/a.ts', false],
    ['tests/a.ts', false],
    ['src/__tests__/a.ts', false],
    ['benches/a.ts', false],
    ['src/a.test.ts', false],
    ['src/a.spec.ts', false],
    ['src/a_test.ts', false],
    ['vendor/lib/a.ts', false],
    ['web/node_modules/x/a.js', false],
    ['src/borrowed/a.ts', false],
    ['.worktrees/issue-1/src/a.ts', false],
    ['src/testing/a.ts', true],
    ['src/latest.ts', true],
    // Every language counts, not JS/TS only; docs, config, data and minified output don't.
    ['src/main.rs', true],
    ['src/lib/mod.rs', true],
    ['examples/demo.rs', true],
    ['tests/it.rs', false],
    ['crates/x/tests/it.rs', false],
    ['crates/x/src/lib.rs', true],
    ['benches/speed.rs', false],
    ['vendor/dep/src/lib.rs', false],
    ['cmd/main.go', true],
    ['cmd/main_test.go', false],
    ['app/models.py', true],
    ['app/test_models.py', false],
    ['test_app.py', false],
    ['app/latest_test.py', false],
    ['bin/run.sh', true],
    ['lib/a.c', true],
    ['lib/a.H', true],
    ['site/page.astro', true],
    ['site/app.css', true],
    ['site/index.html', true],
    ['Cargo.toml', false],
    ['Cargo.lock', false],
    ['config.yaml', false],
    ['data.csv', false],
    ['logo.png', false],
    ['web/app.min.js', false],
    ['web/app.js.map', false],
    ['Makefile', false],
    ['.bashrc', false],
  ];
  for (const [path, isCounted] of cases) assert.equal(sizeCountedFiles([path], sizeConfig(), sizeReads).length === 1, isCounted, path);
});

test('size: size.exempt reads folders and globs as layout.exempt does', () => {
  const files = ['src/a.ts', 'generated/b.ts', 'generated/deep/c.ts', 'crates/one/gen/d.ts', 'crates/one/two/gen/e.ts', 'docs.records/f.ts', 'docsxrecords/g.ts'];
  const counted = (exempt: string[]) => sizeCountedFiles(files, sizeConfig({ exempt }), sizeReads);
  assert.deepEqual(counted(['generated/']), ['src/a.ts', 'crates/one/gen/d.ts', 'crates/one/two/gen/e.ts', 'docs.records/f.ts', 'docsxrecords/g.ts']);
  // `*` is one whole folder, `**` any number of folders; a dot is a dot.
  assert.deepEqual(counted(['crates/*/gen']), ['src/a.ts', 'generated/b.ts', 'generated/deep/c.ts', 'crates/one/two/gen/e.ts', 'docs.records/f.ts', 'docsxrecords/g.ts']);
  assert.deepEqual(counted(['crates/**/gen', 'docs.records']), ['src/a.ts', 'generated/b.ts', 'generated/deep/c.ts', 'docsxrecords/g.ts']);
  // An exempt entry is anchored at the root.
  assert.deepEqual(counted(['deep']), files);
});

test('size: no config, a fork, at the cap, near it and over it', () => {
  const files = ['src/a.ts', 'src/b.ts', 'test/a.test.ts'];
  const lines: Record<string, number> = { 'src/a.ts': 60, 'src/b.ts': 40, 'test/a.test.ts': 900 };
  const run = (size: Partial<typeof DEFAULTS.size>, isChosen = true) => {
    const notes: Finding[] = [];
    const problems = checkSize(files, (path) => lines[path] ?? 0, sizeConfig(size), { ...sizeReads, isChosen }, notes);
    return { problems: problems.map(formatFinding), notes: notes.map(formatFinding) };
  };
  // No "size" key: never a problem, one note with the count and the way to turn it on.
  const none = run({ maxLines: 50 }, false);
  assert.deepEqual(none.problems, []);
  assert.equal(none.notes.length, 1);
  assert.match(none.notes[0], /^100 lines of the project's own code; no cap is set/);
  // The cap it offers is the count rounded up when that is over the default, so it passes.
  assert.match(none.notes[0], /add `"size": \{ "maxLines": 100 \}` to yokoten\.json/);
  assert.match(run({ maxLines: 5000 }, false).notes[0], /"maxLines": 5000 \}/, 'under the default, the default');
  assert.match(run({ maxLines: 99 }, false).notes[0], /"maxLines": 100 \}/, 'an exact hundred stays');
  // A fork: the count is a note, whatever the cap.
  const fork = run({ maxLines: 50, fork: true });
  assert.deepEqual(fork.problems, []);
  assert.match(fork.notes[0], /^100 lines .*; a fork/);
  // Well under the cap: nothing. Within 10% of it, or right at it: a note.
  assert.deepEqual(run({ maxLines: 200 }), { problems: [], notes: [] });
  assert.deepEqual(run({ maxLines: 112 }), { problems: [], notes: [] });
  assert.match(run({ maxLines: 110 }).notes[0] ?? '', /^100 lines .*, within 10% of the cap of 110/);
  const at = run({ maxLines: 100 });
  assert.deepEqual(at.problems, []);
  assert.equal(at.notes.length, 1);
  // Over the cap: one problem with the count, the cap and the biggest files; the fix names fork.
  const over = run({ maxLines: 99 });
  assert.deepEqual(over.notes, []);
  assert.equal(over.problems.length, 1);
  assert.match(over.problems[0], /^100 lines of the project's own code, over the cap of 99; the biggest: src\/a\.ts \(60\), src\/b\.ts \(40\)/);
  assert.match(over.problems[0], /Cut code .*"fork": true/);
  // A repo with no counted code gets nothing at all.
  assert.deepEqual(checkSize(['README.md'], () => 10, sizeConfig(), { ...sizeReads, isChosen: false }, []), []);
});

test('size: an over-cap problem names the five biggest files, biggest first', () => {
  const files = Array.from({ length: 7 }, (_, i) => `src/f${i}.ts`);
  const [problem] = checkSize(files, (path) => 10 * (Number(/\d/.exec(path)?.[0]) + 1), sizeConfig({ maxLines: 10 }), { ...sizeReads, isChosen: true }, []);
  assert.match(problem?.what ?? '', /the biggest: src\/f6\.ts \(70\), src\/f5\.ts \(60\), src\/f4\.ts \(50\), src\/f3\.ts \(40\), src\/f2\.ts \(30\)$/);
});
