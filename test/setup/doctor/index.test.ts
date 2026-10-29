// Tests for src/setup/doctor/index.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { test } from 'node:test';
import { makeSandbox, rowsText } from '../../repo/helpers.ts';

test('doctor: a marks file it can not read is named as unreadable, not missing (#656)', async () => {
  const sandbox = makeSandbox();
  const config = join(sandbox.home, '.config', 'yokoten');
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, 'private-marks'), 'quietharbor\n');
  const folder = join(sandbox.home, 'marks-folder');
  mkdirSync(folder);
  const result = await sandbox.call(['doctor', '--all'], { extra: { YOKOTEN_PRIVATE_MARKS: folder } });
  // A row wraps at 80 columns; its lines read as one here.
  const out = result.stdout.replace(/\n {14}/g, ' ');
  assert.match(out, /private-marks: a private-marks file can't be read, so the privacy check stops every commit; make ~\/\.config\/yokoten\/private-marks readable/);
  assert.doesNotMatch(out, /is missing or has no marks/);
  assert.doesNotMatch(out, /quietharbor/i);
});

// The contract for outside readers (#1202): doctor.yokoten.app runs `doctor --all --json` and
// `check --json` on a public repo and shows the result as-is. Keys may be added; these keys,
// their types and the mark strings stay, or the page breaks.
const MARKS = ['done', 'to do', 'next', "can't check", 'not now'];

test('doctor: --all --json keeps the shape that other tools read (#1167, #1202, #1203)', async () => {
  const sandbox = makeSandbox();
  const result = await sandbox.call(['doctor', '--all', '--json']);
  assert.ok(result.status === 0 || result.status === 1, `exit ${result.status}`);
  const json = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(typeof json.version, 'string');
  assert.equal(typeof json.stage, 'number');
  const { steps, findings, next } = json as { steps: Record<string, unknown>[]; findings: Record<string, unknown>[]; next: Record<string, unknown> | null };
  assert.ok(next !== null, 'a fresh repo has a next step');
  for (const key of ['id', 'what', 'why', 'fix']) assert.equal(typeof next[key], 'string', `next.${key}`);
  assert.ok(Array.isArray(steps) && steps.length > 0);
  for (const step of steps) {
    for (const key of ['id', 'how', 'why']) assert.equal(typeof step[key], 'string', `${String(step.id)}.${key}`);
    assert.equal(typeof step.stage, 'number');
    assert.ok(MARKS.includes(step.mark as string), `${String(step.id)}: mark ${String(step.mark)}`);
  }
  for (const mark of ['done', 'next', 'to do']) assert.ok(steps.some((step) => step.mark === mark), `a fresh repo has a step marked ${mark}`);
  assert.equal(steps.filter((step) => step.mark === 'next').length, 1, 'one next step');
  assert.ok(Array.isArray(findings) && findings.length > 0);
  for (const found of findings) {
    for (const key of ['id', 'what', 'why', 'fix']) assert.equal(typeof found[key], 'string', `${String(found.id)}.${key}`);
    assert.ok(found.docs === undefined || typeof found.docs === 'string');
  }
});

test('check: --json keeps its shape and never prints the value it found (#1202)', async () => {
  const sandbox = makeSandbox();
  // Built from parts so this file holds no address of its own; example.org would be allowed.
  const secret = ['quiet.harbor.7731', 'harbormail.net'].join('@');
  sandbox.write('notes.md', `write to ${secret}\n`);
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'notes');
  const result = await sandbox.call(['check', '--json']);
  assert.ok(result.status === 0 || result.status === 1, `exit ${result.status}`);
  const json = JSON.parse(result.stdout) as { ok: unknown; findings: Record<string, unknown>[] };
  assert.equal(typeof json.ok, 'boolean');
  const found = json.findings.find((item) => item.file === 'notes.md');
  assert.ok(found, 'the planted address is found');
  for (const key of ['id', 'what', 'file', 'grade', 'why', 'fix']) assert.equal(typeof found[key], 'string', key);
  assert.equal(typeof found.line, 'number');
  assert.ok(!result.stdout.includes(secret) && !result.stdout.includes('quiet.harbor'), 'the value never reaches the JSON');
});

// A folder with a GitHub origin, but no gh on the PATH, no login and no network: doctor skips the server steps at once.
test("doctor: with no gh on the PATH, the server steps are can't check, and doctor answers fast (#1167)", async () => {
  const sandbox = makeSandbox();
  // A PATH of the folders that hold git and node. If gh lives in one of them, a folder of links to git and node alone.
  const named = (dir: string, names: string[]) => names.map((name) => join(dir, name)).find((path) => existsSync(path));
  const gitPath = (process.env.PATH ?? '').split(delimiter).map((dir) => named(dir, ['git', 'git.exe'])).find(Boolean) ?? 'git';
  let bin = [...new Set([dirname(process.execPath), dirname(gitPath)])].join(delimiter);
  if (bin.split(delimiter).some((dir) => named(dir, ['gh', 'gh.exe', 'gh.cmd']))) {
    const links = join(sandbox.home, 'bin');
    mkdirSync(links);
    symlinkSync(gitPath, join(links, 'git'));
    symlinkSync(process.execPath, join(links, 'node'));
    bin = links;
  }
  sandbox.git('remote', 'add', 'origin', 'https://github.com/someone/repo.git');
  const started = Date.now();
  const result = await sandbox.call(['doctor', '--all', '--json'], { extra: { PATH: bin } });
  const seconds = (Date.now() - started) / 1000;
  assert.ok(result.status === 0 || result.status === 1, `exit ${result.status}: ${result.stderr}`);
  assert.equal(result.stderr, '');
  const { steps } = JSON.parse(result.stdout) as { steps: { id: string; mark: string }[] };
  for (const id of ['protection', 'merge-settings', 'security-settings', 'tag-bypass', 'release-reviewer', 'release-tag-rule']) {
    assert.equal(steps.find((step) => step.id === id)?.mark, "can't check", id);
  }
  assert.match(rowsText((await sandbox.call(['doctor', '--all'], { extra: { PATH: bin } })).stdout), /gh is not installed/);
  // Measured at about 0.2 s in this process; the bound only catches a hang or a retry loop.
  assert.ok(seconds < 5, `took ${seconds} s`);
});
