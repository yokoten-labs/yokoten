// Every screen keeps the limits of record 0049 (issue #1099). The test renders each screen the
// command list reaches, in this process, through a pipe at 80 columns with no colour, and runs
// `screenProblems` on the text a person reads. A new command joins by itself: its help page and
// its usage error are rendered from COMMANDS. Today's offenders are on WAIVED, each with its
// reason; the list only shrinks. The limits are calibrated on the six screens the owner judged
// (captured-screens.ts). The layout module, src/rules/text/screen.ts, is tested here too: test/
// holds 7 entries, the cap, so it has no test/platform/ folder.
import '../home.ts';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { test } from 'node:test';
import {
  askLine, failure, field, helpScreen, isDoneMark, LABEL_COLUMN, MARK_COLUMN, MARKS, moreLine, nextLine, noteLine, row, ROW_INDENT, ROW_TEXT_COLUMN, screen, SCREEN_WIDTH, section,
  spaced, summaryLine, table, title, underRow, wrap,
} from '../../../src/rules/text/screen.ts';
import { limitOf, machinePathsIn, RATCHETS, type RatchetId, ratchetsOf, readSource, SCREEN_RULES, screenProblems, type SourceFile } from './screen-rules.ts';
import { healedWaivers, readText, RENDER_WAIVED, RENDER_WAIVED_MOST, renderKey, renderProblems } from '../invoke.ts';
import { COMMANDS, commandHelp } from '../../../src/run/cli.ts';
import { styleText } from '../../../src/commands/shared.ts';
import { servingScreen } from '../../../src/commands/kanban/server.ts';
import { anchorNote, anchorScreen, deskStartScreen, stopsOffScreen, stopsOnScreen, stopsScreen, workerEnvScreen, workerMarkedScreen, workerUnmarkedScreen } from '../../../src/commands/hook.ts';
import { checkScreen, ciHealthScreen, marksScreen, prSyncScreen, provenanceScreen, summarizeActionsHealth } from '../../../src/commands/more/check.ts';
import { finding } from '../../../src/rules/text/message.ts';
import { makeSandbox, ROOT, writeNodeProgram } from '../helpers.ts';
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

