// Tests for src/setup/advice/adopt.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  answer,
  FACTS,
  fixture,
  makeSandbox,
  makeTempDir,
} from '../../repo/helpers.ts';
import {
  draft,
  draftJson,
  type Fact,
  facts,
  parseAnswer,
  prompt,
  promptProblems,
  ruleDraft,
} from '../../../src/setup/advice/adopt.ts';
import { ROAD } from '../../../src/setup/road.ts';
import { adoptAllScreen, adoptScreen } from '../../../src/commands/more/advice/doctor.ts';
import { screenProblems } from '../../repo/docs/screen-rules.ts';

const statusOf = (rows: Fact[]) => Object.fromEntries(rows.map((r) => [r.key, r.status]));

const GOOD = [
  { key: 'rules', decision: 'as-is', reason: 'Already there.' },
  { key: 'ci', decision: 'lighter', reason: 'Keep the existing CI and add one step.' },
  { key: 'codeowners', decision: 'not-now', reason: 'One person; look again at the first outside contributor.' },
];

test('adopt: with no key, the rule-based draft and how to set the key; it changes no file (#6)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('CLAUDE.md', '# rules\n');
  sandbox.write('package.json', JSON.stringify({ scripts: { test: 'node --test' } }));
  const before = sandbox.git('status', '--porcelain', '--ignored').stdout;
  // The entry, through the real binary; the rest runs in this process.
  const r = sandbox.run(['adopt', '--all']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^yokoten adopt · the whole draft, \d+ rows\n/);
  assert.match(r.stdout, /^Add a lighter form:\n {2}rules +partial: no AGENTS\.md, but CLAUDE\.md\./m, 'a partial step is drafted lighter');
  assert.match(r.stdout.replace(/\n/g, ' '), /set MODEL_API_KEY \(or LLAMA_API_KEY\)/);
  assert.match(r.stdout, /You decide every row/);
  const json = await sandbox.call(['adopt', '--json']);
  const rows = JSON.parse(json.stdout) as { key: string; decision: string }[];
  // Plan D1: --json prints the draft the screens are built from, in the shape it always had.
  const drafted = await draft(facts(sandbox.repo, sandbox.env), { env: sandbox.env });
  const shape = drafted.rows.map(({ key, status, evidence, decision, reason }) => ({ key, status, evidence, decision, reason }));
  assert.deepEqual(rows, shape, 'the old output, row for row');
  assert.deepEqual(draftJson(drafted), shape);
  assert.ok(rows.every((row) => Object.keys(row).join() === 'key,status,evidence,decision,reason'), 'the same fields, in the same order');
  assert.equal(rows.find((row) => row.key === 'tests')?.decision, 'as-is');
  assert.match(json.stderr, /^note: Drafted by rules, because no model key/, "a note on stderr says who drafted it");
  assert.equal(sandbox.git('status', '--porcelain', '--ignored').stdout, before, 'adopt writes nothing');
});

test('adopt facts: an empty repo has every project step missing, and no evidence names a path outside it', () => {
  const dir = fixture({});
  const rows = facts(dir, { HOME: dir });
  assert.deepEqual(rows.map((r) => r.key), ROAD.map((s) => s.key), 'a row for every step on the road, in its order');
  assert.equal(statusOf(rows)['no-build-output'], 'done', 'a step with no reading of its own gets a row from its own check');
  assert.match(rows.find((r) => r.key === 'protection')?.evidence ?? '', /can't check/, 'a server step is not read here');
  // A setting yokoten can't read is unknown, never missing: the draft must not tell the user to turn on what may be on.
  for (const key of ['protection', 'merge-settings', 'security-settings']) assert.equal(statusOf(rows)[key], 'unknown', key);
  assert.match(ruleDraft(rows).find((r) => r.key === 'protection')?.reason ?? '', /yokoten doctor/, 'the rule draft says to check it with doctor');
  const s = statusOf(rows);
  for (const key of ['rules', 'tool-hook', 'commit-check', 'runtime', 'tests', 'ci', 'templates', 'changelog', 'titles', 'codeowners', 'bot', 'security-files']) assert.equal(s[key], 'missing', key);
  assert.equal(s.issues, 'done', 'no todo file');
  for (const r of rows) assert.ok(!r.evidence.includes(dir) && r.evidence.length < 160, r.key);
});

test("adopt facts: the project's own way counts as partial, the road's checks as done", () => {
  const dir = fixture({
    'CLAUDE.md': '# rules\n',
    '.husky/pre-commit': 'npm test\n',
    '.github/workflows/test.yml': 'on: push\n',
    '.github/pull_request_template.md': '## Why\n',
    'CHANGELOG.md': '# Changelog\n\n## 1.0.0\n',
    'commitlint.config.js': 'export default {};\n',
    LICENSE: 'MIT\n',
    'package.json': JSON.stringify({ scripts: { test: 'node --test' } }),
    'TODO.md': '- a thing\n',
    '.github/CODEOWNERS': '* @someone\n',
  });
  const rows = facts(dir, { HOME: dir });
  const s = statusOf(rows);
  assert.deepEqual(
    { rules: s.rules, hook: s['commit-check'], ci: s.ci, templates: s.templates, changelog: s.changelog, titles: s.titles, security: s['security-files'], tests: s.tests, issues: s.issues, owners: s.codeowners },
    { rules: 'partial', hook: 'partial', ci: 'partial', templates: 'partial', changelog: 'partial', titles: 'partial', security: 'partial', tests: 'done', issues: 'missing', owners: 'done' },
  );
  const ev = Object.fromEntries(rows.map((r) => [r.key, r.evidence]));
  assert.match(ev.rules, /CLAUDE\.md/);
  assert.match(ev['commit-check'], /husky/);
  assert.match(ev.ci, /1 workflow/);
  assert.match(ev.issues, /TODO\.md/);
  // npm init's placeholder is not a test command.
  assert.equal(statusOf(facts(fixture({ 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) }), {})).tests, 'missing');
});

