// Tests for src/agents/desk/fence/srt.ts: a desk plan turned into sandbox-runtime's
// settings, how srt is found, and that the desk refuses when it can't start (fail closed).
// That the fence holds is checked by the contract test in start.test.ts. The case tables
// for src/platform/process.ts are here too, with its first user.

import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fenceCommand, findSrt, NPX_ARGS, splitHidden, SRT_VERSION, type SrtPlan, srtProblem, srtSettings, trustedPath } from '../../../../src/agents/desk/fence/srt.ts';
import { startOptions, treeKill } from '../../../../src/platform/process.ts';
import { makeTempDir } from '../../../repo/helpers.ts';

const PLAN: SrtPlan = {
  desk: '/work/projects/desk',
  state: ['/work/projects/desk.state/claude-code'],
  readable: ['/opt/node', '/work/projects/[odd]'],
  hidden: ['/home', '/work/projects'],
  locked: ['/work/projects/desk/.git/config', '/work/projects/desk/.git/hooks'],
  hosts: ['api.example.com', 'api.example.com'],
};

test('srtSettings: reads all but the hidden folders, writes only the desk and its state, reaches only the hosts', () => {
  assert.deepEqual(srtSettings(PLAN), {
    network: { allowedDomains: ['api.example.com'], deniedDomains: [], strictAllowlist: true, allowLocalBinding: false },
    filesystem: {
      denyRead: ['/home', '/work/projects'],
      allowRead: ['/work/projects/desk', '/work/projects/desk.state/claude-code', '/opt/node', { path: '/work/projects/[odd]', literal: true }],
      allowWrite: ['/work/projects/desk', '/work/projects/desk.state/claude-code'],
      denyWrite: ['/work/projects/desk/.git/config', '/work/projects/desk/.git/hooks'],
      allowGitConfig: false,
    },
  });
  // A plan with no hosts reaches none: srt reads an empty list as no network.
  assert.deepEqual(srtSettings({ ...PLAN, hosts: [] }).network.allowedDomains, []);
});

test('splitHidden: a hidden folder that holds a readable folder with a writable path inside is hidden child by child (case table)', () => {
  const tree: Record<string, string[]> = {
    '/work/projects': ['desk', 'desk.state', 'origin.team', 'other', 'secret.txt'],
    '/home': ['someone'],
    '/home/someone': ['.ssh', 'work'],
    '/home/someone/work': ['desk', 'team', 'notes'],
  };
  const list = (folder: string) => tree[folder] ?? null;
  const team = { ...PLAN, readable: ['/work/projects/origin.team'], state: [...PLAN.state, '/work/projects/origin.team/outbox/probe.jsonl'] };
  const cases: [string, SrtPlan, string[]][] = [
    ['no team: the plan as it is', PLAN, PLAN.hidden],
    ['a team: the projects folder child by child', team, ['/home', '/work/projects/desk.state', '/work/projects/other', '/work/projects/secret.txt']],
    ['a folder that cannot be listed stays hidden whole', { ...team, hidden: ['/work/projects/unlisted'], readable: ['/work/projects/unlisted/team'], state: ['/work/projects/unlisted/team/outbox/x'] }, ['/work/projects/unlisted']],
    ['two levels down, through the home folder', { ...team, desk: '/home/someone/work/desk', hidden: ['/home', '/home/someone'], readable: ['/home/someone/work/team'], state: ['/home/someone/work/team/outbox/x'] }, ['/home/someone/.ssh', '/home/someone/work/notes']],
  ];
  for (const [name, plan, hidden] of cases) assert.deepEqual(splitHidden(plan, list, 'linux').hidden, hidden, name);
  assert.deepEqual(splitHidden(team, list, 'darwin').hidden, PLAN.hidden, 'macOS: the plan as it is');
});

/** A folder with a program `name` that prints `version` for --version and exits with `code` otherwise. */
function fakeProgram(name: string, version: string, code: number): string {
  const folder = realpathSync(makeTempDir('bin-'));
  const file = join(folder, name);
  writeFileSync(file, `#!${process.execPath}\nif (process.argv[2] === '--version') { console.log(${JSON.stringify(version)}); process.exit(0); }\nconsole.error('Error: socat not installed');\nprocess.exit(${code});\n`);
  chmodSync(file, 0o755);
  return folder;
}

/** A pinned srt in a folder shaped like npx's cache: `<temp>/_npx/<hash>/node_modules/.bin`. */
function npxCache(): string {
  const bin = join(realpathSync(makeTempDir('npm-')), '_npx', '0a1b2c', 'node_modules', '.bin');
  mkdirSync(bin, { recursive: true });
  const file = join(fakeProgram('srt', SRT_VERSION, 0), 'srt');
  writeFileSync(join(bin, 'srt'), readFileSync(file));
  chmodSync(join(bin, 'srt'), 0o755);
  return bin;
}

