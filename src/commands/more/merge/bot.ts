// `yokoten bot -- <gh or git command>`: runs it as the GitHub App, after checking its title
// and, for a pull request, its body.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { botConfig, botEnv, botProgram, type Gh, installationToken, readApprovalState, readBranchFiles, readCodeOwners, readIssueMilestone, readRepoLabelNames, repoOf } from '../../../host/github/index.ts';
import { type Config, DEFAULTS, type Env, loadConfig } from '../../../rules/config.ts';
import { finding, type Finding } from '../../../rules/text/message.ts';
import { checkPost, readsStdinBody, readSentBody } from '../../../rules/privacy.ts';
import { type CommandIssueLabels, type CommandLabels, type CommandMilestone, checkCommandTitle, checkMergeApproval, checkIssueLabels, checkOwnedTier, checkPullRequestBody, COMMIT_FORMAT, issueLabelChoices, madeWithFindings, noMilestoneFinding, nonUtcCommits, prTier, type PushedCommit, readCommandBody, readCommandIssueLabels, readCommandLabels, readCommandMilestone, readLabelTier, readPushPlan, utcFix } from '../../../rules/pr.ts';
import { nextSentence, section } from '../../../rules/text/screen.ts';
import { runGit } from '../../../run/check.ts';
import { count, failure, type Invocation, noteLine, type Output, parse, print, problemRows, readInput, requireRoot, rootOf, row, screen, show, spaced, summaryLine, terminalOf, title, usage, wrap } from '../../shared.ts';

/** The bot's name: the App's own name when the project sets one, else the default (#1027). */
export const botName = (env: Env): string => env.YOKOTEN_BOT_NAME || 'yokoten-bot';

/** The one line before the command's own output: `yokoten bot · as yokoten-bot · gh pr create`. */
export const botHeading = (env: Env, command: string[]): string[] => title('bot', `as ${botName(env)} · ${command.join(' ')}`);

// ---- What a person reads: refusals and notes, as data, then one layout (#1115) ----

/** The check that stopped a command: which part of the bot said no. */
export type BotRule = 'program' | 'post' | 'push' | 'setup' | 'remote' | 'run' | 'merge';

/**
 * A refusal as data (#1115): the rule that stopped the command, what is wrong (the title),
 * the fix as one sentence (the Next line), and the blocks of rows between them.
 */
export interface BotRefusal {
  rule: BotRule;
  what: string;
  fix: string;
  blocks?: readonly (readonly string[])[];
}

/** The screen of a refusal: the title says what is wrong, then its rows, then one Next line. */
export const refusalScreen = ({ what, fix, blocks = [] }: BotRefusal): string[] => screen(failure('bot', what), ...blocks, nextSentence(fix));

/** Says a refusal on stderr and gives the exit code. */
function refuse(invocation: Invocation, refusal: BotRefusal): 1 {
  print(invocation, refusalScreen(refusal), invocation.stderr);
  return 1;
}

/** Says a note on stderr: `note: <text>`, wrapped under itself. The command goes on. */
const sayNote = (invocation: Invocation, text: string): void => print(invocation, noteLine(text), invocation.stderr);

/** The refusal of a program the bot does not run (#295). */
export const programRefusal = (program: string): BotRefusal => ({ rule: 'program', what: 'the bot runs gh and git only', fix: `run \`${program}\` without the bot.` });

/** The refusal of a command that never ran, or that a signal ended (#282): only the file and the code or signal, never the token. */
export function runRefusal(file: string, ran: { error?: Error; signal?: NodeJS.Signals | null }): BotRefusal | null {
  if (ran.error) return { rule: 'run', what: `could not run ${file}: ${(ran.error as NodeJS.ErrnoException).code ?? ran.error.message.split('\n')[0]}`, fix: `check that \`${file}\` is installed and on PATH, then run the command again.` };
  if (ran.signal) return { rule: 'run', what: `${file} was ended by ${ran.signal}`, fix: 'run the command again.' };
  return null;
}

