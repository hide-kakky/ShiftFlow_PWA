# v2.0.0 監査ログ・API安定化

## 目的と適用境界

この変更は、v1.6.0以前から残っていた「認証・業務監査・API診断の混在」と、画面初期化時の重複読込を解消する。v2.0.0全体のビジュアル刷新は別スライスとし、この文書では観測可能性、API実行、DB整合性をリリース可能な土台へ固定する。

## 確認できた原因

2026-07-13の本番D1をread-onlyで集計した結果、調査開始時の`login_audits`は15,957件あり、同日分872件のうち533件が`downloadAttachment`等の通常APIだった。2026-07-14 04:56 JSTの最終再確認では16,345件（`token_iat_ms IS NULL`は1,234件、最終行は同日04:20:58 JST）で、`auth_proxy_logs`も全16,345件が`login_attempt`（info 16,294件、warn 51件）だった。01:47時点の16,330件からさらに15件増えており、旧writerがまだ稼働している。両テーブルは全16,345件がrequest IDで1対1に対応し、各テーブル内のrequest ID重複は0件だった。まったく同じミリ秒の記録は201組あるが最大4件であり、「大量の同一ログイン試行」ではなく、別々の通常APIが同時刻表示へまとまったものと、同じ通常APIを旧2テーブルへ二重分類したものが重なって見えていた。直近24時間の最多routeは`downloadAttachment` 787件だった。v1.6系セッションではGoogle tokenの`iat`を保持しなくなったため、画面側の時刻まとめ表示が効かず誤分類が顕在化した。いずれの確認も`rows_written=0`で、本番DBは変更していない。

原因はOAuth callbackの多重実行ではなく、すべての通常APIで旧`login_audits`と`auth_proxy_logs.login_attempt`へ書いていた共通処理である。したがって、表示側で重複を隠すのではなく、書込み元と取得元を分離した。

同日のPages production secret名のread-only確認では`AUTH_RATE_LIMIT_SALT`が未登録で、退役後は不要な`GAS_EXEC_URL`、`SHIFT_FLOW_SHARED_SECRET`、`SHIFT_FLOW_SHARED_SECRET_NEXT`が残っていた。値は取得していない。v2コードを出す前に専用saltを登録し、GAS deployment失効と参照ゼロ確認後に旧secretを削除する。

## v2のログ契約

| 種別 | 正本 | 書込み条件 | 監査画面の分類 |
| --- | --- | --- | --- |
| 認証・セッション・認可 | `auth_events` | OAuth成功/失敗、ログアウト、期限切れ、アクセス拒否、ロール拒否 | 認証・アクセス |
| 業務操作 | `audit_logs` | タスク、メッセージ、ユーザー、フォルダ等の状態変更 | 業務操作 |
| API障害 | `auth_proxy_logs` | `warn` / `error`だけ | API障害 |
| 旧誤分類 | `login_audits`、旧`login_attempt` | v2コードからは新規書込みなし | 表示対象外 |

- 認証イベントはsession IDそのものを保存せず、SHA-256 fingerprintの先頭32桁を冪等キーへ使う。
- OAuth失敗は`authentication.failed`と非PIIのstable reason codeだけを保存する。失敗行はsession fingerprintを持たず、Google `sub`は成功・失敗とも`user_sub`へ、メールは`user_email`へ保存しない。メール表示は`users`正本をjoinする。tenantを信頼できない早期失敗は`org_id` / `user_id`をNULLにして運用者がD1で確認し、他組織の監査画面へ混ぜない。
- OAuth callback時点でactive所属が1件だけならその組織をsnapshotし、複数所属なら任意の古い所属を選ばず`org_id=NULL`とする。user-levelイベントは監査取得時にactive membershipで自組織へ投影し、匿名失敗は組織画面へ出さない。
- route-level RBAC通過後のobject-level 403も`authorization.denied`へ記録する。各HTTP試行にはサーバー生成の`authorizationAttemptId`を使い、クライアントが同じrequest IDを再利用しても拒否記録を抑制しない。request IDは相関用であり、認可試行の冪等キーにはしない。tenant/objectの存在を隠す404は、誤って存在情報を監査判定へ持ち込まないため一律に拒否イベント化しない。
- API診断はrequest ID、route、tenant snapshot、許可済みメタ情報だけを保存する。Cookie、Authorization、token、raw body/header、IP、User-Agentは保存しない。
- ログ配送障害は認証や業務APIを失敗させない。ただし業務データと`audit_logs`は同じD1 batchへ入れ、片方だけが保存される状態を作らない。
- expand migration `009`〜`014`は旧行を削除しない。旧writer停止とdrainを確認した後だけ、通常migration列から分離した`ops/post-deploy/015_quarantine_legacy_auth_logs.sql`を明示承認で実行し、paired旧行を`legacy_api_request_misclassified`へ再分類してPIIを空化する。pairにならない`login_attempt`は実認証イベントの可能性があるため変更せず、preflightで1件でも見つけたら015を止めて個別調査する。行は削除しないが空化は不可逆なので、直前backupを必須とする。

