---
plan_id: "2026-07-13-footer-nav-instagram-inset"
status: "active"
owner: "."
profile: "dev"
opened_at: "2026-07-13"
continuation_of: null
archive_visibility: "local_private"
---

# 下部メニューの下端位置調整

## 現在のタスク

- Instagram の下部ナビゲーションを比較基準に、ShiftFlow のモバイル下部メニューを安全領域内で約 12px 下げ、本番へ反映する。

## 目的

- iPhone のホームインジケータを避けつつ、下部メニューの余白を Instagram に近い密度へ揃える。

## 成功条件

- 下部メニューが現状より約 12px 下がり、ホームインジケータと重ならない。
- safe-area が 0px の端末でも 4px の最低余白を維持する。
- 通常画面・管理画面・FAB・本文下端余白が同じ下端基準を使う。
- APP_VERSION を更新し、静的検査・自動テスト・モバイル表示確認・本番デプロイを完了する。

## 再利用した知識

- `CODEx_PROMPT.md` の Service Worker / APP_VERSION 更新契約。
- `git-branch-safety` の clean main から作業ブランチを作る手順。
- `codegraph-local-code-intelligence` で JavaScript 依存を先に確認し、CSS は `rg` と直接読解で補完する境界。
- 過去コミットの safe-area 対応を維持し、固定値だけでホームインジケータ領域へ侵入しない設計。

## Scope

- `frontend/public/index.html` の下部ナビゲーション下端 inset と連動レイアウト。
- `tests/mobile-navigation.test.mjs` の回帰テスト。
- APP_VERSION と README の同期。
- `design-qa.md` の比較検証記録。

## 非スコープ

- 下部メニューの横幅、色、アイコン、項目構成の変更。
- Instagram の外観そのものの複製。
- 認証、DB、API、通知ロジックの変更。

## 実行計画

1. 添付画像と現在 CSS を比較し、下端余白の設計値を決める。
2. safe-area を尊重する共通 inset へ置き換え、関連レイアウトとテストを同期する。
3. APP_VERSION を上げ、静的検査・自動テスト・モバイル表示・比較画像で確認する。
4. feature branch を push、main へ統合し、Cloudflare Pages 本番とバージョンを確認する。

## 検証方法

- `npm run check`
- 390x844 のモバイル viewport で通常画面の下部メニュー位置、主要タップ、コンソールエラーを確認する。
- 添付画像の下部領域と実装スクリーンショットを並べ、ホームインジケータとの距離を比較する。
- Cloudflare Pages の deployment source と `/api/version` を確認する。

## 戻し方

- feature branch の実装コミットを revert し、APP_VERSION を再度上げて再デプロイする。

## 許可境界

- ユーザーがコード変更、ブランチ作成、main 統合、本番デプロイまで明示許可済み。
- secret、DB データ、認証設定は変更しない。

## Git / 作業ツリー境界

- current branch: `codex/footer-nav-instagram-inset`
- pre-existing changes to preserve: なし（開始時に main / origin/main の同期と clean を確認済み）

## 実装判断

- 比較画像では ShiftFlow の下部メニューが Instagram より約 12〜14 CSS px 高いと判断した。
- `safe-area-inset-bottom` を無視せず、`max(4px, safe-area - 12px)` を共通 inset として使う。これにより iPhone では安全領域へ 12px だけ寄せ、safe-area がない端末では最低 4px を残す。

## Test matrix

- static: version 三点同期、CSS inset 契約、差分確認
- automated: `npm run check`
- manual/live: ローカル・preview・production のモバイル viewport、主要タップ、コンソール、`/api/version`

## High-risk boundary

- Service Worker / PWA キャッシュと本番デプロイ。APP_VERSION 更新、deployment source、production version の三点で誤配信を防ぐ。

## 完了後レビュー

未実施。
