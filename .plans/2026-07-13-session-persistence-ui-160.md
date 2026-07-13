---
plan_id: "2026-07-13-session-persistence-ui-160"
title: "ログインセッション半永続化と管理UIブラッシュアップ"
status: "complete"
owner: "."
profile: "dev"
opened_at: "2026-07-13"
closed_at: "2026-07-13"
archived_from: "PLANS.md"
source_lines: 124
source_sha256: "bdb58ac350376172fdf47494f6bc74f9315a5418d6ede7512ae02a5bcadb784b"
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
plan_id: "2026-07-13-session-persistence-ui-160"
status: "active"
owner: "."
profile: "dev"
opened_at: "2026-07-13"
continuation_of: null
archive_visibility: "local_private"
---

# ログインセッション半永続化と管理UIブラッシュアップ

## 現在のタスク

- Google OAuth を初回本人確認に限定し、ShiftFlow の KV セッションでログインを半永続化する。
- 管理メニューとメッセージ操作カードを既存情報設計のまま整理し、1.6.0として本番配布する。

## 目的

- 初回ログイン後は PWA 再起動や翌日以降の再訪でも、期限内なら即座にアプリを使える状態にする。
- 既存のGoogleログイン導線、主要画面遷移、業務操作を変えず、管理画面とカード群の視認性・一貫性を高める。

## 成功条件

- Google ID token の約1時間期限に依存せず、Cookie + APP_KV + D1権限で通常APIを継続利用できる。
- セッションは30日無操作、最長90日を上限とし、手動ログアウト・無効セッション・権限停止が即時反映される。
- 削除・権限変更はGoogle再認証ではなく、対象と結果が分かる確認モーダルを必須にする。
- 管理メニュー、メッセージカード、キーワード検索、未読絞り込み、すべて既読操作の階層と色が統一される。
- 背景は崩れにくい単純なレイヤーへ整理し、既存ブランド色を保った控えめなガラス感を加える。
- `frontend/public/app-config.js` と `frontend/public/sw.js` が `1.6.0` で一致する。
- 静的、認証回帰、権限、UI、PWA、デプロイ後の本番確認を完了する。

## 再利用した知識

- 2026-07-12 のセッション監査: refresh応答でID tokenが保証されず、初回Cookie 7日とKV 30日が不整合だった。
- ShiftFlow Vault: Cloudflare Pages Functions、APP_KV、D1を現行アーキテクチャの正本として維持する。
- repo `AGENTS.md`: フロント変更時にAPP_VERSIONを更新し、PWAキャッシュ影響を検証する。
- Git安全運用: 既マージ済みの古いブランチではなく最新origin/mainからremote-tracked branchを作る。

## Scope

- `functions/auth/*`、`functions/utils/session.js`、`functions/api/[[route]].js` のセッション認証整理。
- セッション回帰テストと必要なテスト基盤の追加。
- `frontend/public/index.html`、`app-config.js`、`sw.js` の限定的なUI/PWA更新。
- 認証・管理画面・メッセージ操作・確認モーダル周辺の不具合監査と同一scope内の修正。
- READMEとセッション設計文書の実装同期。
- Cloudflare Pagesへのデプロイと本番スモーク確認。

## 非スコープ

- DB schema変更、Google Calendar/Drive等の新規連携、全面的な画面再設計。
- 既存ユーザー・組織・監査ログデータの削除。
- ユーザーが事前に変更していた `.DS_Store` と `AGENTS.md` の編集・コミット。

## 実行計画

1. 認証、権限、管理UI、メッセージ操作、確認モーダルをコード・実画面で監査する。
2. ShiftFlow独自セッションへAPI認証を切り替え、期限・Cookie・logoutを統一する。
3. 削除・権限変更の確認モーダルを漏れなく適用する。
4. 管理メニューとメッセージ操作カードを既存UIに沿ってブラッシュアップする。
5. 1.6.0へ更新し、テスト・ブラウザ確認・リリースガードレールを実行する。
6. Cloudflareへデプロイし、本番スモーク確認後にPlanをclose/archiveする。

## 検証方法

- 認証: 新規/既存/失効/改ざん/無操作/絶対期限/logout/停止ユーザーを自動テストする。
- 権限: CookieセッションでもD1のactive membershipとrole判定を迂回できないことを確認する。
- UI: desktop/mobileで管理、メッセージ一覧、検索・未読・全既読、確認モーダルをスクリーンショット比較する。
- PWA: APP_VERSION一致、Service Worker構文、主要アセット、更新導線を確認する。
- 本番: `/`、`/auth/session`、静的アセット、レスポンスヘッダー、デプロイ版を匿名スモーク確認する。

## 戻し方

