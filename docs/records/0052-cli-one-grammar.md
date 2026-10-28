# 0052 The CLI speaks one grammar: result, then screen

Status: proposed
Date: 2026-10-28 (UTC)

## Context

Record 0049 gave every screen one layout and a test that holds its limits. Stage 2 of
issue #1099 moved the screens onto it. The owner then judged the result and sent 58
complaints. They are about alignment (31), blank lines that glue or split wrongly (18),
too many words (7) and unclear meaning (8). None is about a command's name.

Looking at the code showed why they came back. Each command still builds its own text.
206 places print lines, and 108 pass a bare list of strings. 99 strings start with
`yokoten <cmd>: `. 17 column widths are copied by hand, 117 blank lines are made by hand,
7 files read `isTTY`, and 5 regexes read a report line back to learn what a command did.
`setup.ts` rebuilt its screens from prose. Nothing checked a screen unless a test asked.

This record keeps the names and the layout of 0049. It changes how a command makes its text.

## Decision

D1. **A command reads, computes a result, renders it, and prints it.** The result is plain
data with an exported type. The screen is a pure function `xScreen(result, place)` built
only with `src/rules/text/screen.ts`. Nothing parses printed text back. `--json` prints the
same result the screen was built from.

D2. **The layout makes the rhythm.** Only `screen()` and `spaced()` make blank lines. A
hand-made blank line in `src/` fails a ratchet test. Items are separated whenever one has
more than one line. A title never touches the rows under it.

D3. **One grammar for every message.** A result is `yokoten <cmd> · <what is true>` on
stdout. A failure, a refusal or a usage error is `failure(cmd, what, next)` on stderr with
exit 1. A note to the person is `noteLine(text)` on stderr. No `yokoten <cmd>: sentence`
line remains.

D4. **The platform is an argument.** A runner reads `invocation.platform` once and passes
it down. No runner reads `process.platform`. The `PLATFORM_READS` ratchet goes down.

D5. **One value for terminal facts.** `terminalOf(invocation)` answers: can I ask, can I
use colour, is a person there. No command reads `isTTY` itself.

D6. **Every render is checked.** The test harness runs `screenProblems` on every output a
command produces in the suite. The walk-through dump lists every checked screen, with a
colour copy, the platform it was made for, and its problems. Pure screens (install,
uninstall, init, upgrade, first run, the kanban address) are rendered for Linux, Windows
and macOS from typed results.

D7. **Help is grouped by job.** No command is called "moved" when it did not move.

