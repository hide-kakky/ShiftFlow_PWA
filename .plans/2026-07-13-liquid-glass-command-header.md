---
plan_id: "2026-07-13-liquid-glass-command-header"
title: "検索・フォルダ操作を集約したLiquid Glassヘッダー"
status: "complete"
owner: "."
profile: "rizo"
opened_at: "2026-07-13"
closed_at: "2026-07-13"
archived_from: "PLANS.md"
source_lines: 112
source_sha256: "a7c545f0114565ada3c2b10f76d18ba4f07ffa31b8059de4baba72ca141c4c04"
continuation_of: "2026-07-13-mobile-navigation-density"
supersedes: null
archive_visibility: "local_private"
sanitized: true
immutable: true
read_policy: "explicit_continuation_or_promotion_audit"
---

# Sealed Plan Snapshot

<!-- plan-source-begin -->
---
plan_id: "2026-07-13-liquid-glass-command-header"
status: "active"
owner: "."
profile: "rizo"
opened_at: "2026-07-13"
continuation_of: "2026-07-13-mobile-navigation-density"
archive_visibility: "local_private"
---

# 検索・フォルダ操作を集約したLiquid Glassヘッダー

## 現在のタスク

- タスク／メッセージの検索と絞り込みをヘッダーへ集約し、本文をカード一覧中心にする。ヘッダー、フッター、FABをLiquid Glassの原則に沿って改善し、ローカル画面を提示する。

## 目的

- スマホで一覧へ到達するまでの視覚ノイズと縦方向占有をさらに減らす。
- 頻用操作は1タップ、低頻度または誤操作リスクのある操作はoverflow menuへ分離する。
- glass表現をnavigation/control layerだけに限定し、カード本文の可読性を守る。
- 一覧の下スクロールでは速度に応じてヘッダーを早く退避し、上スクロールでは現在位置に関係なく即座に戻す。

## 成功条件

- タスク／メッセージの虫眼鏡から検索UIを開閉でき、閉じても入力値と絞り込み結果が保持される。
- タスク範囲とメッセージフォルダがヘッダーの同一パターンのプルダウンで切り替えられる。
- メッセージの「未読のみ」と「すべて既読」がoverflow menuから操作でき、一括既読は既存の対象範囲とAPI値を変えない。
- 本文上部に常設の検索／フォルダ操作カードがなく、320〜390px幅でカード一覧の視認範囲が増える。
- 下方向は短い移動または高速操作でヘッダーが退避し、上方向は一覧途中の1px相当の移動でも再表示する。検索／dropdown操作中はヘッダーを保持する。
- ヘッダー、フッター、FABがlight/dark、reduced motion、透明効果非対応環境で可読性を維持する。
- `APP_VERSION`を同期更新し、ローカル画面、既存テスト、静的検査で回帰がない。

## 再利用した知識

- continuation: `.plans/2026-07-13-mobile-navigation-density.md` の画面別ヘッダー、タスクscope、スワイプ軽量化、モバイル監査結果。
- `[[手順_実環境フィードバックをUI改善へ落とす]]`: 1画面1タスク、画面表示とAPI値の分離、実機未検証境界。
- `[[手順_Cloudflare_PWA運用]]`: フロント変更時のService Worker版同期。
- Apple Liquid Glass公式原則: glassはnavigation/control layerへ限定し、内容を主役にする。tintは主要操作へ選択的に使う。
- Product Design監査とCodeGraph: 現行画面の証拠、既存pattern、inline JavaScript索引外の補完境界。

## Scope

- `frontend/public/index.html`: ヘッダー検索popover、task scope、message folder、overflow menu、本文toolbar整理、Liquid Glass CSS、速度・方向対応のheader auto-hide、状態同期。
- `frontend/public/i18n.js`: 新しい操作名の日本語／英語。
- `frontend/public/app-config.js`、`frontend/public/sw.js`、`README.md`: `APP_VERSION`同期。
- 同一viewportでのbefore/after capture、操作確認、静的／既存テスト、Plan close。

## 非スコープ

- API、DB、認証、権限、フォルダ保存値、一括既読対象の業務仕様変更。
- 本番deploy、Cloudflare設定、実データ更新、Vault／codex-obsidianへの書き込み。
- 本文カードをglass化する全面テーマ変更、新規画像アセット、ネイティブiOS専用API。
- 既存のユーザー差分 `.DS_Store` と `AGENTS.md`、前タスク差分の整理やコミット。

## 実行計画

1. 現行1.7.0を390×844で再撮影し、ヘッダーと本文の占有量、操作順、支援技術名を確認する。
2. 頻度と誤操作リスクで検索／scope／folder／overflowの配置を確定し、既存DOMとイベントを最小変更する。
3. navigation/control layerへLiquid Glass tokenを適用し、非対応／dark／reduced motion fallbackと方向・速度対応のheader auto-hideを作る。
4. `APP_VERSION`を更新し、320／375／390px、主要操作、検索開閉、dropdown、overflow、一括既読の対象表示を検証する。
5. 既存テスト、静的検査、before/after比較を閉じ、sealed Planへ固定する。

## 検証方法