async function bot(invocation: Invocation, written: string[]): Promise<number> {
  const { env, cwd } = invocation;
  let command = written;
  // gh and git only (#295): a wrapper such as `env gh` or `sh -c` would run a title unchecked.
  if (command.length && !botProgram(command[0])) return refuse(invocation, programRefusal(command[0]));
  const root = rootOf(cwd, env);
  const projectConfig = root ? loadConfig(root) : DEFAULTS;
  // Standard input is read once, for the checks, and gh then gets the same text.
  let stdinText: string | undefined;
  const readStdin = (): string => (stdinText ??= readInput(invocation.stdin));
  // Every check that needs no token runs first, and all their problems come back in one
  // answer (#1120): a bad title, body or label is refused before anything is sent, and the
  // caller fixes them all in one try instead of one per try.
  const problems = emptyPostProblems();
  problems.title.push(...checkCommandTitle(command, projectConfig));
  // The body file is read once, here (#1077). gh then gets that same text on stdin, so every
  // check below reads the text that is sent, and a file changed after the check changes nothing.
  if (botProgram(command[0] ?? '') === 'gh') {
    const sent = readSentBody(command.slice(1), cwd);
    if ('id' in sent) problems.sent.push(sent);
    else {
      command = [command[0], ...sent.args];
      if (sent.text !== undefined) stdinText = sent.text;
    }
  }
  // A body the bot can't send as it read it is not checked further: its text is not the one gh would get.
  const sendable = !problems.sent.length;
  // Then a pull request's body (#406), by the body rules of `check --pr`. A body for this
  // branch, or one `--head` or `gh pr edit <branch>` names, is checked before anything is sent.
  const body = root && sendable ? readPendingBody(invocation, command, root, readStdin) : null;
  if (body === UNREADABLE) return refuseUnreadable(invocation);
  if (body && !isLookup(body)) {
    const checked = checkBody(body, localBranch(body), env);
    problems.body.push(...checked.problems);
    if (checked.note && !checked.problems.length) sayNote(invocation, checked.note);
  }
  // A comment, a review with a body and a new issue carry the same `Made with` line as a
  // pull request body (#609), so a reader can tell which AI wrote them. Only that line is
  // checked here; an edit stays as it is.
  const note = root && sendable ? readPendingNoteBody(invocation, command, root, readStdin) : null;
  if (note === UNREADABLE) return refuseUnreadable(invocation);
  if (note) problems.body.push(...checkNote(note));
  // Then the labels of `gh pr create` (#422): a tier label the body contradicts is refused.
  const labels = root ? readPendingLabels(command, root, body, env) : null;
  problems.labels.push(...(labels?.problems ?? []));
  // Then the labels of `gh issue create` (#544): checked below, once the token can
  // list the repo's labels. A bad issue is refused, never sent; its labels are not
  // added, as no line of the command names the type. With other problems already found,
  // the token is still asked for, so the one answer names the labels too (#1120).
  const pendingIssue = root ? readPendingIssueLabels(command, root, env) : null;
  const found = (): boolean => countPostProblems(problems) > 0;
  const refusePost = (): number => {
    print(invocation, postRefusal(problems), invocation.stderr);
    return 1;
  };
  if (found() && !pendingIssue) return refusePost();
  // A push sends only commits made in UTC (#1120): an offset names the machine's zone.
  if (!found() && botProgram(command[0] ?? '') === 'git' && refuseNonUtcPush(invocation, command)) return 1;
  const config = botConfig(env);
  if (typeof config === 'string') {
    if (found()) return refusePost();
    return refuse(invocation, { rule: 'setup', what: config, fix: 'set it up, then run the command again.' });
  }
  if (!requireRoot(invocation, cwd)) return 1;
  const remote = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd, env, encoding: 'utf8' });
  const repo = repoOf(remote);
  if (!repo) {
    if (found()) return refusePost();
    return refuse(invocation, { rule: 'remote', what: 'the origin remote is not a GitHub repo, so nothing was sent', fix: 'point `origin` at the GitHub repo, or run the command without the bot.' });
  }
  let token: string;
  try {
    token = await installationToken(config, repo);
  } catch (error) {
    // The problems already found are the answer: the labels then stay unchecked.
    if (found()) return refusePost();
    throw error;
  }
  const [file, ...given] = command;
  // One line before the command's own output, on a terminal only: a pipe keeps the command's
  // bytes exactly, so `yokoten bot -- gh pr view --json … | jq` still reads JSON (#1027).
  // The title is a block of its own, so a blank line goes under it (spaced).
  if (terminalOf(invocation).isPerson) show(invocation, spaced([botHeading(env, command), []]));
  const ghEnv = botEnv(env, token);
  // A new pull request with no milestone takes its linked issue's (#512): one `gh issue view`.
  const wanted = body && !isLookup(body) ? readCommandMilestone(command, body.text) : null;
  const milestone = wanted ? chooseMilestone(invocation, wanted, ghWith(file, cwd, ghEnv)) : null;
  if (milestone === false) return 1;
  if (pendingIssue) {
    const repoLabels = readRepoLabelNames(ghWith(file, cwd, ghEnv));
    const issueProblems = checkIssueLabels(pendingIssue.labels, repoLabels);
    problems.labels.push(...issueProblems);
    if (issueProblems.length) problems.choices.push(...issueLabelChoices(pendingIssue.labels, repoLabels ?? []));
  }
  if (found()) return refusePost();
  // `gh pr edit <number or URL>`: one `gh pr view` with the same token names its branches,
  // and its labels, so an edit can move the tier label to the one its new body sets (#422).
  let current: string[] | null = null;
  let lookedUp = false;
  if (body && isLookup(body)) {
    const branch = lookupBranch(body, file, ghEnv, env);
    lookedUp = true;
    current = 'labels' in branch ? branch.labels ?? null : null;
    if (refuseBody(invocation, checkBody(body, branch, env))) return 1;
  }
  // The type and tier labels the command leaves out, by the names the repo has (#422).
  // An edit also moves the tier label: the pull request's labels say which old one to remove.
  const wantedTier = labels?.edit?.tier ?? null;
  if (wantedTier !== null && !lookedUp) current = readPullRequestLabels(invocation, labels?.edit?.selector ?? null, labels?.repo ?? null, file, ghEnv);
  // A read that failed leaves the old tier label where it is, so the note says so: two tier
  // labels fail `check --pr`, and the caller can remove the old one itself (#422).
  if (wantedTier !== null && current === null) {
    sayNote(invocation, `gh could not read this pull request's labels, so an older tier label may stay next to \`tier ${wantedTier}\`; remove it with --remove-label. \`check --pr\` refuses two tier labels`);
  }
  const chosen = labels?.missing.length ? chooseLabels(invocation, labels, file, ghEnv) : [];
  const addLabel = labels?.edit ? '--add-label' : '--label';
  const adds = chosen.filter((name) => !current?.some((label) => label.toLowerCase() === name.toLowerCase()));
  // The old tier label goes only when the new one is in place: the command gives it, the
  // bot adds it, or the pull request already has it. A tier the repo does not have is left
  // out by `chooseLabels`, so the pull request keeps its current tier label (#422).
  const hasNewTier = Boolean(labels?.hasTierLabel)
    || chosen.some((name) => readLabelTier(name) === wantedTier)
    || (current?.some((label) => readLabelTier(label) === wantedTier) ?? false);
  const removes = wantedTier === null || !hasNewTier ? [] : current?.filter((label) => {
    const tier = readLabelTier(label);
    return tier !== null && tier !== wantedTier && !labels?.removes.some((given) => given.toLowerCase() === label.toLowerCase());
  }) ?? [];
  const labelArgs = [...adds.flatMap((name) => [addLabel, name]), ...removes.flatMap((name) => ['--remove-label', name])];
  const withLabels = labelArgs.length ? addArgs(given, labelArgs) : given;
  const rest = milestone ? addArgs(withLabels, ['--milestone', milestone]) : withLabels;
  // A `gh pr merge` of a tier A pull request needs a code owner's Approve on its head
  // (#612): the merge is refused when the Approve is older, or can't be checked.
  if (file === 'gh' && isPrMerge(rest)) {
    const stopped = refuseStaleMerge(invocation, ghWith(file, cwd, botEnv(env, token)), cwd, env, repo, rest);
    if (stopped) return 1;
  }
  // An `api` call on a pull request's merge endpoint merges too (#612): it goes
  // through the same gate, unless it is provably a read.
  if (file === 'gh' && refuseApiMerge(invocation, ghWith(file, cwd, botEnv(env, token)), cwd, env, repo, rest)) return 1;
  // Last before sending, the privacy check on every text and body file the command sends
  // (#1077). The bot is the gate for what it posts: the guard leaves its body files to it, so
  // they are read here, after the shell wrote them. A file the bot can't read is never sent.
  if (botProgram(file) === 'gh' && refuseLeak(invocation, projectConfig, rest, readStdin)) return 1;
  // A body read from standard input was used up by the checks, so gh gets it the same way.
  const { stdin, stdout, stderr } = invocation;
  const piped = stdinText ?? (stdin.fd === null ? (stdin.text ?? '') : undefined);
  // `gh pr status` shows the Approve check too (#612), so the lead sees a stale Approve
  // before trying to merge. Its output is captured to add the lines after gh's table.
  if (file === 'gh' && showsPrStatus(rest)) {
    return runPrStatus(invocation, file, rest, { cwd, token, origin: repo, piped });
  }
  const result = spawnSync(file, rest, { cwd, stdio: [piped === undefined ? (stdin.fd ?? 'pipe') : 'pipe', childStream(stdout), childStream(stderr)], input: piped, env: botEnv(env, token), maxBuffer: 1 << 30 });
  // What gh said, for a stream that is not the process's own: written as it is, as a terminal would show it.
  if (result.stdout) stdout.write(result.stdout);
  if (result.stderr) stderr.write(result.stderr);
  // A command that never ran, or that a signal ended, says so (#282). Only the file and the
  // code or signal are named: never the token or the environment.
  const stopped = runRefusal(file, result);
  if (stopped) return refuse(invocation, stopped);
  return result.status ?? 1;
}

