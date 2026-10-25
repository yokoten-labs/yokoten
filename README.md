# yokoten · 横展

A safety guard for AI coding tools.

AI agents can make a big mistake in a second. yokoten stops it before it happens.

- **Stops dangerous actions**: a force push, deleting your work, leaking a secret, releasing without you.
- **Works inside the tools you already use**: Claude Code, Codex, Copilot CLI, Muse Code and more.
- **On by default.** One command to start, nothing new to learn.
- **Leaves your settings alone**: it keeps the choices you made, and saves a copy before it changes a file of yours.
- **Works on Linux, Windows and macOS.** On Windows, WSL is fully supported. Native Windows is in beta, in Git Bash and PowerShell 7.

[yokoten.app](https://yokoten.app/?from=github) · English · [简体中文](https://github.com/yokoten-labs/yokoten/blob/main/docs/i18n/zh-CN/README.md) · [繁體中文](https://github.com/yokoten-labs/yokoten/blob/main/docs/i18n/zh-TW/README.md) · [日本語](https://github.com/yokoten-labs/yokoten/blob/main/docs/i18n/ja/README.md)

## Start

You need [Node](https://nodejs.org/) 22.23.4 or later. Then run:

```sh
cd your-project
npx yokoten
```

That's it. Run it again any time: it does only what is still missing.

The first run shows one screen: what it set up, where you are, and the one command to type next.

<!-- The first run in a new repo, from `yokoten` 0.1.1; regenerate it when the screen changes. -->
```text
yokoten 0.1.1 · set up; stage 1 of 5, safety net

  ok          computer    guard on for Claude Code
  ok          project     18 files written, none of yours changed
  done        12 of 26 steps
  MISSING     ~/.config/yokoten/private-marks is missing or has no marks; run
              `npx yokoten marks add` and type your name, your city or a domain;
              it is not shown
  next        Run your tests on every push
  to do       Put the project on GitHub or Gitea
  to do       Name the owner (CODEOWNERS)
  to do       Set up the bot account
  to do       Add a license and a security policy
  can't check 9 steps read the code host; doctor checks them after a push
  note        this project has 16 uncommitted files, the oldest changed 1 minute
              ago

Next: `git add -A && git commit -m "chore: add yokoten"`
More: `yokoten doctor --all` shows every check and 5 notes
```

## What you see

An agent tries something risky. yokoten stops it and says what to do instead:

```
yokoten stopped this: git push origin v1.2.0 pushes a release tag [release]

  Why       Only the owner decides when to release.
  Instead   Stop and tell the owner: only the owner releases, with the steps in How to release; do not look for another way.
  More      https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#how-to-release
```

## What it stops

yokoten protects five things. All five are on in every project after `npx yokoten`, with nothing to set.

- **Your work**: a force push, a hard reset, deleting `.git`, and other ways to lose work.
- **Your secrets**: a commit that adds a key, a private email or an IP address.
- **Your releases**: a new tag, a package publish, or making a repo public. Only you decide when to release.
- **The code you run**: a download that a program would run before anyone reads it.
- **The guard itself**: skipping the commit check, or switching it off.

## How it works

yokoten is a program, not an AI. The same command always gets the same answer, in under
a fifth of a second, at no cost. Before each command or edit, your AI tool asks yokoten. yokoten also
checks each commit and runs in CI, so a bad change is stopped even when no agent is involved.

New in v0.1.1: when several AI sessions work in one repo, `yokoten conflicts` shows which
open pull requests touch the same files and which to merge first. The guard stops an edit
to a file that another open change is moving.

## Works with

Any AI model works. The guard checks the commands the agent runs, not the model.

- **Agents**: the guard runs with each agent below. The [agent table](https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#works-with) in the guide holds the evidence: the date, how each run went, and what to know first.

| Agent | Verified end to end | Needs `npx yokoten trust` first | Models tested |
|---|---|---|---|
| Claude Code | ✅ yes | no | `deepseek-flash` |
| GitHub Copilot CLI | ✅ yes | yes | `gpt-6-luna` (Auto) |
| Antigravity CLI (`agy`) | ✅ yes | no | `gemini-3.8-flash-high` |
| Codex CLI | ✅ yes | yes | `deepseek-flash` |
| Muse Code | ✅ yes | yes | `muse-spark-1.3-contributor` |
| DeepSeek Harness (`dsh`) | ✅ yes | no | the default DeepSeek model |
| Grok CLI (`grok`) | ✅ yes | yes | the default model |
| Gemini CLI | not yet | no | — |
| OpenCode | ✅ yes | no | `opencode-go/deepseek-v4.1-flash`, `opencode-go/glm-5.3-flash` |

- **Programming languages**: any. `doctor` finds the test command for JavaScript, TypeScript, Python, Go, Rust, Java, .NET, Ruby, PHP, Swift, Elixir, Dart and `make test`.

## More ways to install

```sh
npx yokoten install     # once per computer
npx yokoten init        # once per project
npx yokoten doctor      # where you are, and the one next step
```

- **Claude Code plugin**: `/plugin marketplace add https://github.com/yokoten-labs/yokoten.git` (HTTPS, so no SSH key is needed), then `/plugin install yokoten@yokoten`. Use the plugin or `npx`, not both.
- **Versions**: Stable (the default), Beta or Dev. See [which version to install](https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#which-version-to-install).
- **CI only**: [use it as a GitHub Action](https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#use-it-as-a-github-action).
- **Node**: 22.23.4 or later, 24.22.1 or later on Node 24, 26.12.1 or later on Node 26.
- **UTC**: the commit check asks for UTC commit times. Set it once: `export TZ=UTC` in your shell profile, or `$env:TZ = "UTC"` in `$PROFILE` in PowerShell. `npx yokoten doctor` names the line for your shell.
- `npx skills add yokoten-labs/yokoten` copies the skills only. Run `npx yokoten install` too, or nothing is guarded.

## On the road

- **Now, v0.1.1**: the five protections on for everyone; many AI sessions in one repo; every command in one screen.
- **Next, v0.1.2**: run a team of agents from the command line ([issue #823](https://github.com/yokoten-labs/yokoten/issues/823)).
- **Later**: a lesson one project learns becomes a check for every project.

*Yokoten* (横展) is a word from Toyota's factories: a fix that one line finds goes to every
line. See the [milestones](https://github.com/yokoten-labs/yokoten/milestones).

## Learn more

- [The guide](https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md): every rule and command, and what yokoten can't do.
- [The standard](https://github.com/yokoten-labs/yokoten/blob/main/docs/standard.md), [Decisions](https://github.com/yokoten-labs/yokoten/tree/main/docs/records), [Changelog](https://github.com/yokoten-labs/yokoten/blob/main/CHANGELOG.md), [Contributing](https://github.com/yokoten-labs/yokoten/blob/main/CONTRIBUTING.md), [Security](https://github.com/yokoten-labs/yokoten/blob/main/.github/SECURITY.md).

MIT license. Built by [coolwhite](https://coolwhite.us/) and a team of AI agents.
