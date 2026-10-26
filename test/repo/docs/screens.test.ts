// Every screen keeps the limits of record 0049 (issue #1099). The test renders each screen the
// command list reaches, in this process, through a pipe at 80 columns with no colour, and runs
// `screenProblems` on the text a person reads. A new command joins by itself: its help page and
// its usage error are rendered from COMMANDS. Today's offenders are on WAIVED, each with its
// reason; the list only shrinks. The limits are calibrated on the six screens the owner judged
// (captured-screens.ts). The layout module, src/platform/screen.ts, is tested here too: test/
// holds 7 entries, the cap, so it has no test/platform/ folder.
import '../home.ts';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { field, helpScreen, moreLine, nextLine, row, screen, screenProblems, SCREEN_LIMITS, section, table, title, wrap } from '../../../src/platform/screen.ts';
import { COMMANDS, commandHelp } from '../../../src/run/cli.ts';
import { makeSandbox } from '../helpers.ts';
import { CAPTURED_SCREENS } from './captured-screens.ts';

// ---- The calibration: the owner's six verdicts (issue #1099) ----

test('screen limits: the two screens the owner judged OK pass, and the four he judged too much text fail (#1099)', () => {
  const verdicts = CAPTURED_SCREENS.map(({ id, exit, lines }) => {
    const problems = screenProblems({ text: lines.join('\n'), isFailure: exit !== 0, isHelp: lines[0]?.startsWith('Usage: ') });
    return { id, passes: problems.length === 0, problems };
  });
  for (const { id, passes, problems } of verdicts) {
    const owner = CAPTURED_SCREENS.find((captured) => captured.id === id);
    assert.equal(passes, owner?.isOk, `${id} (${owner?.command}), owner: ${owner?.verdict}; limits: ${problems.join('; ') || 'none broken'}`);
  }
  assert.deepEqual(verdicts.filter((verdict) => verdict.passes).map((verdict) => verdict.id), ['S002', 'S071']);
});

// ---- The layout ----

test('layout: wrap breaks once at 80 columns, under the first text, and never inside a command (#1099)', () => {
  const words = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen';
  const lines = wrap('Next: ', words);
  assert.ok(lines.length > 1 && lines.every((line) => line.length <= 80), 'each line fits 80 columns');
  assert.ok(lines.slice(1).every((line) => line.startsWith('      ') && line[6] !== ' '), 'later lines start under the first text');
  assert.deepEqual(wrap('', `${'x'.repeat(70)} \`yokoten desk --help\``), ['x'.repeat(70), '`yokoten desk --help`'], 'a command in backticks stays whole');
  assert.deepEqual(wrap('', ''), [''], 'no text is one empty line');
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
  const long = 'x'.repeat(30);
  assert.deepEqual(table([['-a', 'short'], [long, 'its text']]), ['  -a                      short', `  ${long}`, `${' '.repeat(26)}its text`]);
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
    '  --fast      skip the slow part',
    '  --help, -h  this help',
    '',
    'Notes:',
    '  one  a row',
    '',
    'More: https://example.com/demo',
  ]);
  assert.deepEqual(screenProblems({ text: lines.join('\n'), isHelp: true }), []);
});

// ---- Each limit, with a positive control ----

test('screen limits: each limit catches its known-bad screen (#1099)', () => {
  const caught = (text: string, more: { isFailure?: boolean; isHelp?: boolean } = {}) => screenProblems({ text, ...more }).join('; ');
  const wide = 'x'.repeat(SCREEN_LIMITS.width + 1);
  assert.equal(caught(wide), '', 'one line may run over, for a link');
  assert.match(caught(`${wide}\n${wide}`), /2 lines are wider than 80 columns/);
  assert.match(caught('x'.repeat(SCREEN_LIMITS.widest + 1)), /101 columns wide/);
  assert.match(caught(Array(SCREEN_LIMITS.prose + 1).fill('prose').join('\n')), /5 lines of prose in a row/);
  assert.equal(caught(['Heading:', ...Array(SCREEN_LIMITS.prose).fill('prose'), '  a row', ...Array(SCREEN_LIMITS.prose).fill('prose')].join('\n')), '', 'a row or a heading ends a run of prose');
  assert.match(caught('Usage: yokoten x\n\none\ntwo\nthree\n\nOptions:\n  -h  this help', { isHelp: true }), /summary is 3 lines/);
  assert.match(caught('yokoten x: it broke.', { isFailure: true }), /does not say what to do next/);
  assert.equal(caught('yokoten x: it broke. Run `yokoten x --help`.', { isFailure: true }), '', 'a command to run is a next step');
  assert.equal(caught('yokoten x · 1 problem\n\nNext: fix it\nMore: https://example.com', { isFailure: true }), '', 'the Next line may come before a More line');
  assert.match(caught('\u001b[1mbold\u001b[0m'), /colour code/);
});

