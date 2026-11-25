# Web Push通知とアプリアイコンのバッジ

現在の通知仕様はAPP_VERSION=2.2.9。メッセージはフォルダ別、タスクは全体共通で設定する。今回の変更・検証・公開記録は[app-badge-reminder.md](app-badge-reminder.md)、以前の受信障害の切り分けは[push-test-fix.md](push-test-fix.md)を参照する。

## 利用者の操作

1. iPhoneではiOS 16.4以降でホーム画面に追加し、そのアイコンから起動する。
2. 「設定 → 通知設定」でフォルダ名を開き、受け取る通知を選び「通知設定を保存」を押す。
3. 「この端末で通知を有効にする」を押してOSの許可を与える。端末の購読をサーバーへ保存できた場合だけ「有効」と表示する。
4. 「テスト通知」で本人の端末への送信を確認する。これは1分に1回まで。

フォルダごとに新しいメッセージ・コメントを設定する。タスクの依頼と更新/完了はフォルダに関係なく本人の共通設定を使う。後から担当者を追加した場合も「タスクの依頼」に含み、新担当者へ更新通知を重ねて送らない。新しいフォルダのメッセージ通知と通常タスク通知はONが初期値。朝リマインダーは初期OFFで、毎朝10時（日本時間）、本人担当の期限切れ未完了がある場合に通知する。10時を過ぎてONにした日は対象にせず翌朝から。10時台のcronで遅延回収し、同日分は一度だけキューへ保存する。完了・キャンセル・今日が期限のタスクは対象外。端末への受信は明示登録が必要。

アプリアイコンの数字は「閲覧できるフォルダの未読メッセージ数＋本人の期限切れ未完了タスク数」。本文未読または新着コメントがある投稿を1件と数える。通知OFFのフォルダも閲覧可能なら未読を数え、新規タスク作成や単なる閲覧ではタスク分のバッジを増減させない。完了・キャンセル・延期・担当解除などで期限切れ対象から外れると減る。0件で数字を消す。

件数は通常push・朝リマインダー受信時、起動/復帰/オンライン復帰と画面表示中の再取得で絶対値を同期する。iOSでは可視通知が必要なためバッジだけのsilent pushは送らない。閉じた別端末の既読反映は次の通知または起動まで遅れる。iPhoneの「設定 → 通知 → ShiftFlow → バッジ」もONにする。

設定は組織/利用者ごとに保存し、その人が登録した端末に適用する。端末ごとの「停止」は本人の現在の購読だけを解除し、フォルダ設定は保持する。OSの通知許可はアプリ内設定とは別。iOS PWAからOS通知設定へ直接移動する公式Web APIはないため、非公開URLスキームを使わず「iPhoneの通知設定の変更方法」を表示する。復帰時に許可と購読を再確認する。

## 環境の新設・再構築時の設定

本番へ適用する場合は、対象と権限の承認を得て別の配布工程として進める。通常APIは`WEB_PUSH_ENABLED`が`true`でなければ通知テーブルを参照せず、通知UIは準備中と表示する。

1. D1のバックアップを確認し、既存migration 000–015と追加の`016_add_app_badge_reminders.sql`を順に適用する。016は設定/イベントへの追加列と日次重複防止indexのみで、既存業務データは変更しない。`ops/post-deploy/015_quarantine_legacy_auth_logs.sql`はこの通知migrationとは別であり、実行しない。
2. 環境ごとにVAPID鍵を用意する。既存の鍵がある場合は再生成しない。新規作成はローカルで次を実行する。ファイルはGit除外、mode 0600、上書き禁止、鍵のstdout出力なし。

   ```sh
   node scripts/create-web-push-keys.mjs --subject mailto:operator@example.com
   ```

   上記の連絡先は例。実際の運用連絡先に置き換える。`.local-web-push.json`をGit・スクリーンショット・ログへ含めない。

3. Pagesと`workers/push-dispatch`の両方に同じ環境用の`VAPID_PUBLIC_KEY`、`VAPID_PRIVATE_KEY`、`VAPID_SUBJECT`をCloudflare Secretsへ登録する。秘密鍵をフロント、TOML、READMEへ書かない。公開鍵だけを認証済み通知設定APIから返す。Preview/productionの鍵とDBは分離する。
4. Pagesへこの版のソースを配布し、追加Workerを対象環境へ配布する。Workerのproduction DBは既存production D1と同じものにする。外部向けHTTP入口はなく、production cronは毎分。デフォルト`WEB_PUSH_ENABLED=false`を保持し、準備後に両方の環境変数を`true`へ変更する。Worker側は`wrangler.toml`の該当環境の値も合わせる。デプロイでfalseへ戻さないこと。
5. 既存利用者の業務操作に影響がないこと、本人の端末で許可・テスト受信・通知タップ・フォルダON/OFF・OS拒否→復帰を確認する。

既存のWranglerを使用するローカル検証例（remoteへの変更なし）:

```sh
npm run check
npx wrangler deploy --dry-run --config workers/push-dispatch/wrangler.toml --outdir /tmp/shiftflow-push-dispatch-build
```

## 保存と送信の境界

- `push_preferences`：全体共通のタスク依頼/更新/朝リマインダーと有効化時刻、設定version。保存は楽観ロックし、他画面との競合時は入力を保持する。
- `push_folder_preferences`：組織/利用者/フォルダのメッセージ/コメント通知。旧task列は互換用に保持するが配信判断では使用しない。取得と保存で現在のフォルダ閲覧権限を確認する。
- `push_subscriptions`：本人の購読endpoint/暗号鍵とログインsessionのfingerprint。最大10端末をDBでも強制。別利用者へ購読を移さない。通常利用時に約1日おきに期限を更新し、logout失効台帳を送信時に再確認する。
- `push_events` / `push_deliveries`：業務保存/監査と同じDB batchに通知イベントを記録する。既存auditの`changes()`依存を保ち、イベントはauditの後に追加する。決定的イベントIDとUNIQUEで同じmutation再送のenqueue重複を防ぐ。