/** The process's own stream by its fd, so gh writes to it straight; else a pipe, copied after (#475). */
const childStream = (stream: Output): number | 'pipe' => (typeof stream.fd === 'number' ? stream.fd : 'pipe');

// ---- All the problems of a post in one answer (#1120) ----

/** The problems a post has before anything is sent, by the part of the command they are in. */
export interface PostProblems {
  title: Finding[];
  /** What the command sends: a body file the bot can't read, or more than one. */
  sent: Finding[];
  /** The pull request body, or the `Made with` line of a comment, review or issue. */
  body: Finding[];
  labels: Finding[];
  /** Lines under the labels that name the values the repo's labels may take. */
  choices: string[];
}

export const emptyPostProblems = (): PostProblems => ({ title: [], sent: [], body: [], labels: [], choices: [] });

export const countPostProblems = (problems: PostProblems): number => problems.title.length + problems.sent.length + problems.body.length + problems.labels.length;

type PostPart = 'title' | 'sent' | 'body' | 'labels';

/** Each part in the order a reader fixes it: its name, and the word the fix line uses. */
const POST_PARTS: { part: PostPart; name: string; fix: string }[] = [
  { part: 'title', name: 'the title', fix: 'the title' },
  { part: 'sent', name: 'what this command sends', fix: 'it' },
  { part: 'body', name: 'the body', fix: 'the body' },
  { part: 'labels', name: 'the labels', fix: 'the labels' },
];

/**
 * The one refusal for every problem a post has, grouped by part (#1120); null when there is
 * none. One part keeps its rows under the title; more parts get a heading each, so the
 * caller fixes them all in one try.
 */
export function postRefusalOf(problems: PostProblems): BotRefusal | null {
  const parts = POST_PARTS.filter(({ part }) => problems[part].length);
  if (!parts.length) return null;
  const total = count(countPostProblems(problems), 'problem');
  // The label values the repo has are lines of their own under the labels' rows.
  const blocksOf = ({ part }: (typeof POST_PARTS)[number]): string[][] => [problemRows(problems[part]), part === 'labels' ? spaced(problems.choices.map((choice) => wrap('  ', choice.trim()))) : []];
  if (parts.length === 1) {
    const [only] = parts;
    return { rule: 'post', what: `nothing was sent: ${total} in ${only.name}`, fix: `fix ${only.fix}, then run the same command again.`, blocks: blocksOf(only) };
  }
  const names = parts.map(({ name }) => name);
  const joined = `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return {
    rule: 'post',
    what: `nothing was sent: ${total} in ${joined}`,
    fix: 'fix them all, then run the same command again.',
    blocks: parts.flatMap((part) => {
      const [rows, choices] = blocksOf(part);
      return [section(`In ${part.name} (${problems[part.part].length})`, rows), choices];
    }),
  };
}

/** The screen of postRefusalOf, or no lines when the post has no problem. */
export function postRefusal(problems: PostProblems): string[] {
  const refusal = postRefusalOf(problems);
  return refusal ? refusalScreen(refusal) : [];
}

/** The refusal of a push with commits not in UTC: each commit by short hash and subject, never its offset, and the one fix. */
export function utcRefusal(commits: PushedCommit[], head: string | null): BotRefusal {
  return {
    rule: 'push',
    what: `nothing was pushed: ${count(commits.length, 'commit')} ${commits.length === 1 ? 'has' : 'have'} a time zone other than UTC`,
    fix: `run \`${utcFix(commits, head)}\` on the branch, then push again.`,
    blocks: [
      // The hash leads the text, not a label: a long hash would push the subject to a column of its own.
      spaced(commits.map(({ short, subject }) => row('to do', `${short} ${subject}`))),
      summaryLine("A commit's time zone tells where the machine that made it is, so every pushed time is UTC."),
    ],
  };
}

/**
 * Refuses a `git push` that would send a commit not dated in UTC (#1120). True when it
 * refused. When git can't say which commits the push sends, it refuses too: an unread
 * commit could carry the zone.
 */
function refuseNonUtcPush(invocation: Invocation, command: string[]): boolean {
  const plan = readPushPlan(command.slice(1));
  if (!plan) return false;
  const { cwd, env } = invocation;
  const git = (args: string[], okCodes = [0]): { text: string; status: number } => {
    const { stdout, status } = runGit(cwd, [...plan.options, ...args], { env, okCodes });
    return { text: stdout.toString('utf8'), status };
  };
  try {
    const exists = (ref: string): boolean => git(['show-ref', '--verify', '--quiet', ref], [0, 1]).status === 0;
    // A tag's commits are the guard's to check (it handles tags), so a tag source is left out.
    const isTag = (source: string): boolean => source.startsWith('refs/tags/') || (!source.startsWith('refs/') && !exists(`refs/heads/${source}`) && exists(`refs/tags/${source}`));
    const branches = plan.every ? git(['for-each-ref', '--format=%(refname)', 'refs/heads/']).text.split('\n').filter(Boolean) : [];
    const sources = [...plan.sources.filter((source) => !isTag(source)), ...branches];
    if (!sources.length) return false;
    // What the remote already has is not sent: its remote-tracking refs fence the range. A
    // remote named by URL, or one with no such refs, is fenced by every remote's refs.
    const remote = plan.remote ?? 'origin';
    const tracked = /^[A-Za-z0-9._-]+$/.test(remote) && git(['for-each-ref', '--count=1', '--format=%(refname)', `refs/remotes/${remote}/`]).text.trim() !== '';
    const lines = git(['log', '--topo-order', `--format=${COMMIT_FORMAT}`, ...sources, '--not', tracked ? `--remotes=${remote}` : '--remotes']).text.split('\n');
    const commits = nonUtcCommits(lines);
    if (!commits.length) return false;
    const head = git(['rev-parse', '--verify', '--quiet', 'HEAD'], [0, 1]).text.trim() || null;
    refuse(invocation, utcRefusal(commits, head));
  } catch {
    refuse(invocation, { rule: 'push', what: 'nothing was pushed: git could not say which commits this push sends, so their time zones were not checked', fix: 'check that each branch you push exists, then push again.' });
  }
  return true;
}

