// Tests for src/commands/tidy/tidy.ts: the three screens, on a real repo (issue #1055).

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { makeSandbox, makeTempDir, runChild } from '../../repo/helpers.ts';
import { formatSize } from '../../../src/commands/tidy/tidy.ts';
import type { TrashIndex } from '../../../src/commands/tidy/put-away.ts';
import { tidyStateDir } from '../../../src/commands/tidy/find.ts';

const DAY = 24 * 60 * 60 * 1000;

/** Every file, folder and link under `roots`: path, mode, change time and content. */
function snapshot(...roots: string[]): string[] {
  const lines: string[] = [];
  const walk = (path: string) => {
    const entry = lstatSync(path);
    if (entry.isSymbolicLink()) lines.push(`${path} -> ${readlinkSync(path)}`);
    else if (entry.isDirectory()) {
      lines.push(`${path}/ ${entry.mode} ${entry.mtimeMs}`);
      for (const name of readdirSync(path).sort()) walk(join(path, name));
    } else lines.push(`${path} ${entry.mode} ${entry.mtimeMs} ${createHash('sha256').update(readFileSync(path)).digest('hex')}`);
  };
  roots.forEach(walk);
  return lines;
}

/** Set every change time under `path` to `days` ago, as if nobody touched it since. */
function age(path: string, days: number): void {
  const when = new Date(Date.now() - days * DAY);
  const walk = (current: string) => {
    const entry = lstatSync(current);
    if (entry.isSymbolicLink()) return;
    if (entry.isDirectory()) for (const name of readdirSync(current)) walk(join(current, name));
    utimesSync(current, when, when);
  };
  walk(path);
}

/**
 * A repo with one of each: a merged branch, a squash-merged branch whose remote branch is
 * gone, an open branch, a merged worktree with changes, a merged worktree at a long path, a
 * merged desk with its logs, a desk in use, and the logs of a gone desk. All two days quiet
 * but the desk in use.
 */
