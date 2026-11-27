// Tests for src/setup/init.ts: --no-ci and the kit workflows.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeSandbox, makeTempDir, rowsText, shareGuardMeasure, shareSelfTest } from '../../repo/helpers.ts';
import { KIT, readWorkflowHashes, render, textHash, VERSION } from '../../../src/setup/files.ts';
import { changeText, compareWorkflow, hasIntactKitJobs, type InitResult, NO_CI_REASON, recordNotNow, resultLines, writeGitignore } from '../../../src/setup/init.ts';
import { initIn, has, noted, said, stubGh, folderWith } from './helpers.ts';

shareGuardMeasure();
shareSelfTest();

// #377: a private repo pays for its Actions minutes. init says so and never chooses for
// the owner; `init --no-ci` keeps CI off, and the road can still be finished.
test('init: a private repo can keep CI off with --no-ci, finish the road, and take CI up again (#377)', async () => {
  const sandbox = makeSandbox();
  const extra = stubGh(sandbox, { 'api users/octo --jq .type': 'User', 'api repos/octo/app --jq .private': 'true' });
  sandbox.git('remote', 'add', 'origin', 'https://github.com/octo/app.git');
  // The remote step is done once a branch is pushed; a local ref is enough for the road.
  sandbox.git('commit', '--allow-empty', '-qm', 'first');
  sandbox.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  const ciFiles = ['.github/workflows/yokoten.yml', '.github/workflows/pr.yml', '.github/workflows/issue.yml', '.github/workflows/actions-health.yml', '.github/dependabot.yml'];
  const isThere = (file: string) => existsSync(join(sandbox.repo, file));
  const notNow = () => JSON.parse(readFileSync(join(sandbox.repo, 'yokoten.json'), 'utf8')).notNow;
  const marks = join(sandbox.home, 'marks');
  writeFileSync(marks, 'placeholder-mark\n');
  const key = join(sandbox.home, 'bot.pem');
  writeFileSync(key, 'not a real key\n');
  const machine = { ...extra, YOKOTEN_PRIVATE_MARKS: marks, YOKOTEN_BOT_APP_ID: '1', YOKOTEN_BOT_KEY: key };
  const session = async () => (await sandbox.call(['doctor', '--session'], { extra: machine })).stdout.trimEnd().split('\n');
  assert.equal(sandbox.run(['install']).status, 0); // a real process: the entry point of install
  // A Node project, so the dependabot.yml init writes has an npm block (#379).
  sandbox.write('package.json', '{}\n');

  // Without the choice: today's behaviour. The workflows are written, and init says what they cost.
  let result = initIn(sandbox, { extra });
  assert.ok(result.ok, said(result));
  assert.equal(noted(result, /^this repo is private/)?.fix, 'yokoten init --no-ci');
  assert.match(noted(result, /^this repo is private/)?.what ?? '', /^this repo is private, so the workflows in \.github\/workflows use Actions minutes from your plan; to keep CI off/);
  assert.ok(ciFiles.every(isThere));
  assert.match(readFileSync(join(sandbox.repo, '.github', 'dependabot.yml'), 'utf8'), /package-ecosystem: npm/);
  assert.deepEqual(notNow(), {}, 'init never makes the choice itself');
  sandbox.write('.github/CODEOWNERS', '* @octo\n');
  sandbox.write('LICENSE', 'placeholder license\n');
  // The road with CI on is in report.test.ts: the tests step asks for a workflow.

  // With the choice: the kit's copies go, a changed one stays and is named, and "notNow" holds the reason.
  sandbox.write('.github/workflows/issue.yml', 'name: ours\n');
  result = initIn(sandbox, { noCi: true, extra });
  assert.ok(result.ok, said(result));
  assert.ok(has(result, 'wrote', /^"notNow" ci in yokoten\.json/));
  for (const file of ['.github/workflows/yokoten.yml', '.github/workflows/pr.yml', '.github/workflows/actions-health.yml', '.github/dependabot.yml']) {
    assert.ok(result.changes.some((change) => change.state === 'removed' && change.note === `${file} (the kit's copy; CI is off)`), file);
    assert.ok(!isThere(file), file);
  }
  assert.ok(noted(result, /^\.github\/workflows\/issue\.yml is kept: it is not the kit's copy/), said(result));
  assert.equal(result.changes.filter((change) => change.path === '.github/workflows/issue.yml').length, 1, 'a kept file is named once');
  assert.doesNotMatch(said(result), /this repo is private/, 'the choice is made, so no offer');
  assert.deepEqual(notNow(), { ci: NO_CI_REASON });
  rmSync(join(sandbox.repo, '.github', 'workflows', 'issue.yml'));
  // A later init writes no workflow again, and says why.
  result = initIn(sandbox, { extra });
  assert.ok(has(result, 'skipped', /^\.github\/workflows\/yokoten\.yml \(yokoten\.json "notNow" names ci\)$/));
  assert.ok(has(result, 'skipped', /^\.github\/dependabot\.yml \(yokoten\.json "notNow" names ci\)$/));
  assert.ok(!ciFiles.some(isThere));

  // The road: no nag about CI, and every step yokoten can check is done or not now: a row
  // marked skipped that starts with "not now" and its reason.
  assert.deepEqual(await session(), ['yokoten: every step yokoten can check is done, or marked not now.']);
  const full = rowsText((await sandbox.call(['doctor', '--all'], { extra: machine })).stdout);
  assert.match(full, /^ +skipped +tests \(Best Practices: test\): not now, CI is off to save Actions minutes[^\n]*\(notNow ci\); run the tests yourself before each merge$/m);
  assert.match(full, /^ +skipped +ci \(Scorecard: CI-Tests\): not now, CI is off to save Actions minutes/m);
  assert.match(full, /^ +skipped +titles \([^)]*\): not now, [^\n]*; run `npx yokoten check --pr <number>` before each merge$/m);
  assert.match(full, /^ +done +security-files/m, 'no Dependabot config is asked for');
  // The trade-off, said once: what is not checked, and when to end the choice.
  assert.equal(full.match(/no-ci: /g)?.length, 1, full);
  assert.match(full, /^ +note +no-ci: CI is off \("notNow" names `ci`\), so nothing on the server checks pull requests, issue titles or the workflows, no code scanning such as CodeQL runs[^\n]*; before each merge, run `npx yokoten check --pr <number>` and the tests; when the repo goes public, remove "ci" from "notNow"/m);

  // Taking CI up again: remove the choice, and init brings the workflows back.
  sandbox.write('yokoten.json', JSON.stringify({ notNow: {} }));
  result = initIn(sandbox, { extra });
  assert.ok(result.ok, said(result));
  assert.ok(ciFiles.every(isThere), said(result));
  assert.doesNotMatch(rowsText((await sandbox.call(['doctor', '--all'], { extra: machine })).stdout), /no-ci/);
});

test('init: only "notNow" ci leaves kit files out; other steps in "notNow" keep today\'s files (#377)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('yokoten.json', JSON.stringify({ notNow: { templates: 'later', changelog: 'later', codeowners: 'later', 'security-files': 'later', titles: 'later' } }));
  const result = initIn(sandbox);
  assert.ok(result.ok, said(result));
  assert.doesNotMatch(said(result), /^skipped /m);
  for (const file of ['.github/ISSUE_TEMPLATE/task.yml', '.github/pull_request_template.md', 'changes/README.md', '.github/SECURITY.md', '.github/dependabot.yml', '.github/CODEOWNERS', '.github/workflows/pr.yml']) {
    assert.ok(existsSync(join(sandbox.repo, file)), file);
  }
});

