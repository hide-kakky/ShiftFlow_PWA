---
plan_id: "2026-07-13-modal-header-layering"
title: "詳細モーダルと上部メニューの表示階層修正"
status: "complete"
owner: "."
profile: "dev"
opened_at: "2026-07-13"
closed_at: "2026-07-13"
archived_from: "PLANS.md"
source_lines: 145
source_sha256: "b6652b82c428d457b59353b31b75639898ded047ff8e6b926b1cfed79f715d89"
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
plan_id: "2026-07-13-modal-header-layering"
status: "active"
owner: "."
profile: "dev"
opened_at: "2026-07-13"
continuation_of: null
archive_visibility: "local_private"
---

# 詳細モーダルと上部メニューの表示階層修正

## 現在のタスク

- 提供画像を根拠に、詳細モーダルとグローバル上部メニューの責務・表示階層を整理する。
- モーダルの固有ヘッダーが隠れず、背景側のグローバル操作が前面に出ないよう最小修正する。
- 回帰テスト、PWA version更新、main統合、本番デプロイ、公開確認まで閉じる。

## 目的

- 全画面詳細モーダルを1つの操作コンテキストとして成立させ、背景画面のメニューとの二重ナビゲーションと誤操作を防ぐ。

## 成功条件

- モバイルのメッセージ詳細で「戻る／メッセージ詳細」ヘッダーが常に前面に見える。
- モーダル表示中、グローバル上部メニューはモーダルやbackdropより前面に出ず操作できない。
- モーダルを閉じるとグローバルヘッダー、検索、スクロールが従来どおり復帰する。
- タスク詳細・新規作成など既存Bootstrapモーダルと画像ビューアの階層を壊さない。
- `APP_VERSION`を更新し、main統合後のCloudflare Pages本番で公開版を確認できる。

## 再利用した知識

- `git-branch-safety`: mainがcleanかつorigin同期済みと確認し、remote tracking branchから開始した。
- `codegraph-local-code-intelligence`: CodeGraphでJavaScript索引を確認し、inline HTML/CSSは`rg`と直接読解で補完した。
- `plans-strategy-archive`: 判断、検証範囲、戻し方をcurrent Plan 1件へ記録する。
- `nonfunctional-release-guardrails`: PWAキャッシュ、スクロールロック、全モーダルへの副作用をrelease条件にする。
- `cloudflare-deploy`: Git連携のPreview/Production sourceと公開アセットを照合する。
- Git branch Failure: mainへ直接実装せず、merge後の記録も作業ブランチで行う。

## Scope

- `frontend/public/index.html`のグローバルヘッダー、検索パネル、modal/backdropの表示階層。
- モーダル階層の静的回帰テスト、README、`app-config.js`、`sw.js`。
- Preview確認、main merge、Production確認、Plan close。

## 非スコープ

- 詳細モーダルの情報設計や本文レイアウトの全面改修。
- Bootstrapの更新、通知機能、API/DB変更。

## 実行計画

1. スクリーンショット、CSS z-index、modal lifecycle、履歴・scroll lockを照合して意図と原因を分ける。
2. 比較案から最小安全修正を選び、回帰テストとversion更新を行う。
3. 静的・自動・モバイル相当のUI確認とrelease guardrailを通す。
4. commit/push、Preview、main統合、Production公開確認を行う。
5. 結果、未検証境界、Rizo接続を記録しsealed archive化する。

## 検証方法

- CSSとDOMの静的テストで、ヘッダーのstacking levelがBootstrap modal backdropより低いことを確認する。
- `npm run check`で既存テスト、機密情報scan、Pages Functions buildを確認する。
- モバイルviewportで詳細モーダルの固有ヘッダー、背景メニュー非表示、close後の復帰を確認する。
- Preview/Productionのsource SHA、公開`APP_VERSION`、rootとsession APIのHTTP応答を確認する。

## 戻し方

- コードはmain統合コミットをrevertして再デプロイする。
- DB変更はない。表示階層だけを元のheader z-indexへ戻せる差分に限定する。

## 許可境界

- ユーザーから実装、main統合、本番デプロイまで明示許可済み。
- API/DB、secret、認証設定、外部通知は変更しない。

## Git / 作業ツリー境界

- current branch: `codex/modal-header-layering`
- upstream: `origin/codex/modal-header-layering`
- pre-existing changes to preserve: なし。開始時mainはcleanで`origin/main`と同一。

## 実装判断

