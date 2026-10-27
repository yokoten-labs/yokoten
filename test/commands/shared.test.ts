// Tests for src/commands/shared.ts.

import '../repo/home.ts';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  at,
  makeSandbox,
  stopCheckoutWalk,
} from '../repo/helpers.ts';
import { invoke } from '../repo/invoke.ts';
import { canColour, isColourTerminal, paint, problemRows, say, styleLine, styleText, type Invocation } from '../../src/commands/shared.ts';
import type { Env } from '../../src/rules/config.ts';
import { finding, fixCommand, formatRefusal, leadingCommand } from '../../src/rules/text/message.ts';

// #1017: a Windows triage saw a guard refusal name `C:Users<name>AppData...`: bash had
// dropped the backslashes, and the home mask looked only for the written path.
test('guard message: a Windows home bash ran together is hidden in a refusal (#1017)', () => {
  const written: string[] = [];
  const stream = { write: (text: string) => written.push(text) } as unknown as Invocation['stderr'];
  const invocation = { env: { HOME: 'C:\\Users\\sample' } } as unknown as Invocation;
  const refusal = formatRefusal(finding('lead-only', `this commit changes C:${'Users'}${'sample'}AppDataLocalx.json, which is lead-only`, 'unstage it'));
  say(invocation, `${refusal}\n`, stream);
  const text = written.join('');
  assert.match(text, /this commit changes ~AppDataLocalx\.json/);
  assert.doesNotMatch(text, /sample/i);
});

test('outside a git repo: every command that needs one says so plainly, exits 1 and writes nothing (#205)', async () => {
  const sandbox = makeSandbox();
  // Inside the sandbox home, so the folder shows as ~. Home is a temp folder, which can sit
  // inside this checkout when TMPDIR does; the marker stops git's walk there (#712).
  stopCheckoutWalk(sandbox.home);
  const away = join(sandbox.home, 'away');
  mkdirSync(away);
  const said = (command: string) => new RegExp(`^yokoten ${command} · this folder is not in a git repo\\n\\nNext: go to your project's folder, or start one here with \`git init\`\\n$`);
  const runs: [string[], string, Record<string, string>?][] = [
    [['doctor'], 'doctor'],
    [['check'], 'check'],
    [['check', '--staged'], 'check'],
    [['check', '--history'], 'check'],
    [['check', '--pr'], 'check'],
    [['check', '--issue'], 'check'],
    [['adopt'], 'adopt'],
    [['update'], 'update'],
    [['update', '--write'], 'update'],
    [['init'], 'init'],
    [['init', '--github', '--yes'], 'init'],
    [['bot', '--', 'gh', 'issue', 'list'], 'bot', { YOKOTEN_BOT_APP_ID: '1' }],
  ];
  for (const [args, command, extra] of runs) {
    const result = await sandbox.call(args, { cwd: away, extra });
    assert.equal(result.status, 1, args.join(' '));
    assert.equal(result.stdout, '', `${args.join(' ')}: nothing on stdout`);
    // A moved command says so first (#1054); the error is the rest.
    assert.match(result.stderr.replace(/^note: .*\n\n/, ''), said(command), args.join(' '));
    assert.deepEqual(readdirSync(away), [], `${args.join(' ')}: nothing written`);
  }
  // --json: the same finding, as data.
  for (const args of [['check', '--json'], ['doctor', '--json']]) {
    const result = await sandbox.call(args, { cwd: away });
    assert.equal(result.status, 1, args.join(' '));
    const out = JSON.parse(result.stdout);
    assert.equal(out.ok, false);
    const found = out.findings.find((f: { id: string }) => f.id === 'not-a-repo');
    assert.equal(found?.what, '~/away is not inside a git repo', args.join(' '));
  }
  // init in a folder that does not exist creates nothing: a typo never becomes a project.
  const result = await sandbox.call(['init', '--list', 'typo'], { cwd: away });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, 'note: yokoten init moved to yokoten. It runs as before this time.\n\nyokoten init: typo does not exist; nothing was written. Create it and run `git init` there first.\n');
  assert.deepEqual(readdirSync(away), [], 'no folder made');
  // A session in a non-repo folder gets no noise, and starts.
  const session = await sandbox.call(['doctor', '--session'], { cwd: away });
  assert.deepEqual([session.status, session.stdout, session.stderr], [0, '', '']);
  // changelog reads changes/ only, and needs no git.
  assert.equal((await sandbox.call(['changelog'], { cwd: away })).status, 0);
});

