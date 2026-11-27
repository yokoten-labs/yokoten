// Tests for src/setup/init.ts: update, the copy of yokoten in .yokoten/, GitHub and the screens init prints.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { commitCommand } from '../../../src/commands/more/setup/init.ts';
import { test } from 'node:test';
import { CLI, makeSandbox, rowsText, shareGuardMeasure, shareSelfTest } from '../../repo/helpers.ts';
import { VERSION } from '../../../src/setup/files.ts';
import { AGENTS_BACKUP, compareCoreRules, compareVersions, readKitVersion, updateCoreRules } from '../../../src/setup/init.ts';
import { initIn, has, stubGh, ghCalls, NO_SYMLINK } from './helpers.ts';

shareGuardMeasure();
shareSelfTest();

// The version under test, read from package.json: a release bump must not need test edits.
const versionPattern = VERSION.replaceAll('.', '\\.');
const NEWER = `${Number(VERSION.split('.')[0]) + 1}.0.0`;
const newerPattern = NEWER.replaceAll('.', '\\.');

function commitAgents(sandbox: ReturnType<typeof makeSandbox>): void {
  sandbox.git('add', 'AGENTS.md');
  sandbox.git('commit', '-q', '--allow-empty', '-m', 'rules');
}

// A lesson added to the kit's core rules reaches a project that already ran init (#120).
test('update: doctor says when the core rules are behind; update previews, and --write keeps "This project" byte for byte (#120)', async () => {
  const sandbox = makeSandbox();
  assert.ok(initIn(sandbox).ok);
  const path = join(sandbox.repo, 'AGENTS.md');
  const fresh = readFileSync(path, 'utf8');
  const kitCore = fresh.slice(0, fresh.indexOf('## This project'));
  // init wrote the kit, so it is up to date (doctor says so in the .yokoten/ test below).
  let result: { status: number | null; stdout: string; stderr: string } = sandbox.run(['update']); // a real process: the entry point of update
  assert.deepEqual([result.status, result.stdout], [0, 'yokoten update · the core rules are up to date, nothing changed\n']);

  // An older kit had no rule 12, and someone edited a line by hand. The project's own
  // part has trailing spaces and a CRLF line end, to show it is kept byte for byte.
  const own = '## This project\n\nBuild with `make`.  \n<!-- ours -->\r\n';
  const old = kitCore.replace(/^\| 12 \|.*\n/m, '').replace('Plain English, close to', 'Plain words, close to') + own;
  writeFileSync(path, old);
  const doctor = await sandbox.call(['doctor', '--all']);
  assert.match(rowsText(doctor.stdout), new RegExp(String.raw`MISSING {6}core-rules: the core rules in AGENTS\.md are behind yokoten ${versionPattern}'s, or were edited by hand \(2 lines added, 1 removed; sections changed: Core rules, Writing\); run \x60yokoten update\x60 to see the change`));
  assert.equal(doctor.status, 1);
  assert.match((await sandbox.call(['doctor', '--session'])).stdout, /^yokoten: the core rules in AGENTS\.md are behind/m, 'a session hears it');

  // The preview has each line, the hand edit too, and writes nothing.
  const preview = updateCoreRules(sandbox.repo, { write: false }, sandbox.env);
  assert.deepEqual([preview.state, preview.summary], ['preview', '2 lines added, 1 removed; sections changed: Core rules, Writing']);
  const lineOf = (kind: string, start: string) => preview.changes.some((change) => change.kind === kind && change.line.startsWith(start));
  assert.ok(lineOf('removed', 'Plain words, close to ASD-STE100'), 'the hand-edited line is shown as replaced');
  assert.ok(lineOf('added', 'Plain English, close to ASD-STE100'));
  assert.ok(lineOf('added', '| 12 | Decisions are written down once'));
  // update --all shows them, through the real command.
  result = await sandbox.call(['update', '--all']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(String.raw`^yokoten update · the core rules differ from yokoten ${versionPattern}'s: 2 lines`));
  assert.match(result.stdout, /^ {2}- Plain words, close to ASD-STE100/m);
  assert.match(result.stdout, /\nNext: `yokoten update --write`\n$/);
  assert.equal(readFileSync(path, 'utf8'), old, 'the preview writes nothing');

  // --write replaces the core part only; a second run has nothing to do.
  commitAgents(sandbox); // git can give this file back, so update --write keeps no copy (#989)
  const written = updateCoreRules(sandbox.repo, { write: true }, sandbox.env);
  assert.deepEqual([written.ok, written.state, written.summary, written.backup], [true, 'written', '2 lines added, 1 removed; sections changed: Core rules, Writing', undefined]);
  assert.equal(readFileSync(path, 'utf8'), kitCore + own);
  assert.match((await sandbox.call(['update'])).stdout, /up to date/);

  // Line ends do not count: a CRLF checkout is up to date.
  writeFileSync(path, kitCore.replaceAll('\n', '\r\n') + own);
  assert.match((await sandbox.call(['update'])).stdout, /up to date/);

  // Without the heading, doctor can't tell the core rules from the project's: a note, never a guess.
  writeFileSync(path, '# our own rules\n');
  assert.match(rowsText((await sandbox.call(['doctor', '--all'])).stdout), /\n {2}note +core-rules: can't compare the core rules in AGENTS\.md: AGENTS\.md has no `## This project` heading/);
  assert.doesNotMatch((await sandbox.call(['doctor', '--session'])).stdout, /core rules/);
  const unread = updateCoreRules(sandbox.repo, { write: true }, sandbox.env);
  assert.deepEqual([unread.ok, unread.state], [false, "can't compare"]);
  assert.match(unread.problem?.what ?? '', /^can't compare AGENTS\.md with the kit: .*; nothing changed/);
  assert.equal(readFileSync(path, 'utf8'), '# our own rules\n');

  rmSync(path);
  assert.doesNotMatch(rowsText((await sandbox.call(['doctor', '--all'])).stdout), /core-rules/, 'the road asks for AGENTS.md');
  result = await sandbox.call(['update']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^yokoten update · there is no AGENTS\.md here, so nothing changed\n\nNext: `yokoten init`\n$/m);
  assert.equal((await sandbox.call(['update', '--force'])).status, 1, 'an unknown option is refused');
  assert.match((await sandbox.call(['explain', 'core-rules'])).stdout.replace(/\s+/g, ' '), /^yokoten explain core-rules · .* What the core rules in AGENTS\.md/);
});

// A project written by a newer yokoten is never taken back to an older kit (#141).
test('update: init writes the kit version, and a project from a newer yokoten is refused (#141)', async () => {
  const sandbox = makeSandbox();
  assert.ok(initIn(sandbox).ok);
  const path = join(sandbox.repo, 'AGENTS.md');
  const fresh = readFileSync(path, 'utf8');
  assert.match(fresh, new RegExp(String.raw`^<!-- yokoten kit ${versionPattern} -->\n# How work is done here\n`), 'init writes the mark on the first line');
  const own = fresh.slice(fresh.indexOf('## This project'));
  const kitCore = fresh.slice(0, fresh.indexOf('## This project'));

  // Newer: a later kit added a line. update refuses, with or without --write, and doctor
  // says to update yokoten, not the project.
  const newer = kitCore.replace(`${VERSION} -->`, `${NEWER} -->`).replace('## Roles\n', '## Roles\n\nA rule from a later kit.\n') + own;
  writeFileSync(path, newer);
  for (const write of [false, true]) {
    const result = updateCoreRules(sandbox.repo, { write }, sandbox.env);
    assert.deepEqual([result.ok, result.state, result.problem?.fix], [false, 'newer', 'yokoten update']);
    assert.match(result.problem?.what ?? '', new RegExp(String.raw`^AGENTS\.md was written by yokoten ${newerPattern}, newer than this yokoten ${versionPattern}, so nothing changed`));
  }
  assert.equal(readFileSync(path, 'utf8'), newer, 'a newer project is not downgraded');
  const doctor = await sandbox.call(['doctor', '--all']);
  assert.match(rowsText(doctor.stdout), new RegExp(String.raw`\n {2}note +core-rules: the core rules in AGENTS\.md come from yokoten ${newerPattern}, newer than this yokoten ${versionPattern}; update yokoten itself, not the project`));
  assert.doesNotMatch(doctor.stdout, /MISSING {6}core-rules/);
  // An older mark, and no mark at all, are compared by content: the core rules test of
  // compareCoreRules below holds both, and the test above runs update --write end to end.
});

// `update --write` replaces the core part of AGENTS.md; it keeps what init keeps (#989).
async function behindSandbox() {
  const sandbox = makeSandbox();
  assert.ok(initIn(sandbox).ok);
  const path = join(sandbox.repo, 'AGENTS.md');
  const fresh = readFileSync(path, 'utf8');
  const behind = fresh.replace('Plain English, close to', 'Plain words, close to');
  return { sandbox, path, fresh, behind };
}

test('update --write: a file git cannot give back is kept as AGENTS.md.before-yokoten; a committed one is not (#989)', async () => {
  const { sandbox, path, fresh, behind } = await behindSandbox();
  writeFileSync(path, behind);
  const backup = join(sandbox.repo, AGENTS_BACKUP);
  const result = updateCoreRules(sandbox.repo, { write: true }, sandbox.env);
  assert.deepEqual([result.state, result.backup], ['written', AGENTS_BACKUP]);
  assert.equal(readFileSync(backup, 'utf8'), behind, 'the old file, byte for byte');
  assert.equal(readFileSync(path, 'utf8'), fresh);

  // A different copy is there already: never overwritten, and AGENTS.md is not written.
  writeFileSync(path, behind.replace('Plain words', 'Simple words'));
  const clash = updateCoreRules(sandbox.repo, { write: true }, sandbox.env);
  assert.deepEqual([clash.ok, clash.state, clash.problem?.fix], [false, 'backup in the way', 'yokoten update --write']);
  assert.match(clash.problem?.what ?? '', /^AGENTS\.md\.before-yokoten is there already, so yokoten kept both files as they are; nothing changed/);
  assert.equal(readFileSync(backup, 'utf8'), behind);
  assert.match(readFileSync(path, 'utf8'), /Simple words/);

  // The control: when HEAD has the file as it is, no copy is made.
  rmSync(backup);
  commitAgents(sandbox);
  assert.equal(updateCoreRules(sandbox.repo, { write: true }, sandbox.env).state, 'written');
  assert.ok(!existsSync(backup), 'git has the old file');
  assert.equal(readFileSync(path, 'utf8'), fresh);
});

test('update --write: a linked AGENTS.md is refused and the target stays as it was (#989)', { skip: NO_SYMLINK }, async () => {
  const { sandbox, path, behind } = await behindSandbox();
  sandbox.write('docs/rules.md', behind);
  rmSync(path);
  symlinkSync('docs/rules.md', path);
  const result = updateCoreRules(sandbox.repo, { write: true }, sandbox.env);
  assert.deepEqual([result.ok, result.state, result.problem?.fix], [false, 'link', 'yokoten update --all']);
  assert.match(result.problem?.what ?? '', /^AGENTS\.md is a link to docs\/rules\.md, so yokoten did not write the core rules into it/);
  assert.equal(readFileSync(join(sandbox.repo, 'docs', 'rules.md'), 'utf8'), behind);
  assert.ok(lstatSync(path).isSymbolicLink(), 'the link is still a link');
  assert.ok(!existsSync(join(sandbox.repo, AGENTS_BACKUP)));
});

// CI and the hooks run the copy in .yokoten/. It carries the kit's AGENTS.md, so doctor
// there compares with the kit the project vendored, not "can't compare" (#145).
test('update: the .yokoten/ copy has the kit\'s AGENTS.md, so doctor and update compare from it (#145)', async () => {
  const sandbox = makeSandbox();
  assert.ok(initIn(sandbox).ok);
  const vendored = (...args: string[]) => spawnSync('node', ['.yokoten/bin/yokoten.ts', ...args], { cwd: sandbox.repo, env: sandbox.env, encoding: 'utf8' });
  const kitDir = join(sandbox.repo, '.yokoten', 'kit');
  // The kit's lessons come too (#77), so doctor from the copy runs them, and the kit's
  // workflows with their hashes (#456), for the command that compares them; nothing else of the kit.
  const kitFiles = readdirSync(kitDir, { recursive: true }).map(String).sort();
  const workflows = join('project', '.github', 'workflows');
  assert.deepEqual(
    kitFiles.filter((path) => !path.startsWith('lessons')),
    ['project', join('project', '.github'), workflows, ...['actions-health.yml', 'issue.yml', 'pr.yml', 'yokoten.yml'].map((name) => join(workflows, name)), join('project', 'AGENTS.md'), 'workflow-hashes.json'],
    'the kit\'s AGENTS.md, workflows and their hashes, and the lessons, no more',
  );
  assert.ok(kitFiles.includes(join('lessons', 'README.md')), 'the lessons table');
  assert.match(rowsText(vendored('doctor', '--all').stdout), /\n {2}ok +core-rules\n/, 'a fresh project is up to date');

  const path = join(sandbox.repo, 'AGENTS.md');
  const fresh = readFileSync(path, 'utf8');
  writeFileSync(path, fresh.replace('Plain English, close to', 'Plain words, close to'));
  assert.match(rowsText(vendored('doctor', '--all').stdout), new RegExp(String.raw`MISSING {6}core-rules: the core rules in AGENTS\.md are behind yokoten ${versionPattern}'s, or were edited by hand`));
  const result = vendored('update', '--write');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(path, 'utf8'), fresh, 'the copy writes its own kit, the one CI checks against');
});

test('init: run from the project\'s .yokoten/, it keeps .yokoten/ (#204)', async () => {
  const sandbox = makeSandbox();
  assert.ok(initIn(sandbox).ok);
  const vendored = () => spawnSync('node', ['.yokoten/bin/yokoten.ts', 'init', '--list'], { cwd: sandbox.repo, env: sandbox.env, encoding: 'utf8' });
  let result = vendored();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^ {2}kept \.yokoten\/ \(the copy running now\)$/m);
  result = vendored();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(sandbox.repo, '.yokoten', 'VERSION')));
});