test('layout: screen() never glues a title to its rows, even when they come in one block (#1115)', () => {
  const rows = [...row('ok', 'none old'), ...row('next', 'put away 2 desks')];
  assert.deepEqual(screen([...title('tidy', 'nothing to put away'), ...rows]), ['yokoten tidy · nothing to put away', '', ...rows], 'a title and its rows in one block get the blank line');
  assert.deepEqual(screen([...title('tidy', 'x'), '', ...rows]), ['yokoten tidy · x', '', ...rows], 'a title already followed by a blank line keeps one');
  const long = title('install', 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen');
  assert.ok(long.length > 1, 'the title wraps');
  assert.deepEqual(screen([...long, ...rows]), [...long, '', ...rows], 'a wrapped title stays whole, the blank line after its last line');
  assert.deepEqual(screen(['yokoten · not set up yet', ...rows]), ['yokoten · not set up yet', '', ...rows], 'the bare command too');
  assert.deepEqual(screen(['Branches:', ...rows]), ['Branches:', ...rows], 'a block with no title is left as it is');
  assert.deepEqual(screen(title('tidy', 'x')), ['yokoten tidy · x'], 'a title alone is one line');
  assert.deepEqual(spaced([title('tidy', 'x'), row('ok', 'a'), row('ok', 'b')]), ['yokoten tidy · x', '', '  ok          a', '  ok          b'], 'spaced() puts a blank line after a title item, not between short rows');
  assert.deepEqual(spaced([row('ok', 'a'), [...row('ok', 'b'), 'more']]), ['  ok          a', '', '  ok          b', 'more'], 'spaced() still separates when any item has two lines');
});

test('layout: failure() is the title, then one Next line, a blank line between (#1115)', () => {
  assert.deepEqual(failure('desk', 'no desk named demo.', 'yokoten desk'), ['yokoten desk · no desk named demo', '', 'Next: `yokoten desk`']);
  assert.deepEqual(failure(undefined, 'git is not installed', 'install git, then run `yokoten` again'), ['yokoten · git is not installed', '', 'Next: install git, then run `yokoten` again'], 'the bare command; a sentence with its command in backticks stays a sentence');
  assert.deepEqual(failure('check', 'nothing to check'), ['yokoten check · nothing to check'], 'with no next, the title stands alone');
  const lines = failure('check', 'the commit message has no issue number, so the change is not linked to its task', 'yokoten check --help');
  assert.ok(lines.every((line) => line.length <= SCREEN_WIDTH));
  assert.deepEqual(screenProblems({ text: lines.join('\n'), isFailure: true }), []);
});

test('layout: noteLine, summaryLine and askLine, the one form each (#1115)', () => {
  assert.deepEqual(noteLine('the GitHub read is slow today'), ['note: the GitHub read is slow today']);
  const long = noteLine('one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen');
  assert.ok(long.length > 1 && long.slice(1).every((line) => line.startsWith('      ') && line[6] !== ' '), 'a long note wraps under its text');
  assert.deepEqual(summaryLine('28 files written'), ['28 files written']);
  const rows = row('ok', 'skills');
  assert.deepEqual(screen(rows, summaryLine('28 files written')), [...rows, '', '28 files written'], 'a summary line is a block of its own');
  assert.equal(askLine('Set up yokoten here?'), 'Set up yokoten here? [Y/n]');
  assert.equal(askLine('Set up yokoten here? [Y/n]'), 'Set up yokoten here? [Y/n]', 'a question that has it already is kept');
});

test('layout: MARKS is every row mark and change state, and the columns are named (#1115)', () => {
  for (const mark of ['ok', 'done', 'next', 'to do', 'MISSING', 'note', "can't check", 'skipped', 'wrote', 'updated', 'linked', 'added', 'removed', 'kept', 'not now']) assert.ok((MARKS as readonly string[]).includes(mark), mark);
  assert.equal(new Set(MARKS).size, MARKS.length, 'one word once');
  assert.ok(MARKS.every((mark) => mark.length < MARK_COLUMN), 'every mark fits its field');
  assert.deepEqual(MARKS.filter(isDoneMark), ['ok', 'done', 'wrote', 'updated', 'linked', 'added', 'removed', 'kept']);
  assert.equal(ROW_TEXT_COLUMN, 26);
  assert.equal(LABEL_COLUMN, 12);
  assert.equal(row('ok', 'text', 'label')[0]?.indexOf('text'), ROW_TEXT_COLUMN, 'a labelled row starts its text at ROW_TEXT_COLUMN');
  assert.equal(row('ok', 'text')[0]?.indexOf('text'), ROW_INDENT + MARK_COLUMN);
  assert.equal(field('trash', 'text')[0]?.indexOf('text'), ROW_INDENT + LABEL_COLUMN);
  assert.deepEqual(row('MISSING', 'text', 'a-very-long-path.md'), ['  MISSING     a-very-long-path.md', `${' '.repeat(ROW_TEXT_COLUMN)}text`], 'a long label stands on its own line');
  assert.deepEqual(underRow('why'), [`${' '.repeat(ROW_TEXT_COLUMN)}why`]);
  assert.deepEqual(underRow('why', false), [`${' '.repeat(ROW_INDENT + MARK_COLUMN)}why`]);
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
  /** The demo repo (the default), a folder outside any repo, a repo with unsaved work, a GitHub repo where gh is not signed in, a home with a DeepSeek Harness profile, a commit with a time zone, or a new home and repo of its own. */
  place?: 'repo' | 'plain' | 'dirty' | 'signed-out' | 'deepseek' | 'zoned' | 'fresh';
  /** A screen built in this process instead of run: the kanban serves until it is stopped, so its banner is rendered as the server would print it. */
  lines?: string[];
  /** The system a screen built in this process was rendered for; a run screen is always this one's (#1115). */
  platform?: NodeJS.Platform;
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

// Commands run with no words in the screen list. The ones that change the home or the repo
// each get a new sandbox, so no screen depends on the order they run in; kanban serves until it
// is stopped, so its banner is rendered below instead.
const BARE = ['install', 'upgrade', 'uninstall', 'init', 'trust', 'update', 'doctor', 'worker', 'msg', 'train', 'ci-health', 'tidy', 'stops', 'version'];
const CHANGES_HOME_OR_REPO = new Set(['install', 'upgrade', 'uninstall', 'init', 'trust', 'update', 'tidy', 'stops']);

// C4: the results check, ci-health, provenance, marks and pr sync render from (#1115).
const C4_PROBLEMS = [
  finding('email', 'an email address', 'remove it, or put it in .yokotenignore if it is meant to be public', { file: 'docs/notes/meeting.md', line: 3 }),
  finding('change-file', 'changelog: 1 changed file has no entry', 'run `yokoten changelog --new`', { why: 'the changelog is how a reader learns what changed' }),
];
const C4_NOTE = finding('long-sentence', 'a sentence of 30 words', 'split it into sentences of 25 words or fewer', { file: 'README.md', line: 2 });
const C4_RUN = { id: 1, workflow: 'CI', event: 'push', branch: 'main', status: 'completed', conclusion: 'failure', createdAt: '2026-10-22T10:00:00Z', startedAt: '2026-10-22T10:01:00Z', updatedAt: '2026-10-22T10:04:00Z', url: 'https://example.com/octo/demo/actions/runs/1' };
const C4_HEALTH = summarizeActionsHealth([C4_RUN, { ...C4_RUN, id: 2, conclusion: 'success', branch: 'work' }, { ...C4_RUN, id: 3, workflow: 'Actions health', conclusion: 'cancelled' }], [{ number: 7, title: 'feat(desk): a desk says its fence', url: 'https://example.com/octo/demo/pull/7', isDraft: false, check: 'test (ubuntu)', conclusion: 'failure' }]);
const C4_SCREENS: ScreenRun[] = [
  { key: 'check, two problems and a note', words: ['check'], lines: checkScreen({ mode: 'tree', problems: C4_PROBLEMS, notes: [C4_NOTE], hints: [] }) },
  { key: 'check, clean', words: ['check'], lines: checkScreen({ mode: 'tree', problems: [], notes: [], hints: [] }) },
  { key: 'ci-health, the summary', words: ['ci-health'], lines: ciHealthScreen({ repo: 'octo/demo', health: C4_HEALTH }) },
  {
    key: 'provenance, a commit',
    words: ['provenance', 'HEAD'],
    lines: provenanceScreen([{ commit: 'a1b2c3d4e5f6', subject: 'feat(check): one screen per check (#1115)', writers: [{ vendor: 'Claude Code', model: 'claude-opus-5-5' }], reviewers: [{ vendor: 'Codex', model: 'gpt-5' }], approver: 'octo', tier: 'A', issues: [1115] } as unknown as Parameters<typeof provenanceScreen>[0][number]], 'HEAD'),
  },
  { key: 'marks, the list', words: ['marks'], lines: marksScreen({ kinds: [{ kind: 'git name', count: 1, isOff: false, isFromInstall: true }, { kind: 'git email', count: 0, isOff: true, isFromInstall: true }, { kind: 'by hand', count: 2, isOff: false, isFromInstall: false }], files: ['~/.config/yokoten/private-marks'] }) },
  {
    key: 'pr sync, a conflict',
    words: ['pr', 'sync'],
    lines: prSyncScreen({
      isCut: false,
      pulls: [
        { number: 4, branch: 'work', base: 'main', state: 'merged' },
        { number: 5, branch: 'fix', base: 'main', state: 'needs-agent', files: ['src/a.ts'], hunksText: ['<<<<<<< HEAD\nexport const limit = 1;\n=======\nexport const limit = 2;\n>>>>>>> main'], brief: 'Merge main into fix and keep both limits.\nRun npx tsc and the tests of src/a.ts.' },
      ],
    }),
  },
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
    { key: 'desk, in a repo', words: ['desk'] },
    { key: 'kanban --text, outside a repo', words: ['kanban', '--text'], place: 'plain' },
    // S004: each list gh could not read, the cause said once, then one Fix line (#1115).
    { key: 'kanban --text, gh not signed in', words: ['kanban', '--text'], place: 'signed-out' },
    ...GUARD_CALLS.map(([name, command]): ScreenRun => ({ key: `guard, ${name}`, words: ['hook'], stdin: toolCall(repo, command), isStderrOnly: true })),
    { key: 'session start', words: ['doctor', '--session'] },
    { key: 'session start, unsaved work', words: ['doctor', '--session'], place: 'dirty' },
    { key: 'session start, codex', words: ['doctor', '--session', '--agent', 'codex'] },
    { key: 'session start, codex, unsaved work', words: ['doctor', '--session', '--agent', 'codex'], place: 'dirty' },
    { key: 'commit check', words: ['check', '--staged'] },
    // S072: a commit whose time carries a time zone; its row ends with the Fix line (#1115).
    { key: 'commit check, a time zone', words: ['check', '--staged'], place: 'zoned' },
    // init's notes, which a sandbox with no DeepSeek Harness profile never shows; then init again (#1115).
    { key: 'init, a DeepSeek Harness profile', words: ['init'], place: 'deepseek' },
    { key: 'init, run twice', words: ['init'], place: 'deepseek' },
    // The first run, and each command with no words, as a newcomer types it: the captured screens S040 to S049 (#1115).
    { key: 'first run', words: [], place: 'fresh' },
    ...BARE.map((word): ScreenRun => ({ key: `${word}, bare`, words: [word], place: CHANGES_HOME_OR_REPO.has(word) ? 'fresh' : 'repo' })),
    { key: 'kanban --no-open', words: ['kanban', '--no-open'], lines: servingScreen({ url: 'http://repo.localhost:49152/', isOpening: false }) },
    { key: 'kanban, opening the browser', words: ['kanban'], lines: servingScreen({ url: 'http://repo.localhost:49152/', isOpening: true }) },
    // C5: stops, worker, anchor, the desk's start and the stop hook's notes, each built from its data (#1115).
    { key: 'stops, on with stops logged', words: ['stops'], lines: stopsScreen({ isOff: false, count: 3, file: '~/.config/yokoten/stops.jsonl' }) },
    { key: 'stops, off', words: ['stops'], lines: stopsScreen({ isOff: true, count: 0, file: '~/.config/yokoten/stops.jsonl' }) },
    { key: 'stops off', words: ['stops', 'off'], lines: stopsOffScreen() },
    { key: 'stops on', words: ['stops', 'on'], lines: stopsOnScreen('~/.config/yokoten/stops.jsonl') },
    { key: 'worker mark, a worktree', words: ['worker', 'mark', '../task'], lines: workerMarkedScreen({ kind: 'worktree', folder: '../task' }) },
    { key: 'worker mark, a worktree on Windows', words: ['worker', 'mark', '..\\task'], lines: workerMarkedScreen({ kind: 'worktree', folder: '..\\task' }), platform: 'win32' },
    { key: 'worker mark, a clone', words: ['worker', 'mark', '../desk-1'], lines: workerMarkedScreen({ kind: 'clone', folder: '../desk-1' }) },
    { key: 'worker unmark', words: ['worker', 'unmark', '../task'], lines: workerUnmarkedScreen('../task') },
    { key: 'worker env', words: ['worker', 'env'], lines: workerEnvScreen({ kept: ['HOME', 'LANG', 'PATH', 'TERM', 'TZ'], dropped: { 'secret name': 2, 'secret value': 1, 'too long': 0, 'not on the list': 14 } }) },
    { key: 'worker env claude-code', words: ['worker', 'env', 'claude-code'], lines: workerEnvScreen({ runtime: 'claude-code', kept: ['ANTHROPIC_API_KEY', 'HOME', 'PATH'], dropped: { 'secret name': 1, 'secret value': 0, 'too long': 0, 'not on the list': 9 } }) },
    { key: 'anchor, no checkpoints', words: ['anchor'], lines: anchorScreen([]) },
    {
      key: 'anchor, two checkpoints',
      words: ['anchor'],
      lines: anchorScreen([
        { commit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', at: '2026-10-28T09:12:00Z', check: 'npm test' },
        { commit: '0f1e2d3c4b5a69788796a5b4c3d2e1f0aabbccdd', at: '2026-10-28T08:40:00Z', check: 'the changed-file check' },
      ]),
    },
    { key: 'desk, the start screen', words: ['desk', 'claude-code', '../desk-1', '--', 'claude'], lines: deskStartScreen({ runtime: 'claude-code', folder: '../desk-1', hosts: ['api.anthropic.com', 'registry.npmjs.org'], fence: 'bwrap' }) },
    { key: 'hook --stop, a passing worker', words: ['hook', '--stop'], lines: anchorNote({ kind: 'recorded', anchor: { commit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', at: '2026-10-28T09:12:00Z', check: 'npm test' } }) },
    { key: 'hook --stop, a dirty tree', words: ['hook', '--stop'], lines: anchorNote({ kind: 'dirty' }) },
    // C5 end.
    // C4: check and its small commands, rendered from result objects (#1115).
    ...C4_SCREENS,
  ];
}

// The owner's screen walk-throughs read the same screens this test checks: with SCREENS_OUT
// set to a file (not a YOKOTEN_ name, which test/repo/home.ts clears), the test also writes
// each one there as JSON, on every system, even when a screen fails the check. A capture never
// drifts from what the rules see, and needs no script.
const CAPTURE_FILE = process.env.SCREENS_OUT;

/** One screen in the capture: the system it was rendered for, the piped text the rules check, and the same lines coloured as a terminal shows them. */
interface Captured { key: string; command: string; platform: NodeJS.Platform; exit: number | null; text: string; problems: string[]; colour: string }

/**
 * Today's offenders (issue #1099, stage 1). Each is a screen built before the layout; stage 2
 * moves it onto src/rules/text/screen.ts and takes it off. The list only shrinks: a waived
 * screen that passes fails the test until its line is removed, and a new screen is never waived.
 */
/** How many screens WAIVED may hold. Lower it in the same change that takes a screen off. */
const WAIVED_MOST = 0;
const WAIVED: Record<string, string> = {
};

/** Renders every screen of the list, in order, on sandboxes of its own. */
async function renderScreens() {
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
  const boxOf = (place: ScreenRun['place']) => (place === 'dirty' ? dirty : place === 'signed-out' ? signedOut : place === 'deepseek' ? deepseek : place === 'fresh' ? makeSandbox() : sandbox);
  const rendered: { run: ScreenRun; status: number | null; text: string }[] = [];
  for (const run of screensOf(sandbox.repo)) {
    if (run.lines) {
      rendered.push({ run, status: 0, text: `${run.lines.join('\n')}\n` });
      continue;
    }
    const where =
      run.place === 'plain' ? { cwd: plain, extra: { GIT_CEILING_DIRECTORIES: dirname(plain) } }
      : run.place === 'dirty' ? { cwd: dirty.repo }
      : run.place === 'signed-out' ? { cwd: signedOut.repo, extra: noLogin }
      : run.place === 'deepseek' ? { cwd: deepseek.repo }
      : run.place === 'zoned' ? { extra: { GIT_AUTHOR_DATE: '2026-10-18T09:00:00+0700', SHELL: '/bin/bash' } }
      : {};
    const result = await boxOf(run.place).call(run.words, { input: run.stdin ?? '', ...where });
    // Both streams in the order written, as a terminal shows them: a moved note comes first.
    rendered.push({ run, status: result.status, text: run.isStderrOnly ? result.stderr : result.output });
  }
  return rendered;
}

test('screens: every screen the command list reaches keeps the limits of record 0049; WAIVED only shrinks (#1099)', async () => {
  const started = performance.now();
  const rendered = await renderScreens();
  const runs = rendered.map(({ run }) => run);
  // Every screen, measured, before any assertion: the capture holds them all even when one fails.
  const checked = rendered.map(({ run, status, text }) => ({
    run,
    status,
    text,
    problems: text.trim() === '' ? [] : screenProblems({ text, isFailure: status !== 0, isHelp: run.isHelp }),
  }));
  // The colour copy is the same text styled as `print` styles it on a terminal; a guard refusal is never coloured (canColour).
  const captured: Captured[] = checked.map(({ run, status, text, problems }) => ({ key: run.key, command: ['yokoten', ...run.words].join(' '), platform: run.platform ?? process.platform, exit: status, text, problems, colour: styleText(text, run.words[0] !== 'hook') }));
  const dump = `${JSON.stringify(captured, null, 2)}\n`;
  try {
    assert.deepEqual(machinePathsIn(dump), [], 'the capture shows no path on this machine: the owner shares it (no-internal-path, #1115)');
    const broken: string[] = [];
    const healed: string[] = [];
    for (const { run, text, problems } of checked) {
      if (run.key === 'init, a DeepSeek Harness profile') assert.match(text, /note {8}DeepSeek Harness/, `init shows the DeepSeek Harness note: ${text}`);
      if (run.place === 'zoned') assert.match(text, /Fix: `export TZ=UTC`/, `the commit check stops on the time zone: ${text}`);
      if (run.place === 'signed-out') assert.match(text, /\n- the pull requests and the Actions runs: gh is not signed in\n {2}Fix: `gh auth login`\n/, `the fake gh answered: ${text}`);
      if (run.key === 'install, bare') assert.match(text, /guard {7}on for /, `install set the sandbox home up: ${text}`);
      const isWaived = run.key in WAIVED;
      if (problems.length && !isWaived) broken.push(`${run.key} (yokoten ${run.words.join(' ')}): ${problems.join('; ')}`);
      if (!problems.length && isWaived) healed.push(`${run.key}: it keeps the limits now; take it off WAIVED`);
    }
    const keys = new Set(runs.map((run) => run.key));
    const stale = Object.keys(WAIVED).filter((key) => !keys.has(key)).map((key) => `${key}: no such screen; take it off WAIVED`);
    assert.equal(keys.size, runs.length, 'each screen has its own key');
    assert.deepEqual([...broken, ...healed, ...stale], [], 'build the screen with src/rules/text/screen.ts (record 0049)');
    assert.ok(Object.values(WAIVED).every((reason) => reason.includes('#1115')), 'each waiver names issue #1115');
    assert.ok(Object.keys(WAIVED).length <= WAIVED_MOST, `WAIVED holds ${Object.keys(WAIVED).length}; the most is ${WAIVED_MOST}, and it only goes down`);
  } finally {
    if (CAPTURE_FILE) writeFileSync(CAPTURE_FILE, dump);
  }
  console.log(`screens: ${runs.length} rendered, ${Object.keys(WAIVED).length} waived, ${Math.round(performance.now() - started)} ms`);
});

test('screens: desk --help is built from the help spec and keeps every limit (#1099)', () => {
  const desk = COMMANDS.find((command) => command.name === 'desk');
  assert.ok(desk && 'help' in desk, 'desk has a help spec');
  const lines = commandHelp(desk);
  assert.deepEqual(screenProblems({ text: lines.join('\n'), isHelp: true }), []);
  for (const heading of ['Examples:', 'Options:', 'The fence:']) assert.ok(lines.includes(heading), `desk --help has ${heading}`);
});

// ---- Every render in the suite (test/repo/invoke.ts, #1115) ----

test('every render: the key, what a person reads, and a waiver that covers only its rules (#1115)', () => {
  assert.equal(renderKey(['check', '--staged', '--all']), 'check --all --staged', 'flags sorted');
  assert.equal(renderKey(['desk', 'claude', 'work', '--name=one', '--', 'npm', '--help']), 'desk --name', 'a value and the words after -- are left out');
  assert.equal(renderKey([]), '(none)', 'the bare command');
  const done = { code: 0, stdout: '{"ok":true}\n', stderr: 'yokoten · refused\n', output: 'both\n' };
  assert.equal(readText(['doctor', '--json'], done), null, '--json is for a program');
  assert.equal(readText(['redact'], done), null, 'redact passes a stream through');
  assert.equal(readText(['bot', 'run', '--', 'gh', 'pr'], done), null, "bot -- prints the child's output");
  assert.equal(readText(['hook'], done), done.stderr, 'hook: only stderr, the person reads it');
  assert.equal(readText(['doctor'], done), done.output);
  const wide = { code: 1, stdout: '', stderr: '', output: `${'x'.repeat(101)}\n` };
  const rules = (problems: string[]) => problems.map((problem) => /\[([a-z-]+)\]$/.exec(problem)?.[1]);
  assert.deepEqual(rules(renderProblems(['demo'], wide, { waived: {} })), ['widest', 'next-step'], 'a failure with no next step, and a line too wide (one line may run past 80)');
  assert.deepEqual(rules(renderProblems(['demo'], wide, { waived: { demo: { rules: ['widest'], reason: '#1115' } } })), ['next-step'], 'a waiver covers only the rules it lists');
  assert.deepEqual(renderProblems(['demo', '--json'], wide, { waived: {} }), [], 'nobody reads --json');
  assert.deepEqual(renderProblems(['demo'], { ...wide, code: 0, output: '\u001b[1mok\u001b[0m\n' }, { isTTY: true, waived: {} }), [], 'colour on a terminal is what the person sees');
});

test('every render: RENDER_WAIVED holds old screens only, each naming #1115, and healedWaivers says what to take off (#1115)', () => {
  const keys = Object.keys(RENDER_WAIVED);
  assert.ok(keys.length <= RENDER_WAIVED_MOST, `RENDER_WAIVED holds ${keys.length}; the most is ${RENDER_WAIVED_MOST}, and it only goes down`);
  assert.deepEqual(keys.filter((key) => !RENDER_WAIVED[key]?.reason.includes('#1115')), [], 'each waiver names issue #1115');
  assert.deepEqual(keys.filter((key) => renderKey(key.split(' ')) !== key), [], 'each key is a render key: the command, then its flags sorted');
  const ids = new Set<string>(SCREEN_RULES.map((rule) => rule.id));
  assert.deepEqual(keys.filter((key) => !RENDER_WAIVED[key]?.rules.length || RENDER_WAIVED[key]?.rules.some((rule) => !ids.has(rule))), [], 'each waiver lists rules of SCREEN_RULES');
  // The positive control: a report where one key healed, one rule healed, and one is still needed.
  const waived = { 'a --x': { rules: ['width'], reason: '#1115' }, b: { rules: ['width', 'prose'], reason: '#1115' }, c: { rules: ['prose'], reason: '#1115' } } as const;
  const report = [
    { key: 'a --x', file: 'one.test.ts', checked: true, rules: [] },
    { key: 'b', file: 'one.test.ts', checked: true, rules: ['prose'] },
    { key: 'b', file: 'two.test.ts', checked: true, rules: [] },
    { key: 'c', file: 'two.test.ts', checked: true, rules: ['prose'] },
    { key: 'c', file: 'one.test.ts', checked: true, rules: [] },
  ];
  assert.deepEqual(healedWaivers(report, waived), ['a --x: it keeps width now; take it off RENDER_WAIVED', 'b: it keeps width now; take that rule off its waiver'], 'a key that passes in one file and fails in another is still needed');
});

// ---- The screens' source (plan 6.5, #1115) ----
//
// Each ratchet counts one way a screen is built by hand in src/ (RATCHETS in screen-rules.ts).
// A count may only go down: above its ceiling the test fails, and below it the test asks for
// the ceiling to come down with it. The finish line is every ceiling at 0. The integrator
// owns the ceilings; a group reports what healed.

/** The most each ratchet may find. Only the integrator changes these, and only down. */
const RATCHET_CEILINGS: Record<Exclude<RatchetId, 'R4'>, number> = { R1: 78, R2: 15, R3: 124, R5: 24, R6: 8 };

/**
 * R4: the raw writes that stay, as `path: <the line, trimmed>`. A child's or a hook's own
 * bytes pass through as they are; anything a person reads goes through `show` or `fail`.
 */
const RAW_WRITES = [
  // The hook's JSON answer to the agent.
  'src/commands/hook.ts: invocation.stdout.write(answer.text());',
  'src/commands/hook.ts: else answerInvocation.stdout.write(rewritten);',
  // The desk child's own stderr, passed through.
  'src/commands/hook.ts: if (started.stderr) invocation.stderr.write(started.stderr);',
  'src/commands/desk/desk.ts: if (ran.stderr) invocation.stderr.write(ran.stderr);',
  // redact: the stream, as it comes in.
  'src/commands/more/check.ts: void redactStream(invocation.stdin.stream, pieces, (text) => stdout.write(text)).then((err) => {',
  // bot: the child's own output, passed through.
  'src/commands/more/merge/bot.ts: if (result.stdout) stdout.write(result.stdout);',
  'src/commands/more/merge/bot.ts: if (result.stderr) stderr.write(result.stderr);',
  'src/commands/more/merge/bot.ts: if (shown.stdout) stdout.write(shown.stdout);',
  'src/commands/more/merge/bot.ts: if (shown.stderr) stderr.write(shown.stderr);',
  // Not a kind of plan 6.5: the release notes, a Markdown document (C9 decides), and the
  // bridge's two failure lines, hand-made (C7 moves them to failure()). Take them off when they go.
  'src/commands/more/learn.ts: invocation.stdout.write(notes);',
  'src/agents/desk/network/bridge.ts: stderr.write(`yokoten desk: ${parsed}\\n`);',
  "src/agents/desk/network/bridge.ts: stderr.write(`yokoten desk: can't start ${file}: ${error.code ?? error.message}\\n`);",
];

const SRC_FILES: SourceFile[] = readdirSync(join(ROOT, 'src'), { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
  .map((entry) => join(entry.parentPath, entry.name))
  .sort()
  .map((path) => ({ path: relative(ROOT, path).split(sep).join('/'), source: readFileSync(path, 'utf8') }));
const FOUND = ratchetsOf(SRC_FILES);

test("the screens' source: the reader skips comments and imports, and keeps strings apart from code (#1115)", () => {
  const { code, strings } = readSource([
    "import { row } from './screen.ts';",
    "// print('yokoten desk: in a comment')",
    "const at = /it's '/.test(line); const half = total / 2 / 3;",
    "const line = `yokoten tidy: ${count > 0 ? 'a' : ''} left`; /* ' '.repeat(26) */",
  ].join('\n'));
  assert.equal(code.split('\n').length, 4, 'every line stays where it was');
  assert.deepEqual(strings.filter((text) => text.includes('yokoten')), ['yokoten tidy: '], 'a template string, not the comment, and not the import path');
  assert.ok(!code.includes('row') && !code.includes('print') && !code.includes('repeat'), 'imports and comments are gone');
  assert.ok(code.includes("/it's '/.test(line)") && code.includes('total / 2 / 3'), 'a regex with a quote, and a division');
  const control = ratchetsOf([
    { path: 'src/commands/demo.ts', source: "say(`yokoten demo: x`);\nconst pad = 'a'.padEnd(12) + ' '.repeat(26);\nconst lines = ['a', '', 'b'];\nlines.filter((line) => /^ok /.test(line));\nif (stdout.isTTY) stdout.write('x');" },
    { path: 'src/rules/text/screen.ts', source: "const blank = ['', 'a'];\nconst pad = 'a'.padEnd(12);" },
  ]);
  assert.deepEqual(Object.fromEntries(Object.entries(control).map(([id, places]) => [id, places.length])), { R1: 1, R2: 2, R3: 1, R4: 1, R5: 1, R6: 1 }, 'each ratchet catches its known-bad line, and src/rules/text/ is the layout');
});

for (const [id, ceiling] of Object.entries(RATCHET_CEILINGS) as [Exclude<RatchetId, 'R4'>, number][]) {
  test(`the screens' source: ${id}, ${RATCHETS[id]}, only goes down (#1115)`, () => {
    const found = FOUND[id].length;
    console.log(`ratchet ${id}: [${found}, ${ceiling}]`);
    const where = [...new Set(FOUND[id])].slice(0, 12).join(', ');
    assert.ok(found <= ceiling, `${id} finds ${found}, above its ceiling ${ceiling}: build the screen with src/rules/text/screen.ts. Found in: ${where}`);
    assert.ok(found >= ceiling, `${id} finds ${found}, below its ceiling ${ceiling}: lower the ceiling to ${found}`);
  });
}

test("the screens' source: R4, the raw writes, are exactly the allow-list (#1115)", () => {
  console.log(`ratchet R4: ${FOUND.R4.length} raw writes, ${RAW_WRITES.length} allowed`);
  const extra = FOUND.R4.filter((entry) => !RAW_WRITES.includes(entry));
  const gone = RAW_WRITES.filter((entry) => !FOUND.R4.includes(entry));
  assert.deepEqual(extra, [], 'print a screen with show() or fail() from src/commands/shared.ts, not a raw write');
  assert.deepEqual(gone.map((entry) => `${entry}: no such write now; take it off RAW_WRITES`), []);
});
