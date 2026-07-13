---
plan_id: "2026-07-13-scroll-linked-header-fade"
title: "スクロール量に連動するヘッダーフェード"
status: "complete"
owner: "."
profile: "rizo"
opened_at: "2026-07-13"
closed_at: "2026-07-13"
archived_from: "PLANS.md"
source_lines: 99
source_sha256: "9ddfb8895f5b58e684b234a5463c4f825c8622e9c5f17d8bc7854fedfbf030e2"
continuation_of: "2026-07-13-liquid-glass-command-header"
supersedes: null
archive_visibility: "local_private"
sanitized: true
immutable: true
read_policy: "explicit_continuation_or_promotion_audit"
---

# Sealed Plan Snapshot

<!-- plan-source-begin -->
---
plan_id: "2026-07-13-scroll-linked-header-fade"
status: "active"
owner: "."
profile: "rizo"
opened_at: "2026-07-13"
continuation_of: "2026-07-13-liquid-glass-command-header"
archive_visibility: "local_private"
---

# スクロール量に連動するヘッダーフェード

## 現在のタスク

- ヘッダーがしきい値到達後に急に消える挙動を、下スクロール量と速度へ連動する移動＋透明度フェードへ変更する。上方向の即時再表示と操作中の固定は維持する。

## 目的

- 速い下スクロールでもヘッダーが瞬間的に消えず、スクロール量に応じて段階的に退避する。
- blur／filterを動かさず、`transform`と`opacity`だけで描画負荷を抑える。

## 成功条件

- 低速では長い距離と約320ms、高速では短い距離と最短約220msへ連続的に補間される。
- ヘッダーの移動量と透明度が途中状態を持ち、完全表示から完全非表示へ一括切替されない。
- 一覧途中の上スクロールで約130ms以内に全表示へ戻る。
- 検索、dropdown、ヘッダー内フォーカス中は全表示を維持する。
- `APP_VERSION`を同期し、既存テスト、静的検査、ローカル操作確認が成功する。

## 再利用した知識

- continuation: `.plans/2026-07-13-liquid-glass-command-header.md` の方向・速度対応header auto-hide、Liquid Glass描画境界、Browser検証。
- 既存の`requestAnimationFrame`とCSS custom propertyを再利用し、状態やイベントを増やし過ぎない。

## Scope

- `frontend/public/index.html`: header auto-hideの進捗計算、速度補間、transform／opacity CSS。
- `frontend/public/app-config.js`、`frontend/public/sw.js`、`README.md`: `APP_VERSION`同期。
- ローカルBrowserで低速／高速／1px上方向／検索中を確認し、Planを固定保存する。

## 非スコープ

- header commandの情報設計、タスク／メッセージ本文、API／DB／認証、Liquid Glass tokenの全面再設計。
- 本番deploy、公開、commit、push、ユーザー差分`.DS_Store`／`AGENTS.md`、sealed archiveの追記。

## 実行計画

1. 現行のしきい値後90〜145ms切替を、スクロール距離から0〜1の退避進捗を計算する方式へ置換する。
2. 進捗をheaderのtranslateとopacityへ反映し、速度から必要距離と補間時間を連続計算する。
3. 低速／高速／一覧途中の上方向／検索中をBrowserで確認し、静的・既存テストとPWA版同期を閉じる。

## 検証方法

- Browser: 低速下方向の途中opacity、完全退避時間、高速下方向の最短時間、一覧途中1px上方向、検索中の固定。
- Static: inline script構文、重複ID、`APP_VERSION`同期、`git diff --check`。
- Regression: `npm run check`。
- 未検証: iPhone／Android実機の慣性スクロールとPerformance trace、本番、実データ、deploy。

## 戻し方

- このPlanで追加するscroll-linked progress、opacity／transform、version／docs差分だけを逆パッチまたは将来の当該commitのrevertで戻す。

## 許可境界

