// Tests for src/setup/init.ts: Dependabot, CODEOWNERS and the CLAUDE.md import, and the core rules it moves into AGENTS.md.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { at, makeSandbox, makeTempDir, ROOT, rowsText, shareGuardMeasure, shareSelfTest, stepMark } from '../../repo/helpers.ts';
import { DEFAULTS } from '../../../src/rules/config.ts';
import { parseCodeOwners } from '../../../src/rules/pr.ts';
import { readCodeOwners } from '../../../src/host/github/index.ts';
import { KIT, render, VERSION } from '../../../src/setup/files.ts';
import { AGENTS_BACKUP, changeText, compareCoreRules, demoteHeadings, findEcosystems, findRulesGap, importRules, moveUnderProjectHeading, readDependabotEcosystems, readKitVersion, resultLines, splitFrontMatter, type Step, stepOf, writeCodeOwners, writeDependabot } from '../../../src/setup/init.ts';
import { ROAD } from '../../../src/setup/road.ts';
import { initIn, has, noted, said, stubGh, folderWith, NO_SYMLINK } from './helpers.ts';

shareGuardMeasure();
shareSelfTest();

/** The paths CODEOWNERS should name: each lead-only default, a `x/**` glob as the folder `/x/`. */
const leadOnlyPaths = () => DEFAULTS.leadOnly.map((glob) => (glob.endsWith('/**') ? `/${glob.slice(0, -'**'.length)}` : `/${glob}`));

// Dependabot for the project's own packages (#379): one block per ecosystem init finds.
const updateBlocks = (text: string) =>
  text.split(/^(?=  - package-ecosystem:)/m).slice(1).map((block) => ({
    ecosystem: /package-ecosystem: (\S+)/.exec(block)?.[1],
    dirs: [...block.matchAll(/^ {4}directory: (\S+)$|^ {6}- (\/\S*)$/gm)].map((match) => match[1] ?? match[2]),
    block,
  }));

/** The kit's dependabot.yml as init renders it for a project. */
const kitDependabot = () => render(readFileSync(join(KIT, 'project', '.github', 'dependabot.yml'), 'utf8'), { cli: '.yokoten/bin/yokoten.ts', version: VERSION });

/** writeDependabot, the step init runs, in a folder with these files: the step's words and the file it leaves. */
const initDependabot = (files: Record<string, string>) => {
  const root = folderWith(files);
  const step = writeDependabot(root, kitDependabot());
  const path = join(root, '.github/dependabot.yml');
  return { step, said: step.changes.map(changeText).join('\n'), text: readFileSync(path, 'utf8'), path, root };
};

test('init: Dependabot updates a Cargo workspace from the root, once (#379)', () => {
  const { said, text } = initDependabot({
    'Cargo.toml': '[workspace]\nmembers = ["cli", "crates/core"]\n',
    'Cargo.lock': '',
    'cli/Cargo.toml': '[package]\nname = "cli"\n',
    'crates/core/Cargo.toml': '[package]\nname = "core"\n',
    'target/debug/Cargo.toml': '',
  });
  assert.equal(said, 'wrote .github/dependabot.yml (the actions CI runs, and cargo)');
  const blocks = updateBlocks(text);
  assert.deepEqual(blocks.map(({ ecosystem, dirs }) => [ecosystem, dirs]), [['github-actions', ['/']], ['cargo', ['/']]], 'the workspace root covers its members');
  const cargo = blocks[1].block;
  for (const line of [/interval: monthly/, /default-days: 7/, /^ {6}cargo:\n {8}patterns: \['\*'\]$/m, /prefix: chore/]) assert.match(cargo, line);
});

test('init: Dependabot updates a Node project, and a bun lock file means bun (#379)', () => {
  const node = initDependabot({ 'package.json': '{}', 'package-lock.json': '{}', 'node_modules/x/package.json': '{}' });
  assert.deepEqual(updateBlocks(node.text).map(({ ecosystem, dirs }) => [ecosystem, dirs]), [['github-actions', ['/']], ['npm', ['/']]]);
  assert.match(node.said, /\(the actions CI runs, and npm\)$/);
  assert.deepEqual([...findEcosystems(node.root)], [['npm', ['/']]], 'node_modules is not a project');
  const bun = initDependabot({ 'package.json': '{}', 'bun.lock': '' });
  assert.deepEqual(updateBlocks(bun.text).map(({ ecosystem }) => ecosystem), ['github-actions', 'bun']);
  assert.deepEqual([...findEcosystems(folderWith({ 'pyproject.toml': '', 'uv.lock': '' })).keys()], ['uv'], 'a uv lock file means uv, not pip');
});

test('init: Dependabot covers each stack in a mixed project, in the root and one folder down (#379)', () => {
  const { said, text } = initDependabot({
    'go.mod': 'module example.com/demo\n',
    'web/package.json': '{}',
    'site/package.json': '{}',
    'api/pyproject.toml': '[project]\nname = "api"\n',
    'App/App.csproj': '<Project/>',
    'android/build.gradle.kts': '',
    '.cache/Gemfile': '',
    'docs/readme.md': '# docs\n',
  });
  assert.match(said, /\(the actions CI runs, and npm, pip, gomod, nuget, gradle\)$/);
  assert.deepEqual(updateBlocks(text).map(({ ecosystem, dirs }) => [ecosystem, dirs]), [
    ['github-actions', ['/']],
    ['npm', ['/site', '/web']],
    ['pip', ['/api']],
    ['gomod', ['/']],
    ['nuget', ['/App']],
    ['gradle', ['/android']],
  ], 'a hidden folder is not read');
  assert.match(text, /^ {4}directories:\n {6}- \/site\n {6}- \/web\n {4}schedule:/m, 'two folders, one block');
});