/** A run table: npx at the pinned version gives `npxGives` as its PATH; each other program really runs, and is logged. */
function runTable(npxGives: string | null, ran: string[] = []) {
  return (file: string, args: string[]) => {
    ran.push(file);
    if (file.endsWith('/npx')) return args.slice(0, NPX_ARGS.length).join(' ') === NPX_ARGS.join(' ') ? npxGives : null;
    return spawnSync(file, args, { encoding: 'utf8' }).stdout;
  };
}

test('findSrt: srt on PATH at the pinned version, else npx at the pinned version, else one line (case table)', () => {
  const pinned = fakeProgram('srt', SRT_VERSION, 0);
  const older = fakeProgram('srt', '0.0.1', 0);
  const npx = fakeProgram('npx', '', 0);
  const cache = npxCache();
  const project = [realpathSync(makeTempDir('project-'))];
  assert.equal(findSrt({ PATH: pinned }, 'linux', project, runTable(null)), join(pinned, 'srt'), 'the pinned one on PATH');
  assert.equal(findSrt({ PATH: `${older}:${npx}` }, 'darwin', project, runTable(cache)), join(cache, 'srt'), 'another version on PATH: npx');
  assert.equal(findSrt({ PATH: npx }, 'linux', project, runTable(`/usr/bin:${cache}`)), join(cache, 'srt'), 'none on PATH: npx');
  const offline = findSrt({ PATH: `${older}:${npx}` }, 'linux', project, runTable(null));
  assert.match((offline as { problem: string }).problem, /^the sandbox \(sandbox-runtime 0\.0\.81\) can't start here: npx can't get @anthropic-ai\/sandbox-runtime@0\.0\.81; .*Nothing was started\.$/);
  assert.match((findSrt({ PATH: older }, 'linux', project, runTable(cache)) as { problem: string }).problem, /npx can't get/, 'no npx on PATH: one line');
  assert.match((findSrt({ PATH: npx }, 'linux', project, runTable(older)) as { problem: string }).problem, /npx gave no srt 0\.0\.81/);
  assert.match((findSrt({ PATH: npx }, 'linux', project, runTable(pinned)) as { problem: string }).problem, /npx gave no srt 0\.0\.81/, 'npx gave a PATH folder that is not its cache');
});

test('findSrt: an srt the project planted is never chosen, nor run (positive control)', () => {
  const project = realpathSync(makeTempDir('project-'));
  mkdirSync(join(project, '.git'));
  const planted = join(project, 'node_modules', '.bin');
  mkdirSync(planted, { recursive: true });
  writeFileSync(join(planted, 'srt'), readFileSync(join(fakeProgram('srt', SRT_VERSION, 0), 'srt')));
  chmodSync(join(planted, 'srt'), 0o755);
  const npx = fakeProgram('npx', '', 0);
  const desk = join(project, 'desk');
  mkdirSync(desk);
  // Any node_modules/.bin, even outside the project; and a folder inside the checkout, found from the desk.
  const elsewhere = join(realpathSync(makeTempDir('other-')), 'node_modules', '.bin');
  mkdirSync(elsewhere, { recursive: true });
  writeFileSync(join(elsewhere, 'srt'), readFileSync(join(planted, 'srt')));
  chmodSync(join(elsewhere, 'srt'), 0o755);
  const inside = join(project, 'tools');
  mkdirSync(inside);
  writeFileSync(join(inside, 'srt'), readFileSync(join(planted, 'srt')));
  chmodSync(join(inside, 'srt'), 0o755);
  for (const [name, path] of [['the project node_modules/.bin', planted], ['another node_modules/.bin', elsewhere], ['a folder in the checkout', inside]] as const) {
    const ran: string[] = [];
    const found = findSrt({ PATH: `${path}:${npx}` }, 'linux', [desk], runTable(null, ran));
    assert.equal(typeof found, 'object', `${name}: refused`);
    assert.ok(!ran.some((file) => file.startsWith(path)), `${name}: never run`);
  }
  // npx's PATH carries the project's node_modules/.bin first: only npx's own cache counts.
  const cache = npxCache();
  assert.equal(findSrt({ PATH: npx }, 'linux', [desk], runTable(`${planted}:${cache}`)), join(cache, 'srt'), 'npx: the cache, not the project');
  assert.equal(typeof findSrt({ PATH: npx }, 'linux', [desk], runTable(`${planted}:${join(project, '_npx', '0a1b2c', 'node_modules', '.bin')}`)), 'object', 'a cache-shaped folder inside the project');
  // The lead's own PATH dropping the project folders.
  assert.equal(trustedPath(`${planted}:relative:${npx}:${inside}`, [desk], false), npx);
});

test('srtProblem: srt that fails to start gives its first line; one that starts gives null', () => {
  const settings = realpathSync(makeTempDir('fence-'));
  const broken = join(fakeProgram('srt', SRT_VERSION, 1), 'srt');
  assert.equal(srtProblem(broken, {}, settings), "the sandbox (sandbox-runtime 0.0.81) can't start here: Error: socat not installed. Nothing was started.");
  assert.match(srtProblem(join(settings, 'missing'), {}, makeTempDir('fence-')) ?? '', /can't run .*missing \(ENOENT\)/);
  assert.equal(srtProblem(join(fakeProgram('srt', SRT_VERSION, 0), 'srt'), {}, makeTempDir('fence-')), null);
  // The probe's settings: no network, no writes outside its own folder, and read-only.
  const written = JSON.parse(readFileSync(join(settings, 'srt-probe.json'), 'utf8'));
  assert.deepEqual(written.network.allowedDomains, []);
});

test('fenceCommand: native Windows gets the guard and WSL; a fence that cannot start refuses (fail closed)', () => {
  const spec = { root: '/work/desk', writable: [], network: ['api.example.com'] };
  assert.deepEqual(fenceCommand(spec, ['agent'], 'win32', {}), { command: ['agent'], fence: 'guard', notice: 'fence  none on native Windows: only the guard holds the rules. Run yokoten in WSL, where the desk has a sandbox.' });
  assert.throws(() => fenceCommand(spec, ['agent'], 'linux', { PATH: '' }), /^Error: the sandbox \(sandbox-runtime 0\.0\.81\) can't start here: npx can't get/);
  const broken = fakeProgram('srt', SRT_VERSION, 1);
  assert.throws(() => fenceCommand(spec, ['agent'], 'darwin', { PATH: broken }), /can't start here: Error: socat not installed\. Nothing was started\./);
  assert.throws(() => fenceCommand(spec, ['agent'], 'linux', { YOKOTEN_FENCE: 'own' }), /YOKOTEN_FENCE=own runs only through `yokoten desk/);
});

const real = findSrt(process.env, process.platform, [process.cwd()]);
const reason = typeof real === 'string' ? srtProblem(real, process.env, makeTempDir('fence-')) : real.problem;

test('fenceCommand: with srt here, the command writes in the root and nowhere else', { skip: (process.platform === 'win32' && 'no srt fence on native Windows') || reason || false }, () => {
  const projects = realpathSync(makeTempDir('projects-'));
  const root = join(projects, 'desk');
  mkdirSync(join(root, '.git'), { recursive: true });
  const fenced = fenceCommand({ root, writable: [], network: [] }, [process.execPath, '-e', `require('fs').writeFileSync('in.txt', 'x'); try { require('fs').writeFileSync(${JSON.stringify(join(projects, 'out.txt'))}, 'x'); } catch {}`], process.platform, process.env);
  assert.equal(fenced.fence, 'system');
  assert.match(fenced.notice, /^fence {2}sandbox-runtime 0\.0\.81 \(Anthropic, Apache-2\.0\): writes only the desk; reaches no host only$/);
  const ran = spawnSync(fenced.command[0], fenced.command.slice(1), { cwd: root, encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
  assert.ok(existsSync(join(root, 'in.txt')), 'a write in the root works');
  assert.ok(!existsSync(join(projects, 'out.txt')), 'a write next to it never reaches the disk');
});

test('startOptions and treeKill: no shell; a group to end at once on Linux and macOS, taskkill on Windows (case table)', () => {
  const cases: [NodeJS.Platform, boolean, ReturnType<typeof startOptions>, ReturnType<typeof treeKill>][] = [
    ['linux', true, { shell: false, detached: true, windowsHide: false }, { kind: 'signal', pid: -42, signal: 'SIGTERM' }],
    ['linux', false, { shell: false, detached: false, windowsHide: false }, { kind: 'signal', pid: 42, signal: 'SIGTERM' }],
    ['darwin', true, { shell: false, detached: true, windowsHide: false }, { kind: 'signal', pid: -42, signal: 'SIGTERM' }],
    ['win32', true, { shell: false, detached: false, windowsHide: true }, { kind: 'run', file: 'taskkill', args: ['/PID', '42', '/T', '/F'] }],
  ];
  for (const [platform, group, options, kill] of cases) {
    assert.deepEqual(startOptions(platform, group), options, `${platform} start`);
    assert.deepEqual(treeKill(42, 'SIGTERM', platform, group), kill, `${platform} kill`);
  }
});