// A repo inside the clone that runs init was told "kept", with nothing written (#204).
test('init: a repo inside the running copy gets its own .yokoten/, unless the copy would hold itself (#204)', () => {
  const sandbox = makeSandbox();
  const clone = join(sandbox.home, 'clone');
  for (const part of ['bin', 'src', 'kit', 'package.json']) cpSync(join(dirname(CLI), '..', part), join(clone, part), { recursive: true });
  const initIn = (path: string) => {
    mkdirSync(path, { recursive: true });
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: path, env: sandbox.env });
    return spawnSync('node', [join(clone, 'bin', 'yokoten.ts'), 'init', '--list'], { cwd: path, env: sandbox.env, encoding: 'utf8' });
  };
  const project = join(clone, 'project');
  let result = initIn(project);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^ {2}wrote \.yokoten\/ /m);
  assert.ok(existsSync(join(project, '.yokoten', 'VERSION')), 'the project has its own runtime');
  // Copying src/ into a folder inside src/ never ends, so init writes nothing and says why.
  const inside = join(clone, 'src', 'project');
  result = initIn(inside);
  // init did not move, so no moved note comes first (plan 4); the failure is one screen.
  assert.deepEqual([result.status, result.stdout, result.stderr.replace(/\s+/g, ' ')], [1, '', 'yokoten init · cannot copy the runtime to src/project/.yokoten, because it is inside src/ of the copy running now. Run yokoten from a copy outside that folder Next: `yokoten doctor` ']);
  assert.deepEqual(readdirSync(inside), ['.git'], 'nothing is written');
  assert.ok(!readdirSync(join(clone, 'src')).some((name) => name.startsWith('.')), 'no temp folder is left');
});

