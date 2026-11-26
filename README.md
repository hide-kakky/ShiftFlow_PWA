# ShiftFlow PWA

クラウドワークフロー管理ツール ShiftFlow の最新版アーキテクチャです。  
Cloudflare Pages と Pages Functions を中核に、Google OAuth・Cloudflare D1 / KV / R2で PWA を構築しています。旧Apps Scriptは退役stubのみです。

---

## 運用メモ（Codex / Service Worker）

- 現在の APP_VERSION: `2.3.14`（`frontend/public/app-config.js` と `frontend/public/sw.js`）。フロントのファイルを一行でも触ったら、必ずこの値をインクリメントし、回答にも記載すること。
- アプリ本体の更新案内は [更新案内の仕様](docs/app-update-notice.md) を参照。
- 通知の現在仕様・アイコン件数・朝10時の任意リマインダーは [通知仕様](docs/web-push.md) と [2.2.9の変更・検証](docs/app-badge-reminder.md) を参照。
- すべての回答で日本語のコミットメッセージ案と `git commit` コマンド例を提示すること。
- 基本ルールは `CODEx_PROMPT.md` と `AGENTS.md` に従うこと。
- Wrangler の `compatibility_date` は Pages Functions / Worker どちらも `2025-11-02` で統一。

---

## システム構成

| レイヤー | 役割 | 実装/リソース | 備考 |
| --- | --- | --- | --- |
| フロントエンド | PWA / UI / Service Worker | `frontend/public`（静的 HTML/CSS/JS） | Pages でそのままホスティング。ビルド工程なし。 |
| 認証 / API | Cloudflare Pages Functions | `functions/auth/*`, `functions/api/[route].js`, `functions/config.js` | Google OAuth (PKCE) と `SESSION` Cookie でシングルサインオン。すべての業務 API を Functions 内で実装。 |
| データストア | Cloudflare D1 (`DB` binding) | `migrations/*.sql` | ユーザー / 組織 / タスク / メッセージ / 監査ログ / 添付を保存。ULID 主キー。組織のブランド / 通知設定、フォルダ / テンプレート、コメント更新表示、ユーザー個人のメッセージピン留めに対応。 |
| セッション / フラグ | Cloudflare KV (`APP_KV` binding) | `functions/utils/session.js` | セッションレコード、PKCE 初期データ、機能フラグ (`shiftflow:flags`) を保管。 |
| ファイルストレージ | Cloudflare R2 (`R2` binding) | `functions/api/[route].js`, `infra/r2/lifecycle.json` | プロフィール画像・メッセージ添付を`orgs/<org_id>/profiles/...`、`orgs/<org_id>/messages/...`へtenant分離して保存。 |
| バックアップ | 専用 Worker + R2 | `workers/r2-backup` | Cron で本番 R2 → バックアップ R2 へ差分コピー・フル検証。 |
| 診断 / 監査 | Cloudflare D1 | `auth_events`, `audit_logs`, `auth_proxy_logs` | 認証・業務監査・API障害を別の正本へ分離。D1だけをログ正本とする。 |

---

## ディレクトリガイド

| パス | 目的 |
| --- | --- |
| `frontend/public/` | 静的 PWA 一式（`index.html`・`sw.js`・`app-config.js`・`_headers` 等）。 |
| `frontend/public/_headers`, `_redirects` | Pages でのヘッダー / ルーティング設定。 |
| `functions/api/[[route]].js` | `/api/<route>` を一括で処理するメイン API。D1・R2・KV を直接呼び出し、Apps Script には依存しない。 |
| `functions/auth/` | `/auth/start` (Google OAuth), `/auth/callback`, `/auth/session`, `/auth/logout`。PKCE + SESSION Cookie を管理。 |
| `functions/utils/` | セッション・Google ID トークン検証などの共通ロジック。 |
| `functions/config.js` | `/config` エンドポイントで公開用のGoogle OAuth client IDを埋め込む。 |
| `backend/gas/` | 旧Apps Scriptの退役stub。GET/POST/OPTIONSは`gas_runtime_retired`と`httpStatus: 410`を含むJSONだけを返し、公開業務関数・サインインHTML・Spreadsheet/Drive scopeを持たない。 |
| `migrations/` | D1 用スキーマ定義 (`000_init.sql` など) と QC (`999_qc_checks.sql`)。 |
| `scripts/etl/` | スプレッドシート CSV → 正規化 JSON → `seeds/*.sql` を生成する ETL ツール。 |
| `scripts/predeploy-scan.js` | デプロイ前に `.clasp.json` など秘匿ファイルの混入をチェック。 |
| `infra/r2/` | R2 ライフサイクルポリシー。 |
| `workers/r2-backup/` | Cron Worker（R2 バックアップ）。 |