test('init: Dependabot with no package manager found updates the actions only (#379)', () => {
  const { step, text } = initDependabot({ 'README.md': '# demo\n', 'src/main.c': '' });
  assert.deepEqual(step.changes, [{ state: 'wrote', kind: 'file', path: '.github/dependabot.yml', note: '.github/dependabot.yml (the actions CI runs)' }]);
  assert.deepEqual(updateBlocks(text).map(({ ecosystem }) => ecosystem), ['github-actions']);
});

test('init: a dependabot.yml that is there is kept, and init names what it does not update (#379)', () => {
  const mine = 'version: 2\nupdates:\n  - package-ecosystem: "npm"\n    directory: /\n    schedule:\n      interval: weekly\n';
  const { step, text, root } = initDependabot({ '.github/dependabot.yml': mine, 'package.json': '{}', 'Cargo.toml': '' });
  assert.equal(text, mine, 'the file is the project\'s, byte for byte');
  assert.deepEqual(step.changes.map((change) => [change.state, change.path]), [['kept', '.github/dependabot.yml']]);
  assert.deepEqual(step.notes.map((note) => note.what), ['.github/dependabot.yml does not update cargo; copy its github-actions block for each, with prefix chore'], 'a note, never folded (#1040)');
  assert.deepEqual([...readDependabotEcosystems(mine)], ['npm'], 'a quoted ecosystem name counts');
  // A dependabot.yaml counts too: init writes no second file next to it.
  const other = folderWith({ '.github/dependabot.yaml': 'version: 2\nupdates:\n  - package-ecosystem: github-actions\n    directory: /\n' });
  assert.deepEqual(writeDependabot(other, kitDependabot()), { changes: [{ state: 'kept', kind: 'file', path: '.github/dependabot.yaml', note: '.github/dependabot.yaml' }], notes: [], problems: [] });
  assert.ok(!existsSync(join(other, '.github/dependabot.yml')));
  assert.match(writeDependabot(root, kitDependabot()).notes[0]?.what ?? '', /^\.github\/dependabot\.yml does not update cargo/, 'said again on each init');
  assert.equal(readFileSync(join(root, '.github/dependabot.yml'), 'utf8'), mine);
});

test("init: a CLAUDE.md gets one line that imports AGENTS.md, and doctor's rules step wants it (#206)", async () => {
  const sandbox = makeSandbox();
  sandbox.write('CLAUDE.md', '# our rules\n\nRun the tests first.\n');
  sandbox.write('AGENTS.md', '# shared rules\n');
  assert.notEqual(await stepMark(sandbox, 'rules'), 'done', 'AGENTS.md that Claude Code does not read is not done');
  assert.match(rowsText((await sandbox.call(['doctor', '--all'])).stdout), /rules[^\n]*: CLAUDE\.md does not import AGENTS\.md[^\n]*; add a line `@AGENTS\.md`/);
  rmSync(join(sandbox.repo, 'AGENTS.md'));
  let result = initIn(sandbox);
  assert.ok(result.ok, said(result));
  assert.ok(has(result, 'wrote', /^AGENTS\.md/));
  assert.ok(has(result, 'updated', /^CLAUDE\.md: it now reads AGENTS\.md/));
  const claude = readFileSync(join(sandbox.repo, 'CLAUDE.md'), 'utf8');
  assert.ok(claude.startsWith('# our rules\n\nRun the tests first.\n\n'), 'the project\'s own lines stay');
  assert.match(claude, /\n<!--[^\n]*-->\n@AGENTS\.md\n$/, 'a comment line, then the import, at the end');
  assert.equal(await stepMark(sandbox, 'rules'), 'done');
  // Again: one import, not two.
  result = initIn(sandbox);
  assert.doesNotMatch(said(result), /updated CLAUDE\.md/);
  assert.equal(readFileSync(join(sandbox.repo, 'CLAUDE.md'), 'utf8'), claude);
});

// When gh fails (#313), the owner is the remote owner, as before #313: this test is that case.
// check --pr reading CODEOWNERS from the base branch is in test/commands/more/check.test.ts.
test('init: writes .github/CODEOWNERS for every lead-only path, owned by the GitHub remote owner, also when gh fails (#304, #313)', async () => {
  const sandbox = makeSandbox();
  // A gh that always fails, so init never reaches GitHub for labels.
  const bin = join(sandbox.home, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(bin, 'gh'), 0o755);
  sandbox.git('remote', 'add', 'origin', 'https://github.com/octo/app.git');
  const result = initIn(sandbox, { extra: { PATH: `${bin}:${process.env.PATH}` } });
  assert.ok(result.ok, said(result));
  assert.ok(has(result, 'wrote', /^\.github\/CODEOWNERS \(the lead-only paths, owned by @octo\)/));
  const owners = readCodeOwners(sandbox.repo, '', process.env);
  assert.equal(owners?.from, 'the working tree');
  assert.doesNotMatch(owners!.text, /YOUR_GITHUB_HANDLE/, 'gh failed: the remote owner, not the placeholder');
  const rules = parseCodeOwners(owners!.text);
  assert.deepEqual(rules.map((rule) => rule.pattern), leadOnlyPaths());
  for (const rule of rules) assert.deepEqual(rule.owners, [`${at}octo`], rule.pattern);
  assert.equal(await stepMark(sandbox, 'codeowners', { PATH: `${bin}:${process.env.PATH}` }), 'done');
});

