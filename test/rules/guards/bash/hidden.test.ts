// Tests for src/rules/guards/bash/hidden.ts.
//
// The guard reads commands with its own reader. When the reader and bash disagree, the
// guard can allow a command that runs a program or writes a file it never saw. These tests
// give each command to real bash, with every program replaced by a recorder and every write
// kept in a temp folder, and compare what really happened with what the guard read. A case
// fails only when the guard allowed the command and bash did something the guard did not
// see; a refusal is safe (record 0014).
//
// The fixed corpus and the seed keep CI reproducible. `YOKOTEN_DIFF_CASES` asks for a
// longer seeded run, and `YOKOTEN_DIFF_SEED` changes the seed, for a local or nightly run.

import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import {
  execFileSync,
  spawnSync,
} from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { makeTempDir, blocked, allowed } from '../../../repo/helpers.ts';
import { checkCommand, commandWords, findProgramPlaces } from '../../../../src/rules/guards/index.ts';

const DIFF_FIXTURE: Record<string, string> = {
  'ev/f.md': 'QuietVale\n',
  'f.md': 'clean\n',
  'a.md': 'a\n',
  'notes.md': 'notes\n',
  '--output=x': 'a file whose name looks like an option\n',
  'sub/keep.txt': 'keep\n',
  'package.json': '{"scripts":{"test":"node --test"}}\n',
};

// A recorder at every program name. It writes what ran to $YOKOTEN_RECORD, makes the files
// a write option names, and hands a nested shell or a launcher its own command.
const RECORDER = `#!/bin/bash
name=\${0##*/}
{
  printf 'RUN %s' "$name"
  for arg in "$@"; do printf ' %s' "$arg"; done
  printf '\\n'
} >> "$YOKOTEN_RECORD"
write() { [ -n "$1" ] && : > "$1"; }
case $name in
  git) for arg in "$@"; do case $arg in --output=*) write "\${arg#--output=}";; esac; done;;
  sort|less)
    previous=
    for arg in "$@"; do
      case $arg in
        -o) previous=o;;
        --output=*) write "\${arg#--output=}";;
        *) [ "$previous" = o ] && { write "$arg"; previous=; };;
      esac
    done;;
  curl)
    previous=
    for arg in "$@"; do
      case $arg in
        -o|--output) previous=o;;
        --output=*) write "\${arg#--output=}";;
        *) [ "$previous" = o ] && { write "$arg"; previous=; };;
      esac
    done;;
  wget)
    previous=
    for arg in "$@"; do
      case $arg in
        -O) previous=o;;
        *) [ "$previous" = o ] && { write "$arg"; previous=; };;
      esac
    done;;
  dd) for arg in "$@"; do case $arg in of=*) write "\${arg#of=}";; esac; done;;
  tee) for arg in "$@"; do case $arg in -*) ;; *) write "$arg";; esac; done; while IFS= read -r line; do :; done;;
  bash|sh) if [ "$1" = "-c" ]; then exec "$YOKOTEN_BASH" -c "$2"; fi;;
  env) while [ $# -gt 0 ]; do case $1 in -*) shift;; *=*) shift;; *) break;; esac; done; [ $# -gt 0 ] && exec "$@";;
  nice|nohup|setsid|sudo) while [ $# -gt 0 ]; do case $1 in -*) shift;; *) break;; esac; done; [ $# -gt 0 ] && exec "$@";;
esac
exit 0
`;

const STUB_PROGRAMS = [
  'bash', 'sh', 'env', 'nice', 'nohup', 'setsid', 'sudo',
  'git', 'sort', 'less', 'curl', 'wget', 'dd', 'tee',
  'cp', 'mv', 'rm', 'cat', 'echo', 'printf', 'node', 'npm', 'npx', 'gh',
  'grep', 'sed', 'xargs', 'find', 'touch', 'mkdir', 'ln', 'chmod', 'chown', 'chgrp',
  'python3', 'perl', 'jq', 'date', 'id', 'printenv', 'sleep', 'tar', 'install',
  'truncate', 'vim', 'nano', 'patch', 'unzip', 'split', 'gzip', 'wc', 'head', 'tail',
  'diff', 'true', 'false', 'pwd', 'cut', 'tr', 'shasum', 'mktemp', 'basename', 'dirname',
  'realpath', 'stat', 'file', 'which',
];

// Programs the guard reads as launchers: it names what they run, not the launcher.
const LAUNCHERS = new Set(['env', 'nice', 'nohup', 'setsid', 'sudo', 'time', 'command', 'exec']);

