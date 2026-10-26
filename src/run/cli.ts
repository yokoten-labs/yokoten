// How yokoten is called. Hooks, the git hook and CI name the entry point by path, and
// setup and doctor need to recognise a command that runs it.

// A package runner that starts the published yokoten at the start of a line or a command:
// npx, npx --yes, bunx, pnpm dlx, npm exec. "yokoten-check" or "echo npx yokoten" is not one.
// The flags are read one word at a time, so a long line takes linear time and never throws
// (#431): a regex that repeats a group over the whole line ran out of stack.

import { helpScreen, type HelpExample, type HelpSection, type HelpSpec } from '../platform/screen.ts';
import { docsLink } from '../rules/message.ts';

const RUNNER_HEAD = /^[ \t]*(?:npx|bunx|pnpm[ \t]+dlx|npm[ \t]+exec)/gm;
const RUNNER_FLAG = /[ \t]+-\S+/y;

/** A test of a command, as `runs` gives it: true when the text holds the command. */
export interface CommandTest {
  test: (text: string) => boolean;
}

/** Whether a package runner at a line start, after its flags, runs what `rest` (a sticky regex) matches. */
function runsByRunner(text: string, rest: RegExp): boolean {
  for (const head of text.matchAll(RUNNER_HEAD)) {
    let at = head.index + head[0].length;
    for (RUNNER_FLAG.lastIndex = at; RUNNER_FLAG.test(text); RUNNER_FLAG.lastIndex = at) at = RUNNER_FLAG.lastIndex;
    rest.lastIndex = at;
    if (rest.test(text)) return true;
  }
  return false;
}

/**
 * A command that runs yokoten's `<sub>` by the path of a yokoten file (yokoten.ts or
 * yokoten.mjs): the form yokoten builds for its own hooks. A package runner's `npx yokoten
 * <sub>` is not one: that is a hook the user wrote, and install and uninstall leave it (#984).
 */
export const runsByPath = (sub: string): RegExp => new RegExp(`yokoten\\.(?:ts|mjs)"?\\s+${sub}\\b`);

/** A command that runs yokoten's `<sub>`, by whatever path (yokoten.ts or, since #408, yokoten.mjs), or by a package runner (#298). */
export const runs = (sub: string): CommandTest => {
  const byPath = runsByPath(sub);
  const afterRunner = new RegExp(String.raw`[ \t]+yokoten(?:@[\w.^~-]+)?\s+${sub}\b`, 'y');
  return { test: (text) => byPath.test(text) || runsByRunner(text, afterRunner) };
};

