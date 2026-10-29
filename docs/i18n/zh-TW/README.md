<!-- source: README.md -->
# yokoten · 橫展

[![npm](https://img.shields.io/npm/v/yokoten?logo=npm)](https://www.npmjs.com/package/yokoten)
[![ci](https://github.com/yokoten-labs/yokoten/actions/workflows/yokoten.yml/badge.svg)](https://github.com/yokoten-labs/yokoten/actions/workflows/yokoten.yml)
[![license](https://img.shields.io/badge/license-MIT-blue)](https://github.com/yokoten-labs/yokoten/blob/main/LICENSE)
[![Node](https://img.shields.io/badge/Node-%E2%89%A522.23.4-5FA04E?logo=nodedotjs&logoColor=white)](https://nodejs.org/)

給 AI 寫程式工具用的安全守衛。

AI agent 一秒鐘就能犯大錯。yokoten 在它動手之前攔下。

[yokoten.app](https://yokoten.app/?from=github) · [English](https://github.com/yokoten-labs/yokoten/blob/main/README.md) · [简体中文](https://github.com/yokoten-labs/yokoten/blob/main/docs/i18n/zh-CN/README.md) · 繁體中文 · [日本語](https://github.com/yokoten-labs/yokoten/blob/main/docs/i18n/ja/README.md)

## 開始

要有 [Node](https://nodejs.org/) 22.23.4 或更新。然後執行：

```sh
cd your-project
npx yokoten
```

就這樣：一條指令，什麼都不用設。隨時可以再執行一次，它只做還缺的部分。

第一次執行只有一屏：裝好了什麼、你走到哪一步、下一條要輸入的指令。

<!-- The first run in a new repo, from `yokoten` 0.1.2; regenerate it when the screen changes. -->
```text
yokoten 0.1.2 · set up; stage 1 of 5, safety net

  ok          guard on for Claude Code on this computer
  ok          37 files written in this project, none of yours changed

  MISSING     ~/.config/yokoten/private-marks is missing or has no marks
              Type your name, your city or a domain; it is not shown.
              Fix: `npx yokoten marks add`

  done        12 of 26 steps
  next        Run your tests on every push
  to do       Put the project on GitHub or Gitea
  to do       Name the owner (CODEOWNERS)
  to do       Set up the bot account
  to do       Add a license and a security policy
  can't check 9 steps read the code host; doctor checks them after a push

  note        16 uncommitted files, the oldest changed 1 minute ago

Next: `git add -A && git commit -m "chore: add yokoten"`
More: `npx yokoten doctor --all` shows every check and 5 notes
```

## 它攔下什麼

| 保護什麼 | 攔下什麼 |
|---|---|
| 你的工作 | 強制 push、硬重設（hard reset）、刪除 `.git` |
| 你的秘密 | 提交裡加了金鑰、私人電子郵件或 IP 位址 |
| 你的發布 | 建立新標籤、發套件、把儲存庫改成公開 |
| 你執行的程式碼 | 讓程式直接執行沒人看過的下載內容 |
| 守衛本身 | 跳過提交檢查，或是把它關掉 |

攔下時，它會說明原因，以及該怎麼做：

```
yokoten stopped this: git push origin v1.2.0 pushes a release tag [release]

  Why       Only the owner decides when to release.

  Instead   Stop and tell the owner: only the owner releases, with the steps in
            How to release; do not look for another way.

  More      https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#how-to-release
```

## 它怎麼運作

- **是程式，不是 AI。**同一條指令，每次都得到同一個回答，不到五分之一秒，不花錢。
- **三個地方。**你的 AI 工具在每條指令或每次修改之前先問 yokoten；yokoten 也檢查每次提交，並在 CI 裡執行。
- **不亂動你的設定。**你做過的選擇都會保留；改你的檔案之前，先留一份副本。
- **一個儲存庫裡多個 AI 工作階段。**`yokoten conflicts` 會說先合併哪個開著的變更；一個檔案正被另一個開著的變更移動時，守衛會攔下對它的編輯。

## 常用指令

開始只要一條指令。用起來之後，再多四條。

| 指令 | 它做什麼 |
|---|---|
| `npx yokoten` | 補上缺的東西，再給出下一步 |
| `yokoten check` | 提交之前找出密鑰和被破壞的規則 |
| `yokoten desk` | 把一個任務交給一個 AI，在它自己的工位裡做 |
| `yokoten kanban` | 一眼看到整個團隊，即時，唯讀（預覽版） |
| `yokoten tidy` | 列出舊分支、worktree 和工位 |

`yokoten help --all` 按用途分組列出其餘的指令：開始、工作、守衛、合併與 CI、維護。

## 支援範圍

任何 AI 模型都可以。守衛檢查的是 agent 要跑的指令，不是模型。

- **Agent**：守衛和下面每一個 agent 一起工作。每一行的證據（日期、執行方式、先要知道什麼）見[指南裡的 agent 表](https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#works-with)（英文）。
- **先信任**：寫 `yes` 的，要先在資料夾裡跑一次 `npx yokoten trust`，agent 才會執行守衛。

| Agent | 已做端到端驗證 | 先信任 | 測試過的模型 |
|---|---|---|---|
| Claude Code | ✅ yes | no | `deepseek-flash` |
| GitHub Copilot CLI | ✅ yes | yes | `gpt-6-luna` (Auto) |
| Antigravity CLI | ✅ yes | no | `gemini-3.8-flash-high` |
| Codex CLI | ✅ yes | yes | `deepseek-flash` |
| Muse Code | ✅ yes | yes | `muse-spark-1.3-contributor` |
| DeepSeek Harness | ✅ yes | no | the default DeepSeek model |
| Grok CLI | ✅ yes | yes | the default model |
| Gemini CLI | not yet | no | — |
| OpenCode | ✅ yes | no | `opencode-go/deepseek-v4.1-flash`, `opencode-go/glm-5.3-flash` |

- **語言**：什麼語言都可以。`doctor` 能找到 JavaScript、TypeScript、Python、Go、Rust、Java、.NET、Ruby、PHP、Swift、Elixir、Dart 和 `make test` 的測試指令。
- **平台**：Linux、macOS 和 WSL。原生 Windows 為測試版，支援 Git Bash 和 PowerShell 7。

## 其他安裝方式

`npx yokoten` 會替你把這三步都做完。它們也仍然可以單獨執行：

```sh
npx yokoten install     # 每台電腦一次
npx yokoten init        # 每個專案一次
npx yokoten doctor      # 走到了第幾關，下一步做什麼
```

- **Claude Code 外掛**：`/plugin marketplace add https://github.com/yokoten-labs/yokoten.git`，再執行 `/plugin install yokoten@yokoten`。外掛和 `npx` 選一個，不要兩個都裝。
- **版本**：Stable（預設）、Beta 或 Dev。見[要安裝哪個版本](https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#which-version-to-install)（英文）。
- **只在 CI 裡用**：[當成 GitHub Action 用](https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#use-it-as-a-github-action)（英文）。
- **Node**：22.23.4+、24.22.1+ 或 26.12.1+。
- **UTC**：提交檢查要求提交時間用 UTC。`npx yokoten doctor` 會告訴你自己的 shell 該加哪一行。

## 路線圖

- **已完成，v0.1.1**：五項保護對所有人開啟；一個儲存庫裡多個 AI 工作階段。
- **現在，v0.1.2**：前台五條指令，`yokoten`、`check`、`desk`、`kanban` 和 `tidy`；每個變更由和作者不同的模型來審。
- **以後**：一個專案學到的教訓，變成每個專案的檢查。

*橫展*（yokoten）是豐田工廠裡的說法：一條產線發現的問題，改到每條產線。

## 延伸閱讀

[指南](https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md)（英文） · [標準](https://github.com/yokoten-labs/yokoten/blob/main/docs/standard.md) · [決策紀錄](https://github.com/yokoten-labs/yokoten/tree/main/docs/records) · [更新日誌](https://github.com/yokoten-labs/yokoten/blob/main/CHANGELOG.md) · [里程碑](https://github.com/yokoten-labs/yokoten/milestones) · [參與貢獻](https://github.com/yokoten-labs/yokoten/blob/main/CONTRIBUTING.md) · [安全](https://github.com/yokoten-labs/yokoten/blob/main/.github/SECURITY.md)（皆為英文）

MIT 授權。由 [coolwhite](https://coolwhite.us/) 和一支 AI agent 團隊打造。
