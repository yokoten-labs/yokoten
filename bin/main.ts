// yokoten: carry what one project learned into every project. bin/yokoten.ts turns on
// the compile cache, then loads this file (#286). This file reads the command and hands it
// to its module in src/commands/, one per command or small group (#330). Each module is
// imported only when its command runs, so a guard call never loads doctor or init (#408).
//
// Loading this file runs nothing. bin/yokoten.mjs calls `runFromProcess`, which makes the one
// invocation from the process; a test calls `main` with its own, in-process (#475).

import { withHome } from '../src/rules/privacy.ts';
import { fail, type Invocation, isTerminal, parse, print, usage } from '../src/commands/shared.ts';
import { closestWord, COMMANDS, commandHelp, findCommand, HELP_OPTIONS, commandList, movedNote } from '../src/run/cli.ts';
import { failure, moreLine, noteLine, screen, wrap } from '../src/rules/text/screen.ts';
import { VERSION } from '../src/setup/files.ts';

/**
 * `yokoten help` (#207, #944, #1054, #1115): the version, the first step, the usage, then the
 * commands to start with; with --all, every command under the heading of its job. The list
 * comes from the table the parser reads.
 */
export const helpLines = (all: boolean, version = VERSION): string[] =>
  screen(
    [`yokoten ${version}`],
    ['Start here: run `yokoten` in your project.'],
    wrap('Usage: ', 'yokoten <command> [options]'),
    commandList(all),
    moreLine(all ? '`yokoten <command> --help`' : '`yokoten help --all` for every command, `yokoten <command> --help` for one'),
  );

/** `yokoten version`, `--version` and `-v`: the version alone, for a person or a script. */
export const versionLines = (version = VERSION): string[] => [version];

/**
 * An unknown command (#1115): the word as typed (`shown`, already escaped), then the one step:
 * the near command when there is one, or the help that lists them all.
 */
export function unknownCommandLines(shown: string, near: string | undefined): string[] {
  const next = near ? `\`yokoten ${near}\`, if you meant it; \`yokoten help\` lists every command` : '`yokoten help` lists every command';
  return failure(undefined, `unknown command ${shown}`, next);
}

/** An unknown command: the closest one when it is near, or else the list. Exit 1. */
async function unknownCommand(invocation: Invocation, name: string): Promise<number> {
  // The word is anyone's text: a plain word shows as typed; any other is quoted with control and bidi characters escaped.
  const { shownValue } = await import('../src/rules/text/terminal.ts');
  print(invocation, unknownCommandLines(shownValue(name), closestWord(name, COMMANDS.map((command) => command.name))), invocation.stderr);
  return 1;
}

/**
 * True when the command line asks for help: `--help` or `-h` among its own words. For
 * `bot` and `desk`, only the words before `--` count: after it, they belong to the command it runs.
 */
function isHelpAsked(words: string[]): boolean {
  const end = words.indexOf('--');
  return (end === -1 ? words : words.slice(0, end)).some((word) => HELP_OPTIONS.includes(word));
}

/** What `hook` and `redact` print when started by hand: they wait for input from a pipe, so a terminal gets one line (#1053). */
const TERMINAL_LINE: Record<string, string> = {
  hook: 'yokoten hook is the tool-call guard: your agent runs it and sends it each call on stdin. Run `yokoten hook --help` for more.',
  redact: 'yokoten redact hides private text in a pipeline: try `cat file | yokoten redact`. Run `yokoten redact --help` for more.',
};

