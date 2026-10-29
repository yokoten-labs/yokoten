// Tests for src/host/github/pull-request.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeSandbox, makeTempDir } from '../../repo/helpers.ts';
import { GitReadError } from '../../../src/run/check.ts';
import { noteRows } from '../../../src/commands/more/check.ts';
import { annotation, annotations, isUnreadable, OPEN_PULL_LIMIT, readBranchFiles, readCodeOwners, readEvent, readIssue, readOpenPulls, readPullRequest, stepSummary } from '../../../src/host/github/pull-request.ts';

// #91: workflow commands, escaped as GitHub's runner decodes them
// (docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands).
test('annotations: escape the message and the properties; a history place goes in the message (#91)', () => {
  const f = { id: 'layout', what: '100% full,\nline two\r', why: 'a: b', fix: 'see a, b', file: 'docs/a,b:c.md', line: 7 };
  assert.equal(annotation(f, 'error'), '::error file=docs/a%2Cb%3Ac.md,line=7,title=yokoten layout::docs/a,b:c.md:7: 100%25 full,%0Aline two%0D. A: b. See a, b.', 'the message names the file and line (#1239)');
  assert.equal(annotation({ id: 'large-diff', what: 'big', why: 'w', fix: 'f' }, 'warning'), '::warning title=yokoten large-diff::big. W. F.');
  assert.equal(annotation({ id: 'secret', what: 'a secret', why: 'w', fix: 'f', grade: 'likely', ignored: 'a test fixture' }, 'warning'), '::warning title=yokoten secret::a secret [likely; ignored: a test fixture]. W. F.');
  assert.equal(annotation({ ...f, what: 'x', file: 'commit abc (message)', line: 1 }, 'error', false), '::error title=yokoten layout::commit abc (message):1: x. A: b. See a, b.');
  const linked = { id: 'email', what: 'an email', why: 'w', fix: 'f', docs: 'https://example.com/guide#privacy', file: 'a.md', line: 1 };
  assert.equal(annotation(linked, 'error'), '::error file=a.md,line=1,title=yokoten email::a.md:1: an email. W. F.%0A  docs: https://example.com/guide#privacy', 'the link goes in the message (#94)');
  const many = Array.from({ length: 60 }, (_, i) => ({ id: 'email', what: `e${i}`, why: 'w', fix: 'f', file: 'a.md', line: i + 1 }));
  const lines = annotations(many, [{ id: 'large-diff', what: 'big', why: 'w', fix: 'f' }]);
  assert.equal(lines.length, 50, 'GitHub shows at most 50 per job');
  assert.ok(lines.every((l) => l.startsWith('::error ')), 'problems come before notes');
});

