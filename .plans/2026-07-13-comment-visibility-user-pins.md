---
plan_id: "2026-07-13-comment-visibility-user-pins"
title: "コメント可視化と個人別ピン留め"
status: "complete"
owner: "."
profile: "dev"
opened_at: "2026-07-13"
closed_at: "2026-07-13"
archived_from: "PLANS.md"
source_lines: 144
source_sha256: "0b05fd8d6a4e2725b0b52bcf9c1b0b750dc8250de8de2dd33caecbdddf61e9cb"
continuation_of: null
supersedes: null
archive_visibility: "local_private"
sanitized: true
immutable: true
read_policy: "explicit_continuation_or_promotion_audit"
---

# Sealed Plan Snapshot

<!-- plan-source-begin -->
---
plan_id: "2026-07-13-comment-visibility-user-pins"
status: "active"
owner: "."
profile: "dev"
opened_at: "2026-07-13"
continuation_of: null
archive_visibility: "local_private"
---

# コメント可視化と個人別ピン留め

## 現在のタスク

- メッセージへのコメント追加を他ユーザーにも視認できる状態へ直す。
- メッセージのピン留めを組織共通状態からユーザー個人の状態へ変更する。
- 実装、回帰テスト、PWAバージョン更新、mainへの統合、本番デプロイと疎通確認まで閉じる。

## 目的

- 会話の更新を見落とさず、各ユーザーが自分用に重要メッセージを整理できるようにする。

## 成功条件

- コメント数または更新表示が、コメント投稿者以外のユーザーにもAPI再取得後に表示される。
- 同一メッセージをユーザーAがピン留めしてもユーザーBの表示状態は変わらない。
- 他組織・他ユーザーのピン状態へアクセスできないことをサーバー側で保証する。
- 既存データの移行方針とロールバック方法が明確で、関連テストが通る。
- `APP_VERSION` と `app-config.js` のバージョンが同期し、本番デプロイ後に公開版を確認できる。

## 再利用した知識

- `git-branch-safety`: 前ブランチが `origin/main` と同一であることを確認し、main更新後に追跡付き作業ブランチを作成した。
- `codegraph-local-code-intelligence`: CodeGraphで対象シンボルを絞り、最終判断は直接読解・`rg`・テストで検証する。
- `nonfunctional-release-guardrails`: ユーザー別データ境界、IDOR、入力検証、migration、production確認をリリース条件にする。
- `ShiftFlow Index` / `Repo Work Context` / `Operating Loop`: repo固有仕様を正本とし、本変更を現場コミュニケーション改善の実績素材として扱う。
- `mainブランチ直接編集` Failure: mainでは変更せず、remote tracking branchを復帰点にする。

## Scope

- コメント表示・取得・投稿後更新に関わるフロント/API/テスト。
- 個人別ピン留めのDB、API、フロント、migration、テスト。
- 関連README、PWAバージョン、デプロイ記録。

## 非スコープ

- コメント内容の通知メール・Push通知など、新しい外部通知チャネル。
- メッセージ一覧全体の再設計や無関係なUI変更。

## 実行計画

1. 現行のコメント・ピン留めのデータフローと未統合ブランチの関連差分を確認する。
2. 最小のDB/API/UI差分と移行方針を決め、ユーザー境界テストを先に定義する。
3. 実装し、静的・自動・手動相当の検証を行う。
4. バージョン更新、commit/push、main統合、本番デプロイ、公開疎通確認を行う。
5. Planを完了保存し、学びとRizo接続を整理する。

## 検証方法

- APIテストでコメント追加後の他ユーザー取得と、ピン状態のユーザー間分離を確認する。
- migrationをローカルDBまたはテストDBへ適用し、schema/QCを確認する。
- JavaScript構文チェック、既存テスト、predeploy scanを実行する。
- 本番デプロイ後、公開アセットのバージョンと認証不要範囲のHTTP応答を確認する。

## 戻し方

- コードは本変更のmerge commitをrevertして再デプロイする。
- DB変更は破壊的削除を避け、旧列を残すforward-compatible migrationとし、必要時は旧API参照へ戻せるようにする。

## 許可境界

- ユーザーからbranch作成、実装、main統合、本番デプロイまで明示許可済み。
- secret値の閲覧・変更、外部通知送信、既存本番データの破壊的削除は行わない。

## Git / 作業ツリー境界

- current branch: `codex/comment-visibility-user-pins`
- upstream: `origin/codex/comment-visibility-user-pins`
- pre-existing changes to preserve: なし（開始時clean、前ブランチと`origin/main`は同一コミット）

## 実装判断

