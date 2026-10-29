// Tests for src/commands/more/advice/doctor.ts.

import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { test } from 'node:test';
import { CLI, makeSandbox, pick, stopCheckoutWalk } from '../../../repo/helpers.ts';
import { underMark } from '../../../repo/docs/screen-rules.ts';
import { problemRows, runDoctor, sessionNoteBlocks, sessionScreen } from '../../../../src/commands/more/advice/doctor.ts';
import type { Invocation, Output } from '../../../../src/commands/shared.ts';
import { machineChecks } from '../../../../src/setup/doctor/checks.ts';
import { fillMarks, machineMarks, paths } from '../../../../src/setup/install.ts';

// What Codex and Gemini CLI hear at a session start: they don't filter command output (#390), as a note (#1099).
const UNFILTERED_NOTE = [
  'yokoten: only Claude Code hides your details in command output; other agents',
  '         show it as it is',
  '',
  '  Next      To stop those commands there instead, set "privacy": { "output":',
  '            "stop" } in yokoten.json.',
].join('\n');

// Codex adds a SessionStart hook's plain stdout to the context; Gemini CLI reads JSON only (#211).
test('doctor --session --agent: plain text for Codex, hookSpecificOutput JSON for Gemini CLI (#211)', async () => {
  const sandbox = makeSandbox();
  // The entry, through the real binary; the rest runs in this process.
  const plain = sandbox.run(['doctor', '--session']);
  assert.match(plain.stdout, /^yokoten: stage 1 of 5/);
  // Codex and Gemini CLI also hear that they don't filter command output (#390).
  const unfiltered = `\n${UNFILTERED_NOTE}\n`;
  assert.deepEqual(pick(await sandbox.call(['doctor', '--session', '--agent', 'codex'])), [plain.status, plain.stdout + unfiltered, plain.stderr]);
  const result = await sandbox.call(['doctor', '--session', '--agent', 'gemini']);
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(out), ['hookSpecificOutput']);
  assert.deepEqual(Object.keys(out.hookSpecificOutput), ['additionalContext']);
  assert.equal(out.hookSpecificOutput.additionalContext, (plain.stdout + unfiltered).trimEnd());
  assert.ok(!result.stdout.includes(sandbox.home), 'output shows the home path');
  // Outside a repo there is nothing to say, and no JSON either. A stop marker keeps the
  // walk from finding the repo around this folder when TMPDIR lives inside one.
  stopCheckoutWalk(sandbox.home);
  assert.equal((await sandbox.call(['doctor', '--session', '--agent', 'gemini'], { cwd: sandbox.home })).stdout, '');
  assert.equal((await sandbox.call(['doctor', '--session', '--agent', 'cursor'])).status, 1);
});

test('doctor --session: a desk names the real model and vendor first, and the board keeps the model (#748)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('yokoten.json', '{}\n');
  const identity = 'yokoten: you are DeepSeek (deepseek-flash), served through codex; codex is your harness, and what it says about its own maker is the tool, not you.';
  const out = (await sandbox.call(['doctor', '--session', '--agent', 'codex'], { extra: { YOKOTEN_MODEL: 'deepseek-flash', YOKOTEN_VENDOR: 'DeepSeek' } })).stdout;
  assert.equal(out.split('\n\n')[0]?.replace(/\n +/g, ' '), identity, 'the brief starts with who the agent is');
  assert.equal(JSON.parse(readFileSync(join(sandbox.repo, '.yokoten-agent.json'), 'utf8')).model, 'deepseek-flash', 'the board reads the real model');
  // A model of the harness's own vendor needs no line: its prompt already tells the truth.
  const own = (await sandbox.call(['doctor', '--session', '--agent', 'codex'], { extra: { YOKOTEN_MODEL: 'gpt-6.1-sol', YOKOTEN_VENDOR: 'OpenAI' } })).stdout;
  assert.ok(!own.includes('you are'), 'no identity line for the harness own vendor');
});

