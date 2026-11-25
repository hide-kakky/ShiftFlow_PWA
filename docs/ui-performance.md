# ホーム・下部操作・画面切替の修正

APP_VERSION=2.2.4。基点aa07d1e、作業branchはcodex/fix-push-delivery。

2.2.4で遅さが残るという本人回答に対する継続修正は[2.2.5の計測・修正記録](message-smoothness.md)。以下は2.2.4時点の記録。

## 配置

- ホームのシフトカードだけ、縦flex内の中央揃えを左揃えへ修正。長い連続文字もカード内で折り返す。
- すべて／未読バーを新規作成ボタンの左12pxへ移し、同じ高さに揃える。393px幅では260px、320px幅では216px。下部ナビの上で、FABと同じ移動量・safe-area・下端停止位置を使う。
- カードテーマ、切替操作、検索、個人ピン、未読判定、通知設定は保持する。

## 処理

スクロール中は保存した寸法を使い、高さ変更・resize・画面変更時にだけ一括測定する。style書込前に寸法の読取りを終え、バーの追随は固定bottomとtransformで行う。全画面に伝播するrootの追随変数更新を除去した。読み取りと書き込みの交互実行を避ける方針は[web.devのlayout解説](https://web.dev/articles/avoid-large-complex-layouts-and-layout-thrashing)も参照した。

非表示のメッセージはsource更新だけにし、取得結果・条件・日付が同じならDOMを作り直さない。ホームも本人単位のメモリと進行中requestを共有し、再訪時のIDB待ちと、更新中のスケルトン置換・最低220ms待ちを除去した。タスク画面への遷移時は二重描画を避け、取得済み一覧を裏更新中も保つ。認証破棄・force更新・日付と言語変更で古い表示を再利用しない。

## 確認結果

次は合成DOM上の処理回数。実iPhoneのFPS・INP・通信速度の測定ではない。

| 条件 | 基点 | 修正版 |
| --- | --- | --- |
| 定常scroll 3回＋rAF 1回の寸法/style読取 | 25回 | 0回 |
| 1000件取得済み、ホーム先読み10回の非表示一覧再描画 | 10回 | 0回 |
| warmホーム再訪のIDB読取 | 1回 | 0回 |
| warmタスク遷移の一覧構築 | 2回 | 1回 |

- 226テスト、predeploy scan、Functions build成功。inline JSも構文確認。
- 距離比例の退避、同じrAF内の方向転換、上端復帰、native select・dropdown・検索のロック、ResizeObserverでのfooter切替をVMで確認。
- Homeのforce競合・認証破棄後の遅延応答、表示条件・日付変更を回帰で確認。
- 合成データのブラウザで320/393pxとPCを確認。バーとFABの隙間は12px・中心差0pxで、退避後も保持。320pxの長い題名もページ横幅を超えない。
- trace収集用MCPは利用不可。実機のフレーム時間や本人の体感評価とは区別する。

## 実行・切戻し

```sh
npm run check
npx wrangler pages deploy frontend/public --project-name shiftflow --branch main --commit-dirty=false
```

切戻しは直前2.2.3のPages版fd85e2a0-9ff4-4a0c-acad-e326d6bcba02へ戻すか、aa07d1eの対象UIを新しい版として再配布する。DB、鍵、通知Workerは変更しない。GitHub mainへのpushも行わない。

## 公開結果

Productionは20646261-5e21-4c75-9a1b-ae3287ab4dea、source commitはedbadb3、previewはef6e34d2。prod/deployment URLのindex/app-config/sw/compact-uiが保存版とSHA-256一致。匿名sessionは200で未認証、メッセージ・通知設定APIは401。追加の通知送信、DB・Worker変更は行っていない。

保存済みのGitコマンド:

```sh
git commit -m 'シフトカードと下部操作の配置を直し画面切替を軽量化'
```
