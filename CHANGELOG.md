# Changelog

All notable changes are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Dates are UTC.

## [Unreleased]

## [0.1.1] - 2026-10-25

The safeguard release: yokoten now protects you from the first command, in any repo, with no setup.
To start, read the [guide](https://github.com/yokoten-labs/yokoten/blob/v0.1.1/docs/guide.md).

**The main changes**

- The five protections are on for everyone, in any repo, with no `yokoten init` and no setting.
- The guard also stops root commands (`sudo`, `su`), wiping your home folder or a system folder, and disk commands.
- Every refusal reads the same, in four lines: what was stopped, Why, Do instead, More.
- Many AI sessions in one repo: `yokoten conflicts` and `yokoten train --next` say which change to merge first, and the guard stops an edit to a file another open change is moving.
- `yokoten upgrade` brings yokoten to the newest version in one command, with no SSH key.
- OpenCode is guarded too, tested with DeepSeek V4.1 Flash and GLM-5.3 Flash. The README shows every agent in one table.
- `yokoten doctor` shows your next step first, then one block per stage.

### Added

- `yokoten train <pr>...` merges an approved, green queue one pull request at a time (#320). Each merged tree runs the project's tests and `check`. The first pull request that needs a person stops the train.
- `install` now writes the user-level command guard for Antigravity CLI and Copilot CLI (#342).
  For agy it goes in `~/.gemini/config/hooks.json`, and for Copilot in `~/.copilot/hooks/yokoten.json`.
  Both files run in every workspace, so a repo without yokoten is guarded too.
  `uninstall` removes the guard and keeps the user's own entries.
  `doctor` notes a missing or out-of-date guard when that CLI's folder exists.
  Neither agent gets a stop check yet: agy has no re-entry signal, and Copilot lets a timed-out hook go on.
- `yokoten mcp`: start a project's MCP server over stdio and check its tools for Claude, Gemini, OpenAI strict, Cursor and ChatGPT apps. It reports schema, name, annotation, count, result-shape, stdout and Windows launch traps, each with a what, a why and a fix. See the MCP section of the guide (#370).
- A build, a test suite, a package install or a container build now asks before it starts when the last reading of the Windows drive under a WSL disk file is low: Claude Code shows the question, and the other agents get the same words as a note. The guard reads the reading `doctor` kept, never the drive, so it stays fast (#401).
- `yokoten pr sync` merges main into open pull requests after each merge, resolves mechanical conflicts, and pushes as the bot (#432).
- `yokoten doctor` now reports what one guard call costs on this machine, in one line: `guard: 90 ms per command (60 ms CPU)`, the wall time and the CPU time of a real run. A session start does not run it (#461). A guard that cannot run leaves the line out, rather than reporting a cost it did not spend.

  New `yokoten test` runs the tests light for a machine other work shares: `node --test` under `nice -n 10` (not on Windows), with the concurrency at most half the cores and one per GB of free memory, and at least 1. It is on by default; `YOKOTEN_LIGHT_TESTS=0` or `--heavy` turns it off (#461).
- A merge skill tells the lead to merge only through the bot.
  The lead then runs `git fetch` and reads `origin/main`.
  The lead stops when that commit is not UTC.
  Doctor still does not count those commits (#488).
- `yokoten doctor` now reads a Gitea server, so a Gitea repo walks the road with its forge steps judged instead of marked "can't check". Name a self-hosted Gitea in `yokoten.json` (`"host": "gitea"`), give the bot user a token in `GITEA_TOKEN`, and doctor reads the default branch protection, tag protection, labels, milestones and forgotten branches through Gitea's API. `gitea.com` is recognised without the key. The workflow steps also read `.gitea/workflows` on Gitea, next to `.github/workflows`. The API is read only, and only in full doctor (#505).
- Kit skills now carry the merge order, the second-time cause, the weak-model road, and the `issue #N` name. This is part 1 of 2 (issue #531).
- Every yokoten skill, including the plugin's own, now says in one line that a skills-only
  copy from `npx skills add` has no guard. It gives the fix: `npx yokoten install`. `doctor`
  names a skills-only copy beside the Claude Code plugin. It gives one fix for each copy:
  `yokoten uninstall` at home, and each project yokoten skill folder to delete (#540).
- `check --issue` also checks the issue's labels: one type label and one tier label,
  when the repo has those labels. `yokoten bot` refuses a `gh issue create` without them
  before it sends anything (#544).
- `yokoten doctor` and `yokoten adopt` now find the test command of .NET, Ruby, PHP, Swift, Elixir, Dart and Flutter projects. A Makefile with a test target counts too. In CI, `dotnet test`, `bundle exec rspec`, `vendor/bin/phpunit`, `swift test`, `mix test`, `dart test` and `flutter test` now count as running the tests. Both commands read one table, so they name the same command (#546).

  Changed

  `yokoten doctor` now says which language it found in the tests step, for example "this looks like a Go project". A test run through a virtualenv path, such as `.venv/bin/python -m pytest`, now counts.
- `yokoten init` asks to add a `tests` job for Python, Go, Rust, .NET, Ruby and PHP projects (#550).
- `yokoten init` now adds a SessionStart hook to `.muse/hooks.json`. Muse Code runs `yokoten doctor --session` at the start of a session and shows the next step to the model. An existing file keeps your own hooks. Running `init` again adds the hook only once (#556).
- `yokoten install` now writes the session doctor and the command guard for Muse Code, in its user settings, when its config folder exists. `yokoten doctor` compares them, as it does for Codex, Gemini and Grok (#557).
- The command guard refuses work-losing commands: an `alias`, removing `.git`,
  deleting the default branch (`git branch -D`, `git update-ref -d`,
  `git push --delete`) and piping a download into a shell (`curl ... | sh`).
  Each refusal names the safe way instead (#560).
- The worker mark survives `.git` being moved away: `yokoten worker mark` also keeps the worktree path on a worker list outside the worktree, and `yokoten worker unmark` (lead only) clears it (#566).
- Every pull request body ends with `Made with <agent> (<model)>`, one or more comma-separated pairs, so each one names each AI and model that made it. `check --pr` and `yokoten bot` refuse a body without the line (#570).
- Worker worktrees now live in `.worktrees/<issue>/` inside the project, git-ignored,
  where a restart can't wipe them. `yokoten init` adds `.worktrees/` to `.gitignore`. The
  layout check skips it. The guard reads a path under it from that worktree, so a
  lead-only file there is still lead-only. `doctor` names `.worktrees/` in the fix when a
  worktree sits in a temp folder. The `dispatch` skill makes the worktree there, never
  under `/tmp`, and says workers run on the lead's model unless the owner names
  another (#571).
- `yokoten init` writes the sandbox settings for Claude Code, Codex, Gemini CLI and Grok. `yokoten doctor` checks them in the new `sandbox` step (#589).
- The kit workflows and this repo's own are ready for a merge queue (#590). `yokoten.yml` and `pr.yml` also run on `merge_group`, so a queued merge runs the same required checks as a pull request. A merge group run has no pull request: `yokoten.yml` runs every job in full, and the `pr` job skips, which counts as green for the queue. Turn the queue on in the repo settings.
- `yokoten board` shows the team on a live page on this machine: each agent, each pull request stage, and each worktree. `yokoten board --text` prints the same data as plain text. The printed link holds a random token, and the board answers only its own host, so no other page can read it. The page shows the agents on the left, grouped by issue. The middle shows the picked agent. The right shows the pull requests with their checks. Each agent names its role: engineer, reviewer or verifier (#601).
- Start, watch and stop agents from the board page (#603).
- The bot refuses a comment, a review with a body, or a new issue whose last line is not the `Made with` line (#609).
  A note with `--attach` is refused: the upload lands past the `Made with` line (#609).
- The board shows what each agent used and what it would cost on the vendor's API, read from the session logs already on this machine (#611). Each row is an agent, model and day, with input, cached and output tokens, filtered by role or vendor. A model with no price, or a log without token counts, says "partial". `yokoten board --text` prints the same rows.
- `yokoten bot` refuses `gh pr merge` of a tier A pull request whose newest code-owner review is not an Approve on the head. An Approve counts when its author owns the changed files, read from CODEOWNERS on the base branch; association never counts. A newer changes-requested or dismissed review refuses, and other reviews never count. When the changed files name no owner, any owner named anywhere in CODEOWNERS counts. When the head is newer, the merge goes on only for a clean merge of the base branch with the same own diff. The gate also covers `gh api` merges. `gh pr status` through the bot shows the same check for tier A pull requests (#612).
- A worker can end a task only when the done-when check passes (#614). The stop hook
  runs the brief's command (`YOKOTEN_DONE_WHEN`, or `yokoten-done-when` in the worktree's
  git folder). When the brief has none, it checks the changed files. A failing check
  sends the worker back, up to three times, with the output in short. On the third, the
  hook says the next stop is let through. The worker's message to the lead must start
  with "NOT DONE: checks failing" and quote the output.

  The allowed stop writes `.yokoten-agent.json` in a linked worktree. It sets `checks`
  to `failing`. A pass sets `checks` to `passing`. The main checkout is left unchanged.
  The lead reads that file. The board will show `checks` later (#603). `init` adds the
  file to `.gitignore` when that line is missing. A link at that path is left unchanged.
  A link into another worktree does not change that worktree's file. A file swapped
  for a link is not read. A status file over 64 KiB loses its old fields. When the
  worktree root itself is reached through a link, no status file is written, and the
  stop stays safe.

  A worker type is exactly `worker`, or a name that ends with `:worker`. A name such as
  `code-worker` is not a worker. Re-mark such an agent as `worker`, or use a name that
  ends with `:worker`.

  When the try count cannot be saved, the next stop is let through if `stop_hook_active`
  is set. It is also let through when this same worker was refused in the last 5 minutes.
  That covers a runtime that never sets `stop_hook_active`. A worker is never trapped.
  The count is cleared after a pass and after that stop. Count files older than one day
  are removed when a new count is written. A subagent is checked only when its own type
  is a worker. The parent session's role does not make it one.

  The command uses the platform shell. A timeout stops the command and the programs it
  started. When the shell exits, the check ends on that result. It waits a short time
  for the last output, then drops the pipes. A program that leaves the group does not
  hold the check open. On Windows, yokoten stops the tree while the shell is still running. Claude
  Code (Stop and SubagentStop), Codex (Stop), Muse Code (Stop) and Grok CLI (Stop) each
  wait 600 seconds. Gemini CLI (AfterAgent) reads `timeout` in milliseconds, so its hook
  waits 600000 milliseconds (10 minutes). Muse Code settings hooks, including
  `.muse/hooks.json`, read `timeout` in seconds. That is Muse's documented unit, and the
  1.4.11 build keeps it apart from a plugin hook's `timeoutMs`. DeepSeek Harness and
  Antigravity CLI have no stop hook. The lead runs the check.
- yokoten keeps a stop log on this computer. Each time the tool-call guard stops a call, or the stop check sends an agent back, it writes one line to `~/.config/yokoten/stops.jsonl`: the time in UTC, the agent's runtime, its role, the rule, and the answer (`refused`, `allowed once` or `no answer`). A command is written only after the privacy filter has masked it, and only its first line; an edit writes no path and no file text. The log stays on this computer, and nothing is sent anywhere. It holds at most 5 MB, oldest lines first. The new `yokoten stops` command shows it; `yokoten stops off` stops the writing and deletes the log, and `yokoten stops on` starts it again. `yokoten uninstall` removes the log too (#621).
- Three release channels for the Claude Code plugin and npm (#632). Stable installs the latest release tag and npm `latest`; Beta installs the latest pre-release tag and npm `next`; Dev installs the default branch. `doctor` now names the channel and version it runs, and the release workflow sends a pre-release to npm `next`, never `latest`.
- `yokoten desk <agent> <folder> -- <command>` starts a worker's agent in a fenced desk, the same for Claude Code, Codex (and DeepSeek through it), Grok and Muse Code. The agent writes only in its own clone and the desk's own state folder, which gets only your login file; `.git/config` and `.git/hooks` stay read-only. Your home, other projects and your own agent state (settings, hooks, history, sessions) are hidden. Commands have no network, and only the agent's API hosts pass the proxy. `YOKOTEN_ROLE=worker` and `TZ=UTC` are set, and no token is passed in. Linux and WSL2 use `bwrap`; macOS uses `sandbox-exec` (not yet run on a Mac); native Windows is not built yet (#669). Your private marks stay out of the desk unless you pass `--marks`, so run the commit check outside until #665 (#637).
- `yokoten ci-health` and the `actions-health.yml` workflow watch a repo's Actions: every 30 minutes, one pinned issue, `CI health`, shows failed or cancelled runs on the default branch, failed checks on open pull requests, slow workflows, queue waits, and branches that both passed and failed. The `board` workflow no longer starts a run for each issue event, so a queued run is no longer replaced and shown as cancelled (#647).
- The command guard now stops an agent from cancelling or deleting a GitHub Actions run.
  That is `gh run cancel`, `gh run delete`, and the same call through `gh api` or `yokoten bot`.
  A cancelled run turns a check red and blocks the merge. A deleted log is evidence gone.
  Reading a run still works, and so does `gh run rerun`. Ask the owner to cancel or delete a run on the Actions page (#650).
  A flag's value cannot hide the method, and a `repositories/<id>` path is the same call.
  A path is read with `.` and `..` resolved, and `$1`, `$@` and `$*` count as the repo.
  `gh alias set` and `gh alias import` are refused. Ask the owner to add an alias by hand.
  A cluster of short options in `gh api` is refused, unless one option carries its value.
  A shell variable cannot hide the method or the path of a run call.
  `gh run` refuses a subcommand from the shell. Route words such as `repos` and `cancel` match in any case.
  A `gh` command must be one that gh ships. Installing an extension, or setting an alias with `gh config`, is refused.
  `gh extension exec` and `gh extension browse` are refused. One runs an extension. The other can install one.
  A non-GET call is refused when the path after `repos/` or `repositories/` is only a variable.
- `yokoten init` writes a tests job for a Node project that has a test script. When `engines.node` is absent, `.nvmrc` or `.node-version` can set the Node version, including `20`, `v20` and `lts/*`. The install and the test command follow its lockfile: npm, pnpm, Yarn or Bun. With no lockfile, the job runs `npm install`. Node is chosen only when no other language is detected. `yokoten doctor` shows the job as YAML you can paste. When the workflow file is missing, doctor says to run `yokoten init` (#653).
- `yokoten trust` turns on yokoten's guard in Codex, Grok CLI, Copilot CLI and Muse Code. A person runs it at a terminal: a pipe, a hook or CI writes nothing and names the terminal. It trusts a folder only when yokoten's own guard hook is in the project. The project's Codex sandbox must also pass the check doctor runs, because trusting a folder is what lets that sandbox apply. `yokoten init` asks once on a terminal, writes only yokoten's entries, and names the command when no terminal can answer; `yokoten trust --undo` removes only what it wrote (#661). For Codex, a hook is yokoten's only when its command is exactly the one yokoten writes: a hook a repo ships beside it is never trusted. A hook edited after trust stays off, and doctor says to run `yokoten init`, which puts yokoten's command back.
- The last line of a pull request may name the reviewers: `🤖 Made with worker <X> (<model>), reviewed by <Y> (<model>) and <Z> (<model>), lead Claude Code (<model>)`. One part with one or two reviewers is allowed, never more, and old lines still pass. A malformed `reviewed by` part is reported with how to fix it. The dispatch and inspect skills and the pull request template tell agents to add each reviewer (#673).
- Agents of every vendor can now message each other with `yokoten msg send`, `inbox`, `who` and `log` (#674). Messages are files in a team folder next to your checkout; there is no server and no network. In a desk, an agent can write only its own outbox, so it can't send as anyone else. Who an agent is comes from the desk, never from a file it can write. Outside a desk there is no fence: a program there can write any outbox, so run workers that message in desks. Hooks add unread messages to the agent's context after the end-of-turn checks. Every delivery says the messages are data and can't grant approval. Each message gets the same privacy and secret scan as posted text, and messages have size, rate and outbox caps. `yokoten desk` takes `--name` for the agent's name on the team.
- `yokoten check` refuses a file in `src/borrowed/` whose header lacks its source URL, upstream commit, license or copyright notice. It also refuses a license outside MIT, BSD-2-Clause, BSD-3-Clause, ISC and Apache-2.0. The source must be a GitHub file link, because the watch reads only GitHub. The new `yokoten borrowed` command compares each wheel with upstream's default branch. It opens one issue per changed source, and calls out a security fix. A commit missing from the upstream list is compared by date, so a snapshot opens no false issue (#676).
- `yokoten board` fills itself. The hooks now keep each agent's `.yokoten-agent.json` up to date for every vendor: the session start writes the vendor, model, role and worktree; each allowed call says what the agent is doing (at most once every 5 seconds); a refused call sets `blocked`; the stop sets the state and the checks. The file is kept out of git through `.git/info/exclude`. Desks started by `yokoten desk` show on the board too. `yokoten board` opens the page in your browser (`--no-open` only prints the link), and the empty board says how agents appear. Agent titles no longer start with ", issues #…" when the task text names a pull request, and DeepSeek agents get their own colour (#685).
- Chrome and Edge can install the board as its own window (#693).
  The page links a manifest named "yokoten board".
  The window opens without the browser tabs.
  Use Install in the browser menu.
- `yokoten board` shows the picked agent's own session in the middle column, live, like a chat: what it says, and its tool calls folded into "Ran N steps · the last one". Click a step to see the whole call and its output. The board reads Claude Code, Muse Code and Grok logs, from the agent's worktree, and only the new lines on each read. Every line is masked first: the home folder, email addresses, tokens, keys and your private marks never leave the board. An agent with no log found shows its `doing` steps, as before (#694).
- The board streams a runner's plain text log when it finds no session log (#694).
  The status file may name that log in an optional `log` field.
  The path must resolve inside the worktree or the runtime's log folder.
  Only new lines show, and every line is masked like a session line.
  OpenCode workers use this log until the board can read their sessions.
- An area lead can approve a pull request in its area, when its vendor differs from the writer's. The merge check reads the lead, vendor, model and committed review from the pull request. A hard-line file or a looser change still needs the owner (#699).
- The lead box on the board is a short desk (#701).
  It shows one line of what the lead is doing.
  It shows up to three decisions, with the lead's pick and one-word answers.
  It shows the first sentence of the last reply. Click it to read the rest.
  Picking the lead shows a timeline of the last 24 hours.
  Each bar runs from the start to now, or to the finish.
  The bar uses the vendor's colour and breathes while the work goes on.
  A row says what it waits for, such as after #697.
  The lead writes the desk in `.git/yokoten-lead-desk.json`.
  A bad file is ignored. The words are masked like the session.
- A safe exit for every agent, so no run loops forever (#711). The tool-call guard counts,
  per session, the same refusal for the same command shape and the same failing command.
  At the third repeat the refusal becomes a stop message: stop, go back to your last
  anchor, or write your report. A call that succeeds resets the count. The count lives in
  yokoten's config folder and is never a reason to trap a session.

  A worker records an anchor when its checks pass and its tree is clean. An anchor is a
  commit. `yokoten anchor` lists them, newest first, and says the way back:
  `git switch -c try-2 <commit>`. Nothing is reset or deleted. A second passing check on
  the same clean HEAD says that HEAD is already the anchor. Only a dirty tree asks for a
  checkpoint commit (#792).

  The board stops a worker it starts after three hours unless yokoten.json sets
  `worker.timeLimitMinutes`. The board writes `REPORT-<issue>.md` from the last output
  when the worker wrote none, and shows "stopped by the time limit". The dispatch brief
  now carries the anchors, the stop rules, and the time limit.
- Every brief yokoten hands a worker now names a safe exit: stop after the same step fails three times. It names an anchor: commit after each test you touch passes. A resumed run reads the last commits first, and the board brief names the commit it starts from (#711, #718).
- A `security` label for holes in the guard, the privacy checks and the supply chain; the tier labels now say who approves (#738).
- A desk reads the model and provider an agent's config names, so the session starts with
  one line saying who the agent really is when the model is not the harness's own vendor,
  and the board shows the real model rather than the harness default (#748). A Codex desk
  on a DeepSeek model now tells its agent that Codex is the tool, not its maker.

  `check --pr` also notes a `Made with` line whose worker model is not the one the worker's
  status file on that branch names, so a wrong signature is seen before the pull request
  merges. This note needs the worker's desk, so it runs on the worker's machine, not in CI.
  A desk command's `--model` wins over the config's model, and the team roster and
  `YOKOTEN_MODEL` name the same one.
- `yokoten provenance <ref>` names the writer, reviewers, approver, tier and issue of a commit or a range, in plain text or with `--json` (#756). `check --pr` now checks the Made-with line against the desk status files of the branch, and reports a reviewer from the writer's own vendor, as `pr-provenance`.
- `yokoten learn --export` writes a reviewed lesson as one small JSON file; `yokoten learn --import` shows a lesson from another project and adds it to `lessons/` for review (#757).
- Doctor counts merge commits among the last 200 on the default branch whose author or committer time is not UTC. It prints one command that shows those merges, never a time zone, name or email, and says nothing when all are UTC (#760).
- `yokoten check --anchor` checks each past day of the event log against its hash in Sigstore Rekor, and names the day when the log no longer matches (record 0029, #768).
  Only the day's 64 hex characters leave the machine; the anchor workflow signs them with its own OIDC identity, and there is no new runtime dependency.
- A record lists what each vendor's personal plan allows for shared work, and what its API allows instead. It marks every cell as unread at the source, so no one pitches layer 3 as ready (#772).
- The tool-call guard refuses a `git commit` that adds a secret, a private email address or an IP address, even in a repo with no `yokoten init`: it reads the staged diff as text (binary files too), and with `-a` the tracked changes, and names the file and line, never the secret. A commit whose change it cannot read is refused, never allowed (#824).
- A guard protocol, `yokoten-guard/1`: any agent tool can call `yokoten hook --protocol` and read an allow, a refusal or a question. OpenCode uses it end to end, and a published conformance test checks an integration (#898).
- `yokoten conflicts` says which open changes collide, and what to merge first (#909).
  It reads every open pull request, or every local branch when there is no host.
  It names the pairs that touch one file, and which of the two goes first.
  It checks nothing out and merges nothing, and keeps the map in the git folder.
  The session-start doctor says one line when changes collide or the map is old.
- The guard now stops an edit to a file that another open change is moving or deleting. It names the change to wait for (#911).
  DeepSeek (deepseek-v4.1-flash) made this change.
- `yokoten train --next` says which open pull request to merge next and why. With no pull request numbers, the train takes its queue from the conflict map (#912).
- `yokoten conflicts` now offers a rebuild when a change conflicts with main (#913). It writes a prompt to paste into an AI: keep the old commits as `old-work`, start the branch again from today's main, and make the same change there. The rebuilt branch pushes with `--force-with-lease` on the head it started from, so a branch that moved is refused.
- `yokoten upgrade` brings yokoten itself to the newest version in one command. It updates the Claude Code marketplace, then the plugin, with git told to fetch github.com over HTTPS for those calls. No GitHub SSH key is needed, and it adds or removes nothing (#950).

  `doctor` and the start of a session note when Claude Code fetches the yokoten marketplace over SSH. The fix they name is `npx yokoten@latest upgrade` (#950).

### Changed

- Record 0028 sets the framework above the details: yokoten is a neutral trust layer for AI teams, with three pillars (an open standard, a provenance ledger, a lesson network). The desk becomes the main line of defence and the guard stops mistakes.
- Record 0029 sets how yokoten runs a team: one event log is the source of truth, control loops do what the lead did by hand, and service levels decide priorities.
- Record 0030 sets earned autonomy: each agent gets a level per area, from L0 (a person approves each change) to L4, computed from its record. Levels drop fast and rise slowly.
- Record 0031 protects the owner's attention: one consent agenda a day, a cooling-off period for constitution changes, two keys for releases and money, and no trust carried from one area to another.
- Record 0035: the safeguard is the MVP; other parts wait until it is done.
- Record 0036: many small v0.1.x releases, each needing one approval from the owner.
- The `dispatch` skill asks the lead to name the pull requests from outside accounts in its summary to the owner, even when the count is zero, so spam is seen early and a newcomer's first pull request still gets reviewed (#88).
- The Japanese README names the skills-only install. The Japanese manifesto now says it is a translation and asks for corrections. The guide is translated into Japanese. The stale-translation check reads every Japanese page (#121).
- `init` now writes a `check` workflow that also runs the released yokoten Action,
  `yokoten-labs/yokoten@<commit>`, pinned to the v0.1.0 commit (#129). Dependabot keeps
  the pin current. The project's copy in `.yokoten/` still runs first: it is the same
  yokoten as the commit hook, so a commit made with `--no-verify` meets the same check
  in CI (core rule 6). The action adds a check a pull request cannot edit by changing
  `.yokoten/`. The `pr` and `issue` workflows run the project's copy only.
- Every agent adapter now fills one contract, and the guard asks the adapter table instead of naming a runtime. The guide's "Works with" table is generated from that contract and the dated runs, with a new capabilities column (#395).
- `yokoten bot -- gh pr edit` adds the type label a new title names, and the tier label a new body names. It removes the old tier label only when the new one is in place: added by the command or the bot, or already on the pull request. A tier label the repo does not have is left out, and the old tier label stays. A label you pass is kept (#422). When gh cannot read the pull request's labels, the edit still goes: the new tier label is added, and a note says an older tier label may stay next to it, with `--remove-label` to drop it. Two tier labels fail `check --pr`.
- `yokoten install` keeps a skill or agent you edited, and says where the new copy is. `yokoten uninstall` keeps it too, and `yokoten doctor` names an edited file whose kit copy has changed, with the `diff` command to compare them (#477).

  A file from an older yokoten has no hash, so the next install replaces it once, edit or not. After that it has a hash, and your edits stay.
- The README and its translations now list all eight guarded AI coding agents and mark Gemini CLI as listed but not verified end to end. The guide's agent table is the one list.
- The manifesto and its translations now match the guide's list of eight agents. Gemini CLI is listed, but not verified end to end (#487).
- `yokoten doctor` says why the road's stage jumped. It does so when the stage moves by more than one since the last full run. A line for each passed stage says whether that stage was already in place, or has steps yokoten can't check yet (#514).
- `yokoten install` shows an example when it asks you to type a mark. A new
  private-marks file names the same three kinds: a city, a company domain and
  a server name (#525).
- The `release` skill now reads a project's release docs before it writes the owner's checklist. For a package not yet on npm it lists the publish by hand, npm's "Require two-factor authentication and disallow bypass 2fa tokens" setting, and the trusted publisher timed just before the next release. Record 0009 and `docs/server.md` use the same npm wording (#538).
- The guide explains the review bots beginners see on pull requests: what they do, when they run, and where the two kinds send your code. It says yokoten works before the pull request, alongside a bot, and that yokoten's own review is enough to start. README and its three translations add one line, and PR findings stay yokoten's own (#545).
- A beginner runs `yokoten` once in a project. It installs yokoten when the machine lacks it, adds the rules when the project lacks them, and then shows the next step (#548).
- Full `doctor` says `reading GitHub settings...` on a terminal while the slow reads run. A slow server read stops after about 3 seconds, and the step says why it can't be checked (#561).
- `yokoten board` has a new page. Left: what needs you, then the agents by role. Middle:
  what the picked agent did, step by step. Right: each pull request as Built, Checked,
  You, Merged.

  It works on a phone and speaks English, Simplified Chinese, Traditional Chinese
  and Japanese. It follows dark mode, links to the repo on GitHub, and loads nothing
  from the internet. The status file gains `model`, `effort`, `state` and `checks`, and the
  `lead` and `helper` roles (#603).
- Secret and privacy findings show a sure, likely or unknown grade. An ignore must name the rule and give a reason, and an ignored finding stays in the output. The check also finds the real values of secret-looking environment variables (#616).

  A sure secret or a private-mark hit can be ignored only in `.yokotenignore`, which is now lead-only, never in a comment on its line. `check --pr` shows each ignore a pull request adds as a notice for the reviewer (#616).
- The `dispatch` skill gives every worker a way out. The brief now has a `Stuck:` line: a task that can't be done, or a wrong brief, is a good report, not a failure. A `Your way:` line invites the worker's own approach. After 3 review rounds on one task, the lead stops and rethinks the task. Record 0019 says why (#635).
- `check --pr` notes a long sentence only on a line the pull request adds, so notes about old text no longer bury a problem (#647).
- `yokoten init` leads with the git hook: `git hook: on (the commit check runs from .githooks)`. A trust step prints only when that agent is installed on this machine. Any agent left out is one line, `other agents: see the guide`. The hook files are still written for every agent. When the hook stays off, the first line says why (#654).
- Native Windows still has no worker desk, and the guide and `yokoten desk` now say it is experimental and needs a passed contract test before it starts (#669).
- The board shows Needs you in one place, on the left (#693).
  One pull request or issue is one row.
  A row leaves once that pull request is approved on its latest commit.
  A merged or closed pull request or issue leaves too.
  Claude, Grok, Muse and DeepSeek each show under one name.
  Codex on a DeepSeek model shows as DeepSeek.
- The board shows every agent's session in one shape (#698).
  The agent's words are the main text.
  Each tool is one short line, and a long run of steps folds after three.
  Claude, Grok, Muse and DeepSeek all use that shape.
  DeepSeek is read from its Codex log.
  A Codex shell, patch or search call becomes the same step, and a failed command shows as failed.
  The bottom bar shows how many seats are free, per vendor and in total.
  The seats come from `.git/yokoten-seats.json` when that file exists; without it the bar counts idle agents.
  A vendor with seats but no agent still shows its free seats.
  A vendor's square breathes while one of its agents is working.
  A stopped agent does not keep a seat.
- A refusal now reads the same everywhere, at a tool call and at the end of a turn: `yokoten stopped this: <what> [<rule>]`, then `Why:`, `Do instead:` and `More:`. Only a hook installed as Claude Code's (`--agent claude-code`) gets the deny as JSON on exit 0; every other reader, including a host that runs the shared `.claude/settings.json`, keeps exit 2. On a terminal, `yokoten doctor` and other commands use colour and lined-up columns, and `NO_COLOR` turns the colour off. A command inside a coloured line no longer ends the colour for the rest of the line. The board draws a refusal by the same four parts. `YOKOTEN_HOOK_DENIAL=exit2` keeps the older hook answer. (#707)
- The board starts queued work in dependency order (#709).
  An issue waits until every issue on its "Depends on issue #N" line is closed.
  The next ready issue comes from a priority heap: priority first, then the smallest issue number.
  "Start next" starts the ready issues in that order.
  The agent cap and the memory floor hold a start. The first issue that does not fit stops the list.
  The queue's limits row sets the agent cap and the memory floor in MB.
  The lead view shows the next ready issues, any cycle, and why a start waits.
  A cycle is reported, never followed.
  The longest open chain leads the timeline.
  The board reads one issue past its limit, so a complete list still schedules.
  DeepSeek (deepseek-v4.1-flash) made this change.
- A refusal that would delete the `.git` folder now names only what the command would delete, not why `.git` matters (#707).
  DeepSeek V4.1 Flash made this change.
- Open issues are grouped into lines of work, each led by an area lead and read top first. Record 0038 names the first line, the story (#720): the site, the README, the docs and Japanese.
- Needs you is a bell in the board header (#737).
  The list opens under the bell.
  The left box and the right column are gone, so the session is wider.
  A row leaves when that pull request is approved, merged or closed, while the page stays open.
  A row older than a day says so.
  A new row pulses the badge once.
  Grok 4.7 made this change.
- Record 0034: one safeguard, on by default and the same for everyone. Five things an agent cannot do without you: lose your work, leak a secret, publish, run code from the internet unread, or take the safeguard apart (#816).
- The five safeguards hold in a repo with no `yokoten.json` too: the defaults stop the same
  five things, so a project needs no `init` to be safe. Creating a tag, a hard reset and
  making a repo public are stopped too. The guide says a worker cannot edit CI or the rules,
  and the owner reviews a lead's change to them. A refusal reads in the four parts from
  #707: title, why, do instead, more.
- The guide now names the third way people arrive: `npx skills add` copies the skills alone, and skills alone guard nothing. It says to run `npx yokoten install`, or use the plugin, to turn the guard on (#826).
- The README is short and plain Markdown now, in all four languages, so npm, GitHub and agents show the same page. The top says what yokoten is in one line, then three points and one command to start. Below are what it stops, how it works, the agents it works with, and other ways to install. The sample refusal is the guard's real output. A test keeps HTML out of the READMEs (#832). It replaces the README notes of #618 and the three follow-ups for the headline, the footer and the match with the site.
- In yokoten's own repo, the owner reviews only changes that can loosen the safeguard, publish, or reach a secret (record 0037). Other code changes are tier B: another vendor's agent reviews them, and the lead approves.
- A pull request that changes `kit/` also passes when its body says every project gets the change on its next init.
- `yokoten install` leaves one global entry skill, not seven, and writes nothing global when the Claude Code plugin is on; with the plugin it also takes back the copies an older install left. It prints the files and settings keys it will touch, and `yokoten uninstall` restores the home folder, including the hooks of every agent tool (#904).

  Without the plugin, install still writes the three agents in the global folder, beside the one entry skill. With the plugin on, install writes no guard of its own: the plugin's guard is the one guard. The owner decided both on 2026-10-24. Turn the plugin off or remove it, and the machine is left with no guard at all. `yokoten doctor` and a session start then fail with "no guard for Claude Code", and `yokoten install` writes install's own guard.
- A commit that moves, renames, splits or deletes files waits while another open change moves the same paths. It is refused with that change's name (#910).
- Every command a person runs now colours its marks, headings, refusals and commands at a terminal, and help names each command in cyan (#929).
- A release refusal now says stop and tell the owner: only the owner releases, with the steps in How to release. The approval way moved there (#931). DeepSeek V4.1 Flash made this change.
- `yokoten help`, `yokoten board --help` and the first line `yokoten board` prints say the board is a preview: it may change, and team commands come in v0.1.2 (#933).
- `yokoten help` starts with the first step, then lists the commands in four groups with a heading each: start, every day, a team of agents, and keeping the project healthy (#944).
- `yokoten conflicts` now says the next pick first, then one headed block each for the moves, the colliding pairs and the hot files (#945). Drafts and map notes come last.
- A colour terminal now shows a mark and a word for each state: `✔ done`, `✘ missing`, `● next`, `⚠ note`, `? can't check` (#946). A pipe, a file and an agent keep the word alone, so no old console shows a broken glyph.

  Full doctor now says the stage and the next step first. Each stage, `project` and `machine` gets its own block. The done steps of a stage share one line, except in the stage that holds the next step, where each keeps its own line. Steps and findings that share a reason share one line too (#946). `--json` is unchanged.
- The "Works with" part of every README is a table now: one row per agent, with what is
  verified end to end, whether `npx yokoten trust` is needed first, and the models each
  run used. The first line says any AI model works. A test keeps each README's table and
  its refusal sample equal to the guide's table and the hook's output, so they cannot
  drift by hand again (#960).
- The guide now describes the four-line refusal (`yokoten stopped this:`, `Why:`, `Do instead:`, `More:`) exactly as the hook prints it, in English, Japanese, and Simplified Chinese (#963).

### Fixed

- `yokoten init`, `yokoten doctor` and the hooks setup no longer stop with a RangeError on a very long line of package-runner flags, such as `npx -y -y ... yokoten check`. They now read the flags one word at a time (#431).
- The guard no longer reads a quoted `~` after `cd` as your home folder. Bash keeps `cd "~/x"` as a folder named `~`, so the guard now treats where that `cd` goes as unknown. A worker that writes a lead-only file after such a `cd` is stopped again (#465).
- `yokoten bot --` runs its command with `TZ=UTC`. Then `gh` sends `Time-Zone: UTC`, and the commits GitHub makes, such as a merge, stay on UTC. The tool-call guard trusts `TZ=UTC` next to a post, as an `export` or a prefix. Any other zone or name is still refused (#488).
- A `gh` post through `yokoten bot --` gets your project's privacy allow only from yokoten's own paths. These are a plain `yokoten`, a path such as `bin/yokoten.ts`, or one under `~/`. A path under another user's home (`~other/…`), `~+` or `~-` no longer counts, and neither does a word with `=` or `,`, such as `GH_REPO=x/yokoten`. The guard then checks the post without the allow (#506).
- The privacy check and `yokoten redact` now find a private mark written in another Unicode form: é as one character or as e plus an accent, full-width letters such as `ｓａｍ`, a zero-width space inside or between words, and the Turkish capital İ. Both fold the mark and the text the same way before they match, and redact still replaces the exact place in the original text. Every line the check stopped before is still stopped, and a long run of accents takes linear time (#507).
- `yokoten doctor` now reads the `v*` tag ruleset's bypass list, and the `release` environment's required reviewer and `v*` tag rule. A missing release lock is named with the place to click (#537).

  A bypass counts only on a ruleset that blocks tag creation. Every `v*` ruleset that blocks creation must name Repository admin, because a push meets them all (#850). A bot on a ruleset that blocks no creation is no fault. When you cannot push and a bot can, the line names both. A `v*` branch rule next to the tag rule is caught too.
- `yokoten help` names `yokoten init` again, so a reader who wants the steps instead of the one-command start can find them. The npm package check reads that help line (#548).
- `yokoten` with no command says plainly that the machine has no home folder, instead of an error that named the command `undefined` (#548).
- `yokoten adopt` marks `tests` done only when the project has tests: a test folder, test files for its language, or a test script. A repo with only a project file is missing, and names the command to use once tests exist (#551).
- `yokoten doctor` no longer reports a `kit-workflows` note after you add a job to `.github/workflows/yokoten.yml` the way its tests step says. A job you add under `jobs:`, and its name in the `needs` list of `ci`, stays yours: only the kit's own jobs falling behind says so (#552).
- `yokoten doctor` now shows a step when Muse Code does not trust the folder. This is the `tool-hook` step. It applies when the project has `.muse/hooks.json`. Before, Muse skipped the guard and doctor showed only a note. The step says to run `muse` here and choose "Trust and continue". It also says you can pass `--trust-workspace` to `muse exec` (#554).
- A worker in Muse Code, or in any agent that passes its hooks no `YOKOTEN_ROLE`, is now
  treated as a worker. The lead marks the worker's worktree with the new
  `yokoten worker mark <dir>`, and the `dispatch` skill does it for each worktree. The guard
  reads the mark for every agent, and treats a `.git` link it can't read as marked. For a
  worker, `git push`, `yokoten bot`, `gh pr create`, a write through `gh api` and a
  git alias are refused. So are the plain ways to change the mark. It reads
  text, so the real lock is the server and credentials kept from the worker.
  `git worktree remove` removes the mark with the worktree (#555).
- `yokoten install` now links each skill from the shared folder to Claude Code's copy, instead of writing it twice. Muse reads both folders and warned once per skill. It now sees each skill once. A shared skill folder with your own files in it stays a real folder (#557).
- The doctor note for a folder Muse does not trust now names the headless way too: pass `--trust-workspace` to `muse exec`. It used to name only "Trust and continue" (#557).
- The release refusal for a tag push now names the whole push, remote included: `git push origin v1.2.0 pushes a release tag`. It used to drop the remote. The Muse release refusal no longer mentions `YOKOTEN_ROLE` (#557).
- A worker's relative write after a `cd` the guard can't follow is refused, including `git apply` of a named patch and a `git commit` that takes the staged or all changed files (#559, #465).
- A pull request runs the whole test suite in one macOS job instead of three shards, so the shared macOS runners stay free; the full macOS matrix runs on push to main and once a day. A job that never got a runner is named as such instead of looking like a test failure (#568).
- A test folder counts only when that language's own test files are in the project. An OpenAPI `spec/` folder is not a passing test suite (#576).
  Maven and Gradle count Surefire names such as `TestFoo.java`, `TestFoo.kt` and `FooTestCase.java`. A `Test` prefix counts under `src/test` only.
  Gradle also counts `@Test` and a Kotest `StringSpec` under `src/test`. Maven keeps the Surefire names.
  Rust counts `#[tokio::test]`, `#[async_std::test]` and `#[rstest]`.
  .NET counts a source file that holds a test attribute such as `[Fact]`. The same text in a comment, a string, an indexer or a collection does not count.
- Two linear-time tests no longer fail on a busy runner. The 100k-words guard test and the `normalizeRemote` test now share one call per test. A noisy first round then grows to a steady 20 ms base. A quadratic read still fails (#594).
- Board-started agents are workers, guarded, and honestly modelled (#603).
- A done-when check that exits normally stops programs it left in the background, so a passing check cannot keep writing (#641).
- A refused `.yokoten-agent.json` is left unchanged, and the stop check says why (#642).
- The `pr` check now shows the true result for a pull request as it is now, whatever order its runs start in. In `pr.yml`, `check --pr` reads the title, body, labels and milestone from GitHub when it runs, not from the event. So a run that starts late judges the labels added since, and a rerun judges the pull request again. No pull request run is cancelled or skipped, so a cancelled run no longer shows as a failure, and a skipped run can't hide one. A draft is checked like any pull request. If the read fails, the check fails (#645).
- The linear-time tests no longer fail when a busy test runner pauses them. They now judge how the CPU time of a read grows, not its wall-clock time, and still catch a quadratic read (#648).
- `doctor` now gives a new project one order: make the repo, add the remote, push, then set the CODEOWNERS handle and the labels. The `remote` step counts only branches under `origin`. Its commit advice includes a message and says what `.yokoten/` is. The mailmap note says to run `yokoten install`, which writes the file and points git at it. A new lesson that passes says "a new check ran: ok" (#655).
- A merge to `main` no longer cancels the run before it, so every commit on `main` is tested on its own. Only a push to a pull request cancels the older run (#660).
- `yokoten check` and full `doctor` report a CODEOWNERS line whose path matches no file. A moved or renamed owned path no longer loses its owner review without a word (#667). A line with a class that cannot compile, such as `[z-a]`, is reported like any other stale line instead of stopping the whole check. A backslash before a glob keeps it literal, as on GitHub: `\*` names only the file called `*`.
- `yokoten bot` fetches a missing base commit before it reads CODEOWNERS. When that commit is still missing, it tells the lead to run `git fetch origin` (#670).
- Muse Code in a worker's own `git clone`, such as a desk, now runs as a worker. Muse passes its hooks no `YOKOTEN_ROLE`, and the guard did not read the worker mark in a clone's `.git`, so it saw a lead. `yokoten worker mark <dir>` now also marks a plain clone, except a checkout the lead works in or one with worktrees (#672).

  A worker can no longer drop the mark by removing or replacing the folder that holds `.git` (`rm -rf "$PWD"`, `rsync --delete` into it). A worker can no longer run `yokoten worker mark` either. The lead marks a clone from its own checkout, and a caller's `GIT_DIR` no longer moves the mark into another checkout.

  `yokoten desk` now marks the desk clone as a worker's before it starts the agent, and does not start a desk it can't mark.
- `yokoten board` shows the local agents at once, instead of "Loading" for 5 to 9 seconds after each refresh. gh now reads the pull requests and issues in the background, one read at a time, and the page shows the last lists it read. Until the first read ends, they say "Reading GitHub…". A failed read keeps the last lists and says when they were read. The board also asks GitHub for less: the open pull requests and the last 10 merged, with checks only for the open ones (#688).
- The board groups agents by the work they do (#693).
  A worker shows with the engineers.
  A lead in a desk shows with the project managers.
  A reviewer shows with the reviewers.
  Any other role shows with the helpers.
  Each agent has a friendly name that stays the same.
  The name sits next to the vendor. The task stays on its own line.
  The text board shows that name too.
  The top bar shows the repo's main folder.
- The board hides a home path, an email, a token and a private mark on /data (#693).
  Every string in that payload is masked, including a run's output.
  A quiet agent is idle after 15 minutes, the same window as a live seat.
  A review comment that says request changes stays out of Needs you.
  A later GitHub approval clears an older request-changes comment.
- On a phone the board hides the lead column (#693).
  The agents column stays.
  The lead desk opens under the bell.
  Grok 4.7 made this change.
- The lead box on the board now follows the lead you are talking to (#700).

  A lead session saves the path of its log when it starts. The board reads that path first. The line under the lead is the first line of what it last said. A worker does not save a path. A path that is not a Claude log is ignored. The board then looks in the checkout folder.
- Copilot CLI's user-level guard keeps its exit-2 answer, so a refused call still stops there. Claude Code gets the deny as JSON on exit 0 (#707).
- The guard's worker starts with a dynamic `import('node:module')` instead of `require`, so a guarded call works on Node 26.12.1, which runs that code as an ES module (#707).
- A second `yokoten install`, `yokoten init` or `yokoten uninstall` now says what it kept in plain English, instead of lines like "same the launcher" or "not there the SessionStart doctor" (#719).
- The guard refuses a download piped into a shell, a substitution, or a program word that is not plain text (#734, #745).
- On a phone, the Needs you panel opens under the header across the screen instead of running off the left edge, and a long list keeps its scroll place when the board refreshes (#737).
- An empty or partial `.git` folder no longer counts as a git checkout, so a stray `/tmp/.git` cannot make yokoten think a temp folder is a project. A folder counts only when git would use it: a `HEAD` file whose text is a `ref:` line or a commit sha, plus `objects` and `refs` folders. A worker desk whose `.git` still holds its worker mark fails closed instead (#746). Its own `yokoten-done-when` still runs on stop; the parent's is never used and the stop is never skipped.
- The linear-time tests count the work a scan does. A busy runner can no longer make a linear scan look quadratic. One wall-clock check remains, with room for a slow machine. A quote and a backtick nested too deep are read once (#754).
- The suite's time budget gives a busy CI runner 50% more time for the same work, so a shared runner no longer fails a green suite. The slowest tests are still named, and a new child process per test still fails the child cap (#783).
- A repeated step is counted only when the agent names its session, so sessions in one project no longer add up to a stop (#792).
- A run on `main` is never cancelled, even while it waits: every event other than a pull request gets its own concurrency group (#798).
- `yokoten pr sync` verifies every merge before it pushes and keeps the names each side added to an import list. It leaves a checked-out branch clean when it stops. It runs as UTC, names the base branch it merged, and says when the open list stops at 100 pull requests (#809).
- The guard now refuses `git tag <name>` and `git tag -a/-s` for every agent, not only a tag push: only the owner creates a tag (#812). A listing still passes, combined flags included (`git tag -l`, `git tag -ln`).
- The test helper that starts child programs never uses a shell, so a test value can never run as shell code (#813).
- The tool-call guard asks git for the repository root once, not twice, on an allowed command. Every guarded call is a few milliseconds faster, and the guard's 100 ms budget is unchanged (#821).
- The guard now refuses the other ways an agent could lose your work. That is deleting the checkout (`rm -rf .` or `..`), `git clean`, and `git checkout .` or `git restore .` of the whole tree. It also stops a forced checkout or switch, `git stash clear` and `git stash drop`. It stops `git gc --prune=now` or `--prune=all`, `git prune --expire=now` or `--expire=all`, `git reflog expire`, and `git filter-branch`. It stops moving the default branch with `git update-ref`, `git branch -f` or `git checkout -B`. It reads a shortened option as git does, so `--har` and `--del` are refused too. A repeated option counts by its last value. A path is read as the shell reads it: `src/a/..` is `src`, so it passes. `git restore -S .` passes because it only unstages (#828). A dry run counts only where git reads one: `-e` and `--exclude` take a pattern, so `git clean -fd -e --dry-run` is refused, and the last of `--dry-run` and `--no-dry-run` decides (#847). A force flag inside a combined word counts too, so `git checkout -qf HEAD` and `git switch -qf other` are refused, while `-bname` names a branch. When a forced checkout names a path after `--`, the refusal says that path, not the whole checkout. The run line a tag refusal hands back puts the tag in shell quotes, so a name like `v1$(id)` cannot run anything.
- The guard stops more ways an agent could publish without you: `gh api`, release workflows, `npm version`, `push.followTags`, `git update-ref` tags, `npx` release tools, other code hosts, and package, image and chart tools. A dry run and `--help` still pass (#829).
- The Gitea adapter now reads Gitea's own repository fields, so doctor judges the merge
  settings on a real server. A tag pattern must cover a patch release to count. A missing
  code-owner field is "can't check", not off. A 404 from a later list says which API is
  missing, not that the repo is missing (#849).
- On an older Gitea with no tag protection API, doctor now says the API is missing, not
  that it cannot find the repo (#849).
- Doctor no longer stops when it reads a Gitea server: the tag bypass and the release
  reviewer read as "can't check", with the steps to check them by hand (#849).
- The tests, CI and titles steps read `.gitea/workflows` on every host, so a workflow the
  host never runs made them look done: on GitHub, and on GitLab or a host with no adapter
  too. They now read the folder the host runs: only `.github/workflows`, and both folders
  on Gitea (#849).
- The guard reads the publish path the way the tool does. A query string on a `gh api` path no longer hides a release, tag or public-repo call. A variable owner or repo in a `PATCH` does not hide it either. Creating a repo through `gh api user/repos` or `gh api orgs/<org>/repos` is stopped. So is `gh repo create --public=true`. A GraphQL query the shell builds (`query=$(cat …)`, `query=$QUERY`) is refused like a query read from a file. The last GraphQL field wins, as gh reads it. A release tool keeps its name with a version suffix (`npx semantic-release@latest`). `npm publish --dry-run false` is a publish, not a dry run, and the last dry-run flag decides. `git --git-dir` and `GIT_DIR` no longer hide a pushed tag or `push.followTags` (#865). The last `GIT_DIR` is the repo git reads. A `git push` option that takes a value (`-o`, `--repo`) cannot hide a dry run or a tag. The last of `--dry-run` and `--no-dry-run` decides a push, as git reads it. `/graphql` and a full GraphQL URL are read as GraphQL. A `%` escape in a `gh api` path is read, so an encoded route is the route it spells. A `git push` destination that does not start with `refs/` is judged like the source, so `:v1` and `feature:v1` are refused. The `git update-ref` refusal quotes the tag name, so its line can be pasted.
- With the plugin on, `yokoten install` takes the Claude Code hooks out before it removes the runtime, and keeps the runtime while a hook still runs it: a settings file it cannot read, or a hook of your own that calls yokoten. A link of yours in `~/.agents/skills` under a skill's name stays (#904).
- A session start no longer names the missing Claude Code guard on a machine that
  never set Claude Code up; full `doctor` still lists it with its fix (#904).
- `yokoten ci-health` reads an Actions run page larger than 1 MB again. The `gh` runner asked Node for 16 MB instead of its 1 MB default. A full page of 100 runs no longer fails as if the sign-in were wrong (#916).
- The OpenCode guard no longer refuses every call when OpenCode sends no folder. It uses the folder OpenCode runs in, and still stops a force push.
- The file lease also holds at commit time, so a change made from the shell to a file another pull request is moving waits too. A rebase (a detached HEAD) and a conflict map dated ahead of the clock no longer stop work, and `yokoten conflicts --rebuild` keeps the map as well.
- The tool guard treats `tags/<name>` as a tag, because git resolves it to `refs/tags/<name>`. A delete or a move of a remote tag is now refused (#924).
- The guard reads a very long command that is not a commit again, and does not refuse it. The new commit scan (#824) now skips any command with no `commit` word (#926).
- The UTC refusal and `doctor` give the line for the shell in use, so the first commit works (#932).
- A session start takes back the skill, agent, hook, runtime and launcher copies an older install left, when the yokoten plugin is on. It says what it did in one line (#935).
- CI on macOS no longer fails on a slow runner alone: the lease timing test judges the first of up to three readings that fits, and the whole-suite macOS job gets a 400 s budget (#941, #943).
- The Claude Code plugin installs and updates over HTTPS, so it works on a machine with no GitHub SSH key: each channel in the marketplace names the repo by its https address (#950).
- `gh api -X PUT repos/o/r/actions/workflows/<id>/disable`, in the `repositories/<id>` and shell-variable forms too, is refused with `workflow-disable`, like `gh workflow disable` (#956).
- A tag refusal no longer repeats a tag name with a shell character in it as it is. `git tag v1$(id)` now refuses as `creating the tag 'v1$(id)'`, so a person who copies the line into a shell runs nothing; a plain name like `v1.2.0` prints as it did. The same guard covers the `git tag` and `git update-ref` ways of naming the tag. (#962)
- A file that install or init keeps because you changed it shows as a note (a yellow ⚠ on a colour terminal), not as done: a sandbox file, a kit workflow, an older hooks file, or a git setting of your own.
- The open standard (`docs/standard.md`) again matches the board: a working dot lasts 15 minutes, not 30, the status file has a `started` field, and the code links point at the files the board split into.

### Security

- yokoten now needs Node 22.23.4 or later (24.22.1 on Node 24, 26.12.1 on Node 26). Releases 22.18 to 22.23.3 still run yokoten. But they have the security holes that Node fixed on 2026-10-21, among them TLS hostname checks that the calls to GitHub rely on. npm warns about them at install, and `yokoten doctor` notes an unfixed Node with the version to upgrade to. The kit workflows and the GitHub Action set up `^22.23.4` (#572).
- The guard refuses `find -delete` and `find -exec rm` when a test can name `.git` (#573).
  It also refuses a null-split `xargs` when one word can be `.git`.
- The guard refuses a download piped into `sudo -s`, `sudo -i` or `doas -s`.
  It refuses a shell name in any case, and `wget2`, `aria2c` or `fetch` piped into a shell (#574).
- A worker can no longer clear the worker list to drop its worker role (#591). The worker list and the bot's keys are in yokoten's config folder (`~/.config/yokoten`). The guard refuses a worker's command or edit that changes, moves or removes that folder or a file in it. A folder that holds it counts too, such as `rm -rf ~/.config`. A worker can still read the files there. The lead still marks and unmarks worktrees.

  The guard no longer tries to read every way bash can spell a path. A worker now works in a box:

  - `cd` takes one plain path that stays inside the worker's worktree. `pushd`, `popd`, `cd -P`, `set -P` and `set -o physical` are refused. A plain path has only letters, digits, `.`, `_`, `/`, `-` and a leading `~`. A `cd` in a subshell, a pipe or the background is refused.
  - `$'...'` and `${...@...}` are refused.
  - Settings before a command, after `env`, or in `export` (`NAME=` and `NAME+=`) come from a short list: `TZ`, `CI`, `NODE_ENV`, `NO_COLOR`, `FORCE_COLOR`, `DEBUG`, `LANG` and `LC_ALL`. Options to `env`, `read`, `printf -v` and `eval` are refused.
  - git takes no option before its subcommand (`--no-pager` is fine). `git config` only reads, and `--output` is refused.
  - `less` and `file` may not write a file (`less -o`, `--log-file`, `file -C`).
  - `alias` definitions are refused, and so is a `find -L` that changes files or runs a program.
  - A command that does more than read may not name a path that is or holds the config folder. The guard resolves each path word the way the kernel does: one part at a time, following a symlink before a later `..`. So `link/../yokoten` counts. It expands globs itself (`l*/workers`, `*/*`, `link/../*/*`). It reads an attached short-option value (`-olink/workers`, `-Clink`) and `$PWD`. A part it can't read (`$x`, `$(...)`) may be empty or any name, so it counts when any name in its place reaches the folder. It refuses `~name` and the paths `/proc/self`, `/proc/<id>/cwd`, `/proc/<id>/root`, `/proc/<id>/fd` and `/dev/fd`.
  - Any worker command is refused if it uses the directory stack (`~0`, `~+N`, `~-`, `$OLDPWD`).
  - A worker may not make a link into the config folder with `ln -s` or `cp -s`.
  - A recursive writer (`-r`, `-a`, rsync `-K`) may not run over a folder that holds such a link, up to 6 folders deep.
  - Also refused: a symlink-following read (`find -L`, `grep -R`, `ls -L`) piped into `xargs`, `alias`, `hash -p`, and `enable` with an option.
  - `chmod`, `chown` and `chgrp` may not take `-L` or `-H`.
  - A command that names the home config folder, a glob such as `~/.c*/yokoten` too, passes only when every program in it only reads. A repo's own `.config/` folder is not the home one.

  Known limits: the guard reads command text only.

  - A script the worker writes and then runs (`node x.mjs`) is out of its reach. So is inline code, such as `node -e`, `awk`, or a `sed` script with `w`.
  - A program the worker runs (`npm test`, a build tool) can follow links on its own.
  - Links that come inside an archive or a patch (`tar -x`, `unzip`, `git apply`) are not checked.
  - The folder scan stops after 6 folders deep or 5,000 entries, and skips `.git` and `node_modules`.
  - The guard errs toward refusing. In a worktree that holds a link into the config folder, a path with a `$x` part is refused. A message such as `-m "~wip"` is refused too.

  The real lock is the operating system sandbox (issue #589).
- yokoten now prepares a clean environment for the agents it will start: the names every program needs, never your tokens or keys. A runtime names its own login variable, and only its agent gets it. `yokoten worker env` (not `doctor`) lists the names an agent would get, never the values. No command starts an agent with it yet: the board's "start an agent" (#603) will be the first (#613).
- `YOKOTEN_PRIVATE_MARKS` can no longer turn the privacy check off. Before, it replaced your private-marks file, so pointing it at an empty file left no marks to check. Now yokoten reads both your own file in `~/.config/yokoten` and the file the setting names, and checks for every mark in them. When your own file is there but can't be read, the commit check stops, whatever the setting says. The file that lets a mark through in one repo, `private-marks-allow.json`, is now read only from `~/.config/yokoten`, so the setting can't bring its own. `yokoten adopt` no longer sends its draft prompt when a marks file can't be read. `yokoten doctor` now says the file can't be read instead of calling it missing (#656).
- Agents can no longer get past the commit check or the privacy check with a shell trick. The guard now refuses a command that changes the home folder (`HOME` or `USERPROFILE`) for git, gh, yokoten or a shell. Another home has no private marks, so the check lets everything through (#664). Before other programs it still passes, so `HOME=$(mktemp -d) npm test` works. It also refuses a shell write to `.git/config`, `.git/hooks` or `.githooks`, such as `>>`, `cp`, `sed -i`, `rm`, `chmod -x`, `patch` or `vim`. It refuses the `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM` and `GIT_CONFIG_COUNT`/`KEY`/`VALUE` settings too. Each of these can turn the commit check off (#361). Reading these files and `$HOME` still works. For one setting in one command, use `git -c <name>=<value>`.
- An agent can no longer take gh's token and call GitHub around the guard. For the lead and every worker, the guard now refuses the gh commands that print the token, such as `gh auth token` and `gh auth status --show-token`. The places a login is kept are refused too: `git credential fill`, a credential helper's `get`, `~/.git-credentials`, gh's `hosts.yml` and the system keychain. So is a command that expands `$GH_TOKEN`, `$GITHUB_TOKEN` or the enterprise names, in bash, PowerShell or cmd. Programs that run code, such as `node` and `python`, are refused when the command names one. `GIT_TRACE_REDACT=0` is refused, and the bot's git takes no `-c` or git settings from the environment. The bot no longer passes a pager, editor, browser, ssh program or trace setting on to gh and git. `gh auth status`, `gh pr view` and `curl https://example.com` still pass (#668). `gh workflow disable` is refused for every agent: only the owner turns a workflow off (#668). The privacy check of what gh posts can no longer be skipped by an option value that looks like another option, such as `gh api … -q -XGET -f body=…` (#659).
- `yokoten bot` no longer reads a later CODEOWNERS file when an earlier place fails or is over 64 KiB. Only a real HTTP 404 moves on to the next place. Any other failure refuses the merge (#670).
- `doctor` and `doctor --session` now note when this project has `.muse/hooks.json` and `~/.claude/CLAUDE.md` is visible in your home folder. Outside a desk, Muse can send that file to Muse's model. Run Muse in a desk (`yokoten desk muse`) so the home folder stays hidden. When the session is already in a desk and that file is still visible, the note changes. It says the home folder is visible and the desk needs attention (#681).
- The board page is at `http://<repo>.localhost:<port>/` (#693).
  `<repo>` is the folder name, made safe for a hostname.
  The port stays the same for this repo.
  The first visit uses `?token=` and sets an HttpOnly Secure cookie.
  That visit then opens the page without the token.
  Later visits use the cookie.
  A wrong host, a missing cookie or a wrong cookie is refused.
- A plugin update applies on the next tool call. A guard which cannot be found refuses the call. The hook command is one short line. If that plugin folder is removed during a session, the tool call is refused and asks for a restart. A session which still has the old hook command needs one restart. Doctor's update note says the same. The launcher reads the account home from the password file, so a project setting for HOME cannot choose the plugin copy. A cache segment that contains a colon, or a Windows device name, is refused. A drive letter at the start of a Windows cache path is allowed. A launch with no real exit status refuses the tool call. The session fallback must stay inside its plugin folder (#706).
- A worker can no longer point `HOME`, `USERPROFILE` or `XDG_CONFIG_HOME` at another folder before `git commit`, `yokoten check`, or a shell. `env` and `export` count too. Another home has no private marks, so the check would pass (#739).

  When the marks file under `$HOME` is missing, or it holds no marks, the check reads the one in the real home. The real home comes from the password database. A missing file there is not an error. A file it cannot read stops the check. A file it can read is used.

  A worker cannot run a shell script from a file, such as `bash script` or `sh script`. The guard cannot read that file, so it refuses. `bash -c` stays allowed. The script text is in the command.

  Unsetting `HOME` or `USERPROFILE` is refused. So is `env -u HOME` before git, gh, yokoten or a shell. A worker cannot unset those names, or `XDG_CONFIG_HOME`, before the commit check.

  With no `HOME`, the check still reads the marks file in the real home.

  For the lead, `HOME` before another program still passes, and so does `XDG_CONFIG_HOME`. `env -u HOME npm test` still passes.
- The guard refuses a `find` that deletes when nothing keeps it out of `.git` (#744).
  A prune of `.git`, an exclusion of its files, or a start folder that cannot hold it still passes.
  A delete whose characters name git storage, but match no sample, is refused too.
  That covers a loose object, a pack index, and a ref other than the samples.
- The guard refuses a download piped into a program named by a variable, or into `eval`.
  `curl … | jq "$filter"` still passes, because the variable is only an argument (#745).
- OpenCode now gets the same tool-call guard as the other agents (#767).
  `init` writes `.opencode/plugins/yokoten.ts`.
  `install` writes the user plugin when `~/.config/opencode` exists, or `$XDG_CONFIG_HOME/opencode` when that is set.
  OpenCode 2 denies the call in the permission hook, and throws from the shell hook as a backup.
  OpenCode 1 still throws from `tool.execute.before`.
  The plugin refuses the call when the guard fails or times out.
  It also refuses a call that is not read-only when it cannot read a command or a path.
  OpenCode 1 reads command and code on every tool, and path or file_path on a write.
  An unknown action is refused when any command field is refused, including code beside a file name.
  `doctor` notes a project that has OpenCode and no plugin.
- An agent can read with `gh api` but cannot change repository or organization settings with it.
  That covers the repo's visibility and default branch, branch protection and rulesets, who reaches the code, CI secrets and runners, an environment, and an organization. Actions, Dependabot and Codespaces secrets count as CI secrets. A `gh api graphql` mutation is refused too, wherever it sits in the document. The release check refuses any document with the word `mutation`, so post a comment with `gh pr comment` or the REST route. A document the guard cannot read is refused as well, and so is any `$` in it. The owner makes the change (#825).
- The guard now refuses a download that a program would run without a pipe (#830). It reads a pipe across a line break, even with a comment between the two sides. It reads a download in `$(…)` or a backtick where a command goes. It reads a download handed to a shell, `eval`, an interpreter or `make`. A pipe into an interpreter is refused when the interpreter reads its program from input: `python3 -`, `node`, `perl`, `ruby`, `php`, `lua` or `Rscript -`. A path that names the same input counts in any spelling: `//dev/stdin`, `/dev/./stdin` and `/proc/self/fd//0`. A `-` after a script file is that script's argument, not the program, so that pipe passes. A pipe into `make -f -` or `make -f /dev/stdin` is refused. So is a pipe into a small shell a minimal image ships: `ash`, `mksh`, `pdksh`, `yash`, `posh`, `oksh`, `rbash` or `toybox sh`. A download beside a substitution still passes. An interpreter that only prints its version still passes: `perl -v` and `python3 --version`, but not `python3 -v`, which still runs the program. A refusal names the download but never the credentials, a query value or a fragment in its URL, so a token stays private.
- The tool-call guard now stops a command that asks for root. That is `sudo`, `doas`, `su`, `pkexec`, `runas` and `Start-Process -Verb RunAs`. It does this for every person and every agent, with no setting.

  It stops a recursive delete, and a recursive mode or owner change, on `/`, the home folder or a top-level system folder. That covers `rm -r`, `rmdir`, `find` with `-delete` or `-exec`, `Remove-Item -Recurse`, `rd /s`, `del /s`, `erase /s`, `chmod -R` and `chown -R`. A glob over one of them counts too. The folder the command runs in counts as the project, so `rm -rf dist` passes at `/app` as it does deeper down. A target the guard cannot read is refused too. A `$(pwd)` form counts as one it cannot read, so name the folder with a plain path. A target that arrives on stdin (`echo dist | xargs rm -rf`) is not read, and stays allowed.

  It stops disk commands too: `mkfs*`, `wipefs`, `fdisk`, `parted`, `diskutil`, `hdparm`, `sgdisk`, `nvme`, `blkdiscard`, and `shred` onto a disk. It stops `dd` into `/dev`, a redirect into `/dev`, `format` and `diskpart`. A disk tool is refused even when it only reads, such as `diskutil list`.

  The wipe and disk refusals say: tell the owner, who runs what needs root or touches a disk. A rule that names an exact case may answer first (#969, by GLM glm-5.3-flash, fixes by DeepSeek deepseek-v4.1-flash).

### Internal

- Split the guard rules into topic modules, with no change in behaviour (#626).
- Split `doctor` into topic modules under `src/setup/doctor/`, with no change in behaviour (#629).
- The guard compiles a list of protected-path globs once and reads it in one pass, instead of compiling every glob on every ask (#710). The guard keeps its per-word Sets: at every list size measured, a Set beat a trie and Aho-Corasick (scripts/time/guard-words.ts).
- The secret scan now finds fixed token prefixes in one pass, then runs only the patterns that may match (#710).
- The privacy rule now lives in `src/rules/privacy/`, one folder per topic: `home.ts` and `marks.ts` leave `privacy.ts`, and `secrets.ts` moves in (#715). The rule itself does not change.
- The Gitea adapter's doctor test reads the host it checks from the host under test, not
  from a URL literal. Code scanning read the literal in `includes` as a URL check and
  raised `js/incomplete-url-substring-sanitization`; the assertion still says the same
  thing (#849).
- A workflow folder is now read directly, in a `try`, so a check-then-read cannot race
  with a folder that goes away; an absent folder reads as no workflow file, as before
  (#849). A remote's owner and name are cut from the path instead of chained replaces, and
  a host named `__proto__` reads as "this host", not a key from the label table. The Gitea
  adapter's test token is built at run time, so the test file holds no key-shaped string
  for code scanning to flag.
- The Gitea adapter builds every read from a literal `https://` and the host it read, so
  no address it asks for can be plain http. A path that would move the read to another
  server is refused (#849).
- The Gitea adapter matches branch and tag patterns by walking the strings, not by
  building a regular expression from a server's pattern. Code scanning flagged the
  older form, which could backtrack for a long time (#849).
- The Gitea adapter sends its token only over https. The check sits beside the fetch as
  well as before the read. A read must also stay on the server's origin, so a plain-http
  address or a path that points elsewhere never carries the token (#849).
- The plugin hooks test now runs the copy in this checkout, even on a machine with an
  installed yokoten plugin (#902). The test adds `--account-home <folder>` to the hook
  command it writes, and the launcher reads that flag from its own command line. No
  environment variable names the account home, so a session's environment cannot move
  which plugin copy the hook runs. `HOME` alone still never moves the lookup.

## [0.1.0] - 2026-10-21

The first release. yokoten guides you through a good team's habits, and guards your AI agents while you learn.
To start, read the [guide](https://github.com/yokoten-labs/yokoten/blob/v0.1.0/docs/guide.md).
The README is also in [中文](https://github.com/yokoten-labs/yokoten/blob/v0.1.0/docs/i18n/zh-CN/README.md), [繁體中文](https://github.com/yokoten-labs/yokoten/blob/v0.1.0/docs/i18n/zh-TW/README.md) and [日本語](https://github.com/yokoten-labs/yokoten/blob/v0.1.0/docs/i18n/ja/README.md).

### Added

**Stop risky agent actions**

- A guard checks each command and edit before it runs, and tells the agent why it stopped it.
- It stops release tag pushes, publish commands, force pushes and skipped commit checks.
- An agent fixing a bug can't edit the tests; a worker agent can't change the rules or CI, even from the shell.
- A project can block any program in `yokoten.json`, with its own reason.
- It runs in Claude Code, Codex, GitHub Copilot CLI, Antigravity CLI, Muse Code, DeepSeek Harness and Grok CLI.
- In Claude Code, Codex, Muse Code and Grok CLI, an agent must fix problems in its changed files before its turn ends.
- Agents see command output with your name, email, secrets and private hosts hidden by `yokoten redact`.
- The hooks start fast, and CI fails when one goes over its time budget.

**Check every commit**

- `yokoten check` runs before each commit and in CI, so a bad commit stops whoever made it.
- It catches personal emails, IP addresses and secrets, and names the file and line, never the text.
- When it stops a commit, it says how to take the stopped files out of it.
- A staged `node_modules` or other dependency folder is one finding, with the command that takes it out.
- Add your own private words, such as your name or city, to a list kept outside the repo.
- `yokoten install` adds your git name, git email and forge login to that list for you.
- `yokoten marks` counts your private words, and lets you add, remove or turn off a kind.
- A private word is found as a whole word, so `sam` stops `hi Sam` but not `sample`.
- A stopped line names the kind of private word, never the word, and how to let it through.
- A project can let its own name, public email or a mark through, in `yokoten.json` or on your machine only.
- `yokoten check --history` checks every old commit before a private repo goes public.

**Stop private details in what agents post**

- The guard runs the same checks on issues, pull requests, comments and release notes an agent posts with `gh`.
- It reads inline text, body files and heredocs, and refuses a body file it can't be sure of, with the reason.
- A read-only pipe after a post, such as `| tail -2`, is fine: the body is still checked.
- `yokoten bot -- gh pr create` checks the body before sending, adds the type and tier labels, and takes the linked issue's milestone.

**Know where you stand**

- `yokoten doctor` shows five stages, from a safety net to going public, and your one next step.
- Each new agent session hears that next step and why it matters.
- With the GitHub CLI (`gh`), `doctor` also reads your GitHub settings: branch rules, required reviews and security switches.
- On Gitea, GitLab and other hosts, `doctor` says which steps it can't check and what each asks.
- `doctor` names one way to run yokoten in every line, and each message tells you what to type next.
- `doctor` lists work that exists only on this machine, a low disk, and old temp folders, and only reads.
- `yokoten explain <id>` says what a rule means, and most problems link to the guide.

**Set up a project**

- Install yokoten as a Claude Code plugin, with `npx yokoten install`, or from a clone.
- `yokoten install` puts a `yokoten` command on your PATH, and `yokoten uninstall` removes it.
- `yokoten init` adds the rules, hooks, CI and templates to a project, and never overwrites your files.
- `init` keeps a project's own `AGENTS.md` and moves it under the core rules.
- `init` adds your package managers' folders, such as `node_modules/`, to `.gitignore`, and only adds missing lines.
- `init` updates a CI workflow you never changed, and keeps one you did.
- `init` writes a Dependabot config for your project's own packages, and a short CI for docs-only pull requests.
- A private repo can skip CI with `init --no-ci`.
- `yokoten adopt` drafts a plan for an older project: what it does today, and what to add.
- `yokoten update` brings a project's rules up to date with your yokoten.

**Learn from mistakes**

- `yokoten learn <issue>` turns an incident report into a draft check for a person to review.
- A reviewed check ships with yokoten, and `doctor` runs it in every project.
- `yokoten learn --upstream` keeps a note about a gap in yokoten itself, with your details hidden.

**Work with a team of agents**

- You talk to one lead agent; it hands each task to a worker agent in its own folder.
- Skills help agents hand out tasks, review changes, find root causes, record decisions and prepare releases.
- `yokoten bot` opens pull requests as a GitHub App, so you review work you did not write.

**Check pull requests in CI**

- Use yokoten as a GitHub Action: `uses: yokoten-labs/yokoten@<commit SHA>`.
- `yokoten check --pr` checks each pull request's title, description, linked issue and changelog entry.
- Problems show on the changed lines of the pull request, with how to fix them.
- A translation is flagged when only the English changed; a newer CI run on main cancels the older one.

[Unreleased]: https://github.com/yokoten-labs/yokoten/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/yokoten-labs/yokoten/releases/tag/v0.1.0
