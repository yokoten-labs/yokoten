// Run the tests on the owner's MacBook, on the committed head of this checkout's branch, so a
// full test run leaves WSL its memory (owner 2026-10-28: "多安排macbook干活"). It replaces the
// lead's ~/.config/yokoten-mac/run.sh: a worker may not run a command under ~/.config, but it
// may run this file from its worktree, and as a lead-only file (`.github/**`) a worker cannot
// change what it runs (issue #1241).
//
//   node .github/mac/run.ts [-- <command...>]     (default: npm test)
//
// Only test commands run (TEST_COMMANDS): the Mac is the owner's own account, so this is no
// shell there. The branch's tests still run as that account, as they did when the lead ran
// them; a sandbox for them is a follow-up (issue #1255). A checkout with uncommitted changes, or
// with untracked files that are not ignored, is refused, so a green run means the commit sent.
//
// It pushes the branch to the Mac's bare repo (~/work/yokoten.git) over ssh, checks it out in
// a Mac worktree named after the branch (node_modules shared from ~/work/yokoten-cap), runs the
// command there with nice, and prints its output with the Mac's address and home path masked.
// The address is read from ~/.config/yokoten-mac/host, which a worker may not write, and is
// never printed. Exit: the command's own code; 2 for a problem before the command starts.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST_FILE = join(homedir(), '.config', 'yokoten-mac', 'host');
// Branch and host go into a shell on the Mac and onto ssh's command line, so they may hold only
// these characters, and never start with `-`, which ssh and git would read as an option.
export const BRANCH_CHARS = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
export const HOST_CHARS = /^[A-Za-z0-9][A-Za-z0-9._@:-]*$/;
// What the remote setup prints when it fails, told apart from the command's own exit code.
export const SETUP_FAILED = 'yokoten-mac-run: setup failed';

/** A word quoted for a POSIX shell. */
export function quote(word: string): string {
  return /^[A-Za-z0-9._/=:@%+-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** Output with the Mac's address, its home folder and any user@address hidden. */
export function mask(text: string, host: string): string {
  const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(/[A-Za-z0-9._-]+@\d{1,3}(?:\.\d{1,3}){3}/g, 'USER@HOST').replace(new RegExp(escaped, 'g'), 'MAC').replace(/\/Users\/[^/\s]+/g, '~');
}

/** Whether a command is one of the test commands this runner sends. */
export function isTestCommand(command: string[]): boolean {
  const [first, second, third] = command;
  if (first === 'npm') return (second === 'test' && command.length === 2) || (second === 'run' && command.length === 3 && /^[a-z][a-z0-9:-]*$/.test(third ?? ''));
  if (first === 'npx') return second === 'tsc' && command.length === 2;
  if (first === 'node') return second === '--test' && command.slice(2).every((word) => /^[A-Za-z0-9_*][A-Za-z0-9._/*-]*$/.test(word) || /^--test-name-pattern=[A-Za-z0-9 ._*-]+$/.test(word));
  return false;
}

/** The shell line run on the Mac: set up the branch's worktree, then the command. */
export function remoteLine(branch: string, command: string[]): string {
  const setup = [
    'export PATH=/opt/homebrew/bin:$PATH',
    'cd ~/work',
    'git -C yokoten-cap fetch -q origin',
    `if [ "$(git -C yokoten-cap branch --show-current)" = ${quote(branch)} ]; then D=yokoten-cap; else D=${quote(`wt-${branch.replace(/\//g, '-')}`)}; [ -d "$D" ] || git -C yokoten-cap worktree add -q "../$D" -B ${quote(branch)} ${quote(`origin/${branch}`)}; fi`,
    'cd "$D"',
    `git checkout -q -B ${quote(branch)} ${quote(`origin/${branch}`)}`,
    '{ [ -e node_modules ] || ln -s ../yokoten-cap/node_modules node_modules; }',
  ];
  return `{ ${setup.join(' && ')}; } || { echo ${quote(SETUP_FAILED)} >&2; exit 2; }; nice ${command.map(quote).join(' ')}`;
}

/**
 * The environment for git and ssh, without what could write the host somewhere or run another
 * command: every GIT_TRACE* (a set one, even "0", makes git print private hosts), GIT_CURL_VERBOSE,
 * and GIT_SSH, GIT_SSH_COMMAND and GIT_SSH_VARIANT.
 */
export function sendEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !/^GIT_(TRACE|CURL_VERBOSE|SSH)/i.test(name)));
}

function fail(message: string): never {
  process.stderr.write(`run.ts: ${message}\n`);
  process.exit(2);
}

function git(...args: string[]): string | null {
  const run = spawnSync('git', args, { encoding: 'utf8' });
  return run.status === 0 ? run.stdout.trim() : null;
}

function main(): void {
  const dash = process.argv.indexOf('--');
  const command = dash === -1 ? ['npm', 'test'] : process.argv.slice(dash + 1);
  if (!isTestCommand(command)) fail('only `npm test`, `npm run <script>`, `npx tsc` or `node --test <files>` run on the Mac');

  const top = git('rev-parse', '--show-toplevel') ?? fail('not in a git checkout');
  const branch = git('branch', '--show-current') || fail('no branch checked out; check one out and commit first');
  if (!BRANCH_CHARS.test(branch)) fail('the branch name has characters this runner does not send');
  const status = git('-C', top, 'status', '--porcelain');
  if (status === null) fail('git status failed here, so the runner cannot tell what would be left out');
  if (status !== '') fail('there are uncommitted changes or untracked files; commit them (or ignore them) first, since only the commit goes to the Mac');
  let host = '';
  try {
    host = readFileSync(HOST_FILE, 'utf8').trim();
  } catch {
    fail('no Mac address in ~/.config/yokoten-mac/host');
  }
  if (!HOST_CHARS.test(host)) fail('the Mac address in ~/.config/yokoten-mac/host is not a plain host');

  const env = sendEnv(process.env);
  const push = spawnSync('git', ['-C', top, 'push', '-q', '-f', `ssh://${host}/~/work/yokoten.git`, `${branch}:${branch}`], { env, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
  if (push.status !== 0) fail(`the push to the Mac failed (exit ${push.status})`);

  let setupFailed = false;
  const ssh = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', host, remoteLine(branch, command)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const [from, to] of [[ssh.stdout, process.stdout], [ssh.stderr, process.stderr]] as const) {
    let rest = '';
    from.setEncoding('utf8');
    from.on('data', (chunk: string) => {
      const lines = (rest + chunk).split('\n');
      rest = lines.pop() ?? '';
      if (lines.some((line) => line === SETUP_FAILED)) setupFailed = true;
      if (lines.length) to.write(`${lines.map((line) => mask(line, host)).join('\n')}\n`);
    });
    from.on('end', () => {
      if (rest) to.write(mask(rest, host));
    });
  }
  // exitCode, not exit: the streams flush what they still hold.
  ssh.on('close', (code) => {
    if (setupFailed) process.stderr.write('run.ts: the setup on the Mac failed (fetch, worktree or checkout); nothing ran\n');
    else if (code === 255 || code === null) process.stderr.write('run.ts: ssh to the Mac failed; nothing ran, or the run was cut off\n');
    process.exitCode = setupFailed || code === 255 || code === null ? 2 : code;
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