/**
 * Runs the privacy check of `rules/privacy.ts` on what gh is about to send, as the sender
 * (#1077), and prints the problem. True when it refuses.
 */
function refuseLeak(invocation: Invocation, config: Config, args: string[], readStdin: () => string): boolean {
  const { env, cwd } = invocation;
  // Standard input only for an option value the bot rewrites, never a title such as `x=-` (#1104).
  const leak = checkPost({ args, stdinText: readsStdinBody(args) ? readStdin() : undefined }, { env, privacy: config.privacy, cwd, command: '', isSender: true });
  if (!leak) return false;
  print(invocation, postRefusal({ ...emptyPostProblems(), sent: [leak] }), invocation.stderr);
  return true;
}

/** A body file the bot can't read: nothing is sent (#1077). */
const UNREADABLE = 'unreadable';

function refuseUnreadable(invocation: Invocation): number {
  return refuse(invocation, { rule: 'post', what: 'nothing was sent: the body file could not be read', fix: 'write the file, then run the same command again.' });
}

/** A pull request body a command is about to set, read and not yet checked. */
interface PendingBody {
  root: string;
  text: string;
  base: string | null;
  head: string | null;
  repo: string | null;
}

/**
 * The body `gh pr create` or `gh pr edit` sets, read from the command, a file or standard
 * input. Null when there is none, the repo has no yokoten.json, or the command names another
 * repo. UNREADABLE when the file can't be read: the bot then sends nothing (#1077).
 */
function readPendingBody(invocation: Invocation, command: string[], root: string, readStdin: () => string): PendingBody | typeof UNREADABLE | null {
  const found = readCommandBody(command);
  if (!found || !existsSync(join(root, 'yokoten.json')) || !isOrigin(root, found.repo, invocation.env)) return null;
  try {
    if ('text' in found.body) return { root, text: found.body.text, base: found.base, head: found.head, repo: found.repo };
    const text = found.body.file === '-' ? readStdin() : readFileSync(resolve(invocation.cwd, found.body.file), 'utf8');
    return { root, text, base: found.base, head: found.head, repo: found.repo };
  } catch {
    return UNREADABLE;
  }
}

/** A comment, review or new-issue body a command is about to set, read and not yet checked. */
interface PendingNote {
  root: string;
  text: string;
  repo: string | null;
  /** Whether the command names `--attach`: gh posts those uploads after the body. */
  attach: boolean;
}

// The options of `issue`/`pr` `comment`, `pr review` and `issue create` that take a value,
// so their value is not read as the noun or the verb. Gh's host flag is here too, so a
// host before the noun is not read as the noun. A run-together word expands letter
// by letter, the way gh reads it; a value that looks like another flag is not consumed,
// the way `parse` reads yokoten's own options. `--attach` uploads land after the body,
// so any `--attach` is refused rather than checked.
const NOTE_VALUES = new Set(['--body', '-b', '--body-file', '-F', '--repo', '-R', '--hostname', '--title', '-t', '--label', '-l', '--add-label', '--milestone', '-m', '--project', '-p', '--assignee', '-a', '--reviewer', '-r', '--base', '-B', '--head', '-H', '--template', '-T', '--type', '--attach']);
const NOTE_SHORT_VALUES = 'bFRtlmarBHpT';
// On `gh pr review`, `-a` (`--approve`) and `-r` (`--request-changes`) are booleans, and
// there is no assignee or reviewer: those four spellings take no value there.
const REVIEW_VALUES = new Set([...NOTE_VALUES].filter((flag) => flag !== '--assignee' && flag !== '-a' && flag !== '--reviewer' && flag !== '-r'));
// The short letters that take a value on `gh pr review`: only the body and repo letters,
// since `-a`, `-r` and `-c` (`--comment`) are booleans there.
const REVIEW_SHORT_VALUES = 'bFR';

/** The words and the option values of a note command's args, read with one command's flags. */
interface NoteArgs {
  /** Each word that is not an option or an option's value. */
  words: string[];
  /** Each option and its value, in order, with `--attach` kept apart. */
  options: [name: string, value: string][];
  /** Whether the command names `--attach`. */
  attach: boolean;
}

/**
 * The words and the option values of a note command's args. As in gh, the last spelling
 * of an option wins; a run-together word expands letter by letter (`-wb` is `-w -b`); a
 * separate value that looks like another flag is not consumed, so it is read as a flag.
 * A bare `--` is the exception: in value position it is the value, as gh reads it, and
 * parsing continues after it; in flag position it still ends the flags.
 */
function readNoteArgs(args: string[], values: Set<string>, shorts: string): NoteArgs {
  const rest = [...args];
  const words: string[] = [];
  const options: [string, string][] = [];
  let attach = false;
  for (let index = 0; index < rest.length; index++) {
    const word = rest[index];
    if (word === '--') break;
    if (word === '-' || !word.startsWith('-')) {
      words.push(word);
      continue;
    }
    let name = word;
    let value: string | undefined;
    const equals = word.startsWith('--') ? word.indexOf('=') : -1;
    if (equals > 0) {
      name = word.slice(0, equals);
      value = word.slice(equals + 1);
    } else if (!word.startsWith('--') && word.length > 2) {
      if (!shorts.includes(word[1])) {
        // A run-together word starting with a boolean letter: gh reads the letter as a
        // flag and the rest again, so the letter is dropped and the rest is read again.
        rest[index] = `-${word.slice(2)}`;
        index -= 1;
        continue;
      }
      name = word.slice(0, 2);
      value = word.slice(2);
      // Gh drops the `=` of an attached short value: `-t=x` is the title `x`.
      if (value.startsWith('=')) value = value.slice(1);
    }
    if (!values.has(name)) continue;
    if (value === undefined) {
      const next = rest[index + 1];
      if (next === undefined) break;
      // A bare `--` here is the value, as gh reads it; any longer `--` word is a flag.
      if (next !== '--' && next.startsWith('--')) continue;
      index += 1;
      value = rest[index];
    }
    if (name === '--attach') {
      attach = true;
      continue;
    }
    options.push([name, value]);
  }
  return { words, options, attach };
}