test('adopt answer: a valid answer becomes rows in the facts order, with a code fence allowed', () => {
  const parsed = parseAnswer(answer([...GOOD].reverse()), FACTS);
  assert.ok('rows' in parsed);
  assert.deepEqual(parsed.rows.map((r) => [r.key, r.decision, r.status]), [['rules', 'as-is', 'done'], ['ci', 'lighter', 'partial'], ['codeowners', 'not-now', 'missing']]);
  assert.ok('rows' in parseAnswer(`\`\`\`json\n${answer(GOOD)}\n\`\`\``, FACTS));
});

test('adopt answer: anything off is not valid, and a partial answer is not valid', () => {
  const bad: [string, RegExp][] = [
    ['here you go', /not JSON/],
    ['[]', /no "rows"/],
    [JSON.stringify({ rows: GOOD, extra: 1 }), /other than/],
    [answer(GOOD.slice(0, 2)), /no decision for codeowners/],
    [answer([...GOOD, GOOD[0]]), /twice/],
    [answer([...GOOD, { key: 'deploy', decision: 'as-is', reason: 'x' }]), /unknown key/],
    [answer([{ ...GOOD[0], decision: 'skip' }, ...GOOD.slice(1)]), /unknown decision/],
    [answer([{ ...GOOD[0], reason: '' }, ...GOOD.slice(1)]), /reason/],
    [answer([{ ...GOOD[0], reason: 'one\ntwo' }, ...GOOD.slice(1)]), /reason/],
    [answer([{ ...GOOD[0], note: 'x' }, ...GOOD.slice(1)]), /unknown fields/],
  ];
  for (const [content, error] of bad) {
    const parsed = parseAnswer(content, FACTS);
    assert.ok('error' in parsed && error.test(parsed.error), `${content.slice(0, 40)}: ${JSON.stringify(parsed)}`);
  }
});

test('adopt draft: no key, a failed call or a bad answer fall back to the rules, and say why', async () => {
  const rules = ruleDraft(FACTS).map((r) => r.decision);
  assert.deepEqual(rules, ['as-is', 'lighter', 'as-is']);
  let calls = 0;
  const noKey = await draft(FACTS, { env: {}, send: async () => (calls++, answer(GOOD)) });
  assert.equal(calls, 0, 'no key, no call');
  assert.equal(noKey.by, 'rules');
  assert.match(noKey.note ?? '', /LLAMA_API_KEY/);
  const env = { LLAMA_API_KEY: 'test-key', HOME: '/nowhere' };
  const failed = await draft(FACTS, { env, send: async () => Promise.reject(new Error('the model endpoint answered HTTP 500')) });
  assert.deepEqual([failed.by, failed.rows.map((r) => r.decision)], ['rules', rules]);
  assert.match(failed.note ?? '', /HTTP 500/);
  const invalid = await draft(FACTS, { env, send: async () => 'not json' });
  assert.match(invalid.note ?? '', /not valid/);
  const good = await draft(FACTS, { env, send: async () => answer(GOOD) });
  assert.equal(good.by, 'the model (muse-spark-1.3)');
  assert.deepEqual(good.rows.map((r) => r.decision), ['as-is', 'lighter', 'not-now']);
  const out = adoptAllScreen(good).join('\n');
  assert.match(out, /^yokoten adopt · the whole draft, 3 rows\n/);
  assert.match(out, /^Keep as it is:\n {2}rules /m, 'each decision under its heading');
  assert.match(out, /You decide every row/);
  assert.deepEqual(screenProblems({ text: out }), [], 'the whole draft keeps the screen rules');
  for (const d of [noKey, failed, invalid, good]) assert.ok(!JSON.stringify(d).includes('test-key') && !adoptAllScreen(d).join('\n').includes('test-key'), 'the key is never in the output');
});

