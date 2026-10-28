// Tests for src/setup/advice/explain.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeSandbox } from '../../repo/helpers.ts';
import { RULES } from '../../../src/rules/text/message.ts';
import {
  explain,
  ids,
} from '../../../src/setup/advice/explain.ts';

test('explain with no id lists the ids on stdout and exits 0; --json gives { ids } (#247)', async () => {
  const sandbox = makeSandbox();
  // The entry, through the real binary; the rest runs in this process.
  let result: Pick<ReturnType<typeof sandbox.run>, 'status' | 'stdout' | 'stderr'> = sandbox.run(['explain']);
  assert.deepEqual([result.status, result.stderr], [0, '']);
  assert.match(result.stdout, /^yokoten explain · \d+ rules and \d+ steps\n/);
  assert.match(result.stdout, /\brelease\b/);
  assert.match(result.stdout, /\bsecret\b/);
  for (const line of result.stdout.split('\n')) assert.ok(line.length <= 80, line);
  result = await sandbox.call(['explain', '--json']);
  assert.deepEqual([result.status, result.stderr], [0, '']);
  const listed = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(listed), ['ids']);
  assert.ok(listed.ids.includes('release') && listed.ids.includes('secret'));
  // An unknown id is still an error.
  result = await sandbox.call(['explain', 'nope']);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, 'yokoten explain · no rule or step is called nope\n\nNext: `yokoten explain`\n', 'one failure, and the command that lists the ids');
});

test('explain: each rule and step, its reason and its check; ids are unique (#42)', () => {
  const all = ids();
  assert.equal(new Set(all).size, all.length, 'a rule and a step share an id');
  assert.ok(Object.keys(RULES).length >= 20);
  for (const id of all) {
    const e = explain(id);
    assert.ok(e && e.what && e.why && e.check, id);
    assert.ok(![e.what, e.why, e.check].some((t) => /[.]$/.test(t)), `${id}: no full stop at the end`);
  }
  assert.equal(explain('nope'), null);
  assert.equal(explain('toString'), null, 'only own keys');
});

test('explain <id> is one screen: the stage, the four labels and a link (#1027)', async () => {
  const sandbox = makeSandbox();
  const result = await sandbox.call(['explain', 'tests']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^yokoten explain tests · stage 1, safety net\n/);
  assert.match(result.stdout, /^  What {8}run your tests on every push$/m);
  assert.match(result.stdout, /^  Why {9}/m);
  assert.match(result.stdout, /^  Check {7}/m);
  assert.match(result.stdout, /^  Fix {9}/m);
  assert.match(result.stdout, /^More: https:\/\//m);
  for (const line of result.stdout.split('\n')) assert.ok(line.length <= 80, line);
});

test('explain tests shows the job it asks for on several lines, and ends with the next step (#1145)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('package.json', JSON.stringify({ scripts: { test: 'node --test' } }));
  sandbox.write('package-lock.json', '{}');
  sandbox.write('.github/workflows/yokoten.yml', `on: push\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@${'a'.repeat(40)} # v1\n  ci:\n    needs: [check]\n    runs-on: ubuntu-latest\n    steps:\n      - run: 'true'\n`);
  const result = await sandbox.call(['explain', 'tests']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^ {18}runs-on: ubuntu-latest$/m, 'the job is shown, not only named');
  assert.match(result.stdout, /^ {18}steps: \[\{uses: <your checkout step>\},$/m);
  assert.match(result.stdout, /\nNext: `yokoten doctor`\nMore: https:\/\//, 'the screen ends with the next step');
  assert.ok(result.stdout.split('\n').length <= 25, 'one screen');
  for (const line of result.stdout.split('\n')) assert.ok(line.length <= 80 || line.startsWith('More:'), line);
});

test('explain <rule> ends with a Next line (#1145)', async () => {
  const result = await makeSandbox().call(['explain', 'secret']);
  assert.match(result.stdout, /\nNext: `yokoten check`\nMore: https:\/\//);
});
