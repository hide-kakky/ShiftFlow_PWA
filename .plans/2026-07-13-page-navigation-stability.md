---
plan_id: "2026-07-13-page-navigation-stability"
title: "ページ遷移の安定化と画面見切れ防止"
status: "complete"
owner: "."
profile: "dev"
opened_at: "2026-07-13"
closed_at: "2026-07-13"
archived_from: "PLANS.md"
source_lines: 106
source_sha256: "73bd6ff7706104049890f60f0070a8f268a53dcb4f981b4f2cfc2b3ac5a7d7d1"
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
plan_id: "2026-07-13-page-navigation-stability"
status: "active"
owner: "."
profile: "dev"
opened_at: "2026-07-13"
continuation_of: null
archive_visibility: "local_private"
---

# ページ遷移の安定化と画面見切れ防止

## 現在のタスク

- 4画面を横並びにして移動するスライド方式を、選択画面だけを即時表示する方式へ置き換える。

## 目的

- ページ遷移のカクつき、終了待ち、隣接画面の見切れを構造的に解消する。

## 成功条件

- ホーム・タスク・メッセージ・設定の切替で、常に1画面だけが表示・操作可能になる。
- 画面切替に transform、transitionend、固定タイマー待ちを使わない。
- ブラウザ履歴、各画面のデータ読込、下部ナビの選択状態を維持する。
- 自動テストとモバイル幅のブラウザ確認を通す。
- `APP_VERSION` を設定・Service Worker・READMEで一致させる。

## 再利用した知識

- `CODEx_PROMPT.md`: フロント変更時のバージョン同期、検証、ロールバック契約。
- `codegraph-local-code-intelligence`: CodeGraph 0.9.9で27 JavaScriptファイルを確認。遷移本体はHTML内インラインコードのため、直接読解とテストを証拠にする。
- `Repo_Work_Context.md` / `Operating_Loop.md`: ShiftFlowの現場改善実績と失敗予防へ接続し、検証境界を残す。
- 添付画像: 設定画面左端に前画面のカード端が見切れる現象を受入条件へ反映した。

## Scope

- `frontend/public/index.html` の通常画面ナビゲーションCSS/JavaScript。
- `tests/mobile-navigation.test.mjs` の回帰テスト。
- `frontend/public/app-config.js`、`frontend/public/sw.js`、`README.md` のバージョン同期。
- `PLANS.md` と完了時のsealed archive。

## 非スコープ

- 管理画面内部のセクション切替、認証、DB、API、デプロイは変更しない。
- データ取得処理や画面内容のデザイン変更は行わない。

## 実行計画

1. 横並び・transform・transition待ちに依存する箇所を除去する。
2. 非選択パネルを `display: none` / `hidden` / `inert` で隔離し、選択パネルを同期的に表示する。
3. 回帰テストを追加し、APP_VERSIONをbugfixとして更新する。
4. 静的テスト、全テスト、事前スキャン、ブラウザで連続切替を確認する。

## 検証方法

- static: 不要になったtransition変数・関数・`translate3d`参照がないことを`rg`で確認する。
- automated: `npm test`、`node scripts/predeploy-scan.js`、可能なら`npm run check`。
- manual UI: モバイル幅で4画面を連続切替し、表示パネル数、左右オーバーフロー、コンソールエラーを確認する。

## 戻し方

- 今回の差分だけを逆適用し、APP_VERSION 3ファイルを元の値へ戻す。既存archiveや他機能は変更しない。

## 許可境界

- repo内の実装・テスト・Plan更新まで。デプロイ、外部公開、Vault更新は行わない。

## Git / 作業ツリー境界

- current branch: `main`（`origin/main`追跡）
- pre-existing changes to preserve: 作業開始時はなし。

## 実装判断

- スライドの微調整では、前後画面の同時描画と終了待ちが残るため、画面アニメーションを廃止する。
- ナビアイコンの短い選択表現は残し、操作反応は即時にする。
- `hidden`と`inert`を併用し、視覚だけでなくキーボード・支援技術の操作対象も1画面へ限定する。

## Test matrix

- static: complete。旧スライド用の変数・関数・`translate3d`・`is-moving`参照が実装からなく、`git diff --check`も通過した。
- automated: complete。`npm run check`で28テスト、秘匿情報スキャン、Pages Functions buildがすべて成功した。
- manual/live: complete（ローカル・テストユーザー）。390×844で6回連続切替し、各時点の表示・操作可能パネルは1、横オーバーフロー0px、transformなし、JavaScript error 0件を確認した。

## High-risk boundary

- Service Workerの版更新はキャッシュ更新を伴う。3正本の一致テストと既存更新導線を維持する。
- デプロイは今回の許可範囲外。

## 完了後レビュー

- status: complete
- 実施結果: スライド遷移、遷移終了待ち、画面幅の再計算を廃止し、選択画面だけを同期表示する方式へ変更した。
- 見切れ防止: 非選択画面を初期HTMLと切替処理の両方で `display:none` / `hidden` / `inert` / `aria-hidden` にし、隣接画面が描画・操作対象へ残らないようにした。
- 操作感: 画面本体のアニメーションは廃止し、下部メニューの選択表現だけを維持した。データ読込、履歴、スクロール位置リセットは従来契約を維持した。
- PWA: `APP_VERSION=1.10.3` で設定、Service Worker、READMEの一致を確認した。
- 未検証: 本番デプロイ後の実機iOS PWA確認は未実施。デプロイは今回の許可範囲外。
- ローカル警告: 静的サーバーには認証/APIがないため設定・認証404警告が出たが、テストユーザーモードの画面切替ではJavaScript errorは発生しなかった。

## Rizo接続

- 接続分類: `failure_prevention` / `evidence_asset`
- 増えた資産: スマートフォン向け業務PWAで、装飾的な横スライドより表示対象を1画面へ隔離する方が安定性を優先できる実装・検証例。
- 保存先: 対象repoのコード、回帰テスト、sealed Plan。Vaultとpublishは更新しない。
- 反省と改善: UI遷移はアニメーションの見栄えだけでなく、同時描画数・終了待ち・連続操作時の状態一貫性を受入条件に含める。

<!-- plan-source-end -->
