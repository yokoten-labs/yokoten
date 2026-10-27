// Every screen keeps the limits of record 0049 (issue #1099). The test renders each screen the
// command list reaches, in this process, through a pipe at 80 columns with no colour, and runs
// `screenProblems` on the text a person reads. A new command joins by itself: its help page and
// its usage error are rendered from COMMANDS. Today's offenders are on WAIVED, each with its
// reason; the list only shrinks. The limits are calibrated on the six screens the owner judged
// (captured-screens.ts). The layout module, src/rules/text/screen.ts, is tested here too: test/
// holds 7 entries, the cap, so it has no test/platform/ folder.
import '../home.ts';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { field, helpScreen, moreLine, nextLine, row, screen, SCREEN_WIDTH, section, table, title, wrap } from '../../../src/rules/text/screen.ts';
import { limitOf, SCREEN_RULES, screenProblems } from './screen-rules.ts';
import { COMMANDS, commandHelp } from '../../../src/run/cli.ts';
import { makeSandbox, writeNodeProgram } from '../helpers.ts';
import { CAPTURED_SCREENS } from './captured-screens.ts';

// ---- The calibration: the owner's six verdicts (issue #1099) ----

// A verdict a later rule overrules, with the reason: the owner's own later verdict on the same text.
const OVERRULED: Record<string, string> = {
  S071: 'fix-line: its row is the one the owner flagged in S072, the fix inside a sentence (issue #1115)',
};

test('screen limits: the screens the owner judged OK pass, and the ones he judged too much text fail (#1099, #1115)', () => {
  const verdicts = CAPTURED_SCREENS.map(({ id, exit, lines }) => {
    const problems = screenProblems({ text: lines.join('\n'), isFailure: exit !== 0, isHelp: lines[0]?.startsWith('Usage: ') });
    return { id, passes: problems.length === 0, problems };
  });
  for (const { id, passes, problems } of verdicts) {
    const owner = CAPTURED_SCREENS.find((captured) => captured.id === id);
    const expected = id in OVERRULED ? !owner?.isOk : owner?.isOk;
    assert.equal(passes, expected, `${id} (${owner?.command}), owner: ${owner?.verdict}; limits: ${problems.join('; ') || 'none broken'}`);
  }
  assert.deepEqual(verdicts.filter((verdict) => verdict.passes).map((verdict) => verdict.id), ['S002']);
  assert.match(verdicts.find((verdict) => verdict.id === 'S071')?.problems.join('; ') ?? '', /\[fix-line\]$/, OVERRULED.S071);
});

// ---- The layout ----

test('layout: wrap breaks once at 80 columns, under the first text, and never inside a command (#1099)', () => {
  const words = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen';
  const lines = wrap('Next: ', words);
  assert.ok(lines.length > 1 && lines.every((line) => line.length <= 80), 'each line fits 80 columns');
  assert.ok(lines.slice(1).every((line) => line.startsWith('      ') && line[6] !== ' '), 'later lines start under the first text');
  assert.deepEqual(wrap('', `${'x'.repeat(70)} \`yokoten desk --help\``), ['x'.repeat(70), '`yokoten desk --help`'], 'a command in backticks stays whole');
  assert.deepEqual(wrap('', ''), [''], 'no text is one empty line');
  assert.deepEqual(wrap('', `${'x'.repeat(60)} push (\`git push -u origin --all\`).`), ['x'.repeat(60) + ' push', '(`git push -u origin --all`).'], 'a command after a bracket stays whole');
});

test('layout: a title, rows, fields, a section and the Next line, one blank line between blocks (#1099)', () => {
  const lines = screen(title('tidy', 'nothing to put away'), section('Branches', [...row('ok', 'none old'), ...field('trash', 'empty')]), [], nextLine('yokoten tidy --local'), moreLine('`yokoten tidy --help`'));
  assert.deepEqual(lines, [
    'yokoten tidy · nothing to put away',
    '',
    'Branches:',
    '  ok          none old',
    '  trash       empty',
    '',
    'Next: `yokoten tidy --local`',
    '',
    'More: `yokoten tidy --help`',
  ]);
  assert.deepEqual(section('Empty', []), [], 'a section with no lines is left out');
  assert.equal(screenProblems({ text: lines.join('\n') }).length, 0);
});