- Browser: 390×844のbefore/after、320／375pxのheader overflow、検索開閉、task/message dropdown、overflow menu、本文開始位置、低速／高速の下スクロールと一覧途中の1px上スクロール。
- Accessibility: heading、操作名、`aria-expanded`、選択状態、44px target、focus、コントラスト、reduced motion。
- Static: inline script構文、重複ID、旧toolbar残存、i18n、`APP_VERSION`同期、`git diff --check`。
- Regression: `npm test`、`scripts/predeploy-scan.js`。
- 未検証を分離: iPhone実機のbackdrop-filter／Performance trace、本番、deploy、実データは未実施。

## 戻し方

- このPlanで追加したheader controls、本文toolbar削除、Liquid Glass token、i18n、version、docs差分だけを逆パッチまたは当該コミットのrevertで戻す。
- `.DS_Store`、`AGENTS.md`、continuation元のsealed archiveは変更しない。

## 許可境界

- ユーザーが依頼したフロントUI、ローカル検証、必須のversion／Plan同期までを実施する。
- deploy、外部送信、公開、DB/API/認証変更、commit、pushは実施しない。

## Rizo接続

- 接続分類: `evidence_asset`
- 再利用した知識: 現場スマホUIの1画面1タスク化、検証済み／実機未検証の分離。
- 増える資産: 操作頻度と誤操作リスクからheaderへcommandを集約したShiftFlow改善証拠。
- 接続しないもの: Apple固有表現の模倣を汎用UI正本として昇格しない。
- 反省と改善: glassの見た目より本文一覧性と操作理解を先に検証し、実機差は次回確認点として残す。

## 完了後レビュー

- 状態: `complete`
- 実装結果:
  - 既存のタスク検索3種、担当者select、メッセージ検索、フォルダselect、未読checkbox、一括既読buttonのIDとイベントを保ったまま、ヘッダーのcommand layerへ再配置した。状態の複製やAPI値変更は行っていない。
  - タスクは「範囲dropdown + 検索 + overflow」、メッセージは「フォルダselect + 検索 + overflow」に統一し、本文の常設操作カードを削除した。overflowにはメッセージ固有の未読／すべて既読と、画面再読込、既存ユーザー操作を格納した。
  - 検索panelは`aria-expanded`、`hidden`、`inert`、Escape、focus復帰、入力中／絞り込み中の状態dotを持ち、task scope変更時も実入力へ追従する。
  - Liquid Glassはヘッダー／検索panel／フッターのnavigation-control面へ限定し、本文カードとmodalは不透明面へ戻した。非対応、contrast、reduced transparencyのfallbackを追加し、スワイプ中は`:has(.views-track.is-moving)`でblurを止める。
  - FABは高不透明度の青紫〜ピンクtintと拡散光を維持し、ユーザーフィードバックを受けて疑似要素とbutton borderの外縁ringを除去した。
  - header auto-hideをDOM構築後に確実に初期化するよう直した。下方向は通常12px、高速時4px（0.35px/ms以上）を目安に退避し、速度に応じて145／115／90msへ短縮する。上方向は一覧途中の1px相当でも100msで即再表示し、検索またはdropdown表示中は退避させない。
  - 一括既読確認文から「範囲」を除き、既存どおり選択フォルダを対象、検索語を対象外とする処理を維持した。
- 画面比較:
  - 390px幅でタスクカード開始位置は約142pxから約104pxへ、メッセージカード開始位置は約212pxから約104pxへ前進した。
  - 320px幅でも画面アイコン、scope／folder、検索、overflowが1行に収まり、dropdownと検索panelが操作できた。
- 検証結果:
  - `npm run check`: Node test 13件成功、predeploy scan成功、Wrangler Pages Functions build成功。
  - static: 実行可能inline script 6本を構文解析、289 IDの重複なし、`git diff --check`成功、不要説明文なし。
  - `APP_VERSION`: `app-config.js`、`sw.js`、READMEを`1.8.1`へ同期。
  - Browser: 390x844と320x700でtask scope、task/message search、message folder、unread toggle、overflow、light/dark、FAB外縁削除後の表示を確認した。さらに低速下スクロールで145ms、高速下スクロールで90msの退避、一覧途中の約1px上スクロールで100msの再表示、検索中のヘッダー保持を確認した。ローカルconsoleはGAS URL／session endpoint未設定の既知warningだけで、新規例外はなかった。
- 未検証境界: iPhone/Android実機のPerformance trace、iOSのReduce Transparency実機挙動、Cloudflare本番、実データ、deploy、ユーザー受入は未実施。
- ロールバック: このPlanのheader command、Liquid Glass、i18n、version差分だけを逆パッチまたは将来の当該commitのrevertで戻す。continuation元とユーザー差分`.DS_Store`／`AGENTS.md`は対象外。
- Knowledge Update判断: 既存のUIフィードバック手順とPWA運用手順で再利用できたためVaultは更新しない。配置判断、実測値、未検証境界をsealed Planへ固定する。
- Rizo再接続: `evidence_asset`として、現場スマホUIを操作頻度と誤操作リスクで再配置し、比較・回帰確認まで閉じた実績が増えた。公開素材化は別判断とする。

<!-- plan-source-end -->