test('init: reads GitHub and says what it would do; --github --yes does it, and a second run changes nothing (#10)', async () => {
  const sandbox = makeSandbox();
  // A gh first on PATH that fails every call and logs it: the real gh and GitHub are never reached.
  const extra = stubGh(sandbox, {});
  const calls = () => ghCalls(sandbox);
  // Without a GitHub remote, init succeeds, says what it skipped, and never runs gh.
  let result = await sandbox.call(['init', '--github'], { extra });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^ {2}note {9}GitHub was not read: there is no origin remote yet;/m);
  assert.equal(calls().length, 0);
  assert.equal((await sandbox.call(['init', '--list', '--yes'], { extra })).status, 1, '--yes alone is refused');
  assert.equal((await sandbox.call(['init', '--list', '--remove-default-labels'], { extra })).status, 1, 'so is --remove-default-labels');
  assert.equal((await sandbox.call(['init', '--list', '--board'], { extra })).status, 1, 'and --board (#156)');
  // --github --yes asked for changes on GitHub; with no remote none were made, so it fails (#208).
  result = await sandbox.call(['init', '--list', '--github', '--yes'], { extra });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^ {2}note {9}GitHub was not read: there is no origin remote yet;/m);
  assert.match(result.stderr, /^yokoten init · --github --yes changed nothing on GitHub; the project files are\n {15}as shown above\n\nNext: `yokoten init --github --yes`\n$/m);
  assert.equal(calls().length, 0);
  // With a remote: plain init only reads GitHub and says what it would do; --github --yes
  // asks gh for the changes. The gh here answers the two reads with an empty repo and fails
  // every change, so the log shows what was asked. Each change's text, and that a second run
  // changes nothing, are in test/setup/plan.test.ts, with a gh in the test process.
  sandbox.git('remote', 'add', 'origin', 'https://github.com/example/repo.git');
  stubGh(sandbox, {
    'api --paginate repos/example/repo/labels?per_page=100 --jq .[] | {name, color, description} | tojson': '',
    'api --paginate repos/example/repo/milestones?state=all&per_page=100 --jq .[] | "\\(.state) \\(.title)"': '',
  });
  const changes = () => calls().filter((call) => call.startsWith('label create ') || call.includes(' POST '));
  result = await sandbox.call(['init', '--github'], { extra });
  assert.match(result.stdout, /^On GitHub, example\/repo:\n {2}to do {8}make label "/m, result.stdout + result.stderr);
  assert.deepEqual(changes(), [], 'without --yes init only reads');
  await sandbox.call(['init', '--list', '--github', '--yes'], { extra });
  assert.ok(changes().some((call) => call.startsWith('label create ')), 'a label is made');
  assert.ok(changes().some((call) => call.includes(' POST ') && call.includes('repos/example/repo/milestones')), 'a milestone is made');
  // Without gh on the PATH, plain init still succeeds and says so. Only node and git are there.
  const noGh = join(sandbox.home, 'no-gh');
  mkdirSync(noGh);
  const gitPath = spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout.trim();
  symlinkSync(process.execPath, join(noGh, 'node'));
  symlinkSync(join(gitPath, 'git'), join(noGh, 'git'));
  result = await sandbox.call(['init', '--github'], { extra: { PATH: noGh } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^ {2}note {9}GitHub was not read: gh is not installed/m);
  // init --github --yes fails: it was asked to change GitHub and could not (#208).
  result = await sandbox.call(['init', '--list', '--github', '--yes'], { extra: { PATH: noGh } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^yokoten init · --github --yes changed nothing on GitHub/m);
});

test('init: a yokoten.json "areas" that is not a list stops init before it writes a file (#156)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('yokoten.json', JSON.stringify({ areas: 'cli' }));
  let result = await sandbox.call(['init']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /yokoten\.json: "areas" must be a list of names/);
  assert.doesNotMatch(result.stderr, /is not a function/);
  assert.ok(!existsSync(join(sandbox.repo, 'AGENTS.md')), 'nothing written');
  // The control: the same project with a list runs.
  sandbox.write('yokoten.json', JSON.stringify({ areas: ['cli'] }));
  result = await sandbox.call(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(sandbox.repo, 'AGENTS.md')));
});