test('git not installed: a command that needs a repo says git is missing, not "not a repo" (#205)', async () => {
  const sandbox = makeSandbox();
  // Only node on the PATH.
  const noGit = join(sandbox.home, 'no-git');
  mkdirSync(noGit);
  symlinkSync(process.execPath, join(noGit, 'node'));
  for (const command of ['check', 'doctor']) {
    const result = await sandbox.call([command], { extra: { PATH: noGit } });
    assert.equal(result.status, 1, command);
    assert.match(result.stderr.replace(/^note: .*\n\n/, ''), new RegExp(`^yokoten ${command}( ·|:) git is not installed \\(or not on PATH\\); yokoten needs git[.\\n]`), command);
    // The next step names both causes: git may be installed but not on PATH (#1115 review).
    if (command === 'doctor') assert.match(result.stderr, /\n\nNext: install git, or add it to PATH, then run `yokoten doctor` again\n$/);
  }
});

test('--json: check, doctor, hook and explain print pure JSON with what, why and fix; never a private value (#42)', async () => {
  const sandbox = makeSandbox();
  const marks = join(sandbox.home, 'marks');
  writeFileSync(marks, 'mycity\n');
  const extra = { YOKOTEN_PRIVATE_MARKS: marks, YOKOTEN_ROLE: 'worker' };
  const token = `${'gh'}p_${'x7Y2k9'.repeat(6)}`;
  sandbox.write('AGENTS.md', '# rules\n');
  sandbox.write('notes/a.md', `me${at}gmail.com\nI live in MyCity\n${token}\nserver ${[10, 1, 2, 3].join('.')}\n`);
  sandbox.write('dist/app.js', 'x\n');
  for (let i = 0; i < 8; i++) sandbox.write(`many/${i}.md`, 'x\n');
  sandbox.git('add', '.');
  const shaped = (f: Record<string, unknown>) => {
    for (const k of ['id', 'what', 'why', 'fix']) assert.ok(typeof f[k] === 'string' && f[k], `${f.id}: ${k}`);
  };
  const clean = (out: string) => {
    for (const secret of ['mycity', 'gmail', token, [10, 1, 2, 3].join('.'), sandbox.home]) assert.ok(!out.toLowerCase().includes(secret.toLowerCase()), `${secret} printed`);
  };

  // check: the text form says what, why and fix on each line.
  // The entry, through the real binary; the rest runs in this process.
  let result: Pick<ReturnType<typeof sandbox.run>, 'status' | 'stdout' | 'stderr'> = sandbox.run(['check', '--staged'], { extra: { ...extra, GIT_AUTHOR_DATE: '2026-10-18T09:00:00+0700' } });
  assert.equal(result.status, 1);
  // One MISSING row per problem (#1027): what on the row, then why and fix as sentences, or
  // the fix's command on its own last line (#1115).
  const problems = result.stderr.replace(/\s+/g, ' ').split(' MISSING ').slice(1).map((one) => one.split(' Next: ')[0] ?? one);
  assert.ok(problems.length >= 7, result.stderr);
  for (const one of problems) assert.match(one, /^.+ [A-Z].+\. (?:.+\.|Fix: `[^`]+`)\s*$/, one);
  clean(result.stderr);
  result = await sandbox.call(['check', '--staged', '--json'], { extra: { ...extra, GIT_AUTHOR_DATE: '2026-10-18T09:00:00+0700' } });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.equal(report.check, 'staged');
  assert.equal(report.ok, false);
  assert.deepEqual(
    [...new Set(report.findings.map((f: { id: string }) => f.id))].sort(),
    ['build-output', 'email', 'ip', 'layout', 'lead-only', 'private-mark', 'secret', 'time-zone'],
  );
  report.findings.forEach(shaped);
  assert.deepEqual(report.findings.find((f: { id: string }) => f.id === 'email'), {
    id: 'email',
    what: 'an email address',
    why: 'an email address points at a person, and git keeps it after the file is gone',
    fix: 'use your GitHub noreply address, or a placeholder at example.com. If it is your project\'s own public address, such as support@ at its domain, add it to "privacy.allow" in yokoten.json',
    docs: 'https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#privacy',
    file: 'notes/a.md',
    line: 1,
    grade: 'sure',
  });
  clean(result.stdout);
  result = await sandbox.call(['check', '--json'], { extra });
  assert.deepEqual(Object.keys(JSON.parse(result.stdout)), ['check', 'ok', 'findings', 'notes']);

  // hook: the runtimes still read stderr and the exit code; --json adds the finding on stdout.
  const call = { cwd: sandbox.repo, tool_input: { command: 'git push --force' } };
  result = await sandbox.call(['hook', '--json'], { input: JSON.stringify(call) });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^yokoten stopped this: git push --force forces the push \[force-push\]\n\n  Why       [\s\S]+?\n  Instead   .*Use --force-with-lease/);
  const blocked = JSON.parse(result.stdout);
  assert.equal(blocked.blocked, true);
  shaped(blocked.finding);
  assert.equal(blocked.finding.id, 'force-push');
  result = await sandbox.call(['hook', '--json'], { input: JSON.stringify({ cwd: sandbox.repo, tool_input: { command: 'git status' } }) });
  assert.deepEqual([result.status, JSON.parse(result.stdout)], [0, { blocked: false, toolCall: true }]);
  result = await sandbox.call(['hook'], { input: JSON.stringify(call) });
  // Without --json, stdout holds only the deny decision Copilot CLI reads (#30); Claude Code ignores it on exit 2.
  assert.deepEqual(Object.keys(JSON.parse(result.stdout)), ['permissionDecision', 'permissionDecisionReason']);

  // doctor: the road and the machine as data.
  result = await sandbox.call(['doctor', '--json'], { extra });
  assert.equal(result.status, 1);
  const doc = JSON.parse(result.stdout);
  assert.equal(doc.stage, 1);
  assert.equal(doc.next.id, 'tool-hook');
  assert.ok(doc.steps.some((st: { id: string; mark: string }) => st.id === 'rules' && st.mark === 'done'));
  assert.ok(doc.findings.some((f: { id: string }) => f.id === 'secret'), 'the tree check is in it');
  doc.findings.forEach(shaped);
  doc.notes.forEach(shaped);
  clean(result.stdout);
  result = await sandbox.call(['doctor', '--session', '--json'], { extra });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout).findings.map((f: { id: string }) => f.id), ['tool-hook']);

  // explain: a known id, and an unknown one with the list.
  result = await sandbox.call(['explain', 'secret', '--json']);
  assert.deepEqual(Object.keys(JSON.parse(result.stdout)), ['found', 'id', 'kind', 'what', 'why', 'check', 'docs']);
  result = await sandbox.call(['explain', 'nope', '--json']);
  assert.equal(result.status, 1);
  const unknown = JSON.parse(result.stdout);
  assert.equal(unknown.found, false);
  assert.ok(unknown.ids.includes('secret') && unknown.ids.includes('tool-hook'));
  result = await sandbox.call(['explain', 'secret']);
  // One screen since #1027: the title, then What, Why and Check rows, and the link last.
  assert.match(result.stdout, /^yokoten explain secret · .+\n\n  What {8}.+\n(?:.*\n)*  Why {9}.+\n(?:.*\n)*  Check {7}.+\n(?:.*\n)*\nMore: https:\/\/github\.com\/yokoten-labs\/yokoten\/blob\/main\/docs\/guide\.md#privacy\n$/, 'the link to the rule (#94)');
  result = await sandbox.call(['explain', 'commit-check']);
  assert.match(result.stdout, /^yokoten explain commit-check · stage 1, safety net\n\n  What {8}.+\n(?:.*\n)*  Why {9}.+\n(?:.*\n)*  Check {7}.+\n(?:.*\n)*  Standard {4}OSPS-BR-07\.01\n\nMore: .+\n$/);
});

// #707: colour for a person's terminal, never for an agent, a pipe or a file. `NO_COLOR`
// turns it off.
test('output colour: a terminal only, and NO_COLOR or a dumb terminal turns it off (#707)', () => {
  assert.equal(isColourTerminal({}, { isTTY: true }), true);
  assert.equal(isColourTerminal({}, { isTTY: false }), false);
  assert.equal(isColourTerminal({}, {}), false, 'a pipe is not a terminal');
  assert.equal(isColourTerminal({ NO_COLOR: '' }, { isTTY: true }), false, 'an empty NO_COLOR still turns it off');
  assert.equal(isColourTerminal({ NO_COLOR: '1' }, { isTTY: true }), false);
  assert.equal(isColourTerminal({ TERM: 'dumb' }, { isTTY: true }), false);
  const invocation = (command: string, env: Env = {}): Invocation => ({
    command,
    args: [],
    env,
    cwd: '',
    stdout: { isTTY: true } as Invocation['stdout'],
    stderr: { isTTY: true } as Invocation['stderr'],
    stdin: { fd: null, text: null, stream: {} as Invocation['stdin']['stream'] },
    script: '',
  });
  assert.equal(canColour(invocation('doctor'), invocation('doctor').stdout), true);
  assert.equal(canColour(invocation('hook'), invocation('hook').stdout), false, 'an agent reads the hook answer');
  assert.equal(canColour(invocation('doctor', { NO_COLOR: '1' }), invocation('doctor').stdout), false);
});

test('output colour: a mark in green, red or yellow, a heading in bold, a command in cyan (#707)', () => {
  assert.equal(paint('ok', '32', false), 'ok', 'off is plain text');
  // Rule 3 of the layout (owner 2026-10-24): a mark and a word, and the word keeps its
  // column, so a block of states still lines up.
  assert.equal(styleLine('  ok      tool-call-guard: ready', false), '  ok      tool-call-guard: ready');
  assert.equal(styleLine('  ok      tool-call-guard: ready', true), '  \u001b[32m✔ ok\u001b[0m    tool-call-guard: ready');
  assert.match(styleLine('  MISSING tree: 2 problems', true), /^\s+\u001b\[31m✘ MISSING\u001b\[0m /);
  assert.match(styleLine('    note    a warning', true), /^\s+\u001b\[33m⚠ note\u001b\[0m /);
  // A file kept because the user changed it is a note, not done; the words stay the same (#964).
  // The first two are `describeWrite`'s words, the rest init's (src/setup/init.ts:87, 805, 1260, and
  // install's own setting, so every command prints the same state in one colour).
  const keptAsYours = [
    "  kept    the skill foo in ~/.claude/skills/foo (yours, not yokoten's)",
    '  kept    (your edit) the skill foo',
    '  kept    your Claude Code sandbox in .claude/settings.json (doctor names what differs)',
    '  kept    your .githooks/pre-commit: .githooks/pre-commit runs it after the check',
    '  kept    .github/workflows/ci.yml: it has your changes. To see how the kit\'s newest copy differs: `git diff --no-index .github/workflows/ci.yml .yokoten/kit/project/.github/workflows/ci.yml`',
    '  kept    your own git mailmap.file setting; add the lines of .mailmap to that file',
  ];
  for (const kept of keptAsYours) {
    assert.match(styleLine(kept, true), /^\s+\u001b\[33m⚠ kept\u001b\[0m /, kept);
    assert.equal(styleLine(kept, false), kept);
  }
  assert.match(styleLine('  kept    the tool-call hook in .claude/settings.json', true), /^\s+\u001b\[32m✔ kept\u001b\[0m /, 'a file that was already right stays done');
  assert.equal(styleLine('  next: run `yokoten init`', true), '  next: run \u001b[36m`yokoten init`\u001b[0m', 'a command line is not a state');
  assert.equal(styleLine('project:', true), '\u001b[1mproject:\u001b[0m');
  assert.equal(styleLine('yokoten stopped this: a tag push [release]', true), '\u001b[1;31myokoten stopped this: a tag push [release]\u001b[0m');
  assert.equal(styleLine('  1. safety net', true), '\u001b[1m  1. safety net\u001b[0m');
  assert.equal(styleLine('Run `yokoten init` first', true), 'Run \u001b[36m`yokoten init`\u001b[0m first');
  // The five states, each with its glyph, in its colour.
  const states: [string, string, string][] = [
    ['  ok      core-rules', '32', '✔ ok'],
    ['    done        security-files', '32', '✔ done'],
    ['  MISSING runtime: none', '31', '✘ MISSING'],
    ["  can't check review: unread", '33', "? can't check"],
    ['    note    a warning', '33', '⚠ note'],
    ['    next    do this', '33', '● next'],
    ['    to do   do that', '33', '● to do'],
  ];
  for (const [line, colour, mark] of states) {
    assert.ok(styleLine(line, true).includes(`\u001b[${colour}m${mark}\u001b[0m`), `${line.trim()} keeps its mark and word`);
    assert.equal(styleLine(line, false), line, `${line.trim()} off a terminal keeps the word alone`);
  }
  // A state the five rules do not name keeps its word only.
  assert.equal(styleLine('  not now     a decision', true), '  \u001b[33mnot now\u001b[0m     a decision');
  // A command inside a coloured line closes the colour, so the outer style is opened again
  // after it; otherwise the rest of a red refusal or a bold heading goes plain (#707).
  assert.equal(
    styleLine('yokoten stopped this: run `yokoten init` now [release]', true),
    '\u001b[1;31myokoten stopped this: run \u001b[36m`yokoten init`\u001b[0m\u001b[1;31m now [release]\u001b[0m',
  );
  assert.equal(
    styleLine('the road: run `yokoten doctor` next', true),
    '\u001b[1mthe road: run \u001b[36m`yokoten doctor`\u001b[0m\u001b[1m next\u001b[0m',
  );
  assert.equal(styleLine('project: `yokoten init`', true), '\u001b[1mproject: \u001b[36m`yokoten init`\u001b[0m\u001b[0m', 'a command at the end needs no re-open');
  assert.equal(styleText('project:\n  ok      done', false), 'project:\n  ok      done');
  assert.ok(!styleText('project:\n  ok      done', false).includes('\u001b'));
});

// #707: doctor on a terminal, through the command, gets colour; a pipe or NO_COLOR does not.
test('output colour: doctor colours a terminal report and never a pipe or NO_COLOR (#707)', async () => {
  const sandbox = makeSandbox();
  const colour = await invoke(['doctor', '--all'], { env: { ...sandbox.env, NO_COLOR: undefined }, cwd: sandbox.repo, isTTY: true });
  assert.match(colour.stdout, /\u001b\[1m/, 'a heading is bold');
  assert.match(colour.stdout, /\u001b\[(?:32|31|33)m(?:✔ ok|✔ done|✘ MISSING|⚠ note|● next|● to do|\? can't check)\u001b\[0m/, 'a mark has its glyph, its word and its colour');
  assert.ok(!/^[ ]*(?:✔|✘|●|⚠|\?)/m.test(colour.stdout), 'the glyph sits inside the colour, so a plain line never shows one');
  const plain = await invoke(['doctor', '--all'], { env: { ...sandbox.env, NO_COLOR: '1' }, cwd: sandbox.repo, isTTY: true });
  const piped = await invoke(['doctor', '--all'], { env: { ...sandbox.env, NO_COLOR: undefined }, cwd: sandbox.repo });
  for (const [name, result] of [['NO_COLOR', plain], ['a pipe', piped]] as const) {
    assert.ok(!result.stdout.includes('\u001b'), `${name}: no ANSI code`);
    assert.ok(result.stdout.includes('yokoten '), `${name}: the report still reads`);
  }
});

// #929: every command a person runs shows colour on a terminal, and none in a pipe or
// under NO_COLOR. `trust --undo` is the subcommand a sandbox can reach: plain `trust` finds
// no agent installed there, so it has no mark, heading, refusal or command to colour.
const PERSON_COMMANDS: { name: string; args: string[] }[] = [
  { name: 'start', args: [] },
  { name: 'help', args: ['help'] },
  { name: 'install', args: ['install'] },
  { name: 'init', args: ['init'] },
  { name: 'doctor', args: ['doctor'] },
  { name: 'conflicts', args: ['conflicts'] },
  { name: 'train', args: ['train', '--next'] },
  { name: 'check', args: ['check'] },
  { name: 'trust', args: ['trust', '--undo'] },
  { name: 'desk', args: ['desk'] },
  { name: 'msg', args: ['msg', 'inbox'] },
];
for (const { name, args } of PERSON_COMMANDS) {
  test(`output colour: ${name} colours a terminal report and never NO_COLOR or a pipe (#929)`, async () => {
    const sandbox = makeSandbox();
    const colour = await sandbox.call(args, { isTTY: true });
    assert.match(colour.stdout + colour.stderr, /\u001b\[/, `${name}: a colour code on a terminal`);
    const plain = await sandbox.call(args, { isTTY: true, extra: { NO_COLOR: '1' } });
    const piped = await sandbox.call(args, {});
    for (const [kind, result] of [['NO_COLOR', plain], ['a pipe', piped]] as const) {
      assert.ok(!`${result.stdout}${result.stderr}`.includes('\u001b'), `${name}: no ANSI code with ${kind}`);
    }
  });
}

// #929: help reads at a glance: the usage line and the section titles in bold, each
// command's name in cyan.
test('output colour: help bolds the usage and sections, and names each command in cyan (#929)', async () => {
  const sandbox = makeSandbox();
  const list = await sandbox.call(['help'], { isTTY: true });
  assert.match(list.stdout, /\u001b\[1mUsage: yokoten <command> \[options\]\u001b\[0m/, 'the usage line is bold');
  assert.match(list.stdout, /\u001b\[36mkanban\u001b\[0m/, 'a command name is cyan');
  assert.match(list.stdout, /\u001b\[1mCommands:\u001b\[0m/, 'a group title is bold');
  assert.match(list.stdout, /\u001b\[1mMore: /, 'the last section title is bold');
  const one = await sandbox.call(['help', 'check'], { isTTY: true });
  assert.match(one.stdout, /\u001b\[1mUsage: yokoten \u001b\[36mcheck\u001b\[0m\u001b\[1m/, 'the usage names the command in cyan');
  assert.match(one.stdout, /\u001b\[1mOptions:\u001b\[0m/, 'the options title is bold');
  assert.match(one.stdout, /\u001b\[1mExamples?:\u001b\[0m/, 'the example title is bold');
});


// #1027: the screen helpers every command uses.
test('screen helpers: 80 columns, the label column, plural counts, the old console falls back (#1027)', async () => {
  const { wrap, row, title, nextLine, count, isUnicodeTerminal } = await import('../../src/commands/shared.ts');
  const long = 'word '.repeat(40).trim();
  for (const line of [...wrap('  note        ', long), ...row('note', long, 'label'), ...title('doctor', long)]) assert.ok(line.length <= 80, line);
  assert.deepEqual(row('ok', 'on for Claude Code', 'guard'), ['  ok          guard       on for Claude Code']);
  assert.deepEqual(nextLine('yokoten init'), ['Next: `yokoten init`']);
  assert.equal(count(1, 'file'), '1 file');
  assert.equal(count(3, 'file'), '3 files');
  // is-unicode-supported's rules: Windows Terminal and VS Code draw ✔; the classic console gets √.
  assert.equal(isUnicodeTerminal({}, 'win32'), false);
  assert.equal(isUnicodeTerminal({ WT_SESSION: 'x' }, 'win32'), true);
  assert.equal(isUnicodeTerminal({ TERM_PROGRAM: 'vscode' }, 'win32'), true);
  assert.equal(isUnicodeTerminal({}, 'darwin'), true);
  assert.equal(isUnicodeTerminal({ TERM: 'linux' }, 'linux'), false);
  assert.match(styleLine('  ok          guard', true, false), /√ ok/);
  assert.match(styleLine('  ok          guard', true, true), /✔ ok/);
});

// Issue #1115: a fix that starts with a command ends its row on a Fix line, said once.
test('problem rows: a fix that starts with a command is its own last line, said once under the problems it fixes (#1115)', async () => {
  assert.deepEqual(leadingCommand('`yokoten init` adds one'), { command: 'yokoten init', then: '' });
  assert.deepEqual(leadingCommand('run `yokoten marks add` and type your name'), { command: 'yokoten marks add', then: 'type your name' });
  assert.deepEqual(leadingCommand('run `export TZ=UTC`, then keep the command in ~/.bashrc'), { command: 'export TZ=UTC', then: 'keep the command in ~/.bashrc' });
  assert.equal(leadingCommand('Run `git fetch origin` and `git fetch origin pull/1/head`'), null, 'two commands stay one sentence');
  assert.equal(leadingCommand('`AGENTS.md` names no owner'), null, 'a file in backticks is no command');
  assert.equal(leadingCommand('run `yokoten install` again, or report it in an issue'), null, 'more advice after it stays a sentence');
  // One rule for every screen: a command followed by more words is still the fix's command.
  assert.deepEqual(fixCommand('run `yokoten install` from this copy of yokoten'), { command: 'yokoten install', then: 'from this copy of yokoten' });
  assert.deepEqual(fixCommand('run `yokoten install` again, or report it in an issue'), { command: 'yokoten install', then: 'again, or report it in an issue' });
  assert.equal(fixCommand('Run `git fetch origin` and `git fetch origin pull/1/head`'), null, 'two commands stay one sentence');
  assert.equal(fixCommand('make `yokoten.json` valid JSON'), null);
  const same = finding('time-zone', 'no runtime installed', 'run `yokoten install` from this copy of yokoten');
  const checkFix = problemRows([same]).filter((line) => line.includes('Fix: '));
  const doctorFix = (await import('../../src/commands/more/advice/doctor.ts')).problemRows([same]).flat().filter((line) => line.includes('Fix: '));
  assert.deepEqual(checkFix, doctorFix, 'check and doctor show the same Fix line');
  assert.deepEqual(checkFix, ['              Fix: `yokoten install`']);
  // A fix with a follow-up says it on both screens (the check screen keeps it under the why, doctor under the row).
  const marks = finding('time-zone', 'no marks', 'run `yokoten marks add` and type your name');
  const doctorLines = (await import('../../src/commands/more/advice/doctor.ts')).problemRows([marks]).flat();
  assert.ok(problemRows([marks]).some((line) => line.includes('Type your name.')), problemRows([marks]).join('\n'));
  assert.ok(doctorLines.some((line) => line.includes('Type your name.')), doctorLines.join('\n'));
  assert.deepEqual(problemRows([marks]).filter((line) => line.includes('Fix: ')), doctorLines.filter((line) => line.includes('Fix: ')));
  const zone = finding('time-zone', "this commit's time carries your time zone", 'run `export TZ=UTC`, then keep the command in ~/.bashrc');
  const lines = problemRows([zone, { ...zone, what: 'the committer time carries it too' }]);
  assert.deepEqual(lines.filter((line) => line.includes('Fix: ')), ['              Fix: `export TZ=UTC`'], 'one Fix line for both');
  assert.equal(lines.at(-1), '              Fix: `export TZ=UTC`', 'under the last problem it fixes');
  assert.ok(lines.includes(''), 'a blank line between the rows');
  // A positive control: a fix with no leading command keeps its sentence, and no Fix line.
  const plain = problemRows([finding('time-zone', 'one', 'leave history as it is')]);
  assert.ok(!plain.some((line) => line.includes('Fix: ')), plain.join('\n'));
  assert.ok(plain.join(' ').includes('Leave history as it is.'), plain.join('\n'));
});