## API多重実行の抑止契約

- `/auth/session`と、副作用のない同一read requestだけをin-flight coalescingする。同じ処理中の呼出しは1本のPromiseを共有する。
- 旧Apps Script bridgeは公開業務関数・サインインHTML・Spreadsheet/Drive scopeを削除した退役stubへ置換する。全entrypointは`gas_runtime_retired`と`httpStatus: 410`を含むJSONだけを返し、Pages Functions/D1だけを実行正本とする。`TextOutput`は実HTTP statusを変更できないため、旧deployment失効を外部到達停止の必須gateとする。
- mutationは401後に自動再送しない。利用者操作が成功済みか不明な状態で同じ作成APIを再送しないためである。
- 作成mutationは`X-ShiftFlow-Request-Id`、tenant、actor、resource scope、canonical payload hashから決定的なentity IDを作る。同一actorの同じrequest ID・同じpayload再送は同じメッセージ・タスク等へ収束するが、別actorの同じ値は別entityとして扱う。7日TTL後に同じrequest IDを異なるpayloadで再利用しても、旧resourceへ誤収束しない。
- `api_idempotency_keys`にはcanonical payloadのSHA-256だけを保存する。同一tenant・actor・route・request IDでhashが異なる場合は`409 idempotency_key_reused`とし、raw bodyや個人情報は台帳へ保存しない。
- idempotency keyの保持は7日間とする。成功と副作用有無が不確かな5xxは保持し、通常4xxは新規挿入した世代だけをCASで解放する。期限切れは次のmutation時に全actor横断のexpiry indexから1要求最大100件だけ削除する。処理がない間は増加もしないため、QCの期限切れ件数をrelease監視へ含める。
- 完了・削除・ピン留め等は、対象行が実際に変化した場合だけ業務監査を挿入する。異なるrequest IDで同じ状態を再送しても、実操作1回に対して監査1件となる。
- 作成済みresourceを削除した後に古いmessage/task作成requestが再送されても、成功監査をtombstoneとして`409 idempotency_replay`で停止し、削除済みresourceを復活させない。
- ユーザー設定は`settings_version`を用いた楽観ロックで、名前・テーマ・言語・プロフィール画像を1つのaggregateとして保存する。同時更新は先着だけを確定し、後着は入力を保持したまま409で再確認する。同じrequestの並行再送は先着結果へ収束し、古い成功requestの再送で新しい設定を巻き戻さない。
- mutation routeのGET実行は405、`CFG_D1_WRITE=false`時は保存前に503で拒否する。
- Bootstrap後のtemplate再取得、フォルダchange listenerの二重登録、ホーム「すべて」選択時の二重`getMessages`、空タスク再取得ループ、無制限STALE retryを除去した。
- 異なる添付ファイルの並列取得は維持する。同じURLの重複だけをまとめる。
- `/auth/start`は同一clientあたり20回/分、`/auth/callback`は30回/分をアプリ側KV guardの上限とし、同一isolate内の並行判定はkey単位に直列化する。client IPは専用salt付きSHA-256のKV keyにだけ使い、ログとKV valueへ保存しない。KVまたはsalt欠落時は認証書込み増幅を避けるためfail-closedする。KVは全edgeで強整合なカウンタではないため、Cloudflare edge側のrate limitを本番の外周防御として併用する。
- フロントは認証開始中の60秒間を1本に固定し、連打・複数イベントからOAuth windowを重複起動しない。画面復帰時は先に`/auth/session`を強制確認し、Cookieの利用者が変わっていたら旧利用者のメモリ・IndexedDB・下書きを消してreloadするまで業務APIを送らない。
- 添付はJSON内のData URIを廃止し、`stageAttachment`へ画像バイナリを1件ずつ送る。通常JSONは1MB、プロフィール画像は8MB、メッセージ画像は1件10MBでhard capし、長さ不明bodyは小容量から幾何拡張する。同一isolateで保持するbinary upload数も制限し、[Cloudflare Workersの128MB memory境界](https://developers.cloudflare.com/workers/platform/limits/)を超える同時bufferを作らない。
- stageはowner・org・membership・用途・checksum・7日idempotency世代をD1へ保存し、30分以内にmessage/profile batchが1回だけclaimする。期限切れ・supersede後も同世代の古いrequestはtombstoneで拒否し、7日後の新世代だけ別IDとして再利用できる。
- セッションはKV recordとCookie秘密鍵を照合した後、D1 `first-primary`の`session_revocations`を最終accept gateにする。logoutはraw session IDではなくSHA-256 fingerprintをD1へ先に保存し、[KVの伝播遅延](https://developers.cloudflare.com/kv/concepts/how-kv-works/)中も後続requestを拒否する。

## DB整合性

- `009_add_v2_observability.sql`はexpand-only migrationで、`auth_events`、`audit_logs.request_id`、`storage_cleanup_jobs`を追加し、`auth_proxy_logs`へ`org_id` / `user_id`を追加する。旧テーブル・旧行は残し、manual cleanup前のread-only preflightをCPU上限内で行う`login_audits(request_id)` indexだけを先に追加する。
- `010_scope_api_idempotency.sql`は`api_idempotency_keys`を追加し、旧監査unique indexをactor込みへ置換する。別actorによる同一対象・同一request IDの操作も各actorの監査として保持する。
- `011_add_user_settings_version.sql`は既存userを保持したまま`settings_version='0'`を追加し、プロフィール設定の楽観ロックを有効にする。v2フロントは取得したversionを次の保存へ送り、旧cacheクライアントは移行期間のみAPIが読取時versionを補完する。
- `012_scope_audit_idempotency_generation.sql`は業務監査へcanonical payload hashとidempotency世代を追加し、7日TTL後の同一request IDを新しい操作として保持する。同一actor・request・action・target・hash・世代だけを重複拒否する。
- `013_add_staged_attachments.sql`は`staged_attachments`とscope/quota/初期状態/claim triggerを追加する。INSERTは`uploading`だけを許可し、purposeとclaim targetを`message→message`、`profile→user_settings`へ固定する。旧Data URI writerは使わず、R2 put前の台帳、claim、attachment、業務更新を段階化する。R2 cleanup leaseとattachment採用の境界は`009`のtriggerが担当する。
- `014_add_session_revocations.sql`はsession IDのSHA-256 fingerprintと90日expiryだけを持つ失効台帳を追加する。認証コードより先に必ず適用し、D1 primaryを読めない場合は認証をfail-closedする。
- `ops/post-deploy/015_quarantine_legacy_auth_logs.sql`は通常migrationではない。新writerの稼働と旧writer停止を確認した後、backupと明示承認を得たmaintenance windowだけで旧誤分類行を再分類・PII空化する。
- タスク作成・更新・完了・削除と対応する業務監査を同一D1 batchで保存する。
- メッセージ作成は本体、stage claim、添付メタデータ、既読、業務監査を同一D1 batchで保存する。プロフィール更新もstage claim、attachment、`settings_version`更新、監査を同一batchで確定する。各stageはR2 putより前に`upload_uncommitted` cleanup候補を永続化し、追跡できない場合はputせず503で閉じる。競合敗者はwinnerのattachment・cleanup jobを変更せず、応答喪失時はprimaryの監査・version・owner・checksum・R2 keyを照合して同じ成功へ収束する。
- D1 batchがcommit後に応答だけ失われた可能性がある場合、R2を即時削除せずprimaryからmessage/profile・attachment・監査を再読する。採用済みなら成功として回復し、結果不明ならcleanup候補を保持する。誤ってlive objectを削除するより一時的なorphan候補を優先する。
- タスク／メッセージ削除はD1の関連行・監査・R2 cleanup予定を同一batchで確定してから、R2 objectを削除する。添付本体の`org_id`と親のtenantが一致し、他のtask/message参照がない添付だけを削除候補にするため、不整合なcross-org linkがあっても別組織のD1/R2を巻き込まない。R2 cleanupだけが失敗した場合はDBを巻き戻さず、object keyを`storage_cleanup_jobs`へ残す。再試行はadmin限定の`POST /api/adminRetryStorageCleanup`で、自組織・`org_id IS NOT NULL`・live attachment参照なしのjobだけを1回1〜25件処理する。D1 leaseをCAS取得し、成功/失敗もlease tokenでCAS確定する。期限切れleaseは別workerが再claimできるが、tokenが残る間は期限に関係なく同じR2 keyのattachment採用をDB triggerで拒否する。完全一致replay、R2未設定、cross-org、live参照は削除を行わない。
- cleanup応答と`storage_cleanup.retry`監査にはjob ID、status、件数、error codeだけを残し、R2 key、対象ID、raw errorは出さない。live attachmentを参照するjobはR2を削除せず`updated_at_ms` CASで台帳から解決し、後続orphanの飢餓を防ぐ。CAS競合時はjobを保持し、`org_id IS NULL`の旧jobは手動調査対象とする。
- 空DBへの`000`からの全migration再構築と`999_qc_checks.sql`実行を自動テストする。

## リリース手順（未実施）

Preview / Productionそれぞれに専用の`AUTH_RATE_LIMIT_SALT`を設定し、Cloudflare edge側rate limitも確認する。通常migrationは`009` → `010` → `011` → `012` → `013` → `014`で、すべてコードより先に適用する。`013`はstaged attachment、`014`は強整合なsession失効に必須であり、特に`014`を欠いたままv2コードを出すと全セッション検証が503でfail-closedする。本番は先にPages v2へ切り替えて旧GAS参照ゼロと旧ログ非増加を確認し、その後だけ旧GASを退役stubへ更新してweb app deploymentを失効させる。manual post-deploy `015`をこの段階で実行してはいけない。

1. 開発DBでpending migrationを確認する。

   ```bash
   npx wrangler d1 migrations list app_d1_dev --remote
   npx wrangler d1 migrations apply app_d1_dev --remote
   npm run qc:dev
   ```

2. Previewへコードを出し、下記の受入確認を行う。
3. 本番D1のbackup/restore手順を確認し、`login_audits`、`auth_proxy_logs`、`auth_proxy_logs.event='login_attempt'`の直前件数を記録する。`login_attempt`は`request_id`で`login_audits`とpairになる件数・pairにならない件数を分け、unpairedが1件でもあれば015対象と決めつけず停止条件として記録する。
4. 本番へexpand migration `009`〜`014`を順に適用する。QC先頭のmetricsは直前値・期待値と比較し、後続のanomaly queryが0行であることを確認する。この時点の`legacy_login_attempt_rows_pending_review` / `paired` / `unpaired`は観測値として扱う。manual 015後に`pending_review=0`を要求できるのは、直前preflightで`unpaired=0`を確認して015がpaired全件を処理した場合だけである。

   ```bash
   npx wrangler d1 migrations list app_d1_prod --remote --env production
   npx wrangler d1 migrations apply app_d1_prod --remote --env production
   npm run qc:prod
   ```

5. Pages Functions/PWAをdeployする。現行clientとService Worker更新前の旧cache clientを含む通常操作後も`login_audits`と旧`login_attempt`件数が増えず、静的参照とruntime trafficの両方で旧GAS参照が0であることを確認する。この確認中は旧GAS deploymentを維持し、旧clientを先に壊さない。
6. Pages v2の安定と旧client trafficのdrainを確認した後だけ、旧GAS web appへ退役stubをdeployする。公開関数が`doGet` / `doPost` / `doOptions`だけであること、旧サインインHTML、Spreadsheet/Drive scope、旧writer、再開用Script Propertyが配布物にないことを確認してdeploymentを失効する。失効後もGAS trafficが0であることを確認し、最後に`GAS_EXEC_URL`と`SHIFT_FLOW_SHARED_SECRET*`をPages secretから削除する。
7. post-deploy cleanup直前にD1をexportする。backupファイルはrepoへ追加しない。

   ```bash
   npx wrangler d1 export app_d1_prod --remote --env production --output=<安全なrepo外パス>.sql
   ```

8. 件数がdrain後も不変で、backupが読めることを確認する。preflightで`login_attempt`総数、`login_audits`とのpaired件数、unpaired件数を再集計し、paired件数が承認対象と一致してunpairedが0件の場合に限り、既存ログの不可逆なPII空化について別の明示承認を得て015を実行する。unpaired行は015自身も変更しないが、0件でなければ実行せず認証ログとして個別調査する。

   ```bash
   npx wrangler d1 execute app_d1_prod --remote --env production \
     --command "SELECT COUNT(*) AS total, SUM(CASE WHEN proxy.request_id IS NOT NULL AND proxy.request_id <> '' AND proxy.request_id IN (SELECT request_id FROM login_audits WHERE request_id IS NOT NULL AND request_id <> '') THEN 1 ELSE 0 END) AS paired, SUM(CASE WHEN proxy.request_id IS NULL OR proxy.request_id = '' OR proxy.request_id NOT IN (SELECT request_id FROM login_audits WHERE request_id IS NOT NULL AND request_id <> '') THEN 1 ELSE 0 END) AS unpaired FROM auth_proxy_logs proxy WHERE proxy.event = 'login_attempt'"
   # total=paired、unpaired=0、paired=承認対象件数を確認してから次を実行する
   npx wrangler d1 execute app_d1_prod --remote --env production \
     --file ops/post-deploy/015_quarantine_legacy_auth_logs.sql
   npm run qc:prod
   ```

9. 015前後の総行数が不変、承認したpaired行が`legacy_api_request_misclassified`、対象PII列がNULL、旧`login_attempt`が0件であることを確認する。もしpreflightと異なるunpaired行が出現していたら、その行は変更されていないことを確認して以後のcleanupを止める。
10. 24時間、`auth_events`件数、`login_audits`増分、`auth_proxy_logs`の`warn/error`、API request数を比較する。

このrepo作業では、本番migration、deploy、secret設定、GAS更新/失効、既存ログcleanupは実施していない。

## 受入確認

- OAuth callback 1回につき`authentication.succeeded`が1件だけ増える。
- OAuthのstate/token/verify/session保存失敗は、サーバー発行の認証attempt単位で`authentication.failed`を1件だけ保存し、token、Google `sub`、raw response/errorを保存しない。同じcallback stateの同時到着はD1 claimでtoken exchange前に1本へ収束する。
- 画面を通常利用しても`login_audits`と`login_attempt`が増えない。
- `/auth/start` / `/auth/callback`の過剰呼び出しがrate limitで停止し、Cookieのない未開始callbackは`auth_events`を増やさない。
- 別POPに古いKV sessionが残っていても、logout後はD1 primaryの失効fingerprintで拒否される。D1を読めない場合は503となり、KV-onlyへfallbackしない。
- ログアウト、期限切れ、pending/suspended/revoked、ロール拒否が対応する認証イベントとして表示される。
- 監査画面で「業務操作」「認証・アクセス」「API障害」が別々に絞り込め、別組織の行が混ざらない。
- DevTools Networkで、同一引数のread requestが同時に1本だけ送信される。
- 作成・更新・削除で401/500を発生させても、フロントがmutationを自動再送しない。
- D1 batchへ意図的に失敗を注入したテストで、本体・既読・監査がすべてrollbackされる。
- 同一request IDで作成を再送しても本体・監査が1件のままで、完了再送でも監査が増えない。
- 添付Data URIは`staged_attachment_required`で拒否され、1MB超のJSON、8/10MB超のbinary、深さ64または10,000 nodeを超えるpayloadは安定した4xxで停止する。同一isolateのbinary body保持上限を越える要求もbody読取前に拒否する。
- 同じstage requestの並行再送は同じR2 objectへ収束する。同じprofile stage/save requestの並行再送は両方200となり、異なるsave requestの競合は`200 + 409`でwinnerのattachment・R2・cleanup jobを保持する。
- stage cleanup後に7日以内の古いrequestを再送してもmessage/profile stageを復活させず、idempotency期限後の新世代だけ別stage IDで作成できる。
- 異なるprofile requestを同じ設定versionから並行させると`200 + 409`となり、名前・テーマ・言語・画像はwinner一式だけが保存される。入力を混在させず、loser objectとmetadataを回収する。
- 画像なしの設定保存は既存profile attachmentを削除しない。過去のprofile save、削除済みmessage/taskの古い作成requestを再送しても現在の正本を巻き戻さない。
- D1 batchを実commit後に応答喪失させても、採用済みmessage/profile R2 objectを削除せず成功状態を回復する。
- 別actorが同じrequest IDを使ってもtask、message、comment、folder member、template、R2添付、profile画像、監査が混ざらない。同一actorが異なるpayloadで再利用した場合は409となり、正本を変更しない。
- R2削除失敗を注入すると`storage_cleanup_jobs`へobject keyとrequest IDが残る。
- 親と異なる組織のattachmentをfixture上で不正関連付けしても、親削除でそのattachment metadata、R2 object、cleanup jobを変更しない。
- cleanup再試行はadmin POSTだけが実行でき、自組織のorphanだけを削除する。live参照はR2 deleteなしでjobをCAS解決し、cross-org、NULL org、完全一致replayではR2 deleteを呼ばない。失敗時はmetadataを保ったままattemptを1だけ増やす。
- cleanup workerがlease期限を越えて停止しても、旧tokenが残る間は同じkeyのattachment INSERT/UPDATEを拒否する。期限切れjobは次のretryだけが新tokenで再claimできる。
- 画面復帰時に別アカウントのCookieへ変わっていた場合、旧アカウントのin-memory状態、IndexedDB dataset cache、下書きを消してreloadするまで業務APIを送らない。ログアウト後も同じprivate cacheを消す。
- private folder非メンバーは個別・bulkの既読更新を行えず、bulkに権限外または他組織messageが1件でも混ざれば全件無変更となる。managerは既存契約どおり参照可能。
- Service Worker更新後、`APP_VERSION=2.0.0`が表示され、旧cacheから更新通知を経て切り替わる。

## ロールバック

- PagesはD1 session gateとGAS非依存を維持する直前deploymentへ戻す。migration `009`〜`014`は旧列・旧テーブルを削除しないため、そのまま残す。
- `auth_events`、追加列、`storage_cleanup_jobs`、`api_idempotency_keys`、`staged_attachments`、`session_revocations`を緊急時にDROPしない。
- `014`適用後にコードだけ旧KV-only版へ戻すと、「D1失効は成功したがKV tombstoneは失敗した」sessionを再び通す恐れがある。rollbackはD1 gateを維持する直前版へ戻すか、全sessionを強制失効してから行う。
- GAS deployment失効後は、GAS依存版へのPages rollbackや旧GAS deploymentの再公開を行わない。GAS非依存かつD1 session gateを持つdeploymentだけをrollback候補にする。
- コードrollback後は旧誤分類書込みが再開するため、監視上で明示し、長期運用しない。
- post-deploy 015のPII空化はSQLだけでは復元できない。復旧には直前exportのrestoreが必要で、cleanup後の新規書込みとの調整を伴うため、backup・drain・明示承認なしでは実行しない。
- R2/D1のデータ削除や旧ログcleanupをコードrollback手段として使わない。