test('adopt draft: facts with an email, a secret, a private mark or a home path are never sent', async () => {
  const dir = makeTempDir('yokoten-marks-');
  writeFileSync(join(dir, 'marks'), 'secret-city\n');
  const cases = [`write to someone${'@'}personal-mail.com`, `ghp_${'a'.repeat(36)}`, 'from Secret-City', '/home/someone/project', 'C:\\Users\\someone'];
  for (const evidence of cases) {
    let sent = false;
    const d = await draft([{ ...FACTS[0], evidence }], { env: { LLAMA_API_KEY: 'test-key', HOME: '/nowhere', YOKOTEN_PRIVATE_MARKS: join(dir, 'marks') }, send: async () => ((sent = true), answer(GOOD)) });
    assert.equal(sent, false, evidence);
    assert.match(d.note ?? '', /nothing was sent/);
    assert.ok(!(d.note ?? '').includes(evidence), 'the finding is never printed');
  }
  assert.deepEqual(promptProblems(prompt(FACTS), { HOME: '/nowhere' }), [], 'clean facts may go');
});

test('adopt draft: a real value from a secret-looking environment variable is never sent (#616)', () => {
  const value = ['env', 'Secret', 'Value', '1234567890'].join('');
  const found = promptProblems([{ role: 'user', content: `key ${value}` }], { HOME: '/nowhere', SERVICE_TOKEN: value });
  assert.equal(found.length, 1);
  assert.match(found[0], /a secret \(environment value\)/);
  assert.ok(!found.join().includes(value), 'the value is never printed');
});

test('promptProblems: a marks file that can not be read stops the prompt, never an empty list (#656)', () => {
  const home = makeTempDir('yokoten-');
  // A folder where the setting names a file: reading it fails (EISDIR).
  const folder = join(home, 'marks-folder');
  mkdirSync(folder);
  const problems = promptProblems(prompt(FACTS), { HOME: home, YOKOTEN_PRIVATE_MARKS: folder });
  assert.ok(problems.some((line) => /private-marks file can't be read/.test(line)), 'refused');
  assert.deepEqual(promptProblems(prompt(FACTS), { HOME: home }), [], 'readable: clean facts may go');
});

// #1027: the default adopt is one screen, grouped by what to do with each row.
test('adopt: the default screen groups the rows as keep, add and decide (#1027)', () => {
  const drafted = {
    by: 'rules',
    note: 'no model key; set MODEL_API_KEY',
    rows: [
      { key: 'rules', status: 'partial' as const, evidence: 'your CI, your PR template', why: '', decision: 'as-is' as const, reason: '' },
      { key: 'tests', status: 'missing' as const, evidence: 'AGENTS.md, the commit check', why: '', decision: 'lighter' as const, reason: '' },
      { key: 'codeowners', status: 'unknown' as const, evidence: 'your CODEOWNERS differs from the road', why: '', decision: 'not-now' as const, reason: '' },
    ],
  };
  const lines = adoptScreen(drafted);
  assert.equal(lines[0], 'yokoten adopt · a draft for this project');
  assert.ok(lines.some((line) => /^  ok\s+keep\s+your CI, your PR template$/.test(line)), 'a keep row');
  assert.ok(lines.some((line) => /^  next\s+add\s+AGENTS\.md, the commit check$/.test(line)), 'an add row');
  assert.ok(lines.some((line) => /^  can't check\s+decide\s+your CODEOWNERS/.test(line)), 'a decide row');
  assert.ok(lines.some((line) => line.startsWith('  note') && line.includes('MODEL_API_KEY')), 'why the rules drafted it');
  assert.equal(lines.at(-1), 'More: `yokoten adopt --json` shows every row with its reason');
  for (const line of lines) assert.ok(line.length <= 80, `over 80: ${line}`);
});
