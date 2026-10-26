// Tests for src/commands/desk/clone.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { makeSandbox, runChild } from '../../repo/helpers.ts';
import { deskBranch, desksHome, makeClone, type Run, runWith } from '../../../src/commands/desk/clone.ts';

test('desk clone: ../<repo>-desks/<n>, branch desk/<n> from the remote main, origin, hooks and name kept (#1054)', () => {
  const sandbox = makeSandbox();
  sandbox.git('commit', '-q', '--allow-empty', '-m', 'start');
  const remote = join(dirname(sandbox.repo), 'remote.git');
  runChild('git', ['init', '-q', '--bare', '-b', 'main', remote], { env: sandbox.env });
  sandbox.git('remote', 'add', 'origin', remote);
  sandbox.git('push', '-q', 'origin', 'main');
  sandbox.git('config', 'core.hooksPath', '.githooks');
  // The remote moved on: the desk starts from it, not from the local checkout.
  sandbox.git('commit', '-q', '--allow-empty', '-m', 'local only');
  const calls: string[] = [];
  const real = runWith(sandbox.env);
  const run: Run = (file, args, cwd) => {
    calls.push([file, ...args].join(' '));
    return real(file, args, cwd);
  };
  const made = makeClone({ root: sandbox.repo, name: '14', run, install: true });
  assert.ok(!('problem' in made), JSON.stringify(made));
  const desk = join(dirname(sandbox.repo), 'repo-desks', '14');
  assert.equal(made.desk, desk);
  assert.equal(desksHome(sandbox.repo), dirname(desk));
  const git = (...args: string[]) => runChild('git', args, { cwd: desk, env: sandbox.env }).stdout.trim();
  assert.equal(git('branch', '--show-current'), deskBranch('14'));
  assert.equal(git('log', '--format=%s', '-1'), 'start', 'from the remote main');
  assert.equal(made.base, git('rev-parse', 'HEAD'));
  assert.equal(git('remote', 'get-url', 'origin'), remote);
  assert.equal(git('config', 'core.hooksPath'), '.githooks');
  assert.equal(git('config', 'user.name'), 'Test');
  assert.match(readFileSync(join(desk, '.git', 'info', 'exclude'), 'utf8'), /^\.yokoten-agent\.json$/m);
  assert.ok(!calls.some((line) => /\bpush\b/.test(line)), 'never a push');
  assert.ok(!calls.some((line) => line.startsWith('npm')), 'no lock file, no npm ci');
  // A second desk of the same name is refused, and nothing is changed.
  const again = makeClone({ root: sandbox.repo, name: '14', run, install: true });
  assert.match('problem' in again ? again.problem : '', /repo-desks\/14 is already there\. Run `yokoten desk 14` to go on with it/);
});

test('desk clone: with no remote, from the checkout; npm ci only with a lock file and no --no-install (#1054)', () => {
  const sandbox = makeSandbox();
  sandbox.write('package-lock.json', '{}\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-q', '-m', 'start');
  const calls: string[] = [];
  const real = runWith(sandbox.env);
  const run: Run = (file, args, cwd) => {
    calls.push([file, ...args].join(' '));
    return file === 'npm' ? { status: 0, stdout: '', stderr: '' } : real(file, args, cwd);
  };
  const made = makeClone({ root: sandbox.repo, name: 'fix-the-typo', run, install: false });
  assert.ok(!('problem' in made));
  assert.ok(!calls.some((line) => line.startsWith('npm')), '--no-install skips npm ci');
  const second = makeClone({ root: sandbox.repo, name: '15', run, install: true });
  assert.ok(!('problem' in second));
  assert.ok(calls.includes('npm ci --ignore-scripts --no-audit --no-fund'), 'npm ci runs with no scripts');
  // A failed npm ci is one line that names the way past it.
  const failing: Run = (file, args, cwd) => (file === 'npm' ? { status: 1, stdout: '', stderr: 'npm error network\n' } : real(file, args, cwd));
  writeFileSync(join(sandbox.repo, 'x'), '');
  const failed = makeClone({ root: sandbox.repo, name: '16', run: failing, install: true });
  assert.match('problem' in failed ? failed.problem : '', /^npm ci failed in .+: npm error network\. Run it again with --no-install to skip it\.$/);
});