// ---- Every screen the command list reaches ----

/** One screen to render: its key, the words after `yokoten`, and where it runs. */
interface ScreenRun {
  key: string;
  words: string[];
  /** The demo repo (the default), or a folder outside any repo. */
  place?: 'repo' | 'plain' | 'dirty';
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
    ...GUARD_CALLS.map(([name, command]): ScreenRun => ({ key: `guard, ${name}`, words: ['hook'], stdin: toolCall(repo, command), isStderrOnly: true })),
    { key: 'session start', words: ['doctor', '--session'] },
    { key: 'session start, unsaved work', words: ['doctor', '--session'], place: 'dirty' },
    { key: 'session start, codex', words: ['doctor', '--session', '--agent', 'codex'] },
    { key: 'commit check', words: ['check', '--staged'] },
  ];
}

/**
 * Today's offenders (issue #1099, stage 1). Each is a screen built before the layout; stage 2
 * moves it onto src/platform/screen.ts and takes it off. The list only shrinks: a waived
 * screen that passes fails the test until its line is removed, and a new screen is never waived.
 */
/** How many screens WAIVED may hold. Lower it when a screen comes off; never raise it. */
const WAIVED_MOST = 38;
const OLD_HELP ='old help text, one paragraph after another: move it to the help spec, a summary of two lines, then rows (#1099)';
const WAIVED: Record<string, string> = {
  'install --help': `S010: ${OLD_HELP}`,
  'init --help': `S011: ${OLD_HELP}`,
  'trust --help': `S012: ${OLD_HELP}`,
  'doctor --help': `S014: ${OLD_HELP}`,
  'worker --help': `S015: ${OLD_HELP}`,
  'msg --help': `S016: ${OLD_HELP}`,
  'upgrade --help': `S017: ${OLD_HELP}`,
  'check --help': `S019: ${OLD_HELP}`,
  'ci-health --help': `S020: ${OLD_HELP}`,
  'provenance --help': `S021: ${OLD_HELP}`,
  'mcp --help': `S022: ${OLD_HELP}`,
  'redact --help': `S024: ${OLD_HELP}`,
  'test --help': `S025: ${OLD_HELP}`,
  'marks --help': `S026: ${OLD_HELP}`,
  'learn --help': `S028: ${OLD_HELP}`,
  'hook --help': `S029: ${OLD_HELP}; one line is 110 columns`,
  'anchor --help': `S030: ${OLD_HELP}`,
  'stops --help': `S031: ${OLD_HELP}`,
  'pr --help': `S033: ${OLD_HELP}`,
  'bot --help': `S034: ${OLD_HELP}`,
  'train --help': `S035: ${OLD_HELP}`,
  'kanban --help': `S008: ${OLD_HELP}`,
  'tidy --help': `S009: ${OLD_HELP}`,
  'conflicts --help': `S036: ${OLD_HELP}`,
  'uninstall --help': `S037: ${OLD_HELP}`,
  'help --help': `S038: ${OLD_HELP}`,
  'marks, an unknown option': 'its usage error is one line of 157 columns: wrap it, the next step last (#1099)',
  'an unknown command': 'S051: one line names every command, 322 columns: a title, then the closest command or `yokoten help` (#1099)',
  'start, outside a repo': 'S057, the owner: too much text, no structure. The not-a-repo finding is one long line (#1099)',
  'desk, outside a repo': 'S055: the not-a-repo finding is one long line (formatFinding in src/rules/message.ts) (#1099)',
  'kanban --text, outside a repo': 'S056: the not-a-repo finding is one long line (formatFinding in src/rules/message.ts) (#1099)',
  'guard, force push': 'S061, the owner: too much text, no structure. Refusal rows are not wrapped (formatRefusal in src/rules/message.ts) (#1099)',
  'guard, tag push': 'S062: refusal rows are not wrapped (formatRefusal in src/rules/message.ts) (#1099)',
  'guard, wipe home': 'S063: refusal rows are not wrapped (formatRefusal in src/rules/message.ts) (#1099)',
  'guard, skip check': 'S064: refusal rows are not wrapped (formatRefusal in src/rules/message.ts) (#1099)',
  'session start': 'S067: each note is one long line, up to 244 columns (src/setup/doctor/report.ts) (#1099)',
  'session start, unsaved work': 'S069, the owner: too much text, no structure. Each note is one long line (#1099)',
  'session start, codex': 'S068: each note is one long line, up to 244 columns (src/setup/doctor/report.ts) (#1099)',
};