test('doctor --session: an agent that cannot filter output hears it once, with the opt-in (#390)', async () => {
  const sandbox = makeSandbox();
  const line = UNFILTERED_NOTE;
  assert.ok((await sandbox.call(['doctor', '--session', '--agent', 'codex'])).stdout.includes(line));
  assert.ok(!(await sandbox.call(['doctor', '--session'])).stdout.includes(line), 'Claude Code filters it');
  sandbox.write('yokoten.json', JSON.stringify({ privacy: { output: 'stop' } }));
  assert.ok(!(await sandbox.call(['doctor', '--session', '--agent', 'codex'])).stdout.includes(line), 'opted in to the stop');
});

test('doctor --session: after a compaction, Claude Code hears only what changed (#405)', async () => {
  const sandbox = makeSandbox();
  const today = (await sandbox.call(['doctor', '--session'])).stdout;
  const hook = { CLAUDE_PROJECT_DIR: sandbox.repo };
  const start = async (event: Record<string, string>) => (await sandbox.call(['doctor', '--session'], { input: JSON.stringify({ hook_event_name: 'SessionStart', ...event }), extra: hook })).stdout;
  assert.equal(await start({ session_id: 's-1', source: 'startup' }), today, 'a first start prints as today');
  assert.equal(await start({ session_id: 's-1', source: 'compact' }), '', 'a compaction start with nothing new prints nothing');
  sandbox.write('AGENTS.md', '# rules\n');
  const changed = await start({ session_id: 's-1', source: 'compact' });
  assert.match(changed, /^yokoten: stage 1 of 5, safety net\n\n  Next      No tool-call guard/);
  assert.match(changed, /^Tell the user in plain words/m, 'a changed step keeps its offer line');
  assert.doesNotMatch(changed, /private-marks/, 'a note the session heard is not repeated');
  // No session id, or no hook: as today.
  assert.equal(await start({ source: 'compact' }), (await sandbox.call(['doctor', '--session'])).stdout);
  assert.equal((await sandbox.call(['doctor', '--session'], { input: JSON.stringify({ session_id: 's-1', source: 'compact' }) })).stdout, (await sandbox.call(['doctor', '--session'])).stdout, 'stdin is read only in a Claude Code hook');
});

test('doctor --session: a stdin pipe left open never holds the session start (#405)', async () => {
  const sandbox = makeSandbox();
  const today = (await sandbox.call(['doctor', '--session'])).stdout;
  // Like a hook runner that writes the event, or nothing, and never closes stdin.
  const start = (event?: Record<string, string>) =>
    new Promise<{ code: number | null; stdout: string }>((done, failed) => {
      const child = spawn('node', [CLI, 'doctor', '--session'], { cwd: sandbox.repo, env: { ...sandbox.env, CLAUDE_PROJECT_DIR: sandbox.repo }, stdio: ['pipe', 'pipe', 'ignore'] });
      let stdout = '';
      child.stdout.on('data', (chunk) => (stdout += chunk));
      const timer = setTimeout(() => {
        child.kill();
        failed(new Error('doctor --session waited on an open stdin'));
      }, 15_000);
      child.on('exit', (code) => {
        clearTimeout(timer);
        child.stdin.destroy();
        done({ code, stdout });
      });
      if (event) child.stdin.write(JSON.stringify(event));
    });
  assert.deepEqual(await start(), { code: 0, stdout: today }, 'no event: everything, as today');
  assert.deepEqual(await start({ session_id: 's-open', source: 'startup' }), { code: 0, stdout: today });
  assert.deepEqual(await start({ session_id: 's-open', source: 'compact' }), { code: 0, stdout: '' }, 'the event is read without an end of input');
});

test('doctor --session: a worker hears that lead-only files are guarded; the lead hears nothing (#402)', async () => {
  const sandbox = makeSandbox();
  const line = 'yokoten: this session is a worker: lead-only files are guarded.';
  const has = (result: { stdout: string }) => result.stdout.split('\n').includes(line);
  assert.ok(has(await sandbox.call(['doctor', '--session'], { extra: { YOKOTEN_ROLE: 'worker' } })), 'YOKOTEN_ROLE=worker');
  assert.ok(!has(await sandbox.call(['doctor', '--session'])), 'the lead');
  assert.ok(!has(await sandbox.call(['doctor', '--all'], { extra: { YOKOTEN_ROLE: 'worker' } })), 'only at session start');
  // A compaction drops what the session heard, never the worker's role (#405).
  const start = (source: string) => sandbox.call(['doctor', '--session'], { extra: { YOKOTEN_ROLE: 'worker', CLAUDE_PROJECT_DIR: sandbox.repo }, input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'w-1', source }) });
  assert.ok(has(await start('startup')));
  assert.ok(has(await start('compact')), 'after a compaction too');
});