/** The yokoten subcommand a command runs, if any. The word ends at a `;`, as in a tool-call guard (#260). */
export const subcommand = (command: string): string | undefined => command.match(/yokoten\.(?:ts|mjs)"?\s+(\w[\w-]*)/)?.[1];

/**
 * A hook command that runs `node <path> <args>`, with `path` quoted for the shell. When the
 * file is gone, it says `missing` in one line, never a Node stack trace with the full path
 * (#204). It exits 1: the agents report that and go on, so a missing copy never blocks
 * every tool call. At session start the line goes to stdout with exit 0, where the agent
 * reads it, as plain text or, for Gemini CLI, as JSON (`sessionOutput`). The test's own
 * error goes to /dev/null, so a broken path never prints the full path.
 * `missing` has no quote or backslash, so it fits in the echo and the JSON as it is. It
 * never names the file followed by a word, or `subcommand` would read that word.
 * A tool-call guard (`isToolCall`) fails closed: see `refuseOnFailure`.
 */
export function guardCommand(
  path: string,
  args: string,
  missing: string,
  {
    isSessionStart = false,
    sessionOutput = 'text',
    isToolCall = false,
  }: { isSessionStart?: boolean; sessionOutput?: 'text' | 'json'; isToolCall?: boolean } = {},
): string {
  if (/['"\\]/.test(missing)) throw new Error(`a missing-runtime line has a quote or a backslash: ${missing}`);
  const line = sessionOutput === 'json' ? `{"hookSpecificOutput":{"additionalContext":"${missing}"}}` : missing;
  const say = isSessionStart ? `echo '${line}'; exit 0` : `echo '${missing}' >&2; exit 1`;
  const check = `[ -f ${path} ] 2>/dev/null || { ${say}; }; `;
  return check + (isToolCall ? refuseOnFailure(path, args) : `node ${path} ${args}`);
}

/**
 * Caps the tool-call guard's heap at 256 MB. A read that runs away aborts in a second or
 * two and is refused, instead of swapping until the agent's hook timeout lets the call
 * through (#260). One tool call is at most a few MB of JSON, so this leaves a wide margin.
 */
export const GUARD_HEAP = '--max-old-space-size=256';

/** What a tool-call guard says when node is not on the agent's PATH. It lets the call go on, as a missing runtime does. */
export const MISSING_NODE = 'yokoten: the guard cannot run, because node is not on PATH for this agent; run yokoten doctor in a terminal';

/**
 * `node <path> <args>`, a tool-call guard, failing closed (#260). The agents block a call
 * on exit 2 only, and run it on any other failure, so a guard that crashes, runs out of
 * memory or is killed would let the call through. Here 0 and 2 pass as they are, stdout
 * and stderr both, and anything else, a signal (128 + its number) included, becomes 2
 * with one line on stderr and nothing more: node's own stderr, a heap trace, is dropped.
 * - No node on PATH is one line and exit 1, as a missing runtime is: refusing every call
 *   would refuse the `yokoten doctor` that explains it.
 * - node's stderr goes to a variable, with an `x` after it so a trailing newline stays;
 *   its stdout goes straight to the hook's own, through fd 3.
 * - The subshell's stderr is /dev/null, so the shell's job line for a killed node
 *   ("Killed", or bash's line with the whole command and its paths) never shows.
 * install's tool-call guard is this text. The plugin's tool guard fails closed inside
 * bin/launch.mjs, so its hook command stays one short line (#706).
 */
export const refuseOnFailure = (path: string, args: string): string =>
  `command -v node >/dev/null 2>&1 || { echo '${MISSING_NODE}' >&2; exit 1; }; ` +
  `{ err=$( ( node ${GUARD_HEAP} ${path} ${args} 2>&1 1>&3 3>&-; c=$?; printf x; exit $c ) 2>/dev/null ); code=$?; } 3>&1; ` +
  'case $code in 0|2) printf %s "${err%x}" >&2;; ' +
  '*) echo "yokoten\'s guard failed (exit $code), so the command is refused; run \\`yokoten doctor\\`" >&2; code=2;; esac; exit $code';

/** What PreToolUse says when no safe plugin copy remains. It names no path. `bin/launch.mjs` says the same line. */
export const PLUGIN_GUARD_MISSING = 'yokoten: the guard cannot run, because no safe plugin copy was found, so the command is refused';

/** What SessionStart says when no safe plugin copy remains. It names no path, and the session still starts. `bin/launch.mjs` says the same line. */
export const PLUGIN_SESSION_MISSING = 'yokoten: the session check cannot run, because no safe plugin copy was found';

/** What the plugin hook says when `bin/launch.mjs` is not in this session's plugin folder. A tool call is refused. Session start still goes on. */
export const PLUGIN_COPY_GONE = 'yokoten: this plugin copy is gone; restart Claude Code';

/**
 * The Claude Code plugin hook (#706). The command is one short line, so a refusal
 * does not show a long program in front of the message. It runs `bin/launch.mjs`
 * when that file is there. When the file is gone, it says `PLUGIN_COPY_GONE` and
 * refuses a tool call (exit 2), or prints the line and exits 0 at session start.
 * The fallback path stays in the command, so the file scan still sees
 * `${CLAUDE_PLUGIN_ROOT}/bin/yokoten.mjs`. The launcher reads every other path.
 */
export function pluginHookCommand(isSessionStart: boolean): string {
  if (/['"\\]/.test(PLUGIN_COPY_GONE)) throw new Error('the gone line has a quote or a backslash');
  const launch = '"${CLAUDE_PLUGIN_ROOT}/bin/launch.mjs"';
  const fallback = '"${CLAUDE_PLUGIN_ROOT}/bin/yokoten.mjs"';
  const mode = isSessionStart ? 'session' : 'tool';
  const yokotenArgs = isSessionStart ? 'doctor --session' : 'hook --commands-only --agent claude-code';
  const say = isSessionStart ? `echo '${PLUGIN_COPY_GONE}'; exit 0` : `echo '${PLUGIN_COPY_GONE}' >&2; exit 2`;
  return `[ -f ${launch} ] 2>/dev/null || { ${say}; }; node ${launch} ${mode} ${fallback} ${yokotenArgs}`;
}

/**
 * The line that runs the commit check from a project's own pre-commit, by `cli`'s path.
 * Without the runtime, one plain line and exit 1, as in the kit's pre-commit (#204).
 * `init` writes it, and its advice and `doctor`'s show the same line.
 */
export const commitCheckLine = (cli: string): string =>
  `[ -f "${cli}" ] 2>/dev/null || { echo 'yokoten: the commit check cannot run, because ${cli} is missing. Restore it from git, or run yokoten init again' >&2; exit 1; }; node "${cli}" check --staged || exit 1`;

/** The line a project's hook says when its runtime folder (`.yokoten/`, or `bin/` in yokoten's own repo) is gone. */
export const missingProjectRuntime = (cli: string): string =>
  `yokoten: the hook cannot run, because ${cli.split('/')[0]}/ is missing. Restore it from git, or run yokoten init again`;

/** One option a command takes: `value` names the word that follows it, if any. */
export interface CommandOption {
  name: string;
  value?: string;
  text: string;
}

/**
 * One command: what `yokoten <name> --help` prints, and what its parser accepts. The
 * parser reads `options` and `argument` from here, so the help and the parser can't
 * drift apart (#207).
 */
export type Command = CommandEntry & HelpPage;

/**
 * A help page as the layout's spec (record 0049, issue #1099): a summary of one or two lines,
 * the examples, and the details as rows under headings. The usage and options come from the
 * entry, so the help and the parser still read one table.
 */
export interface HelpPage {
  help: {
    summary: string;
    examples: HelpExample[];
    sections?: HelpSection[];
    /** Where the rest is: a link or a command in backticks. */
    more?: string;
  };
}

/** What every entry holds, the help page included. */
interface CommandEntry {
  name: string;
  /**
   * Where `yokoten help` shows it (issue #1054, record 0043): `always` in the short list,
   * `all` only with `help --all`, and `folded` with `help --all` among the moved ones.
   * A folded command still runs, after a first line that says where it moved.
   */
  shown: 'always' | 'all' | 'folded';
  /** For a folded command: the command it moved into. */
  into?: 'yokoten' | 'desk' | 'kanban';
  /** Old names that still run this command, after a line that names the new one: `board` for `kanban`. */
  oldNames?: string[];
  /** One line, for the command list. */
  summary: string;
  /** The words after `yokoten <name>`, as the usage line shows them. */
  usage: string;
  options: CommandOption[];
  /** The one positional argument it takes, if any. */
  argument?: string;
  /** The positional arguments it takes, in order, when it takes more than one: an action, then its word (#447). */
  arguments?: string[];
  /** It takes any number of positional arguments, in the order given: a merge train's queue (#320). */
  many?: boolean;
}

/** Every command takes these, and prints its help. */
export const HELP_OPTIONS = ['--help', '-h'];

/** Where the guide lists every command, for the pages with no section of their own. */
const GUIDE_COMMANDS = docsLink('guide.md', 'commands');

export const COMMANDS: Command[] = [
  {
    name: 'install',
    shown: 'folded',
    into: 'yokoten',
    summary: 'skills, agents and user-level hooks for this machine',
    usage: '[--yes] [--list]',
    help: {
      summary: 'Sets up this computer. It shows one screen of what it writes, asks once, then writes it. Files you wrote yourself are left alone.',
      examples: [
        { command: 'yokoten install', text: 'see what it sets up, then answer the question' },
        { command: 'yokoten install --yes', text: 'write it without the question' },
        { command: 'yokoten install --list', text: 'name every file it writes or keeps' },
      ],
      sections: [
        {
          heading: 'What it writes',
          rows: [
            ['skills, agents', "yokoten's skills and agents"],
            ['hooks', 'a SessionStart doctor hook, and a user-level command guard'],
            ['private marks', 'an empty private-marks file'],
            ['launcher', 'a yokoten launcher in ~/.local/bin'],
          ],
        },
      ],
      more: GUIDE_COMMANDS,
    },
    options: [
      { name: '--yes', text: 'set this computer up without asking first' },
      { name: '--list', text: 'every file install writes or keeps, one line each' },
    ],
  },
  {
    name: 'init',
    shown: 'folded',
    into: 'yokoten',
    summary: 'put the practices into a project (adds only, never overwrites)',
    usage: '[dir] [--no-ci] [--github --yes [--remove-default-labels] [--board]]',
    help: {
      summary: 'Adds the practices to the project at [dir] (default: here). It keeps any file that is already there and says so.',
      examples: [
        { command: 'yokoten init', text: 'add the practices to this project' },
        { command: 'yokoten init --github --yes', text: 'also add the standard labels and a first milestone on GitHub' },
        { command: 'yokoten init --no-ci', text: 'keep CI off' },
      ],
      sections: [
        {
          heading: 'GitHub',
          rows: [
            ['read', 'it reads GitHub through gh and says which standard labels and milestone it would add'],
            ['change', 'it changes GitHub only with --github --yes'],
            ['notNow ci', 'with "notNow" ci in yokoten.json, it writes no workflow and no Dependabot config'],
          ],
        },
      ],
      more: GUIDE_COMMANDS,
    },
    options: [
      { name: '--list', text: 'show every file init wrote or kept' },
      { name: '--no-ci', text: 'keep CI off: no workflows or Dependabot, and "notNow" ci in yokoten.json' },
      { name: '--github', text: 'work on GitHub too; goes with --yes' },
      { name: '--yes', text: 'add the standard labels, a first milestone and up to 8 area labels on GitHub' },
      { name: '--remove-default-labels', text: "also delete GitHub's default labels outside the set" },
      { name: '--board', text: "also make a board linked to the repo (needs the gh token's project scope)" },
    ],
    argument: 'dir',
  },
  {
    name: 'trust',
    shown: 'folded',
    into: 'yokoten',
    summary: "turn on yokoten's guard in the agents installed here",
    usage: '[dir] [--undo]',
    help: {
      summary: "Turns on yokoten's guard in Codex, Grok CLI, Copilot CLI and Muse Code, for the project at [dir] (default: here). Run it at a terminal.",
      examples: [
        { command: 'yokoten trust', text: 'trust yokoten\'s hooks in this project' },
        { command: 'yokoten trust --undo', text: 'take back what it wrote' },
      ],
      sections: [
        {
          heading: 'Good to know',
          rows: [
            ['pipe', 'in a pipe it writes nothing'],
            ['writes', "only yokoten's entries; it says what it wrote and how to undo it"],
          ],
        },
      ],
      more: GUIDE_COMMANDS,
    },
    options: [{ name: '--undo', text: 'remove only the entries yokoten trust wrote for this project; a setting you changed since stays' }],
    argument: 'dir',
  },
  {
    name: 'update',
    shown: 'folded',
    into: 'yokoten',
    summary: "the core rules in AGENTS.md: preview, or --write",
    usage: '[dir] [--write] [--all]',
    help: {
      summary: "Shows what this yokoten changes in the core rules of the project's AGENTS.md. With --write it replaces them and keeps the \"This project\" part as it is.",
      examples: [
        { command: 'yokoten update', text: 'preview the changes; writes nothing' },
        { command: 'yokoten update --write', text: 'replace the core rules' },
        { command: 'yokoten update --all', text: 'preview every changed line' },
      ],
      more: docsLink('guide.md', 'updating-the-rules'),
    },
    options: [{ name: '--write', text: 'replace the core rules in AGENTS.md' }, { name: '--all', text: 'every changed line, not one row per rule' }],
    argument: 'dir',
  },
  {
    name: 'upgrade',
    shown: 'all',
    summary: 'yokoten itself, to the newest version',
    usage: '',
    help: {
      summary: 'Brings yokoten itself to the newest version. It adds and removes nothing.',
      examples: [{ command: 'yokoten upgrade', text: 'update yokoten' }],
      sections: [
        {
          heading: 'With the Claude Code plugin',
          rows: [
            ['updates', 'the marketplace, then the plugin'],
            ['git', 'told to fetch github.com over HTTPS for those calls only, so no GitHub SSH key is needed'],
          ],
        },
        { heading: 'Without the plugin', rows: [['prints', 'the command that installs the newest yokoten; it runs nothing']] },
      ],
      more: GUIDE_COMMANDS,
    },
    options: [],
  },
  {
    name: 'doctor',
    shown: 'folded',
    into: 'yokoten',
    summary: 'the road: where this project is and its next step',
    usage: '[--all] [--session] [--json] [--agent <name>]',
    help: {
      summary: 'Shows where the project is, what is left to do, and the next command, on one screen.',
      examples: [
        { command: 'yokoten doctor', text: 'where this project is, and the next step' },
        { command: 'yokoten doctor --all', text: 'every stage and step, and what this machine is missing' },
        { command: 'yokoten doctor --session', text: 'only the next step' },
      ],
      sections: [
        {
          heading: 'Exit code',
          rows: [
            ['0', 'nothing is wrong. Steps left on the road are to do, not problems; always 0 with --session'],
            ['1', 'a problem: a failed self-test, or a core-rules, tree or machine line marked MISSING'],
          ],
        },
      ],
      more: GUIDE_COMMANDS,
    },
    options: [
      { name: '--all', text: 'every check: the whole road, the project, unsaved work, this machine and the server' },
      { name: '--session', text: 'only the next step, for the start of a session' },
      { name: '--json', text: 'the report as JSON on stdout' },
      { name: '--agent', value: 'name', text: 'with --session: claude-code (the default), codex, muse, or gemini for Gemini CLI JSON' },
    ],
  },
  {
    name: 'adopt',
    shown: 'all',
    summary: 'a draft of the adoption table for an old project',
    usage: '[--json] [--all]',
    help: {
      summary: 'Drafts the adoption table: what the project does today, and as-is, lighter or not now for each step. You decide every row. It writes no file.',
      examples: [
        { command: 'yokoten adopt', text: 'the draft, one screen' },
        { command: 'yokoten adopt --all', text: 'the whole table, with a reason for every row' },
      ],
      more: docsLink('guide.md', 'a-first-draft-of-the-table'),
    },
    options: [{ name: '--json', text: 'the rows as JSON on stdout' }, { name: '--all', text: 'the whole table, with a reason for every row' }],
  },
  {
    name: 'check',
    shown: 'all',
    summary: 'layout, privacy and lead-only files, and a PR or issue',
    usage: '[--staged | --history | --pr [number] | --issue | --anchor] [--all] [--json]',
    help: {
      summary: 'Checks the whole tree by default. Use one mode at most.',
      examples: [
        { command: 'yokoten check', text: 'the whole tree' },
        { command: 'yokoten check --staged', text: 'the next commit, as the git hook runs it' },
        { command: 'yokoten check --pr 123', text: 'a pull request, read through gh: no CI needed' },
      ],
      more: GUIDE_COMMANDS,
    },
    options: [
      { name: '--staged', text: 'the next commit, as the git hook runs it' },
      { name: '--history', text: 'the privacy check over every commit; run it before going public' },
      { name: '--pr', text: 'the title, tier, sections, issue and change file of the pull request: in CI, or by its number' },
      { name: '--issue', text: 'in CI: the issue title, `area: summary` in 60 characters at most' },
      { name: '--anchor', text: 'the event log against the daily hashes in Sigstore Rekor' },
      { name: '--repo', value: 'owner/name', text: 'the repo whose anchor workflow signed the entries; GITHUB_REPOSITORY or origin by default' },
      { name: '--all', text: 'every note in full; by default they fold into a count' },
      { name: '--json', text: 'the findings as JSON on stdout' },
    ],
    argument: 'number',
  },
  {
    name: 'ci-health',
    shown: 'all',
    summary: 'the last 200 Actions runs, in one issue that is updated in place',
    usage: '[--repo owner/name] [--write] [--dry-run]',
    help: {
      summary: 'Reads the Actions runs and the checks of open pull requests through gh, and prints one Markdown report. It writes nothing unless you pass --write.',
      examples: [
        { command: 'yokoten ci-health', text: 'print the report' },
        { command: 'yokoten ci-health --write', text: 'put the report in the pinned issue' },
        { command: 'yokoten ci-health --dry-run', text: 'print the report; touch no issue' },
      ],
      more: GUIDE_COMMANDS,
    },
    options: [
      { name: '--write', text: 'create or edit the pinned issue "CI health" with the report; the first run creates it' },
      { name: '--dry-run', text: 'print the report only; do not create or edit the issue' },
      { name: '--repo', value: 'owner/name', text: 'the repo to read; the default is GITHUB_REPOSITORY, or the origin remote' },
    ],
  },
  {
    name: 'provenance',
    shown: 'all',
    summary: 'the writer, reviewers and approver of a commit',
    usage: '<ref> [--json]',
    help: {
      summary: 'Shows who wrote, reviewed and approved a commit. It reads the message a squash merge leaves on the branch, and the Approve on the pull request it names.',
      examples: [
        { command: 'yokoten provenance HEAD', text: 'one commit' },
        { command: 'yokoten provenance main~1..main', text: 'a range, oldest commit first' },
      ],
      sections: [{ heading: 'Good to know', rows: [['approver', 'the latest Approve; when gh cannot read it, it shows unknown']] }],
      more: docsLink('standard.md', 'provenance'),
    },
    options: [{ name: '--json', text: 'the records as JSON on stdout' }],
    argument: 'ref',
  },
  {
    name: 'mcp',
    shown: 'all',
    summary: 'check the project MCP server and its tools',
    usage: '[dir] [--command "<command>"] [--json]',
    help: {
      summary: 'Starts each stdio server in .mcp.json, .vscode/mcp.json or mcp.json, calls tools/list, and checks every tool.',
      examples: [
        { command: 'yokoten mcp', text: 'check the servers in the config' },
        { command: 'yokoten mcp --command "node server.ts"', text: 'check a server that has no config entry' },
      ],
      sections: [
        {
          heading: 'What it checks',
          rows: [
            ['schemas', 'each tool schema, for Claude, Gemini and OpenAI strict mode'],
            ['names', 'the tool and property names'],
            ['annotations', 'all four annotations'],
            ['count', 'fewer than 40 tools'],
            ['results', 'an outputSchema result carries both structuredContent and text'],
            ['stdout', 'it reports any line that is not JSON-RPC'],
            ['Windows', 'it warns when a config needs cmd /c for npx or a .cmd file'],
          ],
        },
      ],
      more: GUIDE_COMMANDS,
    },
    options: [
      { name: '--command', value: 'command', text: 'start this command instead of a config entry, such as "node server.ts"' },
      { name: '--json', text: 'the findings as JSON on stdout' },
    ],
    argument: 'dir',
  },
  {
    name: 'borrowed',
    shown: 'all',
    summary: 'borrowed code against upstream, with issues',
    usage: '[--dry-run] [--json]',
    help: {
      summary: "Compares each file in src/borrowed/ with upstream's default branch, through gh. It opens one issue per source that changed, and calls out a security fix.",
      examples: [
        { command: 'yokoten borrowed --dry-run', text: 'show what it would open; write nothing' },
        { command: 'yokoten borrowed', text: 'open the issues' },
      ],
      more: docsLink('guide.md', 'borrowed-code'),
    },
    options: [
      { name: '--dry-run', text: 'show the report and the issues it would open, and write nothing' },
      { name: '--json', text: 'the report as JSON on stdout' },
    ],
  },
  {
    name: 'redact',
    shown: 'all',
    summary: 'hide your private marks in a pipeline',
    usage: '',
    help: {
      summary: 'Reads text on stdin and writes it to stdout with your private details replaced by placeholders.',
      examples: [{ command: 'git log -1 2>&1 | yokoten redact', text: 'a log with your details hidden' }],
      sections: [
        {
          heading: 'What it hides',
          rows: [
            ['<secret>', 'secrets'],
            ['<mark>', 'your private marks'],
            ['<email>', 'private email addresses'],
            ['<owner>', 'git user.name'],
            ['<host>', 'private remote hosts'],
          ],
        },
        { heading: 'If it cannot hide the text', rows: [['it', 'prints no more of it, says why in one line on stderr, and exits 1']] },
      ],
      more: docsLink('guide.md', 'privacy'),
    },
    options: [],
  },
  {
    name: 'test',
    shown: 'all',
    summary: 'run the tests light: niced, with few at once',
    usage: '[--heavy] [--print] [-- <test runner words>]',
    help: {
      summary: "Runs node --test light, so tests do not starve a shared machine: under nice, with at most half the cores and one file per GB of free memory.",
      examples: [
        { command: 'yokoten test', text: 'run all the tests' },
        { command: 'yokoten test -- test/run/cli.test.ts', text: 'run one file' },
        { command: 'yokoten test --print', text: 'show the command; run nothing' },
      ],
      sections: [
        {
          heading: 'Good to know',
          rows: [
            ['after --', "words go to the runner: test files, or its options"],
            ['all calls', 'YOKOTEN_LIGHT_TESTS=0 turns the light run off for every call'],
          ],
        },
      ],
      more: GUIDE_COMMANDS,
    },
    options: [
      { name: '--heavy', text: 'no nice and no cap on concurrency, for this call' },
      { name: '--print', text: 'show the command and why it was chosen, and run nothing' },
    ],
  },
  {
    name: 'marks',
    shown: 'all',
    summary: 'your private marks, never their values',
    usage: '[add | remove | off <kind> | on <kind> | allow <mark> --here | allow --remove <mark> --here]',
    help: {
      summary: 'Counts your private marks by kind; it never shows a value. install adds your git name, git email and forge login by itself.',
      examples: [
        { command: 'yokoten marks', text: 'count your marks by kind' },
        { command: 'yokoten marks add', text: 'add one mark, typed with no echo' },
        { command: 'yokoten marks off git-name', text: 'stop install adding your git name' },
        { command: 'yokoten marks allow <mark> --here', text: 'let one mark pass in this repo only' },
      ],
      sections: [
        {
          heading: 'Words',
          rows: [
            ['add, remove', 'read one mark: typed with no echo in a terminal, or from stdin. Never a word on the command line, where your shell history would keep it'],
            ['off <kind>', 'install stops adding git-name, git-email or forge-login, and removes the marks it added for it'],
            ['on <kind>', 'brings the default back and adds it again. Marks you added yourself are never touched'],
            ['allow <mark>', 'the mark passes the checks in this repo only, as with "privacy.allow" in yokoten.json. Only a mark in your private-marks file can be allowed'],
            ['allow --remove', 'takes the allow back, so the checks stop the mark here again'],
          ],
        },
        { heading: 'Where an allow lives', rows: [['on this machine', 'beside the private-marks file, for the repo you are in, by its origin remote (a repo with no origin cannot have one). Nothing is written into the repo']] },
      ],
      more: docsLink('guide.md', 'privacy'),
    },
    options: [
      { name: '--here', text: 'for the repo you are in (needed: an allow is always for one repo)' },
      { name: '--remove', text: 'take the allow back' },
    ],
    arguments: ['action', 'mark'],
  },
  {
    name: 'changelog',
    shown: 'all',
    summary: 'the entries the files in changes/ add under [Unreleased]',
    usage: '[--write] | --notes <version>',
    help: {
      summary: 'Shows the entries the files in changes/ add under [Unreleased] in CHANGELOG.md.',
      examples: [
        { command: 'yokoten changelog', text: 'show the entries; writes nothing' },
        { command: 'yokoten changelog --write', text: 'put them into CHANGELOG.md, before a release' },
        { command: 'yokoten changelog --notes 0.1.2', text: "print one version's release notes" },
      ],
      more: docsLink('guide.md', 'the-changelog'),
    },
    options: [
      { name: '--write', text: 'put them into CHANGELOG.md and delete the files (before a release)' },
      { name: '--notes', value: 'version', text: "print the release notes: that version's opening from CHANGELOG.md, and a link to all of it" },
    ],
  },
  {
    name: 'learn',
    shown: 'all',
    summary: 'a check draft from an incident issue, for a person to review',
    usage: '<issue> [--write] | --ship <id> | --export <id> [--out <file>] | --import <file> [--write] | --upstream "<what happened>" [--area <name>] [--fix <idea>] | --upstream --list | --upstream --done <id>',
    help: {
      summary: 'Reads an incident issue (a number or a URL) through gh and drafts a check from it, for a person to review. It writes nothing without --write.',
      examples: [
        { command: 'yokoten learn 138', text: 'show the draft' },
        { command: 'yokoten learn 138 --write', text: 'put the draft in lessons/' },
        { command: 'yokoten learn --upstream "what happened"', text: 'keep a note about a gap in yokoten' },
      ],
      sections: [
        {
          heading: 'Share a lesson',
          rows: [
            ['--ship', 'in yokoten: moves a reviewed lesson into kit/lessons/, where doctor runs it in every project'],
            ['--export', 'a reviewed lesson as one small JSON file, with its incident and its positive control, and no private detail'],
            ['--import', 'shows such a file from another project; --write adds it to lessons/ for review. It runs nowhere before --ship'],
          ],
        },
        {
          heading: 'Notes for yokoten itself',
          rows: [
            ['--upstream', 'keeps a note about a gap in yokoten, found in any project, in ~/.config/yokoten/upstream/, outside every repo'],
            ['hidden first', 'the project name, its path, your home folder and your name. A note with a known secret shape is refused'],
          ],
        },
      ],
      more: docsLink('guide.md', 'learning-from-an-incident'),
    },
    options: [
      { name: '--write', text: 'put the draft in lessons/ (adds only, never overwrites)' },
      { name: '--all', text: 'show every field the issue left open, and the files the draft writes' },
      { name: '--ship', text: 'move a reviewed lesson into kit/lessons/; refused while a TODO is left' },
      { name: '--export', value: 'id', text: 'a reviewed lesson as one small JSON file (prints it, or writes it with --out)' },
      { name: '--out', value: 'file', text: 'with --export: write the lesson file here instead of printing it' },
      { name: '--import', value: 'file', text: 'a lesson file from another project: show it, or add it with --write' },
      { name: '--upstream', text: 'a note for the yokoten repo: what happened, in a few words' },
      { name: '--area', value: 'name', text: 'with --upstream: the part of yokoten it is about, such as hook or doctor' },
      { name: '--fix', value: 'idea', text: 'with --upstream: how it could be fixed' },
      { name: '--list', text: 'with --upstream: the notes that wait' },
      { name: '--done', text: 'with --upstream: remove a note, once its issue is open' },
    ],
    argument: 'issue',
  },
  {
    name: 'hook',
    shown: 'all',
    summary: 'the tool-call guard, or the stop check with --stop',
    usage: '[--agent <name>] [--commands-only] [--stop] [--json] [--denial <mode>] [--protocol]',
    help: {
      summary: 'The tool-call guard. It reads one tool call on stdin, and exits 2 with the reason on stderr when it blocks the call.',
      examples: [
        { command: `echo '{"tool_input":{"command":"git status"}}' | yokoten hook`, text: 'ask the guard about one command' },
        { command: 'yokoten hook --stop', text: 'the stop check, at the end of a turn' },
      ],
      sections: [
        {
          heading: 'How it answers',
          rows: [
            ['claude-code', "as Claude Code's PreToolUse hook: a deny in JSON on stdout, exit 0. YOKOTEN_HOOK_DENIAL=exit2 keeps exit 2"],
            ['antigravity', 'says deny on stdout and exits 0, as Antigravity CLI asks'],
            ['--denial exit2', 'keeps the reason on stderr and exit 2, for a host that reads the exit code alone'],
            ['--protocol', 'reads the guard protocol (version yokoten-guard/1) and answers in it, so any tool can call the guard. See docs/records/0039-the-guard-protocol.md'],
          ],
        },
      ],
      more: docsLink('guide.md', 'the-stop-check'),
    },
    options: [
      { name: '--agent', value: 'name', text: 'the runtime that sends the call: claude-code (the default), codex, gemini, antigravity, muse, deepseek-harness, grok or opencode' },
      { name: '--stop', text: 'read the end-of-turn event of the runtime and check the changed files; a worker also runs the done-when command' },
      { name: '--commands-only', text: 'judge commands only, and leave files to the project' },
      { name: '--json', text: 'the result as JSON on stdout' },
      { name: '--denial', value: 'mode', text: 'the answer a refusal gets: exit2 puts the reason on stderr and exits 2, for a host that ignores a JSON deny' },
      { name: '--protocol', text: 'read one yokoten-guard/1 call on stdin and answer in the same protocol on stdout; any agent tool can send it' },
    ],
  },
  {
    name: 'anchor',
    shown: 'all',
    summary: "list a worker's checkpoints: commits whose checks passed",
    usage: '[--json] [--all]',
    help: {
      summary: 'Lists the anchors recorded in this checkout, newest first. A worker records one when its checks pass and its tree is clean.',
      examples: [{ command: 'yokoten anchor', text: 'list the anchors' }],
      sections: [{ heading: 'Going back', rows: [['an anchor', 'is a commit. Going back is a new branch from it: `git switch -c try-2 <commit>`. Nothing is reset or deleted']] }],
      more: docsLink('guide.md', 'the-stop-check'),
    },
    options: [{ name: '--json', text: 'the anchors as JSON on stdout' }],
  },
  {
    name: 'stops',
    shown: 'all',
    summary: 'the log of the guard stops on this computer, or turn it off and on',
    usage: '[off | on]',
    help: {
      summary: 'Shows where the stop log is, and whether yokoten writes it. The log stays on this computer.',
      examples: [
        { command: 'yokoten stops', text: 'where the log is, and whether it is on' },
        { command: 'yokoten stops off', text: 'stop writing the log, and delete it' },
        { command: 'yokoten stops on', text: 'start writing it again' },
      ],
      more: docsLink('guide.md', 'the-stop-check'),
    },
    options: [],
    arguments: ['action'],
  },
  {
    name: 'worker',
    shown: 'folded',
    into: 'desk',
    summary: "mark a worktree as a worker's",
    usage: 'mark <dir> | unmark <dir> | env [runtime]',
    help: {
      summary: "Marks the worktree at <dir> as a worker's. The guard then treats every agent there as a worker. Run it from your own checkout.",
      examples: [
        { command: 'yokoten worker mark .worktrees/42', text: "mark a worktree as a worker's" },
        { command: 'yokoten worker unmark <dir>', text: 'clear its entry; only the lead runs it' },
        { command: 'yokoten worker env [runtime]', text: 'the names an agent would get from this shell; never a value' },
      ],
      sections: [
        {
          heading: 'The mark',
          rows: [
            ['guard', 'treats every agent there as a worker, even one whose runtime passes no YOKOTEN_ROLE to its hooks (Muse Code)'],
            ['kept in', "a file in the worktree's own git folder, and its path on the worker list (in yokoten's config folder, outside the worktree), so moving .git away keeps the role"],
            ['real lock', "the guard refuses a worker's plain ways to remove it; the server and credentials kept from the worker are the real lock"],
            ['subfolder', 'given one, it marks the worktree it is in, and names it'],
            ['remove', '`git worktree remove <dir>` removes the file with the worktree; `unmark` clears the list entry'],
            ['a desk', 'a plain clone is marked in its own .git'],
            ['never marked', 'the main checkout (the clone the lead runs in, or one with worktrees) and a submodule. A worker cannot mark or unmark'],
          ],
        },
        { heading: 'env', rows: [['tokens, keys', 'and passwords stay out of the list']] },
      ],
      more: docsLink('guide.md', 'works-with'),
    },
    options: [],
    arguments: ['action', 'dir'],
  },
  {
    name: 'desk',
    shown: 'always',
    summary: 'give one task to one AI, in its own fenced desk',
    usage: '[<issue> | "<task>"] [--agent <name>] [--pr] [--no-install]',
    // The worked example of the help spec (issue #1099): two lines of summary, the common
    // uses first, then the fence as rows. The guide's desk section holds the rest.
    help: {
      summary: 'Gives one task to one AI in its own fenced desk, a clone on the branch desk/<n>. When the AI exits, the desk runs the check and the tests and shows the evidence.',
      examples: [
        { command: 'yokoten desk', text: 'list your desks; writes nothing' },
        { command: 'yokoten desk 42', text: 'a desk for issue 42; run again, it goes on from there' },
        { command: 'yokoten desk "fix it"', text: 'a desk for a task in quotes' },
        { command: 'yokoten desk 42 --pr', text: "push desk 42's branch and open its pull request" },
      ],
      sections: [
        {
          heading: 'The fence',
          rows: [
            ['writes', 'the desk folder and <folder>.state; not .git/config or .git/hooks'],
            ['hides', 'your home, other projects, agent state and your tokens'],
            ['network', "only the agent's API hosts, through a proxy"],
            ['scripts', '`yokoten desk <agent> <folder> -- <command>`, in a clone you made'],
            ['commit check', 'runs outside the fence, for now'],
          ],
        },
      ],
      more: docsLink('guide.md', 'the-desk'),
    },
    options: [
      { name: '--agent', value: 'name', text: 'the AI to start: claude-code (first when installed) or codex' },
      { name: '--pr', text: "push the desk's branch and open its pull request" },
      { name: '--no-install', text: 'skip npm ci in a new desk' },
      { name: '--name', value: 'name', text: "the agent's name on the team (default: the desk folder's name)" },
      { name: '--read', value: 'paths', text: 'more paths to show read-only, joined by commas' },
      { name: '--host', value: 'hosts', text: "more API hosts the agent may reach, joined by commas" },
      { name: '--marks', text: 'show your private-marks file, read-only (not available yet)' },
    ],
    arguments: ['agent', 'folder'],
  },
  {
    name: 'msg',
    shown: 'folded',
    into: 'desk',
    summary: 'messages between agents on this team',
    usage: 'send <to> [<text>] | inbox | who | log',
    help: {
      summary: 'Agents on a team send each other messages. Each agent writes only its own outbox, in the team folder next to your checkout (<repo>.team).',
      examples: [
        { command: 'yokoten msg send lead "tests pass; ready for review"', text: 'send a message' },
        { command: 'yokoten msg inbox', text: 'read yours, and mark them read' },
        { command: 'yokoten msg who', text: 'list the team' },
        { command: 'yokoten msg log', text: 'every message; only the lead runs it' },
      ],
      sections: [
        {
          heading: 'Good to know',
          rows: [
            ['no fakes', 'in a desk the rest of the team folder is read-only, so no agent can fake a sender'],
            ['text', 'comes after the name, or on stdin. It gets the same privacy scan as posted text'],
            ['unread', "hooks add unread messages to the agent's context, marked as data that grants no approval"],
          ],
        },
      ],
      more: docsLink('guide.md', 'messages-between-agents'),
    },
    options: [],
    arguments: ['action', 'to', 'text'],
  },
  {
    name: 'explain',
    shown: 'all',
    summary: 'a rule or a step: what it is, why, and how it is checked',
    usage: '[<id>] [--json]',
    help: {
      summary: 'Explains one rule or one step of the road. With no id, it lists the ids.',
      examples: [
        { command: 'yokoten explain', text: 'list the ids' },
        { command: 'yokoten explain release', text: 'explain one' },
      ],
      more: GUIDE_COMMANDS,
    },
    options: [{ name: '--json', text: 'the explanation, or the ids, as JSON on stdout' }],
    argument: 'id',
  },
  {
    name: 'pr',
    shown: 'all',
    summary: 'keep open pull requests up to date',
    usage: 'sync',
    help: {
      summary: 'Brings each open pull request that is behind its base branch up to date. Run it after every merge.',
      examples: [{ command: 'yokoten pr sync', text: 'update every pull request that is behind' }],
      sections: [
        {
          heading: 'For each one',
          rows: [
            ['merges', 'the base branch in'],
            ['resolves', 'only the mechanical conflicts: two added blocks, or two changed import lists'],
            ['checks', 'runs typecheck and the tests of the touched files'],
            ['pushes', 'as the bot'],
            ['stops', 'on anything else, with the files, the hunks and a dispatch brief'],
            ['never', 'force-pushes, rebases or resolves on GitHub'],
          ],
        },
      ],
      more: GUIDE_COMMANDS,
    },
    options: [],
    argument: 'action',
  },
  {
    name: 'bot',
    shown: 'all',
    summary: 'run one command as the bot account',
    usage: '-- <command>',
    help: {
      summary: 'Runs the command after -- as the bot, with a one-hour token. It runs gh and git only.',
      examples: [{ command: 'yokoten bot -- gh pr create --fill', text: 'open a pull request as the bot' }],
      sections: [
        {
          heading: 'Good to know',
          rows: [
            ['titles', 'it checks an issue or pull request title first, and sends nothing when the title is wrong'],
            ['after --', 'everything is passed on unchanged, --help too'],
          ],
        },
      ],
      more: GUIDE_COMMANDS,
    },
    options: [],
  },
  {
    name: 'train',
    shown: 'all',
    summary: 'merge an approved queue, one at a time',
    usage: '[<pr>...] [--wait <seconds>] [--next]',
    help: {
      summary: 'Merges each pull request in the given order, as the bot, and stops at the first one that needs a person. Only the lead runs it.',
      examples: [
        { command: 'yokoten train', text: 'print the plan from the conflict map; merges nothing' },
        { command: 'yokoten train 1207 1209 1211', text: 'merge these, in this order' },
        { command: 'yokoten train --next', text: 'say which is next and why; merges nothing' },
      ],
      sections: [
        {
          heading: 'How it merges',
          rows: [
            ['first', 'records every base branch, because GitHub forgets a base when it deletes the branch. A pull request stacked on a squash-merged branch then merges from the base it really shares with its old branch'],
            ['conflicts', 'one that is only import lines is resolved by taking the union'],
            ['stops', 'on any other conflict, a failing test or a missing approval'],
            ['tests', "each merged tree runs the project's tests and `check` before it is pushed"],
            ['CI', 'must pass on the pushed merge before the squash'],
          ],
        },
      ],
      more: GUIDE_COMMANDS,
    },
    options: [
      { name: '--wait', value: 'seconds', text: 'how long to wait for CI after a push (default 1800)' },
      { name: '--next', text: 'print the next pull request to merge and why, and merge nothing' },
    ],
    many: true,
  },
  {
    name: 'kanban',
    shown: 'always',
    oldNames: ['board'],
    summary: 'the team at a glance, live and read only (preview)',
    usage: '[--text] [--no-open]',
    help: {
      summary: 'Preview: it may change. Read only: nothing on the page starts, stops or changes work. It serves a page on this machine only.',
      examples: [
        { command: 'yokoten kanban', text: 'open the page in your browser' },
        { command: 'yokoten kanban --text', text: 'print the sessions, pull requests and Actions' },
        { command: 'yokoten kanban --no-open', text: 'print the address only' },
      ],
      sections: [
        {
          heading: 'The page',
          rows: [
            ['address', 'http://<repo>.localhost:<port>/; the port stays with this repo'],
            ['sign-in', 'the browser opens signed in. The key goes only to the browser: it is never printed'],
            ['runs', 'until you stop it'],
            ['sessions', 'in this repo, its worktrees and its desks show by themselves: the hooks write .yokoten-agent.json for them'],
            ['data', 'the page reads GET /api/state'],
          ],
        },
      ],
      more: docsLink('guide.md', 'the-kanban'),
    },
    options: [
      { name: '--text', text: 'print the sessions, pull requests and Actions, and exit' },
      { name: '--no-open', text: 'do not open the browser; print the address only' },
    ],
  },
  {
    name: 'tidy',
    shown: 'always',
    summary: 'find old branches, worktrees and desks, and put them away',
    usage: '[--local | --empty [--yes]]',
    help: {
      summary: 'Lists what is old, with the reason and size: merged or gone branches, idle worktrees and desks, and logs of gone desks. It changes nothing.',
      examples: [
        { command: 'yokoten tidy', text: 'list what is old' },
        { command: 'yokoten tidy --local', text: 'save each one, then move it to the trash' },
        { command: 'yokoten tidy --empty', text: 'delete what has been in the trash over 7 days' },
      ],
      sections: [
        {
          heading: 'With --local',
          rows: [
            ['saves first', 'a git bundle, a patch of unsaved changes, and index.json'],
            ['then', 'moves it into a dated folder in the trash'],
            ['a save fails', 'nothing moves'],
            ['in use', 'a desk or worktree in use is never touched'],
            ['GitHub', 'branches on GitHub are only listed'],
          ],
        },
        { heading: 'The trash', rows: [['folder', '~/.local/state/yokoten/trash, or %LOCALAPPDATA%\\yokoten\\trash on Windows']] },
      ],
      more: GUIDE_COMMANDS,
    },
    options: [
      { name: '--local', text: 'save the old things on this machine, then move them into the trash' },
      { name: '--empty', text: 'delete what has been in the trash over 7 days, after one question' },
      { name: '--yes', text: 'with --empty: answer the question yes, for a run with no terminal' },
    ],
  },
  {
    name: 'conflicts',
    shown: 'all',
    summary: 'which open changes collide, and what to merge first',
    usage: '[--json] [--rebuild <id>]',
    help: {
      summary: 'Reads every open pull request, or every local branch when there is no host, and says which changes collide with main and with each other.',
      examples: [
        { command: 'yokoten conflicts', text: 'which collide, and what to merge first' },
        { command: 'yokoten conflicts --json', text: 'the whole map, for an agent or a script' },
      ],
      sections: [
        {
          heading: 'Good to know',
          rows: [
            ['pairs', 'it names the pairs that touch one file, and which of the two to merge first'],
            ['safe', 'it checks nothing out and merges nothing'],
            ['kept', 'the answer is kept in the git folder, so the guard reads it without running git'],
          ],
        },
      ],
      more: GUIDE_COMMANDS,
    },
    options: [
      { name: '--json', text: 'the whole map as data on stdout, for an agent or a script' },
      { name: '--rebuild', value: 'id', text: 'print a prompt that rebuilds one change on the current main instead of merging it' },
    ],
  },
  {
    name: 'uninstall',
    shown: 'all',
    summary: 'take back what install wrote',
    usage: '[--list]',
    help: {
      summary: 'Takes back what install wrote. Your own files and settings stay.',
      examples: [
        { command: 'yokoten uninstall', text: 'take it back' },
        { command: 'yokoten uninstall --list', text: 'name every file it removes or keeps' },
      ],
      sections: [
        {
          heading: 'It removes',
          rows: [
            ['skills, agents', 'the ones install wrote (only files marked as managed by yokoten)'],
            ['hooks', 'its two hooks in ~/.claude/settings.json'],
            ['program', '~/.local/share/yokoten'],
          ],
        },
        { heading: 'It keeps', rows: [['yours', 'your own files, your other settings and ~/.config/yokoten (keys, private marks)']] },
      ],
      more: GUIDE_COMMANDS,
    },
    options: [{ name: '--list', text: 'every file uninstall removes or keeps, one line each' }],
  },
  {
    name: 'help',
    shown: 'all',
    summary: 'this list, or the help of one command',
    usage: '[<command>] [--all]',
    help: {
      summary: 'Prints the three commands to start with, or the usage, options and an example of one command.',
      examples: [
        { command: 'yokoten help', text: 'the commands to start with' },
        { command: 'yokoten help check', text: 'the help of one command' },
        { command: 'yokoten help --all', text: 'every command' },
      ],
      more: GUIDE_COMMANDS,
    },
    options: [{ name: '--all', text: 'every command, in two groups: the ones that moved, and the ones agents and CI use' }],
    argument: 'command',
  },
  {
    name: 'version',
    shown: 'all',
    summary: 'the version of this yokoten',
    usage: '',
    help: {
      summary: 'Prints the version. `yokoten --version` and `yokoten -v` do the same.',
      examples: [{ command: 'yokoten version', text: 'print the version' }],
    },
    options: [],
  },
];

/** The command with this name, if there is one. */
export const findCommand = (name: string): Command | undefined => COMMANDS.find((command) => command.name === name || command.oldNames?.includes(name));

/** The option as its help shows it: `--agent <name>`. */
const optionLabel = (option: CommandOption): string => (option.value ? `${option.name} <${option.value}>` : option.name);

/** A command's help page as the layout's spec: its own `help`, with the usage and options of the entry. */
export function helpSpecOf(command: Command): HelpSpec {
  const usage = `yokoten ${command.name}${command.usage ? ` ${command.usage}` : ''}`;
  const options = [...command.options.map((option) => [optionLabel(option), option.text] as const), [HELP_OPTIONS.join(', '), 'this help'] as const];
  const { summary, examples, sections, more } = command.help;
  return { usage, summary: [summary], examples, options, sections, more };
}

/**
 * What `yokoten <name> --help` prints (record 0049, issue #1099): the usage, a short summary,
 * the examples, the options aligned, then the sections. The layout wraps each text once.
 */
export const commandHelp = (command: Command): string[] => helpScreen(helpSpecOf(command));

/**
 * The groups `yokoten help --all` shows after the short list, in order (issue #1054): the
 * commands that moved, then the ones agents and CI run. Each comes from the table's `shown`.
 */
export const ALL_GROUPS: readonly { title: string; shown: Command['shown'] }[] = [
  { title: 'Moved (each still runs, and says where it went)', shown: 'folded' },
  { title: 'For agents and CI', shown: 'all' },
];

/**
 * The command list (issue #1027, #1054): `yokoten help` lists only the `always` rows;
 * `help --all` adds the two groups, a blank line between, each command on one line of at
 * most SCREEN_WIDTH (R1, R3).
 */
export function commandList(all = false): string[] {
  const width = Math.max(...COMMANDS.map((command) => command.name.length)) + 2;
  const rows = (shown: Command['shown']) => COMMANDS.filter((command) => command.shown === shown).map((command) => `  ${command.name.padEnd(width)}${command.summary}`);
  return [
    'Commands:',
    ...rows('always'),
    ...(all ? ALL_GROUPS.flatMap(({ title, shown }) => ['', `${title}:`, ...rows(shown)]) : []),
  ];
}

/**
 * The first line a folded command or an old name prints before it runs (issue #1054), or
 * undefined for a command that has not moved. `name` is the word that was typed.
 */
export function movedNote(name: string): string | undefined {
  const command = findCommand(name);
  if (!command) return undefined;
  const into = command.name !== name ? command.name : command.shown === 'folded' ? command.into : undefined;
  if (!into) return undefined;
  return `note: yokoten ${name} moved to ${into === 'yokoten' ? 'yokoten' : `yokoten ${into}`}. It runs as before this time.`;
}

/** How many single-letter edits turn one word into the other (Levenshtein). */
export function editDistance(from: string, to: string): number {
  let previous = Array.from({ length: to.length + 1 }, (_, i) => i);
  for (let i = 1; i <= from.length; i++) {
    const current = [i];
    for (let j = 1; j <= to.length; j++) current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (from[i - 1] === to[j - 1] ? 0 : 1));
    previous = current;
  }
  return previous[to.length];
}

/** The known word closest to a typo, when two edits or fewer turn one into the other. */
export function closestWord(word: string, known: string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = 3;
  for (const candidate of known) {
    const distance = editDistance(word, candidate);
    if (distance < bestDistance) [best, bestDistance] = [candidate, distance];
  }
  return best;
}
