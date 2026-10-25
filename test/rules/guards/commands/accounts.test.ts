import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { hardenRead, isRedacted, printsAccount, REDACT_FAILED, wrapForRedact } from '../../../../src/rules/guards/index.ts';

test('printsAccount: one plain read from the table is caught (#390)', () => {
  const caught = [
    'git log -3', 'git show HEAD', 'git blame README.md', 'git shortlog -sn HEAD', 'git whatchanged', '/usr/bin/git log',
    'git remote -v', 'git remote get-url origin', 'git remote show origin', 'git config --list', 'git config --global --get user.email', 'git config get remote.origin.url',
    'gh api user', 'gh api repos/o/r/traffic/views --jq .count', 'gh api -X GET users/someone', 'gh api --method=GET user --paginate', 'gh auth status', 'gh auth status --hostname github.com',
    'npm whoami', 'npm whoami --registry https://registry.npmjs.org', 'wrangler whoami', 'npx wrangler whoami', 'pnpm dlx wrangler@3 whoami',
    // Any format: the author can print with no "Author:" line (#413).
    'git log --format=%an', 'git log --pretty=format:%ae', 'git log --oneline', 'git show --pretty=format:%s', 'git log --format=%H -1',
    "git log --format='%an <%ae>'", 'git log --format="%cn <%ce>" -3', 'git shortlog -sne HEAD', 'git shortlog -s -n -e main', 'git blame -e README.md',
    "git for-each-ref --format='%(authorname) %(refname)'", 'git for-each-ref refs/tags', 'git cat-file -p HEAD', 'git cat-file commit HEAD', 'git cat-file tag v1',
    // A quote inside the other kind is plain text.
    `git log '"'`, `git log "'"`, "git log -- '*.md'",
    // A shortlog with a revision; an option's value comes first.
    'git shortlog --group=author HEAD', 'git shortlog --group author HEAD', 'git shortlog -s HEAD -- docs',
  ];
  for (const command of caught) assert.ok(printsAccount(command), `not caught: ${command}`);
  assert.equal(printsAccount('git log -1'), '`git log` prints author names and emails');
  assert.equal(printsAccount('git remote show origin'), '`git remote` prints remote URLs');
});

test('printsAccount: anything more than one plain read is left to the normal flow (#390)', () => {
  const left = [
    // More than one command, or shell around it.
    'cd x && git log', 'git log; ls', 'git log | head', 'git log > out', 'git log 2>/dev/null', 'git log &', 'git log $(echo x)', 'git log `x`', '(git log)', '{ git log; }', 'git log # note', 'git log\ngit push',
    // A prefix or a launcher.
    'FOO=1 git log', 'sudo git log', 'env git log', 'nice git log', 'bash -c "git log"', 'npx --yes wrangler whoami',
    // Options that write a file, run a program, or pick another git.
    'git -c a=b log', 'git -C x log', 'git log --output=x', 'git log -o x', 'git log --ext-diff', 'git show --textconv x', 'git log --exec-path=/x', 'git log --show-signature', 'git show --show-signature HEAD',
    // A subcommand only by name further on.
    'git remote add show x', 'git remote rename get-url x', 'git remote',
    // A write, or something sent.
    'git config user.email x', 'git config --get core.hooksPath', 'git push', 'git fetch', 'git pull', 'git clone x', 'git ls-remote', 'wrangler deploy', 'wrangler login', 'npx wrangler pages deploy',
    'gh api -X PATCH user -f name=x', 'gh api user -f bio=x', 'gh api --method=POST user/emails', 'gh api repos/o/r', 'gh auth status --show-token', 'gh auth token',
    // Not in the table any more: they print secrets, not only the owner.
    'env', 'printenv', 'printenv HOME',
    // A format in a compound command, or quoted text bash still reads (#413).
    "git log --format='%an'; ls", 'git log --format=%an | head', 'git log --format="$(id)"', 'git log --format="`id`"', "git log \\'x;ls'", "git log 'a'\\';ls'", 'git log --format=%an > out', "git log '%an' && git push",
    // A quote the plain-text search can't match to bash's own reading: it could hide a redirect (#413).
    `git log --format="%an %ae'$x" > out.txt --invert-grep --grep='"'`, `git log "'$x" >> ~/.bashrc '"'`, `git log 'x`, `git log "x`, `git log "a\\"b"`,
    // A word that reads as a redirect, even quoted.
    `git log '>' out`, `git log '2>&1'`, `git log '&>' x`,
    // A glob: a file named `--output=x` would become an option (#413).
    'git log *', 'git log -- *.md', 'git show HEAD?', 'git log [a]', 'git blame *',
    // A shortlog with no revision reads stdin: an option's value or a path after -- is none.
    'git shortlog -sne', 'git shortlog -sn', 'git shortlog -s --group author', 'git shortlog --format %an', 'git shortlog -w 20', 'git shortlog -s -- HEAD',
    // The subcommand quoted: the rewrite can't place its options.
    '"git" log -1', "git 'log' -1",
    // A cat-file that is not one object printed: a batch reads stdin, a filter runs a program.
    'git cat-file --batch', 'git cat-file -p', 'git cat-file --filters HEAD:x', 'git cat-file -t HEAD', 'git cat-file -p HEAD extra',
    'git status', 'echo git log',
  ];
  for (const command of left) assert.equal(printsAccount(command), null, command);
});