- モバイルの詳細モーダルは独自の戻る操作とタイトルを持つため、グローバル上部メニューの同時前面表示は意図しない。
- 観測事実はglobal header `1080/1100`、Bootstrap 5.3.2 modal backdrop `1050`、modal `1055`。ヘッダーがmodal headerを覆うstacking不整合が原因。
- modal側を引き上げる案は画像ビューア`1080`をmodal背面へ落とすため不採用。JSでheaderを隠す案より、global navigationをBootstrap標準のoverlay層より下へ戻す方が責務に沿う。

## Test matrix

- static: z-index階層、detail modal固有header、version同期、diff check。
- automated: 全27件（新規modal layering regression 2件を含む）、predeploy scan、Functions build。
- manual UI: mobile viewportでloading/detail/close、タスク・新規作成modal、画像ビューアを確認。
- live: Preview/Production source、version、root/session API。実データの変更操作は行わない。

## High-risk boundary

- 全画面modal、safe-area、PWA cache、history/scroll lockが影響境界。DOM構造やlifecycle JSは変更せずCSS階層の最小差分を優先する。
- ProductionはGit連携でmain push後に自動deployされるため、二重direct deployを行わない。

## Rizo接続

- 接続分類: `evidence_asset` / `failure_prevention`。
- 増える資産: 現場向けPWAで、global navigationと一時的overlayの責務を分ける実装・回帰テスト。
- 接続しないもの: 記事公開やVault直接更新は今回行わず、repo実装とsealed Planを正本にする。

## 完了後レビュー

### 結果

- status: `complete`
- グローバルヘッダーをmobile/desktopとも`z-index: 1040`へ揃え、Bootstrapの`backdrop 1050 / modal 1055`より背面へ戻した。
- 画像ビューア`1080`は維持し、詳細モーダル上の添付画像表示を壊していない。
- メッセージ詳細のタイトル関連付け、装飾アイコン除外、多言語対応の非表示「戻る」ラベルを追加した。
- `APP_VERSION`を`1.10.1`へ更新した。API、DB、migration、認証、環境変数は変更していない。

### 検証結果

- `npm run check`: 27/27 tests、predeploy secret scan、Pages Functions buildが成功。
- `git diff --check`とversion同期テストが成功。
- mobile viewport `390 x 844`のlocal/Preview/Productionで、`header 1040 < backdrop 1050 < modal 1055 < image viewer 1080`をcomputed styleで確認した。
- modal固有headerが画面上端のhit targetになること、Tab focusがmodal内に留まること、画像viewerがmodalより前面に出ること、close後にheaderと`modal-open`が復帰することを確認した。
- Preview source `6d14f6d`、Production source `f5d2f3e`がActive。公開root、`app-config.js`、`sw.js`、`/auth/session`がHTTP 200で、公開版`1.10.1`と新しいDOM/CSSを確認した。

### 未検証境界

- 実ユーザーの認証済みデータは変更せず、テストログインのfixtureで詳細表示を確認した。
- 実機iOS Safari/PWAのタッチ操作は未実施。Chromiumのmobile viewport、production static assets、Service Worker version更新で境界を補った。

### 独立レビュー / CodeGraph

- 2系統の独立監査で、前面表示が不具合でありglobal headerをoverlay層より下へ戻す判断に合意した。最終レビューで固定日本語ARIA labelを検出し、既存i18nの非表示ラベルへ修正した。
- CodeGraph `0.9.9`は26 JavaScript files / 575 nodes / 2,327 edgesでindex current、`.codegraph/`はignore済み。inline HTML/CSSは索引対象外のため、`rg`、直接読解、Bootstrap固定CSS、静的テスト、実ブラウザcomputed styleで補完した。

### Rizo再利用

- 使った知識: Repo Work Context、Operating Loop、Git branch Failure、release/Cloudflare/PWAの既存手順。
- 今回増えた資産: `実績素材` / `失敗予防`。global navigationと一時overlayの標準階層、および回帰テスト。
- 更新候補: 同種の重なりが再発した場合、overlay layer mapをProject Skillまたは共通Failureへ昇格する。
- 接続しないもの: Vault、記事、公開文は直接更新しない。repo実装とsealed Planを正本にする。
- 次に改善するループ: 実機iOSでのrelease smoke testを再利用可能なチェック項目へ加える。

### 戻し方

- mainの統合commit `f5d2f3e`を新しいrollback branchで`git revert`し、検証後mainへ統合・pushする。
- DB変更はないためdata rollbackは不要。旧Service Workerへ戻す場合もversionを新たに上げて再配布する。

<!-- plan-source-end -->
