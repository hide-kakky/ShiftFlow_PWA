# メッセージ遷移とスクロール追随の再改善

APP_VERSION=2.2.5。2.2.4でも遅いという本人回答を受けた継続修正。基点はbfc5067、作業branchはcodex/fix-push-delivery。

深い位置からのヘッダー復帰とmode切替の位置を直した継続修正は[2.2.7の記録](scroll-chrome-mode-reset.md)。以下は2.2.5時点の記録。

## 変更と理由

取得済みメッセージも、入場時に全件のカードを作っていた。初回は24件だけ描画し、末尾の400px手前で次の24件を自動追加する。「さらに表示」でも追加できる。検索・フォルダ・未読は全件を絞ってから表示するので、まだ描かれていない投稿も見つかる。個人ピンと最終更新日の並び、ページ境界の日付見出し、左右スワイプは維持する。通常の画面入場は先頭24件へ戻し、ブラウザーの履歴復帰では表示済み件数と位置を保つ。

Homeのfresh応答には、専用メッセージAPIと同じ閲覧範囲の全件が含まれる。この応答を本人の共有sourceへ採用し、背景先読みの二重取得を省く。実際にメッセージへ入った場合は、遅いHomeを待たず専用取得を始める。force更新、本人変更、認証破棄の世代保護は維持する。永続cacheのHomeは全件sourceとして採用しない。並び替え時の日付計算は1件1回にする。Homeの新着プレビューは直近3件に収め、未読バッジは全件で数える。

通常の画面切替は、現在位置を履歴へ保存してから上端へ即時移動し、次画面を表示する。次フレームの二重リセットを除去して、直後の操作を巻き戻さない。Bootstrap 5.3.2は通常設定でrootをsmooth scrollにしていたため、html/bodyを常時autoで上書きした。[Bootstrap公式ソース](https://raw.githubusercontent.com/twbs/bootstrap/v5.3.2/scss/_reboot.scss)を確認した。

退避限界に達したメニューは、位置・透明度・hidden classが同じなら書き直さない。スクロール位置の追跡は続けるので、逆方向へ動かした時の復帰を遅らせない。移動するヘッダーの二重ぼかしを1層にし、内側と下部ナビはblur 12pxに抑えた。背景ぼかしの描画工程は[WebKit公式解説](https://webkit.org/blog/3632/introducing-backdrop-filters/)も参照した。透明効果を減らすOS設定ではぼかしを無効にする。バーの配置は新規作成ボタン左12pxのまま。

## ブラウザーでの確認

同じ393×852px、合成40件/1000件、同じイニシャル表示、先読み完了後の比較。既存demo mockを使い、SW登録はfixture内だけ無効にした。計測値は操作から2回目のrequestAnimationFrameまでで、描画機会の近似。画素提示時刻、INP、FPS、実iPhone、JSON/HTTP通信の計測ではない。各条件は少数回の観測で、統計的な中央値ではない。

| 条件 | 2.2.4基点 | 最終2.2.5 |
| --- | ---: | ---: |
| 1000件・初回入場の2rAF | 533.0ms | 74.8ms |
| 1000件・初回カード数 / 要素数 | 1000 / 19519 | 24 / 473 |
| 1000件・未読切替の2rAF | 481.5ms | 22.6ms |
| 40件・初回入場の2rAF | 93.0ms | 53.5ms |
| 40件・取得済み再訪の2rAF | 68.4ms | 22.4ms |
| 40件・未読切替の2rAF | 41.5ms | 30.1ms |

別試行では1000件の基点初回937.6ms、修正中候補104.5ms。40件の修正中候補初回は101.9msで基点より遅い試行もあり、少件数の初回が一律に速くなるとは断定しない。最終1000件の再訪は46.7ms。基点の同一DOMを保った再訪でも1192.9msの観測があり、文字列生成の省略だけでは大きなDOMのlayoutを抑えられなかった。

最終計測のindex SHA-256は`ba484338820373ff9e15c8fb44c888250c2142599561b6beeca14f85166e8ff8`、compact-ui.cssは`ba52f10dbb7713f673f99703c149a503f7a5815233f65fee4c56317a6d50fd6d`。ローカルの`.ui-review/candidate-release-{40,1000}.json`に結果、`message-smoothness-final.png`に表示を保存した。fixtureは公開ディレクトリへ含めない。

実ブラウザーでは続きの自動追加で24→48件、後方1000件目の検索1件、未読切替、横はみ出しなし、scroll-behavior=autoを確認。メッセージを1534pxスクロールしてHomeへ移ると0pxになり、履歴を戻ると1534pxへ復帰した。

## 自動チェック

`npm run check`は253件成功、predeploy scan成功、Functions build成功。追加テストはHomeと全件sourceの応答順・force・本人境界、段階表示と全件検索・未読・日付境界・更新後の空表示解消・履歴復帰、メニューの同値書込と次フレーム巻戻し。退避限界後20フレームの同値style書込は160→0回、class操作は60→0回。独立レビューも公開阻害事項なし。実iPhoneの操作感は公開後の本人利用で確認する。

## 実行・切戻し

```sh
npm run check
npx wrangler pages deploy frontend/public --project-name shiftflow --branch message-smoothness-preview --commit-dirty=false
npx wrangler pages deploy frontend/public --project-name shiftflow --branch main --commit-dirty=false
```

切戻しは直前の2.2.4 Pages `20646261-5e21-4c75-9a1b-ae3287ab4dea`へ戻すか、bfc5067の対象UIを新しいAPP_VERSIONで再配布する。既に2.2.5を導入したPWAには新しい版での再配布を優先する。認証、DB、鍵、通知Workerに変更はない。GitHub mainへのpushは行わない。

保存時のGitコマンド:

```sh
git commit -m 'メッセージを段階描画し画面切替とメニュー退避を改善'
```

## 公開結果

Productionは`b3f9f385-dbe9-45fa-9376-b914897af0a7`、source commitは`f226697`、previewは`9fbcec74`。2026-11-13にpreview、本番URL、固定Deployment URLのindex/app-config/sw/compact-ui/i18nの5ファイルが保存版とSHA-256一致した。indexはPagesが正規化するルート本文で照合。匿名auth/sessionは200・authenticated=false、メッセージと通知設定APIは401。公開前のProductionが2.2.4/source edbadb3のままであることも再確認した。

本番の実ユーザーログイン・データ操作・追加通知送信は行っていない。比較用のローカルサーバーとブラウザータブは終了し、一時viewportも解除した。合成計測の改善と本人の実機評価は別の状態として扱う。
