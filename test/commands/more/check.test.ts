// Tests for src/commands/more/check.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { test } from 'node:test';
import {
  at,
  CLI,
  makeSandbox,
  ROOT,
  writeNodeProgram,
} from '../../repo/helpers.ts';
import { invoke } from '../../repo/invoke.ts';
import { type ActionsHealth, cutPoint, failureWord, readActionsRuns, redactStream, runRedact, readHealthPullChecks, renderActionsHealth, summarizeActionsHealth } from '../../../src/commands/more/check.ts';
import { borrowedIssue, borrowedJson, borrowedScreen, checkJson, checkScreen, ciHealthScreen, hasOpenIssue, marksScreen, prSyncEnv, prSyncScreen, provenanceJson, provenanceScreen, pullLine, testEndScreen, testFilesOf, testPlanScreen } from '../../../src/commands/more/check.ts';
import { finding } from '../../../src/rules/text/message.ts';
import { screenProblems } from '../../repo/docs/screen-rules.ts';
import { type BorrowedHost, watchBorrowed } from '../../../src/run/check.ts';
import { REDACT_FAILED, wrapForRedact } from '../../../src/rules/guards/index.ts';

/** The screen as one line of words: rows wrap at 80 columns (#1027), and a match reads the words. */
const flat = (text: string): string => text.replace(/\s+/g, ' ');

/** The rules a screen breaks, as the screen test measures them. */
const broken = (lines: string[], isFailure = false): string[] => screenProblems({ text: lines.join('\n'), isFailure });

// On run, not call: one real child keeps the check entry point (exit code and output through the binary) tested (#475).
test('check --pr: reads the CI event, lists the changed files from git, notes long prose (#47)', () => {
  const sandbox = makeSandbox();
  sandbox.write('README.md', 'Short.\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'base');
  const base = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  sandbox.write('src/a.ts', 'export const a = 1;\n');
  sandbox.write('README.md', `Short.\n${Array.from({ length: 30 }, (_, i) => `w${i}`).join(' ')}.\n`);
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'head');
  const head = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  const event = (body: string) => {
    const file = join(sandbox.home, 'event.json');
    writeFileSync(file, JSON.stringify({ pull_request: { title: 'feat: a', body, labels: [{ name: 'feat' }, { name: 'tier B' }], milestone: { title: 'M0' }, base: { sha: base }, head: { sha: head } } }));
    return { GITHUB_EVENT_PATH: file };
  };
  const body = 'tier: B\nCloses #1\n## Why\nx\n## What changed\nx\n## How tested\nx\nMade with worker (opus)\n';
  let result = sandbox.run(['check', '--pr', '--all'], { extra: event(body) });
  assert.equal(result.status, 1, 'src/a.ts changed with no changelog line');
  assert.match(result.stderr, /changelog: 1 changed file/);
  // The notes are rows of the one screen, under the problems (#1115).
  assert.match(result.stderr, /^ {2}note {8}README\.md:2: a sentence of 30 words$/m);
  result = sandbox.run(['check', '--pr', '--all'], { extra: event(body.replace('Made with worker', 'No changelog: a test\n\nMade with worker')) });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /check --pr · (PR #\d+, )?no problems/);
  assert.doesNotMatch(result.stdout, /lines, over 400/, 'a small diff gets no size note (#57)');
  // Outside a pull request run, there is nothing to check.
  result = sandbox.run(['check', '--pr', '--all']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /no pull request in this run/);
});

test('check --pr: a long sentence is noted only on a line the pull request adds (#647)', async () => {
  const sandbox = makeSandbox();
  const oldSentence = `${Array.from({ length: 30 }, (_, i) => `w${i}`).join(' ')}.\n`;
  // A different long sentence, so git cannot match it to the old one and call it unchanged.
  const newSentence = `${Array.from({ length: 30 }, (_, i) => `v${i}`).join(' ')}.\n`;
  sandbox.write('README.md', `Short.\n${oldSentence}`);
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'base');
  const base = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  const head = (firstLine: string, extra = '') => {
    sandbox.write('README.md', `${firstLine}\n${oldSentence}${extra}`);
    sandbox.git('add', '.');
    sandbox.git('commit', '-qm', 'head');
    return sandbox.git('rev-parse', 'HEAD').stdout.trim();
  };
  const event = (sha: string) => {
    const file = join(sandbox.home, 'event.json');
    const body = 'tier: B\nCloses #1\n## Why\nx\n## What changed\nx\n## How tested\nx\nMade with worker (opus)\n';
    writeFileSync(file, JSON.stringify({ pull_request: { title: 'feat: a', body, labels: [{ name: 'feat' }, { name: 'tier B' }], milestone: { title: 'M0' }, base: { sha: base }, head: { sha } } }));
    return { GITHUB_EVENT_PATH: file };
  };
  // The old long sentence is on a line this commit does not touch: no note.
  let result = await sandbox.call(['check', '--pr', '--all'], { extra: event(head('Shorter.')) });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /long sentence/);
  // A second long sentence on the line this commit adds is noted, and the old one still is not.
  result = await sandbox.call(['check', '--pr', '--all'], { extra: event(head('Shorter.', newSentence)) });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^ {2}note {8}README\.md:3: a sentence of 30 words$/m);
});

test('check --pr: a change file counts as the changelog entry, and its form is checked (#132)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('README.md', 'Short.\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'base');
  const base = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  const commit = (files: Record<string, string>) => {
    for (const [file, content] of Object.entries(files)) sandbox.write(file, content);
    sandbox.git('add', '.');
    sandbox.git('commit', '-qm', 'head');
    return sandbox.git('rev-parse', 'HEAD').stdout.trim();
  };
  const good = commit({ 'src/a.ts': 'export const a = 1;\n', 'changes/1-a.md': 'Added\n\nA new thing.\n' });
  const bad = commit({ 'changes/1-a.md': 'Improved\n\nA new thing.\n' });
  const event = (head: string) => {
    const file = join(sandbox.home, 'event.json');
    const body = 'tier: B\nCloses #1\n## Why\nx\n## What changed\nx\n## How tested\nx\nMade with worker (opus)\n';
    writeFileSync(file, JSON.stringify({ pull_request: { title: 'feat: a', body, labels: [{ name: 'feat' }, { name: 'tier B' }], milestone: { title: 'M0' }, base: { sha: base }, head: { sha: head } } }));
    return { GITHUB_EVENT_PATH: file };
  };
  let result = await sandbox.call(['check', '--pr', '--all'], { extra: event(good) });
  assert.equal(result.status, 0, result.stderr);
  result = await sandbox.call(['check', '--pr', '--all'], { extra: event(bad) });
  assert.equal(result.status, 1);
  assert.match(flat(result.stderr), /MISSING changes\/1-a\.md:1 line 1 is not a section .*Make line 1 one of: Added, Changed/);
  assert.doesNotMatch(result.stderr, /changelog: /, 'the file still counts as the entry');
});

test('check --pr: CODEOWNERS comes from the base branch, so a pull request cannot lower its own tier', async () => {
  const sandbox = makeSandbox();
  sandbox.write('.github/CODEOWNERS', '/kit/ @owner\n');
  sandbox.write('README.md', 'Short.\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'base');
  const base = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  // The pull request edits CODEOWNERS to drop kit/, and changes kit/.
  sandbox.write('.github/CODEOWNERS', '/nothing/ @owner\n');
  sandbox.write('kit/a.md', 'Short.\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'head');
  const head = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  const event = (tier: string) => {
    const file = join(sandbox.home, 'event.json');
    const body = `tier: ${tier}\nCloses #1\nThis changes the kit.\n## Why\nx\n## What changed\nx\n## How tested\nx\nMade with worker (opus)\n`;
    writeFileSync(file, JSON.stringify({ pull_request: { title: 'feat: a', body, labels: [{ name: 'feat' }, { name: `tier ${tier}` }], milestone: { title: 'M0' }, base: { sha: base }, head: { sha: head } } }));
    return { GITHUB_EVENT_PATH: file };
  };
  let r = await sandbox.call(['check', '--pr', '--all'], { extra: event('B') });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /this changes 1 file\(s\) that CODEOWNERS owns\n +\(read from the base branch\): kit\/a\.md/);
  r = await sandbox.call(['check', '--pr', '--all'], { extra: event('A') });
  assert.equal(r.status, 0, r.stderr);
});

test('check --pr: a large pull request gets a note, never a failure; lock files do not count (#57)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('README.md', 'Short.\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'base');
  const base = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `export const a${i} = ${i};\n`).join('');
  sandbox.write('package-lock.json', lines(1000));
  sandbox.write('src/a.ts', lines(300));
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'small');
  const small = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  sandbox.write('src/b.ts', lines(200));
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'large');
  const large = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  const event = (head: string) => {
    const file = join(sandbox.home, 'event.json');
    const body = 'tier: B\nCloses #1\n## Why\nx\n## What changed\nx\n## How tested\nx\nNo changelog: a test\nMade with worker (opus)\n';
    writeFileSync(file, JSON.stringify({ pull_request: { title: 'feat: a', body, labels: [{ name: 'feat' }, { name: 'tier B' }], milestone: { title: 'M0' }, base: { sha: base }, head: { sha: head } } }));
    return { GITHUB_EVENT_PATH: file };
  };
  let r = await sandbox.call(['check', '--pr', '--all'], { extra: event(small) });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /lines, over 400/, '300 lines; the lock file does not count');
  r = await sandbox.call(['check', '--pr', '--all'], { extra: event(large) });
  assert.equal(r.status, 0, r.stderr);
  assert.match(flat(r.stdout), /note this pull request changes 500 lines, over 400 Smaller pull requests are easier to review/);
  assert.match(r.stdout, /check --pr · (PR #\d+, )?no problems/);
});