// The kit version mark in AGENTS.md (#141): newer is never "behind", and no mark compares by content.
test('core rules: the kit version mark tells older from newer; no mark compares by content (#141)', () => {
  assert.equal(compareVersions('0.8.0', '0.1.9'), 1);
  assert.equal(compareVersions('0.1.10', '0.1.9'), 1, 'numbers, not text');
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.0.0-beta.2', '1.0.0'), -1, 'a pre-release is older than its release');
  assert.equal(compareVersions('1.0.0-beta.10', '1.0.0-beta.2'), 1);
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1);
  assert.equal(compareVersions('{{version}}', '0.1.0'), null, 'not a version');
  assert.equal(readKitVersion('<!-- yokoten kit 0.3.1 -->\r\n# rules\n'), '0.3.1');
  assert.equal(readKitVersion('# rules\n'), null);

  const kit = '<!-- yokoten kit 0.8.0 -->\n# rules\n\n## This project\n';
  const own = '## This project\n\nours\n';
  const newer = compareCoreRules(`<!-- yokoten kit 0.9.0 -->\n# rules, later\n\n${own}`, kit);
  assert.deepEqual(newer, { state: 'newer', version: '0.9.0', kitVersion: '0.8.0' });
  const older = compareCoreRules(`<!-- yokoten kit 0.1.0 -->\n# old rules\n\n${own}`, kit);
  assert.equal(older.state, 'behind');
  assert.equal(older.state === 'behind' && older.updated, `<!-- yokoten kit 0.8.0 -->\n# rules\n\n${own}`, 'the update writes the new mark');
  const unmarked = compareCoreRules(`# old rules\n\n${own}`, kit);
  assert.equal(unmarked.state === 'behind' && unmarked.updated, `<!-- yokoten kit 0.8.0 -->\n# rules\n\n${own}`, 'no mark: an unknown version, compared by content');
  assert.equal(compareCoreRules(`# rules\n\n${own}`, kit).state, 'same', 'the mark alone is no change');
  assert.equal(compareCoreRules(`<!-- yokoten kit 0.9.0 -->\n# rules\n\n${own}`, kit).state, 'same', 'a newer mark with the same text is up to date');
  assert.equal(compareCoreRules(`<!-- yokoten kit {{version}} -->\n# rules, later\n\n${own}`, kit).state, 'behind', 'a mark that is not a version is unknown');
});

