// `yokoten init`: add the rules to a project, and the screens that report it.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ghIn } from '../../../host/github/index.ts';
import { loadConfig } from '../../../rules/config.ts';
import { init } from '../../../setup/init.ts';
import { readOriginUrl, setUpPlanning } from '../../../setup/plan.ts';
import { count, type Invocation, moreLine, nextLine, parse, print, requireRoot, row, screen, spaced, title, usage, wrap } from '../../shared.ts';
import { askWhenTerminal, handRow, NEEDS_HAND, remaining, ROW_TEXT_INDENT } from './ask.ts';

/** The project part of the first run: init's report as four rows and a file count (#1027). */
export function projectScreen(lines: string[], ok: boolean, isFirstRun = false): string[] {
  const wrote = lines.filter((line) => /^wrote /.test(line));
  const kept = lines.filter((line) => /^kept /.test(line));
  if (ok && !wrote.length) return title('init', 'already set up here, nothing changed');
  const workflows = wrote.filter((line) => /^wrote \.github\/workflows\//.test(line)).length;
  const hasDependabot = wrote.some((line) => /dependabot/.test(line));
  const hasGithubFiles = wrote.some((line) => /templates|CODEOWNERS|pull_request_template/.test(line));
  const agents = lines.filter((line) => /hook in \./.test(line)).length;
  const isDone = ok && !lines.some((line) => NEEDS_HAND.test(line));
  const out = title('init', isDone ? 'this project is set up' : 'this project is partly set up');
  out.push('');
  out.push(...row('ok', 'AGENTS.md, the commit check', 'rules'));
  const ci = [workflows && `${workflows} workflows`, hasDependabot && 'Dependabot'].filter(Boolean).join(', ');
  if (ci) out.push(...row('ok', ci, 'CI'));
  if (hasGithubFiles) out.push(...row('ok', 'issue and PR templates, CODEOWNERS', 'GitHub'));
  out.push(...row('ok', `guard for Claude Code${agents > 1 ? ` and ${agents - 1} more` : ''}`, 'agents'));
  out.push(`${ROW_TEXT_INDENT}${wrote.length} files written${kept.length ? `, ${kept.length} of yours kept` : ', none of yours changed'}`);
  const rest = remaining(lines, { isProblemsOnly: true });
  if (rest.length) out.push('', ...rest);
  // The first run ends on one Next line, after doctor, so this screen names only the rest.
  if (!isFirstRun) {
    out.push('');
    out.push(...nextLine('git add -A && git commit -m "chore: add yokoten"'));
    out.push(...moreLine('`yokoten init --list` names every file'));
  } else out.push('', ...moreLine('`yokoten init --list` names every file'));
  return out;
}

export function runInit(invocation: Invocation): number {
  const options = parse('init', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  if (options.flags.has('--yes') && !options.flags.has('--github')) return usage(invocation, '--yes goes with --github');
  if (options.flags.has('--remove-default-labels') && !options.flags.has('--github')) return usage(invocation, '--remove-default-labels goes with --github');
  if (options.flags.has('--board') && !options.flags.has('--github')) return usage(invocation, '--board goes with --github');
  const dir = resolve(invocation.cwd, options.positional[0] ?? '.');
  // Checked before anything is written (#205): a typo never becomes a new folder.
  if (!existsSync(dir)) {
    print(invocation, [`yokoten init: ${options.positional[0]} does not exist; nothing was written. Create it and run \`git init\` there first.`], invocation.stderr);
    return 1;
  }
  const root = requireRoot(invocation, dir);
  if (!root) return 1;
  // Read first: a broken yokoten.json stops init before it writes a file.
  const { areas } = loadConfig(root);
  // The tests job is asked first (#550): only with a terminal on stdin and stdout, as install asks.
  const ask = askWhenTerminal(invocation);
  const done = init(root, invocation.env, undefined, { noCi: options.flags.has('--no-ci'), ask, platform: invocation.platform });
  // The host is changed only when asked (#10): it is a remote, and other people see it.
  // Without --yes, init only reads it and says what it would do, or what it skipped.
  const planning = setUpPlanning(ghIn(root, invocation.env), readOriginUrl(root, invocation.env), {
    apply: options.flags.has('--yes'),
    removeDefaults: options.flags.has('--remove-default-labels'),
    areas,
    board: options.flags.has('--board'),
  });
  // --github --yes asked for changes on GitHub; a skip made none, so it fails (#208).
  const isRefused = planning.skipped && options.flags.has('--yes');
  // `--list` keeps the full report, printed as before, on the stream that already carried it.
  if (options.flags.has('--list')) {
    print(invocation, done.lines);
    print(invocation, planning.lines, planning.ok && !isRefused ? invocation.stdout : invocation.stderr);
  } else {
    // A plain init never asks GitHub, so its skip is not news on the screen (#1027); --github shows rows.
    const plan = options.flags.has('--github') ? planScreen(planning.lines) : [];
    print(invocation, initScreen(done.lines, plan, done.ok), planning.ok && !isRefused ? invocation.stdout : invocation.stderr);
  }
  if (isRefused) print(invocation, ['yokoten init: --github --yes changed nothing on GitHub (the reason is above). The project files are as listed above.'], invocation.stderr);
  return planning.ok && !isRefused && done.ok ? 0 : 1;
}

// The default screen of `yokoten init` (issue #1027, the design the owner approved 2026-10-25):
// a title, groups of rows, and the command to type. `--list` keeps the full line-by-line report.
// Only the printing changes: the same files are written, and the exit code is untouched.

/** The agents init writes a guard for, in the order the report names them. */
const INIT_AGENTS = ['Claude Code', 'Codex', 'Gemini CLI', 'Antigravity CLI', 'OpenCode', 'Muse Code', 'DeepSeek Harness', 'Grok CLI'];
/** The folders whose files are the agents' guard and sandbox settings. */
const AGENT_FOLDERS = ['.claude/', '.codex/', '.gemini/', '.agents/', '.opencode/', '.muse/', '.dsh/', '.grok/'];

interface InitItem {
  /** True when init wrote or changed this item on this run. */
  isWritten: boolean;
  /** The file the line is about, when it names one. */
  path: string | null;
  line: string;
}

/** One report line of init as an item: whether it was written, and which file it names. */
function initItem(line: string): InitItem {
  const isWritten = /^(?:wrote|updated|linked|added) /.test(line);
  const direct = /^(?:wrote|updated|linked|kept) ([^\s(]+)/.exec(line);
  const inside = / in (\.[^\s()]+)/.exec(line);
  const path = direct?.[1] !== undefined && /[./]/.test(direct[1]) ? direct[1] : inside?.[1] ?? null;
  return { isWritten, path, line };
}

/** Whether a line says a file of the user's was left as it is, which is a note. */
const isYours = (line: string): boolean => /^kept (?:your|\(your edit\))/.test(line) || /\(yours, not yokoten's\)$/.test(line);

/** The group a line belongs to; null for the plain files the count folds. */
function initGroup(item: InitItem): 'rules' | 'CI' | 'GitHub' | 'agents' | null {
  const path = item.path ?? '';
  if (/AGENTS\.md/.test(item.line) || item.line.startsWith('git hook:') || path.startsWith('.githooks/')) return 'rules';
  if (path.startsWith('.github/workflows/') || path === '.github/dependabot.yml') return 'CI';
  if (path.startsWith('.github/ISSUE_TEMPLATE/') || path === '.github/pull_request_template.md' || path === '.github/CODEOWNERS' || path === '.github/SECURITY.md') return 'GitHub';
  if (AGENT_FOLDERS.some((folder) => path.startsWith(folder))) return 'agents';
  return null;
}

/** The text of one group's row, from the items it holds. */
function groupText(group: 'rules' | 'CI' | 'GitHub' | 'agents', items: InitItem[]): string {
  const paths = items.filter((item) => initGroup(item) === group && item.path !== null).map((item) => item.path ?? '');
  if (group === 'rules') return 'AGENTS.md, the commit check';
  if (group === 'CI') {
    const workflows = new Set(paths.filter((path) => path.startsWith('.github/workflows/')));
    const parts = [count(workflows.size, 'workflow')];
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
  const found = INIT_AGENTS.filter((name) => items.some((item) => initGroup(item) === 'agents' && item.line.includes(name)));
  const [first] = found;
  if (first === undefined) return 'no agent found';
  return found.length === 1 ? `guard for ${first}` : `guard for ${first} (${found.length - 1} more ready)`;
}

/** The default screen of `yokoten init`, from its report lines and the GitHub rows when asked. */
export function initScreen(lines: string[], plan: string[] = [], ok = true): string[] {
  const items = lines.map(initItem);
  const isRuntimeCopy = (item: InitItem): boolean => item.path === '.yokoten/';
  const written = new Set(items.filter((item) => item.isWritten && !isRuntimeCopy(item) && item.path !== null).map((item) => item.path ?? ''));
  const kept = new Set(items.filter((item) => !item.isWritten && !isRuntimeCopy(item) && item.path !== null).map((item) => item.path ?? ''));
  // A file kept because the user changed it, a skip and a command to run by hand need an answer,
  // so they are never folded (R5 of the design).
  const notes = items
    .filter((item) => isYours(item.line) || /^(?:skipped |could not )/.test(item.line) || (!/^(?:wrote|updated|linked|added|kept) /.test(item.line) && !item.line.startsWith('git hook:') && item.line !== 'other agents: see the guide'))
    .map((item) => item.line)
    .filter((line, at, all) => all.indexOf(line) === at);
  // A step left for the person is a MISSING row, never a note or a file count (#1027 review).
  const handRows = lines.filter((line, at) => NEEDS_HAND.test(line) && lines.indexOf(line) === at).flatMap(handRow);
  const otherNotes = notes.filter((line) => !NEEDS_HAND.test(line));
  const more = moreLine('`yokoten init --list` shows every file');
  // The notes are a block of their own, as on the first run (#1115).
  if (written.size === 0 && !handRows.length) {
    const said = screen(title('init', 'already set up here, nothing changed'), plan, spaced(notes.map(noteLine)));
    return plan.length || notes.length ? [...said, '', ...more] : [...said, ...more];
  }
  const groups = (['rules', 'CI', 'GitHub', 'agents'] as const).filter((group) => items.some((item) => initGroup(item) === group));
  // Partly new: list only the groups that got something on this run.
  const shown = groups.filter((group) => items.some((item) => initGroup(item) === group && item.isWritten));
  const isPartly = !ok || handRows.length > 0;
  const out = [...title('init', isPartly ? 'this project is partly set up' : 'this project is set up'), ''];
  const isPartlyNew = kept.size > 0;
  // Partly new: a group names only what this run added, so an old file is not news.
  const listed = isPartlyNew ? items.filter((item) => item.isWritten) : items;
  // The group in the text, not a label column: the notes and MISSING rows have none (#1115).
  for (const group of shown) out.push(...row('done', `${group}: ${groupText(group, listed)}`));
  const summary = isPartlyNew
    ? `${count(written.size, 'file')} added, ${count(kept.size, 'file')} already there`
    : `${count(written.size, 'file')} written, ${notes.some(isYours) ? 'your own files kept' : 'none of yours changed'}`;
  out.push(...wrap('  ', summary));
  out.push(...handRows, ...plan);
  // The notes are a block of their own, a blank line between them when one wraps (#1115).
  const noteRows = spaced(otherNotes.map(noteLine));
  if (noteRows.length) out.push('', ...noteRows);
  out.push('', ...nextLine('git add -A && git commit -m "chore: add yokoten"'), ...more);
  return out;
}

/** One note of init as a row, so a queue and an agent read the same words. */
function noteLine(line: string): string[] {
  const text = line.replace(/^kept (?:your|\(your edit\)) /, 'your ').replace(/^kept /, '');
  return row('note', text);
}

/** The GitHub part of `yokoten init --github` as rows: what was done, kept, skipped or planned. */
export function planScreen(lines: string[]): string[] {
  const rows: string[] = [];
  for (const line of lines) {
    const done = /^- done: (.*)$/.exec(line);
    const failed = /^- could not (.*)$/.exec(line);
    const keptLine = /^- (.*kept)$/.exec(line);
    const item = /^- (.*)$/.exec(line);
    const head = /^GitHub: (.*)$/.exec(line);
    if (done) rows.push(...row('done', done[1] ?? '', 'GitHub'));
    else if (failed) rows.push(...row('MISSING', failed[1] ?? '', 'GitHub'));
    else if (keptLine) rows.push(...row('ok', keptLine[1] ?? '', 'GitHub'));
    else if (line === 'Nothing to change.') rows.push(...row('ok', 'nothing to change', 'GitHub'));
    else if (item) rows.push(...row('to do', item[1] ?? '', 'GitHub'));
    else if (head) rows.push(...row(line.startsWith('GitHub: skipped') ? 'note' : 'ok', head[1] ?? '', 'GitHub'));
    else if (line.startsWith('Nothing changed.')) rows.push(...nextLine(line.replace(/^Nothing changed\. /, '').replace(/`/g, '')));
    else if (line !== 'Would do:') rows.push(...wrap('  ', line));
  }
  return rows;
}

