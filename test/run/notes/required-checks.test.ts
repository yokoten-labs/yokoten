// Tests for src/run/notes/required-checks.ts (#1376).

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { droppedChecks, unreportedChecks, workflowCheckNames } from '../../../src/run/notes/required-checks.ts';

const WORKFLOW = `name: CI
on: [pull_request]
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - run: npm test # name: not-a-job
  lint:
    name: "Lint: all"
    runs-on: ubuntu-latest
  tests:
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest]
        node:
          - 22
          - '24'
    runs-on: \${{ matrix.os }}
  build:
    name: build on \${{ matrix.os }}
    strategy:
      matrix:
        os: [linux, macos]
`;

test('required checks: plain names, the name key, and matrix names are read (#1376)', () => {
  const { names, prefixes } = workflowCheckNames(WORKFLOW);
  assert.deepEqual(names, ['ci', 'Lint: all', 'tests (ubuntu-latest, 22)', 'tests (ubuntu-latest, 24)', 'tests (windows-latest, 22)', 'tests (windows-latest, 24)', 'build on linux', 'build on macos']);
  assert.deepEqual(prefixes, []);
});

test('required checks: a name it cannot work out is a prefix, never a warning (#1376)', () => {
  const unsure = `jobs:
  call:
    uses: ./.github/workflows/reuse.yml
  dynamic:
    strategy:
      matrix: \${{ fromJSON(needs.plan.outputs.rows) }}
  included:
    name: pack \${{ inputs.kind }}
`;
  assert.deepEqual(workflowCheckNames(unsure), { names: [], prefixes: ['call / ', 'call (', 'dynamic (', 'pack '] });
  assert.deepEqual(unreportedChecks(['call / tests', 'dynamic (a)', 'pack zip'], [unsure]), []);
});

test('required checks: a required name no job reports is caught; a matching one is not (#1376)', () => {
  // Positive control: the renamed job no longer reports "test".
  assert.deepEqual(unreportedChecks(['ci', 'test', 'tests (ubuntu-latest, 22)'], [WORKFLOW]), ['test']);
  assert.deepEqual(unreportedChecks(['ci', 'Lint: all', 'tests (windows-latest, 24)'], [WORKFLOW]), []);
  assert.deepEqual(unreportedChecks(['ci'], []), ['ci'], 'no workflow reports nothing');
  assert.deepEqual(unreportedChecks(['ci'], ['not: [yaml']), ['ci'], 'text with no jobs reports nothing');
});

test('required checks: a pull request that renames a required job drops it (#1376)', () => {
  const renamed = WORKFLOW.replace('  ci:\n', '  build-and-test:\n');
  assert.deepEqual(droppedChecks(['ci', 'Lint: all'], [WORKFLOW], [renamed]), ['ci']);
  assert.deepEqual(droppedChecks(['ci', 'Lint: all'], [WORKFLOW], [WORKFLOW]), [], 'no change drops nothing');
  // A name no job reported before is doctor's to say, not the pull request's.
  assert.deepEqual(droppedChecks(['gone'], [WORKFLOW], [renamed]), []);
});

test('required checks: a quoted " #", a block scalar and a matrix caller give no false note (#1376)', () => {
  const tricky = `jobs:
  one:
    name: "Build #1" # the comment goes, the quoted text stays
  two:
    name: 'it''s #2'
  three:
    name: >-
      folded
  call:
    uses: ./.github/workflows/reuse.yml
    strategy:
      matrix:
        v: [a]
`;
  assert.deepEqual(workflowCheckNames(tricky), { names: ['Build #1', "it's #2"], prefixes: ['', 'call / ', 'call ('] });
  // Positive control: without the block scalar, an unknown name is still caught.
  assert.deepEqual(unreportedChecks(['Build #1', 'call (a) / tests', 'gone'], [tricky.replace(/ {2}three:[\s\S]*?(?= {2}call:)/, '')]), ['gone']);
});

test('required checks: a long unclosed expression in a name reads in linear time (#1376)', () => {
  const name = `\${{${' '.repeat(50_000)}x`;
  const started = performance.now();
  const checks = workflowCheckNames(`jobs:\n  slow:\n    name: ${name}\n    runs-on: ubuntu-latest\n`);
  assert.ok(performance.now() - started < 1000, 'no catastrophic backtracking');
  assert.deepEqual(checks, { names: [name], prefixes: [] });
  const quotes = workflowCheckNames(`jobs:\n  q:\n    name: x${"'".repeat(50_000)}\n`);
  assert.equal(quotes.names.length, 1);
});
