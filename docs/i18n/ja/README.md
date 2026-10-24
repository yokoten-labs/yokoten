<!-- source: README.md -->
# yokoten · 横展

AI コーディングツールのための安全な番人。

AI エージェントは一瞬で大きなミスをします。yokoten はその前に止めます。

- **危険な操作を止めます**：force push、作業の削除、秘密の漏えい、あなた抜きのリリース。
- **いま使っているツールの中で動きます**：Claude Code、Codex、Copilot CLI、Muse Code など。
- **最初から有効です。** コマンドひとつで始まり、新しく覚えることはありません。

[yokoten.app](https://yokoten.app/?from=github) · [English](https://github.com/yokoten-labs/yokoten/blob/main/README.md) · [简体中文](https://github.com/yokoten-labs/yokoten/blob/main/docs/i18n/zh-CN/README.md) · [繁體中文](https://github.com/yokoten-labs/yokoten/blob/main/docs/i18n/zh-TW/README.md) · 日本語

## はじめる

[Node](https://nodejs.org/) 22.23.4 以降が必要です。次を実行します。

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

## 何を止めるか

yokoten は五つを守ります。`npx yokoten` を実行すれば、五つの保護はどのプロジェクトでも有効で、ほかの設定はいりません。

- **作業**：force push、hard reset、`.git` の削除など、作業を失う操作。
- **秘密**：鍵、個人のメールアドレス、IP アドレスを加えるコミット。
- **リリース**：新しいタグ、パッケージの公開、リポジトリの公開。リリースの時期を決めるのはあなただけです。
- **実行するコード**：だれも読んでいないダウンロードをプログラムに実行させること。
- **番人そのもの**：コミットチェックの省略や、それを切ること。

## しくみ

yokoten は AI ではなくプログラムです。同じコマンドには毎回同じ答えを返します。5 分の 1 秒もかからず、費用はかかりません。AI ツールはコマンドや編集の前に yokoten に確認します。yokoten はコミットごとにも確認し、CI でも動くので、エージェントがいなくても悪い変更を止めます。

v0.1.1 の新機能：一つのリポジトリで複数の AI セッションが働くとき、`yokoten conflicts` は同じファイルに触れる開いた pull request と、先にマージするものを示します。別の開いた変更が移動中のファイルを編集しようとすると、番人が止めます。

## 対応しているもの

- **エージェント**：Claude Code、GitHub Copilot CLI、Antigravity CLI、Codex CLI、Muse Code、DeepSeek Harness、Grok CLI、OpenCode はエンドツーエンドで検証済みです。Gemini CLI はコードにありますが、エンドツーエンドではまだ実行していません。Codex CLI、Copilot CLI、Muse Code、Grok CLI は、フォルダーを信頼したあとにだけ番人を動かします。一度 `npx yokoten trust` を実行してください。[エージェント表](https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#works-with)（英語）を見てください。
- **言語**：どの言語でもかまいません。`doctor` は JavaScript、TypeScript、Python、Go、Rust、Java、.NET、Ruby、PHP、Swift、Elixir、Dart、`make test` のテストコマンドを見つけます。

## ほかのインストール方法

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

## これからの道

- **いま、v0.1.1**：五つの保護をすべての人に；一つのリポジトリで複数の AI セッション。
- **次、v0.1.2**：コマンドラインでエージェントのチームを動かす（[issue #823](https://github.com/yokoten-labs/yokoten/issues/823)）。
- **その先**：一つのプロジェクトが学んだことを、すべてのプロジェクトのチェックにする。

*横展*（yokoten）はトヨタの工場の言葉です。一つのラインで見つけた直しを、すべてのラインに広げます。[マイルストーン](https://github.com/yokoten-labs/yokoten/milestones) も見てください。

## もっと知る

- [ガイド](https://github.com/yokoten-labs/yokoten/blob/main/docs/i18n/ja/guide.md)：すべてのルールとコマンド、そして yokoten にできないこと。
- [標準](https://github.com/yokoten-labs/yokoten/blob/main/docs/standard.md)、[決定記録](https://github.com/yokoten-labs/yokoten/tree/main/docs/records)、[変更履歴](https://github.com/yokoten-labs/yokoten/blob/main/CHANGELOG.md)、[貢献](https://github.com/yokoten-labs/yokoten/blob/main/CONTRIBUTING.md)、[セキュリティ](https://github.com/yokoten-labs/yokoten/blob/main/.github/SECURITY.md)（英語）。

MIT ライセンス。[coolwhite](https://coolwhite.us/) と AI エージェントのチームが作っています。