---

## Cloudflare Pages / Functions の設定

### 必須環境変数

| 変数 | 用途 |
| --- | --- |
| `CF_ORIGIN` | 許可するオリジンをカンマ区切りで指定。`https://shiftflow.pages.dev,https://shiftflow.example.com` など。 |
| `GOOGLE_OAUTH_CLIENT_ID` | Google Cloud で発行した OAuth クライアント ID（`GOOGLE_CLIENT_ID` エイリアスも可）。`functions/auth/*` と `/config` で使用。 |
| `GOOGLE_OAUTH_CLIENT_SECRET` | OAuth シークレット。`wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET` で登録し、token exchange に使用。 |
| `AUTH_RATE_LIMIT_SALT` | `/auth/start` / `/auth/callback`の短時間KV guard用secret。client IPはこの値をsaltにしたSHA-256のKV keyにだけ使い、ログ・KV valueへ保存しない。Preview / Productionで別値を設定する。 |
| `CFG_CF_AUTH`, `CFG_CACHE_BOOTSTRAP`, `CFG_CACHE_HOME`, `CFG_D1_READ`, `CFG_D1_WRITE`, `CFG_D1_PRIMARY`, `CFG_USE_JWKS` | 機能フラグ。未指定時は `readFeatureFlags` のデフォルトを採用。 |
| `CFG_FLAG_KV_KEY`（任意） | KV 上のフラグキー。デフォルト `shiftflow:flags`。 |

### バインディング（`wrangler.toml`）

- `DB` : Cloudflare D1（`app_d1_dev` / `app_d1_prod`）。  
  `wrangler d1 migrations apply app_d1_dev --remote` で開発DBへスキーマ適用。
- `APP_KV` : KV。セッション / PKCE 状態 / フラグを保存。
- `R2` : 添付・プロフィール画像用 R2 バケット。
- `compatibility_date` : `2025-11-02`（Pages Functions, Worker 共通）。

Preview / Production でそれぞれ正しい ID / バケット名に更新すること。

v2はGASへの診断mirrorと業務APIを廃止した。本番ではPages v2を先にdeployし、旧cache clientを含むGAS参照ゼロと旧ログ非増加を確認してから、旧GASをこのrepoの退役stubへ更新しweb app deploymentを失効する。Apps Scriptの`TextOutput`はHTTP status自体を変更できないため、stubの`httpStatus: 410`はbody上の退役通知であり、外部到達停止はdeployment失効で保証する。旧writerやScript Propertyによる再開経路は配布物に残さない。Pages Functions側の`captureDiagnostics`はwarn/errorだけをD1へ保存する。

退役確認後は、Pagesに残る旧`GAS_EXEC_URL`と`SHIFT_FLOW_SHARED_SECRET*`も削除する。productionでは`AUTH_RATE_LIMIT_SALT`が未登録のままv2をdeployすると認証開始がfail-closedするため、専用値の登録を先に完了する。

### Feature Flag 運用

`APP_KV` に JSON を保存することで環境ごとに切り替え可能。Productionを操作する場合は、必ず`--env production`を明示する。

```bash
# Preview / development
npx wrangler kv key put --binding=APP_KV shiftflow:flags '{"d1Read":true,"d1Primary":true}'

# Production（実行前に対象environmentを再確認）
npx wrangler kv key put --binding=APP_KV --env production shiftflow:flags '{"d1Read":true,"d1Primary":true}'
```

---

## Google OAuth とセッションフロー

1. `/auth/start` で PKCE の `code_verifier` / `code_challenge` を生成し、`APP_KV` に初期状態を保管。`CANONICAL_DOMAIN`（`shiftflow.pages.dev`）向けに Google OAuth へ 302。  
   - カスタムドメインを使う場合は `functions/auth/start.js` / `callback.js` の `CANONICAL_DOMAIN` を合わせて更新し、Google Cloud 側の **認証済みリダイレクト URI** も更新すること。
