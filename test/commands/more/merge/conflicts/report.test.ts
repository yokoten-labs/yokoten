// Tests for src/commands/more/merge/conflicts/report.ts (#909): the summary a beginner reads,
// in the words the issue asks for.

import '../../../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { firstOf, movers, pathsText, rebuildRefusal, rebuildScreen, refusalScreen, summaryLines } from '../../../../../src/commands/more/merge/conflicts/report.ts';
import { rebuildPrompt } from '../../../../../src/commands/more/merge/conflicts/rebuild.ts';
import { screenProblems } from '../../../../repo/docs/screen-rules.ts';
import type { Change, Collision, ConflictMap } from '../../../../../src/commands/more/merge/conflicts/types.ts';

/** One change, by hand: the summary is words, so it needs no repo. */
function change(id: string, label: string, files: string[], moves: string[] = [], options: { draft?: boolean; main?: string[] } = {}): Change {
  return {
    id,
    label,
    branch: id,
    head: '0'.repeat(8),
    draft: options.draft ?? false,
    files,
    moves,
    mainConflicts: options.main ?? [],
  };
}

/** A map of the changes given, in the order given. */
function mapOf(changes: Change[], collisions: Collision[] = [], hot: string[] = []): ConflictMap {
  return { version: 1, builtAt: new Date(0).toISOString(), main: '0'.repeat(8), changes, collisions, leased: {}, hot };
}

/** The example the issue gives: two pull requests on one file, and one that moves a file three touch. */
function issueExample(): ConflictMap {
  return mapOf(
    [
      change('pr:12', 'PR #12', ['src/app.ts', 'src/old.ts'], [], { main: ['src/app.ts'] }),
      change('pr:15', 'PR #15', ['src/app.ts', 'src/old.ts'], [], { main: ['src/app.ts'] }),
      change('pr:20', 'PR #20', ['src/new.ts'], ['src/old.ts']),
      change('pr:25', 'PR #25', ['src/old.ts']),
    ],
    [{ first: 'pr:12', second: 'pr:15', files: ['src/app.ts'] }],
  );
}

test('the summary puts the next pick first, then one block of pairs and one of the rest, spaced when a row wraps (#1115)', () => {
  assert.deepEqual(summaryLines(issueExample()), [
    'yokoten conflicts · 4 open changes, 2 collide',
    '',
    '  next        PR #12 ⇄ PR #15',
    '              src/app.ts. Merge PR #12 first: it conflicts with main in 1 file',
    '              now, so it needs a rebuild before it can merge.',
    '',
    '  note        PR #12 collides with main: src/app.ts',
    '',
    '  note        PR #15 collides with main: src/app.ts',
    '',
    '  ok          2 changes touch no shared file',
    '',
    '  note        PR #20 moves 1 file that 3 other changes touch; merge it in alone,',
    '              before them',
    '',
    'Next: `yokoten train --next`',
  ]);
  // One screen: no line passes 80 columns (issue #1027).
  for (const line of summaryLines(issueExample())) assert.ok(line.length <= 80, `over 80: ${line}`);
});


test('a map with nothing to say is one short line', () => {
  const quiet = mapOf([change('pr:12', 'PR #12', ['src/app.ts']), change('pr:15', 'PR #15', ['src/b.ts'])]);
  assert.deepEqual(summaryLines(quiet), [
    'yokoten conflicts · 2 open changes, none collide',
    '',
    '  ok          2 changes touch no shared file',
    '',
    'Next: `yokoten train --next`',
  ]);
  assert.deepEqual(summaryLines(mapOf([])), [
    'yokoten conflicts · no open change to compare with main',
    '',
    '  to do       push a branch or open a pull request, then run `yokoten conflicts`',
    '              again',
  ]);
});

test('the pair order is the smaller change first, then the smaller number', () => {
  const small = change('pr:15', 'PR #15', ['src/app.ts']);
  const big = change('pr:12', 'PR #12', ['src/app.ts', 'src/b.ts', 'src/c.ts']);
  assert.equal(firstOf(small, big), small);
  assert.equal(firstOf(big, small), small);
  const same = change('pr:9', 'PR #9', ['src/app.ts']);
  assert.equal(firstOf(same, small), same);
});

test('a draft is listed but not ordered, and a hot path is named', () => {
  const draft = change('pr:18', 'PR #18', ['src/app.ts'], [], { draft: true, main: ['src/app.ts'] });
  const one = change('pr:12', 'PR #12', ['src/app.ts', 'src/b.ts']);
  const lines = summaryLines(mapOf([draft, one], [], ['src/app.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts']));
  assert.deepEqual(lines, [
    'yokoten conflicts · 2 open changes, 1 collide',
    '',
    '  note        PR #18 collides with main: src/app.ts',
    '  ok          1 change touches no shared file',
    '  note        4 files are hot: src/app.ts, src/b.ts, src/c.ts, and 1 more',
    '  note        PR #18 is a draft, so it is listed here, but not ordered',
    '',
    'Next: `yokoten train --next`',
  ]);
});

