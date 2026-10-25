import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkCommand } from '../../../../src/rules/guards/index.ts';
import { makeSandbox, yokotenSandbox } from '../../../../test/repo/helpers.ts';
import { DEFAULTS, type Env } from '../../../../src/rules/config.ts';

test('lead-only files: a worker shell write under .worktrees/<issue>/ is stopped, not the lead (#571)', () => {
  const sandbox = yokotenSandbox();
  const worker = { YOKOTEN_ROLE: 'worker' };
  const run = (command: string, env: Env = worker) => checkCommand(command, { env, cwd: sandbox.repo });
  assert.equal(run('echo x > .worktrees/571-x/AGENTS.md')?.id, 'lead-only');
  assert.match(run('echo x > .worktrees/571-x/AGENTS.md')?.what ?? '', /\.worktrees\/571-x\/AGENTS\.md, which is lead-only/);
  assert.equal(run('echo x > .worktrees/571-x/.github/workflows/ci.yml')?.id, 'lead-only');
  assert.equal(run('rm -rf .worktrees/571-x/.github')?.id, 'lead-only', 'a folder that may hold one');
  assert.equal(run('echo x > .worktrees/571-x/src/a.ts'), null, 'other files pass');
  assert.equal(run('echo x > .worktrees/571-x/AGENTS.md', {}), null, 'the lead passes');
  // A grant names the worktree's own path.
  assert.equal(run('echo x > .worktrees/571-x/AGENTS.md', { ...worker, YOKOTEN_LEAD_ONLY_OK: 'AGENTS.md' }), null);
});

test('lead-only files: the hook stops a shell write from the plugin agent yokoten:worker, with no YOKOTEN_ROLE (#402)', async () => {
  // The session folder is reached through a symlink, as /var is /private/var on macOS: git
  // names the root by its real path, the agent by the link. The full hook rules the session's
  // repo with no yokoten.json, as it does for an edit.
  const sandbox = makeSandbox();
  const link = join(sandbox.home, 'repo-link');
  symlinkSync(sandbox.repo, link);
  for (const cwd of [sandbox.repo, link]) {
    const call = (agentType?: string) =>
      sandbox.call(['hook'], { cwd, input: JSON.stringify({ cwd, agent_type: agentType, tool_input: { command: 'sed -i s/a/b/ AGENTS.md' } }) });
    const result = await call('yokoten:worker');
    assert.equal(result.status, 2, `${cwd === link ? 'through the link' : 'the repo'}: ${result.stderr}`);
    assert.match(result.stderr, /writes AGENTS\.md, which is lead-only/);
    assert.equal((await call()).status, 0, 'the lead');
    assert.equal((await call('yokoten:reviewer')).status, 0, 'not a worker');
  }
});

// #1015: on Windows a worker writes Git Bash paths (`/c/Users/...`, `/tmp/...`). They name the
// same files as `C:\Users\...`, so the same writes are refused. The place is passed in, so
// Linux CI reads them as Windows does; the paths are text, with nothing on this disk.
test('lead-only files: a worker write by a Git Bash path is refused on Windows (#1015)', () => {
  const place = { platform: 'win32', tmp: 'C:\\Users\\agent\\AppData\\Local\\Temp' } as const;
  const repo = 'C:\\Users\\agent\\proj';
  const worktree = `${repo}\\.worktrees\\1015-w`;
  const repos = [repo, `${place.tmp}\\scratch`].map((root) => ({ root, leadOnly: DEFAULTS.leadOnly }));
  const run = (command: string) => checkCommand(command, { env: { YOKOTEN_ROLE: 'worker' }, cwd: worktree, repos, place });
  const refused: [string, RegExp][] = [
    ['echo hacked > /c/Users/agent/proj/AGENTS.md', /writes \/c\/Users\/agent\/proj\/AGENTS\.md|AGENTS\.md, which is lead-only/],
    ["echo 'on: push' > /c/Users/agent/proj/.github/workflows/ci.yml", /lead-only/],
    ['cp notes.md /c/Users/agent/proj/AGENTS.md', /lead-only/],
    ['sed -i s/a/b/ /c/Users/agent/proj/AGENTS.md', /lead-only/],
    ['rm /c/Users/agent/proj/AGENTS.md', /lead-only/],
    ['rm -rf /c/Users/agent/proj/.github', /lead-only/],
    ['echo x > /c/Users/agent/proj/.yokoten/state.json', /lead-only/],
    ['echo hacked > /C/Users/agent/proj/AGENTS.md', /lead-only/],
    ['echo hacked > /c/Users/agent/proj/.worktrees/1015-w/AGENTS.md', /lead-only/],
    ['echo hacked > /tmp/scratch/AGENTS.md', /lead-only/],
    ["echo 'on: push' > /tmp/scratch/.github/workflows/ci.yml", /lead-only/],
    ['cd /c/Users/agent/proj && echo hacked > AGENTS.md', /lead-only/],
    ['git -C /c/Users/agent/proj checkout AGENTS.md', /lead-only/],
    // The forms that were refused before stay refused.
    ['echo hacked > C:/Users/agent/proj/AGENTS.md', /lead-only/],
    ["echo hacked > 'C:\\Users\\agent\\proj\\AGENTS.md'", /lead-only/],
    ['echo hacked > "C:\\Users\\agent\\proj\\AGENTS.md"', /lead-only/],
  ];
  for (const [command, what] of refused) {
    const finding = run(command);
    assert.equal(finding?.id, 'lead-only', command);
    assert.match(finding?.what ?? '', what, command);
  }
  // Unsure: a Git Bash folder of its own, and a climb past the drive, where bash goes on from
  // `/`. The worker's mark rule answers first, with the same reason.
  for (const command of ['echo x > /usr/x', 'echo x > ../../../../../../c/Users/agent/proj/AGENTS.md', 'rm -rf /etc/x']) {
    assert.match(run(command)?.what ?? '', /can't place on Windows/, command);
  }
  // Positive controls: the worker's own files, in every form, and files outside every repo.
  for (const command of [
    'echo x > src/a.ts',
    'echo x > C:/Users/agent/proj/.worktrees/1015-w/src/a.ts',
    "echo x > 'C:\\Users\\agent\\proj\\.worktrees\\1015-w\\src\\a.ts'",
    'echo x > /c/Users/agent/proj/.worktrees/1015-w/src/a.ts',
    'echo x > /C/Users/agent/proj/.worktrees/1015-w/src/a.ts',
    'cd /c/Users/agent/proj/.worktrees/1015-w && echo x > src/a.ts',
    'echo x > /tmp/out.txt',
    'echo x > /dev/null',
    'echo x 2> /dev/stderr',
  ]) assert.equal(run(command), null, command);
});
