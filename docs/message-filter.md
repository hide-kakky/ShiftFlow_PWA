# メッセージの事前取得と下部切替

対象版: APP_VERSION=2.2.7。公開元branchは`codex/fix-push-delivery`。

2.2.3の追加調整: 未読表示時にヘッダー「…」へ付けていた赤い印を削除。表示状態は下部の切替バーで確認する。検索の状態表示と下部ナビの未読件数は保持する。

ホーム表示時に、本人が閲覧できる全メッセージを先読みする。同じ全件データから「すべて／未読」、フォルダ、検索を絞り込む。カード、個人ピン、最終更新日による区切りと左右スワイプは維持する。

取得済みなら同期描画し、切替時にスケルトンや最低待機時間を挟まない。60秒以上経った場合は表示を保ちながら更新する。取得中に切り替えても最新の表示条件を使い、取得失敗時も現在の絞り込みを維持する。

共有sourceは本人単位のメモリと既存の本人単位IndexedDBを使う。旧版の未読だけのcacheを全件として扱わないため、新しい全件専用keyを使用する。認証破棄時にsourceと進行中readを破棄する。投稿・既読・コメント・ピン等の強制取得では世代を進め、bridgeの古いreadにも合流しない。API側の閲覧権限は変更しない。

2.2.4では、細い切替バーを新規作成ボタンのすぐ左へ短くして固定する。下部ナビの上で同じ高さを保ち、safe-areaとスクロール追随に合わせる。最後のカードが隠れない余白を確保し、FAB展開時はバーを一時的に隠して操作対象から外す。他画面や認証非表示時には出さない。再描画・scroll処理と新しい公開結果は[ui-performance.md](ui-performance.md)。

2.2.5では全件の取得を維持し、表示を24件ずつに分ける。末尾近くで自動追加し、「さらに表示」でも続けられる。未表示の投稿も検索・未読・フォルダの絞り込み対象になる。通常入場では先頭へ戻し、履歴復帰では展開済み件数と位置を維持する。fresh Homeの全件応答を先読みに共有し、Home上のプレビューだけは直近3件、バッジは全件で数える。計測条件、検証、公開結果は[message-smoothness.md](message-smoothness.md)。

2.2.7では、すべて/未読の切替で一覧先頭へ即時移動する。タップ・矢印キー・左右スワイプは共通動作。同じmode再選択や検索入力では位置を巻き戻さない。深い位置からのヘッダー復帰も修正した。[検証と切戻し](scroll-chrome-mode-reset.md)。

## 検証

- 実request-coalescerを挟むVMで、連続切替・取得中切替・強制取得の競合・失敗時filter・認証破棄・期限切れ裏更新を確認。
- 自動checkは208テスト、秘匿ファイルscan、Functions build成功。inline JS構文も確認。
- 393pxブラウザの合成データで、タップ・左右スワイプ、末尾までのスクロール、FAB開閉を確認。PC幅でも配置を確認した。実iPhoneの操作結果とは区別する。
- 通知未着の切り分け操作と未確認の境界は[push-test-fix.md](push-test-fix.md)。

## 実行・切戻し

```sh
npm run check
npx wrangler pages deploy frontend/public --project-name shiftflow --branch main --commit-dirty=false
```

今回のUI配布で通知Worker、DB、鍵、購読は変更しない。2.2.3の切戻しは直前2.2.2のPages版`545d023d-ba7e-4b81-a0c5-810ab78bdb67`へ戻す。2.2.2のUI全体を戻す場合は2.2.1の`8a142459-8657-4f55-9b24-e09adc31d35e`、または基点`29e8acd`の対象UIを新しい版として再配布する。通知の送信修正は保持する。

## 公開結果

2.2.2のProductionは`545d023d-ba7e-4b81-a0c5-810ab78bdb67`、source commitは`d34cffb`。previewは`d7dd8eb7`。production/deployment URLのindex/app-config/sw/compact-ui/push-settingsの5ファイルが保存版とSHA-256一致。匿名auth/sessionは200で未認証、メッセージ・通知設定APIは401。公開UIへ実ユーザーでログインする試験や、通知の追加送信は行っていない。

2.2.3は`fd85e2a0-9ff4-4a0c-acad-e326d6bcba02`、source commitは`e72dabd`、previewは`610d8784`。393pxの未読選択状態でヘッダー赤点の削除を確認。変更したindex/app-config/swはproduction/deployment URLとも保存版とSHA-256一致。auth/session 200、匿名メッセージAPI401、既存208テスト成功。本人は端末内の診断と外部テスト通知の両方の受信を確認した。

保存時のGitコマンドは次のとおり。branchに保存済みで、GitHub mainへのpushは行っていない。

```sh
git commit -m 'メッセージの事前取得と下部切替バー、端末通知の表示確認を追加'
```
