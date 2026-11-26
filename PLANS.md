---
status: "idle"
owner: "."
profile: "rizo"
last_archive: ".plans/2026-07-13-page-navigation-release-1103.md"
updated_at: "2026-07-13"
---

# PLANS.md

## 現在のタスク

現在進行中のタスクはありません。

## 最新の固定保存

- `.plans/2026-07-13-page-navigation-release-1103.md`

## 再開ルール

- 新しい作業はcurrent task 1件として開始する。
- 過去作業の続きは明示された場合だけ該当archiveを読み、新しいPlanを作る。
- sealed archiveへ追記しない。

## ダークモードの視認性 / 2.3.13

白いステータスバー脇の背景はルート・safe area・ブラウザ指定色を暗色面に揃える。下部ナビと作成フォームのボタンは暗色用の文字・枠・選択色を指定し、認証・保存・DB・通知は変えない。検証は `npm run check` とスマートフォン幅で通常画面・全画面フォーム・ライトテーマの比較。iOSが描画する時計や通信表示の色は実機でのみ判定可能。問題時は前の表示に戻した上で版を上げ、GitHubとPagesを同じコミットに揃える。