test('screens: every screen the command list reaches keeps the limits of record 0049; WAIVED only shrinks (#1099)', async () => {
  const started = performance.now();
  const sandbox = makeSandbox();
  const plain = join(sandbox.home, 'plain');
  mkdirSync(plain);
  const dirty = makeSandbox();
  dirty.write('notes.md', 'draft\n');
  dirty.write('todo.txt', 'todo\n');
  sandbox.write('notes.txt', 'hello\n');
  sandbox.git('add', 'notes.txt');
  const runs = screensOf(sandbox.repo);
  const broken: string[] = [];
  const healed: string[] = [];
  for (const run of runs) {
    const where = run.place === 'plain' ? { cwd: plain, extra: { GIT_CEILING_DIRECTORIES: dirname(plain) } } : run.place === 'dirty' ? { cwd: dirty.repo } : {};
    const result = await (run.place === 'dirty' ? dirty : sandbox).call(run.words, { input: run.stdin ?? '', ...where });
    const text = run.isStderrOnly ? result.stderr : `${result.stdout}${result.stderr}`;
    const problems = text.trim() === '' ? [] : screenProblems({ text, isFailure: result.status !== 0, isHelp: run.isHelp });
    const isWaived = run.key in WAIVED;
    if (problems.length && !isWaived) broken.push(`${run.key} (yokoten ${run.words.join(' ')}): ${problems.join('; ')}`);
    if (!problems.length && isWaived) healed.push(`${run.key}: it keeps the limits now; take it off WAIVED`);
  }
  const keys = new Set(runs.map((run) => run.key));
  const stale = Object.keys(WAIVED).filter((key) => !keys.has(key)).map((key) => `${key}: no such screen; take it off WAIVED`);
  assert.equal(keys.size, runs.length, 'each screen has its own key');
  assert.deepEqual([...broken, ...healed, ...stale], [], 'build the screen with src/platform/screen.ts (record 0049)');
  assert.ok(Object.values(WAIVED).every((reason) => reason.includes('#1099')), 'each waiver names issue #1099');
  assert.ok(Object.keys(WAIVED).length <= WAIVED_MOST, `WAIVED holds ${Object.keys(WAIVED).length}; the most is ${WAIVED_MOST}, and it only goes down`);
  console.log(`screens: ${runs.length} rendered, ${Object.keys(WAIVED).length} waived, ${Math.round(performance.now() - started)} ms`);
});

test('screens: desk --help is built from the help spec and keeps every limit (#1099)', () => {
  const desk = COMMANDS.find((command) => command.name === 'desk');
  assert.ok(desk && 'help' in desk, 'desk has a help spec');
  const lines = commandHelp(desk);
  assert.deepEqual(screenProblems({ text: lines.join('\n'), isHelp: true }), []);
  for (const heading of ['Examples:', 'Options:', 'The fence:']) assert.ok(lines.includes(heading), `desk --help has ${heading}`);
});