2. Google から `/auth/callback` へ戻り、`code` + `code_verifier` でトークン交換。`verifyGoogleIdToken` で ID トークンを検証。
3. 検証済みの Google `sub` とユーザー情報だけを `APP_KV` に保存し、host-only の `SESSION=<id>.<key>` Cookie を `SameSite=Lax` で発行。Googleトークンはセッションへ保存しない。
4. フロントは `/auth/session` でShiftFlowセッションを検証する。KV recordとCookie秘密鍵が一致した候補だけをD1 primaryの`session_revocations`で最終確認する。アイドル期限は30日、絶対期限は90日で、通常利用中にGoogleへ再問い合わせしない。
5. `/auth/logout` はsession IDのSHA-256 fingerprintをD1へ先に失効記録し、その後KV tombstone・session record・Cookieを破棄する。KVの伝播遅延があっても、後続リクエストはD1でfail-closedする。

---

## API / データフロー（`functions/api/[[route]].js`）

1. すべての `/api/<route>` が単一ファイルで完結。
2. ログイン時に検証済みのShiftFlowセッションをCookieから読み、`sub` / `email` / `emailVerified`を認証IDとして使う。Google ID tokenの検証はOAuth callback時だけ行う。
3. `resolveAccessContextFromD1` が `users` / `memberships` を参照し、所属組織、`status=active`、ロール（`admin` / `manager` / `member` / `guest`）を各リクエストで評価する。
4. 許可されたリクエストだけが D1 にアクセス。代表的なルート:
   - **Bootstrap**: `getBootstrapData`, `getHomeContent`, `listActiveUsers`, `listActiveFolders`
   - **タスク**: `addNewTask`, `updateTask`, `completeTask`, `deleteTaskById`, `listMyTasks`, `listCreatedTasks`, `listAllTasks`, `getTaskById`
   - **メッセージ/メモ**: `getMessages`, `getMessageById`, `addNewMessage`, `deleteMessageById`, `toggleMemoRead`, `markMemosReadBulk`
   - **添付 / 設定**: `stageAttachment`, `downloadAttachment`, `getUserSettings`, `saveUserSettings`
   - **フォルダ / テンプレート**: `listActiveFolders` に加え、フォルダ作成・更新・アーカイブ、フォルダ紐付きテンプレートの取得 / 作成（管理者権限のみ）。
5. 添付はJSON内のbase64 Data URIを受け付けない。フロントが`stageAttachment`へ画像バイナリを1件ずつ送り、D1の`staged_attachments`とR2へ30分の一時保存を作ってから、メッセージまたはプロフィール更新のD1 batchで1回だけclaimする。通常JSON bodyは1MBでhard capする。
   - プロフィール画像: 8MB、同一利用者の未確定stageは1件。新しい選択は旧未確定stageを安全にsupersedeする。
   - メッセージ添付: 10MB × 最大5件、合計50MB。画面からは逐次uploadし、Worker内の同時binary処理にも上限を置く。
   - R2 keyは`orgs/<org_id>/<profiles|messages>/objects/...`に限定し、owner・org・membership・checksum・idempotency世代をD1で検証する。
