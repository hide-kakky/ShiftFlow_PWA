---
plan_id: "2026-07-13-mobile-chrome-navigation"
title: "スマホUIとタップ遷移の統一"
status: "complete"
owner: "."
profile: "dev"
opened_at: "2026-07-13"
closed_at: "2026-07-13"
archived_from: "PLANS.md"
source_lines: 109
source_sha256: "f53837725868337c666249da8074a361d38f26941ac548302071d9b4cd215077"
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
plan_id: "2026-07-13-mobile-chrome-navigation"
status: "active"
owner: "."
profile: "dev"
opened_at: "2026-07-13"
continuation_of: null
archive_visibility: "local_private"
---

# スマホUIとタップ遷移の統一

## 現在のタスク

- スマホのシステムバーと下部ナビゲーションを画面へ馴染ませ、画面遷移を下部メニューのタップだけに統一する。

## 目的

- 上部ステータスバーの白浮き、下部メニューバーの高すぎる位置、青みのあるFAB、意図しない横スワイプ遷移を解消する。

## 成功条件

- iOS/Android PWA向けのステータスバー指定と背景色がアプリ背景に整合する。
- 下部メニューが safe area を守りながら、現在より画面下端寄りに配置される。
- FABが既存ブランドの暖色系で統一され、青系のグラデーションを含まない。
- 横方向のtouch操作で画面遷移せず、下部メニューのタップでは従来どおり遷移できる。
- `APP_VERSION` を `1.9.1` に揃え、静的検査、テスト、Functions buildが通る。

## 再利用した知識

- `git-branch-safety`: 統合後のmainを直接編集せず、remote-tracked branchへ分離した。
- `codegraph-local-code-intelligence`: semantic indexで候補を絞り、inline HTML/CSS/JSは`rg`と直接読解で最終確認する。
- repo固有ルール: フロント変更時は`sw.js`と`app-config.js`の`APP_VERSION`を同期し、READMEにも反映する。
- 過去のShiftFlow監査: docsだけを実装証拠にせず、実コードとテストで照合する。

## Scope

- `frontend/public/index.html` のPWA metadata、モバイル下部ナビ、FAB、画面遷移イベント。
- `frontend/public/app-config.js`、`frontend/public/sw.js`、`README.md` のバージョン同期。
- 必要な回帰テストとPlan close-out。

## 非スコープ

- 認証、API、DB、Cloudflare設定、実データ、デプロイ。
- 下部メニューの項目構成や各画面の業務機能変更。

## 実行計画

1. CodeGraphと直接検索でmetadata、bottom nav、FAB、swipe処理、既存テストを特定する。
2. 最小差分で見た目と入力経路を修正し、不要になったswipe専用処理を安全に除去する。
3. `APP_VERSION=1.9.1`へ同期し、構文、テスト、ビルド、モバイル表示を検証する。
4. 結果をPlanへ反映し、sealed archiveを作成してcurrent planをidleへ戻す。

## 検証方法

- metadata/CSS/JSの直接読解と`rg`で、青系FAB指定とswipe listenerの残存がないことを確認する。
- `git diff --check`、HTML内script構文確認、`npm test`、predeploy scan、Pages Functions build。
- 可能な範囲でモバイルviewportの画面表示と下部メニューのタップ遷移を手動確認する。

## 戻し方

- この作業ブランチのコミットをrevertする。`main`や既存archiveを巻き戻さない。
- PWAキャッシュが残る場合は、旧versionへ戻すのではなくrevert commitで新しい`APP_VERSION`を発行する。

## 許可境界

- ユーザーが明示したUI修正、ローカル検証、作業ブランチへの通常実装まで。
- デプロイ、mainへの追加統合、外部公開は今回の許可に含めない。

## Git / 作業ツリー境界

- current branch: `codex/mobile-chrome-navigation`（`origin/codex/mobile-chrome-navigation`を追跡）
- pre-existing changes to preserve: なし。元ブランチの`.DS_Store`生成差分は統合対象外としてstashに退避済み。

## 実装判断

- safe areaを消さず、余分な持ち上げ量だけを減らす。
- 画面遷移APIは維持し、touch swipeの入力経路だけを除去してタップ遷移へ統一する。
- 認証画面を含む全テーマ経路のiOS指定を`black-translucent`へ揃え、manifestの起動背景をlight surfaceへ合わせた。
- 下部バーの追加余白を12pxから2pxへ縮め、左右のsafe areaも最終上書きCSSへ反映した。
- FABは既存の暖色`--fab` tokenをlight/dark両方で使い、青いgradient・halo・shadowを除去した。
- 通常画面と管理画面の横スワイプlistener、専用state、死んだguard属性を削除し、縦Pull-to-Refreshは維持した。

## Test matrix

- static: `git diff --check`、predeploy scan、metadata/CSS/event listener/version同期を確認済み。
- automated: `npm run check`成功（Node test 16/16、secret scan、Pages Functions build）。HTML内script 6/6構文成功。
- manual/live: ローカル390x844でbottom navを確認。footerはbottom=844px・height=60px・padding-bottom=2px、FABはlight `rgb(232, 93, 106)` / dark `rgb(241, 111, 162)`。
- interaction: homeからtasks/messages/settingsへのタップ遷移を確認。settings上で横touchを合成してもactive/visible viewはsettingsのまま、Pull-to-Refreshも非表示を維持。
- 未検証: 実機iOS/AndroidのOSステータスバー、safe-area、本番PWA、デプロイ。

## High-risk boundary

- Service Workerのキャッシュキー更新を伴う。3箇所のversion不一致を残さない。
- safe area対応を外すとノッチ/ホームインジケータへ重なるため、端末余白は維持する。

## Rizo接続

- 接続分類: `evidence_asset`
- 増える資産: スマホ現場利用でのPWA操作性改善と検証境界。
- 接続しないもの: 未検証の実機効果や本番効果は実績として扱わない。

## 完了後レビュー

- status: complete
- 成果: 白浮きの再発経路、下部バーの余分な高さ、FABの青色上書き、2系統の横スワイプ遷移を解消した。
- 検証: CodeGraph 0.9.9（JavaScript 23 files / 523 nodes）で索引を確認。inline HTML/CSS/JSは`rg`、直接読解、自動テスト、ローカルブラウザで補完した。
- 反省と改善: UI本体がinline HTMLのためCodeGraph単独では追えない。画面遷移入力とversion同期を静的回帰テストへ追加し、次回の見落としを防ぐ。
- 残課題: 実機のOS chromeは開発ブラウザで再現できないため、iOS/Androidで更新受諾後のcold launchを確認する。

<!-- plan-source-end -->
