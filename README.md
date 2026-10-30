# yokoten · 横展

[![npm](https://img.shields.io/npm/v/yokoten?logo=npm)](https://www.npmjs.com/package/yokoten)
[![ci](https://github.com/yokoten-labs/yokoten/actions/workflows/yokoten.yml/badge.svg)](https://github.com/yokoten-labs/yokoten/actions/workflows/yokoten.yml)
[![license](https://img.shields.io/badge/license-MIT-blue)](https://github.com/yokoten-labs/yokoten/blob/main/LICENSE)
[![Node](https://img.shields.io/badge/Node-%E2%89%A522.23.4-5FA04E?logo=nodedotjs&logoColor=white)](https://nodejs.org/)

yokoten stops your AI coding agent from making the mistake you can't undo.

One command, no setup.

[yokoten.app](https://yokoten.app/?from=github) · English · [简体中文](https://github.com/yokoten-labs/yokoten/blob/main/docs/i18n/zh-CN/README.md) · [繁體中文](https://github.com/yokoten-labs/yokoten/blob/main/docs/i18n/zh-TW/README.md) · [日本語](https://github.com/yokoten-labs/yokoten/blob/main/docs/i18n/ja/README.md)

## Start

You need [Node](https://nodejs.org/) 22.23.4 or later. Then run:

```sh
cd your-project
npx yokoten
```

That's it: one command, nothing to set. Run it again any time; it does only what is still missing.

The first run shows one screen: what it set up, where you are, and the next command.

<!-- The first run in a new repo; regenerate it when the screen changes. -->
```text
yokoten 0.2.0 · set up; stage 1 of 5, safety net

  ok           guard on for Claude Code on this computer
  ok           37 files written in this project, none of yours changed

  MISSING      ~/.config/yokoten/private-marks is missing or has no marks
               Type your name, your city or a domain; it is not shown.
               Fix: `npx yokoten marks add`

  done         12 of 26 steps
  next         Run your tests on every push
  to do        Put the project on GitHub or Gitea
  to do        Name the owner (CODEOWNERS)
  to do        Set up the bot account
  to do        Add a license and a security policy
  can't check  9 steps: they read the code host; doctor checks them after a push

  note         16 uncommitted files, the oldest changed 1 minute ago

Next: `git add -A && git commit -m "chore: add yokoten"`
More: `npx yokoten doctor --all` shows every check and 5 notes
```

## What it stops

| It protects | It stops |
|---|---|
| Your work | a force push, a hard reset, deleting `.git` |
| Your secrets | a commit that adds a key, a private email or an IP address |
| Your releases | a new tag, a package publish, making a repo public |
| The code you run | a download that runs before anyone reads it |
| The guard itself | skipping the commit check, or switching it off |

When it stops something, it says why and what to do instead:

```
yokoten stopped this: git push origin v1.2.0 pushes a release tag [release]

  Why       Only the owner decides when to release.

  Instead   Stop and tell the owner: only the owner releases, with the steps in
            How to release; do not look for another way.

  More      https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#how-to-release
```

## How it works

- **A program, not an AI.** The same command always gets the same answer, in under a fifth of a second, at no cost.
- **Three places.** Your AI tool asks yokoten before each command or edit; yokoten also checks each commit and runs in CI.
- **Leaves your settings alone.** It keeps your choices, and saves a copy before it changes a file of yours.
- **Many AI sessions in one repo.** `yokoten conflicts` says which open change to merge first, and the guard stops an edit to a file another open change is moving.

## The commands

You need one command to start. Four more help along the way.

| Command | What it does |
|---|---|
| `npx yokoten` | sets up what is missing, then shows the next step |
| `yokoten check` | looks for secrets and broken rules before a commit |
| `yokoten desk` | gives one task to one AI, in its own desk |
| `yokoten kanban` | shows the team at a glance (preview) |
| `yokoten tidy` | lists old branches, worktrees and desks |

`yokoten help --all` lists the rest, in groups by job: Start, Work, Guard, Merge and CI, Maintain.

## Works with

Any AI model works. The guard checks the commands the agent runs, not the model.

- **Agents**: the guard runs with each agent below. The [agent table](https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#works-with) in the guide holds the evidence: the date, how each run went, and what to know first.
- **Trust first**: `yes` means you run `npx yokoten trust` once in the folder, so the agent runs the guard.

| Agent | Verified end to end | Trust first | Models tested |
|---|---|---|---|
| Claude&nbsp;Code | ✅ yes | no | `deepseek-flash` |
| GitHub&nbsp;Copilot&nbsp;CLI | ✅ yes | yes | `gpt-6-luna` (Auto) |
| Antigravity&nbsp;CLI | ✅ yes | no | `gemini-3.8-flash-high` |
| Codex&nbsp;CLI | ✅ yes | yes | `deepseek-flash` |
| Muse&nbsp;Code | ✅ yes | yes | `muse-spark-1.3-contributor` |
| DeepSeek&nbsp;Harness | ✅ yes | no | the default DeepSeek model |
| Grok&nbsp;CLI | ✅ yes | yes | the default model |
| Gemini&nbsp;CLI | not yet | no | — |
| OpenCode | ✅ yes | no | `opencode-go/deepseek-v4.1-flash`, `opencode-go/glm-5.3-flash` |

- **Programming languages**: any. `doctor` finds the test command for JavaScript, TypeScript, Python, Go, Rust, Java, .NET, Ruby, PHP, Swift, Elixir, Dart and `make test`.
- **Platforms**: Linux, macOS and WSL. Native Windows is in beta, in Git Bash and PowerShell 7.

## More ways to install

`npx yokoten` runs all three for you. Each one still runs alone:

```sh
npx yokoten install     # once per computer
npx yokoten init        # once per project
npx yokoten doctor      # where you are, and the one next step
```

- **Claude Code plugin**: `/plugin marketplace add https://github.com/yokoten-labs/yokoten.git`, then `/plugin install yokoten@yokoten`. Use the plugin or `npx`, not both.
- **Versions**: Stable (the default), Beta or Dev; see [which version to install](https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#which-version-to-install).
- **CI only**: [use it as a GitHub Action](https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#use-it-as-a-github-action).
- **Node**: 22.23.4+, 24.22.1+ or 26.12.1+.
- **UTC**: the commit check asks for UTC commit times. `npx yokoten doctor` names the line for your shell.

## Roadmap

- **Done, v0.1.2**: five commands up front, `yokoten`, `check`, `desk`, `kanban` and `tidy`; another model than the writer reviews each change.
- **Now, v0.2.0**: `doctor --files` reads only the files in a project, so a web page can show its road; a review ends in three rounds.
- **Later**: a lesson one project learns becomes a check for every project.

*Yokoten* (横展) is a word from Toyota's factories: a fix that one line finds goes to every line.

## Learn more

[The guide](https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md) · [The standard](https://github.com/yokoten-labs/yokoten/blob/main/docs/standard.md) · [Decisions](https://github.com/yokoten-labs/yokoten/tree/main/docs/records) · [Changelog](https://github.com/yokoten-labs/yokoten/blob/main/CHANGELOG.md) · [Milestones](https://github.com/yokoten-labs/yokoten/milestones) · [Contributing](https://github.com/yokoten-labs/yokoten/blob/main/CONTRIBUTING.md) · [Security](https://github.com/yokoten-labs/yokoten/blob/main/SECURITY.md)

MIT license. Built by [coolwhite](https://coolwhite.us/) and a team of AI agents.