- ユーザーが依頼したヘッダー遷移、必須version／Plan同期、ローカル検証までを実施する。
- deploy、外部送信、DB/API/認証変更、commit、pushは実施しない。

## Rizo接続

- 接続分類: `evidence_asset`
- 再利用した知識: 現場スマホUIでは固定時間だけでなく、指の操作量と画面応答を一致させる。
- 増える資産: scroll-linked fadeを軽量なtransform／opacityだけで実装・検証した証拠。
- 接続しないもの: 単一端末の感触を汎用モーション正本として昇格しない。
- 反省と改善: 数値上の高速化が体感上の自然さと一致しなかったため、しきい値切替より連続進捗を優先する。

## 完了後レビュー

- 状態: `complete`
- 実装結果:
  - 距離しきい値を超えた瞬間にclassで全退避する方式をやめ、下方向の各scroll frameから`hideProgress`（0〜1）を累積する方式へ変更した。
  - `hideProgress`からtranslate量とsmoothstepの透明度を算出し、CSS custom property経由で`transform`と`opacity`だけを更新する。blur／filterはアニメーション対象にしていない。
  - 下方向の速度を0〜1へ正規化し、完全退避までの距離を96〜62px、補間時間を320〜220msで連続的に変える。高速操作でも旧90msの瞬間退避にならない。
  - 上方向は距離をためず130msで全表示へ戻す。header内のfocus、検索panel、Bootstrap dropdown表示中も全表示を維持する。
  - スクロール停止110ms後に途中進捗を表示／非表示のどちらかへ収束させ、半透明・半移動のまま残らないようにした。縦スクロール中は`.navbar--scrolling`で実blur面の`.container-xl`だけblurを止める。
  - 完全非表示の論理classが先に付いてもフェード中の可視部分を操作できるよう、`pointer-events: none`は使わない。
- 検証結果:
  - Browser低速: 40px下スクロール中、70ms時点でrendered opacity `0.956`、200ms時点で`0.768`と段階的に変化し、停止後は中間状態を残さず非表示へ収束した。
  - Browser高速: 一括下スクロール開始40ms後もrendered opacity `0.924`を保ち、duration `220ms`で0へ到達するフェードを確認した。
  - Browser上方向: 一覧末尾付近から約1px戻すだけで非表示classが外れ、duration `130ms`でopacity 1／translate 0へ復帰した。
  - Browser操作保護: 検索panelを開いたまま末尾へ移動してもtarget/rendered opacity 1、header表示を維持した。
  - Browser描画負荷: 縦スクロール中は子glass面のcomputed backdrop-filterが`none`、停止後だけ`saturate(1.65) blur(22px)`へ戻ることを確認した。フェード中もcomputed pointer-eventsは`auto`だった。
  - 独立レビュー: 初回指摘の「中間状態残留」「可視中の操作不能」「縦スクロール中blur継続」を修正後に再確認し、P1/P2残件なし。
  - `npm run check`: Node test 13件成功、predeploy scan成功、Wrangler Pages Functions build成功。
  - static: executable inline script 6本の構文解析、288 IDの重複なし、`git diff --check`成功。
  - `APP_VERSION`: `app-config.js`、`sw.js`、READMEを`1.8.2`へ同期。
- 未検証境界: iPhone／Android実機の慣性スクロールとPerformance trace、Cloudflare本番、実データ、deploy、ユーザー受入は未実施。
- ロールバック: このPlanの`hideProgress`／速度補間／opacity CSS／version差分だけを逆パッチまたは将来の当該commitのrevertで戻す。
- Knowledge Update判断: 前Planのモーション調整を連続進捗へ改善した局所知見であり、現時点ではVaultへ昇格せずsealed Planへ固定する。
- Rizo再接続: `evidence_asset`として、実環境フィードバックを数値高速化から操作量連動へ修正し、体感差を再検証した証拠を残す。

<!-- plan-source-end -->