// #1006: the plain `git config user.email` is a read too, as the guide says. A write is not.
test('printsAccount: git config reads of an account key are caught, writes are not (#1006)', () => {
  const cases: [command: string, isRead: boolean][] = [
    // Reads: plain, with a scope or another read option, and explicit.
    ['git config user.email', true],
    ['git config user.name', true],
    ['git config --global user.email', true],
    ['git config --local user.name', true],
    ['git config --show-origin user.email', true],
    ['git config --show-scope --global user.email', true],
    ['git config --type bool user.useConfigOnly', true],
    ['git config --file=.git/config user.email', true],
    ['git config -f .git/config user.email', true],
    ['git config remote.origin.url', true],
    ['git config --get user.email', true],
    ['git config --global --get user.email', true],
    ['git config --get-all user.email', true],
    ['git config get user.email', true],
    ['git config get --show-origin user.email', true],
    ['git config --list', true],
    ['git config --global -l', true],
    ['git config list', true],
    // Writes: a value after the key, or an option or subcommand that changes the config.
    ['git config user.email x', false],
    ['git config --global user.email x', false],
    ['git config user.name "Sample Owner"', false],
    ['git config --unset user.email', false],
    ['git config --unset-all user.email', false],
    ['git config --add user.email x', false],
    ['git config --replace-all user.email x', false],
    ['git config set user.email x', false],
    ['git config set user.email', false],
    ['git config unset user.email', false],
    ['git config --remove-section user', false],
    ['git config --rename-section user people', false],
    ['git config --edit', false],
    ['git config -e', false],
    ['git config edit', false],
    // Not an account key, or nothing named.
    ['git config core.hooksPath', false],
    ['git config --get core.hooksPath', false],
    ['git config', false],
    ['git config --global', false],
    ['git config --list user.email', false],
  ];
  for (const [command, isRead] of cases) assert.equal(printsAccount(command) !== null, isRead, command);
});

test('hardenRead: a log, show or blame runs no textconv or external diff; other reads stay as they are (#413)', () => {
  assert.equal(hardenRead('git log -1'), 'git log --no-ext-diff --no-textconv --no-show-signature -1');
  assert.equal(hardenRead('git show'), 'git show --no-ext-diff --no-textconv --no-show-signature');
  assert.equal(hardenRead('/usr/bin/git whatchanged -p'), '/usr/bin/git whatchanged --no-ext-diff --no-textconv --no-show-signature -p');
  assert.equal(hardenRead('git blame -e README.md'), 'git blame --no-textconv -e README.md');
  for (const command of ['git shortlog -sn HEAD', 'git cat-file -p HEAD', 'git remote -v', 'npm whoami', 'git status']) assert.equal(hardenRead(command), command);
});