test('init: a CODEOWNERS owner gh says is a user is written as is (#313)', () => {
  const sandbox = makeSandbox();
  sandbox.git('remote', 'add', 'origin', 'https://github.com/octo/app.git');
  // A gh that answers only who @octo is, and fails every other call.
  const calls: string[] = [];
  const gh = (args: string[]): string => {
    calls.push(args.join(' '));
    if (args.join(' ') === 'api users/octo --jq .type') return 'User\n';
    throw new Error('gh: not this call');
  };
  assert.deepEqual(resultLines(writeCodeOwners(sandbox.repo, gh, sandbox.env)), ['wrote .github/CODEOWNERS (the lead-only paths, owned by @octo)']);
  const rules = parseCodeOwners(readFileSync(join(sandbox.repo, '.github', 'CODEOWNERS'), 'utf8'));
  assert.deepEqual(rules.map((rule) => rule.pattern), leadOnlyPaths());
  for (const rule of rules) assert.deepEqual(rule.owners, [`${at}octo`], rule.pattern);
  // init asked GitHub, once, who @octo is.
  assert.deepEqual(calls, ['api users/octo --jq .type']);
  // The file is there now: kept, and gh is not asked again.
  assert.deepEqual(resultLines(writeCodeOwners(sandbox.repo, gh, sandbox.env)), ['kept .github/CODEOWNERS']);
  assert.equal(calls.length, 1);
});

