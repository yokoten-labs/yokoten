// Tests for src/rules/guards/commands/commit-privacy.ts.

import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkCommand } from '../../../../src/rules/guards/index.ts';
import { makeSandbox } from '../../../../test/repo/helpers.ts';

test('commit: a secret is stopped with no yokoten.json, staged and with -a (#824)', () => {
  // No yokoten.json: there is no pre-commit hook here, so only the tool-call guard sees it.
  const sandbox = makeSandbox();
  // The key is built from pieces, so this file holds no secret of its own.
  const key = `ghp_${'a1B2c3D4e5'.repeat(4).slice(0, 36)}`;
  sandbox.write('README.md', 'hello\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'start');
  const run = (command: string) => checkCommand(command, { env: sandbox.env, cwd: sandbox.repo });
  assert.equal(run('git commit -m x'), null, 'nothing staged yet');
  // Staged: what `git commit` takes. The kind and the place are named, never the key.
  sandbox.write('config.ts', `// settings\nexport const token = '${key}';\n`);
  sandbox.git('add', 'config.ts');
  const found = run('git commit -m x');
  assert.equal(found?.id, 'secret');
  assert.equal(found?.file, 'config.ts');
  assert.equal(found?.line, 2);
  assert.ok(!JSON.stringify(found).includes(key), 'the secret is never in the finding');
  assert.match(found?.fix ?? '', /\.gitignore/, 'the safe road: an ignored file');
  assert.equal(run('git commit -m x README.md'), null, 'a pathspec commits only what it names');
  // A tracked change that is not staged: only -a takes it.
  sandbox.git('restore', '--staged', 'config.ts');
  sandbox.write('src/a.ts', 'export const a = 1;\n');
  sandbox.git('add', 'src/a.ts');
  sandbox.git('commit', '-qm', 'add a');
  sandbox.write('src/a.ts', `export const token = '${key}';\n`);
  assert.equal(run('git commit -m x'), null);
  for (const command of ['git commit -am x', 'git commit -a -m x', 'git commit --all -m x']) {
    const hit = run(command);
    assert.equal(hit?.id, 'secret', command);
    assert.equal(hit?.file, 'src/a.ts', command);
  }
  // A named tracked file commits its work tree version, so that is what the guard reads.
  assert.equal(run('git commit -m x src/a.ts')?.id, 'secret');
  // An untracked file that git never staged cannot enter a commit: git refuses that
  // pathspec itself, so there is nothing for the guard to stop (checked, #824 review).
  sandbox.write('fresh.ts', `export const token = '${key}';\n`);
  assert.equal(run('git commit -m x fresh.ts'), null);
  // Controls: a clean commit passes, and commands that are no commit pay nothing for this.
  sandbox.write('src/a.ts', 'export const a = 2;\n');
  sandbox.git('add', 'src/a.ts');
  assert.equal(run('git commit -m x'), null);
  for (const command of ['git status', 'git diff', 'echo git commit', 'cat src/a.ts']) assert.equal(run(command), null, command);
});

test('commit: a change the guard cannot read is refused, not let through (#824)', () => {
  const sandbox = makeSandbox();
  const key = `ghp_${'a1B2c3D4e5'.repeat(4).slice(0, 36)}`;
  sandbox.write('README.md', 'hello\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'start');
  const run = (command: string) => checkCommand(command, { env: sandbox.env, cwd: sandbox.repo });
  sandbox.write('config.ts', `export const token = '${key}';\n`);
  sandbox.git('add', 'config.ts');
  // --git-dir and --work-tree leave the folder unknown: without a pathspec the index is
  // unreadable, so the guard refuses instead of allowing a commit it never saw (#824).
  assert.equal(run('git --git-dir=.git commit -m x')?.id, 'unreadable-command');
  assert.equal(run(`git --git-dir=${join(sandbox.repo, '.git')} --work-tree=${sandbox.repo} commit -m x`)?.id, 'unreadable-command');
  // -C still names a folder the guard can read, so the secret is named.
  assert.equal(run(`git -C ${sandbox.repo} commit -m x`)?.id, 'secret');
  // A binary file is read as text: the key beside a NUL byte is still found.
  writeFileSync(join(sandbox.repo, 'blob.bin'), Buffer.concat([Buffer.from([0]), Buffer.from(key), Buffer.from('\n')]));
  sandbox.git('add', 'blob.bin');
  sandbox.git('restore', '--staged', 'config.ts');
  const binary = run('git commit -m x');
  assert.equal(binary?.id, 'secret');
  assert.equal(binary?.file, 'blob.bin');
  // A commit that reads the paths to commit from a file is one the guard cannot follow,
  // whether the option is spelled out or shortened the way git allows (#824 review).
  for (const option of ['--pathspec-from-file=names.txt', '--pathspec-from-file', '--pathspec-from-f=names.txt', '--pathspec-from-f', '--pathspec-from-fil=names.txt']) {
    const command = option.includes('=') ? `git commit -m x ${option}` : `git commit -m x ${option} names.txt`;
    assert.equal(run(command)?.id, 'unreadable-command', command);
  }
  // A shortened option that takes a value takes the next word too: `x` is the message,
  // not a path, so the staged secret is still found (#824 review).
  sandbox.git('add', 'config.ts');
  for (const command of ['git commit --mess x', 'git commit --fil msg.txt', 'git commit --auth "a <a@example.com>" -m x']) {
    assert.equal(run(command)?.id, 'secret', command);
  }
  // A staged change git itself cannot read is refused, never allowed.
  writeFileSync(join(sandbox.repo, '.git', 'index'), 'not an index');
  const broken = run('git commit -m x');
  assert.equal(broken?.id, 'unreadable-command');
  assert.match(broken?.what ?? '', /could not read the change/);
});

test('commit: an added line that starts with ++ is text, not a file header (#824 review)', () => {
  const sandbox = makeSandbox();
  const key = `ghp_${'a1B2c3D4e5'.repeat(4).slice(0, 36)}`;
  sandbox.write('README.md', 'hello\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'start');
  const run = (command: string) => checkCommand(command, { env: sandbox.env, cwd: sandbox.repo });
  // `-U0` prints this added line as `+++ <key>`, the same shape as a file header.
  sandbox.write('src.ts', `++ ${key}\n`);
  sandbox.git('add', 'src.ts');
  const found = run('git commit -m x');
  assert.equal(found?.id, 'secret', 'the added line is scanned');
  assert.equal(found?.file, 'src.ts');
  assert.equal(found?.line, 1);
  assert.ok(!JSON.stringify(found).includes(key), 'the secret is never in the finding');
});

test('commit: a big change beside the named paths does not refuse the commit (#824 review)', () => {
  const sandbox = makeSandbox();
  sandbox.write('README.md', 'hello\n');
  sandbox.write('big.txt', 'start\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'start');
  const run = (command: string) => checkCommand(command, { env: sandbox.env, cwd: sandbox.repo });
  sandbox.write('README.md', 'hello again\n');
  sandbox.git('add', 'README.md');
  // Unstaged and not named: this commit leaves it out, so its size is not the guard's cost.
  sandbox.write('big.txt', `${'x'.repeat((16 << 20) + 1024)}\n`);
  assert.equal(run('git commit -m x README.md'), null, 'the named change alone is small');
  // A positive control: -a does take the big file, and the guard still refuses that.
  assert.equal(run('git commit -am x')?.id, 'unreadable-command', 'the cap still holds for -a');
});

test('commit: a small diff is scanned in under 100 ms (#824, record 0035)', () => {
  const sandbox = makeSandbox();
  sandbox.write('README.md', 'hello\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'start');
  sandbox.write('src/a.ts', Array.from({ length: 40 }, (_, index) => `export const a${index} = ${index};\n`).join(''));
  sandbox.git('add', 'src/a.ts');
  const check = () => {
    const started = performance.now();
    checkCommand('git commit -m x', { env: sandbox.env, cwd: sandbox.repo });
    return performance.now() - started;
  };
  check(); // the first call reads the folders and the modules; time the ones a user waits for
  const times = [check(), check(), check()];
  const fastest = Math.min(...times);
  assert.ok(fastest < 100, `a commit check with a small diff took ${Math.round(fastest)} ms`);
});