test('isRedacted: the wrapper\'s own first line and the call; a comment that names them is not enough (#390)', () => {
  const wrapped = wrapForRedact('git log', '"node" "$HOME/y/bin/yokoten.ts" redact');
  assert.equal(isRedacted(wrapped), true);
  assert.equal(printsAccount(wrapped), null);
  assert.equal(isRedacted('git log # yokoten-redact yokoten redact'), false);
  assert.equal(isRedacted(`echo hi\n${wrapped}`), false);
  assert.equal(isRedacted(wrapped.replace('yokoten.ts" redact', 'other.ts" redact')), false);
  assert.ok(wrapped.startsWith('set -o pipefail # yokoten-redact\n(\ngit log\n) 2>&1 | { "node" "$HOME/y/bin/yokoten.ts" redact || { cat >/dev/null; '), wrapped);
  assert.ok(!wrapped.includes('|| cat;'), 'a redact that fails never passes the output through (#1006)');
});

test('wrapForRedact: keeps the exit code; a heredoc still ends (#390)', () => {
  const run = (command: string, redact = 'tr a-z A-Z') => spawnSync('bash', ['-c', wrapForRedact(command, redact)], { encoding: 'utf8' });
  assert.deepEqual([run('echo hi; exit 3').status, run('echo hi; exit 3').stdout], [3, 'HI\n']);
  assert.deepEqual([run('echo out; echo err >&2').status, run('echo out; echo err >&2').stdout], [0, 'OUT\nERR\n']);
  assert.equal(run('cat <<EOF\nbody\nEOF').stdout, 'BODY\n');
});

// #1006: a redact that can't run hides the output, fail closed. A stand-in redact hides
// the name; the broken ones are missing, exit at once, or stop partway.
test('wrapForRedact: a redact that is missing, exits at once or stops partway prints no name, one line, and the exit code (#1006)', () => {
  const name = ['Sample', 'Owner'].join(' ');
  const email = ['sample.owner', 'example.com'].join('@');
  // Many lines, so a redact that stops partway leaves most of the output unread.
  const command = `for i in $(seq 1 3000); do echo "Author: ${name} <${email}>"; done; echo "by ${name}" >&2`;
  const hide = `sed -e 's/${name}/[name]/g' -e 's/${email}/[email]/g'`;
  const run = (redact: string, exitCode = 0) => spawnSync('bash', ['-c', wrapForRedact(`${command}; exit ${exitCode}`, redact)], { encoding: 'utf8' });
  const assertNoOwner = (output: string) => assert.ok(!output.includes(name) && !output.includes(email), 'the name or email was printed');

  // Positive control: a working redact prints the output, the name hidden.
  const working = run(hide);
  assert.equal(working.status, 0);
  assert.ok(working.stdout.includes('Author: [name] <[email]>') && working.stdout.includes('by [name]'), working.stdout.slice(0, 200));
  assertNoOwner(working.stdout + working.stderr);

  const broken = {
    missing: '"/nonexistent/node" "/nonexistent/yokoten.ts" redact',
    'exits at once': "sh -c 'exit 3'",
    'stops partway': `sh -c "head -n 5 | ${hide.replaceAll('"', '\\"')}; exit 9"`,
  };
  for (const [label, redact] of Object.entries(broken)) {
    for (const exitCode of [0, 4]) {
      const result = run(redact, exitCode);
      assertNoOwner(result.stdout + result.stderr);
      const lines = result.stderr.split('\n').filter((line) => line.startsWith('yokoten:'));
      assert.deepEqual(lines, [REDACT_FAILED], `${label}: ${result.stderr}`);
      // The command's own failure wins; a passed command with hidden output is not a clean run.
      assert.equal(result.status, exitCode || 1, `${label}, command exit ${exitCode}`);
    }
  }
});

// #555: a worker does not push or post, and does not change a git folder, where the worker
// mark is kept; the lead may do all of it. A read that names .git passes.