6. R2 に配置したファイルは `attachments` テーブルへメタデータを書き込み、`task_attachments` / `message_attachments` で紐付け。ダウンロードは `downloadAttachment` が認可チェック後に R2 からストリーム。
7. OAuth成功・失敗、セッション、認可は`auth_events`、業務操作は`audit_logs`へ記録。失敗理由はstable codeだけを保存し、メールは`users`を表示時にjoinする。Google `sub`、token、raw response/errorは保存しない。複数組織所属のuser-level認証イベントは`org_id=NULL`とし、監査取得時にactive membershipで各自組織へ安全に投影する。`captureDiagnostics`はredaction後のwarn/errorだけをD1の`auth_proxy_logs`へ保存する。
8. 同じread requestの同時実行はフロントで1本へまとめる。mutationは401後も自動再送せず、監査対象の業務データと監査行はD1 batchで原子的に保存する。作成IDと監査の冪等性はtenant・actor・canonical payload hash単位に分離する。`api_idempotency_keys`にはpayloadのSHA-256だけを7日間保存し、同一actor・route・request IDの異なるpayloadは409で拒否する。副作用のない通常4xxは今回作成したkeyだけをCAS解放し、期限切れkeyは次のmutation時に全actor横断で最大100件ずつ削除する。
9. ユーザー設定は`settings_version`で楽観ロックする。v2画面は取得versionを保存時に送り、競合時は入力を保持したまま再確認を促す。同時更新の部分混在、古い再送による巻き戻し、画像なし保存によるattachment誤削除を防ぐ。
10. staged R2 uploadはput前に`upload_uncommitted` cleanup候補を永続化し、正本採用時だけ解決する。stageの期限切れ・supersede後も7日idempotency世代が有効な間はtombstoneを保持し、古いrequestからの復活を拒否する。object削除失敗やcommit結果不明は`storage_cleanup_jobs`へ残し、admin限定の`POST /api/adminRetryStorageCleanup`で自組織のorphanだけを最大25件処理する。live attachment参照・有効なstage・cleanup lease中のobjectは削除しない。

---

## D1 データベース

### スキーマ

`migrations/` に段階的な SQL を用意：

- `000_init.sql`: `organizations`, `users`, `memberships`, `messages`, `message_reads`.
- `001_extend_users.sql`: GAS シート互換のユーザーメタ列（`status`, `theme`, `approved_at_ms` 等）。
- `002_add_tasks_attachments_audit.sql`: `tasks`, `task_assignees`, `attachments`, `task_attachments`, `message_attachments`, `audit_logs`, `login_audits`, `auth_proxy_logs`.
- `003_extend_organizations.sql`: `organizations` に短縮名・ブランドカラー・タイムゾーン・通知先メール・メタ情報列を追加。
- `004_add_folders_features.sql`: `folders` / `folder_members` / `templates` と旧共有ピン列を追加。
- `007_add_message_comments.sql`: メッセージの共有コメントを追加。
- `008_add_personal_message_pins.sql`: `message_pins` を追加し、ピン留めを所属ユーザーごとの状態へ分離。旧共有ピン列はロールバック用に残す。
- `009_add_v2_observability.sql`: `auth_events`、業務監査の`request_id`、R2の`storage_cleanup_jobs`を追加し、API診断へtenant snapshot列を追加。旧ログ行は保持し、manual cleanupのread-only preflight用`login_audits(request_id)` indexだけを先に追加する。
- `010_scope_api_idempotency.sql`: 7日TTL付き`api_idempotency_keys`を追加し、作成IDと業務監査をtenant + actor scopeへ分離。同じrequest IDを別actorが使っても相互に干渉させない。
- `011_add_user_settings_version.sql`: 既存userを保持して`settings_version`を追加し、設定保存を楽観ロックする。
- `012_scope_audit_idempotency_generation.sql`: 業務監査へpayload hashと7日TTL世代を追加し、同じrequest IDを期限後に再利用しても旧成功監査へ誤収束させない。
- `013_add_staged_attachments.sql`: 1件ずつのbounded binary upload、owner/org scope、quota、TTL、one-time claim、idempotency tombstoneを追加する。INSERTは`uploading`だけを許可し、claim先を`message→message`、`profile→user_settings`へ固定する。
- `014_add_session_revocations.sql`: logout済みsessionのSHA-256 fingerprintをD1 primaryで強整合に拒否する失効台帳を追加する。
- `ops/post-deploy/015_quarantine_legacy_auth_logs.sql`: 通常migration外の明示承認cleanup。旧writer停止・drain・D1 backup後だけ、paired旧誤分類行を再分類してPIIを空化する。pairにならない`login_attempt`は実認証の可能性があるため変更せず、preflightの停止条件とする。
- `999_qc_checks.sql`: テーブル間の参照整合性・NULL チェック用。

設計、段階リリース、受入確認は [`docs/v2-observability-api-stability.md`](docs/v2-observability-api-stability.md) を参照。

### 運用コマンド

```bash
# スキーマ適用（dev）
npx wrangler d1 migrations list app_d1_dev --remote
npx wrangler d1 migrations apply app_d1_dev --remote
# 品質チェック SQL
npm run qc:dev
# サンプルデータ投入（seeds/*.sql を生成済みの場合）
npm run seed:dev

# 本番は必ずpendingを確認し、expand migration 009-014をアプリコードのdeploy前に適用
npx wrangler d1 migrations list app_d1_prod --remote --env production
npx wrangler d1 migrations apply app_d1_prod --remote --env production
npm run qc:prod
```