test('layout: a table fits its widest label, and a label past the column takes its own line (#1099)', () => {
  assert.deepEqual(table([['--pr', 'push'], ['--agent <name>', 'the AI']]), ['  --pr            push', '  --agent <name>  the AI']);
  const long = 'x'.repeat(40);
  assert.deepEqual(table([['-a', 'short'], [long, 'its text']]), ['  -a                                 short', '', `  ${long}`, `${' '.repeat(37)}its text`], 'a label past the column stands alone, and a blank line goes between the rows');
  assert.deepEqual(table([['-a', 'one'], ['-b', 'two']], 6), ['  -a    one', '  -b    two'], 'a given column, for every table of one screen (#1115)');
});

test('layout: a help page is usage, summary, examples, options, sections, then More (#1099)', () => {
  const lines = helpScreen({
    usage: 'yokoten demo [--fast]',
    summary: ['Shows how a help page reads.'],
    examples: [{ command: 'yokoten demo', text: 'the common case' }, { command: 'yokoten demo --fast', text: 'the quick one' }],
    options: [['--fast', 'skip the slow part'], ['--help, -h', 'this help']],
    sections: [{ heading: 'Notes', rows: [['one', 'a row']] }],
    more: 'https://example.com/demo',
  });
  assert.deepEqual(lines, [
    'Usage: yokoten demo [--fast]',
    '',
    'Shows how a help page reads.',
    '',
    'Examples:',
    '  yokoten demo         the common case',
    '  yokoten demo --fast  the quick one',
    '',
    'Options:',
    '  --fast               skip the slow part',
    '  --help, -h           this help',
    '',
    'Notes:',
    '  one                  a row',
    '',
    'More: https://example.com/demo',
  ]);
  assert.deepEqual(screenProblems({ text: lines.join('\n'), isHelp: true }), []);
});

// ---- Each limit, with a positive control ----