// #561, #1039: full doctor says one note while the slow reads run, to a person at a terminal
// only, on stderr. A session never reads the server, and --json keeps stdout to the report.
test('doctor: one progress note on a terminal; none off it, in a session, or with --json (#561, #1039)', async () => {
  const sandbox = makeSandbox();
  const kept = (isTTY: boolean | undefined) => {
    const chunks: string[] = [];
    const stream = new Writable({ write(chunk, _, done) { chunks.push(String(chunk)); done(); } });
    if (isTTY !== undefined) (stream as Writable & { isTTY: boolean }).isTTY = isTTY;
    return { stream: stream as Output, text: () => chunks.join('') };
  };
  const run = async (isTTY: boolean | undefined, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
    const stdout = kept(isTTY);
    const stderr = kept(undefined);
    const input = Object.assign(Readable.from(['']), isTTY === undefined ? {} : { isTTY });
    const invocation: Invocation = { command: 'doctor', args, env: { ...sandbox.env }, cwd: sandbox.repo, stdout: stdout.stream, stderr: stderr.stream, stdin: { fd: null, text: '', stream: input }, script: CLI };
    return { code: await runDoctor(invocation), stdout: stdout.text(), stderr: stderr.text() };
  };
  const note = 'note: reading GitHub settings, 5 seconds at most...\n';
  const tty = await run(true, []);
  assert.ok(tty.stderr.startsWith(note), tty.stderr);
  assert.ok(!tty.stdout.includes('reading GitHub'), 'the note is not part of the screen');
  const piped = await run(undefined, []);
  assert.ok(!piped.stderr.includes('reading GitHub settings'), 'no note off a terminal');
  assert.ok(!(await run(true, ['--session'])).stderr.includes('reading GitHub settings'), 'no note at session start');
  const json = await run(true, ['--json']);
  assert.ok(!json.stderr.includes('reading GitHub settings') && !json.stdout.includes('reading GitHub settings'), 'stdout holds only the report');
  JSON.parse(json.stdout);
});

// #1027: one screen by default. Owner 2026-10-25: a wall of text sends a beginner away.
// Record 0043 §3, plan D8: a bare command reads; the marks Fix is `yokoten marks add`, which runs (#1115).
test('doctor shows one screen: where, what is left, the next command; --all keeps the map; neither writes the marks (#1027, #1115)', async () => {
  const sandbox = makeSandbox();
  // A git name doctor could add: the positive control at the end shows there was something to fill.
  sandbox.git('config', 'user.name', 'Annsample');
  const marks = paths(sandbox.env).marks;
  const marksNow = () => (existsSync(marks) ? readFileSync(marks, 'utf8') : null);
  const before = marksNow();
  const short = await sandbox.call(['doctor']);
  assert.equal(marksNow(), before, 'bare doctor wrote nothing to the marks file');
  assert.match(short.stdout, underMark(/private-marks is missing or has no marks\n(?: {COL}.*\n)*? {COL}Fix: `yokoten marks add`\n/), short.stdout);
  const lines = short.stdout.trimEnd().split('\n');
  assert.match(lines[0] ?? '', /^yokoten doctor · stage 1 of 5, safety net$/);
  assert.ok(lines.length <= 24, `one screen, not ${lines.length} lines:\n${short.stdout}`);
  assert.ok(lines.every((line) => line.length <= 80), 'no line passes 80 characters');
  assert.match(short.stdout, /^ {2}done {8}\d+ of 26 steps$/m);
  assert.match(short.stdout, /^ {2}next {8}Write the rules for your agents \(AGENTS\.md\)$/m);
  assert.match(lines.at(-2) ?? '', /^Next: `yokoten init`$/);
  assert.match(lines.at(-1) ?? '', /^More: `yokoten doctor --all` shows every check/);
  assert.doesNotMatch(short.stdout, /OpenSSF|Scorecard|OSPS-/, 'no standard ids on the default screen');
  const all = await sandbox.call(['doctor', '--all']);
  assert.match(all.stdout, /OpenSSF/, '--all keeps the standards');
  assert.match(all.stdout, /^Machine:$/m);
  assert.equal(short.status, all.status, 'the same exit code');
  assert.equal(marksNow(), before, 'doctor --all wrote nothing to the marks file');
  assert.doesNotMatch(all.stdout, /added your git name/, 'it says nothing was added');
  const row = all.stdout.split('\n\n').find((block) => /MISSING +private-marks:/.test(block)) ?? '';
  assert.match(row, /Fix: `yokoten marks add`$/, row);
  // The Fix is a command that runs: a newcomer who follows it gets the row healed, not a refusal.
  const followed = await sandbox.call(['marks', 'add'], { input: 'nowhere-town\n' });
  assert.equal(followed.status, 0, followed.stderr);
  assert.equal(machineChecks(sandbox.env).find((check) => check.name === 'private-marks')?.ok, true, 'the Fix healed the row');
  assert.deepEqual(fillMarks(sandbox.env, machineMarks(sandbox.env, { cwd: sandbox.repo })), ['git name'], 'the git name was there to fill');
});