`013`と`014`はv2コードが必要とする通常のexpand migrationであり、特に`014`未適用ではセッション検証がfail-closedして503になる。`ops/post-deploy/015_quarantine_legacy_auth_logs.sql`だけは`migrations/`に含めていない。通常の`migrations apply`では実行されず、旧GAS/Pages writer停止、件数drain、repo外D1 export、paired/unpairedのread-only preflight、不可逆なPII空化への明示承認をすべて満たした場合だけ`wrangler d1 execute --file`で個別実行する。

`npm run seed:*` は `scripts/etl/to-sql.js` が生成した `seeds/090_organizations.sql` などを順番に実行する想定（リポジトリには seeds は含まれないため必要に応じて生成）。  
CSV からの変換手順例:

```bash
node scripts/etl/normalize.js --kind users --input data/templates/users.csv
node scripts/etl/to-sql.js users
```

---

## R2 ストレージとバックアップ

### ライフサイクル

`infra/r2/lifecycle.json`は旧top-level prefixと一時object向けの既存設定を保持する。v2の正本objectは`orgs/<org_id>/...`配下なので、このファイルを更新・適用する際はlive objectを削除対象にしないことをR2 inventoryで先に確認する。

```bash
wrangler r2 bucket lifecycle put app-r2-dev --file infra/r2/lifecycle.json
wrangler r2 bucket lifecycle put app-r2-prod --file infra/r2/lifecycle.json
```

- `orgs/<org_id>/profiles/...`, `orgs/<org_id>/messages/...`: v2のlive正本。固定日数で自動削除せず、D1参照と`storage_cleanup_jobs`に基づいて回収する。
- `attachments/`, `profiles/`: 旧top-level prefix。参照有無を確認せず新しいexpirationを追加しない。
- `temp/`, `thumbnails/`, `logs/`: 旧/補助prefixの既存rule。実在objectと利用元を確認してから変更する。
- 未完了multipart uploadは全prefixで1日後に中断する。

### Cron Worker（`workers/r2-backup`）

- `PRIMARY_BUCKET` → `BACKUP_BUCKET` へ日次差分 (`0 13 * * *`) と週次フル検証 (`0 14 * * 0`) を実施。
- KV `BACKUP_STATE` に進捗 (`lastIncrementalSync`, `lastFullVerification`) を保存。
- デプロイ例:

```bash
wrangler deploy --config workers/r2-backup/wrangler.toml
wrangler tail  --config workers/r2-backup/wrangler.toml
```

---

## 開発・デプロイ手順

1. **依存インストール**: `npm install`（`wrangler` など開発ツールを取得）。
2. **D1 セットアップ**: `npx wrangler d1 migrations apply app_d1_dev`。必要なら `npm run seed:dev`。
3. **環境変数登録**: `wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET`、Pages Dashboard で `CF_ORIGIN` 等を設定。
4. **ローカル検証**: `npx wrangler dev --remote` で Functions を Cloudflare 上に接続して動作確認。`wrangler dev --remote --persist` で D1/KV/R2 の開発データを保持。
5. **ログ確認**: `npx wrangler tail`。`requestId`を基点にD1の`auth_events` / `audit_logs` / `auth_proxy_logs`を突き合わせる。
6. **事前チェック**: `node scripts/predeploy-scan.js` で秘匿ファイルが Git に混入していないか確認。
7. **デプロイ**:
   - GitHub 連携で Pages が自動デプロイ。
   - もしくは `wrangler pages deploy --branch=main frontend/public` を使用。

---

## 動作確認チェックリスト