test('screen limits: each limit catches its known-bad screen, and every rule has one (#1099, #1115)', () => {
  // Each rule a control catches, by the [id] its problem ends with; every row of SCREEN_RULES is among them.
  const seen = new Set<string>();
  const caught = (text: string, more: { isFailure?: boolean; isHelp?: boolean } = {}) => {
    const problems = screenProblems({ text, ...more });
    for (const problem of problems) seen.add(/\[([a-z-]+)\]$/.exec(problem)?.[1] ?? '');
    return problems.join('; ');
  };
  const wide = 'x'.repeat(SCREEN_WIDTH + 1);
  assert.equal(caught(wide), '', 'one line may run over, for a link');
  assert.match(caught(`${wide}\n${wide}`), /2 lines are wider than 80 columns/);
  assert.match(caught('x'.repeat(limitOf('widest') + 1)), /101 columns wide/);
  assert.match(caught(Array(limitOf('prose') + 1).fill('prose').join('\n')), /5 lines of prose in a row/);
  assert.equal(caught(['Heading:', ...Array(limitOf('prose')).fill('prose'), '  a row', ...Array(limitOf('prose')).fill('prose')].join('\n')), '', 'a row or a heading ends a run of prose');
  assert.match(caught('Usage: yokoten x\n\none\ntwo\nthree\n\nOptions:\n  -h  this help', { isHelp: true }), /summary is 3 lines/);
  assert.match(caught('yokoten x: it broke.', { isFailure: true }), /does not say what to do next/);
  assert.equal(caught('yokoten x: it broke. Run `yokoten x --help`.', { isFailure: true }), '', 'a command to run is a next step');
  assert.equal(caught('yokoten x · 1 problem\n\nNext: fix it\nMore: https://example.com', { isFailure: true }), '', 'the Next line may come before a More line');
  assert.equal(caught('yokoten x\n\n  Instead   fix it, then\n            try again\n\n  More      https://example.com', { isFailure: true }), '', 'an Instead row wrapped onto two lines is still the next step');
  assert.match(caught('yokoten x\n\n  Instead   fix it\n\n  Why       a reason that wraps\n            onto a second line\n\n  More      https://example.com', { isFailure: true }), /does not say what to do next/, 'a wrapped row is one row: the row before More is Why');
  assert.match(caught('\u001b[1mbold\u001b[0m'), /colour code/);
  // Issue #1115: the four the owner saw on the captured screens, and the fix said once.
  assert.match(caught('Options:\n  -a      one\n  --long  two\n\nNotes:\n  x  three'), /start their text in 2 columns \(5, 10\)/, 'two sections, two text columns');
  assert.equal(caught('Options:\n  -a      one\n\nNotes:\n  x       three'), '', 'one column for every section');
  assert.match(caught('Examples:\n  yokoten a  one\n  yokoten a --very-long-flag\n             two'), /1 examples have their text on the next line/);
  assert.match(caught('Options:\n  -a  one\n      more\n  -b  two'), /1 items touch a wrapped item/);
  assert.equal(caught('Options:\n  -a  one\n      more\n\n  -b  two'), '', 'a blank line between the items');
  assert.equal(caught('Options:\n  -a  one\n  -b  two'), '', 'no item wraps, so the items may touch');
  assert.match(caught('  MISSING     gh is not signed in: run `gh auth login`'), /1 problems keep their fix inside the text/);
  assert.match(caught('  MISSING     gh is not signed in\n              Fix: `gh auth login`\n              then read the repo again'), /keep their fix inside the text/, 'the Fix line is the last line');
  assert.equal(caught('  MISSING     gh is not signed in\n              Fix: `gh auth login`'), '', 'the fix on its own last line');
  assert.match(caught('Not read:\n- the pull requests (please run: `gh auth login`)'), /keep their fix inside the text/, 'an item under Not read is a problem too');
  assert.match(caught('  MISSING     no pull requests\n              Fix: `gh auth login`\n\n  MISSING     no runs\n              Fix: `gh auth login`'), /"Fix: `gh auth login`" 2 times/);
  assert.match(caught('yokoten desk · /var/tmp/work/plain is not in a repo'), /1 paths on this machine show/);
  assert.match(caught('yokoten x · C:\\Users\\someone\\work is gone'), /1 paths on this machine show/, 'a Windows path too');
  assert.equal(caught('yokoten x · ~/work and https://example.com/a/b and GET /api/state'), '', 'a home path, a link and an API path are not machine paths');
  // Stage 2 (#1115, review of stage 1, L1 to L3): what the rules missed.
  assert.match(caught('  ok          main        pushed\n  MISSING     no bot'), /start their text in 2 columns \(14, 26\)/, 'a row with a mark and a label starts its text past the label');
  assert.equal(caught('  ok          pushed\n  MISSING     no bot'), '', 'rows with a mark and no label share one column');
  assert.match(caught('yokoten x · C:/Users/someone/work is gone'), /1 paths on this machine show/, 'a Windows path with forward slashes');
  assert.match(caught('yokoten x · /c/Users/someone/work is gone'), /1 paths on this machine show/, "Git Bash's form of a Windows path");
  assert.match(caught('  MISSING     gh is not signed in; run gh auth login'), /1 problems keep their fix inside the text/, 'a command to run, named without backticks');
  assert.equal(caught('  MISSING     the tests did not run\n              Fix: `npm test`'), '', '"did not run" names no command');
  assert.equal(caught('  MISSING     a run of tests failed\n              Fix: `npm test`'), '', '"a run of" is English, not a command');
  assert.equal(caught('  MISSING     nothing to see\n              Fix: `npm test`\n\n  MISSING     run a check by hand'), '', '"run a" is English, not a command');
  assert.match(caught('  MISSING     gh is not signed in; run yokoten doctor'), /1 problems keep their fix inside the text/, 'run and a known command word');
  assert.deepEqual(SCREEN_RULES.map((rule) => rule.id).filter((id) => !seen.has(id)), [], 'every rule has a control that breaks it');
});

// ---- Every screen the command list reaches ----

/** One screen to render: its key, the words after `yokoten`, and where it runs. */
interface ScreenRun {
  key: string;
  words: string[];
  /** The demo repo (the default), a folder outside any repo, a repo with unsaved work, a GitHub repo where gh is not signed in, a home with a DeepSeek Harness profile, a commit with a time zone, or a new repo of its own. */
  place?: 'repo' | 'plain' | 'dirty' | 'signed-out' | 'deepseek' | 'zoned' | 'fresh';
  stdin?: string;
  /** A guard refusal: the person reads stderr, and stdout is JSON for the agent. */
  isStderrOnly?: boolean;
  isHelp?: boolean;
}