- 変更コミットをrevertし、直前のCloudflare Pages deploymentへrollbackする。
- セッション形式は既存Cookie名を維持し、必要ならnamespace/versionで旧セッションを一度だけ無効化する。
- DB migrationは行わないため、データrollbackは不要。

## 許可境界

- ユーザーは実装、監査修正、バージョン1.6.0、Cloudflareデプロイまでを明示許可済み。
- GitHub branchへのpushとCloudflare Pagesデプロイは依頼範囲内。
- secret値の表示・変更、DBデータ削除、DNS変更、Google Cloud設定変更は行わない。

## Git / 作業ツリー境界

- current branch: `feature/session-persistence-ui-1.6.0`（`origin` tracking済み）
- branch base: 最新 `origin/main`。
- pre-existing changes to preserve: `.DS_Store`、`AGENTS.md`。
- rollback: 本タスクのコミット単位でrevertし、ユーザー差分は触らない。

## 実装判断

- Google OAuth/OIDCは初回本人確認と再ログインに使い、通常API認証はサーバー側セッションへ分離する。
- Google tokenはGoogle API利用がない現状では通常セッション更新に使わない。
- 重要操作は再認証ではなく、操作対象と不可逆性を示す確認モーダルで守る。
- UIは既存ブランドと情報構造を維持し、色・境界・透過・余白の一貫性だけを高める。

## Test matrix

- static: JavaScript構文、predeploy scan、version整合、秘密情報scan。
- automated: session helper/handler/API認証の単体・統合回帰、確認モーダルの呼出経路検査。
- manual UI: desktop/mobileの主要画面、light/dark、管理メニュー、検索/未読/全既読、モーダル。
- live: 認証済みユーザーデータは変更せず、匿名endpointと静的配信を確認する。
- production: deployment URLとcanonical URLのversion/headers/auth-session応答を確認する。
- user acceptance: 実ユーザーによる翌日再訪はデプロイ後の継続確認項目として残す。

## High-risk boundary

- trust boundary: browser cookie -> Pages Functions -> APP_KV -> D1 membership/role。
- release blocker: サーバー側のtenant/role判定、改ざんCookie拒否、失効判定、ログへのtoken非出力。
- KVはeventual consistencyのため、ログアウト/権限停止をD1再確認で補強し、session値に権限を固定しない。

## 完了後レビュー

- 実装: Google OAuthはcallback時の本人確認だけに限定し、Google tokenを保存しないShiftFlow session v2へ移行した。アイドル30日、絶対90日、Cookie最大30日、旧Domain Cookieの失効と旧v1 sessionの安全な一回移行を実装した。
- 認証・権限: 通常APIはhost-only SESSION CookieとAPP_KVを検証し、D1 membership/role/statusを毎回確認する。組織境界、管理ユーザー更新、監査ログ、添付の親リソース認可、OAuth login CSRF、APIレスポンスキャッシュを修正した。
- UI: 削除・権限変更・一括既読を履歴と背面modalを壊さないnative dialog確認へ統一した。管理panelのhidden/inert、desktopのmobile nav混入、メッセージ検索race・大小文字・一括既読scope、カード色を修正した。
- デザイン: 既存ブランドと情報構造を維持し、半透明surface・共通border/shadowへ整理した。背景gradientとbackdrop blurは実画面で合成崩れが出たため採用せず、単色背景へ戻した。
- version: `frontend/public/app-config.js` / `sw.js` / READMEを`1.6.0`へ同期した。Service WorkerはAPI/Authをキャッシュせず、旧cacheを即時削除し、app shell更新はversion別cacheとnetwork reloadで行う。
- 検証: 13件のNode test、`npm audit` 0件、secret scan、inline script構文、`wrangler pages functions build`、`git diff --check`を通過した。desktop/mobile、light/dark、管理、メッセージ、nested modal上の確認dialogをagent-browserで確認した。
- release: commit `22539e6`を`origin/feature/session-persistence-ui-1.6.0`へpushし、Cloudflare Pages productionへdeployした。deployment URLは`https://de060f0a.shiftflow.pages.dev`、canonicalは`https://shiftflow.pages.dev`。
- production smoke: `/` 200、`sw.js` 200かつno-store、APP_VERSION 1.6.0、匿名`/auth/session` 200/no_session、host-only/旧Domain失効Cookieの2本、production test modeのメッセージ/管理画面を確認した。
- 未検証: 実利用者が翌日以降に再訪してGoogle画面を経由しないことは時間経過を伴うため、運用観測項目として残す。自動テストではGoogle通信なしのsession再利用を確認済み。
- rollback: commitをrevertし、Cloudflare Pagesの直前deploymentへrollbackする。DB migrationとデータ削除は実施していない。

<!-- plan-source-end -->
