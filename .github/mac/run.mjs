// Run a command on the owner's MacBook, on the committed head of this checkout's branch, so a
// full test run leaves WSL its memory (owner 2026-10-28: "多安排macbook干活"). It replaces the
// lead's ~/.config/yokoten-mac/run.sh: a worker may not run a command under ~/.config, but it
// may run this file from its worktree, and as a lead-only file (`.github/**`) a worker cannot
// change what it runs (issue #1241).
//
//   node .github/mac/run.mjs [-- <command...>]     (default: npm test)
//
// It pushes the branch to the Mac's bare repo (~/work/yokoten.git) over ssh, checks it out in
// a Mac worktree named after the branch (node_modules shared from ~/work/yokoten-cap), runs the
// command there with nice, and prints its output with the Mac's address and home path masked.
// Only committed work goes: commit first. Nothing goes back; the Mac keeps no secret.
// The Mac's address is read from ~/.cache/fable/mac-host.txt (written from Tailscale's status),
// never printed. Exit: the command's own code; 2 for a setup problem.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOST_FILE = join(homedir(), '.cache', 'fable', 'mac-host.txt');
// Branch and host go into a shell on the Mac, so they may hold only these characters.
const BRANCH_CHARS = /^[A-Za-z0-9._/-]+$/;
const HOST_CHARS = /^[A-Za-z0-9._@:-]+$/;

function fail(message) {
  process.stderr.write(`run.mjs: ${message}\n`);
  process.exit(2);
}

function git(...args) {
  const run = spawnSync('git', args, { encoding: 'utf8' });
  return run.status === 0 ? run.stdout.trim() : null;
}

/** A word quoted for a POSIX shell. */
function quote(word) {
  return /^[A-Za-z0-9._/=:@%+-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

const dash = process.argv.indexOf('--');
const command = dash === -1 ? ['npm', 'test'] : process.argv.slice(dash + 1);
if (command.length === 0) fail('no command after --');

const top = git('rev-parse', '--show-toplevel') ?? fail('not in a git checkout');
const branch = git('branch', '--show-current') || fail('no branch checked out; check one out and commit first');
if (!BRANCH_CHARS.test(branch)) fail('the branch name has characters this runner does not send');
let host = '';
try {
  host = readFileSync(HOST_FILE, 'utf8').trim();
} catch {
  fail('no Mac address in ~/.cache/fable/mac-host.txt');
}
if (!HOST_CHARS.test(host)) fail('the Mac address in ~/.cache/fable/mac-host.txt is not a plain host');

// A set GIT_TRACE or GIT_CURL_VERBOSE, even "0", makes git print private hosts.
const env = { ...process.env };
delete env.GIT_TRACE;
delete env.GIT_CURL_VERBOSE;
const push = spawnSync('git', ['-C', top, 'push', '-q', '-f', `ssh://${host}/~/work/yokoten.git`, `${branch}:${branch}`], { env, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
if (push.status !== 0) fail(`the push to the Mac failed (exit ${push.status})`);

const remote = [
  'set -e',
  'export PATH=/opt/homebrew/bin:$PATH',
  'cd ~/work',
  'git -C yokoten-cap fetch -q origin',
  `if [ "$(git -C yokoten-cap branch --show-current)" = ${quote(branch)} ]; then D=yokoten-cap; else D=${quote(`wt-${branch.replace(/\//g, '-')}`)}; [ -d "$D" ] || git -C yokoten-cap worktree add -q "../$D" -B ${quote(branch)} ${quote(`origin/${branch}`)}; fi`,
  'cd "$D"',
  `git checkout -q -B ${quote(branch)} ${quote(`origin/${branch}`)}`,
  '[ -e node_modules ] || ln -s ../yokoten-cap/node_modules node_modules',
  `nice ${command.map(quote).join(' ')}`,
].join('; ');

const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mask = (text) => text.replace(new RegExp(escaped, 'g'), 'MAC').replace(/\/Users\/[^/\s]+/g, '~').replace(/[A-Za-z0-9._-]+@[0-9.]+/g, 'USER@HOST');
const ssh = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', host, remote], { stdio: ['ignore', 'pipe', 'pipe'] });
for (const [from, to] of [[ssh.stdout, process.stdout], [ssh.stderr, process.stderr]]) {
  let rest = '';
  from.setEncoding('utf8');
  from.on('data', (chunk) => {
    const lines = (rest + chunk).split('\n');
    rest = lines.pop();
    if (lines.length) to.write(`${lines.map(mask).join('\n')}\n`);
  });
  from.on('end', () => rest && to.write(mask(rest)));
}
ssh.on('close', (code) => process.exit(code ?? 2));