- ピン状態はログイン中membershipを所有者としてサーバー側で読み書きし、クライアント指定の所有者IDを信用しない。
- コメント可視化は共有コメント実体を増やすのではなく、現行データの取得・再描画契約の欠落を特定して最小修正する。
- 一覧へ `commentCount` / `lastCommentAt` / `hasNewComment` を返し、閲覧時刻より新しいコメントを未確認更新として扱う。
- コメント・既読・ピン操作後は即時再取得し、画面復帰・再フォーカス・画面遷移では60秒を上限に再取得する。Push通知や常時pollingは今回の非スコープとする。
- 旧共有ピンは個人の意思へ安全に帰属できないためbackfillしない。本番の旧共有ピンが0件であることを適用前に確認し、旧列はロールバック用に残す。

## Test matrix

- static: JavaScript構文、migration SQL、version整合、predeploy scan。
- automated: コメント回帰、ピンの同一ユーザーtoggle、別ユーザー非干渉、他組織拒否、既存API回帰。
- manual/live: 2ユーザー相当の画面/API確認、PWA更新導線、production assets/API health。

## High-risk boundary

- 本番D1 migrationとユーザー別認可が高リスク。既存列を即時削除せず、所有者はセッション由来に限定する。
- デプロイ先・binding・認証状態を実行直前に再確認する。
- 新コードは `message_pins` を一覧・home・bootstrapで参照するため、本番は `008` migration、QC、main deployの順を厳守する。
- Preview用D1は既存migration ledgerが本番と一致せず `007` も未適用のため、一括適用で修復せず、Previewはbuild/static確認、本番はmigration後のlive疎通を正本とする。

## Rizo接続

- 接続分類: `evidence_asset` / `failure_prevention`
- 増える資産: 現場コミュニケーションで「更新の可視性」と「個人整理」を分離した実装実績。
- 接続しないもの: 今回は記事公開やVault直接更新までは行わず、repoのPlanと実装を正本にする。

## 完了後レビュー

### 実施結果

- 開始時の `codex/mobile-chrome-navigation` は `origin/main` と同一で、既に統合済みだったため追加mergeは不要と判断した。
- `codex/comment-visibility-user-pins` を作成し、コメント更新表示、個人別ピン、DB migration、回帰テスト、README、PWA versionを実装した。
- `APP_VERSION` を `1.10.0` へ更新し、`app-config.js` / `sw.js` / READMEの一致を確認した。
- 本番D1で旧共有ピンが0件であることを確認後、`008_add_personal_message_pins.sql` を適用した。pendingなし、QC 23クエリ成功、`message_pins` 作成済みを確認した。
- 実装コミット `979dc69`、main統合コミット `1b6a277` をpushし、Cloudflare Pages Production deployment `84a6794e-c40e-497e-9541-fcf8053248a5` が成功した。

### 検証結果

- `npm run check`: 25 tests passed、predeploy scan passed、Pages Functions build passed。
- 統合テスト: Aの個人ピンがBへ影響しない、明示状態の冪等性、private folder拒否、他組織拒否、他者コメントの新着化、詳細閲覧後の解除、既読時刻の巻き戻り防止を確認した。
- Preview: source `979dc69` がActive、公開アセットversion `1.10.0`、未認証セッションAPI 200を確認した。
- Production: source `1b6a277`、公開root 200、`app-config.js` / `sw.js` version `1.10.0`、未認証セッションAPI 200を確認した。
- 実在する2ユーザーの本番画面操作は認証済みアカウントが必要なため未実施。ユーザー境界は実migrationを使うAPI統合テストで代替検証した。

### 問題と学び

- コメント保存自体ではなく、一覧APIの集約、既読時刻更新、フロント再描画の契約不足が主因だった。共有更新の可視性は保存処理だけでなく一覧・既読・再取得を一組で検証する。
- 共有ピンを個人ピンへbackfillすると所有者を推測することになる。利用実績が0件であることを実測し、no-backfillを採用した。
- Preview用D1はmigration ledgerが本番と一致していない。今回の無関係な修復は行わず、実migrationのローカル統合テストと本番適用後QCで境界を閉じた。
- 新schemaを無条件参照するreleaseでは、migrationをコードdeployより先に適用する順序が必須である。

### ロールバック

- コードはmain統合コミット `1b6a277` をrevertしてpushする。旧 `messages.is_pinned` は残しているため旧APIへ戻せる。
- `message_pins` は追加テーブルのみで既存データを変更していないため、コードrevert時はテーブルを残置して安全に未使用化する。

### Rizo接続レビュー

- 接続分類: `evidence_asset` / `failure_prevention`。
- 再利用したもの: branch safety、Plan archive、CodeGraph、release guardrails、Cloudflare deploy手順、ShiftFlowの既存認証・D1設計。
- 増えた資産: 共有更新通知と個人状態を分離する実装、ユーザー境界を通すD1統合テスト、migration-before-deployの実行証跡。
- 次回改善: Preview D1のmigration ledger修復は独立した高リスクタスクとして扱い、本番とのparity確認を先に設計する。
- 保存先: repoの実装・テスト・README・sealed Plan archive。Vault直接更新は今回行わない。

<!-- plan-source-end -->