interface BashSandbox {
  base: string;
  bin: string;
  logs: string;
  tmp: string;
  bash: string;
  /** Its major.minor, so the cases can ask for a bash that has a shape at all. */
  version: number;
  log: () => string;
}

function makeBashSandbox(): BashSandbox {
  const base = makeTempDir('bash-diff-');
  const bin = join(base, 'bin');
  const logs = join(base, 'logs');
  const tmp = join(base, 'tmp');
  mkdirSync(bin);
  mkdirSync(logs);
  mkdirSync(tmp);
  writeFileSync(join(bin, 'record'), RECORDER);
  chmodSync(join(bin, 'record'), 0o755);
  for (const name of STUB_PROGRAMS) symlinkSync(join(bin, 'record'), join(bin, name));
  const bash = execFileSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).trim();
  const version = Number(execFileSync(bash, ['-c', 'echo "${BASH_VERSINFO[0]}.${BASH_VERSINFO[1]}"'], { encoding: 'utf8' }).trim());
  let count = 0;
  return { base, bin, logs, tmp, bash, version, log: () => join(logs, `record-${++count}`) };
}

/** Every file under `folder`, by relative path, with its text. */
function snapshotFiles(folder: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(path, relative);
      else if (entry.isFile()) files.set(relative, readFileSync(path, 'utf8'));
    }
  };
  walk(folder, '');
  return files;
}

const isSafeCase = (command: string): boolean => !command.includes('..') && !/(?:^|[\s;|&(<>])\/(?!dev\/null)/.test(command);

interface BashRun {
  folder: string;
  programs: Set<string>;
  writes: Set<string>;
}

/** Runs one command under bash with the recorder, in its own copy of the fixture. */
function runUnderBash(sandbox: BashSandbox, command: string): BashRun {
  const folder = makeTempDir('bash-case-');
  for (const [path, text] of Object.entries(DIFF_FIXTURE)) {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), text);
  }
  mkdirSync(join(folder, 'home'), { recursive: true });
  const record = sandbox.log();
  const before = snapshotFiles(folder);
  const script = `command_not_found_handle() { printf 'RUN %s\\n' "$1" >> "$YOKOTEN_RECORD"; return 127; }\nset +H\n${command}\n`;
  spawnSync(sandbox.bash, ['--noprofile', '--norc', '-c', script], {
    cwd: folder,
    env: {
      PATH: sandbox.bin,
      HOME: join(folder, 'home'),
      YOKOTEN_RECORD: record,
      YOKOTEN_BASH: sandbox.bash,
      TMPDIR: sandbox.tmp,
      LC_ALL: 'C',
      LANG: 'C',
    },
    encoding: 'utf8',
    input: '',
    timeout: 10_000,
  });
  const after = snapshotFiles(folder);
  const programs = new Set<string>();
  if (existsSync(record)) {
    for (const line of readFileSync(record, 'utf8').split('\n')) {
      const [, name] = /^RUN (\S+)/.exec(line) ?? [];
      if (name !== undefined) programs.add(name.split('/').pop() ?? name);
    }
  }
  const writes = new Set<string>();
  for (const [path, text] of after) if (before.get(path) !== text) writes.add(path);
  return { folder, programs, writes };
}

interface GuardReading {
  programs: Set<string>;
  writes: Set<string>;
  decision: ReturnType<typeof checkCommand>;
}

