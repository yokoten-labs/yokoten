# 0049 Every screen follows one layout, and a test holds its limits

Status: proposed
Date: 2026-10-27 (UTC)

## Context

On 2026-10-26 (UTC) the lead captured the 72 screens a v0.1.2 user can reach: help pages,
errors, guard refusals, the session start and the commit check (issue #1099). The owner
judged six. Two were OK: `yokoten help` (S002) and a commit check that found a problem
(S071). Four had "too much text, no structure": `desk --help` (S007), the not-a-repo error
(S057), a guard refusal (S061) and the session start (S069).

The cause is shared. Each command builds its own text. `src/commands/shared.ts` had a title,
rows and an 80-column wrap, but help pages, errors and refusals did not use them. Help text
was broken by hand at about 85 columns and then wrapped again at 80, so `desk --help` broke
mid-sentence on every line. Nothing checked a screen, so problems were found by hand, after
a release.

## Decision

1. **We follow the Command Line Interface Guidelines** ([clig.dev](https://clig.dev)). The
   rules we take from it, in our words:
   - **Help.** Start with the usage, then a short description, then examples, with the
     common case first. Then the options, most used first. Headings split the page. Help
     reads the same in a pipe as on a terminal. Point to the web docs for the rest.
   - **Errors.** Say what went wrong in words a person knows, and what to do next. Put the
     important line last, where the eye lands. Keep signal over noise: one cause, one fix.
   - **Output.** The result goes to stdout, messages to stderr. `--json` gives data and
     nothing else. No colour when the stream is not a terminal, when `NO_COLOR` is set, or
     when `TERM=dumb`.
   - **State.** When a command changes something, it says what changed, and the next
     command to type.
2. **One layout, `src/platform/screen.ts`.** A screen is a title line, short sections under
   headings, rows, and a `Next:` line, wrapped once at 80 columns. It is pure and in the
   lowest layer, so `src/rules/` (the guard's refusals) can use it too. `shared.ts`
   re-exports its names; there is no second copy.
3. **A help page is data.** `HelpSpec` holds the usage, a summary of at most two lines,
   examples, options, and sections of rows. `commandHelp` builds every page from the
   `COMMANDS` table. An entry with a `help` field is a spec page; the older entries keep
   `text` and `example` until they move (`desk` is the first spec page).
4. **The limits, measured by `screenProblems`:**

   | Limit | Value | Why |
   |---|---|---|
   | Line width | 80 columns | The terminal width most people have, and Heroku's CLI guide |
   | Lines over 80 | at most 1 per screen | A long link cannot break |
   | Widest line | 100 columns | Even a link line stays readable |
   | Prose in a row | at most 4 lines at the left edge | More is a wall; use a heading or rows |
   | Help summary | at most 2 lines | The rest goes in rows, examples or the docs |
   | A failed command | the last line (or the line before `More`) says what to do next | clig: the important line last |
   | Colour codes | none in a pipe | clig: no colour when not a terminal |

5. **The limits are calibrated on the owner's verdicts.** The six captured screens are in
   `test/repo/docs/captured-screens.ts`. The test fails when a limit passes S007, S057, S061
   or S069, or fails S002 or S071. The one-line allowance is what lets S002 pass: its last
   line is 87 columns of prose. S061 has two lines past 80, so it fails.
6. **A screen test** (`test/repo/docs/screens.test.ts`) renders, in this process, every
   command's help page and usage error from `COMMANDS`, so a new command joins by itself.
   It adds the screens of a state: the start, the unknown command, the not-a-repo errors,
   six guard calls, three session starts, and the commit check. Today's offenders are on
   `WAIVED`, each with its reason and #1099. The list only shrinks: a waived screen that
   passes fails the test, and `WAIVED_MOST` is the cap.

## Options not taken

- **A parser library such as commander, yargs or oclif.** They bring help layout, but
  yokoten's core has zero run-time dependencies (AGENTS.md, record 0008). Node's
  `util.parseArgs` and `util.styleText` give the rest.
- **A fixed total length.** A list such as `help --all` is long but structured. The prose
  and summary limits catch a wall of text; a length cap would only catch lists.
- **Snapshot tests of each screen.** They fail on every wording change and say nothing about
  structure. Limits say what is wrong.

## Consequences

- **Easier:** a new screen is checked the day it is written. A reviewer reads the limit that
  broke, not a hunch. Help pages are data, so a translation or a web page can read them.
- **Harder:** stage 2 of #1099 must move 38 screens onto the layout, and some text must get
  shorter. A long fact moves to the guide, with a `More:` link.
- **Still open:** the test reaches each command's help and usage error, but not every state
  of every command (each `explain <id>`, or each bare command). Those join as their
  scenarios are written. The limits can tighten once the waivers are gone.
