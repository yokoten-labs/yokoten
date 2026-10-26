// `yokoten desk` (record 0043, issue #1054, #1056): give one task to one AI, in its own
// fenced desk. Bare `desk` lists the desks and writes nothing. `desk <issue>` or
// `desk "<task>"` makes the desk's own clone (clone.ts), writes the brief (brief.ts), picks
// the AI (pick-agent.ts) and starts it inside the fence, for the person to watch. While it
// runs, a stall is marked (stall.ts); when it exits, finish.ts shows the evidence. A desk
// that stopped mid-task shows on the next start, and `desk <n>` goes on from its last
// commit and its brief. Nothing is pushed without --pr. The old form,
// `desk <agent> <folder> -- <command>`, runs as before, from the guard's module.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findProgram } from '../../platform/process.ts';
import { hasBot } from '../../host/github/bot.ts';
import { type Invocation, nextLine, parse, print, requireRoot, row, title, usage } from '../shared.ts';
import { briefText, type DeskTask, readIssue, readTaskWord, textTask } from './brief.ts';
import { deskBranch, desksHome, makeClone, type Ran, type Run, runWith } from './clone.ts';
import { commitsSince, deskGitProblem, endingOf, endingScreen, type Fenced, gatherEvidence, moveAside, openPullRequest, refusedLine, saveWork, shownPath } from './finish.ts';
import { briefFile, deskRows, type DeskRecord, type IsAlive, isAlive, listScreen, readRecord, readRecords, stateNow, writeRecord } from './list.ts';
import { pickAgent } from './pick-agent.ts';
import { isWaiting, lastActivity, watchDesk } from './stall.ts';

/** The one line on native Windows: the desk runs in WSL. */
export const DESK_USE_WSL = 'yokoten desk: on Windows, a desk runs in WSL, where it has a sandbox. Open WSL and run it there. Nothing was started.';

/** What the desk does to the world, so a test can stand in for each part. */
export interface DeskDeps {
  run: Run;
  /** Start `command` in the desk's fence with `runtime`'s rules: the AI ('inherit'), or the check, tests and saves ('pipe'). */
  fenced: (desk: string, runtime: string, command: string[], stdio: 'inherit' | 'pipe') => Promise<Ran | { fail: string }>;
  isInstalled: (program: string) => boolean;
  alive: IsAlive;
  now: () => Date;
  pid: number;
  /** The words that run a command as the bot, or null when no bot is set up. */
  bot: string[] | null;
  watch: typeof watchDesk;
}

/** The real world: git and gh, the fence of agents/desk/, this process. */
function realDeps(invocation: Invocation): DeskDeps {
  const platform = invocation.platform ?? 'linux';
  return {
    run: runWith(invocation.env),
    fenced: async (desk, runtime, command, stdio) => {
      const { startFencedDesk } = await import('../hook.ts');
      const done = await startFencedDesk(invocation, { runtime, folder: desk, command }, stdio);
      return 'fail' in done ? done : { status: done.code, stdout: done.stdout, stderr: done.stderr };
    },
    isInstalled: (program) => findProgram(program, invocation.env.PATH, platform, invocation.env) !== null,
    alive: isAlive,
    now: () => new Date(),
    pid: process.pid,
    bot: hasBot(invocation.env) ? [process.execPath, invocation.script, 'bot', '--'] : null,
    watch: watchDesk,
  };
}

const utc = (date: Date): string => date.toISOString().replace(/\.\d{3}Z$/, 'Z');

