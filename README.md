# yokoten · 横展

A safety guard for AI coding tools.

AI agents can make a big mistake in a second. yokoten stops it before it happens.

- **Stops dangerous actions**: a force push, deleting your work, leaking a secret, releasing without you.
- **Works inside the tools you already use**: Claude Code, Codex, Copilot CLI, Muse Code and more.
- **On by default.** One command to start, nothing new to learn.

[yokoten.app](https://yokoten.app/?from=github) · English · [简体中文](https://github.com/yokoten-labs/yokoten/blob/main/docs/i18n/zh-CN/README.md) · [繁體中文](https://github.com/yokoten-labs/yokoten/blob/main/docs/i18n/zh-TW/README.md) · [日本語](https://github.com/yokoten-labs/yokoten/blob/main/docs/i18n/ja/README.md)

## Start

You need [Node](https://nodejs.org/) 22.23.4 or later. Then run:

```sh
cd your-project
npx yokoten
```

That's it. Run it again any time: it does only what is still missing.

## What you see

An agent tries something risky. yokoten stops it and says what to do instead:

```
yokoten stopped this: git push origin v1.2.0 pushes a release tag [release]
Why: Only the owner decides when to release.
Do instead: If the owner asked for this, they start a new session with `YOKOTEN_RELEASE_APPROVAL=1 claude` (or your agent's command); do not look for another way.
More: https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#the-core-rules
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

- **Agents**: Claude Code, GitHub Copilot CLI, Antigravity CLI, Codex CLI, Muse Code, DeepSeek Harness, Grok CLI and OpenCode are verified end to end. Gemini CLI is in the code but not run end to end. Codex CLI, Copilot CLI, Muse Code and Grok CLI run the guard only after you trust the folder: run `npx yokoten trust` once. See the [agent table](https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#works-with).
- **Languages**: any. `doctor` finds the test command for JavaScript, TypeScript, Python, Go, Rust, Java, .NET, Ruby, PHP, Swift, Elixir, Dart and `make test`.

## More ways to install

```sh
npx yokoten install     # once per computer
npx yokoten init        # once per project
npx yokoten doctor      # where you are, and the one next step
```

- **Claude Code plugin**: `/plugin marketplace add yokoten-labs/yokoten`, then `/plugin install yokoten@yokoten`. Use the plugin or `npx`, not both.
- **Versions**: Stable (the default), Beta or Dev. See [which version to install](https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#which-version-to-install).
- **CI only**: [use it as a GitHub Action](https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#use-it-as-a-github-action).
- **Node**: 22.23.4 or later, 24.22.1 or later on Node 24, 26.12.1 or later on Node 26.
- **UTC**: the commit check asks for UTC commit times. Set it once: `export TZ=UTC` in your shell profile, or `$env:TZ = "UTC"` in `$PROFILE` in PowerShell. `npx yokoten doctor` names the line for your shell.
- `npx skills add yokoten-labs/yokoten` copies the skills only. Run `npx yokoten install` too, or nothing is guarded.

## On the road

- **Now, v0.1.1**: the five protections on for everyone; many AI sessions in one repo.
- **Next, v0.1.2**: run a team of agents from the command line ([issue #823](https://github.com/yokoten-labs/yokoten/issues/823)).
- **Later**: a lesson one project learns becomes a check for every project.

*Yokoten* (横展) is a word from Toyota's factories: a fix that one line finds goes to every
line. See the [milestones](https://github.com/yokoten-labs/yokoten/milestones).

## Learn more

- [The guide](https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md): every rule and command, and what yokoten can't do.
- [The standard](https://github.com/yokoten-labs/yokoten/blob/main/docs/standard.md), [Decisions](https://github.com/yokoten-labs/yokoten/tree/main/docs/records), [Changelog](https://github.com/yokoten-labs/yokoten/blob/main/CHANGELOG.md), [Contributing](https://github.com/yokoten-labs/yokoten/blob/main/CONTRIBUTING.md), [Security](https://github.com/yokoten-labs/yokoten/blob/main/.github/SECURITY.md).

MIT license. Built by [coolwhite](https://coolwhite.us/) and a team of AI agents.