1. **認証**: OAuth成功時は`authentication.succeeded`、state/token/verify/session保存失敗時はサーバー発行attempt単位で`authentication.failed`が1件だけ追加される。失敗行の`user_sub`とsession fingerprintはNULLで、reason code以外のtoken/raw errorを持たない。`pending` ユーザーの`/api/*`と、route-level RBAC通過後のobject-level 403は`authorization.denied`として各HTTP試行ごとに記録され、クライアントrequest IDの再利用で抑制されない。`active`へ更新後は`getBootstrapData`が200。
2. **RBAC**: `member` が `listAllTasks` を呼ぶと 403、`manager` 以上で 200。`X-ShiftFlow-Request-Id` をログで追跡。
3. **タスク CRUD**: `addNewTask` 成功後、`tasks` / `task_assignees` にレコードが作成され、`downloadAttachment` で添付を取得できる。
4. **メッセージ共同利用**: 他ユーザーのコメント追加後に `commentCount` / `hasNewComment` が一覧へ出て、詳細閲覧後に `read_at_ms` が更新される。ユーザーAのピン操作がユーザーBの `isPinned` に影響しない。
5. **セッション更新**: `/auth/session` が `authenticated: true` を返し、`expiresAt` が30日アイドル期限、`absoluteDeadline` が90日絶対期限として返る。logout後に別POPの古いKVを読ませてもD1失効で拒否され、再訪時にGoogle通信が発生しない。
6. **段階添付**: 画像を1件ずつstageし、同じrequestの再送は同じstageへ収束する。期限切れ・supersede済みstageや別ownerのstageはclaimできず、設定競合ではwinnerの画像だけが残る。
7. **R2 バックアップ**: Worker のログに `mode=incremental` / `mode=full` が出力され、`copied` 件数が期待値内である。

---

## ログ / 監視 / トラブルシューティング

- Cloudflare: `wrangler tail` で Functions / Auth / Cron Worker のログをリアルタイム確認。
- D1: `auth_events`（認証・アクセス）、`audit_logs`（業務操作）、`auth_proxy_logs`（API障害）を`request_id`と`route`で突合。`storage_cleanup_jobs`が1件以上ならR2 cleanupの再実行対象として扱う。
- R2 cleanup: adminの認証済みクライアントから`POST /api/adminRetryStorageCleanup`へ`{"args":[{"limit":10}]}`を送り、batchごとに新しい`X-ShiftFlow-Request-Id`を付ける。完全一致replayは次のjobを誤処理しないよう409で停止する。実行前後に自組織のjob件数を確認し、`resolved_live_reference`は「R2未削除・job解決済み」、`org_id IS NULL`は手動調査として扱う。
- Apps Script: `backend/gas`は全entrypointで`gas_runtime_retired`だけを返す。旧deploymentを退役stubへ更新し、最終的にdeploymentを失効することをrelease gateとする。
- D1: `wrangler d1 execute app_d1_dev --command "SELECT * FROM tasks LIMIT 5"` でデータ確認。`migrations/999_qc_checks.sql` を定期的に実行して参照整合性を担保。
- 失敗時は `functions/api/[[route]].js` の `errorResponse(where='cf-api')` が JSON で理由 (`code`, `reason`, `requestId`) を返す。R2 関連は `code=attachment_upload_failed` 等で判別可能。

---

ShiftFlow v2は「動く」だけでなく、意味の正しいログ、原子的な保存、回帰テスト、段階的ロールバックを標準とします。各コンポーネントの責務境界を保ち、変更はPreviewとQCを経て小さくリリースしてください。

## フォルダ別プッシュ通知

フォルダ単位でメッセージ・コメント・タスク依頼・タスク更新の通知を選択できます。設定UI、配信の準備、iOSの許可と制約、検証/切戻しは[Web Push運用手順](docs/web-push.md)を参照してください。配布前にDB migrationと通知用Secrets、配信Workerの設定が必要です。

## コンパクトUI（2.2.0）

メッセージは個人ピン区画と最終更新日の区画に分け、作者と時刻をカード内へ表示する。本文の改行は一覧で空白へまとめて最大2行、詳細では元の改行を保持する。ALLは全フォルダ。ヘッダー直下の細い「すべて/未読」バーはタップ・矢印キー・左右スワイプで切り替えられる。メッセージ一覧上の左スワイプは未読、右スワイプはすべて。縦スクロールとピン/フォーム操作は切替対象にしない。

ホームは見出しと独立カードへ整理し、タスクは状態・担当・期限を保持して圧縮。設定と詳細も同じ余白へ揃えた。視覚比較と未確認範囲は[design-qa.md](design-qa.md)、通知の運用は[docs/web-push.md](docs/web-push.md)。
