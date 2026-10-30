<!-- source: README.md -->
# yokoten · 横展

[![npm](https://img.shields.io/npm/v/yokoten?logo=npm)](https://www.npmjs.com/package/yokoten)
[![ci](https://github.com/yokoten-labs/yokoten/actions/workflows/yokoten.yml/badge.svg)](https://github.com/yokoten-labs/yokoten/actions/workflows/yokoten.yml)
[![license](https://img.shields.io/badge/license-MIT-blue)](https://github.com/yokoten-labs/yokoten/blob/main/LICENSE)
[![Node](https://img.shields.io/badge/Node-%E2%89%A522.23.4-5FA04E?logo=nodedotjs&logoColor=white)](https://nodejs.org/)

yokoten は、AI コーディングエージェントが取り返しのつかないミスをするのを止めます。

コマンドひとつで、設定はいりません。

[yokoten.app](https://yokoten.app/?from=github) · [English](https://github.com/yokoten-labs/yokoten/blob/main/README.md) · [简体中文](https://github.com/yokoten-labs/yokoten/blob/main/docs/i18n/zh-CN/README.md) · [繁體中文](https://github.com/yokoten-labs/yokoten/blob/main/docs/i18n/zh-TW/README.md) · 日本語

## はじめる

[Node](https://nodejs.org/) 22.23.4 以降が必要です。そして実行します。

```sh
cd your-project
npx yokoten
```

これだけです。コマンドひとつで、設定はいりません。何度でも実行でき、足りない分だけを行います。

初回は一画面だけ表示されます。設定した内容、いまの段階、次のコマンドです。

<!-- The first run in a new repo, from `yokoten` 0.2.0; regenerate it when the screen changes. -->
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

## 何を止めるか

| 守るもの | 止めること |
|---|---|
| 作業 | force push、hard reset、`.git` の削除 |
| 秘密 | 鍵、個人のメールアドレス、IP アドレスを加えるコミット |
| リリース | 新しいタグ、パッケージの公開、リポジトリの公開 |
| 実行するコード | だれも読んでいないダウンロードをそのまま実行すること |
| 番人そのもの | コミットチェックの省略や、それを切ること |

止めたときは、理由と代わりの手順を伝えます。

```
yokoten stopped this: git push origin v1.2.0 pushes a release tag [release]

  Why       Only the owner decides when to release.

  Instead   Stop and tell the owner: only the owner releases, with the steps in
            How to release; do not look for another way.

  More      https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#how-to-release
```

## しくみ

- **AI ではなくプログラムです。**同じコマンドには毎回同じ答えを返します。5 分の 1 秒もかからず、費用もかかりません。
- **三か所で働きます。**AI ツールはコマンドや編集の前に yokoten に確認します。yokoten はコミットごとにも確認し、CI でも動きます。
- **設定を勝手に変えません。**あなたが決めた設定はそのまま残し、ファイルを変える前にコピーを取ります。
- **一つのリポジトリで複数の AI セッション。**`yokoten conflicts` は先にマージする変更を示します。別の開いた変更が移動中のファイルへの編集は、番人が止めます。

## 主なコマンド

始めるのに必要なのは一つのコマンドだけです。進めるうちに、あと四つが役に立ちます。

| コマンド | 何をするか |
|---|---|
| `npx yokoten` | 足りないものを整え、次の一歩を見せる |
| `yokoten check` | コミットの前に、秘密情報や破られたルールを探す |
| `yokoten desk` | 一つのタスクを一つの AI に渡し、その AI 専用のデスクで進める |
| `yokoten kanban` | チームを一目で見せる（プレビュー） |
| `yokoten tidy` | 古いブランチ、worktree、デスクを一覧にする |

`yokoten help --all` で残りのコマンドが、仕事ごとのグループ（はじめる・進める・守る・マージと CI・保守）で分かります。

## 対応しているもの

どの AI モデルでも動きます。番人が検査するのは agent が実行するコマンドで、モデルではありません。

- **エージェント**：番人は下のどのエージェントとも動きます。各行の証拠（日付、実行の方法、先に知るべきこと）は、ガイドの[エージェント表](https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#works-with)（英語）にあります。
- **先に信頼**：`yes` のものは、フォルダで一度 `npx yokoten trust` を実行すると、エージェントが番人を動かします。

| Agent | 端から端まで検証済み | 先に信頼 | 試したモデル |
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

- **言語**：どの言語でもかまいません。`doctor` は JavaScript、TypeScript、Python、Go、Rust、Java、.NET、Ruby、PHP、Swift、Elixir、Dart、`make test` のテストコマンドを見つけます。
- **プラットフォーム**：Linux、macOS、WSL。ネイティブ Windows はベータ版で、Git Bash と PowerShell 7 に対応しています。

## ほかのインストール方法

`npx yokoten` はこの三つをまとめて行います。一つずつ単独でも動きます。

```sh
npx yokoten install     # コンピュータごとに一度
npx yokoten init        # プロジェクトごとに一度
npx yokoten doctor      # いまどこにいて、次に何をするか
```

- **Claude Code プラグイン**：`/plugin marketplace add https://github.com/yokoten-labs/yokoten.git` のあと `/plugin install yokoten@yokoten`。プラグインか `npx` のどちらか一つを使います。
- **バージョン**：Stable（既定）、Beta、Dev。[どのバージョンを入れるか](https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#which-version-to-install)（英語）を見てください。
- **CI だけで使う**：[GitHub Action として使う](https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#use-it-as-a-github-action)（英語）。
- **Node**：22.23.4 以降、24.22.1 以降、または 26.12.1 以降。
- **UTC**：コミットチェックは UTC のコミット時刻を求めます。`npx yokoten doctor` が、あなたのシェル用の行を教えてくれます。

## ロードマップ

- **完了、v0.1.2**：前面に出す五つのコマンド、`yokoten`、`check`、`desk`、`kanban`、`tidy`；変更は書いたモデルとは別のモデルがレビューする。
- **いま、v0.2.0**：`doctor --files` はプロジェクトのファイルだけを読むので、Web ページでも道のりを表示できる；レビューは三回で終わる。
- **その先**：一つのプロジェクトが学んだことを、すべてのプロジェクトのチェックにする。

*横展*（yokoten）はトヨタの工場の言葉です。一つのラインで見つけた直しを、すべてのラインに広げます。

## もっと知る

[ガイド](https://github.com/yokoten-labs/yokoten/blob/main/docs/i18n/ja/guide.md) · [標準](https://github.com/yokoten-labs/yokoten/blob/main/docs/standard.md)（英語） · [決定記録](https://github.com/yokoten-labs/yokoten/tree/main/docs/records)（英語） · [変更履歴](https://github.com/yokoten-labs/yokoten/blob/main/CHANGELOG.md)（英語） · [マイルストーン](https://github.com/yokoten-labs/yokoten/milestones) · [貢献](https://github.com/yokoten-labs/yokoten/blob/main/CONTRIBUTING.md)（英語） · [セキュリティ](https://github.com/yokoten-labs/yokoten/blob/main/SECURITY.md)（英語）

MIT ライセンス。[coolwhite](https://coolwhite.us/) と AI エージェントのチームが作っています。
