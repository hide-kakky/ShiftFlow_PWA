# ヘッダー復帰と未読切替の表示位置

APP_VERSION=2.2.7。基点076ca2a（2.2.6）、branchはcodex/fix-push-delivery。

## 問題と修正

深く下へ進み、上方向へ戻すとfooterだけが復帰する問題を実CSSのブラウザーで再現した。JSの退避量は0、opacityは1、visibilityもvisibleに戻っていたが、header本体は画面外にあった。html/body共通のheight:100%によりbodyの高さが画面1枚分に固定され、sticky headerがbody下端で制限されていた。

bodyだけheight:autoを指定し、既存のmin-height:100%は維持する。headerの移動量・透明度・方向判定・ぼかしには変更を加えない。overflow指定の変更も検討したが、heightの1宣言だけで復帰を確認できたため採用しなかった。modalと画像viewerのスクロールロックは既存指定を保つ。

すべて/未読の実際の切替では、共通handleModeChangeから即時上端へ移動して一覧を絞り込む。タップ、矢印キー、バーと一覧の左右スワイプ、既存checkboxが同じ経路を使う。全件sourceをfilter後に先頭24件を描画する仕組みを維持。同じmodeの再タップ、縦方向の操作、検索入力で不要な巻戻しをしない。認証、API、通知、DBには変更がない。

差分の要点:

```diff
 body {
   margin: 0;
+  height: auto;
   overflow-x: hidden;
 }

 checkbox.checked = unread;
-handleFilterChange();
+handleModeChange();

+function handleModeChange(event) {
+  scrollToTopNow();
+  handleFilterChange(event);
+}
```

## 実ブラウザーの確認

393×852px、同じ合成40件と実UI。SW登録はfixture内だけ無効。実iPhoneのWebKit確認ではない。

| 観測 | 2.2.6基点 | 2.2.7 |
| --- | --- | --- |
| 上スクロール後のページ位置 | y=852px | y=1672px |
| headerの実top / bottom | -68 / 0px | 0 / 68px |
| bodyの実高さ | 852px | 5304.53px |
| headerの移動量・opacity・visibility | 0px / 1 / visible | 0px / 1 / visible |
| header位置のhit-test | 画面外 | header配下 |
| 未読へ切替後のページ位置 | y=852pxを保持 | y=0px |
| 未読の最初のカードtop | -746px | 106px |

基点は1704px下へ進んで852px上へ戻った位置。修正版はさらに下まで進んで戻してもheaderが画面上端へ復帰した。footerは両方ともtop790px。修正版は続きの自動追加で40件になった後、未読へ切替して先頭24件を表示し、すべてへ戻す時もy=0になった。横はみ出しなし。詳細modalはbodyのoverflow:hiddenで背景位置を維持し、閉じると既存overflow:scrollへ戻ることも確認した。

記録はローカル`.ui-review/scroll-header-{baseline,final}.json`、`scroll-mode-{baseline,final}.json`、`scroll-header-return.png`、`scroll-mode-top.png`。比較用サーバーとタブは終了し、viewportも解除済み。実機でのpaintやスクロール感覚は未確認。

## 自動チェックと再発防止

`npm run check`は261件成功、predeploy scan成功、Functions build成功。inline JSの6scriptも構文確認。mode切替の新規3件は、修正前2件失敗/1件成功、修正後3件成功。対象36件も独立レビューで成功した。

既存scrollテストは寸法とCSS変数だけを確認し、stickyの実座標をモデル化していなかった。深さの数字を増やすだけでは今回のheader不具合を検出できない。再発確認では深い位置を保ったままheaderの実top/bottomとhit-testを見る。今後のbody/scroll container変更時にはこのブラウザー確認も再実施する。

## 実行・切戻し

```sh
npm run check
npx wrangler pages deploy frontend/public --project-name shiftflow --branch scroll-mode-preview --commit-dirty=false
npx wrangler pages deploy frontend/public --project-name shiftflow --branch main --commit-dirty=false
```

切戻しは直前2.2.6のPages `6685c6c9-071e-47f8-99c7-0b0c59d1dc2a`、または076ca2aの対象UIを次APP_VERSIONで再配布する。PWA導入済み端末は新しい版での再配布を優先。通知Worker、DB、鍵を維持し、GitHubへpush/mergeはしない。

```sh
git commit -m 'ヘッダーの追随範囲と未読切替時の表示位置を修正'
```

## 公開結果

2026-11-13公開。Productionは`0778bec3-5a9c-42c7-95c5-d5a857a72488`、source commitは`66072c0`、previewは`170b87a6`。preview、本番URL、固定Deployment URLのindex/app-config/sw/compact-ui/i18nが保存版とSHA-256一致。indexは正規化後のルート本文を照合した。

匿名auth/sessionは200・authenticated=false、メッセージと通知設定APIは401。公開前に2.2.6/source9642d40のままか再確認して配布した。実ユーザーの本番データ操作と通知送信は行っていない。

## 再利用と改善

前回の即時スクロール、全件source、段階表示、定常scrollの寸法cacheを再利用した。JSの正常判定と実際に見える状態を分けて検証する失敗予防の素材として、正本をこのrepoに残す。Rizo接続はmethod asset候補。VaultやLedgerは変更しない。