// Issue #1115: a problem's fix is its last line, and a fix several problems share shows once.
test('doctor: each problem ends with its Fix line, one per command (#1115)', () => {
  const problem = (id: string, what: string, fix: string) => ({ id, what, why: '', fix, docs: '' });
  const rows = problemRows([
    problem('a', 'no guard for Claude Code', 'run `yokoten install`'),
    problem('b', 'no runtime installed', 'run `yokoten install` from this copy of yokoten'),
    problem('c', '~/.config/yokoten/private-marks has no marks', 'run `yokoten marks add` and type your name'),
    problem('d', 'the settings file is not JSON', 'make it valid JSON'),
    problem('e', 'yokoten.json is broken', 'make `yokoten.json` valid JSON'),
  ]);
  assert.deepEqual(rows, [
    ['  MISSING     no guard for Claude Code; no runtime installed', '              From this copy of yokoten.', '              Fix: `yokoten install`'],
    ['  MISSING     ~/.config/yokoten/private-marks has no marks', '              Type your name.', '              Fix: `yokoten marks add`'],
    ['  MISSING     the settings file is not JSON; make it valid JSON'],
    ['  MISSING     yokoten.json is broken; make `yokoten.json` valid JSON'],
  ]);
});

test('every road step has a plain task title (#1027)', async () => {
  const { STEP_TITLES: stepTitles } = await import('../../../../src/commands/more/advice/doctor.ts');
  const { ROAD: road } = await import('../../../../src/setup/road.ts');
  assert.deepEqual(road.map((s) => s.key).filter((key) => !stepTitles[key]), []);
  for (const t of Object.values(stepTitles)) assert.ok(t.length <= 60, t);
});

// Plan D1: what a session start says past the report is data; its screen is a pure function (#1115).
test('sessionScreen: identity first, then the blocks said, then the cleanup, the role and the unfiltered note (#935, #402, #390, #1115)', () => {
  const notes = { identity: 'yokoten: you are xAI (grok-4.7), served through codex', cleanup: { files: 1, edits: ['skill yokoten'], profiles: [] }, role: 'env' as const, isUnfiltered: true };
  const lines = sessionScreen([['yokoten: stage 1 of 5, safety net']], notes);
  assert.deepEqual(lines.slice(0, 7), [
    'yokoten: you are xAI (grok-4.7), served through codex',
    '',
    'yokoten: stage 1 of 5, safety net',
    '',
    'yokoten: cleaned 1 file an older install left; the plugin brings them now',
    'yokoten: kept your edit to skill yokoten: an older install left it',
    '',
  ]);
  assert.equal(lines[7], 'yokoten: this session is a worker: lead-only files are guarded.');
  assert.equal(lines.slice(9).join('\n'), UNFILTERED_NOTE);
  // The lead, Claude Code, after a start with nothing to clean: only the blocks said.
  assert.deepEqual(sessionScreen([['a']], { identity: '', cleanup: { files: 0, edits: [], profiles: [] }, role: null, isUnfiltered: false }), ['a']);
  assert.deepEqual(sessionNoteBlocks({ ...notes, identity: 'x' }), sessionNoteBlocks(notes), 'the identity is not a note block');
});