function dispatch(invocation: Invocation): number | Promise<number> {
  const { command: cmd, args } = invocation;
  // `<command> --help` prints that command's help and does nothing else (#207).
  const command = cmd === undefined ? undefined : findCommand(cmd);
  if (command && isHelpAsked(args)) {
    print(invocation, commandHelp(command));
    return 0;
  }
  const line = cmd === undefined ? undefined : TERMINAL_LINE[cmd];
  if (line && isTerminal(invocation.stdin)) {
    print(invocation, [line]);
    return 0;
  }
  // An old name says it was renamed, then runs as before (#1054); a command that kept its name
  // says nothing (#1115). The line is for a person: JSON for a script goes without it.
  const moved = cmd === undefined || args.includes('--json') ? undefined : movedNote(cmd);
  // A blank line follows the note, so a wrapped screen under it never reads as part of it (issue #1115).
  if (moved) print(invocation, [...noteLine(moved), ''], invocation.stderr);
  switch (command?.name ?? cmd) {
    case 'hook': {
      // The tool-call guard's worker, which bin/yokoten.mjs started before this file loaded (#408).
      const guard = args.includes('--stop') ? undefined : import('../src/run/hook.ts').then((m) => m.takeGuard());
      return Promise.all([guard, import('../src/commands/hook.ts')]).then(([started, m]) => m.runHook(invocation, started));
    }
    case 'anchor':
      return import('../src/commands/hook.ts').then((m) => m.runAnchor(invocation));
    case 'stops':
      return import('../src/commands/hook.ts').then((m) => m.runStops(invocation));
    case 'worker':
      return import('../src/commands/hook.ts').then((m) => m.runWorker(invocation));
    case 'desk':
      return import('../src/commands/desk/desk.ts').then((m) => m.runDesk(invocation));
    case 'tidy':
      return import('../src/commands/tidy/tidy.ts').then((m) => m.runTidy(invocation));
    case 'msg':
      return import('../src/commands/more/advice/messages.ts').then((m) => m.runMsg(invocation));
    case 'check':
      return import('../src/commands/more/check.ts').then((m) => m.runCheck(invocation));
    case 'ci-health':
      return import('../src/commands/more/check.ts').then((m) => m.runCiHealth(invocation));
    case 'provenance':
      return import('../src/commands/more/check.ts').then((m) => m.runProvenance(invocation));
    case 'mcp':
      return import('../src/commands/more/advice/mcp.ts').then((m) => m.runMcp(invocation));
    case 'borrowed':
      return import('../src/commands/more/check.ts').then((m) => m.runBorrowed(invocation));
    case 'redact':
      return import('../src/commands/more/check.ts').then((m) => m.runRedact(invocation));
    case 'test':
      return import('../src/commands/more/check.ts').then((m) => m.runTest(invocation));
    case 'marks':
      return import('../src/commands/more/check.ts').then((m) => m.runMarks(invocation));
    case 'changelog':
      return import('../src/commands/more/learn.ts').then((m) => m.runChangelog(invocation));
    case 'learn':
      return import('../src/commands/more/learn.ts').then((m) => m.runLearn(invocation));
    case 'doctor':
      return import('../src/commands/more/advice/doctor.ts').then((m) => m.runDoctor(invocation));
    case 'explain':
      return import('../src/commands/more/advice/doctor.ts').then((m) => m.runExplain(invocation));
    case 'adopt':
      return import('../src/commands/more/advice/doctor.ts').then((m) => m.runAdopt(invocation));
    case 'init':
      return import('../src/commands/more/setup/init.ts').then((m) => m.runInit(invocation));
    case 'trust':
      return import('../src/commands/more/setup/update.ts').then((m) => m.runTrust(invocation));
    case 'update':
      return import('../src/commands/more/setup/update.ts').then((m) => m.runUpdate(invocation));
    case 'upgrade':
      return import('../src/commands/more/setup/upgrade.ts').then((m) => m.runUpgrade(invocation));
    case 'bot':
      return import('../src/commands/more/merge/bot.ts').then((m) => m.runBot(invocation));
    case 'pr':
      return import('../src/commands/more/check.ts').then((m) => m.runPr(invocation));
    case 'train':
      return import('../src/commands/more/merge/train.ts').then((m) => m.runTrain(invocation));
    case 'conflicts':
      return import('../src/commands/more/merge/conflicts/report.ts').then((m) => m.runConflicts(invocation));
    case 'kanban':
      return import('../src/commands/kanban/server.ts').then((m) => m.runBoard(invocation));
    case 'install':
      return import('../src/commands/more/setup/install.ts').then((m) => m.runInstall(invocation));
    case 'uninstall':
      return import('../src/commands/more/setup/install.ts').then((m) => m.runUninstall(invocation));
    case 'version': {
      const options = parse('version', args);
      if (typeof options === 'string') return usage(invocation, options);
      print(invocation, versionLines());
      return 0;
    }
    case '--version':
    case '-v':
      print(invocation, versionLines());
      return 0;
    case 'help': {
      const options = parse('help', args);
      if (typeof options === 'string') return usage(invocation, options);
      const [name] = options.positional;
      if (name === undefined) {
        print(invocation, helpLines(options.flags.has('--all')));
        return 0;
      }
      const named = findCommand(name);
      if (!named) return unknownCommand(invocation, name);
      print(invocation, commandHelp(named));
      return 0;
    }
    case undefined:
      // No command in a project is not an error: it is the start (#548).
      return import('../src/commands/more/setup/start.ts').then((m) => m.runStart(invocation));
    case '--help':
    case '-h':
      break;
    default:
      return unknownCommand(invocation, cmd ?? '');
  }
  print(invocation, helpLines(false));
  return 0;
}

/**
 * The step after an error nothing caught (#1115): doctor finds what is wrong with this project
 * or machine; when doctor itself failed, the help.
 */
export const crashNext = (command: string | undefined): string => (command === 'doctor' ? 'yokoten help' : 'yokoten doctor');

/** Run one command line, and give its exit code. Exit 1, not 2, on an error: a broken guard should be seen, not block every tool call. */
export function main(invocation: Invocation): Promise<number> {
  return Promise.resolve(invocation)
    .then(dispatch)
    .catch((err: Error) => {
      // One line, as data with --json and as the failure title (#1115). No command (the
      // one-command start, #548) has no name to print: failure() says `yokoten ·`, never "yokoten undefined".
      const what = String(err?.message ?? err).split('\n').map((line) => line.trim()).filter(Boolean).join(' ');
      return fail(invocation, what || 'an unexpected error', crashNext(invocation.command));
    });
}

/** Run the command line this process was started with. Only here are process.argv, process.env, process.cwd() and the streams read. */
export function runFromProcess(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  // The one place HOME falls back to the system's home (#356): every module below reads it from env.
  // stdin is read by its fd; its stream is made only when a command reads it (see Input).
  const stdin = {
    fd: 0,
    text: null,
    get stream() {
      return process.stdin;
    },
  };
  const invocation: Invocation = { command, args, env: withHome(process.env), cwd: process.cwd(), stdout: process.stdout, stderr: process.stderr, stdin, script: process.argv[1] ?? 'yokoten', platform: process.platform };
  return main(invocation).then((code) => {
    process.exitCode = code;
  });
}
