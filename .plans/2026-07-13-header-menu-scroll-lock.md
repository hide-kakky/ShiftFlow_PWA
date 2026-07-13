---
plan_id: "2026-07-13-header-menu-scroll-lock"
title: "ヘッダーメニュー表示中の退避防止"
status: "complete"
owner: "."
profile: "rizo"
opened_at: "2026-07-13"
closed_at: "2026-07-13"
archived_from: "PLANS.md"
source_lines: 86
source_sha256: "7bd019ea98dd19c46cf2612c7f877e35e1e4d63600a192f1d443abaaa829c380"
continuation_of: "2026-07-13-scroll-linked-header-fade"
supersedes: null
archive_visibility: "local_private"
sanitized: true
immutable: true
read_policy: "explicit_continuation_or_promotion_audit"
---

# Sealed Plan Snapshot

<!-- plan-source-begin -->
---
plan_id: "2026-07-13-header-menu-scroll-lock"
status: "active"
owner: "."
profile: "rizo"
opened_at: "2026-07-13"
continuation_of: "2026-07-13-scroll-linked-header-fade"
archive_visibility: "local_private"
---

# ヘッダーメニュー表示中の退避防止

## 現在のタスク

- ヘッダー内のBootstrap dropdownまたはフォルダselectを開いたままスクロールした際、header auto-hideが動いてメニュー配置が崩れる競合を防ぐ。

## 目的

- メニュー表示のライフサイクルをheader auto-hideより優先し、開いている間はtranslate／opacity／停止後収束を完全にロックする。

## 成功条件

- タスク範囲メニューとoverflow menuを開いたまま下スクロールしても、メニューが表示されたままheaderのtop／opacity／offsetが変わらない。
- フォルダselectのネイティブpicker表示中もheaderを固定し、change／blur後に通常のauto-hideへ戻る。
- menuを閉じた直後に、表示前の予約済みsettleや古いhideProgressでheaderが急退避しない。
- 既存のスクロール連動フェード、上方向即表示、検索中固定を壊さない。
- `APP_VERSION`同期、既存テスト、静的検査、ローカルBrowser確認が成功する。

## 再利用した知識

- continuation: `.plans/2026-07-13-scroll-linked-header-fade.md` の`hideProgress`、110ms settle、検索／dropdown保護、縦スクロール中blur停止。
- CodeGraph 0.9.9は22 JavaScriptファイルを索引済みだが、対象は`index.html`内inline JavaScriptのため`rg`と直接読解を正本にする。

## Scope

- `frontend/public/index.html`: menu lock状態、Bootstrap lifecycle、native select lifecycle、CSS強制表示ガード。
- `frontend/public/app-config.js`、`frontend/public/sw.js`、`README.md`: `APP_VERSION`同期。
- ローカルBrowserでtask scope／overflow／folder selectと通常スクロールを確認し、Planを固定保存する。

## 非スコープ

- メニュー項目、配置、Liquid Glass外観、スクロール速度、タスク／メッセージ本文、API／DB／認証。
- 本番deploy、公開、commit、push、ユーザー差分`.DS_Store`／`AGENTS.md`、既存sealed archiveの追記。

## 実行計画

1. 現行のDOM `.show`判定だけでは拾いにくいメニュー開閉境界と予約済みsettleの競合を確認する。
2. Bootstrap dropdownとnative selectの表示中を明示的なlock状態にし、CSSでもtranslate／opacityを0／1へ固定する。
3. 各メニュー表示中の下スクロール、閉じた後の通常退避、検索中固定をBrowserと静的／既存テストで確認する。

## 検証方法

- Browser: task scope／overflowを開いたまま下スクロールし、menu show、aria-expanded、header rect top、opacity、offsetを前後比較する。message folder selectと閉じた後の通常退避も確認する。
- Static: inline script構文、重複ID、menu lifecycle、`APP_VERSION`同期、`git diff --check`。
- Regression: `npm run check`。
- 未検証: iOS／Android実機のnative picker、慣性スクロール、本番、実データ、deploy。

## 戻し方

- このPlanのmenu lock、イベント、CSSガード、version／docs差分だけを逆パッチまたは将来の当該commitのrevertで戻す。

## 許可境界

- ユーザーが依頼したヘッダーメニュー表示中の退避防止、必須version／Plan同期、ローカル検証までを実施する。
- deploy、外部送信、DB/API/認証変更、commit、pushは実施しない。

## Rizo接続

- 接続分類: `evidence_asset`
- 再利用した知識: header auto-hideは表示中のoverlay／menu lifecycleより優先しない。
- 増える資産: sticky headerとdropdownを同時利用する際の明示lockと予約処理取消の実装証拠。
- 接続しないもの: Bootstrap固有イベントを汎用モーション正本として昇格しない。
- 反省と改善: 毎scroll時のDOM照合だけでなく、openからhiddenまでを連続したUI状態として保護する。

## 完了後レビュー

- status: `complete`
- 実装: Bootstrap dropdownの`show`〜`hidden`を明示的なSetで保護し、native folder selectはpointer／keyboard／focus lifecycleで保護した。ロック開始時は予約済みsettleを取消し、hide progressを0へ戻す。クラスCSSと`:has()`対応環境のDOM CSSを分離した二重ガードでtranslate 0／opacity 1を強制した。
- Browser実測（390×845）: overflow menuとtask scope menuを開いたまま約206px下スクロールしても、`menuShow=true`、`aria-expanded=true`、`header--menu-open=true`、`top=0`、`opacity=1`、`offset=0.00%`を維持した。
- Browser実測（390×845）: message folder selectを開いて約188px下スクロールしても、select focusと`header--menu-open=true`、`top=0`、`opacity=1`、`offset=0.00%`を維持し、Escape後に検索へfocusを移すとlockが解除された。
- Browser回帰: dropdownを閉じるとlockは解除され、通常の下スクロールでは`navbar--hidden=true`、`opacity=0`、`offset=-112.00%`へ戻ることを確認した。検索表示中の固定も維持した。
- Static／Regression: inline script 6本の構文、287個のID重複なし、`git diff --check`、`APP_VERSION=1.8.4`同期、`npm run check`（13 tests、predeploy scan、Worker build）が成功した。
- 独立レビュー: ブロッカーなし。指摘された`:has()`非対応時のセレクタ無効化を`@supports`分離で修正し、native selectの`pointercancel`解除と派生classの自己保持防止を追加した。
- 証跡: ローカル監査ディレクトリへ`16-header-menu-scroll-lock-184.png`を保存した。
- 未検証境界: iOS／Android実機のnative picker、実機の慣性スクロール、本番、実データ、deploy。deploy／commit／pushは実施していない。
- ロールバック: `frontend/public/index.html`のmenu lock／event／CSS guard差分と、`app-config.js`／`sw.js`／READMEの1.8.4同期差分を逆パッチする。既存のLiquid Glass／header fade差分は残す。

<!-- plan-source-end -->