/** A Claude Code tool call, as the guard reads it on stdin. */
const toolCall = (cwd: string, command: string) => JSON.stringify({ cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });

// The six tool calls the lead's capture sent the guard (S061 to S066).
const GUARD_CALLS: [string, string][] = [
  ['force push', 'git push -f origin main'],
  ['tag push', 'git push origin v1.2.0'],
  ['wipe home', 'rm -rf ~'],
  ['skip check', 'git commit --no-verify -m x'],
  ['open a pull request', 'gh pr create --title x --body x'],
  ['plain status', 'git status'],
];

// Commands run with no words in the screen list. install and uninstall change the home, and
// kanban serves until it is stopped, so they stay out. The ones that change the repo each get a
// new repo, so no screen depends on the order they run in.
const BARE = ['init', 'trust', 'update', 'doctor', 'worker', 'msg', 'train', 'ci-health', 'tidy', 'stops', 'version'];
const CHANGES_REPO = new Set(['init', 'trust', 'update', 'tidy', 'stops']);

/** Every screen: each command's help and usage error from COMMANDS, then the screens of a state. */
function screensOf(repo: string): ScreenRun[] {
  return [
    { key: 'help', words: ['help'] },
    { key: 'help --all', words: ['help', '--all'] },
    ...COMMANDS.map((command): ScreenRun => ({ key: `${command.name} --help`, words: [command.name, '--help'], isHelp: true })),
    ...COMMANDS.map((command): ScreenRun => ({ key: `${command.name}, an unknown option`, words: [command.name, '--not-an-option'] })),
    { key: 'an unknown command', words: ['frobnicate'] },
    { key: 'start, outside a repo', words: [], place: 'plain' },
    { key: 'desk, outside a repo', words: ['desk'], place: 'plain' },
    { key: 'kanban --text, outside a repo', words: ['kanban', '--text'], place: 'plain' },
    // S004: each list gh could not read, the cause said once, then one Fix line (#1115).
    { key: 'kanban --text, gh not signed in', words: ['kanban', '--text'], place: 'signed-out' },
    ...GUARD_CALLS.map(([name, command]): ScreenRun => ({ key: `guard, ${name}`, words: ['hook'], stdin: toolCall(repo, command), isStderrOnly: true })),
    { key: 'session start', words: ['doctor', '--session'] },
    { key: 'session start, unsaved work', words: ['doctor', '--session'], place: 'dirty' },
    { key: 'session start, codex', words: ['doctor', '--session', '--agent', 'codex'] },
    { key: 'commit check', words: ['check', '--staged'] },
    // S072: a commit whose time carries a time zone; its row ends with the Fix line (#1115).
    { key: 'commit check, a time zone', words: ['check', '--staged'], place: 'zoned' },
    // init's notes, which a sandbox with no DeepSeek Harness profile never shows; then init again (#1115).
    { key: 'init, a DeepSeek Harness profile', words: ['init'], place: 'deepseek' },
    { key: 'init, run twice', words: ['init'], place: 'deepseek' },
    // Each command with no words, as a newcomer types it: the captured screens S040 to S049 (#1115).
    ...BARE.map((word): ScreenRun => ({ key: `${word}, bare`, words: [word], place: CHANGES_REPO.has(word) ? 'fresh' : 'repo' })),
  ];
}

/**
 * Today's offenders (issue #1099, stage 1). Each is a screen built before the layout; stage 2
 * moves it onto src/rules/text/screen.ts and takes it off. The list only shrinks: a waived
 * screen that passes fails the test until its line is removed, and a new screen is never waived.
 */
// The owner's screen walk-throughs read the same screens this test checks: with SCREENS_OUT
// set to a file (not a YOKOTEN_ name, which test/repo/home.ts clears), the test also writes
// each one there as JSON. A capture never drifts from what the rules see, and needs no script.
const CAPTURE_FILE = process.env.SCREENS_OUT;

/** One screen in the capture: the piped text the rules check, and the same screen at a terminal. */
interface Captured { key: string; command: string; exit: number | null; text: string; problems: string[]; colour?: string }

