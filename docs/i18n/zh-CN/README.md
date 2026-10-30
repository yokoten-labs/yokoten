<!-- source: README.md -->
# yokoten · 横展

[![npm](https://img.shields.io/npm/v/yokoten?logo=npm)](https://www.npmjs.com/package/yokoten)
[![ci](https://github.com/yokoten-labs/yokoten/actions/workflows/yokoten.yml/badge.svg)](https://github.com/yokoten-labs/yokoten/actions/workflows/yokoten.yml)
[![license](https://img.shields.io/badge/license-MIT-blue)](https://github.com/yokoten-labs/yokoten/blob/main/LICENSE)
[![Node](https://img.shields.io/badge/Node-%E2%89%A522.23.4-5FA04E?logo=nodedotjs&logoColor=white)](https://nodejs.org/)

yokoten 拦住 AI 编程 agent 犯下收不回来的错误。

一条命令，不用设置。

[yokoten.app](https://yokoten.app/?from=github) · [English](https://github.com/yokoten-labs/yokoten/blob/main/README.md) · 简体中文 · [繁體中文](https://github.com/yokoten-labs/yokoten/blob/main/docs/i18n/zh-TW/README.md) · [日本語](https://github.com/yokoten-labs/yokoten/blob/main/docs/i18n/ja/README.md)

## 开始

要有 [Node](https://nodejs.org/) 22.23.4 或更高。然后运行：

```sh
cd your-project
npx yokoten
```

就这样：一条命令，什么都不用设。随时可以再运行一次，它只做还缺的部分。

第一次运行只有一屏：装好了什么、你走到哪一步、下一条要输入的命令。

<!-- The first run in a new repo, from `yokoten` 0.1.3; regenerate it when the screen changes. -->
```text
yokoten 0.1.3 · set up; stage 1 of 5, safety net

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

## 它拦住什么

| 保护什么 | 拦住什么 |
|---|---|
| 你的工作 | 强推、硬重置（hard reset）、删除 `.git` |
| 你的秘密 | 提交里加了密钥、私人邮箱或 IP 地址 |
| 你的发布 | 新建标签、发包、把仓库改成公开 |
| 你运行的代码 | 让程序直接运行没人看过的下载内容 |
| 守卫本身 | 跳过提交检查，或者把它关掉 |

拦住时，它会说明原因，以及该怎么做：

```
yokoten stopped this: git push origin v1.2.0 pushes a release tag [release]

  Why       Only the owner decides when to release.

  Instead   Stop and tell the owner: only the owner releases, with the steps in
            How to release; do not look for another way.

  More      https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#how-to-release
```

## 它怎么工作

- **是程序，不是 AI。**同一条命令，每次都得到同一个回答，不到五分之一秒，不花钱。
- **三个地方。**你的 AI 工具在每条命令或每次修改之前先问 yokoten；yokoten 也检查每次提交，并在 CI 里运行。
- **不乱动你的设置。**你做过的选择它都保留；改你的文件之前，先留一份副本。
- **一个仓库里多个 AI 会话。**`yokoten conflicts` 会说先合并哪个打开的改动；一个文件正被另一个打开的改动移动时，守卫会拦住对它的编辑。

## 常用命令

开始只要一条命令。用起来之后，再多四条。

| 命令 | 它做什么 |
|---|---|
| `npx yokoten` | 补上缺的东西，再给出下一步 |
| `yokoten check` | 提交之前找出密钥和被破坏的规则 |
| `yokoten desk` | 把一个任务交给一个 AI，在它自己的工位里做 |
| `yokoten kanban` | 一眼看到整个团队（预览版） |
| `yokoten tidy` | 列出旧分支、worktree 和工位 |

`yokoten help --all` 按用途分组列出其余的命令：开始、工作、守卫、合并与 CI、维护。

## 支持哪些工具

任何 AI 模型都可以。守卫检查的是 agent 要跑的命令，不是模型。

- **Agent**：守卫能搭配下面每一个 agent 使用。每一行的证据（日期、运行方式、先要知道什么）见[指南里的 agent 表](https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#works-with)（英文）。
- **先信任**：写 `yes` 的，要先在文件夹里跑一次 `npx yokoten trust`，agent 才会运行守卫。

| Agent | 已做端到端验证 | 先信任 | 测试过的模型 |
|---|---|---|---|
| Claude&nbsp;Code | ✅ yes | no | `deepseek-flash` |
| GitHub&nbsp;Copilot&nbsp;CLI | ✅ yes | yes | `gpt-6-luna` (Auto) |
| Antigravity&nbsp;CLI | ✅ yes | no | `gemini-3.8-flash-high` |
| Codex&nbsp;CLI | ✅ yes | yes | `deepseek-flash` |
| Muse&nbsp;Code | ✅ yes | yes | `muse-spark-1.3-contributor` |
| DeepSeek&nbsp;Harness | ✅ yes | no | the default DeepSeek model |
| Grok&nbsp;CLI | ✅ yes | yes | the default model |
| Gemini&nbsp;CLI | not yet | no | — |
| OpenCode | ✅ yes | no | `opencode-go/deepseek-v4.1-flash`<br>`opencode-go/glm-5.3-flash` |

- **语言**：什么语言都行。`doctor` 能找到 JavaScript、TypeScript、Python、Go、Rust、Java、.NET、Ruby、PHP、Swift、Elixir、Dart 和 `make test` 的测试命令。
- **平台**：Linux、macOS 和 WSL。原生 Windows 为测试版，支持 Git Bash 和 PowerShell 7。

## 其他安装方式

`npx yokoten` 会替你把这三步都做完。它们也仍然可以单独运行：

```sh
npx yokoten install     # 每台电脑一次
npx yokoten init        # 每个项目一次
npx yokoten doctor      # 走到了第几关，下一步做什么
```

- **Claude Code 插件**：`/plugin marketplace add https://github.com/yokoten-labs/yokoten.git`，再运行 `/plugin install yokoten@yokoten`。插件和 `npx` 选一个，不要两个都装。
- **版本**：Stable（默认）、Beta 或 Dev。见[要安装哪个版本](https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#which-version-to-install)（英文）。
- **只在 CI 里用**：[当成 GitHub Action 用](https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#use-it-as-a-github-action)（英文）。
- **Node**：22.23.4+、24.22.1+ 或 26.12.1+。
- **UTC**：提交检查要求提交时间用 UTC。`npx yokoten doctor` 会告诉你自己的 shell 该加哪一行。

## 路线图

- **已完成，v0.1.1**：五项保护对所有人开启；一个仓库里多个 AI 会话。
- **现在，v0.1.2**：前台五条命令，`yokoten`、`check`、`desk`、`kanban` 和 `tidy`；每个改动由和作者不同的模型来审。
- **以后**：一个项目学到的教训，变成每个项目的检查。

*横展*（yokoten）是丰田工厂里的说法：一条产线发现的问题，改到每条产线。

## 了解更多

[指南](https://github.com/yokoten-labs/yokoten/blob/main/docs/i18n/zh-CN/guide.md) · [标准](https://github.com/yokoten-labs/yokoten/blob/main/docs/i18n/zh-CN/standard.md) · [决定记录](https://github.com/yokoten-labs/yokoten/tree/main/docs/records)（英文） · [更新日志](https://github.com/yokoten-labs/yokoten/blob/main/CHANGELOG.md) · [里程碑](https://github.com/yokoten-labs/yokoten/milestones) · [参与贡献](https://github.com/yokoten-labs/yokoten/blob/main/CONTRIBUTING.md) · [安全](https://github.com/yokoten-labs/yokoten/blob/main/SECURITY.md)

MIT 许可。由 [coolwhite](https://coolwhite.us/) 和一支 AI agent 团队打造。
