// Tests for src/commands/more/setup/start.ts.

import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { previewLines, startScreen } from '../../../../src/commands/more/setup/start.ts';
import { VERSION } from '../../../../src/setup/files.ts';
import { makeSandbox } from '../../../repo/helpers.ts';

test('start: bare yokoten installs, adds the rules, then shows the road (#548)', async () => {
  const sandbox = makeSandbox();
  const first = await sandbox.call([]);
  // One screen (#1027): the title says it set up and the stage, one row per step, one Next line, then More.
  assert.match(first.stdout, new RegExp(`^yokoten ${VERSION.replaceAll('.', '\\.')} · set up; stage 1 of 5, safety net$`, 'm'));
  assert.match(first.stdout, /^ {2}ok {10}guard on for .+ on this computer$/m);
  assert.match(first.stdout, /^ {2}ok {10}\d+ files written in this project, none of yours changed$/m);
  assert.equal(first.stdout.match(/^Next: /gm)?.length, 1, 'one Next line');
  assert.match(first.stdout, /^Next: `git add -A && git commit -m "chore: add yokoten"`\nMore: /m);
  assert.ok(first.stdout.split('\n').every((line) => line.length <= 80), 'every line fits 80 columns');
  assert.ok(existsSync(join(sandbox.repo, 'AGENTS.md')), 'the rules are in the project');
  assert.ok(existsSync(join(sandbox.repo, 'yokoten.json')), 'init wrote yokoten.json');
  assert.ok(existsSync(join(sandbox.home, '.local', 'share', 'yokoten', 'bin', 'yokoten.mjs')), 'install wrote the runtime');
  // The second run does only what is left: the road and nothing to install or add.
  const again = await sandbox.call([]);
  assert.doesNotMatch(again.stdout, /this computer is set up/);
  assert.doesNotMatch(again.stdout, /this project is set up/);
  assert.match(again.stdout, /^yokoten doctor · stage 1 of 5, safety net$/m);
  assert.doesNotMatch(again.stdout, /^Next: `git add -A/, 'nothing new to commit');
});

test('start: a shell that is not UTC ends doctor\'s full report on the line for that shell (#932)', async () => {
  const sandbox = makeSandbox();
  const result = await sandbox.call(['doctor', '--all'], { extra: { TZ: 'America/New_York', SHELL: '/bin/zsh' } });
  const last = result.stdout.trimEnd().split('\n').at(-1) ?? '';
  assert.match(last, /^yokoten: your shell's time zone is not UTC, so each commit would carry it\./);
  assert.match(last, /`export TZ=UTC`/);
  assert.match(last, /~\/\.zshrc/);
  assert.equal(result.stdout.match(/time zone is not UTC/g)?.length, 1, 'said once');
});

test('start: outside a git repo it writes nothing and names git first (#548)', async () => {
  const sandbox = makeSandbox();
  const outside = join(sandbox.home, 'outside');
  mkdirSync(outside);
  // The test's temp folder sits inside a checkout here, so git is told to stop walking at it.
  const result = await sandbox.call([], { cwd: outside, extra: { GIT_CEILING_DIRECTORIES: dirname(outside) } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /this folder is not in a git repo/);
  assert.match(result.stderr, /git init/);
  assert.deepEqual(existsSync(join(outside, 'AGENTS.md')), false);
});

test('start: with no full home path it says so plainly and writes nothing (#548)', async () => {
  const sandbox = makeSandbox();
  // A relative HOME is the case install already answers with a normal failure: bare `yokoten` must too.
  const result = await sandbox.call([], { extra: { HOME: 'relative-home' } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^yokoten finds no home folder \(HOME is empty or not a full path\), so it has no place outside the repo\. Set HOME to your home folder's full path and run `yokoten` again\.$/m);
  assert.doesNotMatch(result.stderr, /undefined/, 'no command has no name, never "undefined"');
  assert.deepEqual([existsSync(join(sandbox.repo, 'AGENTS.md')), existsSync(join(sandbox.repo, 'yokoten.json'))], [false, false], 'nothing was written');
});

test('start: help still prints the command list (#548)', async () => {
  const sandbox = makeSandbox();
  const result = await sandbox.call(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: yokoten <command> \[options\]/);
  assert.match(result.stdout, /Start here: run `yokoten` in your project/);
});

test('install: the preview says what changes and how to undo it (#1027)', async () => {
  const sandbox = makeSandbox();
  const lines = previewLines(sandbox.env, true, true);
  assert.match(lines.join('\n'), /^yokoten \d+\.\d+\.\d+ · first run: here is what changes$/m);
  assert.match(lines.join('\n'), /^ {2}computer +guard on for Claude Code, 7 skills$/m);
  assert.match(lines.join('\n'), /^ {2}project +AGENTS\.md, the commit check, CI and the templates$/m);
  assert.match(lines.join('\n'), /^Undo: `yokoten uninstall`$/m);
  for (const line of lines) assert.ok(line.length <= 80, line);
});

// Issue #1115: one blank line between blocks, decided from the blocks, not from a line's place.
test('start: one blank line between the title, this run, the problems and the road (#1115)', () => {
  const done = ['  ok          guard on for Claude Code on this computer'];
  const problem = ['  MISSING     no runtime installed', '              Fix: `yokoten install`'];
  const road = ['  done        0 of 5 steps', '  next        add the rules'];
  const doctor = (...blocks: string[][]) => blocks.flatMap((block, at) => (at ? ['', ...block] : block));
  const text = (lines: string[]) => lines.join('\n');
  const bar = `yokoten ${VERSION} · set up; stage 1 of 5, safety net`;
  const title = 'yokoten doctor · stage 1 of 5, safety net';
  // Problems first: a blank line between this run's rows and them, and one before the road.
  assert.equal(text(startScreen(doctor([title], problem, road, ['Next: `x`'], ['More: y']), done)), text([bar, '', ...done, '', ...problem, '', ...road, '', 'Next: `git add -A && git commit -m "chore: add yokoten"`', 'More: y']));
  // A broken self-test line leads the title: it stays first, and the problems still get their blank line.
  const broken = '  MISSING     the self-test failed';
  const led = startScreen(doctor([broken], [title], problem, road, ['More: y']), done);
  assert.deepEqual(led.slice(0, 3), [broken, '', bar]);
  assert.equal(led[led.indexOf(done[0] ?? '') + 1], '', 'a blank line between this run and the problems');
  assert.equal(led.filter((line, at) => line === '' && led[at - 1] === '').length, 0, 'never two blank lines');
  // A screen with no steps: only problems follow this run, still one blank line.
  const bare = startScreen(doctor([title], problem, ['More: y']), done);
  assert.deepEqual(bare.slice(0, 5), [bar, '', ...done, '', problem[0]]);
  // Nothing after the title: no stray blank line.
  assert.deepEqual(startScreen(doctor([title], ['More: y']), done).slice(0, 3), [bar, '', done[0]]);
});