/** How many screens WAIVED may hold. Lower it in the same change that takes a screen off. */
const WAIVED_MOST = 0;
const WAIVED: Record<string, string> = {
};

test('screens: every screen the command list reaches keeps the limits of record 0049; WAIVED only shrinks (#1099)', async () => {
  const started = performance.now();
  const sandbox = makeSandbox();
  const plain = join(sandbox.home, 'plain');
  mkdirSync(plain);
  const dirty = makeSandbox();
  dirty.write('notes.md', 'draft\n');
  dirty.write('todo.txt', 'todo\n');
  // A GitHub remote, and a gh that answers as gh does when nobody is signed in.
  const signedOut = makeSandbox();
  signedOut.git('remote', 'add', 'origin', 'https://github.com/octo/demo.git');
  const noLogin = writeNodeProgram(join(signedOut.home, 'bin'), 'gh', `process.stderr.write('To get started with GitHub CLI, please run:  gh auth login\\n'); process.exitCode = 4;`, process.platform, signedOut.env);
  // A DeepSeek Harness profile, so init prints its notes (#1115).
  const deepseek = makeSandbox();
  mkdirSync(join(deepseek.home, '.dsh', 'profiles', 'work'), { recursive: true });
  sandbox.write('notes.txt', 'hello\n');
  sandbox.git('add', 'notes.txt');
  const runs = screensOf(sandbox.repo);
  const broken: string[] = [];
  const healed: string[] = [];
  const captured: Captured[] = [];
  const boxOf = (place: ScreenRun['place']) => (place === 'dirty' ? dirty : place === 'signed-out' ? signedOut : place === 'deepseek' ? deepseek : place === 'fresh' ? makeSandbox() : sandbox);
  for (const run of runs) {
    const where =
      run.place === 'plain' ? { cwd: plain, extra: { GIT_CEILING_DIRECTORIES: dirname(plain) } }
      : run.place === 'dirty' ? { cwd: dirty.repo }
      : run.place === 'signed-out' ? { cwd: signedOut.repo, extra: noLogin }
      : run.place === 'deepseek' ? { cwd: deepseek.repo }
      : run.place === 'zoned' ? { extra: { GIT_AUTHOR_DATE: '2026-10-18T09:00:00+0700', SHELL: '/bin/bash' } }
      : {};
    const box = boxOf(run.place);
    const result = await box.call(run.words, { input: run.stdin ?? '', ...where });
    // Both streams in the order written, as a terminal shows them: a moved note comes first.
    const text = run.isStderrOnly ? result.stderr : result.output;
    if (run.key === 'init, a DeepSeek Harness profile') assert.match(text, /note {8}DeepSeek Harness/, `init shows the DeepSeek Harness note: ${text}`);
    if (run.place === 'zoned') assert.match(text, /Fix: `export TZ=UTC`/, `the commit check stops on the time zone: ${text}`);
    if (run.place === 'signed-out') assert.match(text, /\n- the pull requests and the Actions runs: gh is not signed in\n {2}Fix: `gh auth login`\n/, `the fake gh answered: ${text}`);
    const problems = text.trim() === '' ? [] : screenProblems({ text, isFailure: result.status !== 0, isHelp: run.isHelp });
    // The capture also keeps the screen as a terminal shows it, in colour. init on the DeepSeek
    // home runs twice on purpose, so a third run would change what the next screen sees.
    const colour = CAPTURE_FILE && run.place !== 'deepseek' ? await box.call(run.words, { input: run.stdin ?? '', ...where, isTTY: true }) : undefined;
    captured.push({ key: run.key, command: ['yokoten', ...run.words].join(' '), exit: result.status, text, problems, colour: colour && (run.isStderrOnly ? colour.stderr : colour.output) });
    const isWaived = run.key in WAIVED;
    if (problems.length && !isWaived) broken.push(`${run.key} (yokoten ${run.words.join(' ')}): ${problems.join('; ')}`);
    if (!problems.length && isWaived) healed.push(`${run.key}: it keeps the limits now; take it off WAIVED`);
  }
  if (CAPTURE_FILE) writeFileSync(CAPTURE_FILE, `${JSON.stringify(captured, null, 2)}\n`);
  const keys = new Set(runs.map((run) => run.key));
  const stale = Object.keys(WAIVED).filter((key) => !keys.has(key)).map((key) => `${key}: no such screen; take it off WAIVED`);
  assert.equal(keys.size, runs.length, 'each screen has its own key');
  assert.deepEqual([...broken, ...healed, ...stale], [], 'build the screen with src/rules/text/screen.ts (record 0049)');
  assert.ok(Object.values(WAIVED).every((reason) => reason.includes('#1115')), 'each waiver names issue #1115');
  assert.ok(Object.keys(WAIVED).length <= WAIVED_MOST, `WAIVED holds ${Object.keys(WAIVED).length}; the most is ${WAIVED_MOST}, and it only goes down`);
  console.log(`screens: ${runs.length} rendered, ${Object.keys(WAIVED).length} waived, ${Math.round(performance.now() - started)} ms`);
});