/**
 * The body that `gh pr comment`, `gh issue comment`, `gh pr review` or `gh issue create`
 * sets with `--body`, `-b`, `--body-file` or `-F`, in any spelling gh takes. As in gh, the
 * last one wins. Null for any other command, for one with no body and no `--attach` (a
 * plain approve), for an edit (which stays as it is), or when the repo has no yokoten.json,
 * or the command names another repo. UNREADABLE when the file can't be read: the bot then
 * sends nothing (#1077). A `--attach` alone still returns a note, so the upload is refused below: gh
 * would post it with no `Made with` line.
 */
function readPendingNoteBody(invocation: Invocation, command: string[], root: string, readStdin: () => string): PendingNote | typeof UNREADABLE | null {
  const [file, ...rest] = command;
  if (!file || botProgram(file) !== 'gh') return null;
  const { words } = readNoteArgs(rest, NOTE_VALUES, NOTE_SHORT_VALUES);
  const [kind, verb] = words;
  const isNote = (kind === 'issue' && (verb === 'comment' || verb === 'create' || verb === 'new')) || (kind === 'pr' && (verb === 'comment' || verb === 'review'));
  if (!isNote) return null;
  const isReview = kind === 'pr' && verb === 'review';
  const found = isReview ? readNoteArgs(rest, REVIEW_VALUES, REVIEW_SHORT_VALUES) : readNoteArgs(rest, NOTE_VALUES, NOTE_SHORT_VALUES);
  let body: string | { file: string } | null = null;
  let repo: string | null = null;
  for (const [name, value] of found.options) {
    if (name === '--body' || name === '-b') body = value;
    else if (name === '--body-file' || name === '-F') body = { file: value };
    else if (name === '--repo' || name === '-R') repo = value;
  }
  if ((!body && !found.attach) || !existsSync(join(root, 'yokoten.json')) || !isOrigin(root, repo, invocation.env)) return null;
  try {
    // An empty body is nothing to check, as gh posts it as it is; `--attach` alone
    // still returns a note below, so the upload is refused.
    if (typeof body === 'string' && body === '' && !found.attach) return null;
    if (typeof body === 'string') return { root, text: body, repo, attach: found.attach };
    if (body === null) return { root, text: '', repo, attach: found.attach };
    const text = body.file === '-' ? readStdin() : readFileSync(resolve(invocation.cwd, body.file), 'utf8');
    if (text === '' && !found.attach) return null;
    return { root, text, repo, attach: found.attach };
  } catch {
    return UNREADABLE;
  }
}

/**
 * The problems with a comment, review or new-issue body: `--attach` uploads land after
 * the body, past the `Made with` line, so any `--attach` is refused; otherwise only the
 * `Made with` line is checked, with or without a body (#609).
 */
function checkNote(note: PendingNote): Finding[] {
  if (note.attach) return [finding('pr-made-with', 'body: `--attach` appends the upload after the `Made with` line', 'drop `--attach`, or link an uploaded file in the body instead')];
  return checkNoteMadeWith(note.text);
}

/**
 * The problems with a comment, review or new-issue body: only the `Made with` line, with
 * the same check (`madeWithFindings`) and the same message as a pull request body (#609). The
 * wording here mirrors `checkPullRequestBody`, which owns it.
 */
function checkNoteMadeWith(text: string): Finding[] {
  return madeWithFindings(text);
}