test('step summary: a heading with the result, a table, notes apart, at most 50 rows (#91)', () => {
  assert.equal(stepSummary('yokoten check', [], []), '### yokoten check: ok\n\n');
  // GitHub renders the summary as HTML: a `<` in a cell would hide the text after it.
  assert.match(stepSummary('yokoten check', [{ id: 'email', what: 'an email', why: 'w', fix: 'f', file: '<draft>.md', line: 1 }], []), /\| &lt;draft>\.md:1 \|/);
  assert.match(stepSummary('yokoten check', [{ id: 'email', what: 'a\\|b', why: 'w', fix: 'f' }], []), /\| a\\\\\\\|b \|/);
  const one = stepSummary('yokoten check --pr', [{ id: 'pr-title', what: 'title: a | b', why: 'why', fix: 'fix it' }], [{ id: 'long-sentence', what: 'long', why: 'w', fix: 'f', file: 'a.md', line: 2 }]);
  assert.equal(one, [
    '### yokoten check --pr: 1 problem',
    '',
    '| Place | Rule | What | Why | Fix |',
    '|-------|------|------|-----|-----|',
    '|  | pr-title | title: a \\| b | Why | Fix it |',
    '',
    '#### Notes (1): these never fail the check',
    '',
    '| Place | Rule | What | Why | Fix |',
    '|-------|------|------|-----|-----|',
    '| a.md:2 | long-sentence | long | W | F |',
    '',
    '',
  ].join('\n'));
  // The id links to its section (#94).
  const linked = { id: 'email', what: 'an email', why: 'w', fix: 'f', docs: 'https://example.com/guide#privacy', file: 'a.md', line: 1 };
  assert.match(stepSummary('yokoten check', [linked], []), /\n\| a\.md:1 \| \[email\]\(https:\/\/example\.com\/guide#privacy\) \| an email \| W \| F \|\n/);
  assert.match(stepSummary('yokoten check', [{ id: 'secret', what: 'a secret', why: 'w', fix: 'f', file: 'a.env', line: 2, grade: 'likely', ignored: 'a test fixture' }], []), /\n\| a\.env:2 \| secret \| a secret \[likely; ignored: a test fixture\] \| W \| F \|\n/);
  const many = Array.from({ length: 53 }, (_, i) => ({ id: 'email', what: `e${i}`, why: 'w', fix: 'f', file: 'a.md', line: i + 1 }));
  const text = stepSummary('yokoten check', many, [{ id: 'large-diff', what: 'big', why: 'w', fix: 'f' }]);
  assert.match(text, /^### yokoten check: 53 problems\n/);
  assert.equal(text.split('\n').filter((l) => l.startsWith('| a.md:')).length, 50);
  assert.match(text, /\nAnd 3 more\. The job log lists them all\.\n/);
  assert.match(text, /#### Notes \(1\): these never fail the check\n\nThe job log lists them\.\n/);
});
// #406: the bot reads the branch's files as check --pr reads a pull request's: a rename is its new path.
test('branch files: changed, renamed and deleted paths since the base, from one local diff (#406)', () => {
  const dir = makeTempDir('yokoten-');
  const env = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(dir, '.gitconfig'), GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' };
  const git = (...args: string[]) => spawnSync('git', args, { cwd: dir, env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'old.ts'), 'export const long = "a long enough line for git to see a rename";\n');
  writeFileSync(join(dir, 'gone.md'), 'Gone.\n');
  writeFileSync(join(dir, 'same.md'), 'Same.\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('mv', 'src/old.ts', 'src/new name.ts');
  git('rm', '-q', 'gone.md');
  writeFileSync(join(dir, 'kit.md'), 'New.\n');
  git('add', '.');
  git('commit', '-qm', 'head');
  const read = readBranchFiles(dir, 'origin/main', 'HEAD', process.env);
  assert.deepEqual({ files: read?.files.sort(), deleted: read?.deleted }, { files: ['gone.md', 'kit.md', 'src/new name.ts'], deleted: ['gone.md'] });
  assert.equal(readBranchFiles(dir, 'origin/none', 'HEAD', process.env), null, 'a base git does not have');
});

// No answer from git is never "no CODEOWNERS", which would let a pull request lower its tier (#403).
test('readCodeOwners: the first place the base commit has; a base git can\'t read throws, never null (#403)', () => {
  const sandbox = makeSandbox();
  sandbox.write('README.md', 'a\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'none');
  const none = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  sandbox.write('docs/CODEOWNERS', '/docs/ @b\n');
  sandbox.write('CODEOWNERS', '/kit/ @a\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'owners');
  const owners = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  // The work tree has another file, which a pull request run must not read.
  sandbox.write('CODEOWNERS', '');
  assert.equal(readCodeOwners(sandbox.repo, none, process.env), null);
  assert.deepEqual(readCodeOwners(sandbox.repo, owners, process.env), { text: '/kit/ @a\n', from: 'the base branch' });
  assert.throws(() => readCodeOwners(sandbox.repo, 'f'.repeat(40), process.env), GitReadError);
});

// #267: an event file that is missing or broken is one finding, never a crash; odd fields are skipped.
test('readEvent, readIssue, readPullRequest: a missing or broken event file is one ci-event finding; odd fields are skipped (#267)', () => {
  const sandbox = makeSandbox();
  sandbox.write('README.md', 'Short.\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'base');
  const head = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  const file = join(sandbox.home, 'event.json');
  const env = { ...sandbox.env, GITHUB_EVENT_PATH: file };
  assert.equal(readEvent({}), null, 'no GITHUB_EVENT_PATH is not a run to check');
  const cases: [string | null, RegExp][] = [
    [null, /can't be read/],
    ['{ broken', /is not valid JSON/],
    ['null', /is not a JSON object/],
    ['[1]', /is not a JSON object/],
  ];
  for (const [content, what] of cases) {
    rmSync(file, { force: true });
    if (content !== null) writeFileSync(file, content);
    for (const read of [readEvent(env), readIssue(env), readPullRequest(sandbox.repo, env)]) {
      assert.ok(isUnreadable(read), `${content}`);
      assert.equal(read.problem.id, 'ci-event');
      assert.match(read.problem.what, what);
      assert.doesNotMatch(JSON.stringify(read.problem), /ENOENT|SyntaxError|TypeError|Unexpected token/);
      assert.ok(!JSON.stringify(read.problem).includes(sandbox.home), 'the path is not printed');
    }
  }
  // A label that is null or has no name, and a title that is not text, are skipped, not a crash.
  writeFileSync(file, JSON.stringify({ issue: { title: 'check: a symptom', labels: [null, 7, { name: 'incident' }, {}] } }));
  assert.deepEqual(readIssue(env), { title: 'check: a symptom', labels: ['incident'] });
  writeFileSync(file, JSON.stringify({ issue: { title: 42, labels: null } }));
  assert.deepEqual(readIssue(env), { title: '', labels: [] });
  writeFileSync(file, JSON.stringify({ pull_request: { title: 'feat: a', body: null, labels: [null], milestone: 'M0', base: { sha: head }, head: { sha: head } } }));
  const pr = readPullRequest(sandbox.repo, env);
  assert.ok(!isUnreadable(pr) && pr !== null);
  assert.deepEqual([pr.body, pr.labels, pr.milestone], ['', [], null]);
  // An event with neither is not a run to check.
  writeFileSync(file, JSON.stringify({ action: 'opened', pull_request: null, issue: 'x' }));
  assert.equal(readPullRequest(sandbox.repo, env), null);
  assert.equal(readIssue(env), null);
});

// #273: a base or head commit id that is empty, missing or not text is one finding, never an empty diff.
test('readPullRequest: an event with no base or head commit id is one pr-commits finding (#273)', () => {
  const sandbox = makeSandbox();
  sandbox.write('README.md', 'Short.\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'base');
  const head = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  const file = join(sandbox.home, 'event.json');
  const env = { ...sandbox.env, GITHUB_EVENT_PATH: file };
  const cases: [object, object, string][] = [
    [{}, { sha: head }, 'base commit is'],
    [{ sha: head }, { sha: 7 }, 'head commit is'],
    [{ sha: '' }, { sha: '' }, 'base and head commits are'],
  ];
  for (const [base, headField, what] of cases) {
    writeFileSync(file, JSON.stringify({ pull_request: { title: 'feat: a', body: '', labels: [], base, head: headField } }));
    const read = readPullRequest(sandbox.repo, env);
    assert.ok(isUnreadable(read), what);
    assert.equal(read.problem.id, 'pr-commits');
    assert.equal(read.problem.what, `the pull request's ${what} missing from the event`);
    assert.match(read.problem.fix, /pull_request/);
  }
});

test('annotations: an ignore a pull request adds is a notice, after the problems and before the other notes (#616)', () => {
  const problem = { id: 'secret', what: 'a secret', why: 'w', fix: 'f', file: 'a.ts', line: 1 };
  const added = { id: 'ignore-added', what: 'this pull request lets a secret hit through on this line', why: 'w', fix: 'f', file: 'a.ts', line: 2, ignored: 'a fixture' };
  const note = { id: 'large-diff', what: 'big', why: 'w', fix: 'f' };
  const lines = annotations([problem], [note, added]);
  assert.match(lines[0], /^::error /);
  assert.equal(lines[1], '::notice file=a.ts,line=2,title=yokoten ignore-added::a.ts:2: this pull request lets a secret hit through on this line [ignored: a fixture]. W. F.');
  assert.match(lines[2], /^::notice /, 'a plain note is a notice, not a warning (#1239)');
});

// #1239: the level follows the finding. The count the check screen gives ("6 notes, 1 warning among
// them") is the count of the annotations, so the log and the summary never disagree.
test('annotations: a warning, a notice and an error each have their level, and the screen count matches (#1239)', () => {
  const problem = { id: 'email', what: 'an email address', why: 'w', fix: 'f', file: 'a.md', line: 1, grade: 'sure' as const };
  const warning = { id: 'secret', what: 'a secret (token)', why: 'w', fix: 'f', file: 'a.ts', line: 3, grade: 'unknown' as const };
  const ignored = { id: 'secret', what: 'a secret (token)', why: 'w', fix: 'f', file: 'b.ts', line: 4, grade: 'likely' as const, ignored: 'a fixture' };
  const behind = [1, 2, 3].map((n) => ({ id: 'translation-behind', what: `is behind README.md by ${n} commits`, why: 'w', fix: 'f', file: `docs/i18n/x${n}/README.md`, line: 1 }));
  const added = { id: 'ignore-added', what: 'this pull request lets a secret hit through on this line', why: 'w', fix: 'f', file: 'c.ts', line: 5, ignored: 'a fixture' };
  const notes = [...behind, warning, ignored, added];
  const lines = annotations([problem], notes);
  const level = (name: string) => lines.filter((line) => line.startsWith(`::${name} `));
  assert.equal(level('error').length, 1);
  assert.equal(level('warning').length, 2);
  assert.equal(level('notice').length, 4, 'three plain notes and the added ignore');
  for (const note of [...behind, warning]) assert.ok(lines.some((line) => line.includes(`::${note.file}:${note.line}: `)), `${note.file} is named in its message`);
  const screen = noteRows(notes, false).join('\n');
  assert.match(screen, new RegExp(`${notes.length} notes, ${level('warning').length} warnings among them`));
});

// #432: the open pull requests `pr sync` walks, through one gh list. A fork is kept and
// marked, since its branch is not on origin. Odd rows are skipped, and a failure is a reason.
test('readOpenPulls: open rows, a fork marked, odd rows skipped, a failure is a reason (#432)', () => {
  const calls: string[][] = [];
  const gh = (args: string[]) => {
    calls.push(args);
    return JSON.stringify([
      { number: 3, headRefName: 'work', baseRefName: 'main', isCrossRepository: false },
      { number: 4, headRefName: 'from-fork', baseRefName: 'main', isCrossRepository: true, isDraft: true },
      { number: 0, headRefName: 'bad', baseRefName: 'main' },
      { number: 5, headRefName: '', baseRefName: 'main' },
      { headRefName: 'no-number', baseRefName: 'main' },
    ]);
  };
  assert.deepEqual(readOpenPulls(gh, 'octo/demo'), {
    pulls: [
      { number: 3, branch: 'work', base: 'main', isFork: false, isDraft: false },
      { number: 4, branch: 'from-fork', base: 'main', isFork: true, isDraft: true },
    ],
    isCut: false,
  });
  assert.deepEqual(calls, [['pr', 'list', '--repo', 'octo/demo', '--state', 'open', '--limit', '100', '--json', 'number,headRefName,baseRefName,isCrossRepository,isDraft']]);
  assert.equal(readOpenPulls(() => '{"not":"a list"}', 'o/r'), 'gh gave no pull request list: run it again');
  const missing = () => {
    throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
  };
  assert.match(String(readOpenPulls(missing, 'o/r')), /^gh is not installed/);
  const refused = () => {
    throw Object.assign(new Error('Command failed'), { stderr: 'HTTP 401: Bad credentials' });
  };
  assert.match(String(readOpenPulls(refused, 'o/r')), /^gh can't list the open pull requests/);
});

test('readOpenPulls: a full list is marked as cut at the limit (#809)', () => {
  const rows = Array.from({ length: OPEN_PULL_LIMIT }, (_, at) => ({ number: at + 1, headRefName: `work-${at + 1}`, baseRefName: 'main' }));
  const full = readOpenPulls(() => JSON.stringify(rows), 'o/r');
  assert.equal(typeof full === 'string' ? full : full.isCut, true, 'the caller can say some pull requests were not read');
  const short = readOpenPulls(() => JSON.stringify(rows.slice(0, OPEN_PULL_LIMIT - 1)), 'o/r');
  assert.equal(typeof short === 'string' ? short : short.isCut, false);
});