export function runDesk(invocation: Invocation, deps?: DeskDeps): number | Promise<number> {
  const { args } = invocation;
  // The old form, for scripts: a command after --, or an agent and a folder. Inside a Linux
  // desk of that form, its first program is the bridge to the proxy.
  if (args[0] === '--bridge') return import('../hook.ts').then((m) => m.runDesk(invocation, { flags: new Set(), values: {}, positional: [] }));
  const end = args.indexOf('--');
  const options = parse('desk', end === -1 ? args : args.slice(0, end));
  if (typeof options === 'string') return usage(invocation, options);
  if (end !== -1 || options.positional.length === 2) return import('../hook.ts').then((m) => m.runDesk(invocation, options));
  if (invocation.platform === 'win32') {
    print(invocation, [DESK_USE_WSL], invocation.stderr);
    return 1;
  }
  const root = requireRoot(invocation, invocation.cwd);
  if (!root) return 1;
  const world = deps ?? realDeps(invocation);
  const home = desksHome(root);
  const [word] = options.positional;
  if (word === undefined) {
    if (options.flags.has('--pr')) return usage(invocation, 'name the desk: yokoten desk <issue> --pr');
    const commitsOf = (record: DeskRecord) => (existsSync(join(home, record.name)) ? commitsSince(world.run, join(home, record.name), record.base) : []);
    print(invocation, listScreen(readRecords(home), world.alive, commitsOf, world.now()));
    return 0;
  }
  const asked = readTaskWord(word);
  if (!asked) return usage(invocation, `${word} is not an issue number or a task: yokoten desk 14, or yokoten desk "fix the typo"`);
  return startOrGoOn(invocation, world, root, asked, { pr: options.flags.has('--pr'), agent: options.values['--agent'], install: !options.flags.has('--no-install') });
}

interface Choices {
  pr: boolean;
  agent: string | undefined;
  install: boolean;
}

/** `desk <n>`: a new desk, the one that stopped, or --pr on one that ended. */
async function startOrGoOn(invocation: Invocation, world: DeskDeps, root: string, asked: { number: number } | { text: string }, choices: Choices): Promise<number> {
  const fail = (line: string) => {
    print(invocation, [`yokoten desk: ${line}`], invocation.stderr);
    return 1;
  };
  const home = desksHome(root);
  const name = 'number' in asked ? String(asked.number) : textTask(asked.text).name;
  const desk = join(home, name);
  let record = readRecord(home, name);
  const now = world.now();
  if (record && (record.state === 'working' || record.state === 'stalled') && stateNow(record, world.alive) !== 'stopped') {
    return fail(`desk ${name} is running in another terminal (${record.state}). Stop it there first.`);
  }
  if (choices.pr) {
    if (!record || !existsSync(desk)) return fail(`there is no desk ${name}. Start it with \`yokoten desk ${name}\`.`);
    return finish(invocation, world, root, record, true);
  }
  // The other desks that stopped or stalled: seen before anything starts (#1056).
  const others = readRecords(home).filter((one) => one.name !== name && ['stopped', 'stalled'].includes(stateNow(one, world.alive)));
  const agent = pickAgent(choices.agent ?? record?.agent, world.isInstalled);
  if ('problem' in agent) return fail(agent.problem);
  let brief: string;
  if (record && existsSync(desk)) {
    // Go on: the saved work first, then the brief with what was done. A desk git can't read safely is refused.
    const refused = deskGitProblem(desk);
    if (refused) return fail(`${refusedLine(refused)}.`);
    const saved = await saveWork((command) => world.fenced(desk, agent.runtime, command, 'pipe'), world.run, desk, record.task);
    if (typeof saved === 'object') print(invocation, [`yokoten desk: ${saved.problem}. It is still in ${shownPath(invocation.cwd, desk, invocation.env.HOME)}.`], invocation.stderr);
    const first = existsSync(briefFile(home, name)) ? readFileSync(briefFile(home, name), 'utf8') : briefText({ ...textTask(record.task.title), name }, record.branch);
    brief = `${first.trimEnd()}\n\n## Done so far (you stopped; go on from here)\n\n${commitsSince(world.run, desk, record.base).map((line) => `- ${line}`).join('\n') || '- no commits yet'}\n`;
  } else {
    if (existsSync(desk)) return fail(`${shownPath(invocation.cwd, desk, invocation.env.HOME)} is there but has no record. Move it away, then run this again.`);
    const task: DeskTask | { problem: string } = 'number' in asked ? readIssue(asked.number, world.run, root) : textTask(asked.text);
    if ('problem' in task) return fail(task.problem);
    print(invocation, [...row('next', `making the desk ${shownPath(invocation.cwd, desk, invocation.env.HOME)}`)], invocation.stderr);
    const made = makeClone({ root, name, run: world.run, install: choices.install });
    if ('problem' in made) return fail(made.problem);
    brief = briefText(task, deskBranch(name));
    writeFileSync(briefFile(home, name), brief);
    record = { name, task: { kind: task.kind, title: task.title, ...(task.kind === 'issue' ? { number: task.number } : {}) }, agent: agent.runtime, branch: deskBranch(name), base: made.base, pid: world.pid, startedAt: utc(now), activeAt: utc(now), state: 'working' };
  }
  if (others.length) print(invocation, [...title('desk', `${others.length} other desk${others.length === 1 ? '' : 's'} stopped mid-task`), ...others.flatMap((one) => deskRows(one, stateNow(one, world.alive), existsSync(join(home, one.name)) ? commitsSince(world.run, join(home, one.name), one.base) : [], now)), ...nextLine(`yokoten desk ${others[0]?.name ?? ''}`), ''], invocation.stderr);
  const running: DeskRecord = { ...record, agent: agent.runtime, pid: world.pid, activeAt: utc(now), state: 'working' };
  writeRecord(home, running);
  // While the AI runs: a stall is marked, and its work saved, since it is idle then (#1056).
  const started = now.getTime();
  let saving: Promise<unknown> = Promise.resolve();
  const stop = world.watch({
    activity: () => Math.max(started, lastActivity(desk, `${desk}.state`)),
    waiting: () => isWaiting(desk),
    now: () => world.now().getTime(),
    onChange: (state, activeAt) => {
      writeRecord(home, { ...running, state, activeAt: utc(new Date(activeAt)) });
      if (state === 'stalled') saving = saveWork((command) => world.fenced(desk, agent.runtime, command, 'pipe'), world.run, desk, running.task);
    },
  });
  const ran = await world.fenced(desk, agent.runtime, agent.interactive(brief), 'inherit').finally(async () => {
    stop();
    await saving;
  });
  if ('fail' in ran) {
    writeRecord(home, { ...running, state: 'kept' });
    return fail(ran.fail);
  }
  if (ran.stderr) invocation.stderr.write(ran.stderr);
  return finish(invocation, world, root, { ...running, activeAt: utc(world.now()) }, false);
}