// Screens the check above leaves out, for the walk-through only: install, upgrade and uninstall
// change the home, kanban serves until it is stopped, and the rest are states the owner judged
// in v4. Each runs in a sandbox of its own, so the real home is never touched. Linux only: the
// "gh missing" PATH is built from links to node and git.
test('screens: the capture adds the screens that change the home or serve (#1115)', { skip: !CAPTURE_FILE || process.platform !== 'linux' }, async () => {
  const extras: Captured[] = [];
  const keep = (key: string, words: string[], result: { status: number | null; output: string }, colour?: { output: string }) =>
    extras.push({ key, command: ['yokoten', ...words].join(' '), exit: result.status, text: result.output, problems: result.output.trim() === '' ? [] : screenProblems({ text: result.output, isFailure: result.status !== 0 }), colour: colour?.output });
  const both = async (key: string, words: string[], setup: (box: ReturnType<typeof makeSandbox>) => { cwd?: string; extra?: Record<string, string> } = () => ({})) => {
    const plain = makeSandbox();
    const result = await plain.call(words, setup(plain));
    const tty = makeSandbox();
    keep(key, words, result, await tty.call(words, { ...setup(tty), isTTY: true }));
  };
  // A GitHub repo on a machine with no gh: PATH holds node and git only.
  const noGh = (box: ReturnType<typeof makeSandbox>) => {
    box.git('remote', 'add', 'origin', 'https://github.com/octo/demo.git');
    const bin = join(box.home, 'no-gh');
    mkdirSync(bin, { recursive: true });
    for (const name of ['node', 'git']) symlinkSync(name === 'node' ? process.execPath : '/usr/bin/git', join(bin, name));
    return { extra: { PATH: bin } };
  };
  await both('first run', []);
  await both('install', ['install']);
  await both('upgrade', ['upgrade']);
  await both('uninstall', ['uninstall']);
  await both('desk, in a repo', ['desk']);
  await both('first run, gh missing', [], noGh);
  await both('desk, gh missing', ['desk'], noGh);
  await both('kanban --text, gh missing', ['kanban', '--text'], noGh);
  await both('session start, codex, unsaved work', ['doctor', '--session', '--agent', 'codex'], (box) => {
    box.write('notes.md', 'draft\n');
    box.write('todo.txt', 'todo\n');
    return {};
  });
  // kanban serves until it is stopped: the child is stopped after a few seconds, and what it
  // printed by then is the screen.
  const served = makeSandbox().run(['kanban', '--no-open'], { timeout: 5000 });
  const output = `${served.stdout ?? ''}${served.stderr ?? ''}`;
  keep('kanban --no-open', ['kanban', '--no-open'], { status: 0, output });
  const captured = JSON.parse(readFileSync(CAPTURE_FILE!, 'utf8')) as Captured[];
  writeFileSync(CAPTURE_FILE!, `${JSON.stringify([...captured, ...extras], null, 2)}\n`);
});

test('screens: desk --help is built from the help spec and keeps every limit (#1099)', () => {
  const desk = COMMANDS.find((command) => command.name === 'desk');
  assert.ok(desk && 'help' in desk, 'desk has a help spec');
  const lines = commandHelp(desk);
  assert.deepEqual(screenProblems({ text: lines.join('\n'), isHelp: true }), []);
  for (const heading of ['Examples:', 'Options:', 'The fence:']) assert.ok(lines.includes(heading), `desk --help has ${heading}`);
});
