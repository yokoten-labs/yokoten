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
2. **One layout, `src/rules/text/screen.ts`.** A screen is a title line, short sections under
   headings, rows, and a `Next:` line, wrapped once at 80 columns. It is pure. It lives in
   `src/rules/text/` with `message.ts` (refusals, findings, notes): how yokoten's text
   reads is a rule, and the guard's refusals in `src/rules/` use it. `src/platform/` keeps
   only the system and its paths (owner, 2026-10-26). `shared.ts` re-exports its names;
   there is no second copy.
3. **A help page is data.** `HelpSpec` holds the usage, a summary of at most two lines,
   examples, options, and sections of rows. `commandHelp` builds every page from the
   `COMMANDS` table: every entry has a `help` field, and there is no other way to write a
   help page.
4. **The limits are one data table, a development tool.** `SCREEN_RULES` in
   `test/repo/docs/screen-rules.ts` holds each rule as a row: what it counts, its limit, why,
   and its source. `screenProblems` there measures every row. It is not in `src/`, because
   only the tests use it. Issue #1115 grew the table from 7 rules to 12, after the owner's
   review of 72 screens, checked against clig.dev and Google's error-message course:

   | Rule | Limit |
   |---|---|
   | `width`, `widest` | at most 1 line over 80 columns; none over 100 |
   | `prose` | at most 4 lines of prose in a row at the left edge |
   | `help-summary` | at most 2 lines |
   | `next-step` | a failed screen ends with what to do next |
   | `colour` | no colour codes when not on a terminal |
   | `label-columns` | one text column for the two-column rows of a screen |
   | `wrapped-example` | an example's text stays beside its command |
   | `spaced-items` | a blank line between items when one wraps |
   | `fix-line` | a problem's command is on its own last line, `Fix: <command>` |
   | `same-fix-once` | one Fix line shows once per screen |
   | `no-internal-path` | no absolute path outside `~`, and no machine path |

   The table is the source: a rule changes in its row, and this record does not repeat the
   numbers.

5. **The limits are calibrated on the owner's verdicts.** The captured screens are in
   `test/repo/docs/captured-screens.ts`. The test fails when a limit passes a screen he judged
   too much, or fails S002, the one he judged OK. S071 is overruled with a reason: its row is
   the one he flagged in S072.
6. **A screen test** (`test/repo/docs/screens.test.ts`) renders, in this process, every
   command's help page and usage error from `COMMANDS`, so a new command joins by itself.
   It adds the screens of a state: the start, the unknown command, the not-a-repo errors,
   six guard calls, three session starts, and the commit check. Today's offenders are on
   `WAIVED`, each with its rule and #1115. The list only shrinks: a waived screen that
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
