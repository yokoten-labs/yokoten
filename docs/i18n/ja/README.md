<!-- source: README.md -->
<div align="center">

# yokoten · 横展

### AI コーディングツールのための安全な番人。

AI エージェントは一瞬で大きなミスをします。yokoten はその前に止めます。

**[yokoten.app](https://yokoten.app/?from=github)** &nbsp;·&nbsp; [English](https://github.com/yokoten-labs/yokoten/blob/main/README.md) | [简体中文](https://github.com/yokoten-labs/yokoten/blob/main/docs/i18n/zh-CN/README.md) | [繁體中文](https://github.com/yokoten-labs/yokoten/blob/main/docs/i18n/zh-TW/README.md) | 日本語

[![ci](https://github.com/yokoten-labs/yokoten/actions/workflows/yokoten.yml/badge.svg)](https://github.com/yokoten-labs/yokoten/actions/workflows/yokoten.yml)
[![license](https://img.shields.io/badge/license-MIT-blue)](https://github.com/yokoten-labs/yokoten/blob/main/LICENSE)
[![npm](https://img.shields.io/npm/v/yokoten?logo=npm)](https://www.npmjs.com/package/yokoten)
[![Node](https://img.shields.io/badge/Node-%E2%89%A522.23.4-5FA04E?logo=nodedotjs&logoColor=white)](https://nodejs.org/)

</div>

- 🛡 **危険な操作を止めます**：force push、作業の削除、秘密の漏えい、あなた抜きのリリース。
- 🔌 **いま使っているツールの中で動きます**：Claude Code、Codex、Copilot CLI、Muse Code など。
- ⚙️ **最初から有効です。** 設定も、新しく覚えることもありません。

## はじめる

[Node](https://nodejs.org/) 22.23.4 以降が必要です。プロジェクトで次を実行します。

```sh
cd your-project
npx yokoten
```

これだけです。いつでももう一度実行できます。足りないものだけを入れます。

## 見えるもの

エージェントが危ないことをしようとすると、yokoten が止めて、代わりに何をすべきかを伝えます。

```
yokoten stopped this: git push origin v1.2.0 pushes a release tag [release]
Why: Only the owner decides when to release.
Do instead: If the owner asked for this, they start a new session with `YOKOTEN_RELEASE_APPROVAL=1 claude` (or your agent's command); do not look for another way.
More: https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#the-core-rules
```

<details>
<summary><b>何を止めるか</b></summary>

yokoten は五つを守ります。あなたの作業、秘密、リリース、実行するコード、そして番人そのものです。五つの保護は、どのプロジェクトでも設定なしで最初から有効です。

- **作業**：force push、hard reset、`.git` の削除など、作業を失う操作。
- **秘密**：鍵、個人のメールアドレス、IP アドレスを加えるコミット。
- **リリース**：新しいタグ、パッケージの公開、リポジトリの公開。リリースの時期を決めるのはあなただけです。
- **実行するコード**：だれも読んでいないダウンロードをプログラムに実行させること。
- **番人そのもの**：コミットチェックの省略や、コミットチェックを切ること。

</details>

<details>
<summary><b>しくみ</b></summary>

yokoten は AI ではなくプログラムです。同じコマンドには毎回同じ答えを返します。約 100 ミリ秒で、費用はかかりません。AI ツールはコマンドや編集の前に yokoten に確認します。yokoten はコミットごとにも確認し、CI でも動くので、エージェントがいなくても悪い変更を止めます。

ターミナル、デスクトップアプリ、エディタで動きます。Orca のように多くのエージェントを動かすツールの下でも使えます。それらのツールを置き換えるものではありません。

</details>

<details>
<summary><b>一つのリポジトリで複数の AI セッション</b>（v0.1.1 の新機能）</summary>

- `yokoten conflicts` は、同じファイルに触れる開いた pull request と、先にマージするものを示します。
- ファイルを移動または削除する変更を先に入れます。同じファイルを移動する別のコミットは待ちます。
- 別の開いた変更が移動中のファイルを編集しようとすると、番人が止めます。

</details>

<details>
<summary><b>対応しているもの</b></summary>

**エージェント。** Claude Code、GitHub Copilot CLI、Antigravity CLI、Codex CLI、Muse Code、DeepSeek Harness、Grok CLI、OpenCode はエンドツーエンドで検証済みです。Gemini CLI はコードにありますが、エンドツーエンドではまだ実行していません。それぞれの確かめ方は [エージェント表](https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#works-with)（英語）にあります。

**言語。** どの言語でもかまいません。`doctor` は JavaScript、TypeScript、Python、Go、Rust、Java、.NET、Ruby、PHP、Swift、Elixir、Dart、`make test` のテストコマンドを見つけます。

</details>

<details>
<summary><b>ほかのインストール方法</b></summary>

一つずつ進める場合：

```sh
npx yokoten install     # コンピュータごとに一度
npx yokoten init        # プロジェクトごとに一度
npx yokoten doctor      # いまどこにいて、次に何をするか
```

- **Claude Code プラグイン**：`/plugin marketplace add yokoten-labs/yokoten` のあと `/plugin install yokoten@yokoten`。プラグインか `npx` のどちらか一つを使います。
- **バージョン**：Stable（既定）、Beta、Dev。[どのバージョンを入れるか](https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#which-version-to-install)（英語）を見てください。
- **CI だけで使う**：[GitHub Action として使う](https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#use-it-as-a-github-action)（英語）。
- **Node**：22.23.4 以降。Node 24 なら 24.22.1 以降、Node 26 なら 26.12.1 以降。
- **UTC**：コミットチェックは UTC のコミット時刻を求めます。シェルの設定ファイルに `export TZ=UTC` を一度だけ加えます。
- `npx skills add yokoten-labs/yokoten` はスキルだけをコピーします。`npx yokoten install` も実行しないと、何も守られません。

</details>

## これからの道

| | いま | 次 |
|---|---|---|
| ✅ | **v0.1.1**：五つの保護をすべての人に；一つのリポジトリで複数の AI セッション | |
| 🚧 | | **v0.1.2**：コマンドラインでエージェントのチームを動かす（[issue #823](https://github.com/yokoten-labs/yokoten/issues/823)） |
| 🌱 | | **その先**：一つのプロジェクトが学んだことを、すべてのプロジェクトのチェックにする |

*横展*（yokoten）はトヨタの工場の言葉です。一つのラインで見つけた直しを、すべてのラインに広げます。[マイルストーン](https://github.com/yokoten-labs/yokoten/milestones) も見てください。

## もっと知る

- **[ガイド](https://github.com/yokoten-labs/yokoten/blob/main/docs/i18n/ja/guide.md)**：すべてのルールとコマンド、そして yokoten にできないこと。
- **[標準](https://github.com/yokoten-labs/yokoten/blob/main/docs/standard.md)**、**[決定記録](https://github.com/yokoten-labs/yokoten/tree/main/docs/records)**、**[変更履歴](https://github.com/yokoten-labs/yokoten/blob/main/CHANGELOG.md)**、**[貢献](https://github.com/yokoten-labs/yokoten/blob/main/CONTRIBUTING.md)**、**[セキュリティ](https://github.com/yokoten-labs/yokoten/blob/main/.github/SECURITY.md)**（英語）。

---

<p align="center"><sub>MIT · <a href="https://coolwhite.us/">coolwhite</a> と AI エージェントのチームが作っています。</sub></p>