test('init --no-ci: a kit copy with Windows line ends is removed; a symlinked file or folder is kept and named (#377)', { skip: process.platform === 'win32' && 'symlinks need rights on Windows' }, async () => {
  const sandbox = makeSandbox();
  assert.ok(initIn(sandbox).ok);
  const workflows = join(sandbox.repo, '.github', 'workflows');
  // A Windows checkout (core.autocrlf) has CRLF line ends on every line.
  const pr = join(workflows, 'pr.yml');
  writeFileSync(pr, readFileSync(pr, 'utf8').replace(/\n/g, '\r\n'));
  // A symlinked file: the file it points at stays, whatever it holds.
  const target = join(sandbox.home, 'issue.yml');
  cpSync(join(workflows, 'issue.yml'), target);
  rmSync(join(workflows, 'issue.yml'));
  symlinkSync(target, join(workflows, 'issue.yml'));
  let result = initIn(sandbox, { noCi: true });
  assert.ok(result.ok, said(result));
  assert.ok(has(result, 'removed', /^\.github\/workflows\/pr\.yml \(the kit's copy; CI is off\)$/));
  assert.ok(noted(result, /^\.github\/workflows\/issue\.yml is kept: \.github\/workflows\/issue\.yml is a symlink, and init never deletes through one/), said(result));
  assert.ok(existsSync(target));
  assert.ok(lstatSync(join(workflows, 'issue.yml')).isSymbolicLink());

  // A symlinked .github/workflows folder: nothing in it is deleted.
  const other = makeSandbox();
  assert.ok(initIn(other).ok);
  const real = join(other.home, 'workflows');
  cpSync(join(other.repo, '.github', 'workflows'), real, { recursive: true });
  rmSync(join(other.repo, '.github', 'workflows'), { recursive: true });
  symlinkSync(real, join(other.repo, '.github', 'workflows'));
  result = initIn(other, { noCi: true });
  assert.ok(result.ok, said(result));
  assert.ok(noted(result, /^\.github\/workflows\/yokoten\.yml is kept: \.github\/workflows is a symlink/), said(result));
  assert.deepEqual(readdirSync(real).sort(), ['actions-health.yml', 'issue.yml', 'pr.yml', 'yokoten.yml']);
  // The control: dependabot.yml is a plain file, the kit's copy, so it goes.
  assert.ok(has(result, 'removed', /^\.github\/dependabot\.yml/));
});

// init --no-ci writes the key with recordNotNow; the test above runs it end to end.
test('init --no-ci: only the "notNow" key changes in yokoten.json; the rest keeps its formatting (#377)', () => {
  const wrote = 'wrote "notNow" ci in yokoten.json (to take CI up again, remove it and run `yokoten init`)';
  const root = folderWith({ 'yokoten.json': '{\n    "areas": ["cli",   "docs"],\n    "notNow": {\n        "bot": "no app yet"\n    }\n}\n' });
  assert.deepEqual(resultLines(recordNotNow(root, 'ci', NO_CI_REASON)), [wrote]);
  assert.equal(readFileSync(join(root, 'yokoten.json'), 'utf8'), `{\n    "areas": ["cli",   "docs"],\n    "notNow": {\n        "ci": ${JSON.stringify(NO_CI_REASON)},\n        "bot": "no app yet"\n    }\n}\n`);
  // No "notNow" key yet: one is added after the opening brace, and nothing else moves.
  const other = folderWith({ 'yokoten.json': '{ "areas": ["cli"] }\n' });
  assert.deepEqual(resultLines(recordNotNow(other, 'ci', NO_CI_REASON)), [wrote]);
  assert.equal(readFileSync(join(other, 'yokoten.json'), 'utf8'), `{ "notNow": { "ci": ${JSON.stringify(NO_CI_REASON)} }, "areas": ["cli"] }\n`);
  // A second run keeps it.
  assert.deepEqual(resultLines(recordNotNow(other, 'ci', NO_CI_REASON)), ['kept "notNow" ci in yokoten.json']);
  assert.equal(readFileSync(join(other, 'yokoten.json'), 'utf8'), `{ "notNow": { "ci": ${JSON.stringify(NO_CI_REASON)} }, "areas": ["cli"] }\n`);
});

const KIT_WORKFLOWS = join(KIT, 'project', '.github', 'workflows');

/** Commit everything in the sandbox repo, so git has the files init may replace. */
const commitAll = (sandbox: ReturnType<typeof makeSandbox>) => {
  assert.equal(sandbox.git('add', '-A').status, 0);
  assert.equal(sandbox.git('commit', '-q', '-m', 'before init').status, 0);
};

/** The kit's workflow `name` as init writes it into a project. */
const kitWorkflow = (name: string) => render(readFileSync(join(KIT_WORKFLOWS, name), 'utf8'), { cli: '.yokoten/bin/yokoten.ts', version: VERSION });

/** The released Action the kit pins, read from the kit: Dependabot moves it, so no test names a commit (#980). */
const releasedActionPin = (): string => {
  const pin = kitWorkflow('yokoten.yml').match(/uses: yokoten-labs\/yokoten@[0-9a-f]{40} # v\d+\.\d+\.\d+/)?.[0];
  assert.ok(pin, 'the kit workflow pins no released yokoten Action');
  return pin;
};

/** The kit's newest yokoten.yml with a `tests` job added the way the tests step says (#552). */
const withTestsJob = (yml: string): string =>
  yml
    .replace(/^  ci:$/m, '  tests:\n    runs-on: ubuntu-latest\n    timeout-minutes: 10\n    permissions:\n      contents: read\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          persist-credentials: false\n      - run: npm test\n  ci:')
    .replace('needs: [changes, check, lint]', 'needs: [changes, check, lint, tests]');

/** The kit's yokoten.yml before #451, rebuilt from the newest: one of the versions init wrote. */
const oldYokotenYml = () =>
  kitWorkflow('yokoten.yml')
    // Before #1188, a moved file listed only its new path.
    .replace(' --no-renames', '')
    // Before #1068, a merge queue group was a full run.
    .replace(
      "  # AGENTS.md (#1051). Then the jobs that Markdown can't break are skipped. A merge queue\n  # group reads its files the same way: the group's base to its head is the pull request's\n  # change (#1068). A push to main is a full run. So is a file list that can't be read:\n  # docs_only is true only when the list was read and every file fits.\n",
      "  # AGENTS.md (#1051). Then the jobs that Markdown can't break are skipped. A push to\n  # main is a full run, and so is a merge queue group. So is a file list that can't be\n  # read: docs_only is true only when the list was read and every file fits.\n",
    )
    .replace(
      '          BASE_SHA: ${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha }}\n          HEAD_SHA: ${{ github.event.pull_request.head.sha || github.event.merge_group.head_sha }}\n        run: |\n          docs_only=false\n          if [ "$EVENT" != pull_request ] && [ "$EVENT" != merge_group ]; then\n            echo "Not a pull request or a merge queue group, so every job runs."\n',
      '          BASE_SHA: ${{ github.event.pull_request.base.sha }}\n          HEAD_SHA: ${{ github.event.pull_request.head.sha }}\n        run: |\n          docs_only=false\n          if [ "$EVENT" != pull_request ]; then\n            echo "Not a pull request, so every job runs."\n',
    )
    // Before #1051, only docs/, changes/, README.md and CHANGELOG.md were docs-only.
    .replace(
      "  # docs/ or changes/, or is a Markdown file outside kit/ and .github/ that is not an\n  # AGENTS.md (#1051). Then the jobs that Markdown can't break are skipped. A push to\n  # main is a full run, and so is a merge queue group. So is a file list that can't be\n  # read: docs_only is true only when the list was read and every file fits.\n",
      "  # docs/ or changes/, or is a README.md or CHANGELOG.md outside kit/. Then the jobs that\n  # Markdown can't break are skipped. A push to main is a full run, and so is a merge\n  # queue group. So is a file list that can't be read: docs_only is true only when the\n  # list was read and every file fits.\n",
    )
    .replace(
      '                kit/*|.github/*|AGENTS.md|*/AGENTS.md) docs_only=false ;;\n                docs/*|changes/*|*.md) ;;\n',
      '                kit/*) docs_only=false ;;\n                docs/*|changes/*|README.md|*/README.md|CHANGELOG.md|*/CHANGELOG.md) ;;\n',
    )
    // Before #129, the kit ran only its own copy of yokoten, not the released Action.
    .replace(
      `      # yokoten as a released Action (#129), pinned to the first release by its full\n      # commit: a tag can move, a commit cannot. Dependabot keeps it current. It runs the\n      # release's own copy, so a pull request that changes .yokoten/ still meets a check\n      # it cannot edit. pr.yml and issue.yml still run the project's copy.\n      - ${releasedActionPin()}\n        with:\n          pr-check: 'false'\n          issue-check: 'false'\n          node-version: '^22.23.4'\n`,
      '',
    )
    .replace(
      '# A newer run cancels the one still going for the same pull request: only its newest\n# commit can merge. Every other event gets a group of its own, so a run on main is never\n# cancelled, waiting or running: every commit stays in history (#660, #798).\n',
      '# A new push to a pull request cancels the run still going for it. A push to main gets\n# a group of its own, so a run on main is never cancelled.\n',
    )
    // The group is the same as before #451, so only the lines below differ.
    // Before #660, a push to main cancelled the run still going on main.
    .replace("cancel-in-progress: ${{ github.event_name == 'pull_request' }}", 'cancel-in-progress: true')
    // Before #572, the kit set up Node by its line alone.
    .replace("node-version: '^22.23.4'", 'node-version: 22')
    // Before #590, the kit never ran on a merge queue group.
    .replace('  # A merge queue runs the same checks as a pull request: every job below also runs\n  # on a merge group. Turn the queue on in the repo settings.\n  merge_group:\n', '')
    .replace(
      "  # Markdown can't break are skipped. A push to main is a full run, and so is a merge\n  # queue group. So is a file list that can't be read: docs_only is true only when the\n  # list was read and every file fits.\n",
      "  # Markdown can't break are skipped. A push to main is a full run. So is a file list\n  # that can't be read: docs_only is true only when the list was read and every file fits.\n",
    );

// ---- The kit's workflows: an old copy the project never changed is updated (#456) ----
test('init: the list of kit workflow hashes ends with each workflow as it is now (#456)', () => {
  const hashes = readWorkflowHashes();
  const names = readdirSync(KIT_WORKFLOWS).sort();
  assert.deepEqual(Object.keys(hashes).sort(), names.map((name) => `.github/workflows/${name}`), 'one list for each kit workflow, no more');
  for (const name of names) {
    const list = hashes[`.github/workflows/${name}`];
    assert.equal(list.at(-1), textHash(kitWorkflow(name)), `kit/project/.github/workflows/${name} changed: add its new hash at the end of kit/workflow-hashes.json, and keep the old ones`);
    assert.equal(new Set(list).size, list.length, `${name}: each hash once`);
  }
  assert.ok(hashes['.github/workflows/yokoten.yml'].includes(textHash(oldYokotenYml())), 'the old copy the next tests use is one the kit wrote');
});

test('init: a project with no workflows gets the kit\'s, and a second run keeps them (#456)', async () => {
  const sandbox = makeSandbox();
  let result = initIn(sandbox);
  assert.ok(result.ok, said(result));
  for (const name of readdirSync(KIT_WORKFLOWS)) {
    assert.ok(result.changes.some((change) => change.state === 'wrote' && change.path === `.github/workflows/${name}`), name);
    assert.equal(readFileSync(join(sandbox.repo, '.github/workflows', name), 'utf8'), kitWorkflow(name));
  }
  const workflow = readFileSync(join(sandbox.repo, '.github/workflows/yokoten.yml'), 'utf8');
  assert.match(workflow, /- run: node \.yokoten\/bin\/yokoten\.ts check\n/, 'the check is the project\'s copy, the same as the commit hook (#129, core rule 6)');
  assert.ok(workflow.includes(releasedActionPin()), 'and the released Action, pinned to a commit (#129)');
  assert.match(workflow, /persist-credentials: false/, 'the hardened workflow (#36)');
  assert.match(workflow, /^  ci:\n    if: always\(\)\n    needs: \[changes, check, lint\]$/m, 'one required check that waits for the rest (#36)');
  assert.match(readFileSync(join(sandbox.repo, '.github/workflows/pr.yml'), 'utf8'), /node \.yokoten\/bin\/yokoten\.ts check --pr/, 'the pull request check (#47)');
  assert.match(readFileSync(join(sandbox.repo, '.github/workflows/issue.yml'), 'utf8'), /node \.yokoten\/bin\/yokoten\.ts check --issue/, 'the issue title check');
  result = initIn(sandbox);
  for (const name of readdirSync(KIT_WORKFLOWS)) assert.ok(result.changes.some((change) => change.state === 'kept' && change.path === `.github/workflows/${name}`), name);
  assert.doesNotMatch(rowsText((await sandbox.call(['doctor', '--all'])).stdout), /kit-workflows/, 'nothing to say about the kit\'s own copies');
});

test('init: updates a kit workflow the project never changed, with its line ends (#456)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('.github/workflows/yokoten.yml', oldYokotenYml().replace(/\n/g, '\r\n'));
  // The newest copy with Windows line ends is the same file: kept byte for byte.
  const prCrlf = kitWorkflow('pr.yml').replace(/\n/g, '\r\n');
  sandbox.write('.github/workflows/pr.yml', prCrlf);
  commitAll(sandbox);
  assert.match(rowsText((await sandbox.call(['doctor', '--all'])).stdout), /note +kit-workflows: \.github\/workflows\/yokoten\.yml is an older copy of the kit's, and you never changed it; run `yokoten init` to update it/);
  const result = initIn(sandbox);
  assert.ok(result.ok, said(result));
  assert.ok(has(result, 'updated', /^\.github\/workflows\/yokoten\.yml to the kit's newest copy \(you had not changed it; `git restore --source=HEAD -- \.github\/workflows\/yokoten\.yml` brings the old one back\)$/));
  assert.equal(readFileSync(join(sandbox.repo, '.github/workflows/yokoten.yml'), 'utf8'), kitWorkflow('yokoten.yml').replace(/\n/g, '\r\n'), 'the newest copy, with the line ends the file had');
  assert.ok(has(result, 'kept', /^\.github\/workflows\/pr\.yml$/));
  assert.equal(readFileSync(join(sandbox.repo, '.github/workflows/pr.yml'), 'utf8'), prCrlf);
  assert.doesNotMatch(rowsText((await sandbox.call(['doctor', '--all'])).stdout), /kit-workflows/);
  // The way back init names is true.
  assert.equal(sandbox.git('restore', '--source=HEAD', '--', '.github/workflows/yokoten.yml').status, 0);
  assert.equal(readFileSync(join(sandbox.repo, '.github/workflows/yokoten.yml'), 'utf8'), oldYokotenYml().replace(/\n/g, '\r\n'), 'git restore gives the old text back');
});

test('init: keeps a kit workflow with the project\'s changes, and says once how to see the difference (#456)', async () => {
  const sandbox = makeSandbox();
  const mine = `${oldYokotenYml()}  # our own job goes here\n`;
  sandbox.write('.github/workflows/yokoten.yml', mine);
  const result = initIn(sandbox);
  assert.ok(result.ok, said(result));
  const diff = 'git diff --no-index .github/workflows/yokoten.yml .yokoten/kit/project/.github/workflows/yokoten.yml';
  assert.ok(result.changes.some((change) => change.state === 'kept' && change.path === YML && change.yours), 'kept, and yours');
  assert.deepEqual(noted(result, /^\.github\/workflows\/yokoten\.yml has your changes/), { id: 'kit-workflows', what: ".github/workflows/yokoten.yml has your changes, so it is kept; to see how the kit's newest copy differs", why: '', fix: diff });
  assert.equal(readFileSync(join(sandbox.repo, '.github/workflows/yokoten.yml'), 'utf8'), mine, 'kept byte for byte');
  assert.ok(existsSync(join(sandbox.repo, '.yokoten/kit/project/.github/workflows/yokoten.yml')), 'the command names a file that is there');
  assert.equal(sandbox.git(...diff.split(' ').slice(1)).status, 1, 'and it shows a difference');
  const first = rowsText((await sandbox.call(['doctor', '--all'])).stdout);
  assert.match(first, /note +kit-workflows: \.github\/workflows\/yokoten\.yml has your changes, and the kit's newest copy differs; to see how: `git diff --no-index/);
  assert.doesNotMatch(rowsText((await sandbox.call(['doctor', '--all'])).stdout), /kit-workflows/, 'said once for this kit version');
});

test('init: never writes through a symlinked kit workflow (#456)', async () => {
  const sandbox = makeSandbox();
  const target = join(makeTempDir(), 'yokoten.yml');
  writeFileSync(target, oldYokotenYml());
  mkdirSync(join(sandbox.repo, '.github/workflows'), { recursive: true });
  symlinkSync(target, join(sandbox.repo, '.github/workflows/yokoten.yml'));
  const result = initIn(sandbox);
  assert.ok(result.ok, said(result));
  assert.ok(noted(result, /^\.github\/workflows\/yokoten\.yml is a symlink, so yokoten did not write through it$/), said(result));
  assert.equal(readFileSync(target, 'utf8'), oldYokotenYml());
  assert.ok(lstatSync(join(sandbox.repo, '.github/workflows/yokoten.yml')).isSymbolicLink());
});

test('compareWorkflow: same, older, changed, missing; Windows line ends compare as Unix ones (#456)', () => {
  const root = makeTempDir();
  const rel = '.github/workflows/ci.yml';
  const hashes = { [rel]: [textHash('old: 1\n'), textHash('new: 2\n')] };
  assert.equal(compareWorkflow(root, rel, 'new: 2\n', hashes), 'missing');
  mkdirSync(join(root, '.github/workflows'), { recursive: true });
  for (const [text, state] of [['new: 2\r\n', 'same'], ['old: 1\r\n', 'older'], ['old: 1\r\n\r\n', 'changed'], ['old: 1\n\n', 'changed'], ['old: 1\nx: 1\r\n', 'changed'], ['old: 1\nmine: 3\n', 'changed']] as const) {
    writeFileSync(join(root, rel), text);
    assert.equal(compareWorkflow(root, rel, 'new: 2\n', hashes), state, JSON.stringify(text));
  }
  assert.equal(compareWorkflow(root, rel, 'new: 2\n', {}), 'changed', 'a file with no list is never taken for a kit copy');
  // A folder where a kit workflow goes is kept, not a crash: init says "it has your changes".
  const folder = makeTempDir();
  mkdirSync(join(folder, rel), { recursive: true });
  assert.equal(compareWorkflow(folder, rel, 'new: 2\n', hashes), 'changed');
  // The kit's own old copy with one CRLF, or blank lines at the end, is the project's change, and is kept.
  const old = oldYokotenYml();
  const kit = kitWorkflow('yokoten.yml');
  assert.equal(compareWorkflow(writeWorkflowFile(old), YML, kit), 'older', 'the positive control: the old copy as the kit wrote it');
  assert.equal(compareWorkflow(writeWorkflowFile(`${old.slice(0, old.indexOf('\n'))}\r${old.slice(old.indexOf('\n'))}`), YML, kit), 'changed', 'one CRLF');
  assert.equal(compareWorkflow(writeWorkflowFile(`${old}\n\n`), YML, kit), 'changed', 'blank lines at the end');
});

/** A folder with only the kit's yokoten.yml path, holding `text`. */
const writeWorkflowFile = (text: string): string => folderWith({ '.github/workflows/yokoten.yml': text });

test('compareWorkflow: a job added the way doctor says stays up to date (#552)', () => {
  const root = makeTempDir();
  const rel = '.github/workflows/yokoten.yml';
  const kit = kitWorkflow('yokoten.yml');
  mkdirSync(join(root, '.github/workflows'), { recursive: true });
  writeFileSync(join(root, rel), withTestsJob(kit));
  assert.equal(compareWorkflow(root, rel, kit, readWorkflowHashes()), 'same');
  assert.equal(compareWorkflow(root, rel, kit, {}), 'same', 'no hash list needed');
});

test('hasIntactKitJobs: own jobs and wider needs pass; a kit job behind does not (#552)', () => {
  const kit = 'name: small\non: push\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: make check\n  ci:\n    if: always()\n    needs: [check]\n    runs-on: ubuntu-latest\n    steps:\n      - run: exit 0\n';
  const plusTests = kit
    .replace('  ci:\n', '  tests:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n  ci:\n')
    .replace('needs: [check]', 'needs: [check, tests]');
  assert.ok(hasIntactKitJobs(plusTests, kit), 'an added job and a wider needs list');
  assert.ok(hasIntactKitJobs(plusTests.replace('needs: [check, tests]', 'needs:\n      - check\n      - tests'), kit), 'a block needs list');
  assert.ok(!hasIntactKitJobs(plusTests, kit.replace('on: push', 'on: pull_request')), 'words outside the jobs');
  assert.ok(!hasIntactKitJobs(plusTests.replace('      - run: make check', '      - run: make check-all'), kit), 'a changed kit job');
  assert.ok(!hasIntactKitJobs(plusTests.replace('needs: [check, tests]', 'needs: [tests]'), kit), 'a narrower needs list');
  assert.ok(!hasIntactKitJobs(kit, plusTests), 'the other way round: the kit lacks the added job');
  assert.ok(!hasIntactKitJobs('no jobs here\n', kit), 'no jobs block in the project');
  assert.ok(!hasIntactKitJobs(plusTests, 'no jobs here\n'), 'no jobs block in the kit');
  // The kit's yokoten.yml: a tests job added the way doctor says passes; a kit job behind
  // does not, so doctor notes it as the project's change (the kit-workflows note is in the
  // "keeps a kit workflow with the project's changes" test above).
  const real = kitWorkflow('yokoten.yml');
  assert.ok(hasIntactKitJobs(withTestsJob(real), real));
  const behind = withTestsJob(real).replace("          pr-check: 'false'", "          pr-check: 'true'");
  assert.ok(!hasIntactKitJobs(behind, real), 'the kit job behind');
  assert.equal(compareWorkflow(writeWorkflowFile(behind), YML, real), 'changed');
});

// doctor after adding the tests job the way it says, in a project with a test script (#552).
test('init: keeps a kit workflow with only the project\'s own jobs added (#552)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('package.json', '{"scripts": {"test": "node --test"}}\n');
  const mine = withTestsJob(kitWorkflow('yokoten.yml'));
  sandbox.write(YML, mine);
  commitAll(sandbox);
  const result = initIn(sandbox);
  assert.ok(result.ok, said(result));
  assert.ok(has(result, 'kept', /^\.github\/workflows\/yokoten\.yml$/));
  assert.equal(readFileSync(join(sandbox.repo, YML), 'utf8'), mine, 'kept byte for byte');
  assert.doesNotMatch(rowsText((await sandbox.call(['doctor', '--all'])).stdout), /kit-workflows/);
});

const YML = '.github/workflows/yokoten.yml';

test('init: keeps an old kit workflow that git cannot give back: untracked, or edited since the last commit (#456)', async () => {
  const old = oldYokotenYml();
  const keptLine = (result: InitResult) => noted(result, /^\.github\/workflows\/yokoten\.yml is an older kit copy that is not committed; commit it, then run init again$/) !== undefined;
  // Untracked.
  let sandbox = makeSandbox();
  sandbox.write(YML, old);
  let result = initIn(sandbox);
  assert.ok(result.ok, said(result));
  assert.ok(keptLine(result), said(result));
  assert.equal(readFileSync(join(sandbox.repo, YML), 'utf8'), old);
  // Tracked, with an uncommitted edit that leaves the text a kit copy: HEAD has other text.
  sandbox = makeSandbox();
  sandbox.write(YML, `${old}# committed note\n`);
  commitAll(sandbox);
  sandbox.write(YML, old);
  result = initIn(sandbox);
  assert.ok(keptLine(result), said(result));
  assert.equal(readFileSync(join(sandbox.repo, YML), 'utf8'), old);
  // A committed old copy is updated, and the way back is true: the "updates a kit workflow
  // the project never changed" test above.
});

test('init --no-ci: removes a never-edited old kit workflow, and doctor is quiet about workflows when CI is off (#456)', async () => {
  const sandbox = makeSandbox();
  sandbox.write(YML, oldYokotenYml());
  commitAll(sandbox);
  const result = initIn(sandbox, { noCi: true });
  assert.ok(result.ok, said(result));
  assert.ok(has(result, 'removed', /^\.github\/workflows\/yokoten\.yml \(the kit's copy; CI is off\)$/));
  assert.ok(!existsSync(join(sandbox.repo, YML)));
  // An old copy that stays (CI is off, init keeps it): no note to run init.
  sandbox.write(YML, oldYokotenYml());
  assert.doesNotMatch(rowsText((await sandbox.call(['doctor', '--all'])).stdout), /kit-workflows/);
});

// init writes .gitignore with writeGitignore; the first test above runs it end to end.
test('init: a .gitignore for the worktrees, dependency folders and the board agent file, only adding missing lines (#521, #571, #601, #614)', () => {
  const root = folderWith({ 'package.json': '{"name":"app"}\n' });
  const gitignore = () => readFileSync(join(root, '.gitignore'), 'utf8');
  // Each step: the project's .gitignore before (null: none), the line init prints, and the file after.
  const steps: [before: string | null, line: string, after: string][] = [
    [null, 'wrote .gitignore (.worktrees/, node_modules/, .yokoten-agent.json)', '.worktrees/\nnode_modules/\n.yokoten-agent.json\n'],
    // Again: nothing changes.
    [null, 'kept .gitignore', '.worktrees/\nnode_modules/\n.yokoten-agent.json\n'],
    // The project's own lines stay, in order; a line that is there in another form counts.
    ['.env\n/node_modules', 'added to .gitignore: .worktrees/, .yokoten-agent.json', '.env\n/node_modules\n.worktrees/\n.yokoten-agent.json\n'],
  ];
  for (const [before, line, after] of steps) {
    if (before !== null) writeFileSync(join(root, '.gitignore'), before);
    assert.equal(changeText(writeGitignore(root)), line, String(before));
    assert.equal(gitignore(), after, String(before));
  }
  writeFileSync(join(root, 'Cargo.toml'), '[package]\nname = "x"\n');
  for (const [before, line, after] of [
    ['.env\ncoverage', 'added to .gitignore: .worktrees/, node_modules/, target/, .yokoten-agent.json', '.env\ncoverage\n.worktrees/\nnode_modules/\ntarget/\n.yokoten-agent.json\n'],
    // A line that is already there is not added again.
    ['.yokoten-agent.json\n.env\n', 'added to .gitignore: .worktrees/, node_modules/, target/', '.yokoten-agent.json\n.env\n.worktrees/\nnode_modules/\ntarget/\n'],
  ]) {
    writeFileSync(join(root, '.gitignore'), before);
    assert.equal(changeText(writeGitignore(root)), line, before);
    assert.equal(gitignore(), after, before);
  }
  // No package manager: .worktrees/ and the board agent file only.
  const plain = makeTempDir();
  assert.equal(changeText(writeGitignore(plain)), 'wrote .gitignore (.worktrees/, .yokoten-agent.json)');
  assert.equal(readFileSync(join(plain, '.gitignore'), 'utf8'), '.worktrees/\n.yokoten-agent.json\n');
});
