// `yokoten init`: add the rules to a project, and the screens that report it.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ghIn } from '../../../host/github/index.ts';
import { loadConfig } from '../../../rules/config.ts';
import type { Finding } from '../../../rules/text/message.ts';
import type { Change, Place, SetupResult } from '../../../setup/files.ts';
import { HOOKS_PATH, init, type InitResult } from '../../../setup/init.ts';
import { type PlanItem, type PlanResult, readOriginUrl, setUpPlanning } from '../../../setup/plan.ts';
import { askOnTerminal, count, fail, failure, type Invocation, moreLine, nextLine, parse, print, printJsonError, requireRoot, row, type RowMark, screen, SCREEN_WIDTH, show, spaced, summaryLine, terminalOf, title, underRow, usage, wrap } from '../../shared.ts';
import { section } from '../../../rules/text/screen.ts';

export function runInit(invocation: Invocation): number {
  const options = parse('init', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  if (options.flags.has('--yes') && !options.flags.has('--github')) return usage(invocation, '--yes goes with --github');
  if (options.flags.has('--remove-default-labels') && !options.flags.has('--github')) return usage(invocation, '--remove-default-labels goes with --github');
  if (options.flags.has('--board') && !options.flags.has('--github')) return usage(invocation, '--board goes with --github');
  const dir = resolve(invocation.cwd, options.positional[0] ?? '.');
  // Checked before anything is written (#205): a typo never becomes a new folder.
  if (!existsSync(dir)) return fail(invocation, `${options.positional[0]} does not exist, so nothing was written`, `git init ${options.positional[0]}`);
  const root = requireRoot(invocation, dir);
  if (!root) return 1;
  // Read first: a broken yokoten.json stops init before it writes a file.
  let areas: string[];
  try {
    ({ areas } = loadConfig(root));
  } catch (err) {
    return fail(invocation, `${(err as Error).message.replace(/\.$/, '')}; nothing was written`, 'yokoten init');
  }
  // The tests job and the trust are asked (#550, #661) only when a person is at the terminal, as install asks.
  const { stdin, stdout } = invocation;
  const ask = terminalOf(invocation).canAsk && stdin.fd !== null ? askOnTerminal(stdout, stdin.fd) : undefined;
  const platform = invocation.platform ?? 'linux';
  const done = init(root, invocation.env, undefined, { noCi: options.flags.has('--no-ci'), ask, platform });
  // The host is changed only when asked (#10): it is a remote, and other people see it.
  // Without --yes, init only reads it and says what it would do, or what it skipped.
  const planning = setUpPlanning(ghIn(root, invocation.env), readOriginUrl(root, invocation.env), {
    apply: options.flags.has('--yes'),
    removeDefaults: options.flags.has('--remove-default-labels'),
    areas,
    board: options.flags.has('--board'),
  });
  // A plain init never asks GitHub, so its skip is not news on the screen (#1027); --github shows its rows.
  const result: InitResult = options.flags.has('--github') ? { ...done, plan: planning } : done;
  const lines = options.flags.has('--list') ? initListScreen(result, { platform }) : initScreen(result, { platform });
  // --github --yes asked for changes on GitHub: a skip made none (#208), and a change that
  // failed is named above, so either one fails, with the command to run again last.
  if (options.flags.has('--yes') && (planning.skipped || !planning.ok)) {
    // One screen on stderr: the files, then the failure under them; screen() makes the gap.
    const failed = (what: string, next: string): 1 => {
      printJsonError(invocation, what);
      print(invocation, screen(lines, failure(invocation.command, what, next)), invocation.stderr);
      return 1;
    };
    if (planning.skipped) return failed('--github --yes changed nothing on GitHub; the project files are as shown above', planning.skip?.fix || 'yokoten init --github');
    return failed('some changes on GitHub failed, as shown above; the project files are set up', 'yokoten init --github --yes');
  }
  show(invocation, lines);
  return planning.ok && done.ok ? 0 : 1;
}

// The default screen of `yokoten init` (issue #1027, the design the owner approved 2026-10-25):
// a title, groups of rows, and the command to type. `--list` shows every change. Both are built
// from init's result (#1115): nothing here reads printed text back.

/** The agents init writes a guard for, in the order the screen names them. */
const INIT_AGENTS = ['Claude Code', 'Codex', 'Gemini CLI', 'Antigravity CLI', 'OpenCode', 'Muse Code', 'DeepSeek Harness', 'Grok CLI'];

/** The groups of the default screen, in order. */
const GROUPS = ['rules', 'CI', 'GitHub', 'agents'] as const;
type Group = (typeof GROUPS)[number];

/** The group a change belongs to; null for the plain files the count folds. */
function groupOf(change: Change): Group | null {
  const { path } = change;
  if (path === 'AGENTS.md' || change.kind === 'git-hook') return 'rules';
  if (path.startsWith('.github/workflows/') || path === '.github/dependabot.yml') return 'CI';
  if (path.startsWith('.github/ISSUE_TEMPLATE/') || path === '.github/pull_request_template.md' || path === '.github/CODEOWNERS' || path === '.github/SECURITY.md') return 'GitHub';
  if (change.agent !== undefined && change.kind !== 'agent') return 'agents';
  return null;
}

/** Whether the change wrote something on this run. */
const isWritten = (change: Change): boolean => change.state === 'wrote' || change.state === 'updated' || change.state === 'linked' || change.state === 'added' || change.state === 'removed';

/** Whether a change is a file of the project: not the runtime copy, the git setting or an agent's own settings. */
const isProjectFile = (change: Change): boolean => change.kind !== 'runtime' && change.kind !== 'agent' && change.path !== HOOKS_PATH;

/** The text of one group's row, from the changes it holds. */
function groupText(group: Group, changes: readonly Change[]): string {
  const paths = changes.filter((change) => groupOf(change) === group).map((change) => change.path);
  if (group === 'rules') return 'AGENTS.md, the commit check';
  if (group === 'CI') {
    const parts = [count(new Set(paths.filter((path) => path.startsWith('.github/workflows/'))).size, 'workflow')];
    if (paths.includes('.github/dependabot.yml')) parts.push('Dependabot');
    return parts.join(', ');
  }
  if (group === 'GitHub') {
    const parts: string[] = [];
    if (paths.some((path) => path.startsWith('.github/ISSUE_TEMPLATE/') || path === '.github/pull_request_template.md')) parts.push('issue and PR templates');
    if (paths.includes('.github/CODEOWNERS')) parts.push('CODEOWNERS');
    if (paths.includes('.github/SECURITY.md')) parts.push('a security policy');
    return parts.join(', ') || 'nothing to add';
  }
  const found = INIT_AGENTS.filter((name) => changes.some((change) => groupOf(change) === 'agents' && change.agent === name));
  const [first] = found;
  if (first === undefined) return 'no agent found';
  return found.length === 1 ? `guard for ${first}` : `guard for ${first} (${found.length - 1} more ready)`;
}

/**
 * A note or a problem as one item: its row, and its fix under it on a `Fix:` line. Several
 * commands, or one too long for a Fix line, go below as lines of their own, so each copies whole
 * (#1040); the rows of a block are spaced apart by `spaced`, so they are items of their own.
 */
function findingItems(mark: 'note' | 'MISSING', note: Finding): string[][] {
  const head = row(mark, note.what);
  const commands = note.fix === '' ? [] : note.fix.split('\n');
  const [only] = commands;
  if (only === undefined) return [head];
  const fixLine = underRow(`Fix: \`${only}\``, false);
  if (commands.length === 1 && fixLine.length === 1 && (fixLine[0] ?? '').length <= SCREEN_WIDTH) return [[...head, ...fixLine]];
  return [head, commands.flatMap((command) => wrap('  ', command))];
}

/** The notes of a result, never folded (#1040): a file of the user's that init kept, then each note. */
const noteItems = (result: SetupResult): string[][] => [
  ...result.changes.filter((change) => change.yours).map((change) => row('note', change.note ?? change.path)),
  ...result.notes.flatMap((note) => findingItems('note', note)),
];

/** The command that keeps what init wrote: PowerShell has no `&&` before version 7, so Windows gets `;` (#1038). */
export const commitCommand = (platform: NodeJS.Platform): string => `git add -A${platform === 'win32' ? ';' : ' &&'} git commit -m "chore: add yokoten"`;

/** The title of init's screens: nothing changed, set up, or partly set up. */
function initTitle(result: SetupResult): string[] {
  const written = result.changes.filter((change) => isProjectFile(change) && isWritten(change));
  if (!written.length && !result.problems.length) return title('init', 'already set up here, nothing changed');
  return title('init', !result.ok || result.problems.length ? 'this project is partly set up' : 'this project is set up');
}

/** The default screen of `yokoten init`, from its result: the groups it wrote, what is left, the GitHub plan when asked, and the notes. */
export function initScreen(result: SetupResult & { plan?: PlanResult }, place: Pick<Place, 'platform'>): string[] {
  const files = result.changes.filter(isProjectFile);
  const written = new Set(files.filter(isWritten).map((change) => change.path));
  const kept = new Set(files.filter((change) => !isWritten(change) && change.state !== 'skipped' && !written.has(change.path)).map((change) => change.path));
  const problems = spaced(result.problems.flatMap((problem) => findingItems('MISSING', problem)));
  const plan = result.plan ? planScreen(result.plan) : [];
  const notes = spaced(noteItems(result));
  const more = moreLine('`yokoten init --list` shows every file');
  if (written.size === 0 && !result.problems.length) return screen(initTitle(result), plan, notes, more);
  // Partly new: a group names only what this run added, so an old file is not news.
  const isPartlyNew = kept.size > 0;
  const listed = isPartlyNew ? result.changes.filter(isWritten) : result.changes;
  // The group in the text, not a label column: the notes and MISSING rows have none (#1115).
  const rows = GROUPS.filter((group) => result.changes.some((change) => groupOf(change) === group && isWritten(change))).flatMap((group) => row('done', `${group}: ${groupText(group, listed)}`));
  const hasYours = result.changes.some((change) => change.yours);
  const summary = isPartlyNew ? `${count(written.size, 'file')} added, ${count(kept.size, 'file')} already there` : `${count(written.size, 'file')} written, ${hasYours ? 'your own files kept' : 'none of yours changed'}`;
  return screen(initTitle(result), rows, summaryLine(summary), problems, plan, notes, [...nextLine(commitCommand(place.platform)), ...more]);
}

/** The headings of `init --list`, by the group of each change; the agents' own settings in the home folder come last. */
const LIST_HEADINGS: Record<Group | 'files' | 'home', string> = { rules: 'The rules', CI: 'CI', GitHub: 'GitHub', agents: 'The agents', files: 'Other files', home: 'Your agent settings' };

/**
 * `yokoten init --list`: the same title, then every change as a row under the heading of its
 * group, what is left, the GitHub plan and the notes. A section is spaced on its own, so one
 * long row spaces out only its own section.
 */
export function initListScreen(result: SetupResult & { plan?: PlanResult }, place: Pick<Place, 'platform'>): string[] {
  const keyOf = (change: Change): keyof typeof LIST_HEADINGS => (change.kind === 'agent' ? 'home' : groupOf(change) ?? 'files');
  const sections = (Object.keys(LIST_HEADINGS) as (keyof typeof LIST_HEADINGS)[]).map((key) =>
    section(LIST_HEADINGS[key], spaced(result.changes.filter((change) => keyOf(change) === key).map((change) => wrap(`  ${change.state} `, change.note ?? change.path)))),
  );
  const problems = spaced(result.problems.flatMap((problem) => findingItems('MISSING', problem)));
  const notes = spaced(result.notes.flatMap((note) => findingItems('note', note)));
  const written = result.changes.some((change) => isProjectFile(change) && isWritten(change));
  return screen(initTitle(result), ...sections, problems, result.plan ? planScreen(result.plan) : [], notes, written || result.problems.length ? nextLine(commitCommand(place.platform)) : []);
}

/** The mark of one item of the GitHub plan. */
const PLAN_MARKS: Record<PlanItem['state'], RowMark> = { done: 'done', failed: 'MISSING', kept: 'ok', 'to do': 'to do', note: 'note' };

/** The GitHub part of `yokoten init --github`, from its plan: what was done, kept, failed or is to do, and the command that does it. */
export function planScreen(plan: PlanResult): string[] {
  if (plan.skip) return spaced(findingItems('note', { id: 'github', what: `GitHub was not read: ${plan.skip.why}`, why: '', fix: plan.skip.fix }));
  const items = plan.items.map((item) => row(PLAN_MARKS[item.state], item.what));
  if (!items.length) items.push(row('ok', 'nothing to change'));
  if (plan.command !== undefined) items.push(wrap('  ', `To do these on GitHub: \`${plan.command}\``));
  return section(`On GitHub, ${plan.repo ?? 'the repo'}`, spaced(items));
}