test('init: the default screen is one screen of groups, and no line passes 80 (#1027)', async () => {
  const sandbox = makeSandbox();
  const result = await sandbox.call(['init']);
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.split('\n');
  assert.match(result.stdout, /^yokoten init · this project is set up$/m);
  assert.match(result.stdout, /^ {2}done +rules: AGENTS\.md, the commit check$/m);
  assert.match(result.stdout, /^ {2}done +CI: 4 workflows, Dependabot$/m);
  assert.match(result.stdout, /^ {2}done +GitHub: issue and PR templates, CODEOWNERS, a security policy$/m);
  assert.match(result.stdout, /^ {2}done +agents: guard for Claude Code \(\d+ more ready\)$/m);
  assert.match(result.stdout, /^\d+ files written, none of yours changed$/m);
  // The commit command as the product builds it for this system (one source: commitCommand).
  assert.ok(result.stdout.split('\n').includes(`Next: \`${commitCommand(process.platform)}\``), result.stdout);
  assert.match(result.stdout, /^More: `yokoten init --list` shows every file$/m);
  for (const line of lines) assert.ok(line.length <= 80, `over 80 columns: ${line}`);
  assert.ok(lines.length <= 20, `${lines.length} lines is more than one screen`);
});

test('init: a second run with nothing to do is one line, and --list keeps every file (#1027)', async () => {
  const sandbox = makeSandbox();
  await sandbox.call(['init']);
  const again = await sandbox.call(['init']);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.stdout, 'yokoten init · already set up here, nothing changed\n\nMore: `yokoten init --list` shows every file\n');
  const list = initIn(sandbox);
  assert.ok(has(list, 'kept', /^\.github\/SECURITY\.md$/), 'the full listing is behind the flag');
  assert.ok(list.changes.length > 20, 'the full listing is longer than a screen');
});

test('init: partly new lists only the group that changed (#1027)', async () => {
  const sandbox = makeSandbox();
  await sandbox.call(['init']);
  rmSync(join(sandbox.repo, '.github', 'CODEOWNERS'));
  const result = await sandbox.call(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^ {2}done +GitHub: CODEOWNERS$/m);
  assert.doesNotMatch(result.stdout, /^ {2}done +rules/m, 'a group with nothing new stays folded');
  assert.match(result.stdout, /^1 file added, \d+ files already there$/m);
  assert.ok(result.stdout.split('\n').every((line) => line.length <= 80), result.stdout);
});

test('init --github --yes: the GitHub results are rows (#1027)', async () => {
  // Without a remote the planning is skipped, and the screen says so once, as a note.
  const sandbox = makeSandbox();
  const result = await sandbox.call(['init', '--github', '--yes']);
  assert.equal(result.status, 1);
  const all = result.stdout + result.stderr;
  assert.match(all, /^ {2}note +GitHub was not read: there is no origin remote yet/m);
  assert.equal(all.match(/GitHub was not read/g)?.length, 1, 'said once');
  for (const line of all.split('\n')) assert.ok(line.length <= 80, `over 80 columns: ${line}`);
});
