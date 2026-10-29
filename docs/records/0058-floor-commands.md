# 0058 Floor commands, and how every command is added, removed and changed

Status: accepted
Date: 2026-10-29 (UTC)

## Context

Record 0057 set:
- one command list with `track: prod | dev`;
- a budget of 12 `prod` commands;
- switches with a floor that can't be turned off: `hook`, `check`, `uninstall`, `help`, `version`.

The same day the owner asked four more questions:

1. **Do floor commands take product slots?** He chose no.
2. **How are floor commands added and removed later?** He asked for a designed add, remove, change and query path ("增删改查的架构"), for the floor and for the other tracks.
3. **Can users choose their own floor?** "Each user may want different floor commands; we ship only the default."
4. **Is the whole idea worth building?** The lead checked other tools on 2026-10-29:
   - git's help lists the most common commands and shows the rest only with `-a`;
   - Homebrew keeps developer commands in their own group, behind a developer mode (`brew developer on`, `HOMEBREW_DEVELOPER`);
   - Claude Code, Codex and Copilot CLI let users allow or deny tools.

   The lead ranked the parts. Three are worth building now: the list, the dev track and the budget. A switch per command is worth having through the guard's existing `commands.block` list, not a second switch. A user-chosen floor is not worth building before a user asks. The owner agreed.

Facts read that day:
- `commands.block` in `yokoten.json` blocks shell commands by program name (`checkBlocked`, `src/rules/guards/commands/check.ts`). It can't name a yokoten subcommand such as `yokoten train`.
- `yokoten.json` is a guard setting: the lead's edit of it asks the owner, and a worker's is refused (record 0056, #1212).

## Decision

1. **Three tracks.** `track` is `floor`, `prod` or `dev`.
   - A `floor` command always runs: dev mode, a switch and a block list never stop it. It takes no product slot.
   - The 12-slot budget of record 0057 counts `prod` only.
   - The floor holds at most 5 commands. A sixth needs a record that says why.
2. **The default floor.** `hook`, `check`, `uninstall`, `help` and `version`.
   - `hook` is the **hard floor**: no setting removes it, because without it the guard is off (record 0056, the floor's fourth reason).
   - The other four are the **default floor**: shipped by yokoten, and a user could remove them (point 6).
3. **Who may join the floor.** A command meets at least one of three tests:
   - the guard can't run without it;
   - it is the way out of yokoten, or the way to undo what yokoten did;
   - it is how a user learns what is installed and which rules apply.

   It must also only read, or only take safety actions.
4. **Add, remove, change, query.**

   | | floor | prod (12) | dev |
   |---|---|---|---|
   | Query | `yokoten help --all` groups commands by track and shows where each floor entry comes from; `--json` gives the same to tools | same | same |
   | Add | edit `src/run/floor.ts`, with a new record, approved by the owner | a free slot: tier A, with the reason in the PR; no free slot: move one out first, or a record raises the budget | ordinary PR |
   | Remove | edit `floor.ts`, with a record that marks the old entry replaced, approved by the owner | tier A: to `dev`, or deleted | ordinary PR |
   | Change | its test or reason: as Add; its code: tier A, reviewed by another model | tier A | ordinary PR |

   - `src/run/floor.ts` holds the floor list: the name, the test it meets, and the record that admitted it. The list is kept apart from `COMMANDS` so that CODEOWNERS can require the owner on it alone.
   - `COMMANDS` stays the one list of commands. Its `track` must agree with `floor.ts`.
5. **Enforced, not trusted:**
   - CODEOWNERS requires the owner's approval on `src/run/floor.ts`;
   - tests check that:
     - `floor.ts` and `COMMANDS` agree;
     - each floor entry names an accepted record;
     - there are at most 5 floor and 12 `prod` commands;
     - each floor command only reads or only takes safety actions;
   - `floor.ts` is lead-only, so a worker's edit is refused;
   - every add or remove ships a Security change file.
6. **User choice of floor: designed now, built when a user asks.**
   - The key is reserved: `"cli": { "floor": { "add": [...], "remove": [...] } }` in `yokoten.json`.
   - When built, `remove` naming `hook`, or naming an unknown command, is a config problem with its reason, never ignored.
   - Changing the key goes through the guard-settings ask. Until it is built, the key is a config problem that says "not yet".
7. **One switch per command, through the block list.** Record 0057's `"cli": { "off": [...] }` is replaced:
   - `commands.block` also takes `yokoten <command>` entries, with a reason;
   - the guard refuses them to agents;
   - the CLI reads the same list and refuses a person with one line that names the reason;
   - a floor command in the list is a config problem.

## Options not taken

- **A second switch list (`cli.off`, record 0057 point 4).** Two lists that both stop commands would disagree, and users would not know which one wins.
- **A user floor built now.** No user has asked, and each new key adds to a new user's load (record 0039: build after the need).
- **Floor inside the 12 slots.** The owner chose not to: the floor is safety and orientation, not product surface.
- **Floor rules kept in `COMMANDS` alone.** The owner's approval could then only be required on the whole command list, so every ordinary command change would wait for him.

## Consequences

- **Easier:**
  - one table answers what each command is and who may change it;
  - the owner holds the key to the floor and no one else;
  - `doctor` and `check` advice never points at a refused command, because commands that advice names go to `prod` (record 0057, issue #1235).
- **Harder:**
  - a floor change takes a record and the owner;
  - `commands.block` grows a second kind of entry, and its checker must read both kinds.
- **Record 0057 point 4** (the `cli.off` switches) is replaced by point 7 here. Its other points stand.
- **Work:** issue #1235 builds points 1, 2, 4, 5 and 7. Point 6 waits for a user's request.