送信直前にD1 primaryで、所属・利用者有効性・フォルダ権限・現在の設定・購読・session失効・対象resourceの存在/フォルダ/担当を照合する。通常の自分の操作は通知しない。システムが生成する朝リマインダーだけは本人を対象にする。ロック画面には種類だけを表示し、件名・本文・投稿者は送らない。暗号化payloadには本人の絶対件数・ownerハッシュ・session有効期限も含む。通知タップ後の詳細取得も通常APIの認証/認可を通す。

暗号化はRFC 8291 aes128gcm、認証はRFC 8292 VAPID。新規外部依存なし。送信先はApple/FCM/Mozilla/WNSの既知ホストへ限定し、HTTPSのみ・リダイレクト不可・4秒timeout。endpoint/鍵/本文/providerのraw応答はログに残さない。Safariでは受信後のsilent破棄を避け、OFFはサーバー側で送信前に適用する。

1回のdrainはイベント2件×20購読の展開と最大5配信。即時配信はcommit後の`waitUntil`に接続し、残件と一時障害は毎分cronで回収する。429/5xx/通信不明はバックオフし最大4試行、404/410で失効購読を除去する。通常イベント有効期限は24時間、朝リマインダーは当日JST24時、送信後のpush service TTLは1時間、outboxは約2日で少量ずつ削除する。

**外部push送信とDBの成功記録は同一transactionにできない。** 送信後の通信断や処理中断では再配信され得る。同じ通知tagで重複表示を抑えるが、厳密なexactly-onceや到達を保証しない。送信直前照合の直後に権限が変わる競合もあるため、通知本文を最小にし、内容閲覧はアプリ内で再認可する。

## 切戻しと検証境界

両サービスの`WEB_PUSH_ENABLED`を`false`にし、必要なら前のPages/Worker版へ戻す。追加テーブルは削除せず保持し、既存業務データを巻き戻さない。VAPID鍵を変更するときは既存購読をそのまま利用できないため、停止・旧購読の整理・端末での再登録を別工程として行う。

自動検証はfixture DB、stub transport、既知のRFCベクトル、UI/Service WorkerのVM実行によるもの。本番構成の確認と、実際のOS許可・iPhone受信・通知タップ・現場での効果は区別する。以前のテスト通知到達は本人確認済み。今回追加のアイコン件数と朝10時受信は実端末で未確認。

## 2026-11-13 本番反映

- APP_VERSION=2.2.0。Pages production `ee6bc273-0482-4ec1-9497-906c25137a42`、配布元commit `6825a56`。公開先は https://shiftflow.pages.dev 。
- ソースはローカルbranch `codex/compact-card-ui`に保存。原checkoutとGitHub mainへの統合・pushは未実施。次の公開もこの版を引き継ぎ、旧sourceで上書きしないこと。
- 追加migration `015_add_web_push.sql`を適用し、5テーブルとpending migrationなしを確認。直前のD1 exportとVAPID鍵はrepo外のprivate保管領域にmode0600で保存。既存業務行と旧ログcleanupは変更していない。
- Pages productionと通知Workerに同じ環境用の3つのVAPID secretを登録。VAPID連絡先URIは公開アプリのHTTPS URL。値をログ・Gitへ出していない。
- `shiftflow-push-dispatch-production` のversion `c203980d-0224-4d47-b516-fa6509472bf0`を100%配布。production D1 binding、3secret、`WEB_PUSH_ENABLED=true`、毎分cronを確認。外部HTTP公開経路なし。
- Pages productionも`WEB_PUSH_ENABLED=true`を設定して再配布した。
- 本番の7つの主要静的ファイルは保存した版とSHA-256一致。未認証の`/auth/session`は200、`/api/getNotificationSettings`は401。認証を通った実利用者の設定保存・購読・OS受信は、この確認に含まない。
- 全191テスト、Functions build、秘匿ファイルscanが成功。
- 短いtail観測ではscheduledイベントは未観測。登録成功と実行成功は区別する。Cron設定の伝播は最大15分かかる場合があるため、後続の実行確認が必要（[Cloudflare公式資料](https://developers.cloudflare.com/workers/configuration/cron-triggers/)）。

実行した配布コマンド（鍵ファイルはGit除外）:

```sh
npx wrangler pages deploy frontend/public --project-name shiftflow --branch main --commit-dirty=false
npx wrangler deploy --env production --config workers/push-dispatch/wrangler.toml
```

切戻しは両サービスの通知flagをfalseへ設定して配布する。必要ならPagesを直前の互換版`0d8b7d61-74aa-4e97-a06a-c79412eccba7`へ戻す。追加テーブルと鍵を保持し、既存業務データを巻き戻さない。

端末確認は、更新版を開いて「設定 → 通知設定 → この端末で通知を有効にする → テスト通知」。フォルダを開いて各種類のON/OFFを変更し、専用の「通知設定を保存」を押す。

## 一次資料

- [Apple Web Push実装](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers)
- [WebKit iOS/iPadOS Web Push](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)
- [iPhoneの通知設定](https://support.apple.com/guide/iphone/change-notification-settings-iph7c3d96bab/ios)
- [RFC 8291](https://www.rfc-editor.org/rfc/rfc8291)、[RFC 8292](https://www.rfc-editor.org/rfc/rfc8292)