function makeMessyRepo() {
  const sandbox = makeSandbox();
  const { repo, git } = sandbox;
  const base = dirname(repo);
  const ok = (...args: string[]) => {
    const result = git(...args);
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const remote = join(base, 'remote.git');
  assert.equal(runChild('git', ['init', '-q', '--bare', '-b', 'main', remote], { env: sandbox.env }).status, 0);
  sandbox.write('a.txt', 'one\n');
  ok('add', 'a.txt');
  ok('commit', '-q', '-m', 'start');
  ok('remote', 'add', 'origin', remote);
  ok('branch', 'merged-one');
  sandbox.write('a.txt', 'two\n');
  ok('commit', '-q', '-am', 'second');
  ok('push', '-q', 'origin', 'main', 'merged-one');
  ok('remote', 'set-head', 'origin', 'main');
  // Squash-merged: pushed, then its remote branch deleted, as a merged pull request does.
  ok('checkout', '-q', '-b', 'gone-one');
  sandbox.write('b.txt', 'squashed work\n');
  ok('add', 'b.txt');
  ok('commit', '-q', '-m', 'work');
  ok('push', '-q', '-u', 'origin', 'gone-one');
  ok('checkout', '-q', 'main');
  ok('push', '-q', 'origin', '--delete', 'gone-one');
  ok('fetch', '-q', '--prune');
  ok('branch', 'open-one', 'main');
  ok('checkout', '-q', 'open-one');
  sandbox.write('c.txt', 'open work\n');
  ok('add', 'c.txt');
  ok('commit', '-q', '-m', 'open');
  ok('checkout', '-q', 'main');
  // A merged worktree, with a change and a new file not committed.
  const done = join(base, 'wt-done');
  ok('worktree', 'add', '-q', '--detach', done, 'main');
  writeFileSync(join(done, 'a.txt'), 'changed here\n');
  writeFileSync(join(done, 'new.txt'), 'only here\n');
  // A worktree with a long name, deep down: a short name in the trash. Its path stays near
  // 170 characters: on Windows, git itself refuses a worktree past about 210 ("'$GIT_DIR' too
  // big", "Filename too long"), so no one there has a longer one for tidy to find.
  const long = join(base, 'l'.repeat(20), 'o'.repeat(20), `wt-${'n'.repeat(50)}`);
  mkdirSync(dirname(long), { recursive: true });
  ok('worktree', 'add', '-q', '--detach', long, 'main');
  // Desks: plain clones that yokoten desk marked, beside the repo.
  const desks = join(base, 'repo-desks');
  const desk = (name: string) => {
    const path = join(desks, name);
    assert.equal(runChild('git', ['clone', '-q', repo, path], { env: sandbox.env }).status, 0);
    writeFileSync(join(path, '.git', 'yokoten-desk'), 'a desk\n');
    mkdirSync(join(`${path}.state`, 'claude-code', 'projects'), { recursive: true });
    writeFileSync(join(`${path}.state`, 'claude-code', 'projects', 'log.jsonl'), '{}\n');
    return path;
  };
  const deskDone = desk('desk-7');
  const deskBusy = desk('desk-8');
  mkdirSync(join(desks, 'desk-gone.state', 'codex'), { recursive: true });
  writeFileSync(join(desks, 'desk-gone.state', 'codex', 'log.jsonl'), '{}\n');
  age(base, 2);
  // The desk in use: its agent wrote its status file a minute ago.
  writeFileSync(join(deskBusy, '.yokoten-agent.json'), '{"state":"working"}\n');
  return { ...sandbox, base, ok, done, long, deskDone, deskBusy, desks };
}

/** The trash folder under a sandbox home, where tidy puts it on this system (#1109). */
const trashIn = (home: string): string => join(tidyStateDir({ HOME: home, USERPROFILE: home }, process.platform), 'trash');

/** The one trash folder a run made, and its index. */
function readOnlyTrash(home: string): { folder: string; index: TrashIndex } {
  const trash = trashIn(home);
  const names = readdirSync(trash);
  assert.equal(names.length, 1, `one trash folder: ${names.join(', ')}`);
  assert.match(names[0], /^\d{4}-\d{2}-\d{2}T\d{6}Z$/);
  const folder = join(trash, names[0]);
  return { folder, index: JSON.parse(readFileSync(join(folder, 'index.json'), 'utf8')) };
}

test('tidy: alone it lists by what you can do, with why and size, and leaves every byte as it was (#1055)', async () => {
  const messy = makeMessyRepo();
  const before = snapshot(messy.base);
  const result = await messy.call(['tidy']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(snapshot(messy.base), before, 'a bare tidy writes nothing, not even the index');
  const text = result.stdout;
  assert.match(text, /^yokoten tidy · 6 to put away, .+; nothing was changed\n/);
  // A group's rows, each joined onto one line again.
  const group = (heading: string) => {
    const lines = text.split('\n');
    const from = lines.indexOf(heading) + 1;
    const length = lines.slice(from).findIndex((line) => /^\S/.test(line));
    return lines.slice(from, length === -1 ? undefined : from + length).join('\n').replace(/\n\s*\n {26}/g, ' ').replace(/\n {26}/g, ' ');
  };
  const putAway = group('Can put away:');
  assert.match(putAway, /branch +merged-one: merged into the main branch, and no change for a day; no commit of its own\./);
  assert.match(putAway, /desk +desk-7 at .*repo-desks[\\/]desk-7: merged into the main branch/);
  assert.match(putAway, /logs +desk-gone\.state at .*: its desk is gone; 3 B\./);
  assert.match(putAway, /worktree +wt-n{50} at .*o{20}[\\/]wt-n{50}: merged/);
  const saved = group('Can put away with a saved copy:');
  assert.match(saved, /branch +gone-one: its branch on the remote is gone, but 1 commit on no remote; 1 commit not in the main branch\./);
  assert.match(saved, /worktree +wt-done at .*: merged into the main branch, and no change for a day, but changes not committed; \d+ B\./);
  assert.match(group('In use, never touched:'), /desk +desk-8 at .*: it changed \d+ min ago; /);
  assert.match(group('On the remote, only listed:'), /branch +origin\/merged-one: merged into origin\/main/);
  assert.match(text, /ok +in work +1 more thing still in work: tidy leaves them\./);
  assert.doesNotMatch(text, /open-one/, 'an open branch is not listed');
  assert.match(text, /\nNext: `yokoten tidy --local`\n$/);
  // A line is over 80 columns only for one word that can't break: a long name or path.
  for (const line of text.split('\n')) assert.ok(line.length <= 80 || Math.max(...line.trim().split(/\s+/).map((word) => word.length)) > 50, `within 80 columns: ${line}`);
});

test('tidy --json: the facts the list is built from, and --json with --local or --empty is refused (#1115)', async () => {
  const messy = makeMessyRepo();
  const before = snapshot(messy.base);
  const listed = await messy.call(['tidy', '--json']);
  assert.equal(listed.status, 0, listed.stderr);
  const data = JSON.parse(listed.stdout) as { items: { name: string; judged: { verdict: string } }[]; remote: unknown[]; trash: unknown[] };
  assert.ok(data.items.some((item) => item.name === 'merged-one' && item.judged.verdict === 'old'));
  assert.ok(Array.isArray(data.remote) && Array.isArray(data.trash));
  assert.deepEqual(snapshot(messy.base), before, '--json writes nothing');
  const refused = await messy.call(['tidy', '--json', '--local']);
  assert.equal(refused.status, 1);
  assert.deepEqual(snapshot(messy.base), before);
});

test('tidy --local: saves, then moves; the bundle and the patch bring the work back; a desk in use stays (#1055)', async () => {
  const messy = makeMessyRepo();
  const goneHead = messy.ok('rev-parse', 'gone-one');
  // The index keeps real paths: on macOS the temp folder is a link (/var to /private/var), and
  // a Windows runner's temp folder has a short (8.3) name.
  const realBase = realpathSync.native(messy.base);
  const real = (path: string) => realBase + path.slice(messy.base.length);
  const result = await messy.call(['tidy', '--local']);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /^yokoten tidy --local · put away 6 things in\s+~[\\/](?:\.local[\\/]state|AppData[\\/]Local)[\\/]yokoten[\\/]trash[\\/]/);
  // Moved: the old branches, the worktrees and their git folders, the desk and its logs.
  assert.equal(messy.git('rev-parse', '-q', '--verify', 'refs/heads/merged-one').status, 1);
  assert.equal(messy.git('rev-parse', '-q', '--verify', 'refs/heads/gone-one').status, 1);
  for (const path of [messy.done, messy.long, messy.deskDone, `${messy.deskDone}.state`, join(messy.desks, 'desk-gone.state')]) assert.equal(existsSync(path), false, path);
  assert.doesNotMatch(messy.ok('worktree', 'list'), /wt-/);
  // Kept: the open branch, the desk in use, main and its files; the remote is not touched.
  assert.ok(messy.ok('rev-parse', 'open-one'));
  assert.ok(existsSync(join(messy.deskBusy, '.yokoten-agent.json')));
  assert.equal(readFileSync(join(messy.repo, 'a.txt'), 'utf8'), 'two\n');
  assert.match(runChild('git', ['ls-remote', join(messy.base, 'remote.git')], { env: messy.env }).stdout, /refs\/heads\/merged-one/);

  const { folder, index } = readOnlyTrash(messy.home);
  assert.equal(index.items.length, 6);
  assert.ok(index.items.every((item) => item.isMoved && item.restore.length > 0));
  assert.ok(Math.abs(Date.parse(index.created) - Date.now()) < 60_000);
  const longEntry = index.items.find((item) => item.from === real(messy.long));
  assert.ok(longEntry && longEntry.moves.every((move) => move.to.length < 80), 'a long path gets a short name in the trash');

  // The positive control of the bundle: a new, empty repo gets the squash-merged commit back.
  const gone = index.items.find((item) => item.name === 'gone-one');
  assert.ok(gone?.bundle);
  const fresh = makeTempDir('yokoten-restore-');
  assert.equal(runChild('git', ['init', '-q', fresh], { env: messy.env }).status, 0);
  assert.equal(runChild('git', ['fetch', '-q', join(folder, gone.bundle), 'gone-one:gone-one'], { cwd: fresh, env: messy.env }).status, 0);
  assert.equal(runChild('git', ['rev-parse', 'gone-one'], { cwd: fresh, env: messy.env }).stdout.trim(), goneHead);
  assert.equal(runChild('git', ['show', 'gone-one:b.txt'], { cwd: fresh, env: messy.env }).stdout, 'squashed work\n');

  // The positive control of the patch: a new checkout at the same commit gets both changes back.
  const done = index.items.find((item) => item.from === real(messy.done));
  assert.ok(done?.patch);
  const again = join(messy.base, 'restored');
  messy.ok('worktree', 'add', '-q', '--detach', again, done.head);
  const applied = runChild('git', ['apply', '--index', join(folder, done.patch)], { cwd: again, env: messy.env });
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(readFileSync(join(again, 'a.txt'), 'utf8'), 'changed here\n');
  assert.equal(readFileSync(join(again, 'new.txt'), 'utf8'), 'only here\n');
  // And the folder itself is in the trash too, as it was.
  const tree = done.moves.find((move) => move.to.endsWith('tree'));
  assert.ok(tree);
  assert.equal(readFileSync(join(folder, tree.to, 'new.txt'), 'utf8'), 'only here\n');

  // A second run finds nothing more, and makes no second trash folder.
  const second = await messy.call(['tidy', '--local']);
  assert.match(second.stdout, /nothing to put away; nothing was changed/);
  readOnlyTrash(messy.home);
});

test('tidy --local: when one save fails, nothing at all is moved (#1055)', async () => {
  const messy = makeMessyRepo();
  // One more gone branch, sorted last, so the others are saved first. Its commit's object is
  // gone, so its bundle can't be made.
  const head = messy.ok('commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'lost');
  messy.ok('update-ref', 'refs/heads/zz-broken', head);
  messy.ok('config', 'branch.zz-broken.remote', 'origin');
  messy.ok('config', 'branch.zz-broken.merge', 'refs/heads/zz-broken');
  unlinkSync(join(messy.repo, '.git', 'objects', head.slice(0, 2), head.slice(2)));
  age(join(messy.repo, '.git'), 2);
  // The home folder gets the empty trash folder; everything else stays as it was.
  const outsideHome = () => snapshot(messy.base).filter((line) => !line.startsWith(messy.home));
  const before = outsideHome();
  const result = await messy.call(['tidy', '--local']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^yokoten tidy · saving zz-broken failed, so nothing was moved: git bundle failed[^]*\n\nNext: `yokoten tidy`\n$/);
  assert.deepEqual(outsideHome(), before, 'nothing moved, the merged branch included');
  assert.deepEqual(readdirSync(trashIn(messy.home)), [], 'the half-made trash folder is gone');
});

test('tidy --empty: deletes only trash over 7 days old, after one question; no terminal needs --yes (#1055)', async () => {
  const sandbox = makeSandbox();
  const trash = trashIn(sandbox.home);
  const put = (name: string, days: number) => {
    mkdirSync(join(trash, name, 'items'), { recursive: true });
    writeFileSync(join(trash, name, 'items', 'file'), 'x'.repeat(2048));
    writeFileSync(join(trash, name, 'index.json'), indexOf(days));
  };
  const indexOf = (days: number) => JSON.stringify({ version: 1, created: new Date(Date.now() - days * DAY).toISOString(), repo: '', items: [] });
  put('2026-10-10T000000Z', 8);
  put('2026-10-20T000000Z', 6);
  // Not tidy's: no index, an index with no time, and a link to a folder outside.
  mkdirSync(join(trash, 'no-index'));
  age(join(trash, 'no-index'), 30);
  mkdirSync(join(trash, 'no-time'));
  writeFileSync(join(trash, 'no-time', 'index.json'), '{}');
  const outside = makeTempDir('yokoten-outside-');
  writeFileSync(join(outside, 'index.json'), JSON.stringify({ created: new Date(Date.now() - 30 * DAY).toISOString() }));
  symlinkSync(outside, join(trash, 'a-link'));
  const left = () => readdirSync(trash).sort();
  const all = left();
  // Files only: the 2 KB file and the index; a folder counts 0 on every file system.
  const size = formatSize(2048 + Buffer.byteLength(indexOf(8)));

  const piped = await sandbox.call(['tidy', '--empty']);
  assert.equal(piped.status, 1);
  assert.ok(piped.stdout.startsWith(`yokoten tidy --empty · 1 trash folder over 7 days old, ${size}\n\n`), piped.stdout);
  assert.match(piped.stdout, /\n\n +next +trash +2026-10-10T000000Z: [\d.]+ KB, put away \d{4}-\d{2}-\d{2}\.\n/);
  assert.match(piped.stderr, /^yokoten tidy · --empty asks before it deletes, and there is no terminal to ask\n +in\. Nothing was deleted\n\nNext: run it in a terminal, or add `--yes`\n$/);
  assert.deepEqual(left(), all);

  const no = await sandbox.call(['tidy', '--empty'], { isTTY: true, input: 'n\n', extra: { NO_COLOR: '1' } });
  assert.equal(no.status, 0);
  assert.ok(no.stdout.includes(`Delete 1 folder (${size}) for good? [Y/n] `), no.stdout);
  assert.match(no.stdout, /\[Y\/n\] +ok +trash +nothing was deleted\./);
  assert.deepEqual(left(), all);

  const enter = await sandbox.call(['tidy', '--empty'], { isTTY: true, input: '\n', extra: { NO_COLOR: '1' } });
  assert.match(enter.stdout, /nothing was deleted\./, 'Enter alone deletes nothing');
  assert.deepEqual(left(), all);

  const yes = await sandbox.call(['tidy', '--empty'], { isTTY: true, input: 'y\n', extra: { NO_COLOR: '1' } });
  assert.equal(yes.status, 0, yes.stderr);
  assert.match(yes.stdout, /done +trash +deleted 1 folder/);
  assert.deepEqual(left(), all.filter((name) => name !== '2026-10-10T000000Z'));
  assert.ok(existsSync(join(outside, 'index.json')), 'a link is never followed');

  put('2026-10-01T000000Z', 25);
  const forced = await sandbox.call(['tidy', '--empty', '--yes']);
  assert.equal(forced.status, 0);
  assert.deepEqual(left(), all.filter((name) => name !== '2026-10-10T000000Z'));
  const nothing = await sandbox.call(['tidy', '--empty']);
  assert.match(nothing.stdout, /^yokoten tidy --empty · nothing in the trash is over 7 days old; nothing was\s+deleted\n/);
  rmSync(join(trash, 'a-link'));
});

test('tidy: the words it does not take are refused, and outside a repo it says so (#1055)', async () => {
  const sandbox = makeSandbox();
  const bad = await sandbox.call(['tidy', '--everything']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /^yokoten tidy · unknown option --everything\n/);
  assert.match((await sandbox.call(['tidy', '--local', '--empty'])).stderr, /--local and --empty run one at a time/);
  assert.match((await sandbox.call(['tidy', '--yes'])).stderr, /--yes goes with --empty/);
  const outside = makeTempDir('yokoten-no-repo-');
  writeFileSync(join(outside, '.git'), 'not a checkout\n');
  const lost = await sandbox.call(['tidy'], { cwd: outside });
  assert.equal(lost.status, 1);
  assert.match(lost.stderr, /^yokoten tidy · /);
});

test('tidy: sizes read as a person reads them (#1055)', () => {
  assert.deepEqual([0, 900, 2048, 1536, 15 * 1024 * 1024, 3.4 * 1024 ** 3].map(formatSize), ['0 B', '900 B', '2.0 KB', '1.5 KB', '15 MB', '3.4 GB']);
});