const programBase = (word: string): string => (word.split('/').pop() ?? word).replace(/^['"]|['"]$/g, '');
const cleanPath = (path: string): string => {
  const clean = join(path).split('\\').join('/');
  return clean.startsWith('./') ? clean.slice(2) : clean;
};

/** Adds a write target, placed from the folder the guard read so far. */
function guardWrite(writes: Set<string>, target: string | undefined, folder: string): void {
  if (target === undefined || target === '' || target.startsWith('/dev/')) return;
  // A value the guard cannot name is not a file it saw.
  if (/[$`*?[\]{}()]/.test(target)) return;
  const inHome = target === '~' ? 'home' : target.startsWith('~/') ? `home/${target.slice(2)}` : target;
  writes.add(cleanPath(join(folder, inHome)));
}

/** What the guard reads: every program it lists, every file it sees written, and its decision. */
function guardReading(command: string, folder: string): GuardReading {
  const decision = checkCommand(command, { env: {}, cwd: folder });
  const commands = commandWords(command);
  const programs = new Set<string>();
  const writes = new Set<string>();
  let where = '';
  for (const words of commands) {
    for (const place of findProgramPlaces(words)) programs.add(programBase(place.word));
    if (words[0] === 'cd' && words.length === 2 && !/[$`*?[]/.test(words[1])) {
      where = cleanPath(join(where, words[1]));
      continue;
    }
    for (const [index, word] of words.entries()) {
      const redirect = /^(?:\d+|\{[A-Za-z_]\w*\}|&)?(>>|>\||>&|<>|<<<|<<|>|<)(.*)$/s.exec(word);
      if (redirect) {
        const [, operator, rest] = redirect;
        if (operator === '<' || operator === '<<' || operator === '<<<') {
          if (rest === '') continue;
        } else if (operator === '>&' && /^\d*$/.test(rest)) continue; // >&2 is a descriptor, not a file
        else guardWrite(writes, rest === '' ? words[index + 1] : rest, where);
        continue;
      }
    }
    const place = findProgramPlaces(words)[0];
    if (!place) continue;
    const program = programBase(place.word);
    const args = words.slice(place.index + 1);
    const optionFile = (options: string[], short?: string) => {
      for (const [index, arg] of args.entries()) {
        if (options.includes(arg)) guardWrite(writes, args[index + 1], where);
        for (const option of options) if (arg.startsWith(`${option}=`)) guardWrite(writes, arg.slice(option.length + 1), where);
        if (short !== undefined && arg === short) guardWrite(writes, args[index + 1], where);
        if (short !== undefined && arg.startsWith(short) && arg.length > short.length && !arg.startsWith('--')) guardWrite(writes, arg.slice(short.length), where);
      }
    };
    if (program === 'git') optionFile(['--output']);
    if (['sort', 'less'].includes(program)) optionFile(['--output'], '-o');
    if (program === 'curl') optionFile(['--output'], '-o');
    if (program === 'wget') optionFile([], '-O');
    if (program === 'dd') for (const arg of args) if (arg.startsWith('of=')) guardWrite(writes, arg.slice(3), where);
    if (program === 'tee') for (const arg of args) if (!arg.startsWith('-')) guardWrite(writes, arg, where);
    if (['cp', 'mv', 'ln', 'install', 'rsync'].includes(program)) {
      const plain = args.filter((arg) => !arg.startsWith('-'));
      guardWrite(writes, plain.at(-1), where);
    }
    if (program === 'touch') for (const arg of args) if (!arg.startsWith('-')) guardWrite(writes, arg, where);
  }
  return { programs, writes, decision };
}

/** Before the reader followed substitutions inside single quotes: that text was data. */
function naiveReading(command: string): GuardReading {
  const text = command.replace(/'[^']*'/gs, ' ');
  const programs = new Set<string>();
  for (const part of text.split(/[;&|\n]+/)) {
    const word = part.trim().split(/\s+/)[0];
    if (word) programs.add(programBase(word));
  }
  const writes = new Set<string>();
  for (const [, target] of text.matchAll(/(?:^|[\s;|&])(?:\d*>>?|&>>?)\s*([^\s;&|]+)/g)) guardWrite(writes, target, '');
  return { programs, writes, decision: null };
}

/** What bash did that the reading did not: a program run, or a file written. */
function disagreements(run: BashRun, reading: GuardReading): string[] {
  const found: string[] = [];
  for (const program of run.programs) if (!LAUNCHERS.has(program) && !reading.programs.has(program)) found.push(`ran ${program}`);
  for (const file of run.writes) if (!reading.writes.has(file)) found.push(`wrote ${file}`);
  return found.sort();
}

// The reviewers' known holes (#402, #413, #439), with the shape that hid them. The third
// number is the oldest bash that runs the shape: macOS ships bash 3.2, and CI runs it, so
// `printf -v` (4.0) and `test -v` / `[[ -v` (4.2) never see the code there. The guard still
// refuses those two (the hidden-code test below), but this test can only compare with what
// real bash does.
const KNOWN_HOLES: [string, string, number?][] = [
  ['PS4 xtrace', "export PS4='$(cp ev/f.md f.md)'; set -x; :"],
  ['PS4 before set -x', "PS4='$(cp ev/f.md f.md) ' && set -x && true"],
  ['PS4 from a name', "X='$(cp ev/f.md f.md)'; PS4=$X; set -x; :"],
  ['arithmetic subscript', "X='a[$(cp ev/f.md f.md)]'; echo $((X))"],
  ['arithmetic command', "X='a[$(cp ev/f.md f.md)]'; ((X))"],
  ['let name', "X='a[$(cp ev/f.md f.md)]'; let X"],
  ['arithmetic $[]', "X='a[$(cp ev/f.md f.md)]'; echo $[X]"],
  ['indirect name', "X='a[$(cp ev/f.md f.md)]'; echo ${!X}"],
  ['loop variable', "for X in 'a[$(cp ev/f.md f.md)]'; do echo $((X)); done"],
  ['printf -v subscript', "printf -v 'a[$(cp ev/f.md f.md)]' %s 1", 4],
  ['test -v subscript', "test -v 'a[$(cp ev/f.md f.md)]'", 4.2],
  ['[[ -v subscript', "[[ -v 'a[$(cp ev/f.md f.md)]' ]]", 4.2],
  ['unquoted heredoc body', ': <<EOF\n$(cp ev/f.md f.md)\nEOF'],
  ['glob becomes an option', 'git log *'],
  ['option-like glob', 'git log --out*'],
  ['quote hides a redirect', `git log --format="%an %ae'$x" > out.txt --invert-grep --grep='"'`],
];

// Commands a reader and bash must agree on: redirects in every spelling, heredocs, quotes,
// braces, arithmetic, substitutions, settings, functions and the everyday shapes.
const DIFF_CORPUS: [string, string][] = [
  ...KNOWN_HOLES.map(([name, command]): [string, string] => [name, command]),
  ['plain write', 'echo hi > out.md'],
  ['append', 'printf x >> f.md'],
  ['clobber', 'echo y >| f.md'],
  ['both streams', 'echo z &> both.md'],
  ['stderr only', 'echo w 2> err.md'],
  ['descriptor is not a file', 'echo hi 2>&1'],
  ['quoted operator is data', 'echo ">" out.md'],
  ['quoted file name', 'echo hi > "q.md"'],
  ['input only', 'cat < f.md'],
  ['input and output', 'cat < f.md > copy.md'],
  ['braces', 'echo {a,b}'],
  ['escaped braces', 'echo \\{a,b\\}'],
  ['dollar single quote', "printf $'x\\n'"],
  ['arithmetic is maths', 'echo $((1+2))'],
  ['nested arithmetic', 'echo $((1+2*3))'],
  ['arithmetic command', '(( i = 1 << 2 ))'],
  ['command substitution', 'echo $(echo hi)'],
  ['backtick', 'echo `echo hi`'],
  ['process substitution', 'echo <(echo hi)'],
  ['quoted substitution is data', "echo '$(echo hi)'"],
  ['double-quoted substitution', 'echo "$(echo hi)"'],
  ['assignment only', 'X=1'],
  ['assignment before a program', 'X=1 echo hi'],
  ['plain PS4', 'PS4=+ set -x; echo hi'],
  ['IFS plain', 'IFS=, printf "%s\\n" a,b > ifs.md'],
  ['function then call', 'f() { echo hi > fun.md; }; f'],
  ['group', '{ echo hi > group.md; }'],
  ['subshell', '( echo hi > sub.md )'],
  ['if', 'if true; then echo hi > if.md; fi'],
  ['pipe to tee', 'echo hi | tee tee.md'],
  ['sort output', 'sort -o sorted.md f.md'],
  ['git output option', 'git log --output=gitout.md'],
  ['nested shell', 'bash -c "echo x > nested.md"'],
  ['nested shell write', "sh -c 'echo x > shell.md'"],
  ['launcher', 'env echo hi'],
  ['cd then write', 'cd sub && echo hi > after-cd.md'],
  ['glob after a separator', 'git log -- *.md'],
  ['quoted glob is a pattern', 'git tag --list "v*"'],
  ['escaped glob is literal', 'echo \\*.md'],
  ['glob input', 'cat *.md > all.md'],
  ['heredoc quoted', "cat > quoted.md <<'EOF'\n$(echo hi)\nEOF"],
  ['heredoc unquoted', 'cat > loose.md <<EOF\n$(echo hi)\nEOF'],
  ['heredoc read', 'cat <<EOF\nhello\nEOF'],
  ['for loop', 'for v in a b; do echo "$v"; done'],
  ['case', 'case x in x) echo hi;; esac'],
];

/** A seeded generator: two fragments joined, with one small mutation (#457). */
function seededCases(count: number, seed: number): [string, string][] {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(items: T[]): T => items[Math.floor(next() * items.length)]!;
  const fragments = [
    'echo hi', 'printf "%s\\n" hi', 'true', ':', 'cat f.md',
    'echo x > out.md', 'printf x >> f.md', 'echo y >| g.md', 'echo z &> h.md', 'echo w 2> i.md',
    'cat < f.md > j.md', 'echo "$(echo hi)"', "echo '$(echo hi)'", 'echo `echo hi`', 'echo <(echo hi)',
    'X=1', "X='a[$(echo hi)]'", 'IFS=,', 'set -x', 'PS4=+',
    'git log --oneline', 'git status', 'git add -- *.md', 'git diff -- *.md',
    'cp ev/f.md out.md', 'tee tee.md < f.md', 'sort -o sorted.md f.md',
    'echo {a,b}', 'echo $((1+2))', 'f() { echo hi; }', 'f', 'cd sub',
    'printf -v X %s hi', 'cat <<EOF\n$(echo hi)\nEOF', "cat <<'EOF'\n$(echo hi)\nEOF",
    'echo $((X))', 'echo ${!X}', 'echo $[1+2]', 'bash -c "echo inner"', 'env echo hi',
  ];
  const cases: [string, string][] = [];
  for (let index = 0; index < count; index++) {
    let command = `${pick(fragments)}${pick(['; ', ' && ', ' | ', '\n'])}${pick(fragments)}`;
    switch (Math.floor(next() * 4)) {
      case 0: command = command.replace('>', '>|'); break;
      case 1: command = command.replace('echo', 'command echo'); break;
      case 2: command = `X=1 ${command}`; break;
      default: command = `${command} 2>/dev/null`;
    }
    cases.push([`seed ${seed} case ${index + 1}`, command]);
  }
  return cases;
}

test("bash differential: the reviewers' known holes are caught when they are put back (#457)", () => {
  const sandbox = makeBashSandbox();
  for (const [name, command, needsBash = 3] of KNOWN_HOLES) {
    // A shape this bash does not run is not a hole here. The guard refuses it anyway.
    if (sandbox.version < needsBash) continue;
    const run = runUnderBash(sandbox, command);
    const caught = disagreements(run, naiveReading(command));
    assert.ok(caught.length > 0, `${name}: a reader that treats single quotes as data was not caught: ${command}`);
    const reading = guardReading(command, run.folder);
    if (reading.decision === null) {
      assert.deepEqual(disagreements(run, reading), [], `${name}: the guard allowed a command it did not fully read: ${JSON.stringify(command)}`);
    }
  }
});

test('bash differential: bash runs and writes only what the guard read, or the guard refuses (#457)', () => {
  const sandbox = makeBashSandbox();
  const seed = Number(process.env.YOKOTEN_DIFF_SEED ?? 457);
  const count = Math.min(Number(process.env.YOKOTEN_DIFF_CASES ?? 60), 2000);
  const cases = [...DIFF_CORPUS, ...seededCases(count, seed)];
  const failures: string[] = [];
  for (const [name, command] of cases) {
    if (!isSafeCase(command)) {
      failures.push(`${name}: unsafe to run in the sandbox: ${JSON.stringify(command)}`);
      continue;
    }
    const run = runUnderBash(sandbox, command);
    const reading = guardReading(command, run.folder);
    if (reading.decision !== null) continue;
    const found = disagreements(run, reading);
    if (found.length > 0) failures.push(`${name}: ${JSON.stringify(command)}\n  ${found.join('\n  ')}`);
  }
  assert.deepEqual(failures, [], `the guard allowed a command bash did more with:\n${failures.join('\n')}`);
});

test('hidden code: a name bash expands later is refused, and plain values pass (#457)', () => {
  for (const command of [
    "export PS4='$(cp ev/f.md f.md)'; set -x; :",
    "X='$(cp ev/f.md f.md)'; PS4=$X; set -x; :",
    "X='a[$(cp ev/f.md f.md)]'; echo $((X))",
    "X='a[$(cp ev/f.md f.md)]'; ((X))",
    "X='a[$(cp ev/f.md f.md)]'; let X",
    "for X in 'a[$(cp ev/f.md f.md)]'; do echo $((X)); done",
    "X='a[$(cp ev/f.md f.md)]'; echo ${!X}",
    "printf -v 'a[$(cp ev/f.md f.md)]' %s 1",
    "test -v 'a[$(cp ev/f.md f.md)]'",
    'a[X]=1',
    'git log *',
    'git log --out*',
    'git log --output=*',
    'git add *.md',
  ]) blocked(command);
  for (const command of [
    'echo $((1+2))',
    'echo $((1<<2))',
    '(( i = 1 << 2 ))',
    'for v in PATH HOME USER; do echo "$v=${!v}"; done',
    "X='a[1]'; echo $((X))",
    'for v in a b; do echo "$v"; done',
    'git add -- *.md',
    'git log -- *.md',
    'git tag --list "v*"',
    'git commit -m "fix * bug"',
    'curl https://example.com/x?y=1',
    'echo ${a:-x}',
    'printf -v X %s hi',
  ]) allowed(command);
});
