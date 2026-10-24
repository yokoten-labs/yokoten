<!-- source: README.md -->
# yokoten · 横展

给 AI 写代码工具用的安全守卫。

AI agent 一秒钟就能犯大错。yokoten 在它动手之前拦住。

- **拦住危险操作**：强推、删掉你的工作、泄露密钥、没经过你就发版。
- **在你已经在用的工具里工作**：Claude Code、Codex、Copilot CLI、Muse Code 等等。
- **默认开启。** 一条命令开始，不用学新东西。

[yokoten.app](https://yokoten.app/?from=github) · [English](https://github.com/yokoten-labs/yokoten/blob/main/README.md) · 简体中文 · [繁體中文](https://github.com/yokoten-labs/yokoten/blob/main/docs/i18n/zh-TW/README.md) · [日本語](https://github.com/yokoten-labs/yokoten/blob/main/docs/i18n/ja/README.md)

## 开始

要有 [Node](https://nodejs.org/) 22.23.4 或更高。然后运行：

```sh
cd your-project
npx yokoten
```

就这样。随时可以再运行一次，它只做还缺的部分。

## 你会看到什么

agent 想做有风险的事，yokoten 拦住它，并告诉它该怎么做：

```
yokoten stopped this: git push origin v1.2.0 pushes a release tag [release]
Why: Only the owner decides when to release.
Do instead: If the owner asked for this, they start a new session with `YOKOTEN_RELEASE_APPROVAL=1 claude` (or your agent's command); do not look for another way.
More: https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#the-core-rules
```

## 它拦住什么

yokoten 保护五样东西。跑过 `npx yokoten` 后，五项保护在每个项目里都开着，不用再设置。

- **你的工作**：强推、硬重置（hard reset）、删除 `.git`，以及其他会丢掉工作的操作。
- **你的秘密**：提交里加了密钥、私人邮箱或 IP 地址。
- **你的发布**：新建标签、发包、把仓库改成公开。什么时候发版，只由你决定。
- **你运行的代码**：让程序直接运行没人看过的下载内容。
- **守卫本身**：跳过提交检查，或者把它关掉。

## 它怎么工作

yokoten 是程序，不是 AI。同一条命令，每次都得到同一个回答，不到五分之一秒，不花钱。你的 AI 工具在每条命令或每次修改之前，先问 yokoten。yokoten 还会检查每次提交，也在 CI 里运行，所以就算没有 agent 参与，坏改动也会被拦住。

v0.1.1 新增：几个 AI 会话在同一个仓库里干活时，`yokoten conflicts` 会列出哪些打开的 pull request 改了同一批文件，以及先合哪一个。一个文件正被另一个打开的改动移动时，守卫会拦住对它的编辑。

## 支持哪些工具

- **Agent**：Claude Code、GitHub Copilot CLI、Antigravity CLI、Codex CLI、Muse Code、DeepSeek Harness、Grok CLI 和 OpenCode 都做了端到端验证。Gemini CLI 已经写进代码，但还没有做端到端运行。Codex CLI、Copilot CLI、Muse Code 和 Grok CLI 要先信任这个文件夹才会运行守卫：跑一次 `npx yokoten trust`。见 [agent 表](https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#works-with)（英文）。
- **语言**：什么语言都行。`doctor` 能找到 JavaScript、TypeScript、Python、Go、Rust、Java、.NET、Ruby、PHP、Swift、Elixir、Dart 和 `make test` 的测试命令。

## 其他安装方式

```sh
npx yokoten install     # 每台电脑一次
npx yokoten init        # 每个项目一次
npx yokoten doctor      # 走到了第几关，下一步做什么
```

- **Claude Code 插件**：先运行 `/plugin marketplace add https://github.com/yokoten-labs/yokoten.git`（用 HTTPS，不需要 SSH 密钥），再运行 `/plugin install yokoten@yokoten`。插件和 `npx` 选一个，不要两个都装。
- **版本**：Stable（默认）、Beta 或 Dev。见[要安装哪个版本](https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#which-version-to-install)（英文）。
- **只在 CI 里用**：[当成 GitHub Action 用](https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#use-it-as-a-github-action)（英文）。
- **Node**：22.23.4 或更高；用 Node 24 要 24.22.1 起，用 Node 26 要 26.12.1 起。
- **UTC**：提交检查只认 UTC 时间。设一次就行：在 shell 的配置文件里加 `export TZ=UTC`；PowerShell 是在 `$PROFILE` 里加 `$env:TZ = "UTC"`。`npx yokoten doctor` 会告诉你自己的 shell 该加哪一行。
- `npx skills add yokoten-labs/yokoten` 只复制 skills。还要运行 `npx yokoten install`，否则什么都没有守住。

## 往哪里去

- **现在，v0.1.1**：五项保护对所有人开启；一个仓库里多个 AI 会话。
- **接下来，v0.1.2**：在命令行里带一支 agent 团队（[issue #823](https://github.com/yokoten-labs/yokoten/issues/823)）。
- **以后**：一个项目学到的教训，变成每个项目的检查。

*横展*（yokoten）是丰田工厂里的说法：一条产线发现的问题，改到每条产线。见 [milestones](https://github.com/yokoten-labs/yokoten/milestones)。

## 了解更多

- [指南](https://github.com/yokoten-labs/yokoten/blob/main/docs/i18n/zh-CN/guide.md)：每条规则、每个命令，以及 yokoten 做不到什么。
- [标准](https://github.com/yokoten-labs/yokoten/blob/main/docs/i18n/zh-CN/standard.md)、[决定记录](https://github.com/yokoten-labs/yokoten/tree/main/docs/records)（英文）、[更新日志](https://github.com/yokoten-labs/yokoten/blob/main/CHANGELOG.md)、[参与贡献](https://github.com/yokoten-labs/yokoten/blob/main/CONTRIBUTING.md)、[安全](https://github.com/yokoten-labs/yokoten/blob/main/.github/SECURITY.md)。

MIT 许可。由 [coolwhite](https://coolwhite.us/) 和一支 AI agent 团队打造。
