# 0057 The command list, a dev track, and a budget of product slots

Status: accepted
Date: 2026-10-29 (UTC)

## Context

On 2026-10-29 the owner asked for a switch on every CLI command and a limit on how many are
active, "like skill slots in a game". He wanted a list of every command, split into dev
and prod, with a priority to build by. He asked whether the architecture exists and
whether the stack supports it.

The facts, read that day:

- All 33 commands are rows of one table, `COMMANDS` in `src/run/cli.ts`. Each row gives:
  - a `group`, one of five jobs (record 0052);
  - `shown`, whether it is on the short list or only in `help --all`.
  The help pages and the parser read the same rows (#207).
- Record 0043 found that most commands were built for our own agent pipeline and then
  shipped as product. Three of them acted without being asked (issues #1042, #1045, #1046).
- `yokoten.json` already has a `commands` key, for shell commands the guard blocks. A
  switch for CLI commands needs a key of its own.
- Others have done this. Homebrew keeps developer commands in `dev-cmd/`, hidden until
  developer mode is on. Feature-flag systems give each feature its own switch.

The lead offered two readings of "slots" with an example, and the owner chose A:

- **A, a product budget:** the slots limit how many commands *we* put in front of a new user.
- **B, user loadouts:** each user picks commands and hits a cap.

B makes a new user configure the tool, then meet a "no free slot" error we built ourselves.

## Decision

The owner's principle for it: simple and strong, so every other file in the repo can rely
on it.

1. **One command list.** Each `COMMANDS` row gains three fields:
   - `track`: `prod` or `dev`;
   - `priority`: a number, lower first, which orders the work;
   - `status`: `stable` or `experimental`.
   `yokoten help --all --json` prints the list. **Write once, run everywhere** (owner,
   2026-10-29): every place that names commands reads this one list, and none keeps a
   copy:
   - the help pages and the parser;
   - the docs and their translations;
   - the README, the site and the kanban;
   - the kit's skills.
   The tracks and switches work the same on Linux, Windows and macOS, and under every AI
   runtime the guard supports. A test fails when any of these names a command the list
   does not have, or shows a `dev` command as a product one.
2. **Two tracks.** A `dev` command is left out of `help` and is refused with one line
   naming the switch, until dev mode is on: `"cli": { "dev": true }` in `yokoten.json`, or
   `--dev` on a single call. A `prod` command always runs.
3. **A product budget.** At most **12** `prod` commands. A test counts them, and the
   number only goes down. Moving a command to `prod` when all 12 slots are full means
   moving one out first, or a new record that raises the number with a reason.
4. **Switches, with a floor.** A user may turn a command off with
   `"cli": { "off": ["train"] }`. The guard's commands (`hook`, `check`) and the ones that
   undo yokoten (`uninstall`, `help`, `version`) can't be turned off. The floor follows
   record 0056: they guard, or they are the way out. There is no cap on what a user turns
   off or on.

## Options not taken

- **B, user loadouts with a cap:** a new user must choose before anything works, and the
  cap is friction we add on purpose. The per-command switch in 4 gives the control
  without the cap.
- **A plugin system** (each command a package, loaded on demand): more parts and an
  install step for each command. One table already gives the list; record 0039 says not
  to build a layer before the need.
- **No dev track, only `shown`:** hides a command from the short list but still runs it,
  so a pipeline command can still act by surprise (record 0043).

## Consequences

- Easier: one place answers "what does yokoten do", and the work goes by `priority`. A new
  user sees at most 12 commands.
- Harder: every new command needs a track and a priority. Promoting a command to `prod`
  costs a slot.
- To check:
  - a test fails when a row lacks the fields, when there are more than 12 `prod` rows,
    or when a floor command is turned off;
  - the docs, README, site and skills name only commands on the list, with their track
    (a drift test: text shown in two places has one source).
- The first pass that sorts the 33 commands into tracks is its own issue. The owner
  reviews which 12 are `prod`.