/** After the AI: save, gather the evidence, show the ending; with --pr, push and open the pull request. */
async function finish(invocation: Invocation, world: DeskDeps, root: string, record: DeskRecord, pr: boolean): Promise<number> {
  const home = desksHome(root);
  const desk = join(home, record.name);
  const fenced: Fenced = (command) => world.fenced(desk, record.agent, command, 'pipe');
  // Fail closed: no git read, save, bundle or push from a desk whose .git points elsewhere.
  const refused = deskGitProblem(desk);
  if (refused) {
    writeRecord(home, { ...record, state: 'kept', activeAt: utc(world.now()) });
    print(invocation, [`yokoten desk: ${refusedLine(refused)}.`], invocation.stderr);
    return 1;
  }
  const saved = await saveWork(fenced, world.run, desk, record.task);
  const extra: string[] = typeof saved === 'object' ? row('MISSING', saved.problem, 'save') : saved === 'saved' ? row('ok', 'the work left uncommitted, in one commit', 'saved') : [];
  let evidence = await gatherEvidence(fenced, world.run, desk, record, [process.execPath, invocation.script, 'check']);
  let ending = endingOf(evidence);
  let pushed = record.pushed;
  if (pr && ending === 'unpushed' && evidence.dirty === 0) {
    const opened = openPullRequest({ run: world.run, root, desk, record, bot: world.bot, evidence });
    if ('problem' in opened) extra.push(...row('MISSING', opened.problem, 'pull'));
    else {
      pushed = evidence.head;
      extra.push(...row('done', `${opened.url} (${world.bot ? 'as the bot' : 'with your gh login'})`, 'pull'));
      evidence = { ...evidence, unpushed: false };
      ending = endingOf(evidence);
    }
  } else if (pr && ending === 'failed') extra.push(...row('note', 'nothing was pushed: the checks failed', 'pull'));
  const kept: DeskRecord = { ...record, pushed, state: ending === 'clean' ? 'done' : 'kept', activeAt: utc(world.now()) };
  writeRecord(home, kept);
  if (ending === 'clean') {
    const moved = moveAside(world.run, home, record.name, world.now());
    extra.push(...('problem' in moved ? row('note', moved.problem, 'moved') : row('done', `to ${shownPath(invocation.cwd, moved.to, invocation.env.HOME)}, with a bundle`, 'moved')));
  }
  print(invocation, endingScreen(record.name, ending, evidence, shownPath(invocation.cwd, desk, invocation.env.HOME), extra));
  return ending === 'failed' ? 1 : 0;
}