test('check --pr: each ignore the pull request adds is a notice on the page, never a failure (#616)', async () => {
  const sandbox = makeSandbox();
  const marker = ['yokoten', 'ignore'].join('-');
  sandbox.write('src/a.ts', `export const a = 1; // ${marker} email: an old one\n`);
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'base');
  const base = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  sandbox.write('src/a.ts', `export const a = 1; // ${marker} email: an old one\nexport const b = 2; // ${marker} secret: a test fixture\n`);
  sandbox.write('.yokotenignore', 'ip: documentation examples\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'head');
  const head = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  const file = join(sandbox.home, 'event.json');
  const body = 'tier: B\nCloses #1\n## Why\nx\n## What changed\nx\n## How tested\nx\nNo changelog: a test\nMade with worker (opus)\n';
  writeFileSync(file, JSON.stringify({ pull_request: { title: 'feat: a', body, labels: [{ name: 'feat' }, { name: 'tier B' }], milestone: { title: 'M0' }, base: { sha: base }, head: { sha: head } } }));
  const r = await sandbox.call(['check', '--pr', '--all'], { extra: { GITHUB_EVENT_PATH: file, GITHUB_ACTIONS: 'true' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ {2}note {8}src\/a\.ts:2: /m);
  assert.match(r.stdout, /^ {2}note {8}\.yokotenignore:1: /m);
  assert.match(r.stdout, /::notice file=src\/a\.ts,line=2,title=yokoten ignore-added::src\/a\.ts:2: this pull request lets a secret hit through on this line \[ignored: a test fixture\]/);
  assert.match(r.stdout, /::notice file=\.yokotenignore,line=1,title=yokoten ignore-added::\.yokotenignore:1: this pull request lets ip hits through in the whole repo \[ignored: documentation examples\]/);
  assert.doesNotMatch(r.stdout, /an old one/, 'an ignore already on the base branch is not new');
});

test('check --issue: reads the issue from the CI event; a bad title fails, a good one passes', async () => {
  const sandbox = makeSandbox();
  sandbox.write('yokoten.json', JSON.stringify({ areas: ['doctor', 'check'] }));
  const event = (issue: object) => {
    const file = join(sandbox.home, 'event.json');
    writeFileSync(file, JSON.stringify({ action: 'opened', issue }));
    return { GITHUB_EVENT_PATH: file };
  };
  let result = await sandbox.call(['check', '--issue'], { extra: event({ title: 'doctor: add the review step', labels: [{ name: 'feat' }] }) });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /check --issue · no problems in this issue/);
  result = await sandbox.call(['check', '--issue'], { extra: event({ title: 'The review step is missing.', labels: [{ name: 'incident' }] }) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /check --issue · 2 problems\n\n  MISSING     title:?\s+it does not start with an area\n +The area tells a reader[^]*Write it as `area: symptom`[^]*\n  MISSING     title:?\s+a full stop at the end/);
  assert.doesNotMatch(result.stderr, /The review step is missing/, 'the title is user input; it is not printed back');
  result = await sandbox.call(['check', '--issue'], { extra: event({ title: 'site: a page', labels: [] }) });
  assert.equal(result.status, 1);
  assert.match(flat(result.stderr), /Use one of: doctor, check/);
  result = await sandbox.call(['check', '--issue', '--json'], { extra: event({ title: 'site: a page.', labels: [] }) });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.equal(report.check, 'issue');
  assert.deepEqual(report.findings.map((f: { id: string }) => f.id), ['issue-area', 'issue-title']);
  assert.ok(!result.stdout.includes('a page'), 'the title is not printed back');
  result = await sandbox.call(['check', '--issue', '--pr']);
  assert.equal(result.status, 1, 'two modes are a usage error');
  assert.equal(result.stdout, '');
  // A comment on a pull request comes as an issue too; it is not an issue to check.
  result = await sandbox.call(['check', '--issue'], { extra: event({ title: 'Anything', pull_request: { url: 'x' } }) });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /no issue in this run/);
  result = await sandbox.call(['check', '--issue']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /no issue in this run/);
  result = await sandbox.call(['check', '--issue', '--json']);
  assert.deepEqual(JSON.parse(result.stdout).skipped, 'no issue in this run (it reads the CI event); nothing to check');
});

// #544: `check --issue` also checks the labels: one type label and one tier label,
// when the repo has those labels. A repo without a kind gets no line for it.
test('check --issue: an issue needs the type and tier labels its repo has (#544)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('yokoten.json', JSON.stringify({ areas: ['doctor'] }));
  sandbox.git('remote', 'add', 'origin', 'https://github.com/octo/app.git');
  // A gh first on PATH that answers `label list` from labels.json; every other call fails.
  const bin = join(sandbox.home, 'bin');
  mkdirSync(bin);
  const labelsFile = join(sandbox.home, 'labels.json');
  writeFileSync(
    join(bin, 'gh'),
    `#!/usr/bin/env node\n// A dynamic import works whether Node loads this file as CommonJS or as an ES module.\nimport('node:fs').then((fs) => {\n  if (process.argv.slice(2, 4).join(" ") === "label list") { process.stdout.write(fs.readFileSync(${JSON.stringify(labelsFile)}, "utf8")); process.exit(0); }\n  process.exit(1);\n});\n`,
    { mode: 0o755 },
  );
  const extra = { PATH: `${bin}:${process.env.PATH}` };
  const setLabels = (names: string[]) => writeFileSync(labelsFile, JSON.stringify(names.map((name) => ({ name }))));
  const event = (labels: string[]) => {
    const file = join(sandbox.home, 'event.json');
    writeFileSync(file, JSON.stringify({ action: 'opened', issue: { title: 'doctor: add the review step', labels: labels.map((name) => ({ name })) } }));
    return { GITHUB_EVENT_PATH: file, ...extra };
  };
  setLabels(['feat', 'bug', 'docs', 'tier A', 'tier B', 'tier C']);
  // Both: none.
  let result = await sandbox.call(['check', '--issue'], { extra: event(['bug', 'tier B']) });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /check --issue · no problems in this issue/);
  // No type label: one line (the positive control).
  result = await sandbox.call(['check', '--issue'], { extra: event(['tier B']) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /check --issue · 1 problem\n\n  MISSING     labels:?\s+no type label\n +A reviewer filters on labels[^]*Add one type label, such as feat, bug, docs/);
  assert.match(flat(result.stderr), /Add one type label, such as feat, bug, docs/);
  assert.doesNotMatch(result.stderr, /tier B.*no tier label/, 'the tier label it has is not named');
  // No tier label: one line (the positive control).
  result = await sandbox.call(['check', '--issue'], { extra: event(['bug']) });
  assert.equal(result.status, 1);
  assert.match(flat(result.stderr), /check --issue · 1 problem MISSING labels:? no tier label .*Add one tier label: `tier A`, `tier B` or `tier C`/);
  // Both missing: one line each.
  result = await sandbox.call(['check', '--issue'], { extra: event(['kit']) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /check --issue · 2 problems/);
  // A repo without tier labels: no line for the tier.
  setLabels(['feat', 'bug', 'docs']);
  result = await sandbox.call(['check', '--issue'], { extra: event(['bug']) });
  assert.equal(result.status, 0, result.stderr);
  // A repo without type labels: no line for the type.
  setLabels(['tier A', 'tier B']);
  result = await sandbox.call(['check', '--issue'], { extra: event(['tier A']) });
  assert.equal(result.status, 0, result.stderr);
  // gh can't list the labels: only the title is checked.
  const bare = makeSandbox();
  bare.write('yokoten.json', JSON.stringify({ areas: ['doctor'] }));
  const bareEvent = join(bare.home, 'event.json');
  writeFileSync(bareEvent, JSON.stringify({ action: 'opened', issue: { title: 'doctor: add the review step', labels: [] } }));
  result = await bare.call(['check', '--issue'], { extra: { GITHUB_EVENT_PATH: bareEvent } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /check --issue · no problems in this issue/);
});

// #91: in GitHub Actions, the findings show on the pull request page: an annotation per
// finding on stdout, and a job summary. The finding text is reused, so no private value.
test('check in GitHub Actions: annotations and a job summary, place but never content (#91)', async () => {
  const sandbox = makeSandbox();
  const marks = join(sandbox.home, 'marks');
  writeFileSync(marks, 'mycity\n');
  const token = `${'gh'}p_${'x7Y2k9'.repeat(6)}`;
  const email = `me${at}gmail.com`;
  sandbox.write('a.md', 'fine\n');
  sandbox.write('notes/b.md', `fine\n${email}\nI live in MyCity\ntoken ${token}\n`);
  sandbox.git('add', '.');
  const summary = join(sandbox.home, 'summary.md');
  const actions = { GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary, YOKOTEN_PRIVATE_MARKS: marks };
  const before = await sandbox.call(['check'], { extra: { YOKOTEN_PRIVATE_MARKS: marks } });
  const result = await sandbox.call(['check'], { extra: actions });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, before.stderr, 'the text for people is the same');
  const lines = result.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^::error file=notes\/b\.md,line=2,title=yokoten email::notes\/b\.md:2: an email address\. .+\. .+\.%0A  docs: https:\/\/\S+#privacy$/);
  assert.match(lines[1], /^::error file=notes\/b\.md,line=3,title=yokoten private-mark::notes\/b\.md:3: matches a word you added to your private marks\. /);
  assert.match(lines[2], /^::error file=notes\/b\.md,line=4,title=yokoten secret::notes\/b\.md:4: a secret \(GitHub token\)\. /);
  const text = readFileSync(summary, 'utf8');
  assert.match(text, /^### yokoten check: 3 problems\n\n\| Place \| Rule \| What \| Why \| Fix \|\n/);
  assert.match(text, /\| notes\/b\.md:2 \| \[email\]\(https:\/\/\S+#privacy\) \| an email address \| .+ \| .+ \|/);
  assert.match(text, /\| notes\/b\.md:3 \| \[private-mark\]\(\S+\) \| matches a word you added to your private marks \|/);
  assert.match(text, /\| notes\/b\.md:4 \| \[secret\]\(\S+\) \| a secret \(GitHub token\) \|/);
  // The positive control: the place is there, the matched text is not (core rule 11).
  for (const out of [result.stdout, text]) {
    assert.ok(!out.includes(token) && !out.includes(email) && !/mycity/i.test(out), 'no matched text');
    assert.ok(!out.includes(sandbox.home), 'the home folder is never shown');
  }
  // --json keeps stdout pure JSON; the summary is still written. The summary file grows.
  const json = await sandbox.call(['check', '--json'], { extra: actions });
  assert.equal(JSON.parse(json.stdout).ok, false);
  assert.equal(readFileSync(summary, 'utf8').split('### yokoten check: 3 problems').length, 3, 'appended, not replaced');
  // ok, with the mode in the heading.
  sandbox.git('rm', '-q', '--cached', 'notes/b.md');
  rmSync(join(sandbox.repo, 'notes'), { recursive: true });
  const ok = await sandbox.call(['check', '--staged'], { extra: actions });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, 'yokoten check --staged · clean: layout, privacy, lead-only files\n', 'no findings, no annotations');
  assert.match(readFileSync(summary, 'utf8'), /### yokoten check --staged: ok\n\n$/);
});

test('check outside GitHub Actions: the output is unchanged and no summary is written (#91)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('a.md', `me${at}gmail.com\n`);
  sandbox.git('add', '.');
  const summary = join(sandbox.home, 'summary.md');
  const plain = await sandbox.call(['check']);
  assert.equal(plain.status, 1);
  assert.equal(plain.stdout, '');
  assert.match(plain.stderr, /^yokoten check · 1 problem\n\n  MISSING     a\.md:1      an email address\n(?:[^\n]+\n){5,9}\nNext: fix it, then `yokoten check`\nMore: \S+#privacy\n$/);
  for (const extra of [{ GITHUB_STEP_SUMMARY: summary }, { GITHUB_ACTIONS: 'false', GITHUB_STEP_SUMMARY: summary }] as Record<string, string>[]) {
    const r = await sandbox.call(['check'], { extra });
    assert.deepEqual([r.status, r.stdout, r.stderr], [plain.status, plain.stdout, plain.stderr], JSON.stringify(extra));
  }
  assert.ok(!existsSync(summary), 'no summary outside Actions');
});

test('check --pr: notes hard-to-read names on added code lines, and the exit code does not change (#111)', async () => {
  const project = makeSandbox();
  const filler = Array(11).fill('// filler');
  // An old file with a long-lived one-letter name: not noted, its lines are not added.
  project.write('src/old.ts', ['const t = 0;', ...filler, 'console.log(t);', ''].join('\n'));
  project.write('src/moved.ts', ['const q = 0;', ...filler, 'console.log(q);', ''].join('\n'));
  project.git('add', '.');
  project.git('commit', '-qm', 'base');
  const base = project.git('rev-parse', 'HEAD').stdout.trim();
  project.write('src/old.ts', ['const t = 0;', ...filler, 'console.log(t);', 'const count = t + 1;', ''].join('\n'));
  project.git('mv', 'src/moved.ts', 'src/renamed.ts');
  project.write('src/cart.js', ['const s = 0;', 'const loadTheWholeUserList = () => [];', 'for (let i = 0; i < 3; i++) console.log(i);', ...filler, 'console.log(s);', ''].join('\n'));
  project.git('add', '.');
  project.git('commit', '-qm', 'head');
  const head = project.git('rev-parse', 'HEAD').stdout.trim();
  const file = join(project.home, 'event.json');
  const body = 'tier: B\nCloses #1\n## Why\nx\n## What changed\nx\n## How tested\nx\nNo changelog: a test\nMade with worker (opus)\n';
  writeFileSync(file, JSON.stringify({ pull_request: { title: 'feat: a', body, labels: [{ name: 'feat' }, { name: 'tier B' }], milestone: { title: 'M0' }, base: { sha: base }, head: { sha: head } } }));
  const r = await project.call(['check', '--pr', '--all'], { extra: { GITHUB_EVENT_PATH: file } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(flat(r.stdout), /note src\/cart\.js:1: "s" is used for 14 lines A reader must scroll back to learn what it holds\. Name what it is, e\.g\. "text"\. note src\/cart\.js:2: "loadTheWholeUserList" has 5 words, over 4 /);
  assert.doesNotMatch(r.stdout, /"i"|old\.ts|renamed\.ts/, 'no note for `i` in a short loop, for unchanged lines, or for a moved file');
  assert.match(r.stdout, /check --pr · (PR #\d+, )?no problems/);
  const json = JSON.parse((await project.call(['check', '--pr', '--all', '--json'], { extra: { GITHUB_EVENT_PATH: file } })).stdout);
  assert.equal(json.ok, true, 'notes never fail the check');
  assert.deepEqual(json.notes.map((note: { id: string; file: string; line: number }) => `${note.id} ${note.file}:${note.line}`), ['name-short src/cart.js:1', 'name-long src/cart.js:2']);
});

test('check --pr in GitHub Actions: notes are warnings, in their own section (#91)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('README.md', 'Short.\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'base');
  const base = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  sandbox.write('README.md', `Short.\n${Array.from({ length: 30 }, (_, i) => `w${i}`).join(' ')}.\n`);
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'head');
  const head = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  const file = join(sandbox.home, 'event.json');
  writeFileSync(file, JSON.stringify({ pull_request: { title: 'feat: a', body: 'tier: B\nCloses #1\n## Why\nx\n## What changed\nx\n## How tested\nx\nMade with worker (opus)\n', labels: [{ name: 'feat' }, { name: 'tier B' }], milestone: null, base: { sha: base }, head: { sha: head } } }));
  const summary = join(sandbox.home, 'summary.md');
  const r = await sandbox.call(['check', '--pr', '--all'], { extra: { GITHUB_EVENT_PATH: file, GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary } });
  assert.equal(r.status, 1, 'no milestone');
  assert.match(r.stdout, /^::error title=yokoten pr-milestone::/m, 'a finding with no place has no file');
  assert.match(r.stdout, /^::notice file=README\.md,line=2,title=yokoten long-sentence::README\.md:2: a sentence of 30 words\. /m, 'a plain note is a notice (#1239)');
  const text = readFileSync(summary, 'utf8');
  assert.match(text, /^### yokoten check --pr: 1 problem\n/);
  assert.match(text, /\n#### Notes \(1\): these never fail the check\n\n\| Place \| Rule \| What \| Why \| Fix \|\n\|[-|]+\|\n\| README\.md:2 \| long-sentence \| a sentence of 30 words \|/);
});

// #299: Dependabot writes its own body, so its pull request gets the title check and the
// body rules as notes, in text, JSON and the job summary.
test('check --pr: a Dependabot pull request passes with notes; the same body from anyone else fails (#299)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('.github/CODEOWNERS', '/.github/ @owner\n');
  sandbox.write('.github/workflows/ci.yml', 'steps:\n  - uses: actions/checkout@v4.2.1\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'base');
  const base = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  sandbox.write('.github/workflows/ci.yml', 'steps:\n  - uses: actions/checkout@v4.2.2\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'head');
  const head = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  const body = [
    'Bumps the actions group with 1 update: [actions/checkout](https://github.com/actions/checkout).',
    '',
    'Updates `actions/checkout` from 4.2.1 to 4.2.2',
    '',
    "Dependabot will resolve any conflicts with this PR as long as you don't alter it yourself. You can also trigger a rebase manually by commenting `@dependabot rebase`.",
    '',
    '[//]: # (dependabot-automerge-start)',
    '[//]: # (dependabot-automerge-end)',
    '',
    '---',
    '',
    '<details>',
    '<summary>Dependabot commands and options</summary>',
    '</details>',
  ].join('\n');
  const event = (login: string, title = 'ci: bump the actions group with 1 update') => {
    const file = join(sandbox.home, 'event.json');
    const labels = [{ name: 'dependencies' }, { name: 'github_actions' }];
    writeFileSync(file, JSON.stringify({ pull_request: { title, body, user: { login, type: 'Bot' }, labels, milestone: null, base: { sha: base }, head: { sha: head } } }));
    return file;
  };
  const summary = join(sandbox.home, 'summary.md');
  let result = await sandbox.call(['check', '--pr', '--all'], { extra: { GITHUB_EVENT_PATH: event('dependabot[bot]') } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(flat(result.stdout), /note body: the first line is not a tier .*Dependabot opened this pull request, so it is a note\./);
  assert.match(result.stdout, /^ {2}note {8}milestone: none set$/m);
  assert.equal(result.stdout.match(/^ {2}note {8}/gm)?.length, 9, 'the nine rules Dependabot does not meet, each a note');
  assert.match(result.stdout, /^yokoten check --pr · (PR #\d+, )?no problems[^\n]*\n\n/);
  result = await sandbox.call(['check', '--pr', '--all', '--json'], { extra: { GITHUB_EVENT_PATH: event('dependabot[bot]'), GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary } });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual([report.ok, report.findings, report.notes.map((note: { id: string }) => note.id)], [true, [], ['pr-tier', 'pr-section', 'pr-section', 'pr-section', 'pr-issue', 'pr-made-with', 'pr-milestone', 'pr-labels', 'pr-labels']]);
  assert.match(readFileSync(summary, 'utf8'), /#### Notes \(9\): these never fail the check\n[^]*\| \[pr-tier\]\(\S+\) \| body: the first line is not a tier \|/);

  // The same body from anyone else fails as before.
  result = await sandbox.call(['check', '--pr', '--all', '--json'], { extra: { GITHUB_EVENT_PATH: event('someone') } });
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout).findings.map((f: { id: string }) => f.id), ['pr-tier', 'pr-section', 'pr-section', 'pr-section', 'pr-issue', 'pr-made-with', 'pr-milestone', 'pr-labels', 'pr-labels']);
  // A bad title from Dependabot still fails.
  result = await sandbox.call(['check', '--pr', '--all', '--json'], { extra: { GITHUB_EVENT_PATH: event('dependabot[bot]', 'Bump the actions group with 1 update') } });
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout).findings.map((f: { id: string }) => f.id), ['pr-title']);
});

/** The error code when this machine may not listen on 127.0.0.1 (a sandbox), else null. */
async function listenRefusal(): Promise<string | null> {
  const server = createServer();
  return new Promise((done) => {
    server.once('error', (error: NodeJS.ErrnoException) => done(error.code ?? 'a refusal'));
    server.listen(0, '127.0.0.1', () => server.close(() => done(null)));
  });
}

// #645: GitHub can start the runs of one pull request in any order, and each event file
// keeps the labels of its own moment. When the workflow asks (YOKOTEN_PR_LIVE), every run
// reads the pull request as it is now, so a late run for `opened` judges the labels added
// since, and a rerun judges it again. A draft is judged in full, like any pull request.
test('check --pr with YOKOTEN_PR_LIVE: judges the pull request as it is now, a draft in full; a failed read fails (#645)', async (t) => {
  // A sandbox can refuse the call itself (`listen EPERM`) before any assertion runs; say so
  // in one line and skip (#827). CI allows a local server, so the test runs there.
  if ((await listenRefusal()) !== null) {
    t.skip('this machine does not allow a local server; skipped');
    return;
  }
  const sandbox = makeSandbox();
  sandbox.write('README.md', 'Short.\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'base');
  const base = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  sandbox.write('README.md', 'Short.\nMore.\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'head');
  const head = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  const body = 'tier: B\nCloses #1\n## Why\nx\n## What changed\nx\n## How tested\nx\nNo changelog: a test\nMade with worker (opus)\n';
  // The event of `opened`: no labels and no milestone yet, as the bot opens it.
  const file = join(sandbox.home, 'event.json');
  writeFileSync(file, JSON.stringify({ number: 7, repository: { full_name: 'octo/app' }, pull_request: { number: 7, title: 'feat: a', body, labels: [], milestone: null, draft: false, base: { sha: base }, head: { sha: head } } }));
  const token = 'ghs_never_printed_645';
  let now: Record<string, unknown> = { title: 'feat: a', body, labels: [{ name: 'feat' }, { name: 'tier B' }], milestone: { title: 'M0' }, draft: false, user: { login: 'someone' } };
  let status = 200;
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url} ${req.headers.authorization === `Bearer ${token}` ? 'token' : 'no token'}`);
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(status === 200 ? now : { message: 'nope' }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const summary = join(sandbox.home, 'summary.md');
  const ci = { GITHUB_EVENT_PATH: file, YOKOTEN_PR_LIVE: '1', GITHUB_TOKEN: token, YOKOTEN_GITHUB_API: api, GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary };
  const outputs: string[] = [];
  const call = async (args: string[], extra: Record<string, string> = ci) => {
    const result = await sandbox.call(args, { extra });
    outputs.push(result.stdout, result.stderr);
    return result;
  };
  const ids = (stdout: string) => JSON.parse(stdout).findings.map((f: { id: string }) => f.id);
  try {
    // Without YOKOTEN_PR_LIVE, a token alone changes nothing: the event file is read, and
    // it has no labels and no milestone, so it fails. No request is made.
    let result = await call(['check', '--pr', '--all', '--json'], { GITHUB_EVENT_PATH: file, GITHUB_TOKEN: token, YOKOTEN_GITHUB_API: api });
    assert.equal(result.status, 1);
    assert.deepEqual(ids(result.stdout).sort(), ['pr-labels', 'pr-labels', 'pr-milestone']);
    assert.deepEqual(requests, [], 'no opt-in, no read');

    // With it, the labels and milestone the pull request has now win over the event's.
    result = await call(['check', '--pr', '--all']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /check --pr · (PR #\d+, )?no problems[^\n]*\n$/);
    assert.deepEqual(requests, ['GET /repos/octo/app/pulls/7 token']);

    // A label taken off since: the same old event file now fails, as a rerun would.
    now = { ...now, labels: [{ name: 'feat' }] };
    result = await call(['check', '--pr', '--all', '--json']);
    assert.equal(result.status, 1);
    assert.deepEqual(ids(result.stdout), ['pr-labels']);

    // A draft is judged in full: missing a label it fails, with its labels it passes.
    now = { ...now, draft: true };
    result = await call(['check', '--pr', '--all', '--json']);
    assert.equal(result.status, 1);
    assert.deepEqual(ids(result.stdout), ['pr-labels']);
    now = { ...now, labels: [{ name: 'feat' }, { name: 'tier B' }] };
    result = await call(['check', '--pr', '--all']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /check --pr · (PR #\d+, )?no problems[^\n]*\n$/);

    // A read that fails fails the check; the old event file is never the answer.
    status = 403;
    result = await call(['check', '--pr', '--all', '--json']);
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stdout).findings.map((f: { id: string; what: string }) => [f.id, f.what]), [['pr-current', "pull request 7 can't be read as it is now: GitHub answered 403"]]);
    assert.match(readFileSync(summary, 'utf8'), /\| \[pr-current\]\(\S+\) \| pull request 7 can't be read as it is now: GitHub answered 403 \|/);
    // Asked for, with no token: it fails too, and asks for the token.
    status = 200;
    requests.length = 0;
    result = await call(['check', '--pr', '--all'], { ...ci, GITHUB_TOKEN: '' });
    assert.equal(result.status, 1);
    assert.match(flat(result.stderr), /MISSING GITHUB_TOKEN is not set, so the pull request as it is now can't be read .*Give the step `GITHUB_TOKEN: \$\{\{ github\.token \}\}` and the job `pull-requests: read`, then run the job again/);
    assert.deepEqual(requests, []);
  } finally {
    server.close();
  }
  // The token is never printed: not in the output, not in the job summary.
  for (const text of [...outputs, readFileSync(summary, 'utf8')]) assert.ok(!text.includes(token), 'the token was printed');
  assert.ok(!outputs.join('').includes('127.0.0.1'), 'the API address is not printed');
});

// ---- redact (#390) ----
//
// One session showed the owner's details six times. Each slip is replayed here in a
// sandbox: the value must come out as a placeholder. All values are made up.
const OWNER = 'Jane Example';
const LOGIN = 'janex';
const CITY = 'Fakeville';
const HOST = 'build.private-host.dev';
const EMAIL = `jane${at}personal-mail.dev`;

/** A sandbox whose repo has the owner as git author and a remote at a private host; with marks unless `marks` is false. */
function ownerSandbox({ marks = true } = {}) {
  const sandbox = makeSandbox();
  sandbox.git('config', 'user.name', OWNER);
  sandbox.git('config', 'user.email', EMAIL);
  sandbox.git('remote', 'add', 'origin', `ssh://git${at}${HOST}:2222/${LOGIN}/app.git`);
  sandbox.write('README.md', 'Hello.\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'docs: hello');
  if (marks) {
    mkdirSync(join(sandbox.home, '.config', 'yokoten'), { recursive: true });
    writeFileSync(join(sandbox.home, '.config', 'yokoten', 'private-marks'), `# mine\n${OWNER}\n${LOGIN}\n${CITY}\n${HOST}\n`);
  }
  // A command as the hook rewrites it, run by bash: its output, and its exit code.
  const wrapped = (command: string) => spawnSync('bash', ['-c', wrapForRedact(command, `node "${CLI}" redact`)], { cwd: sandbox.repo, env: sandbox.env, encoding: 'utf8' });
  return { sandbox, wrapped };
}

const assertHidden = (output: string, values: string[]) => {
  for (const value of values) assert.ok(!output.toLowerCase().includes(value.toLowerCase()), `a value was left in: ${output}`);
};

test('redact: the six slips come out as placeholders (#390)', async () => {
  const { sandbox, wrapped } = ownerSandbox();
  // 1. A git author line.
  const log = wrapped('git log -1');
  assert.equal(log.status, 0, log.stderr);
  assert.match(log.stdout, /Author: <owner> <<email>>/);
  // 2. A CODEOWNERS file.
  sandbox.write('CODEOWNERS', `* @${LOGIN}\n`);
  assert.equal(wrapped('cat CODEOWNERS').stdout, '* @<mark>\n');
  // 3. A push error with the private remote: the exit code is the command's.
  const push = wrapped(`echo "fatal: unable to access 'https://${HOST}/${LOGIN}/app.git/': Could not resolve host: ${HOST}" >&2; exit 128`);
  assert.equal(push.status, 128);
  assert.equal(push.stdout, "fatal: unable to access 'https://<host>/<mark>/app.git/': Could not resolve host: <host>\n");
  // 4. A deploy log with an email.
  assert.equal(wrapped(`echo "Deployed by ${EMAIL} to ${CITY.toLowerCase()}-worker"`).stdout, 'Deployed by <email> to <mark>-worker\n');
  // 5. A traffic report with the login in a path.
  assert.equal(wrapped(`echo '{"path":"/${LOGIN}/app/blob/main/README.md","count":3}'`).stdout, '{"path":"/<mark>/app/blob/main/README.md","count":3}\n');
  // 6. A page title.
  assert.equal(wrapped(`echo "${LOGIN}/app: Settings - ${OWNER} from ${CITY}"`).stdout, '<mark>/app: Settings - <owner> from <mark>\n');
  for (const result of [log, push]) assertHidden(result.stdout, [OWNER, LOGIN, CITY, HOST, EMAIL]);
});

test('redact: without a private-marks file, git name, email and private hosts are still hidden (#390)', async () => {
  const { wrapped } = ownerSandbox({ marks: false });
  const log = wrapped('git log -1; git remote -v');
  assert.equal(log.status, 0, log.stderr);
  assert.match(log.stdout, /Author: <owner> <<email>>/);
  assert.match(log.stdout, /origin\tssh:\/\/git@<host>:2222\//);
  assertHidden(log.stdout, [OWNER, HOST, EMAIL]);
});

// On run, not call: one real child keeps the redact entry point (exit code and output through the binary) tested (#475).
test('redact: keeps line ends, a last line with no end, and text that names nobody (#390)', () => {
  const { sandbox } = ownerSandbox();
  const input = `ok\r\nnoreply${at}github.com and logo${at}2x.png\nannual ${OWNER.toUpperCase()}\nlast`;
  const result = sandbox.run(['redact'], { input });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `ok\r\nnoreply${at}github.com and logo${at}2x.png\nannual <owner>\nlast`);
  // A long output streams through whole.
  const long = `${'line one\n'.repeat(50_000)}${OWNER}\n`;
  const streamed = sandbox.run(['redact'], { input: long });
  assert.equal(streamed.stdout, `${'line one\n'.repeat(50_000)}<owner>\n`);
  assert.deepEqual([sandbox.run(['redact', '--x']).status], [1]);
});

// #475: in this process, redact reads the output from the invocation's stdin as a stream,
// and writes what it hid to the invocation's stdout.
test('redact: in-process, the given stdin comes out hidden, a long one streamed whole (#475)', async () => {
  const { sandbox } = ownerSandbox();
  const run = (stdin: string) => invoke(['redact'], { env: sandbox.env, cwd: sandbox.repo, stdin });
  assert.deepEqual(await run(`by ${OWNER} at ${HOST}\nlast`), { code: 0, stdout: 'by <owner> at <host>\nlast', stderr: '', output: 'by <owner> at <host>\nlast' });
  const long = `${'line one\n'.repeat(50_000)}${EMAIL}\n`;
  assert.equal((await run(long)).stdout, `${'line one\n'.repeat(50_000)}<email>\n`);
  assert.deepEqual(await run(''), { code: 0, stdout: '', stderr: '', output: '' });
});

// #1006: redact fails closed. A marks file it cannot read, or a piece it cannot redact,
// prints nothing more of the input, one failure screen on stderr, and exit 1. Then the wrapper hides the rest.
const REDACT_REFUSED = /^yokoten redact · the output is hidden, because [^]*\n\nNext: [^\n]*`[^\n]*\n$/;

test('redact: fails closed; a marks file it cannot read prints none of the input, one line, exit 1 (#1006)', async () => {
  const { sandbox } = ownerSandbox();
  // A folder where the file should be: reading it fails, as root too.
  const folder = join(sandbox.home, 'marks-folder');
  mkdirSync(folder);
  const unreadable: [why: string, path: string][] = [['a folder', folder]];
  // A file with no read permission: root reads it anyway, so only for others.
  if (process.getuid?.() !== 0) {
    const locked = join(sandbox.home, 'marks-locked');
    writeFileSync(locked, `${CITY}\n`);
    chmodSync(locked, 0o000);
    unreadable.push(['a file with no read permission', locked]);
  }
  for (const [why, path] of unreadable) {
    const result = await sandbox.call(['redact'], { input: `Author: ${OWNER} <${EMAIL}>\n${'more\n'.repeat(10_000)}`, extra: { YOKOTEN_PRIVATE_MARKS: path } });
    assert.equal(result.status, 1, why);
    assert.equal(result.stdout, '', why);
    assert.match(result.stderr, REDACT_REFUSED, why);
    assertHidden(result.stderr, [OWNER, EMAIL, sandbox.home]);
  }
});

test('redact: through the wrapper, a marks file it cannot read hides the output and prints REDACT_FAILED (#1006)', () => {
  const { sandbox } = ownerSandbox();
  const broken = join(sandbox.home, 'marks-folder');
  mkdirSync(broken);
  const wrapped = (command: string) => spawnSync('bash', ['-c', wrapForRedact(command, `node "${CLI}" redact`)], { cwd: sandbox.repo, env: { ...sandbox.env, YOKOTEN_PRIVATE_MARKS: broken }, encoding: 'utf8' });
  const cases: [command: string, status: number][] = [
    // The command passed: hidden output never looks like a clean run.
    ['git log -1', 1],
    [`echo "Author: ${OWNER} <${EMAIL}>"`, 1],
    // A long output is read to its end: the command is not stopped by a closed pipe.
    [`for i in $(seq 1 20000); do echo "by ${OWNER}"; done`, 1],
    // The command failed: its own exit code comes through.
    [`echo "by ${OWNER}"; exit 5`, 5],
  ];
  for (const [command, status] of cases) {
    const result = wrapped(command);
    assert.equal(result.status, status, command);
    assert.equal(result.stdout, '', command);
    assert.ok(result.stderr.includes(REDACT_FAILED), `${command}: ${result.stderr}`);
    assertHidden(result.stdout + result.stderr, [OWNER, EMAIL]);
  }
});

test('redact: no marks file, or a readable one, still redacts and exits 0 (#1006)', async () => {
  const cases: [why: string, marks: boolean, extra: Record<string, string>][] = [
    ['no marks file', false, {}],
    ['YOKOTEN_PRIVATE_MARKS names a file that is not there', false, { YOKOTEN_PRIVATE_MARKS: 'no-such-marks-file' }],
    ['a readable marks file', true, {}],
  ];
  for (const [why, marks, extra] of cases) {
    const { sandbox } = ownerSandbox({ marks });
    const result = await sandbox.call(['redact'], { input: `Author: ${OWNER} <${EMAIL}>\n`, extra });
    assert.deepEqual([result.status, result.stdout, result.stderr], [0, 'Author: <owner> <<email>>\n', ''], why);
  }
  // Through the wrapper too.
  const { wrapped } = ownerSandbox();
  const log = wrapped('git log -1');
  assert.equal(log.status, 0, log.stderr);
  assert.match(log.stdout, /Author: <owner> <<email>>/);
  assert.equal(wrapped('true').status, 0);
});

test('redactStream: a redactor that throws stops the output, and the rest is read and dropped (#1006)', async () => {
  const cases: [why: string, failAt: number, written: string[]][] = [
    ['the first piece fails', 1, []],
    ['a later piece fails', 2, ['one\n']],
    ['no piece fails', 0, ['one\n', 'two\n', 'three']],
  ];
  for (const [why, failAt, written] of cases) {
    const input = new PassThrough();
    const out: string[] = [];
    let calls = 0;
    const redact = (text: string) => {
      calls++;
      if (calls === failAt) throw new Error(`cannot redact ${OWNER}`);
      return text;
    };
    const done = redactStream(input, redact, (text) => out.push(text));
    // One write per piece, each read on its own turn.
    for (const piece of ['one\n', 'two\n', `by ${OWNER}\n`.repeat(3), 'three']) {
      input.write(piece);
      await new Promise((resolve) => setImmediate(resolve));
    }
    input.end();
    const failure = await done;
    assert.equal(input.readableEnded, true, `${why}: the input is read to its end`);
    if (failAt === 0) {
      assert.equal(failure, null, why);
      assert.deepEqual(out, ['one\n', 'two\n', `by ${OWNER}\n`.repeat(3), 'three'], why);
    } else {
      assert.ok(failure instanceof Error, why);
      assert.deepEqual(out, written, why);
    }
  }
  // The stderr line names the failure by a code or a name, never by its message: a message can hold a path.
  const words: [err: unknown, word: string][] = [
    [Object.assign(new Error('open /x/y'), { code: 'EACCES' }), 'EACCES'],
    [new TypeError('x'), 'TypeError'],
    [Object.assign(new Error('x'), { code: '/x/y' }), 'error'],
    ['a path /x/y', 'error'],
    [undefined, 'error'],
  ];
  for (const [err, word] of words) assert.equal(failureWord(err), word);
});

test('redact: a piece that cannot be written or redacted ends in one line on stderr and exit 1 (#1006)', async () => {
  const { sandbox } = ownerSandbox();
  const stdout = new Writable();
  stdout.write = () => {
    throw new Error(`write failed for ${OWNER}`);
  };
  const stderr: string[] = [];
  const stderrStream = new Writable({
    write(chunk, _, done) {
      stderr.push(String(chunk));
      done();
    },
  });
  const stream = Readable.from([`by ${OWNER}\n`, 'more\n'], { objectMode: false });
  const code = await runRedact({ command: 'redact', args: [], env: sandbox.env, cwd: sandbox.repo, stdout, stderr: stderrStream, stdin: { fd: null, text: null, stream }, script: CLI });
  assert.equal(code, 1);
  assert.equal(stderr.length, 1);
  assert.match(stderr.join(''), REDACT_REFUSED);
  assertHidden(stderr.join(''), [OWNER]);
});

test('redact: a long line is cut only at a space or tab, never inside a value (#390)', async () => {
  assert.equal(cutPoint('a\nb', 10), 2);
  assert.equal(cutPoint('short', 10), 0);
  assert.equal(cutPoint('word word longvalue', 10), 10);
  assert.equal(cutPoint('x'.repeat(20), 10), 20, 'no space: the whole buffer goes, redacted as one');
  // Through the command: a value at the end of a long run with no line end is still hidden.
  const { sandbox } = ownerSandbox();
  // A one-word value: a value with a space in it may be cut at that space.
  const input = `${'y'.repeat((1 << 20) + 10)} ${LOGIN}`;
  const result = spawnSync('node', [CLI, 'redact'], { cwd: sandbox.repo, env: sandbox.env, input, encoding: 'utf8', maxBuffer: 8 << 20 });
  assert.ok(result.stdout === `${'y'.repeat((1 << 20) + 10)} <mark>`, `ends with: ${result.stdout.slice(-20)}`);
});

// #377: a repo without CI checks a pull request by its number, read through gh.
test('check --pr <number>: reads the pull request through gh and checks it with the commits here (#377)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('README.md', 'Short.\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'base');
  const base = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  sandbox.write('src/a.ts', 'export const a = 1;\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'head');
  const head = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  const body = 'tier: B\nCloses #1\n## Why\nx\n## What changed\nx\n## How tested\nx\nNo changelog: a test\nMade with worker (opus)\n';
  // A gh first on PATH that answers `pr view 12` only. `pr view 13` fails as gh does for
  // a number the repo does not have; every other call fails plainly.
  const bin = join(sandbox.home, 'bin');
  mkdirSync(bin);
  sandbox.git('remote', 'add', 'origin', 'https://github.com/octo/app.git');
  const answer = (title: string, headSha: string, author: object = { login: 'octo' }, prBody = body, headRefName = 'no-such-branch') =>
    writeFileSync(
      join(bin, 'gh'),
      `#!/usr/bin/env node
if (process.argv[4] === '13') { console.error('GraphQL: Could not resolve to a PullRequest with the number of 13. (repository.pullRequest)'); process.exit(1); }
if (process.argv.slice(2, 4).join(' ') !== 'pr view' || process.argv[4] !== '12') process.exit(1);
console.log(${JSON.stringify(JSON.stringify({ title, body: prBody, labels: [{ name: 'feat' }, { name: 'tier B' }], milestone: { title: 'M0' }, author, baseRefOid: base, headRefOid: headSha, headRefName }))});
`,
      { mode: 0o755 },
    );
  const extra = { PATH: `${bin}:${process.env.PATH}` };
  answer('feat: a', head);
  let result = await sandbox.call(['check', '--pr', '--all', '12'], { extra });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^yokoten check --pr · (PR #\d+, )?no problems$/m);
  // The control: a bad title fails, as in CI.
  answer('a', head);
  result = await sandbox.call(['check', '--pr', '--all', '12', '--json'], { extra });
  assert.equal(result.status, 1);
  assert.ok(JSON.parse(result.stdout).findings.some((f: { id: string }) => f.id === 'pr-title'), result.stdout);
  // gh names Dependabot `app/dependabot`; it counts as dependabot[bot], as in CI, so its body rules are notes.
  const dependabotBody = async (author: object) => {
    // Dependabot writes its own body: no tier line, no sections.
    answer('ci: bump the actions group', head, author, 'Bumps the actions group.');
    const report = JSON.parse((await sandbox.call(['check', '--pr', '--all', '12', '--json'], { extra })).stdout);
    return report.notes.some((f: { why: string }) => /Dependabot opened this pull request/.test(f.why));
  };
  assert.equal(await dependabotBody({ login: 'app/dependabot', is_bot: true }), true);
  assert.equal(await dependabotBody({ login: 'octo', is_bot: false }), false, 'the control: a person is held to every rule');
  // A head commit this clone has not fetched: the fix names what to fetch.
  answer('feat: a', 'f'.repeat(40));
  result = await sandbox.call(['check', '--pr', '--all', '12'], { extra });
  assert.equal(result.status, 1);
  assert.match(flat(result.stderr), /the pull request's head commit is not in this checkout .*Run `git fetch origin` and `git fetch origin pull\/12\/head`, then run it again/);
  // gh can't read it: one finding, never a crash.
  result = await sandbox.call(['check', '--pr', '--all', '13', '--json'], { extra });
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout).findings.map((f: { id: string; what: string }) => [f.id, f.what]), [['pr-read', 'no pull request 13 in octo/app']]);
  result = await sandbox.call(['check', '--pr', '--all', '14', '--json'], { extra });
  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stdout).findings[0].what, /^pull request 14 can't be read: /, 'any other gh failure keeps its own reason');
  // A number goes with --pr only, and must be a number.
  result = await sandbox.call(['check', '12'], { extra });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /a number goes with --pr/);
  result = await sandbox.call(['check', '--pr', '--all', '--x'], { extra });
  assert.equal(result.status, 1);
  result = await sandbox.call(['check', '--pr', '--all', 'main', '--json'], { extra });
  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stdout).findings[0].what, /"main" is not a pull request number/);

  // #748: the `Made with` model must be the one the worker's status file filed. A worker
  // checkout on the pull request's branch holds it; another model there is a note only.
  const worker = join(sandbox.home, 'wt-12');
  sandbox.git('worktree', 'add', '-q', '-b', 'pr-12', worker, head);
  writeFileSync(join(worker, '.yokoten-agent.json'), JSON.stringify({ name: 'w1', vendor: 'codex', model: 'deepseek-flash', role: 'engineer', state: 'done' }));
  const withWorker = (model: string) => body.replace('Made with worker (opus)', `Made with worker (${model})`);
  const notesOf = async (prBody: string) => {
    answer('feat: a', head, { login: 'octo' }, prBody, 'pr-12');
    return JSON.parse((await sandbox.call(['check', '--pr', '--all', '12', '--json'], { extra })).stdout).notes as { id: string; what: string }[];
  };
  const wrong = await notesOf(withWorker('gpt-6.1-sol'));
  assert.ok(wrong.some((f) => f.id === 'pr-made-with' && /status file of pr-12 says the worker ran deepseek-flash/.test(f.what)), JSON.stringify(wrong));
  const right = await notesOf(withWorker('deepseek-flash'));
  assert.ok(!right.some((f) => f.id === 'pr-made-with'), JSON.stringify(right));
});

// ---- yokoten marks: add, remove, off, on (#434) ----

// Samples are built from pieces, so this file passes its own privacy check.
const NAME = ['Ann', 'Sample'].join(' ');
const HAND_MARK = ['quiet', 'harbor'].join('');
const OTHER = ['far', 'meadow'].join('');
const VALUES = /ann|sample|quietharbor|farmeadow/i;

/** A sandbox with a git name, its marks file path, and a call that keeps every output to check for values. */
function marksSandbox() {
  const sandbox = makeSandbox();
  sandbox.git('config', 'user.name', NAME);
  const file = join(sandbox.home, '.config', 'yokoten', 'private-marks');
  const said: string[] = [];
  const call = async (args: string[], input?: string) => {
    const result = await sandbox.call(args, { input });
    said.push(result.stdout, result.stderr);
    return result;
  };
  const marks = () => readFileSync(file, 'utf8');
  return { sandbox, file, said, call, marks };
}

test('marks add, marks and marks remove: one value from stdin, never in stdout or stderr (#434)', async () => {
  const { said, call, marks } = marksSandbox();
  // Not a terminal: the mark is read from stdin, and the file is made.
  const added = await call(['marks', 'add'], `${HAND_MARK}\n`);
  assert.equal(added.status, 0, added.stderr);
  assert.equal(added.stdout, 'yokoten marks · added the mark to your private marks (not shown)\n');
  assert.ok(marks().endsWith(`\n${HAND_MARK}\n`));
  const again = await call(['marks', 'add'], HAND_MARK.toUpperCase());
  assert.match(again.stdout, /already in your private marks, so nothing changed/);
  // The counts by kind, never a value.
  const counts = await call(['marks']);
  assert.equal(counts.status, 0, counts.stderr);
  assert.match(counts.stdout, /^yokoten marks · 1 private mark, values never shown$/m);
  assert.match(counts.stdout, /^ {2}your own +1$/m);
  assert.doesNotMatch(counts.stdout, /^ {2}git-name/m, 'a kind with no mark is folded away');
  // A mark is never a word on the command line, and is not repeated when it is.
  const worded = await call(['marks', 'add', OTHER]);
  assert.equal(worded.status, 1);
  assert.match(worded.stderr, /never a word on the command line/);
  // Nothing, two lines, or a comment: refused, nothing changed.
  const before = marks();
  for (const input of ['', `${HAND_MARK}\n${OTHER}\n`, `# ${OTHER}`]) assert.equal((await call(['marks', 'add'], input)).status, 1);
  assert.equal(marks(), before);
  // Remove: the same way in, and gone from the file.
  const removed = await call(['marks', 'remove'], `${HAND_MARK}\n`);
  assert.equal(removed.stdout, 'yokoten marks · removed the mark from your private marks\n');
  assert.ok(!marks().includes(HAND_MARK));
  assert.match((await call(['marks', 'remove'], HAND_MARK)).stdout, /not in your private marks, so nothing changed/);
  assert.ok(!said.some((text) => VALUES.test(text)), 'no output holds a mark');
});

test('marks: the default screen fits 80 columns (#1027)', async () => {
  const { call } = marksSandbox();
  assert.equal((await call(['marks', 'add'], `${HAND_MARK}\n`)).status, 0);
  const result = await call(['marks']);
  assert.equal(result.status, 0, result.stderr);
  for (const line of result.stdout.split('\n')) assert.ok(line.length <= 80, line);
});

test('marks add: a mark after one yokoten added goes under a header of its own, so it counts as the owner\'s (#434)', async () => {
  const { file, call, marks } = marksSandbox();
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `# added by yokoten from this machine: git email\nann${'@'}sample-mail.dev\n`, { mode: 0o600 });
  assert.equal((await call(['marks', 'add'], OTHER)).status, 0);
  assert.equal(marks(), `# added by yokoten from this machine: git email\nann${'@'}sample-mail.dev\n# your own marks\n${OTHER}\n`);
  assert.match((await call(['marks'])).stdout, /^ {2}git-email +1, added by install\n(?:.*\n)* {2}your own +1$/m);
});

test('marks off git-name: removed, install no longer adds it, hand-added marks untouched; marks on git-name adds it back (#434)', async () => {
  const { sandbox, said, call, marks } = marksSandbox();
  assert.equal((await call(['install'])).status, 0);
  // A mark the owner added by hand, and the same name written by hand too.
  assert.equal((await call(['marks', 'add'], HAND_MARK)).status, 0);
  writeFileSync(join(sandbox.home, '.config', 'yokoten', 'private-marks'), `${marks()}# mine\n${OTHER}\n`);
  assert.match(marks(), new RegExp(`# added by yokoten from this machine: git name\\n${NAME}\\n`));
  const off = await call(['marks', 'off', 'git-name']);
  assert.equal(off.status, 0, off.stderr);
  assert.equal(
    off.stdout,
    'yokoten marks · install no longer adds your git name\n\n  done        removed 1 mark it had added; marks you added yourself are kept\n  undo        `yokoten marks on git-name`\n',
  );
  assert.ok(!marks().includes(NAME) && !marks().includes('from this machine: git name'), 'the git name and its header are gone');
  assert.ok(marks().includes(`\n${HAND_MARK}\n`) && marks().includes(`\n${OTHER}\n`), 'hand-added marks are kept');
  assert.deepEqual(JSON.parse(readFileSync(join(sandbox.home, '.config', 'yokoten', 'machine.json'), 'utf8')).marksOff, ['git name']);
  // install respects it, and `yokoten marks` says the kind is off.
  const install = await call(['install']);
  assert.doesNotMatch(install.stdout, /added your git name/);
  assert.ok(!marks().includes(NAME));
  assert.match((await call(['marks'])).stdout, /^ {2}git-name +0, off: install does not add it$/m);
  // Back to the default: the name is added again, with no value shown.
  const on = await call(['marks', 'on', 'git-name']);
  assert.equal(on.stdout, 'yokoten marks · install adds your git name again, and added it now (not shown)\n');
  assert.match(marks(), new RegExp(`# added by yokoten from this machine: git name\\n${NAME}\\n$`));
  assert.deepEqual(JSON.parse(readFileSync(join(sandbox.home, '.config', 'yokoten', 'machine.json'), 'utf8')).marksOff, []);
  assert.ok(marks().includes(`\n${HAND_MARK}\n`) && marks().includes(`\n${OTHER}\n`), 'still kept');
  assert.ok(!said.some((text) => VALUES.test(text)), 'no output holds a mark');
});

test('marks: an unknown kind or action is refused without repeating the word; allow keeps its own options (#434)', async () => {
  const { said, call } = marksSandbox();
  const kind = await call(['marks', 'off', HAND_MARK]);
  assert.equal(kind.status, 1);
  assert.match(kind.stderr, /name the kind: git-name, git-email, forge-login/);
  const action = await call(['marks', HAND_MARK]);
  assert.equal(action.status, 1);
  assert.match(action.stderr, /the action is add, remove, fill, off, on or allow/);
  assert.match((await call(['marks', 'add', '--here'], HAND_MARK)).stderr, /--here and --remove go with allow only/);
  assert.ok(!said.some((text) => VALUES.test(text)), 'no output holds a mark');
});

// #523: a stopped line names the kind of mark from the marks file's headers, in text and
// --json, and the value is never printed.
test('check: a stopped line names the kind of private mark, never the mark (#523)', async () => {
  const sandbox = makeSandbox();
  const name = ['Rue', 'Sample'].join(' ');
  const email = `ruex${at}personal-mail.dev`;
  const marks = join(sandbox.home, '.config', 'yokoten', 'private-marks');
  mkdirSync(join(sandbox.home, '.config', 'yokoten'), { recursive: true });
  const header = (kind: string) => `# added by yokoten from this machine: ${kind}`;
  writeFileSync(marks, [header('git name'), name, header('git email'), email, header('forge login'), 'octo-ruex', header('private remote host'), 'build.rue-host.dev', '# my own', 'quietvale', ''].join('\n'));
  sandbox.write('notes.md', [`by ${name}`, `mail ${email}`, 'ask @octo-ruex', 'see build.rue-host.dev', 'from QuietVale', ''].join('\n'));
  sandbox.git('add', '.');
  const text = await sandbox.call(['check']);
  assert.equal(text.status, 1);
  assert.match(text.stderr, /notes\.md:1\s+matches your git name \(a private mark yokoten added\s+by\s+itself\)/);
  assert.match(text.stderr, /notes\.md:2:?\s+matches your git email \(a private mark yokoten added\s+by\s+itself\)/);
  assert.match(text.stderr, /notes\.md:3:?\s+matches your forge login \(a private mark yokoten added\s+by\s+itself\)/);
  assert.match(text.stderr, /notes\.md:4:?\s+matches the name of a private server in your git\s+remotes/);
  assert.match(text.stderr, /notes\.md:5:?\s+matches a word you added to your private marks/);
  assert.match(text.stderr, /`yokoten marks off git-name`/);
  const json = await sandbox.call(['check', '--json']);
  const stopped = (JSON.parse(json.stdout).findings as { id: string; line: number; what: string }[]).filter((found) => found.id === 'private-mark').map((found) => [found.line, found.what]);
  assert.equal(stopped.length, 5, json.stdout);
  assert.match(stopped[0][1] as string, /your git name/);
  const said = (text.stdout + text.stderr + json.stdout + json.stderr).toLowerCase();
  for (const part of ['sample', 'personal-mail', 'octo-ruex', 'rue-host', 'quietvale']) assert.ok(!said.includes(part), `check printed ${part.length} letters of a mark`);
});

test('marks: the count names both files when the setting adds one (#656)', async () => {
  const { sandbox, file } = marksSandbox();
  mkdirSync(join(sandbox.home, '.config', 'yokoten'), { recursive: true });
  writeFileSync(file, `${HAND_MARK}\n`);
  const extra = join(sandbox.home, 'extra-marks');
  writeFileSync(extra, `${OTHER}\n`);
  const counts = await sandbox.call(['marks'], { extra: { YOKOTEN_PRIVATE_MARKS: extra } });
  assert.equal(counts.status, 0, counts.stderr);
  assert.match(counts.stdout, /^yokoten marks · 2 private marks, values never shown$/m);
  assert.match(counts.stdout, /~\/\.config\/yokoten\/private-marks/);
  assert.match(counts.stdout, /and the file YOKOTEN_PRIVATE_MARKS names/);
  assert.ok(!VALUES.test(counts.stdout + counts.stderr));
});

// ---- Actions health (#647) ----

/**
 * A gh first on PATH that answers only the listed calls, one line each, and fails the rest.
 * The stub is fixed text: its answers and its log path arrive in the environment, as data (#368).
 */
function healthGh(sandbox: ReturnType<typeof makeSandbox>, answers: Record<string, string>): Record<string, string> {
  const answersFile = join(sandbox.home, 'gh-answers.json');
  const log = join(sandbox.home, 'gh.log');
  writeFileSync(answersFile, JSON.stringify(answers));
  // getBuiltinModule works whether Node loads the program as CommonJS or as an ES module.
  const program = writeNodeProgram(
    join(sandbox.home, 'bin'),
    'gh',
    `const { appendFileSync, readFileSync } = process.getBuiltinModule('node:fs');
const call = args.join(' ');
appendFileSync(process.env.YOKOTEN_HEALTH_GH_LOG, call + '\\n');
const answers = JSON.parse(readFileSync(process.env.YOKOTEN_HEALTH_GH_ANSWERS, 'utf8'));
const key = Object.keys(answers).find((one) => call === one || call.startsWith(one + ' '));
if (key === undefined) process.exit(1);
process.stdout.write(answers[key] + '\\n');`,
  );
  return { ...program, YOKOTEN_HEALTH_GH_ANSWERS: answersFile, YOKOTEN_HEALTH_GH_LOG: log };
}

// The fake gh above runs on each system (issue #1068). Both forms run here, whatever the
// system: the Windows form is node under the name gh.exe, with its preload.
test('writeNodeProgram: the fake program answers with its arguments, as a script and as gh.exe with a preload', () => {
  const body = `process.stdout.write(JSON.stringify(args));`;
  const base = makeSandbox().home;
  const posixDir = join(base, 'posix');
  assert.equal(writeNodeProgram(posixDir, 'gh', body, 'linux', { PATH: '/usr/bin' }).PATH, `${posixDir}:/usr/bin`);
  // The form for this system runs, found on PATH as gh, whichever system it is.
  const hereDir = join(base, 'here');
  const here = writeNodeProgram(hereDir, 'gh', body, process.platform, { PATH: process.env.PATH ?? '' });
  const found = spawnSync('gh', ['api', 'repos/octo/demo'], { env: { ...process.env, ...here }, encoding: 'utf8' });
  assert.equal(found.stdout, '["api","repos/octo/demo"]', found.stderr);
  const windowsDir = join(base, 'windows');
  const extra = writeNodeProgram(windowsDir, 'gh', body, 'win32', { PATH: 'C:\\Windows', NODE_OPTIONS: '--no-warnings' });
  assert.equal(extra.PATH, `${windowsDir};C:\\Windows`, 'Windows joins PATH with ;');
  assert.match(extra.NODE_OPTIONS, /^--no-warnings --require "/, 'the preload is added to NODE_OPTIONS, not in place of it');
  assert.ok(existsSync(join(windowsDir, 'gh.exe')) && existsSync(join(windowsDir, 'gh.cjs')));
  const env = { PATH: process.env.PATH, NODE_OPTIONS: extra.NODE_OPTIONS };
  const ran = spawnSync(join(windowsDir, 'gh.exe'), ['issue', 'pin 12', '--repo', 'octo/demo'], { cwd: windowsDir, env, encoding: 'utf8' });
  // A linked copy of node runs on Windows and Linux. On macOS a Homebrew node finds its libnode.dylib by
  // a path relative to its own location, so the copy cannot start: the Windows form is checked for its files only.
  if (process.platform !== 'darwin' || ran.status === 0) {
    assert.equal(ran.stdout, '["issue","pin 12","--repo","octo/demo"]', ran.stderr);
    assert.equal(ran.status, 0);
  } else assert.match(ran.stderr, /Library not loaded|dyld/, 'on macOS the linked node could not start, for the known reason');
  // Positive control: in a process not named gh.exe (this one), the preload does nothing.
  createRequire(import.meta.url)(join(windowsDir, 'gh.cjs'));
  assert.equal(process.exitCode, undefined, 'the preload left this process alone');
});

const healthCalls = (sandbox: ReturnType<typeof makeSandbox>): string[] => {
  const log = join(sandbox.home, 'gh.log');
  return existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
};

const healthRun = (over: Record<string, unknown>) => ({
  id: 1,
  name: 'yokoten',
  event: 'push',
  head_branch: 'main',
  status: 'completed',
  conclusion: 'success',
  created_at: '2026-10-22T10:00:00Z',
  run_started_at: '2026-10-22T10:01:00Z',
  updated_at: '2026-10-22T10:04:00Z',
  html_url: 'https://example.com/run/1',
  ...over,
});

// #647: a failed run on main, a cancelled one, a failed check on a draft pull request,
// a slow workflow, a long queue wait, and one branch that both passed and failed.
test('ci-health: reads runs and pull request checks, then says what is red', () => {
  const gh = (args: string[]) => {
    if (args[0] === 'repo') return 'main\n';
    if (args[0] === 'api') {
      return JSON.stringify({
        workflow_runs: [
          healthRun({ id: 1, conclusion: 'failure', updated_at: '2026-10-22T10:10:00Z' }),
          healthRun({ id: 2, name: 'board', event: 'issues', conclusion: 'cancelled', created_at: '2026-10-22T10:05:00Z', run_started_at: '2026-10-22T10:06:00Z', updated_at: '2026-10-22T10:07:00Z' }),
          healthRun({ id: 3, event: 'pull_request', head_branch: 'fix/x', created_at: '2026-10-22T10:11:00Z', run_started_at: '2026-10-22T10:11:30Z', updated_at: '2026-10-22T10:13:00Z' }),
          healthRun({ id: 4, event: 'pull_request', head_branch: 'fix/x', conclusion: 'failure', created_at: '2026-10-22T10:14:00Z', run_started_at: '2026-10-22T10:14:10Z', updated_at: '2026-10-22T10:15:00Z' }),
          healthRun({ id: 5, name: 'pr', event: 'pull_request', head_branch: 'fix/x', conclusion: 'failure', created_at: '2026-10-22T10:16:00Z', run_started_at: '2026-10-22T10:16:30Z', updated_at: '2026-10-22T10:17:00Z' }),
        ],
      });
    }
    return JSON.stringify([
      {
        number: 646,
        title: 'drafts first',
        url: 'https://example.com/pull/646',
        isDraft: true,
        statusCheckRollup: [
          { name: 'yokoten', status: 'COMPLETED', conclusion: 'CANCELLED' },
          { name: 'old run', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: '2026-10-22T09:00:00Z' },
          { name: 'old run', status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: '2026-10-22T10:00:00Z' },
        ],
      },
    ]);
  };
  const runs = readActionsRuns(gh, 'octo/demo');
  assert.ok(Array.isArray(runs), JSON.stringify(runs));
  assert.deepEqual(runs.map((run) => run.id), [5, 4, 3, 2, 1], 'newest first');
  const pulls = readHealthPullChecks(gh, 'octo/demo');
  assert.ok(Array.isArray(pulls), JSON.stringify(pulls));
  assert.deepEqual(pulls, [{ number: 646, title: 'drafts first', url: 'https://example.com/pull/646', isDraft: true, check: 'yokoten', conclusion: 'cancelled' }], 'a later green run clears the old failure');

  const health = summarizeActionsHealth(runs, pulls);
  assert.equal(health.defaultBranch, 'main');
  assert.equal(health.mainFailures.length, 1, 'the failed push to main');
  assert.equal(health.mainCancelled.length, 1, 'the cancelled issue run stays apart from a failure');
  assert.equal(health.slowest[0].id, 1, '10 minutes is the slowest run');
  assert.deepEqual(health.unstable, [{ workflow: 'yokoten', branch: 'fix/x', passes: 1, failures: 1 }]);
  const board = health.workflows.find((workflow) => workflow.workflow === 'board');
  assert.deepEqual(board, { workflow: 'board', runs: 1, failed: 0, cancelled: 1, medianRunTime: 60000, medianWaitTime: 60000 });

  const body = renderActionsHealth(health, { repo: 'octo/demo', now: new Date('2026-10-22T12:00:00Z') });
  assert.match(body, /^<!-- yokoten:ci-health -->/);
  assert.match(body, /3 problems need a look/);
  assert.match(body, /\[#646 drafts first\]\(https:\/\/example\.com\/pull\/646\) \(draft\) \| yokoten \| cancelled/);
  assert.match(body, /`board` \(issues\) on `main`: \*\*cancelled\*\*/);
  assert.match(body, /Median wait/);
  assert.match(body, /`yokoten` on `fix\/x`: 1 passed, 1 failed/);
});

test('ci-health --dry-run: shows the report as a screen and touches no issue (#1115)', async () => {
  const sandbox = makeSandbox();
  const extra = healthGh(sandbox, {
    'repo view octo/demo --json defaultBranchRef --jq .defaultBranchRef.name': 'main',
    'api repos/octo/demo/actions/runs?per_page=100&page=1': JSON.stringify({ workflow_runs: [healthRun({ id: 1, conclusion: 'failure' })] }),
    'pr list --repo octo/demo --state open --limit 100 --json number,title,url,isDraft,statusCheckRollup': JSON.stringify([]),
  });
  const result = await sandbox.call(['ci-health', '--dry-run'], { extra: { ...extra, GITHUB_REPOSITORY: 'octo/demo' } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^yokoten ci-health · octo\/demo, the last 1 run: 1 problem\n/);
  assert.match(result.stdout, /^On main:\n {2}MISSING {5}yokoten: failure at /m);
  assert.doesNotMatch(result.stdout, /^Next: /m, 'a dry run names no next step');
  assert.deepEqual(healthCalls(sandbox), [
    'repo view octo/demo --json defaultBranchRef --jq .defaultBranchRef.name',
    'api repos/octo/demo/actions/runs?per_page=100&page=1',
    'pr list --repo octo/demo --state open --limit 100 --json number,title,url,isDraft,statusCheckRollup',
  ], 'a dry run reads, and writes no issue');
});

// #1046: a bare command reads and shows. Only --write touches the issue.
test('ci-health with no flag prints the report, writes no issue and names --write', async () => {
  const sandbox = makeSandbox();
  const extra = healthGh(sandbox, {
    'api repos/octo/demo/actions/runs?per_page=100&page=1': JSON.stringify({ workflow_runs: [healthRun({ id: 1, conclusion: 'failure' })] }),
    'pr list --repo octo/demo --state open --limit 100 --json number,title,url,isDraft,statusCheckRollup': JSON.stringify([]),
    // An answer for every write, so only the code, not a failing stub, keeps them from running.
    'issue list --repo octo/demo --state open --limit 100 --search "CI health" in:title --json number,title': JSON.stringify([{ number: 12, title: 'CI health' }]),
    'issue edit 12 --repo octo/demo --body-file': '',
    'issue create --repo octo/demo --title CI health --body-file': 'https://github.com/octo/demo/issues/12',
    'issue pin 12 --repo octo/demo': '',
  });
  const result = await sandbox.call(['ci-health', '--repo', 'octo/demo'], { extra });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^ {2}MISSING {5}yokoten: failure at /m);
  assert.match(result.stdout, /\nNext: `yokoten ci-health --write` puts it in the pinned issue "CI health"\n$/);
  assert.ok(!healthCalls(sandbox).some((call) => call.startsWith('issue')), `no issue call without --write: ${healthCalls(sandbox).join(', ')}`);
});

test('ci-health: a repo that is not owner/name says which value was wrong (#1115)', async () => {
  const sandbox = makeSandbox();
  const flag = await sandbox.call(['ci-health', '--repo', 'nonsense']);
  assert.equal(flag.status, 1);
  assert.match(flag.stderr, /no GitHub repo to read: --repo nonsense is not owner\/name/);
  const env = await sandbox.call(['ci-health'], { extra: { GITHUB_REPOSITORY: 'also-bad' } });
  assert.equal(env.status, 1);
  assert.match(env.stderr, /no GitHub repo to read: GITHUB_REPOSITORY is also-bad, not\s+owner\/name/);
  // A value with control characters is quoted and escaped, never sent raw (it is anyone's text).
  const odd = 'bad\u001b[2J\nnext\u202e';
  const shown = (text: string) => assert.ok(!/[\u001b\u202e]/.test(text) && text.includes('\\u001b[2J\\nnext\\u202e'), JSON.stringify(text));
  const oddFlag = await sandbox.call(['ci-health', '--repo', odd]);
  shown(oddFlag.stderr);
  const oddEnv = await sandbox.call(['ci-health'], { extra: { GITHUB_REPOSITORY: odd } });
  shown(oddEnv.stderr);
});

test('ci-health refuses --write with --dry-run before it reads anything', async () => {
  const sandbox = makeSandbox();
  const extra = healthGh(sandbox, {});
  const result = await sandbox.call(['ci-health', '--repo', 'octo/demo', '--write', '--dry-run'], { extra });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /pass\s+one of them/);
  assert.deepEqual(healthCalls(sandbox), []);
});

// #1046: every workflow that runs ci-health asks for the write by name.
test('ci-health: each workflow that runs it passes --write', () => {
  const files = [join(ROOT, 'kit/project/.github/workflows/actions-health.yml'), join(ROOT, '.github/workflows/actions-health.yml')];
  for (const file of files) {
    const runs = readFileSync(file, 'utf8').split('\n').filter((line) => /\bci-health\b/.test(line) && /\brun:/.test(line));
    assert.ok(runs.length > 0, `${file} runs ci-health`);
    for (const line of runs) assert.match(line, /ci-health --write\b/, `${file}: ${line.trim()}`);
  }
});

test('ci-health: opens and pins the one report issue, then edits it in place', async () => {
  const sandbox = makeSandbox();
  const runs = JSON.stringify({ workflow_runs: [healthRun({ id: 1 })] });
  const pulls = JSON.stringify([]);
  const extra = healthGh(sandbox, {
    'api repos/octo/demo/actions/runs?per_page=100&page=1': runs,
    'pr list --repo octo/demo --state open --limit 100 --json number,title,url,isDraft,statusCheckRollup': pulls,
    'issue list --repo octo/demo --state open --limit 100 --search "CI health" in:title --json number,title': JSON.stringify([]),
    'issue create --repo octo/demo --title CI health --body-file': 'https://github.com/octo/demo/issues/12',
    'issue pin 12 --repo octo/demo': '',
  });
  let result = await sandbox.call(['ci-health', '--repo', 'octo/demo', '--write'], { extra });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /opened issue #12 in octo\/demo/);
  assert.match(result.stdout, /0 problems/);
  // #1027: one screen: the title says where the report is, then one row says what it found.
  assert.match(result.stdout, /^yokoten ci-health · opened issue #12 in octo\/demo\n\n {2}ok {10}1 run: 0 problems\n$/);
  for (const line of result.stdout.split('\n')) assert.ok(line.length <= 80, `over 80: ${line}`);
  assert.ok(healthCalls(sandbox).some((call) => call.startsWith('issue create')), 'an issue was made');
  assert.ok(healthCalls(sandbox).some((call) => call.startsWith('issue pin 12')), 'and pinned');

  rmSync(join(sandbox.home, 'gh.log'), { force: true });
  const edit = healthGh(sandbox, {
    'api repos/octo/demo/actions/runs?per_page=100&page=1': runs,
    'pr list --repo octo/demo --state open --limit 100 --json number,title,url,isDraft,statusCheckRollup': pulls,
    'issue list --repo octo/demo --state open --limit 100 --search "CI health" in:title --json number,title': JSON.stringify([{ number: 12, title: 'CI health' }]),
    'issue edit 12 --repo octo/demo --body-file': '',
    'issue pin 12 --repo octo/demo': '',
  });
  result = await sandbox.call(['ci-health', '--repo', 'octo/demo', '--write'], { extra: edit });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /updated issue #12 in octo\/demo/);
  assert.ok(!healthCalls(sandbox).some((call) => call.startsWith('issue create')), 'the second run edits, never makes a second issue');
});

// #647: a title from GitHub can hold a pipe and lines; the table stays one row per check.
test('ci-health: a title with a pipe and lines becomes one table cell', () => {
  const run = {
    id: 1,
    workflow: 'ci',
    event: 'push',
    branch: 'main',
    status: 'completed',
    conclusion: 'success',
    createdAt: '2026-10-22T10:00:00Z',
    startedAt: '2026-10-22T10:00:00Z',
    updatedAt: '2026-10-22T10:01:00Z',
    url: '',
  };
  const health = summarizeActionsHealth([run], [{ number: 7, title: 'a | b\nnext', url: '', isDraft: false, check: 'ci', conclusion: 'failure' }]);
  const body = renderActionsHealth(health, { repo: 'octo/demo', now: new Date('2026-10-22T12:00:00Z') });
  assert.match(body, /^\| \[#7 a \\\| b next\]\(#\) \| ci \| failure \|$/m);
});

// #647: a backslash is escaped before the pipe it could pair with, so the cell keeps it.
test('ci-health: a backslash before a pipe stays inside the table cell', () => {
  const run = {
    id: 1,
    workflow: 'ci',
    event: 'push',
    branch: 'main',
    status: 'completed',
    conclusion: 'success',
    createdAt: '2026-10-22T10:00:00Z',
    startedAt: '2026-10-22T10:00:00Z',
    updatedAt: '2026-10-22T10:01:00Z',
    url: '',
  };
  const health = summarizeActionsHealth([run], [{ number: 8, title: String.raw`a \| b`, url: '', isDraft: false, check: 'ci', conclusion: 'failure' }]);
  const body = renderActionsHealth(health, { repo: 'octo/demo', now: new Date('2026-10-22T12:00:00Z') });
  assert.equal(body.split('\n').find((line) => line.startsWith('| [#8 ')), String.raw`| [#8 a \\\| b](#) | ci | failure |`);
});

/** The exported shape, so a field rename is a type error in the tests too. */
export type HealthShape = ActionsHealth;

// #756: `yokoten provenance <ref>` reads a squashed commit's message and the host's
// Approve, in plain text and with --json.
test('provenance: a commit names its writer, reviewers, approver, tier and issue (#756)', async () => {
  const sandbox = makeSandbox();
  const bin = join(sandbox.home, 'bin');
  mkdirSync(bin);
  const gh = (body: string, code = 0) => {
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\n${body}\nexit ${code}\n`);
    chmodSync(join(bin, 'gh'), 0o755);
  };
  const path = { PATH: `${bin}:${process.env.PATH}` };
  sandbox.write('README.md', 'Short.\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'base');
  const message = join(sandbox.home, 'message');
  writeFileSync(message, ['feat(guard): a pipe is refused (#12)', '', 'tier: B', '', 'Closes #12', 'Refs #13', '', '## Why', 'x', '', '🤖 Made with worker Grok (grok-4.7), reviewed by Claude Code (claude-opus-5-5), lead Claude Code (claude-opus-5-5)', '', 'Co-authored-by: someone <someone@example.com>', ''].join('\n'));
  sandbox.write('src/a.ts', 'export const a = 1;\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-q', '-F', message);
  gh('printf "owner-login\\t2026-10-20T00:00:00Z\\n"');
  let result = await sandbox.call(['provenance', 'HEAD'], { extra: path });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^yokoten provenance · [0-9a-f]{7} feat\(guard\): a pipe is refused \(#12\)\n\n  writer      Grok \(grok-4\.7\)\n  reviewers   Claude Code \(claude-opus-5-5\)\n  approver    owner-login\n  tier        B\n  issue       #12, #13$/m);
  const json = JSON.parse((await sandbox.call(['provenance', 'HEAD', '--json'], { extra: path })).stdout);
  assert.equal(json.length, 1);
  assert.equal(json[0].approver, 'owner-login');
  assert.deepEqual(json[0].writers, [{ vendor: 'Grok', model: 'grok-4.7' }]);
  assert.deepEqual(json[0].reviewers, [{ vendor: 'Claude Code', model: 'claude-opus-5-5' }]);
  assert.equal(json[0].tier, 'B');
  assert.deepEqual(json[0].issues, [12, 13]);
  // gh that cannot answer leaves the approver unknown, not an error.
  gh('exit 1');
  result = await sandbox.call(['provenance', 'HEAD'], { extra: path });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /  approver    unknown$/m);
  assert.equal(JSON.parse((await sandbox.call(['provenance', 'HEAD', '--json'], { extra: path })).stdout)[0].approver, null);
});

test('provenance: a range shows each commit, and a bad ref is one finding (#756)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('README.md', 'Short.\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'base');
  const commit = (title: string, line: string) => {
    const file = join(sandbox.home, 'message');
    writeFileSync(file, `${title}\n\ntier: C\n\nCloses #7\n\n## Why\nx\n\n## What changed\nx\n\n## How tested\nx\n\n${line}\n`);
    sandbox.write(`docs/${title.split(':')[0]}.md`, `${title}\n`);
    sandbox.git('add', '.');
    sandbox.git('commit', '-q', '-F', file);
  };
  commit('docs: first (#7)', 'Made with lead Claude Code (claude-opus-5-5)');
  commit('docs: second (#8)', 'Made with worker Grok (grok-4.7)');
  const result = await sandbox.call(['provenance', 'HEAD~2..HEAD']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal((result.stdout.match(/^  writer      /gm) ?? []).length, 2, result.stdout);
  assert.match(result.stdout, /docs: first \(#7\)/);
  assert.match(result.stdout, /docs: second \(#8\)/);
  const bad = await sandbox.call(['provenance', 'not-a-ref']);
  assert.equal(bad.status, 1);
  assert.match(flat(bad.stderr), /^yokoten provenance · git can't answer, so the check stopped without looking: `git log .+` gave no answer: .*Next: `git log --oneline -3`/);
  const usage = await sandbox.call(['provenance']);
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /give a commit or a range/);
});

// ---- Borrowed code (record 0024): the issue, and the command ----

test('borrowed: the issue names the source and the security fix, and a second run sees it open', () => {
  const source = 'https://github.com/example/upstream/blob/main/src/thing.ts';
  const sha = '0123456789abcdef0123456789abcdef01234567';
  const older = 'fedcba9876543210fedcba9876543210fedcba98';
  const path = 'src/borrowed/thing.ts';
  const host: BorrowedHost = {
    commits: () => [
      { sha: older, message: 'fix: CVE-2026-1 remote code execution' },
      { sha, message: 'taken' },
    ],
  };
  const change = watchBorrowed([{ path, source, commit: sha, license: 'MIT' }], host).changed[0];
  const issue = borrowedIssue(change);
  assert.match(issue.title, /^check: /);
  assert.ok(issue.title.length <= 60, issue.title);
  assert.ok(issue.body.includes(source));
  assert.ok(issue.body.includes(path));
  assert.ok(issue.body.includes('security'));
  assert.deepEqual(issue.labels, ['bug', 'hotfix', 'tier B']);
  assert.deepEqual(borrowedIssue({ ...change, isSecurity: false }).labels, ['bug', 'tier B']);
  assert.equal(borrowedIssue({ ...change, isSecurity: false }).title, 'check: review borrowed code upstream');
  const calls: string[][] = [];
  const gh = (args: string[]) => {
    calls.push(args);
    return JSON.stringify([{ number: 7, body: `Upstream changed \`${source}\`` }]);
  };
  assert.equal(hasOpenIssue(gh, source), true);
  assert.equal(hasOpenIssue(gh, 'https://github.com/example/elsewhere/blob/main/x.ts'), false);
  assert.match(calls[0].join(' '), /issue list --state open/);
  // An answer that is not a list is a gap: stop, never open a duplicate (#676).
  for (const answer of ['not json', '{}', 'null']) {
    assert.throws(() => hasOpenIssue(() => answer, source), /did not give an issue list/, answer);
  }
});

test('borrowed --dry-run: a repo with no wheel writes nothing and says so', async () => {
  const sandbox = makeSandbox();
  const result = await sandbox.call(['borrowed', '--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /yokoten borrowed · 0 sources, none moved/);
});
// #432: `pr sync` lists the open pull requests first. With none, it needs no bot and no
// network, and says so in one line. The merge itself is tested in test/run/check.test.ts.
test('pr sync: no open pull requests is one line, and no bot is needed (#432)', async () => {
  const sandbox = makeSandbox();
  sandbox.git('remote', 'add', 'origin', 'https://github.com/me/repo.git');
  const bin = join(sandbox.home, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), '#!/usr/bin/env node\nprocess.stdout.write("[]")\n');
  chmodSync(join(bin, 'gh'), 0o755);
  const result = await sandbox.call(['pr', 'sync'], { extra: { PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'yokoten pr sync · no open pull requests\n');
});

test('pr sync: a missing action is a usage error, not a silent no-op (#432)', async () => {
  const sandbox = makeSandbox();
  const result = await sandbox.call(['pr']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /give the action: `yokoten pr sync`/);
});

test('pr sync: every git call runs as UTC, so the merge commit does too (#809)', () => {
  assert.equal(prSyncEnv({ ...process.env, TZ: 'America/New_York' }).TZ, 'UTC');
});

test('pr sync: each report row names the real base branch (#809, #1027)', () => {
  assert.deepEqual(pullLine({ number: 1, branch: 'work', base: 'release', state: 'merged' }), ['  ok          PR #1       release merged in, tests pass, pushed']);
  assert.deepEqual(pullLine({ number: 2, branch: 'fix', base: 'main', state: 'resolved', hunks: 2 }), ['  ok          PR #2       main merged in (2 hunks resolved), tests pass, pushed']);
  assert.deepEqual(pullLine({ number: 3, branch: 'docs', base: 'next', state: 'up-to-date' }), ['  ok          PR #3       up to date with next']);
});

test('pr sync: a list that stops at the limit says so (#809)', () => {
  const lines = prSyncScreen({ isCut: true, pulls: [{ number: 1, branch: 'work', base: 'main', state: 'up-to-date' }] });
  assert.ok(lines.includes('  note        open list   stops at 100 pull requests; the rest are not synced'), lines.join('\n'));
  assert.deepEqual(broken(lines), []);
});

// #1027: the default screens. A clean check is one line; a problem names its place first,
// its fix under it, and one command to type last. No line passes 80 columns.
test('check: one screen for a clean check and one for a problem (#1027)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('fine.md', 'hello\n');
  sandbox.git('add', 'fine.md');
  const clean = await sandbox.call(['check', '--staged']);
  assert.equal(clean.stdout, 'yokoten check --staged · clean: layout, privacy, lead-only files\n');
  sandbox.write('a.md', `me${at}gmail.com\n`);
  sandbox.git('add', '.');
  const found = await sandbox.call(['check']);
  assert.equal(found.status, 1, found.stdout + found.stderr);
  const lines = found.stderr.split('\n');
  assert.equal(lines[0], 'yokoten check · 1 problem');
  assert.equal(lines[1], '');
  assert.match(lines[2] ?? '', /^ {2}MISSING {5}a\.md:1 {6}an email address$/);
  assert.match(lines[3] ?? '', /^ {26}An email address points at a person, and git keeps it$/);
  assert.equal(lines[lines.length - 3], 'Next: fix it, then `yokoten check`');
  assert.match(lines[lines.length - 2] ?? '', /^More: \S+#privacy$/);
  for (const line of [...clean.stdout.split('\n'), ...lines]) assert.ok(line.length <= 80, `over 80: ${line}`);
});

// ---- The screens, from result objects (issue #1115) ----

test('check: the screen places its notes itself, folded by default and in full with --all (#1115)', () => {
  const problems = [
    finding('email', 'an email address', 'remove it', { file: 'docs/a-long-folder/notes.md', line: 3, why: 'an email address points at a person, and git keeps it' }),
    finding('change-file', 'changelog: 1 changed file has no entry', 'run `yokoten changelog --new`', { why: 'a reader learns what changed from the changelog' }),
  ];
  const note = finding('long-sentence', 'a sentence of 30 words', 'split it', { file: 'README.md', line: 2, why: 'agents misread long sentences' });
  const folded = checkScreen({ mode: 'pr', problems, notes: [note], hints: [] });
  assert.equal(folded[0], 'yokoten check --pr · 2 problems');
  assert.ok(folded.includes('  note        1 note: `yokoten check --all` shows each'), folded.join('\n'));
  assert.equal(folded.at(-1), 'Next: fix them, then `yokoten check`');
  assert.deepEqual(broken(folded, true), []);
  const all = checkScreen({ mode: 'pr', problems, notes: [note], hints: [] }, { isAll: true });
  assert.ok(all.includes('  note        README.md:2: a sentence of 30 words'), all.join('\n'));
  assert.deepEqual(broken(all, true), []);
  const clean = checkScreen({ mode: 'staged', problems: [], notes: [], hints: [] });
  assert.deepEqual(clean, ['yokoten check --staged · clean: layout, privacy, lead-only files']);
  assert.deepEqual(checkScreen({ mode: 'issue', problems: [], notes: [], hints: [], skipped: 'no issue in this run (it reads the CI event); nothing to check' }), ['yokoten check --issue · no issue in this run (it reads the CI event); nothing to', '                        check']);
});

test('check with no flag reads only: the tree and the index are as they were (#1044, D8)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('a.md', 'hello\n');
  sandbox.git('add', '.');
  const before = sandbox.git('status', '--porcelain').stdout;
  assert.equal((await sandbox.call(['check'])).status, 0);
  assert.equal(sandbox.git('status', '--porcelain').stdout, before);
});

test('ci-health: the screen is rows and tables with one text column, built from the summary (#1115)', () => {
  const run = { id: 1, workflow: 'CI', event: 'push', branch: 'main', status: 'completed', conclusion: 'failure', createdAt: '2026-10-22T10:00:00Z', startedAt: '2026-10-22T10:01:00Z', updatedAt: '2026-10-22T10:04:00Z', url: 'https://example.com/run/1' };
  const health = summarizeActionsHealth([run, { ...run, id: 2, conclusion: 'success', branch: 'work' }], [{ number: 7, title: 'feat: a\u001b[2J thing', url: 'https://example.com/pull/7', isDraft: false, check: 'test', conclusion: 'failure' }]);
  const lines = ciHealthScreen({ repo: 'octo/demo', health });
  assert.equal(lines[0], 'yokoten ci-health · octo/demo, the last 2 runs: 2 problems');
  assert.ok(lines.includes('  MISSING     PR #7 test: failure'), lines.join('\n'));
  assert.ok(!lines.join('\n').includes('\u001b'), 'a control character from GitHub never reaches the screen');
  assert.deepEqual(broken(lines), []);
  const posted = ciHealthScreen({ repo: 'octo/demo', health, posted: { number: 12, created: false, pinned: true } });
  assert.deepEqual(posted, ['yokoten ci-health · updated issue #12 in octo/demo', '', '  ok          2 runs: 2 problems']);
});

test('provenance: the screen is a title and fields per commit (#756, #1115)', () => {
  const record = { commit: 'a1b2c3d4e5', subject: 'feat(check): one screen (#12)', writers: [{ vendor: 'Claude Code', model: 'opus' }], reviewers: [], tier: 'B', issues: [12], approver: '' } as unknown as Parameters<typeof provenanceScreen>[0][number];
  const lines = provenanceScreen([record, { ...record, commit: 'f0e1d2c3b4' }], 'main~2..main');
  assert.deepEqual(lines.slice(0, 7), [
    'yokoten provenance · a1b2c3d feat(check): one screen (#12)',
    '',
    '  writer      Claude Code (opus)',
    '  reviewers   none',
    '  approver    unknown',
    '  tier        B',
    '  issue       #12',
  ]);
  assert.deepEqual(broken(lines), []);
  assert.deepEqual(provenanceScreen([], 'HEAD~0..HEAD'), ['yokoten provenance · no commit in HEAD~0..HEAD']);
});

test('marks: the counts screen is fields, never a value; marks with no action reads only (#434, #1115)', async () => {
  const lines = marksScreen({ action: 'list', kinds: [{ kind: 'git name', count: 1, isOff: false, isFromInstall: true }, { kind: 'by hand', count: 2, isOff: false, isFromInstall: false }], files: ['~/.config/yokoten/private-marks'] });
  assert.deepEqual(lines, ['yokoten marks · 3 private marks, values never shown', '', '  git-name    1, added by install', '  your own    2', '', 'Add one: `yokoten marks add`']);
  assert.deepEqual(broken(lines), []);
  const { sandbox, file } = marksSandbox();
  const result = await sandbox.call(['marks']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!existsSync(file), 'a bare `yokoten marks` writes no marks file');
});

test('pr sync: a conflict gets its files, hunks and brief as sections, then the next step (#432, #1115)', () => {
  const lines = prSyncScreen({
    isCut: false,
    pulls: [
      { number: 4, branch: 'work', base: 'main', state: 'merged' },
      { number: 5, branch: 'fix', base: 'main', state: 'needs-agent', files: ['src/a.ts'], hunksText: ['<<<<<<< HEAD\nconst a = 1;\n=======\nconst a = 2;\n>>>>>>> main'], brief: 'Merge main into fix.\nKeep both changes.\n' },
    ],
  });
  assert.equal(lines[0], 'yokoten pr sync · 2 open pull requests, 1 needs an agent');
  for (const heading of ['PR #5, files:', 'PR #5, conflict hunks:', 'PR #5, dispatch brief:']) assert.ok(lines.includes(heading), heading);
  assert.ok(lines.includes('  <<<<<<< HEAD'), 'a hunk keeps its own text, indented as rows are');
  assert.match(lines.at(-1) ?? '', /^Next: /);
  assert.deepEqual(broken(lines, true), []);
});

test('borrowed: a source that moved is a row with what became of its issue (record 0024, #1115)', () => {
  const change = { source: 'https://github.com/example/wheel', files: ['src/borrowed/a.ts'], borrowedCommit: 'abc', latestCommit: 'def', commits: [{ sha: 'def', message: 'fix' }], isSecurity: false } as unknown as Parameters<typeof borrowedIssue>[0];
  const lines = borrowedScreen({ sources: 2, outcomes: [{ change, title: 'check: review borrowed code upstream', body: 'x\n', labels: ['bug', 'tier B'], state: 'failed', reason: 'HTTP 403 `x`' }], unreadable: [] });
  assert.equal(lines[0], 'yokoten borrowed · 2 sources, 1 source moved');
  assert.match(lines.at(-1) ?? '', /^Next: /);
  assert.deepEqual(broken(lines, true), []);
});

// #1044: the test files are the ones git lists, so a build folder git ignores is never tested.
test('test: the files are the ones git lists by the runner\'s own names; a build folder is left out (#1044)', async () => {
  assert.deepEqual(testFilesOf(['test/a.test.ts', 'src/a.ts', 'src/b.test.mjs', 'lib/c_test.js', 'test-d.cjs', 'node_modules/x/test/e.js', 'docs/test.md']), ['test/a.test.ts', 'src/b.test.mjs', 'lib/c_test.js', 'test-d.cjs']);
  const sandbox = makeSandbox();
  sandbox.write('.gitignore', 'dist/\n');
  sandbox.write('test/a.test.ts', "import { test } from 'node:test';\ntest('a', () => {});\n");
  sandbox.write('dist/test/a.test.js', "require('node:test').test('a stale build', () => { throw new Error('dist ran'); });\n");
  const shown = await sandbox.call(['test', '--print']);
  assert.equal(shown.status, 0, shown.stderr);
  assert.match(shown.stdout, /^yokoten test · would run 1 test file, /);
  assert.match(flat(shown.stdout), /--test-reporter=dot <1 test file>/);
  assert.deepEqual(broken(shown.stdout.split('\n')), []);
  const ran = await sandbox.call(['test', '--heavy']);
  assert.equal(ran.status, 0, ran.output);
  assert.match(ran.stdout, /^ {2}done {8}tests passed$/m);
});

test('test: the plan and the end are screens of their own (#461, #1115)', () => {
  const plan = testPlanScreen({ files: ['test/a.test.ts'], light: true, jobs: 2, cores: 4, freeBytes: 2 * 1024 ** 3, hasNice: true, shown: 'nice -n 10 node --test <1 test file>' });
  assert.equal(plan[0], 'yokoten test · would run 1 test file, 2 at once, niced');
  assert.deepEqual(broken(plan), []);
  assert.deepEqual(testEndScreen(0), ['  done        tests passed']);
  assert.deepEqual(broken(testEndScreen(3), true), []);
});

// ---- --json is the result the screen is built from (#1115) ----

/** What printJson writes for a value: the bytes a --json reader gets. */
const printed = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

test('check --json: the result becomes the old {check, ok, findings, notes} shape, byte for byte (#1115)', async () => {
  const problem = finding('email', 'an email address', 'remove it', { file: 'a.md', line: 1 });
  const note = finding('long-sentence', 'a sentence of 30 words', 'split it', { file: 'b.md', line: 2 });
  // The shapes the runner printed by hand before, on the same results.
  assert.equal(printed(checkJson({ mode: 'tree', problems: [problem], notes: [note], hints: ['git restore --staged a.md'] })), printed({ check: 'tree', ok: false, findings: [problem], notes: [note] }));
  assert.equal(printed(checkJson({ mode: 'pr', number: '12', problems: [], notes: [note], hints: [] })), printed({ check: 'pr', ok: true, findings: [], notes: [note] }));
  assert.equal(printed(checkJson({ mode: 'issue', problems: [], notes: [note], hints: [], skipped: 'not an issue event' })), printed({ check: 'issue', ok: true, skipped: 'not an issue event', findings: [], notes: [] }));
  // The command prints exactly that shape: no field more, none in another order.
  const sandbox = makeSandbox();
  sandbox.write('notes.md', `mail jane${at}personal-mail.dev\n`);
  sandbox.git('add', '.');
  const run = await sandbox.call(['check', '--json']);
  assert.equal(run.status, 1, run.stderr);
  const report = JSON.parse(run.stdout) as { findings: unknown[]; notes: unknown[] };
  assert.ok(report.findings.length > 0, run.stdout);
  assert.equal(run.stdout, printed({ check: 'tree', ok: false, findings: report.findings, notes: report.notes }));
});

test('provenance --json: the rows the screen shows, in the old shape, an unknown approver as null (#1115)', () => {
  const record = { commit: 'a1b2c3d4e5', subject: 'feat(check): one screen (#12)', writers: [{ vendor: 'Claude Code', model: 'opus' }], reviewers: [], tier: 'B', issues: [12], approver: '' } as unknown as Parameters<typeof provenanceJson>[0][number];
  const old = (row: typeof record) => ({ commit: row.commit, subject: row.subject, writers: row.writers, reviewers: row.reviewers, approver: row.approver || null, tier: row.tier, issues: row.issues });
  const rows = [record, { ...record, commit: 'f0e1d2c3b4', approver: 'octo' }];
  assert.equal(printed(provenanceJson(rows)), printed(rows.map(old)));
  assert.equal(printed(provenanceJson([])), printed([]));
});

test('borrowed --json: the watch and the issues, in the old shape, from the result; nothing is opened (#1115)', async () => {
  const source = 'https://github.com/example/upstream/blob/main/src/thing.ts';
  const sha = '0123456789abcdef0123456789abcdef01234567';
  const host: BorrowedHost = { commits: (from) => (from.includes('gone') ? null : [{ sha: 'fedcba9876543210fedcba9876543210fedcba98', message: 'fix: a bug' }, { sha, message: 'taken' }]) };
  const watch = watchBorrowed([{ path: 'src/borrowed/thing.ts', source, commit: sha, license: 'MIT' }, { path: 'src/borrowed/gone.ts', source: `${source}/gone`, commit: sha, license: 'MIT' }], host);
  assert.equal(watch.changed.length, 1);
  assert.equal(watch.unreadable.length, 1);
  // The old runner printed the watch, then each moved source with its issue.
  const old = { borrowed: watch, issues: watch.changed.map((change) => ({ source: change.source, ...borrowedIssue(change) })) };
  const result = { sources: 2, unreadable: watch.unreadable, outcomes: watch.changed.map((change) => ({ change, ...borrowedIssue(change), state: 'would open' as const })) };
  assert.equal(printed(borrowedJson(result)), printed(old));
  // A repo with no wheel: the empty shape, exit 0.
  const sandbox = makeSandbox();
  const run = await sandbox.call(['borrowed', '--json']);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, printed({ borrowed: { changed: [], unreadable: [] }, issues: [] }));
});

// ---- yokoten marks: one screen per action, from its result (#1115) ----

test('marks: every action is a screen of its result, never a value, and passes the screen rules (#1115)', () => {
  // The file as this system writes it: hideHome keeps the system's separator after `~`.
  const file = join('~', '.config', 'yokoten', 'private-marks');
  assert.deepEqual(marksScreen({ action: 'add', isAdded: true }), ['yokoten marks · added the mark to your private marks (not shown)']);
  assert.deepEqual(marksScreen({ action: 'remove', isRemoved: true, from: 'git name', isSwitched: true }), [
    'yokoten marks · removed the mark from your private marks',
    '',
    '  note        it came from this machine (your git name), so install adds it',
    '              again',
    '',
    '  stop it     `yokoten marks off git-name`',
  ]);
  assert.deepEqual(marksScreen({ action: 'fill', found: 3, kinds: ['git name', 'git email'], file }), ['yokoten marks · added your git name and git email from this machine (not shown)', '', `  file        ${file}`]);
  assert.match(marksScreen({ action: 'fill', found: 0, kinds: [], file })[0] ?? '', /this machine has none to add/);
  assert.match(marksScreen({ action: 'fill', found: 2, kinds: [], file })[0] ?? '', /nothing new from this machine/);
  assert.deepEqual(marksScreen({ action: 'here', isRemoving: false, isChanged: false }), ['yokoten marks · that mark is already allowed here, so nothing changed']);
  const all = [
    marksScreen({ action: 'add', isAdded: false }),
    marksScreen({ action: 'remove', isRemoved: false, isSwitched: false }),
    marksScreen({ action: 'off', kind: 'git name', removed: 2 }),
    marksScreen({ action: 'on', kind: 'forge login', found: 0, isAdded: false }),
    marksScreen({ action: 'fill', found: 1, kinds: ['private remote host'], file }),
    marksScreen({ action: 'here', isRemoving: true, isChanged: true }),
    marksScreen({ action: 'here', isRemoving: false, isChanged: true }),
  ];
  for (const lines of all) assert.deepEqual(broken(lines), [], lines.join('\n'));
});

test('marks fill: adds the git name this machine has, says the kind and the file, never the value; again, nothing changes (#1115)', async () => {
  const { said, call, marks } = marksSandbox();
  const first = await call(['marks', 'fill']);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, `yokoten marks · added your git name from this machine (not shown)\n\n  file        ${join('~', '.config', 'yokoten', 'private-marks')}\n`);
  assert.match(marks(), new RegExp(`# added by yokoten from this machine: git name\\n${NAME}\\n$`));
  const again = await call(['marks', 'fill']);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /^yokoten marks · nothing new from this machine, so nothing changed$/m);
  // A kind that is off is never filled: off takes the git name out, and fill does not put it back.
  assert.equal((await call(['marks', 'off', 'git-name'])).status, 0);
  const off = await call(['marks', 'fill']);
  assert.equal(off.status, 0, off.stderr);
  assert.ok(!marks().includes(NAME), 'the git name is off, so it is not added');
  assert.equal((await call(['marks', 'fill', 'git-name'])).status, 1, 'fill takes no word');
  assert.ok(!said.some((text) => VALUES.test(text)), 'no output holds a mark');
});
