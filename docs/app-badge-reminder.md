# 通知設定・アイコン件数・朝リマインダー（2.2.9）

## 確定仕様

- メッセージ/コメント通知は閲覧可能なフォルダごとにON/OFF。通知OFFでも未読件数には含む。
- タスク依頼・更新通知はフォルダに関係なくアカウント共通。新規依頼は本人担当への通知。通常の自分の操作は通知しない。
- アイコンの数字は、閲覧可能な未読メッセージ数＋本人担当の期限切れ未完了数。本文未読または新着コメントのある投稿を1件と数える。
- 今日が期限・未来・完了・キャンセルはタスク分から除外。新規作成だけでは加算せず、閲覧だけで消さない。完了・延期・担当解除等で対象から外れた時に減り、0件で消す。
- 朝リマインダーは利用者ごとに初期OFF。毎朝10時JST、期限切れ未完了があれば1日1イベントを作る。10時を過ぎて新しくONにした日は送らず翌朝から。10:00:00.000ちょうどは当日対象。10時台のcronで遅延回収し、当日24時に失効する。
- リマインダーは通常タスク更新のON/OFFから独立。本人の登録済み・有効セッションの端末だけへ送り、送信直前に設定・担当・期限・権限を再確認する。

## 実装と境界

`functions/utils/appBadge.js` がD1 primaryで件数を計算する。GET `/api/getAppBadge` は既存session/RBACを要求し、クエリーで対象本人・組織を変更できない。通知設定や購読の有無で件数を変えない。取得失敗は0件へ変換しない。

送信payloadに絶対件数・ownerハッシュ・セッション有効期限を含める。SWは可視通知を先に呼び出し、認証済みAPIで現在の本人の件数を確認する。通信不可時だけ、同じSWの稼働中に認証API成功を確認したownerと保存済み期限・適用時刻が一致する新しいpayloadを代替利用する。SW再起動直後のオフラインでは代替適用しない。本文・件数・CookieをIndexedDB/CacheStorageへ保存しない。保存はowner/適用時刻/期限だけ。ログアウトは未完了処理を無効化して数字とownerを消す。

バッジAPIは起動・復帰・オンライン復帰・可視中60秒おきと操作成功後に同期する。取得は合流/抑制し、表示切替の完了を待たせない。SWがいる場合は端末への書込みをSWへ集約し、windowとSWの二重書込みを避ける。SWの取得は2.5秒、メタデータ保存は500msで打ち切る。

iOSの閉じたアプリでバッジだけを更新するsilent pushは使えない。通常通知または朝通知で更新し、他端末で既読にした直後などは次回起動まで数字が残る場合がある。ホーム画面アプリと通知/バッジ許可が必要。[WebKitのBadging仕様](https://webkit.org/blog/14112/badging-for-home-screen-web-apps/)

日次イベントは既存kind `task_updated` と追加の `reminder_day` で区別する。既存CHECKを壊すtable再構築は行わない。組織・本人・日付のUNIQUEと決定的IDでキュー重複を抑止する。ただし外部送信後のDB記録失敗では再送され得るため、端末到達のexactly-onceは保証しない。

## 検証

SQLite fixtureで閲覧範囲、他組織、管理者、未読/コメント、JST境界、OFF、完了/キャンセル、日次重複、設定保存競合、旧クライアント互換、送信直前失効を検証。暗号化したstub配信を復号し、件数・owner・期限を確認する。

VMではOS API未対応、0件clear、古いowner/時刻/期限、ネット障害/401/403、logoutの遅延応答、IDB停止、SW取得timeout、可視通知の即時呼出しを検証。393pxの合成設定画面で、フォルダ2項目・タスク共通3項目・初期OFFを確認。実ユーザーの設定変更・テスト通知送信はしていない。

全344テスト、秘匿scan、Functions build、Worker production dry-run buildが成功。preview（3da14ef9）の8ファイルSHA-256一致と匿名session=false・3業務API=401を確認。本番の反映と照合結果は下記を参照。今回の実iPhoneでのアイコン件数・翌朝10時受信は未確認。

## 実行と戻し方

```sh
npm run check
npx wrangler deploy --dry-run --env production --config workers/push-dispatch/wrangler.toml --outdir /tmp/shiftflow-app-badge-worker-build
npx wrangler d1 migrations list app_d1_prod --remote --env production
npx wrangler d1 time-travel info app_d1_prod --env production --json
npx wrangler d1 migrations apply app_d1_prod --remote --env production
npx wrangler pages deploy frontend/public --project-name shiftflow --branch main --commit-dirty=false
npx wrangler deploy --env production --config workers/push-dispatch/wrangler.toml
```

migration016を先に適用し、その後PagesとWorkerへ同じコードを反映する。追加列/indexだけで、旧task列・既存業務データ・鍵・購読は保持する。本番DB全体のローカル複製は自動承認レビューで拒否されたため実施せず、Cloudflare管理のTime Travel復元ポイントだけを記録した。

緊急時は直前Pages `2471fd10-7fa7-42e9-adec-6b44905678a4`、Worker `e82ffe7d-32cc-4060-bdc3-91ad4470b837`へ戻す。追加列は残し、DB全体を巻き戻さない。旧Workerは日次通知を送らず、旧画面の保存でも新しい朝設定を消さない。導入済みSWの修正には新しい版を再配布する。以前のフォルダ別タスク配信へも戻るため、通常は修正版の前進配布を優先する。

利用者は設定で『期限超過タスクの朝リマインダー』をONにして『通知設定を保存』を押す。端末の通知有効登録と、iPhone側のバッジ許可も確認する。

## 本番反映結果（2026-11-13）

- 配布元commit `9279507`、APP_VERSION `2.2.9`。
- Pages production `4c8c4549-330c-4428-b90f-14af106c860f`。公開先 https://shiftflow.pages.dev 。previewは `3da14ef9`。
- 通知Worker `shiftflow-push-dispatch-production` version `50dbfd01-7366-45ce-a417-63f0b9421565`。production D1と通知flag true、毎分cronを維持して配布済み。
- migration016適用成功（5 commands）。後続のlistで未適用migrationなし。既存業務行・鍵・購読は変更していない。
- 本番URLと固定deploymentURLの8ファイルが配布元とSHA-256一致。匿名 `/auth/session` は200かつauthenticated=false。メッセージ/通知設定/件数の3APIは両URLとも401。
- 全344テスト、秘匿scan、Functions build、Worker dry-run build成功。公開したassetは上記commitの実装と同一。追加の実通知送信・利用者の設定変更は行っていない。
- 実iPhoneのアイコン表示・次の10時受信・通知タップは未確認。利用者のフィードバックで到達と件数一致を別途確認する。旧2.2.8が表示される場合はPWAの更新を適用してから設定を確認する。

保存済みコミットと同じ内容のメッセージ例：

```sh
git commit -m "通知設定を分離し件数バッジと朝リマインダーを追加"
```