test('init: an organization is no CODEOWNERS owner, so init writes the placeholder and says why; full doctor flags an org-only file (#313)', async () => {
  const sandbox = makeSandbox();
  const extra = stubGh(sandbox, {
    'api users/octo --jq .type': 'Organization',
    'api repos/octo/app': JSON.stringify({ default_branch: 'main', owner: { login: 'octo', type: 'Organization' } }),
  });
  sandbox.git('remote', 'add', 'origin', 'https://github.com/octo/app.git');
  const result = initIn(sandbox, { extra });
  assert.ok(result.ok, said(result));
  assert.ok(has(result, 'wrote', /^\.github\/CODEOWNERS \(the lead-only paths; @octo is an organization, so put a person or @octo\/<team> in place of @YOUR_GITHUB_HANDLE\)/));
  const text = readFileSync(join(sandbox.repo, '.github', 'CODEOWNERS'), 'utf8');
  assert.match(text, /^# @octo is an organization[^\n]*@octo\/<team>/m);
  const rules = parseCodeOwners(text);
  assert.deepEqual(rules.map((rule) => rule.pattern), leadOnlyPaths());
  for (const rule of rules) assert.deepEqual(rule.owners, ['@YOUR_GITHUB_HANDLE'], rule.pattern);
  // A file owned by the organization alone locks nothing on GitHub: full doctor says so.
  sandbox.write('.github/CODEOWNERS', '/AGENTS.md @octo\n/.github/ @Octo\n');
  assert.equal(await stepMark(sandbox, 'codeowners', extra), 'to do');
  assert.match(rowsText((await sandbox.call(['doctor', '--all'], { extra })).stdout), /\.github\/CODEOWNERS names only @octo, an organization, and GitHub takes no organization as an owner; put a person's handle or @octo\/<team> in \.github\/CODEOWNERS/);
  // A team of the organization, or a person, is an owner.
  sandbox.write('.github/CODEOWNERS', '/AGENTS.md @octo/leads\n');
  assert.equal(await stepMark(sandbox, 'codeowners', extra), 'done');
});

test('init: an existing CODEOWNERS is kept byte for byte, in any place GitHub reads it (#304)', async () => {
  const own = '# ours\r\n/src/ @octo\n';
  let sandbox = makeSandbox();
  sandbox.write('.github/CODEOWNERS', own);
  let result = initIn(sandbox);
  assert.ok(result.ok, said(result));
  assert.ok(has(result, 'kept', /^\.github\/CODEOWNERS/));
  assert.equal(readFileSync(join(sandbox.repo, '.github', 'CODEOWNERS'), 'utf8'), own);
  // One in docs/: a new .github/CODEOWNERS would take its place, so init writes none.
  sandbox = makeSandbox();
  sandbox.write('docs/CODEOWNERS', own);
  result = initIn(sandbox);
  assert.ok(result.ok, said(result));
  assert.ok(has(result, 'kept', /^docs\/CODEOWNERS/));
  assert.equal(existsSync(join(sandbox.repo, '.github', 'CODEOWNERS')), false);
  assert.equal(readFileSync(join(sandbox.repo, 'docs', 'CODEOWNERS'), 'utf8'), own);
});

/** The import line init writes, after one blank line. */
const IMPORT_COMMENT = '<!-- Added by yokoten: Claude Code reads AGENTS.md only through this import. -->';

/** The step importRules returns when it adds the import to `file`. */
const importedLine = (file: string) => stepOf({ changes: [{ state: 'updated', kind: 'file', path: file, note: `${file}: it now reads AGENTS.md (Claude Code reads AGENTS.md only when a CLAUDE.md imports it)` }] });

/**
 * findRulesGap in a folder with these files and an AGENTS.md, then importRules. With no
 * gap, nothing is written. With a gap and no link, the import goes in, and the gap is closed.
 */
function checkRulesGap(files: Record<string, string>, want: { file: string; line: string; link?: string } | null, what: string): { root: string; said: Step | null } {
  const root = folderWith({ 'AGENTS.md': '# shared rules\n', ...files });
  assert.deepEqual(findRulesGap(root), want, `${what}: the gap doctor's rules step reads`);
  assert.equal(rulesStepDone(root), want === null, `${what}: doctor's rules step`);
  if (want && !want.link) assert.equal(rulesStepFix(root), `add a line \`${want.line}\` at the end of ${want.file}, or run \`yokoten init\``, `${what}: doctor's advice`);
  const said = importRules(root);
  if (want === null) {
    assert.equal(said, null, `${what}: init says nothing of CLAUDE.md`);
    for (const [file, text] of Object.entries(files)) assert.equal(readFileSync(join(root, file), 'utf8'), text, `${what}: ${file} is left as it is`);
  } else if (!want.link) {
    assert.deepEqual(said, importedLine(want.file), what);
    assert.equal(findRulesGap(root), null, `${what}: after init, the rules step is done`);
    assert.equal(rulesStepDone(root), true, `${what}: after init, doctor's rules step is done`);
  }
  return { root, said };
}

/** doctor's rules step from the road, called directly: done, and its advice. */
const RULES_STEP = ROAD.find((step) => step.key === 'rules')!;
const rulesStepDone = (root: string) => RULES_STEP.check(root, {}, undefined);
const rulesStepFix = (root: string) => RULES_STEP.fix(root, {}, undefined);

// ---- Which CLAUDE.md imports AGENTS.md (#206, #428): one table on findRulesGap ----
//
// doctor's rules step is done when AGENTS.md is there and findRulesGap is null, and its
// advice names the gap's file, line and link. init writes the import with importRules. So
// each case checks both in a plain folder: no git repo, and no run of init or doctor. The
// test above holds the whole road once, init and doctor end to end.
test('init: which CLAUDE.md imports AGENTS.md, and which gets the import, in one table (#206)', () => {
  const fence = '```';
  // An import there already, in CLAUDE.md or in .claude/CLAUDE.md: left as it is.
  const imports: Record<string, string>[] = [
    { 'CLAUDE.md': `# rules\n${at}AGENTS.md\n` },
    { 'CLAUDE.md': `# rules\nRead ${at}./AGENTS.md first.\n` },
    { 'CLAUDE.md': `# rules\r\n${at}AGENTS.md\r\n` },
    { 'CLAUDE.md': `# rules\n${at}AGENTS.md` },
    { '.claude/CLAUDE.md': `# rules\n${at}../AGENTS.md\n` },
    { '.claude/CLAUDE.md': `# rules\nRead ${at}../AGENTS.md first.\n` },
    // A real import next to a fenced or quoted example.
    { 'CLAUDE.md': `# rules\n${at}AGENTS.md\n\nExample:\n${fence}\n${at}AGENTS.md\n${fence}\n` },
    { 'CLAUDE.md': `# rules\nExample: \`${at}AGENTS.md\`.\n${at}AGENTS.md\n` },
    { 'CLAUDE.md': `# rules\n${fence}\n${at}other.md\n${fence}\n${at}AGENTS.md\n` },
  ];
  for (const files of imports) checkRulesGap(files, null, JSON.stringify(files));

  // No import: the file gets one at the end, and its own lines stay.
  const rootFile = { file: 'CLAUDE.md', line: `${at}AGENTS.md` };
  const folderFile = { file: '.claude/CLAUDE.md', line: `${at}../AGENTS.md` };
  const gaps = [
    { text: '# rules\nRun the tests first.\n', at: rootFile },
    { text: '# rules\n', at: folderFile },
    // An import of another file that starts with AGENTS.md does not count.
    { text: `# rules\n${at}AGENTS.md.bak\n`, at: rootFile },
    { text: `# rules\nOld: ${at}./AGENTS.md.old\n`, at: rootFile },
    { text: `# rules\n${at}../AGENTS.md.bak\n`, at: folderFile },
    // A Markdown link is text: Claude Code loads only `@path` imports.
    { text: '# rules\nSee [the rules](AGENTS.md).\n', at: rootFile },
    { text: '# rules\nSee [the rules](./AGENTS.md).\n', at: rootFile },
    { text: '# rules\nSee [the rules](../AGENTS.md).\n', at: folderFile },
    // Claude Code skips code spans and fenced code blocks when it reads imports.
    { text: `# rules\nWrite \`${at}AGENTS.md\` to import it.\n`, at: rootFile },
    { text: `# rules\nWrite \`\`${at}AGENTS.md\`\` to import it.\n`, at: rootFile },
    { text: `# rules\n${fence}md\n${at}AGENTS.md\n${fence}\n`, at: rootFile },
    { text: `# rules\n~~~\n${at}AGENTS.md\n~~~\n`, at: rootFile },
    { text: `# rules\n  ${fence}\n${at}AGENTS.md\n  ${fence}\n`, at: rootFile },
  ];
  for (const { text, at: want } of gaps) {
    const { root: dir } = checkRulesGap({ [want.file]: text }, want, JSON.stringify(text));
    const after = readFileSync(join(dir, want.file), 'utf8');
    assert.equal(after, `${text.replace(/\n$/, '')}\n\n${IMPORT_COMMENT}\n${want.line}\n`, `${JSON.stringify(text)}: the old lines, one blank line, the comment and the import`);
    // Claude Code resolves an import relative to the file that holds it: no root CLAUDE.md is made.
    if (want.file === '.claude/CLAUDE.md') assert.equal(existsSync(join(dir, 'CLAUDE.md')), false);
  }

  // doctor's advice for .claude/CLAUDE.md names the import from that folder, not the root one.
  assert.equal(rulesStepFix(folderWith({ 'AGENTS.md': '# shared rules\n', '.claude/CLAUDE.md': '# rules\n' })), `add a line \`${at}../AGENTS.md\` at the end of .claude/CLAUDE.md, or run \`yokoten init\``);
  // Both files, neither importing AGENTS.md: the root one gets the import.
  const both = checkRulesGap({ 'CLAUDE.md': '# root rules\n', '.claude/CLAUDE.md': '# folder rules\n' }, rootFile, 'both files');
  assert.match(readFileSync(join(both.root, 'CLAUDE.md'), 'utf8'), /\n@AGENTS\.md\n$/);
  assert.equal(readFileSync(join(both.root, '.claude', 'CLAUDE.md'), 'utf8'), '# folder rules\n');
  // No CLAUDE.md at all: Claude Code reads AGENTS.md itself.
  checkRulesGap({}, null, 'no CLAUDE.md');
});

test('init: a CLAUDE.md that is a link reads the rules through it, or is left as it is with what to do (#428)', { skip: NO_SYMLINK }, () => {
  // A link to AGENTS.md: Claude Code reads the rules through it, so there is no gap and
  // init writes nothing, so AGENTS.md never imports itself.
  for (const links of [[['CLAUDE.md', 'AGENTS.md']], [['.claude/CLAUDE.md', '../AGENTS.md']], [['CLAUDE.md', 'AGENTS.md'], ['.claude/CLAUDE.md', '../AGENTS.md']]]) {
    const dir = folderWith({ 'AGENTS.md': '# shared rules\n\n## This project\n\nRun the tests first.\n' });
    for (const [file, target] of links) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      symlinkSync(target, join(dir, file));
    }
    assert.equal(findRulesGap(dir), null, `${links}: no rules gap`);
    assert.equal(rulesStepDone(dir), true, `${links}: doctor's rules step is done`);
    assert.equal(importRules(dir), null, `${links}`);
    assert.equal(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), '# shared rules\n\n## This project\n\nRun the tests first.\n', `${links}: AGENTS.md does not import itself`);
    for (const [file, target] of links) assert.equal(readlinkSync(join(dir, file)), target, `${file} is the same link`);
  }
  // A link to another file, in the repo or outside it: nothing is written through it, and
  // doctor and init name the file the link points to.
  for (const outside of [false, true]) {
    const base = makeTempDir();
    const dir = join(base, 'repo');
    mkdirSync(dir);
    writeFileSync(join(dir, 'AGENTS.md'), '# shared rules\n');
    const real = outside ? join(base, 'shared-claude.md') : join(dir, 'docs', 'claude.md');
    const named = outside ? 'a file outside this repo' : 'docs/claude.md';
    mkdirSync(dirname(real), { recursive: true });
    writeFileSync(real, '# our rules\n');
    symlinkSync(outside ? real : 'docs/claude.md', join(dir, 'CLAUDE.md'));
    assert.deepEqual(findRulesGap(dir), { file: 'CLAUDE.md', line: `${at}AGENTS.md`, link: named }, 'doctor: add a line `@AGENTS.md` to that file');
    assert.equal(rulesStepDone(dir), false, `${named}: doctor's rules step is not done`);
    assert.equal(rulesStepFix(dir), `CLAUDE.md is a link to ${named}: add a line \`${at}AGENTS.md\` to that file, or make CLAUDE.md a plain file`);
    assert.deepEqual(importRules(dir)?.problems.map((problem) => problem.what), [`CLAUDE.md is a link to ${named}, so Claude Code does not read AGENTS.md; add a line \`${at}AGENTS.md\` to that file by hand, or make CLAUDE.md a plain file`]);
    assert.equal(readFileSync(real, 'utf8'), '# our rules\n', 'nothing is written through the link');
    assert.equal(lstatSync(join(dir, 'CLAUDE.md')).isSymbolicLink(), true);
    assert.notEqual(findRulesGap(dir), null, 'the rules step is still not done');
  }
  // With CLAUDE.md a link to another file, a plain .claude/CLAUDE.md gets the import.
  const dir = folderWith({ 'AGENTS.md': '# shared rules\n', 'docs/claude.md': '# linked rules\n', '.claude/CLAUDE.md': '# folder rules\n' });
  symlinkSync('docs/claude.md', join(dir, 'CLAUDE.md'));
  assert.deepEqual(findRulesGap(dir), { file: '.claude/CLAUDE.md', line: `${at}../AGENTS.md` });
  assert.equal(rulesStepDone(dir), false);
  assert.equal(rulesStepFix(dir), `add a line \`${at}../AGENTS.md\` at the end of .claude/CLAUDE.md, or run \`yokoten init\``);
  assert.deepEqual(importRules(dir), importedLine('.claude/CLAUDE.md'));
  assert.equal(readFileSync(join(dir, 'docs', 'claude.md'), 'utf8'), '# linked rules\n');
  assert.match(readFileSync(join(dir, '.claude', 'CLAUDE.md'), 'utf8'), /\n@\.\.\/AGENTS\.md\n$/);
  assert.equal(findRulesGap(dir), null);
});

