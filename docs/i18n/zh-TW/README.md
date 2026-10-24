<!-- source: README.md -->
# yokoten · 橫展

給 AI 寫程式工具用的安全守衛。

AI agent 一秒鐘就能犯大錯。yokoten 在它動手之前攔下。

- **攔下危險操作**：強制 push、刪掉你的工作、洩露金鑰、沒經過你就發布。
- **在你已經在用的工具裡運作**：Claude Code、Codex、Copilot CLI、Muse Code 等等。
- **預設開啟。** 一條指令開始，不用學新東西。

[yokoten.app](https://yokoten.app/?from=github) · [English](https://github.com/yokoten-labs/yokoten/blob/main/README.md) · [简体中文](https://github.com/yokoten-labs/yokoten/blob/main/docs/i18n/zh-CN/README.md) · 繁體中文 · [日本語](https://github.com/yokoten-labs/yokoten/blob/main/docs/i18n/ja/README.md)

## 開始

要有 [Node](https://nodejs.org/) 22.23.4 或更新版本。然後執行：

```sh
cd your-project
npx yokoten
```

就這樣。隨時可以再執行一次，它只做還缺的部分。

## 你會看到的畫面

agent 想做有風險的事，yokoten 會攔下它，並告訴它該怎麼做：

```
yokoten stopped this: git push origin v1.2.0 pushes a release tag [release]
Why: Only the owner decides when to release.
Do instead: Stop and tell the owner: only the owner releases, with the steps in How to release; do not look for another way.
More: https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#how-to-release
```

## 它攔下什麼

yokoten 保護五樣東西。跑過 `npx yokoten` 後，五項保護在每個專案裡都開著，不用再設定。

- **你的工作**：強制 push、硬重設（hard reset）、刪除 `.git`，以及其他會弄丟工作的操作。
- **你的秘密**：提交裡加了金鑰、私人電子郵件或 IP 位址。
- **你的發布**：建立新標籤、發套件、把儲存庫改成公開。什麼時候發布，只由你決定。
- **你執行的程式碼**：讓程式直接執行沒人看過的下載內容。
- **守衛本身**：跳過提交檢查，或是把它關掉。

## 它怎麼運作

yokoten 是程式，不是 AI。同一條指令，每次都得到同一個回答，不到五分之一秒，不花錢。你的 AI 工具在每條指令或每次修改之前，先問 yokoten。yokoten 也會檢查每次提交，並在 CI 裡執行，所以就算沒有 agent 參與，有問題的修改也會被攔下。

v0.1.1 新增：幾個 AI 工作階段在同一個儲存庫裡工作時，`yokoten conflicts` 會列出哪些開著的 pull request 改了同一批檔案，以及先合併哪一個。一個檔案正被另一個開著的變更移動時，守衛會攔下對它的編輯。

## 支援範圍

任何 AI 模型都可以。守衛檢查的是 agent 要跑的指令，不是模型。

- **Agent**：守衛和下面每一個 agent 一起工作。每一行的證據（日期、執行方式、先要知道什麼）見 [agent 表](https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#works-with)（英文）。

| Agent | 已做端對端驗證 | 要先跑 `npx yokoten trust` | 測試過的模型 |
|---|---|---|---|
| Claude Code | yes | no | `deepseek-flash` |
| GitHub Copilot CLI | yes | yes | `gpt-6-luna` (Auto) |
| Antigravity CLI (`agy`) | yes | no | `gemini-3.8-flash-high` |
| Codex CLI | yes | yes | `deepseek-flash` |
| Muse Code | yes | yes | `muse-spark-1.3-contributor` |
| DeepSeek Harness (`dsh`) | yes | no | the default DeepSeek model |
| Grok CLI (`grok`) | yes | yes | the default model |
| Gemini CLI | not yet | no | — |
| OpenCode | yes | no | `opencode-go/deepseek-v4.1-flash` |

- **語言**：什麼語言都可以。`doctor` 能找到 JavaScript、TypeScript、Python、Go、Rust、Java、.NET、Ruby、PHP、Swift、Elixir、Dart 和 `make test` 的測試指令。

## 其他安裝方式

```sh
npx yokoten install     # 每台電腦一次
npx yokoten init        # 每個專案一次
npx yokoten doctor      # 走到了第幾關，下一步做什麼
```

- **Claude Code 外掛**：先執行 `/plugin marketplace add https://github.com/yokoten-labs/yokoten.git`（用 HTTPS，不需要 SSH 金鑰），再執行 `/plugin install yokoten@yokoten`。外掛和 `npx` 選一個，不要兩個都裝。
- **版本**：Stable（預設）、Beta 或 Dev。見[要安裝哪個版本](https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#which-version-to-install)（英文）。
- **只在 CI 裡用**：[當成 GitHub Action 用](https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#use-it-as-a-github-action)（英文）。
- **Node**：22.23.4 或更新；用 Node 24 要 24.22.1 起，用 Node 26 要 26.12.1 起。
- **UTC**：提交檢查只認 UTC 時間。設一次就好：在 shell 的設定檔裡加 `export TZ=UTC`；PowerShell 是在 `$PROFILE` 裡加 `$env:TZ = "UTC"`。`npx yokoten doctor` 會告訴你自己的 shell 該加哪一行。
- `npx skills add yokoten-labs/yokoten` 只複製 skills。還要執行 `npx yokoten install`，否則什麼都沒有守住。

## 這條路上

- **現在，v0.1.1**：五項保護對所有人開啟；一個儲存庫裡多個 AI 工作階段。
- **接下來，v0.1.2**：在命令列裡帶一支 agent 團隊（[issue #823](https://github.com/yokoten-labs/yokoten/issues/823)）。
- **以後**：一個專案學到的教訓，變成每個專案的檢查。

*橫展*（yokoten）是豐田工廠裡的說法：一條產線發現的問題，改到每條產線。見 [milestones](https://github.com/yokoten-labs/yokoten/milestones)。

## 延伸閱讀

- [指南](https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md)（英文）：每條規則、每個指令，以及 yokoten 做不到什麼。
- [標準](https://github.com/yokoten-labs/yokoten/blob/main/docs/standard.md)、[決策紀錄](https://github.com/yokoten-labs/yokoten/tree/main/docs/records)、[更新日誌](https://github.com/yokoten-labs/yokoten/blob/main/CHANGELOG.md)、[參與貢獻](https://github.com/yokoten-labs/yokoten/blob/main/CONTRIBUTING.md)、[安全](https://github.com/yokoten-labs/yokoten/blob/main/.github/SECURITY.md)（皆為英文）。

MIT 授權。由 [coolwhite](https://coolwhite.us/) 和一支 AI agent 團隊打造。
