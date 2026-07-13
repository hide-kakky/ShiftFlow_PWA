# Design QA: 下部メニューの下端位置

## Source visual truth

- 添付比較画像: `/tmp/codex-remote-attachments/019f5a79-e4e1-7122-a77a-2b0650ad53d8/38C9A73B-241D-402B-AA78-832490FB2B4B/1-貼り付けた画像-1.jpg`
- 比較対象: 左の ShiftFlow と右の Instagram の下部メニュー下端。
- 判断基準: Instagram と同様にホームインジケータ直上へ寄せるが、操作領域とは重ねない。

## Implementation evidence

- 実装スクリーンショット: `/Users/hide_kakky/.codex/visualizations/2026/07/13/019f5a79-e4e1-7122-a77a-2b0650ad53d8/footer-after.png`
- 全体・下端比較: `/Users/hide_kakky/.codex/visualizations/2026/07/13/019f5a79-e4e1-7122-a77a-2b0650ad53d8/footer-comparison.png`
- viewport / state: 390x844 CSS px、deviceScaleFactor 2、テストユーザー、メッセージ一覧、`--safe-bottom: 34px`。
- APP_VERSION: `1.10.2`

## Comparison findings

### Full view

- 参照画像と実装後を同じ比較ボードに並べ、カード、FAB、下部メニューの関係を確認した。
- 横幅、色、アイコン、項目数は既存 ShiftFlow のまま維持し、依頼範囲である垂直位置だけを変更した。
- 下部メニューを下げても、本文カードとFABがメニューに隠れず、スクロール可能領域を維持している。

### Focused footer region

- 参照画像では Instagram のメニューがホームインジケータ直上に配置されている。
- 変更前は safe-area 34px に対して下端余白 36pxだった。
- 変更後は `max(4px, safe-area - 12px)` により下端余白 22pxとなり、参照の密度へ近づいた。
- safe-area が 0px の場合も 4px を残し、画面端への完全な密着を避ける。

## Browser interaction QA

- Agent Browser でテストログインを実行した。
- 下部メニューの「メッセージ」→「設定」→「ホーム」を順にタップし、主要ナビゲーションが動作することを確認した。
- 390x844 / safe-area 34px でメニュー下端余白 22pxを実測した。
- ページエラーは 0 件。ローカル環境のみ `GAS_WEB_APP_URL is not defined` 警告があり、今回のCSS変更とは無関係。

## Iteration history

1. P2: 参照に対して ShiftFlow のメニューが高く、safe-area 34px 時の下端余白が 36pxだった。
2. Fix: 下端基準を `max(4px, calc(var(--safe-bottom) - 12px))` へ統一し、メニュー、FAB、本文下端余白を同期した。
3. Recheck: 下端余白 22px、主要ナビゲーション動作、ページエラー 0 件を確認。残存する P0 / P1 / P2 はなし。

## Final result

passed