test("init: a CLAUDE.md with mixed line endings gets the file's main ending and one blank line (#206)", () => {
  const cases = [
    { text: '# rules\r\nOne.\r\nTwo.\n', want: '# rules\r\nOne.\r\nTwo.\r\n\r\n<!--' },
    { text: '# rules\r\nOne.\r\nTwo.', want: '# rules\r\nOne.\r\nTwo.\r\n\r\n<!--' },
    { text: '# rules\nOne.\nTwo.\r\n', want: '# rules\nOne.\nTwo.\n\n<!--' },
    { text: '# rules\nOne.\n\n\n', want: '# rules\nOne.\n\n<!--' },
  ];
  for (const { text, want } of cases) {
    const dir = folderWith({ 'CLAUDE.md': text });
    assert.deepEqual(importRules(dir), importedLine('CLAUDE.md'));
    const after = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    const newline = want.includes('\r\n') ? '\r\n' : '\n';
    assert.equal(after.slice(0, want.length), want, JSON.stringify(after));
    assert.ok(after.endsWith(`-->${newline}${at}AGENTS.md${newline}`), JSON.stringify(after));
  }
});

test('init: a CLAUDE.md link to an AGENTS.md without `## This project` gets the core rules once, and nothing through the link (#378, #428)', { skip: NO_SYMLINK }, async () => {
  for (const [file, target] of [['CLAUDE.md', 'AGENTS.md'], ['.claude/CLAUDE.md', '../AGENTS.md']]) {
    const sandbox = makeSandbox();
    sandbox.write('AGENTS.md', '# Our rules\n\nRun the tests first.\n');
    mkdirSync(dirname(join(sandbox.repo, file)), { recursive: true });
    symlinkSync(target, join(sandbox.repo, file));
    const result = initIn(sandbox);
    assert.ok(result.ok, said(result));
    assert.ok(has(result, 'updated', /^AGENTS\.md: the core rules are on top, and your 3 lines moved under `## This project`/), file);
    assert.doesNotMatch(said(result), /CLAUDE\.md/, `${file}: no import, no note about the link`);
    const text = readFileSync(join(sandbox.repo, 'AGENTS.md'), 'utf8');
    assert.equal(text.match(/^<!-- yokoten kit /gm)?.length, 1, `${file}: the core rules once`);
    assert.equal(text.match(/^## This project$/gm)?.length, 1, file);
    assert.ok(text.endsWith('## This project\n\n## Our rules\n\nRun the tests first.\n'), text.slice(-120));
    assert.doesNotMatch(text, /^@(\.\.\/)?AGENTS\.md$/m, `${file}: AGENTS.md does not import itself`);
    assert.equal(readlinkSync(join(sandbox.repo, file)), target, `${file} is the same link`);
    assert.equal(await stepMark(sandbox, 'rules'), 'done', file);
    // A second run changes nothing.
    const again = initIn(sandbox);
    assert.ok(has(again, 'kept', /^AGENTS\.md \(`yokoten update` brings its core rules up to date\)$/));
    assert.equal(readFileSync(join(sandbox.repo, 'AGENTS.md'), 'utf8'), text, file);
  }
});

const KIT_RULES = '<!-- yokoten kit 1.0.0 -->\n# How work is done here\n\n## Core rules\n\n1. a rule\n\n## This project\n\n<!-- yours here -->\n';
const KIT_CORE = KIT_RULES.slice(0, KIT_RULES.indexOf('## This project'));

// ---- The core rules into an AGENTS.md the project already has (#378) ----
test('core rules into AGENTS.md: headings go one level down, everything else stays byte for byte (#378)', () => {
  // No headings: the text moves as it is.
  assert.deepEqual(demoteHeadings('just text\nmore\n'), { text: 'just text\nmore\n', headings: [], deepest: [] });
  // `# Title` first, and ATX headings at each level; level 6 stays; `#tag` is no heading.
  const atx = demoteHeadings('# Title\n\nText\n## Sub\n  ### Indented ###\n###### Six\n#tag\n');
  assert.equal(atx.text, '## Title\n\nText\n### Sub\n  #### Indented ###\n###### Six\n#tag\n');
  assert.deepEqual(atx.headings.map((h) => h.after), ['`## Title`', '`### Sub`', '`#### Indented ###`']);
  assert.deepEqual(atx.deepest, ['`###### Six`']);
  // Setext: `===` becomes `---`; a `---` heading becomes `###`. A rule after a blank line, a
  // list or a quote is not a heading.
  const setext = demoteHeadings('Big\n===\n\nSmall\n---\n\n---\n\n- item\n---\n> quote\nlazy\n---\n');
  assert.equal(setext.text, 'Big\n---\n\n### Small\n\n---\n\n- item\n---\n> quote\nlazy\n---\n');
  assert.equal(setext.headings.length, 2);
  // Headings inside fenced code blocks stay, with either fence and a longer closing fence.
  const fenced = '```md\n# not a heading\nTitle\n===\n```\n~~~~\n# not\n~~~\n## still not\n~~~~~\n# yes\n    # indented code\n';
  assert.equal(demoteHeadings(fenced).text, fenced.replace('# yes', '## yes'));
  // CRLF lines keep CRLF; a last line without a newline keeps none.
  assert.equal(demoteHeadings('# A\r\n\r\nB\r\n---\r\ntext').text, '## A\r\n\r\n### B\r\ntext');
  assert.equal(demoteHeadings('').text, '');
});

test('core rules into AGENTS.md: the kit core on top, then `## This project`, then the text (#378)', () => {
  const moved = moveUnderProjectHeading('# Ours\n\nBuild with make.\n', KIT_RULES);
  assert.equal(moved.text, `${KIT_CORE}## This project\n\n## Ours\n\nBuild with make.\n`);
  assert.equal(moved.lines, 3);
  assert.equal(compareCoreRules(moved.text, KIT_RULES).state, 'same', 'doctor finds the core rules up to date');
  // CRLF: the new lines take CRLF too, so update compares it as the same.
  const crlf = moveUnderProjectHeading('# Ours\r\n\r\nrule\r\n', KIT_RULES);
  assert.equal(crlf.text, `${KIT_CORE.replaceAll('\n', '\r\n')}## This project\r\n\r\n## Ours\r\n\r\nrule\r\n`);
  assert.equal(compareCoreRules(crlf.text, KIT_RULES).state, 'same');
  // A byte order mark is dropped, so the kit version line comes first.
  const bom = moveUnderProjectHeading('\uFEFF# Ours\n', KIT_RULES);
  assert.ok(bom.hadBom);
  assert.ok(bom.text.startsWith('<!-- yokoten kit 1.0.0 -->\n'));
  assert.equal(readKitVersion(bom.text), '1.0.0');
  // An empty file, or one with blank lines only, gets the kit's file.
  for (const empty of ['', '\n\n', '\uFEFF']) assert.deepEqual(moveUnderProjectHeading(empty, KIT_RULES), { text: KIT_RULES, lines: 0, headings: [], deepest: [], hadBom: empty === '\uFEFF', frontMatter: false });
});

test('init: an AGENTS.md without `## This project` gets the core rules on top, and a copy of the old file (#378)', async () => {
  const sandbox = makeSandbox();
  // With YAML front matter: it stays on top, and init says so (#378). The cases of front
  // matter are in the unit test of moveUnderProjectHeading below.
  const front = '---\ndescription: our rules\n---\n';
  const old = `${front}# Our rules\n\nRun \`make test\`.\n\n## Style\n\nTabs.\n`;
  sandbox.write('AGENTS.md', old);
  const result = initIn(sandbox);
  assert.ok(result.ok, said(result));
  assert.ok(has(result, 'updated', /^AGENTS\.md: the core rules are on top, and your 7 lines moved under `## This project`; only their heading levels changed \(kept the old file as AGENTS\.md\.before-yokoten;/));
  assert.ok(noted(result, /^AGENTS\.md: a heading went one level down: `# Our rules` is now `## Our rules`$/), said(result));
  assert.ok(noted(result, /^AGENTS\.md: a heading went one level down: `## Style` is now `### Style`$/));
  assert.ok(noted(result, /^AGENTS\.md: the front matter stays at the very top, as it was$/));
  const text = readFileSync(join(sandbox.repo, 'AGENTS.md'), 'utf8');
  const kit = readFileSync(join(ROOT, 'kit', 'project', 'AGENTS.md'), 'utf8');
  const kitCore = kit.slice(0, kit.search(/^## This project$/m)).replace('{{version}}', JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version);
  assert.equal(text, `${front}${kitCore}## This project\n\n## Our rules\n\nRun \`make test\`.\n\n### Style\n\nTabs.\n`);
  assert.equal(readFileSync(join(sandbox.repo, AGENTS_BACKUP), 'utf8'), old, 'the old file, byte for byte');
  assert.match((await sandbox.call(['update'])).stdout, /up to date/);
  // A second run finds the heading and leaves the file to `update`.
  const again = initIn(sandbox);
  assert.ok(has(again, 'kept', /^AGENTS\.md \(`yokoten update` brings its core rules up to date\)$/));
  assert.equal(readFileSync(join(sandbox.repo, 'AGENTS.md'), 'utf8'), text);
});

test('init: a committed AGENTS.md with CRLF and a BOM moves with no copy; git gives the old one back (#378)', async () => {
  const sandbox = makeSandbox();
  const old = '\uFEFFRules\r\n=====\r\n\r\n```sh\r\n# a comment, not a heading\r\n```\r\n';
  sandbox.write('AGENTS.md', old);
  sandbox.git('add', 'AGENTS.md');
  sandbox.git('commit', '-q', '-m', 'rules');
  const result = initIn(sandbox);
  assert.ok(result.ok, said(result));
  assert.match(said(result), /to get the old file back: `git checkout HEAD -- AGENTS\.md`/);
  assert.ok(noted(result, /^AGENTS\.md: a heading went one level down: `Rules` \(underlined with =\) is now `Rules` \(underlined with -\)$/), said(result));
  assert.ok(noted(result, /^AGENTS\.md: the byte order mark at the start is gone/));
  assert.ok(!existsSync(join(sandbox.repo, AGENTS_BACKUP)), 'git has the old file');
  const text = readFileSync(join(sandbox.repo, 'AGENTS.md'), 'utf8');
  assert.ok(text.startsWith('<!-- yokoten kit '));
  assert.ok(text.endsWith('## This project\r\n\r\nRules\r\n-----\r\n\r\n```sh\r\n# a comment, not a heading\r\n```\r\n'), text.slice(-120));
  assert.ok(!/(?<!\r)\n/.test(text), 'every line ends in CRLF');
  sandbox.git('checkout', 'HEAD', '--', 'AGENTS.md');
  assert.equal(readFileSync(join(sandbox.repo, 'AGENTS.md'), 'utf8'), old, 'the command it prints gives the old file back');
});

test('init: an empty AGENTS.md gets the kit file; a different copy already there stops the move (#378)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('AGENTS.md', '');
  const result = initIn(sandbox);
  assert.ok(has(result, 'wrote', /^AGENTS\.md: it had no text, so it now has the core rules and an empty `## This project` section/));
  assert.match(readFileSync(join(sandbox.repo, 'AGENTS.md'), 'utf8'), /^## This project$/m);

  const other = makeSandbox();
  other.write('AGENTS.md', '# mine\n');
  other.write(AGENTS_BACKUP, '# an older copy\n');
  const stopped = initIn(other);
  assert.ok(stopped.ok, said(stopped));
  assert.ok(noted(stopped, /^AGENTS\.md has no `## This project` heading, and AGENTS\.md\.before-yokoten is there already/), said(stopped));
  assert.equal(readFileSync(join(other.repo, 'AGENTS.md'), 'utf8'), '# mine\n');
  assert.equal(readFileSync(join(other.repo, AGENTS_BACKUP), 'utf8'), '# an older copy\n');
});

test('init: an AGENTS.md that is a link is kept, so init never writes through it into CLAUDE.md (#378)', { skip: process.platform === 'win32' && 'a link needs admin rights on Windows' }, async () => {
  const sandbox = makeSandbox();
  sandbox.write('CLAUDE.md', '# our rules\n');
  symlinkSync('CLAUDE.md', join(sandbox.repo, 'AGENTS.md'));
  const result = initIn(sandbox);
  assert.ok(result.ok, said(result));
  assert.ok(noted(result, /^AGENTS\.md is a link to CLAUDE\.md, so yokoten did not write the core rules into it/), said(result));
  assert.doesNotMatch(readFileSync(join(sandbox.repo, 'CLAUDE.md'), 'utf8'), /Core rules/);
});

test('core rules into AGENTS.md: YAML front matter stays at the very top, as it was (#378)', () => {
  // `---` or `...` closes it; nothing inside is demoted, not even a `# comment` line.
  for (const close of ['---', '...']) {
    const front = `---\ntitle: Rules\n# a YAML comment\n${close}\n`;
    const moved = moveUnderProjectHeading(`${front}# Ours\n`, KIT_RULES);
    assert.ok(moved.frontMatter);
    assert.equal(moved.text, `${front}${KIT_CORE}## This project\n\n## Ours\n`);
    assert.deepEqual(moved.headings.map((h) => h.after), ['`## Ours`']);
    // doctor and update read past it: the core rules are the same, and an update keeps it.
    assert.equal(compareCoreRules(moved.text, KIT_RULES).state, 'same');
    const behind = compareCoreRules(moved.text.replace('1. a rule', '1. an old rule'), KIT_RULES);
    assert.ok(behind.state === 'behind' && behind.updated === moved.text, 'update --write keeps the front matter');
  }
  // CRLF, a BOM, and a closing line at the very end of the file.
  assert.equal(moveUnderProjectHeading('\uFEFF---\r\na: 1\r\n---\r\nText\r\n', KIT_RULES).text, `---\r\na: 1\r\n---\r\n${KIT_CORE.replaceAll('\n', '\r\n')}## This project\r\n\r\nText\r\n`);
  assert.equal(moveUnderProjectHeading('---\na: 1\n---', KIT_RULES).text, `---\na: 1\n---\n${KIT_RULES}`);
  // A first line `---` with no closing line is plain text: a rule, then a heading under it.
  assert.deepEqual(splitFrontMatter('---\n# Rules\n'), { front: '', rest: '---\n# Rules\n' });
  const plain = moveUnderProjectHeading('---\n# Rules\nText\n', KIT_RULES);
  assert.ok(!plain.frontMatter);
  assert.equal(plain.text, `${KIT_CORE}## This project\n\n---\n## Rules\nText\n`);
});
