// Six screens as the lead captured them on 2026-10-26 (UTC), from main at 440b1bbc9, through a
// pipe at no colour, and the owner's verdict on each (issue #1099). The screen limits of record
// 0049 are calibrated on them: the two he judged OK pass, the four he judged too much text fail.
// For a guard refusal (S061) the text is stderr, the part a person reads; stdout is JSON for the agent.
// Kept as captured: never edit these to make a limit pass. The one change: S002's first line
// names the version from VERSION, so a release needs no edit here.
import '../home.ts';
import { VERSION } from '../../../src/setup/files.ts';

/** One captured screen: the command, its exit code, the text, and the owner's verdict. */
export interface CapturedScreen {
  id: string;
  command: string;
  exit: number;
  isOk: boolean;
  verdict: string;
  lines: string[];
}

export const CAPTURED_SCREENS: CapturedScreen[] = [
  {
    id: 'S002',
    command: 'yokoten help',
    exit: 0,
    isOk: true,
    verdict: 'OK',
    lines: [
      `yokoten ${VERSION}`,
      '',
      'Start here: run `yokoten` in your project.',
      '',
      'Usage: yokoten <command> [options]',
      '',
      'Commands:',
      '  desk        give one task to one AI, in its own fenced desk',
      '  kanban      the team at a glance, live and read only (preview)',
      '  tidy        find old branches, worktrees and desks, and put them away',
      '',
      'More: `yokoten help --all` lists every command; `yokoten <command> --help` explains one',
    ],
  },
  {
    id: 'S071',
    command: 'git commit -m "add notes"',
    exit: 1,
    isOk: true,
    verdict: 'OK',
    lines: [
      'yokoten check --staged · 1 problem',
      '',
      '  MISSING     this commit\'s time carries your time zone',
      '              A time zone narrows down where you live. Set your shell to UTC',
      '              with `export TZ=UTC` (add it to ~/.bashrc); yokoten init sets it',
      '              for agent sessions.',
      '',
      'Next: fix them, then `yokoten check`',
      'More: https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#privacy',
    ],
  },
  {
    id: 'S007',
    command: 'yokoten desk --help',
    exit: 0,
    isOk: false,
    verdict: 'too much text, no structure',
    lines: [
      'Usage: yokoten desk [<issue> | "<task>"] [--agent <name>] [--pr] [--no-install]',
      '',
      'With no words, lists your desks and writes nothing. With an issue number or a',
      'task in',
      'quotes, makes the desk ../<repo>-desks/<n>/ (its own clone, branch desk/<n>),',
      'writes a',
      'brief, and starts the AI there inside the fence. It never pushes. When the AI',
      'exits,',
      'the desk runs the check and the tests in the fence and shows the evidence. A',
      'stopped',
      'desk shows on the next start; `yokoten desk <n>` again goes on from its last',
      'commit.',
      '--pr pushes the branch and opens the pull request (as the bot when it is set',
      'up).',
      'On native Windows, run it in WSL.',
      '',
      'The old form, for scripts: yokoten desk <agent> <folder> -- <command>.',
      'Starts the command after -- in a sandbox around <folder>, which must be its own',
      'git clone.',
      'The agent writes only in the folder and the desk\'s own state folder,',
      '<folder>.state, which',
      'gets only your login file. Your home, other projects and agent state are hidden.',
      'Commands have no network; only the agent\'s API hosts pass the proxy, for any',
      'command inside.',
      '.git/config and .git/hooks stay read-only. YOKOTEN_ROLE=worker and TZ=UTC;',
      'tokens stay out.',
      'Agents: claude-code, codex (DeepSeek too), grok, muse. Linux and WSL2 use bwrap;',
      'macOS',
      'uses sandbox-exec; native Windows is not built yet. Run the commit check outside',
      'until #665.',
      'The agent joins the team of the project you run it from, by the desk folder\'s',
      'name or --name: see `yokoten msg`.',
      '',
      'Options:',
      '  --agent <name>  the AI to start: claude-code (first when installed) or codex',
      '  --pr            push the desk\'s branch and open its pull request; nothing is',
      '                  pushed without it',
      '  --no-install    skip npm ci in a new desk',
      '  --name <name>   the agent\'s name on the team (default: the desk folder\'s name)',
      '  --read <paths>  more paths to show read-only, joined by commas',
      '  --host <hosts>  more API hosts the agent may reach, joined by commas',
      '  --marks         show the private-marks file read-only (off: the agent could',
      '                  read it until #665)',
      '  --help, -h      this help',
      '',
      'Example:',
      '  yokoten desk 42',
    ],
  },
  {
    id: 'S057',
    command: 'yokoten',
    exit: 1,
    isOk: false,
    verdict: 'too much text, no structure',
    lines: [
      'yokoten: /var/tmp/yokoten-audit/work/plain is not inside a git repo. The checks read commits, so yokoten needs git history. Run it inside your project, or `git init` first.',
      '  docs: https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#commands.',
      'A project starts with git: run `git init` here, then `yokoten` again.',
      'Run `yokoten help` to see every command.',
    ],
  },
  {
    id: 'S061',
    command: 'yokoten hook',
    exit: 2,
    isOk: false,
    verdict: 'too much text, no structure',
    lines: [
      'yokoten stopped this: git push -f forces the push [force-push]',
      '',
      '  Why       A plain force push can throw away work that someone else pushed.',
      '  Instead   Use --force-with-lease, which stops when the remote has work you have not seen.',
      '  More      https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#the-core-rules',
    ],
  },
  {
    id: 'S069',
    command: 'yokoten doctor --session',
    exit: 0,
    isOk: false,
    verdict: 'too much text, no structure',
    lines: [
      'yokoten is BROKEN: user guard check, OpenCode plugin note let a known-bad input through. Do not trust any check until this is fixed.',
      'yokoten: stage 1 of 5, safety net. Next: no AGENTS.md, so the agents have no written rules here; `yokoten init` adds one.',
      'Why: an agent follows the rules it can read, and only those.',
      'Tell the user in plain words, one step at a time, and offer to do it (as-is, lighter, or not now with a reason).',
      'yokoten: ~/.config/yokoten/private-marks is missing or has no marks. Without your marks, the privacy check knows only email addresses, IP addresses and secrets. Run `yokoten marks add` and type your name, your city or a domain; it is not shown.',
      '  docs: https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#privacy',
    ],
  },
];