D8. **A bare command only reads** (record 0043 section 3). One exception stays: bare
`yokoten` on a terminal shows what it will write and asks first. In a pipe it goes ahead,
because install only adds (record 0014, issue #1027).

D9. **No new dependency, no language of our own, no new layer.** Records 0028 to 0031 stand.

D10. **Beginner words.** A title says what is true now. A failure ends with one `Next:`
command. Every review reads each new screen as a newcomer would, because "meaning unclear"
was the owner's second-largest kind of complaint.

## The command map

The names stay. The owner's complaints are not about names. `install`, `init`, `doctor` and
`check` are the names other tools taught people, and the docs and kit use them often.
Renaming them would cost four languages of docs and every kit skill for no complaint on record.

| Command | Change |
|---|---|
| `yokoten` | First run sets up (asks on a terminal), then shows the status screen. It is built from the results of install, init and doctor, never from printed text |
| `help` | Shows `yokoten`, `desk`, `kanban`, `check` and `tidy`. `check` joins because every `Fix:` line and the commit hook point to it |
| `help --all` | Five groups by job: Start, Work, Guard, Merge and CI, Maintain. `help` and `version` are in Start, so there is no sixth group. Replaces the two old groups, one for commands said to have moved and one for agents and CI |
| `doctor` | A bare `doctor` reads and changes nothing. What it used to fix by itself is now `marks fill` |
| `marks` | New action `fill`: adds the marks yokoten can read from this machine (your git name, git email and forge login) and shows their kinds, never their values |
| `install`, `init`, `doctor`, `trust`, `update`, `worker`, `msg` | Same. The "moved to yokoten" note is removed: they did not move, and the note cost a line on every run |
| `board` | Now `kanban`. The note stays, because this is a real rename |
| `install --list`, `init --list`, `uninstall --list` | Rows under a title, from the result's changes |
| `kanban --text` | One renderer, titled `yokoten kanban`. `--json` added |
| `kanban` (serving) | The address screen takes the real start result, fits 80 columns, shows no token |
| `upgrade` | A failed step is a screen with a `Fix:` line |
| `desk` (list), `tidy` (list) | `--json` added, for the kanban to read later |
| every error line | `yokoten <cmd> · <what>` plus `Next:` on stderr |
| exit codes | Unchanged: 0 ok, 1 problem or failure. A separate code for usage errors was considered and rejected, because the hook's exit code is a contract with the agent vendors |
| removed commands | None. `test`, `adopt`, `borrowed` and `learn --upstream` are candidates for v0.2, once we know how they are used |

## How it is held

Six ratchets in `test/repo/docs/screens.test.ts` count what a screen built by hand leaves in
`src/` and `bin/`: the old `yokoten <cmd>: ` line start (R1), a typed column number (R2), a
typed blank line in screen code (R3), a raw stream write outside `shared.ts` (R4, an
allow-list), a regex over report lines (R5) and an `isTTY` read outside `shared.ts` (R6).
Every ceiling is 0. A hit that stays needs an entry in `RATCHET_REASONS` with its file, line,
a reason and issue #1115, and the table must be as long as the found count. R3 looks only at
screen code: the files that print to a person. A `''` that is data (a state, an argument, a
Markdown brief) sits in a short `NOT_SCREEN` list with a reason, and a test keeps that list
honest.

## What this amends

- **Record 0043, section 1.** It showed three commands. `help` now shows five: `yokoten`,
  `desk`, `kanban`, `check` and `tidy`.
- **Record 0043, section 2.** Old commands that "moved" printed a note. That note was false
  for everything except `board`, and it is gone.
- **Record 0049, stage 2.** It is done. The screens are on the layout.
- **Record 0049, section 6.** The screen test no longer checks only a list of screens. The
  harness checks every render the suite makes, and the dump comes from that test.

## What we took from open source

Rule: search first. A permissive license means we may copy with notices. A restrictive one
means a clean-room rewrite. The core stays free of run-time dependencies. Stars and last push
were read from the GitHub API on 2026-10-27.

| Project | License | Decision |
|---|---|---|
| clig.dev | CC BY-SA 4.0 (text) | Pattern, already in 0049: examples first, the fix last, no colour off a terminal |
| gh (cli/cli) | MIT | Pattern: one `IOStreams` object answers terminal, colour and width, which became `terminalOf()`. Each command computes a result, then renders. No Go code copied |
| cargo | Apache-2.0 | Pattern: a right-aligned status word before each line, which our mark column already does. `--message-format json` became `--json`, the result object |
| Heroku CLI style guide | docs | Pattern: 80 columns, already in 0049 |
| log-symbols, is-unicode-supported | MIT | Their fallback tables are already in `shared.ts` with attribution. Nothing more taken |
| oclif, commander, yargs | MIT | Not taken. They are parsers and frameworks; ours is 30 lines on the `COMMANDS` table |
| ink | MIT | Not taken. It is React in a terminal; v0.1.x prints plain text that agents read |
| chalk | MIT | Not taken. Node's `util.styleText` does the job |
| cli-table3, wrap-ansi, string-width | MIT | Not taken. `table()` and `wrap()` are short, and no colour codes reach `wrap`. Output is English, so wide characters are not needed yet |

No dependency is added and no code is copied.

## Options not taken

- **Rename commands to match other tools.** No complaint asks for it, and the cost is large.
- **A new exit code for usage errors.** The hook's code is a vendor contract.
- **Remove the rarely used commands now.** We lack usage evidence; v0.2 can decide.
- **Snapshot tests of screens.** They fail on every wording change and say nothing about
  structure. The limits of 0049 say what is wrong.

## Consequences

- **Easier:** the kanban can show the same facts the CLI prints, because every command makes
  its facts as data first. A new screen is checked the day it is written.
- **Harder:** tests that asserted prose now assert results. Six ratchet counts must reach 0,
  and each one only goes down.
- **Still open:** the owner has not yet judged the new screens. The dump is for him to judge
  after the baseline lands.