test('a long map stays short on a line', () => {
  assert.equal(pathsText(['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']), 'a.ts, b.ts, c.ts, and 2 more');
  assert.equal(pathsText(['a.ts']), 'a.ts');
  const changes = Array.from({ length: 9 }, (_, index) => change(`pr:${index + 1}`, `PR #${index + 1}`, [`src/${index}.ts`]));
  const collisions: Collision[] = changes.slice(1).map((held) => ({ first: 'pr:1', second: held.id, files: ['src/app.ts'] }));
  const lines = summaryLines(mapOf(changes, collisions));
  assert.equal(lines[0], 'yokoten conflicts · 9 open changes, 9 collide');
  assert.equal(lines.filter((line) => line.includes("⇄")).length, 8);
  assert.ok(lines.some((line) => line.includes('src/app.ts. Merge')), lines.join('\n'));
});

test('the map notes join the drafts in the last block', () => {
  const draft = change('pr:18', 'PR #18', ['src/app.ts'], [], { draft: true, main: ['src/app.ts'] });
  const lines = summaryLines(mapOf([draft]), ['1 open change is not in this clone, so the map leaves it out']);
  assert.deepEqual(lines.slice(-4), [
    '  note        PR #18 is a draft, so it is listed here, but not ordered',
    '  note        1 open change is not in this clone, so the map leaves it out',
    '',
    'Next: `yokoten train --next`',
  ]);
});

test('a change that moves a shared file is named once, with how many others touch it', () => {
  const rows = movers(issueExample());
  assert.deepEqual(rows.map((row) => [row.change.label, row.others.length]), [['PR #20', 3]]);
  assert.deepEqual(movers(mapOf([change('pr:20', 'PR #20', ['src/new.ts'], ['src/old.ts'])])), []);
});

test('every screen of conflicts keeps the screen rules: the summary, the rebuild prompt and a refusal (#1115)', () => {
  const failed = (lines: string[]) => screenProblems({ text: lines.join('\n'), isFailure: true });
  assert.deepEqual(screenProblems({ text: summaryLines(issueExample()).join('\n') }), []);
  const map = mapOf([{ ...change('pr:12', 'PR #12', ['src/app.ts'], [], { main: ['src/app.ts'] }), branch: 'topic', head: 'abcdef0123' }]);
  const prompt = rebuildPrompt(map, 'pr:12');
  const shown = rebuildScreen(map.changes[0], prompt);
  assert.equal(shown[0], 'yokoten conflicts · a rebuild prompt for PR #12; paste it into your AI');
  assert.deepEqual(shown.filter(Boolean).slice(-prompt.split('\n').filter(Boolean).length), prompt.split('\n').filter(Boolean), 'every line of the prompt is shown as it is, so it pastes whole');
  assert.ok(shown.includes(`   git push --force-with-lease=topic:abcdef0123 origin topic`), 'a git command is never wrapped');
  assert.deepEqual(screenProblems({ text: shown.join('\n') }), []);
  const refusal = refusalScreen({ what: 'the conflict map has no open change pr:9', next: 'run `yokoten conflicts` to see the 4 changes it holds' });
  assert.deepEqual(refusal, ['yokoten conflicts · the conflict map has no open change pr:9', '', 'Next: Run `yokoten conflicts` to see the 4 changes it holds.']);
  assert.deepEqual(failed(refusal), []);
});

test("a rebuild that can't be written says what, why and the fix as one screen (#1115)", () => {
  const refusal = rebuildRefusal('What: the branch name "a;b" cannot be pushed\nWhy: the prompt puts it into shell commands\nFix: rename the branch, or rebuild this change by hand');
  assert.deepEqual(refusal, { what: 'the branch name "a;b" cannot be pushed', why: 'the prompt puts it into shell commands', next: 'rename the branch, or rebuild this change by hand' });
  const lines = refusalScreen(refusal);
  assert.deepEqual(lines, ['yokoten conflicts · the branch name "a;b" cannot be pushed', '', 'The prompt puts it into shell commands.', '', 'Next: Rename the branch, or rebuild this change by hand.']);
  assert.deepEqual(screenProblems({ text: lines.join('\n'), isFailure: true }), []);
  assert.equal(rebuildRefusal('something broke\nat line 2').what, 'something broke', 'any other error is its first line');
});