/** Whether `--repo` names this repo's origin, or no repo at all. */
function isOrigin(root: string, repo: string | null, env: Env): boolean {
  if (repo === null) return true;
  let origin: string | null = null;
  try {
    origin = repoOf(execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    // no origin: the named repo is another one
  }
  return origin?.toLowerCase() === repo.replace(/^(https?:\/\/)?github\.com\//, '').toLowerCase();
}

/**
 * The labels `gh pr create` leaves out, and the problems with those it gives, by `check
 * --pr` (#422). Null when the repo has no yokoten.json, or the command names another repo.
 */
function readPendingLabels(command: string[], root: string, body: PendingBody | null, env: Env): CommandLabels | null {
  if (!existsSync(join(root, 'yokoten.json'))) return null;
  const labels = readCommandLabels(command, body?.text ?? null);
  return labels && isOrigin(root, labels.repo, env) ? labels : null;
}

/**
 * The labels a `gh issue create` command gives, or null when the repo has no
 * yokoten.json, the command names another repo, or it is no issue create (#544).
 */
function readPendingIssueLabels(command: string[], root: string, env: Env): CommandIssueLabels | null {
  if (!existsSync(join(root, 'yokoten.json'))) return null;
  const found = readCommandIssueLabels(command);
  return found && isOrigin(root, found.repo, env) ? found : null;
}

/**
 * For each missing label, the first name the repo has, from one `gh label list` with the
 * bot's token. A label the repo does not have is said plainly and left out; the bot never
 * creates one. When gh can't list the labels, the best name is used, and gh says the rest.
 */
function chooseLabels(invocation: Invocation, labels: CommandLabels, gh: string, ghEnv: Env): string[] {
  const list = spawnSync(gh, ['label', 'list', '--json', 'name', '--limit', '1000', ...(labels.repo ? ['--repo', labels.repo] : [])], { cwd: invocation.cwd, encoding: 'utf8', env: ghEnv, stdio: ['ignore', 'pipe', 'ignore'] });
  let names: string[] | null = null;
  try {
    const parsed: unknown = JSON.parse(list.stdout ?? '');
    if (list.status === 0 && Array.isArray(parsed)) names = parsed.map((label: { name?: unknown }) => String(label?.name ?? ''));
  } catch {
    // gh said no list: use the best names
  }
  if (!names) return labels.missing.map(([best]) => best);
  const known = new Map(names.map((name) => [name.toLowerCase(), name]));
  const chosen: string[] = [];
  for (const wanted of labels.missing) {
    const found = wanted.map((name) => known.get(name.toLowerCase())).find((name) => name !== undefined);
    if (found !== undefined) chosen.push(found);
    else sayNote(invocation, `the repo has no label \`${wanted[0]}\`, so the pull request gets none; create it on GitHub, or pass another with --label. \`check --pr\` asks for it`);
  }
  return chosen;
}

/**
 * The labels of the pull request an edit names, from one `gh pr view` with the bot's token.
 * Null when gh can't say: the caller then adds what the command says and removes nothing.
 */
function readPullRequestLabels(invocation: Invocation, selector: string | null, repo: string | null, gh: string, ghEnv: Env): string[] | null {
  const args = ['pr', 'view', ...(selector === null ? [] : [selector]), '--json', 'labels', ...(repo === null ? [] : ['--repo', repo])];
  const view = spawnSync(gh, args, { cwd: invocation.cwd, encoding: 'utf8', env: ghEnv, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    const parsed: unknown = JSON.parse(view.stdout ?? '');
    if (view.status === 0 && Array.isArray((parsed as { labels?: unknown })?.labels)) {
      return ((parsed as { labels: { name?: unknown }[] }).labels).map((label) => String(label?.name ?? ''));
    }
  } catch {
    // said by the caller
  }
  return null;
}

/** The gh arguments with `added` before any `--`. */
function addArgs(args: string[], added: string[]): string[] {
  const end = args.indexOf('--');
  return end === -1 ? [...args, ...added] : [...args.slice(0, end), ...added, ...args.slice(end)];
}

/**
 * Runs the gh the command names, with the bot's token. It throws when gh fails.
 * The error keeps gh's stderr, so a contents 404 is not a failed read.
 */
const ghWith =
  (file: string, cwd: string, ghEnv: Env): Gh =>
  (args) =>
    execFileSync(file, args, { cwd, env: ghEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/**
 * The milestone of the first linked issue that has one (#512). False, after saying why,
 * when every linked issue was read and none has one. Null, with a note, when gh can't read
 * an issue: a network hiccup never stops a post, and `check --pr` still asks for it.
 */
function chooseMilestone(invocation: Invocation, wanted: CommandMilestone, gh: Gh): string | null | false {
  const unread: number[] = [];
  for (const issue of wanted.issues) {
    const milestone = readIssueMilestone(gh, issue, wanted.repo);
    if (milestone) return milestone;
    if (milestone === undefined) unread.push(issue);
  }
  if (unread.length) {
    const named = unread.map((issue) => `#${issue}`).join(', ');
    sayNote(invocation, `gh could not read the milestone of issue ${named}, so the pull request gets none; pass --milestone. \`check --pr\` asks for it`);
    return null;
  }
  refuse(invocation, { rule: 'post', what: 'nothing was sent: 1 problem in the milestone', fix: 'fix the command, then run it again.', blocks: [problemRows([noMilestoneFinding(wanted.issues)])] });
  return false;
}

/** Whether the pull request is named by a number or a URL, so gh must say its branches. */
const isLookup = (body: PendingBody): boolean => body.head !== null && /^\d+$|^https?:/.test(body.head);

/** The branches to compare and the pull request's labels, or why the body is checked without the changed files. */
type Branch = { base: string; head: string; files?: ReturnType<typeof readBranchFiles>; labels?: string[] } | { why: string };

/** This branch, or the one `--head` or `gh pr edit <branch>` names, against origin/<base>. */
function localBranch(body: PendingBody): Branch {
  // Another owner's branch (`owner:branch`) is not here to compare.
  if (body.head?.includes(':')) return { why: `\`${body.head}\` is another owner's branch` };
  return { base: `origin/${body.base ?? 'main'}`, head: body.head ?? 'HEAD' };
}

/**
 * The branches of the pull request `gh pr edit <number or URL>` names, from one `gh pr view`
 * with the bot's token (#406). The edit goes to the network anyway. A branch that is not
 * here yet is fetched from origin, quietly.
 */
function lookupBranch(body: PendingBody, gh: string, ghEnv: Env, env: Env): Branch {
  const view = spawnSync(gh, ['pr', 'view', body.head ?? '', '--json', 'headRefName,baseRefName,labels', ...(body.repo ? ['--repo', body.repo] : [])], { cwd: body.root, encoding: 'utf8', env: ghEnv, stdio: ['ignore', 'pipe', 'ignore'] });
  let refs: { headRefName?: unknown; baseRefName?: unknown; labels?: unknown } = {};
  try {
    refs = JSON.parse(view.stdout ?? '');
  } catch {
    // said below
  }
  if (view.status !== 0 || typeof refs.headRefName !== 'string' || typeof refs.baseRefName !== 'string') {
    return { why: `gh could not say the branches of pull request \`${body.head}\`` };
  }
  const base = body.base ?? refs.baseRefName;
  const branch = { base: `origin/${base}`, head: `origin/${refs.headRefName}` };
  const labels = Array.isArray(refs.labels) ? refs.labels.map((label) => String((label as { name?: unknown })?.name ?? '')) : undefined;
  const files = readBranchFiles(body.root, branch.base, branch.head, env);
  if (files) return { ...branch, files, labels };
  spawnSync('git', ['fetch', '--quiet', '--no-tags', 'origin', '--end-of-options', refs.headRefName, base], { cwd: body.root, env, stdio: 'ignore' });
  return { ...branch, labels };
}

/** The problems with a body: every body rule of `check --pr` when the branch's files can be read, else the body alone, with a note. */
function checkBody(body: PendingBody, branch: Branch, env: Env): { problems: Finding[]; note?: string } {
  const config = loadConfig(body.root);
  const files = 'why' in branch ? null : (branch.files ?? readBranchFiles(body.root, branch.base, branch.head, env));
  if ('why' in branch || !files) {
    const why = 'why' in branch ? branch.why : `git can't compare ${branch.head} with ${branch.base}`;
    return { problems: checkPullRequestBody({ body: body.text, files: [] }, config), note: `${why}, so the body was checked without the changed files; CI checks the rest` };
  }
  const pr = { body: body.text, ...files };
  const problems = checkPullRequestBody(pr, config);
  const owned = checkOwnedTier(pr, readCodeOwners(body.root, branch.base, env));
  if (owned) problems.push(owned);
  return { problems };
}

/** Prints the problems with a body the way the title check does, or its note. True when it refuses. */
function refuseBody(invocation: Invocation, { problems, note }: { problems: Finding[]; note?: string }): boolean {
  if (problems.length) {
    print(invocation, postRefusal({ ...emptyPostProblems(), body: problems }), invocation.stderr);
    return true;
  }
  if (note) sayNote(invocation, note);
  return false;
}

/** The gh options that take a value, by long name, for `pr merge` and `pr status`. */
const PR_VALUE_OPTIONS = new Set(['--repo', '--body', '--body-file', '--subject', '--author-email', '--match-head-commit', '--jq', '--template', '--json']);
/** The short forms of those: R, b, F, q, t. */
const PR_VALUE_SHORTS = new Map([['R', '--repo'], ['b', '--body'], ['F', '--body-file'], ['q', '--jq'], ['t', '--template']]);

/** A gh command split into plain words and valued options: a value is never read as a word. */
function splitGhArgs(args: string[]): { words: string[]; options: [string, string][] } {
  const words: string[] = [];
  const options: [string, string][] = [];
  for (let index = 0; index < args.length; index++) {
    const word = args[index];
    if (word === '--') {
      words.push(...args.slice(index + 1));
      break;
    }
    if (!word.startsWith('-') || word === '-') {
      words.push(word);
      continue;
    }
    if (word.startsWith('--')) {
      const cut = word.indexOf('=');
      const name = cut === -1 ? word : word.slice(0, cut);
      if (!PR_VALUE_OPTIONS.has(name)) continue;
      options.push([name, cut === -1 ? (args[++index] ?? '') : word.slice(cut + 1)]);
      continue;
    }
    // A short word: a value letter takes the rest of the word, or the next word.
    const mapped = PR_VALUE_SHORTS.get(word[1]);
    if (mapped === undefined) continue;
    const rest = word.slice(2).replace(/^=/, '');
    options.push([mapped, rest || (args[++index] ?? '')]);
  }
  return { words, options };
}

/** "owner/name" with no URL, path or case left in it, for comparing repos. */
const normalizeRepoName = (name: string): string => name.trim().replace(/^(?:https?:\/\/)?github\.com\//i, '').replace(/\.git\/?$/, '').toLowerCase();

/** Whether the gh command merges a pull request: `pr merge ...`. */
const isPrMerge = (args: string[]): boolean => {
  const { words } = splitGhArgs(args);
  return words[0] === 'pr' && words[1] === 'merge';
};

/** Whether the gh command lists pull requests as a table: `pr status` with no format option. */
const showsPrStatus = (args: string[]): boolean => {
  const { words, options } = splitGhArgs(args);
  if (words[0] !== 'pr' || words[1] !== 'status' || words.length > 2 || args.includes('--json')) return false;
  // `--json` is a valued option, so `--json=<fields>` lands in the options too (#612).
  return !options.some(([name]) => name === '--jq' || name === '--template' || name === '--json');
};

/** The `--repo` value of a gh command, or null when it names none. */
const repoFlag = (args: string[]): string | null => splitGhArgs(args).options.filter(([name]) => name === '--repo').at(-1)?.[1] ?? null;

/** The number in a `gh pr view` answer, or null. Never throws. */
function viewedNumber(gh: Gh, args: string[]): number | null {
  try {
    const viewed: unknown = JSON.parse(gh(args));
    if (typeof viewed === 'object' && viewed !== null && typeof (viewed as { number?: unknown }).number === 'number') return (viewed as { number: number }).number;
  } catch {
    // said below
  }
  return null;
}

/** The pull request a `gh pr merge` names: its number and repo, or why it can't be read. */
function mergeRequest(gh: Gh, args: string[], origin: string | null): { number: number; repo: string } | { unsure: string } {
  const { words } = splitGhArgs(args);
  const flag = repoFlag(args);
  const repo = flag ?? origin;
  if (!repo) return { unsure: 'no repo is named and this checkout names no origin' };
  if (flag && origin && normalizeRepoName(flag) !== normalizeRepoName(origin)) return { unsure: `${flag} is not this checkout, so its commits are not here` };
  const repoArgs = flag ? ['--repo', flag] : [];
  const target = words[2];
  if (target === undefined) {
    const number = viewedNumber(gh, ['pr', 'view', '--json', 'number', ...repoArgs]);
    return number === null ? { unsure: 'gh could not say the pull request of this branch' } : { number, repo };
  }
  const digits = /^(\d+)$/.exec(target);
  if (digits) return { number: Number(digits[1]), repo };
  // A URL names its own repo: `github.com/owner/name/pull/12`, or the API form
  // `repos/owner/name/pulls/12`. Any other `/pull/12` keeps the old answer below.
  const urlRepo = /(?:github\.com\/|repos\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/pulls?\/\d+(?:[/#?]|$)/i.exec(target);
  const fromUrl = /\/pulls?\/(\d+)(?:[/#?]|$)/.exec(target);
  if (fromUrl) {
    if (urlRepo) {
      const named = urlRepo[1];
      if (origin && normalizeRepoName(named) !== normalizeRepoName(origin)) return { unsure: `${named} is not this checkout, so its commits are not here` };
      return { number: Number(fromUrl[1]), repo: named };
    }
    return { number: Number(fromUrl[1]), repo };
  }
  if (words.length > 3) return { unsure: 'more than one pull request is named; merge one at a time' };
  // A branch: gh says its pull request's number.
  const number = viewedNumber(gh, ['pr', 'view', target, '--json', 'number', ...repoArgs]);
  return number === null ? { unsure: `gh could not say the pull request of branch \`${target}\`` } : { number, repo };
}

/** An `api` path that merges a pull request: repos/{owner}/{repo}/pulls/<n>/merge. */
const API_MERGE_ENDPOINT = /^\/?repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/merge(\?.*)?$/;

/** The `api` option names that make a call something other than a bare GET. */
const API_WRITE_OPTIONS = new Set(['-X', '--method', '-f', '--field', '-F', '--raw-field', '--input']);

/**
 * The merge an `api` command attempts, or null. A merge endpoint with a method or
 * a field option merges (or may merge), so it goes through the gate; a bare path is
 * a GET read and passes through (#612). A `--` ends the flags, as in gh.
 */
function apiMerge(args: string[]): { number: number; repo: string } | null {
  const end = args.indexOf('--');
  const before = end === -1 ? args : args.slice(0, end);
  const found = before.find((word) => API_MERGE_ENDPOINT.test(word));
  const endpoint = found && API_MERGE_ENDPOINT.exec(found);
  if (!endpoint) return null;
  // A run-together word expands letter by letter, the way gh reads it (`-sF` is
  // `-s -F`), so any write letter in it counts, mirroring the note parser.
  const writes = before.some((word) => {
    if (!word.startsWith('-') || word === '-') return false;
    if (word.startsWith('--')) return API_WRITE_OPTIONS.has(word.split('=')[0]);
    return [...word.slice(1)].some((letter) => API_WRITE_OPTIONS.has(`-${letter}`));
  });
  if (!writes) return null;
  return { number: Number(endpoint[3]), repo: `${endpoint[1]}/${endpoint[2]}` };
}

/** Refuses an `api` merge the Approve check stops. True when it refused. */
function refuseApiMerge(invocation: Invocation, gh: Gh, cwd: string, env: Env, origin: string | null, args: string[]): boolean {
  const merge = apiMerge(args);
  if (!merge) return false;
  if (origin && normalizeRepoName(merge.repo) !== normalizeRepoName(origin)) {
    refuse(invocation, mergeRefusal({ kind: 'unchecked', text: `could not check the owner's Approve (${merge.repo} is not this checkout, so its commits are not here)` }));
    return true;
  }
  const refusal = approvalRefusal(gh, cwd, env, merge.number, merge.repo);
  if (!refusal) return false;
  refuse(invocation, mergeRefusal(refusal));
  return true;
}

/** Why a merge stops. `kind` picks the status list, so the words of `text` do not. */
interface MergeStop {
  kind: 'unchecked' | 'needsApprove';
  text: string;
}

/** The refusal of a merge the Approve check stops: what stopped it, and the fix its kind has. */
export const mergeRefusal = (stop: MergeStop): BotRefusal => ({
  rule: 'merge',
  what: `nothing was merged: ${stop.text}`,
  fix: stop.kind === 'needsApprove' ? 'Merge again once the owner has approved the head on GitHub.' : 'Fix what stopped the check, then merge again.',
});

/**
 * Why pull request `number` must not merge yet, or null when it may: not tier A, or the
 * owner's Approve is on its head, or an area lead of another model than every writer
 * approved it (record 0047), or only base merges came after that Approve with the same own diff.
 * What gh or git can't answer is `unchecked`. It names the cause and does not ask for
 * a new Approve. A missing or stale Approve is `needsApprove`.
 */
function approvalRefusal(gh: Gh, root: string, env: Env, number: number, repo: string): MergeStop | null {
  const state = readApprovalState(gh, root, env, number, repo);
  if ('unsure' in state) return { kind: 'unchecked', text: `could not check the owner's Approve (${state.unsure})` };
  if (state.tier !== 'A') return null;
  const problem = checkMergeApproval(state);
  return problem ? { kind: 'needsApprove', text: problem.what } : null;
}

/** Refuses a `gh pr merge` the Approve check stops. True when it refused. */
function refuseStaleMerge(invocation: Invocation, gh: Gh, cwd: string, env: Env, origin: string | null, args: string[]): boolean {
  const found = mergeRequest(gh, args, origin);
  if ('unsure' in found) {
    refuse(invocation, mergeRefusal({ kind: 'unchecked', text: `could not check the owner's Approve (${found.unsure})` }));
    return true;
  }
  const refusal = approvalRefusal(gh, cwd, env, found.number, found.repo);
  if (!refusal) return false;
  refuse(invocation, mergeRefusal(refusal));
  return true;
}

/**
 * The tier a `pr list` row with a body and labels says, or null when it says none:
 * then the deep check reads it (#612).
 */
function listTier(entry: { body?: unknown; labels?: unknown }): string | null {
  const body = typeof entry.body === 'string' ? entry.body : '';
  const names = Array.isArray(entry.labels)
    ? entry.labels.map((label) => (typeof label === 'object' && label !== null ? String((label as { name?: unknown }).name ?? '') : '')).filter(Boolean)
    : [];
  if (!body && !names.length) return null;
  return prTier(body, names);
}

/**
 * Runs `gh pr status`, shows its table as gh wrote it, then the Approve check for every
 * open pull request. One list call says each tier, and only tier A (or a row whose tier
 * it can't say) needs the deep check (#612). A missing or stale Approve is one list.
 * A check that could not be read is another. A list is printed only when it has a row.
 */
function runPrStatus(invocation: Invocation, file: string, args: string[], run: { cwd: string; token: string; origin: string | null; piped: string | undefined }): number {
  const { stdout, stderr } = invocation;
  const env = botEnv(invocation.env, run.token);
  const gh = ghWith(file, run.cwd, env);
  const shown = spawnSync(file, args, { cwd: run.cwd, stdio: [run.piped === undefined ? (invocation.stdin.fd ?? 'pipe') : 'pipe', 'pipe', 'pipe'], input: run.piped, env, maxBuffer: 1 << 30 });
  if (shown.stdout) stdout.write(shown.stdout);
  if (shown.stderr) stderr.write(shown.stderr);
  const stopped = runRefusal(file, shown);
  if (stopped) return refuse(invocation, stopped);
  if (shown.status !== 0) return shown.status ?? 1;
  const flag = repoFlag(args);
  const repo = flag ?? run.origin;
  // With no repo to check, the status says nothing: never a bogus ask-the-owner line (#612).
  if (!repo) return 0;
  let listed: unknown;
  try {
    listed = JSON.parse(gh(['pr', 'list', '--json', 'number,body,labels', '--state', 'open', '--limit', '100', ...(flag ? ['--repo', flag] : [])]));
  } catch {
    return 0;
  }
  if (!Array.isArray(listed)) return 0;
  const needsApprove: string[][] = [];
  const unchecked: string[][] = [];
  for (const entry of listed) {
    if (typeof entry !== 'object' || entry === null) continue;
    const number = (entry as { number?: unknown }).number;
    if (typeof number !== 'number') continue;
    const tier = listTier(entry as { body?: unknown; labels?: unknown });
    if (tier !== null && tier !== 'A') continue;
    const refusal = approvalRefusal(gh, run.cwd, invocation.env, number, repo);
    if (!refusal) continue;
    // A check that could not be read is not a missing Approve.
    if (refusal.kind === 'unchecked') unchecked.push(row("can't check", refusal.text, `#${number}`));
    else needsApprove.push(row('to do', refusal.text, `#${number}`));
  }
  show(invocation, approveScreen(needsApprove, unchecked));
  return 0;
}

/**
 * What `gh pr status` adds under gh's table (#612): a title that says how many open pull
 * requests can't merge yet, then one section for a missing or stale Approve and one for a
 * check that could not be read. No lines when every one may merge.
 */
export function approveScreen(needsApprove: readonly (readonly string[])[], unchecked: readonly (readonly string[])[]): string[] {
  const total = needsApprove.length + unchecked.length;
  if (!total) return [];
  return screen(
    title('bot', `${count(total, 'open pull request')} can't merge yet`),
    section('Need a new owner Approve', spaced(needsApprove)),
    section('Could not be checked', spaced(unchecked)),
  );
}

export function runBot(invocation: Invocation): number | Promise<number> {
  const { args } = invocation;
  // No options of its own: everything after `--` is the command, passed on unchanged.
  const end = args.indexOf('--');
  const options = parse('bot', end === -1 ? args : args.slice(0, end));
  if (typeof options === 'string') return usage(invocation, options);
  const command = end === -1 ? [] : args.slice(end + 1);
  // A bare `yokoten bot` only reads (#1044): it says how to name a command, and runs nothing.
  if (!command.length) return usage(invocation, 'no command to run; name one after `--`, as in `yokoten bot -- gh pr create --fill`');
  return bot(invocation, command);
}
