# ShiftFlow PWA

クラウドワークフロー管理ツール ShiftFlow の最新版アーキテクチャです。  
Cloudflare Pages と Pages Functions を中核に、Google OAuth・Cloudflare D1 / KV / R2・Apps Script（診断用）の連携で PWA を構築しています。

---

## 運用メモ（Codex / Service Worker）

- 現在の APP_VERSION: `1.0.28`（`frontend/public/sw.js` 内の定義）。フロントのファイルを一行でも触ったら、必ずこの値をインクリメントし、回答にも記載すること。
- すべての回答で日本語のコミットメッセージ案と `git commit` コマンド例を提示すること。
- 基本ルールは `CODEx_PROMPT.md` と `AGENTS.md` に従うこと。
- Wrangler の `compatibility_date` は Pages Functions / Worker どちらも `2025-11-02` で統一。

---

## システム構成

| レイヤー | 役割 | 実装/リソース | 備考 |
| --- | --- | --- | --- |
| フロントエンド | PWA / UI / Service Worker | `frontend/public`（静的 HTML/CSS/JS） | Pages でそのままホスティング。ビルド工程なし。 |
| 認証 / API | Cloudflare Pages Functions | `functions/auth/*`, `functions/api/[route].js`, `functions/config.js` | Google OAuth (PKCE) と `SESSION` Cookie でシングルサインオン。すべての業務 API を Functions 内で実装。 |
| データストア | Cloudflare D1 (`DB` binding) | `migrations/*.sql` | ユーザー / 組織 / タスク / メッセージ / 監査ログ / 添付を保存。ULID 主キー。組織のブランド / 通知設定、フォルダ / テンプレート、メッセージのピン留めに対応。 |
| セッション / フラグ | Cloudflare KV (`APP_KV` binding) | `functions/utils/session.js` | セッションレコード、PKCE 初期データ、機能フラグ (`shiftflow:flags`) を保管。 |
| ファイルストレージ | Cloudflare R2 (`R2` binding) | `functions/api/[route].js`, `infra/r2/lifecycle.json` | プロフィール画像・メッセージ添付を `/profiles`, `/attachments`, `/orgs/<id>/...` に保存。 |
| バックアップ | 専用 Worker + R2 | `workers/r2-backup` | Cron で本番 R2 → バックアップ R2 へ差分コピー・フル検証。 |
| 診断 / 監査 | Google Apps Script (`backend/gas`) | `logAuthProxyEvent` など | Functions から `captureDiagnostics` でログ転送し、`T_LoginAudit` / `T_AuthProxyLogs` を維持。主要 API は D1 側で完結。 |

---

## ディレクトリガイド

| パス | 目的 |
| --- | --- |
| `frontend/public/` | 静的 PWA 一式（`index.html`・`sw.js`・`app-config.js`・`_headers` 等）。 |
| `frontend/public/_headers`, `_redirects` | Pages でのヘッダー / ルーティング設定。 |
| `functions/api/[route].js` | `/api/<route>` を一括で処理するメイン API。D1・R2・KV を直接呼び出し、Apps Script には依存しない。 |
| `functions/auth/` | `/auth/start` (Google OAuth), `/auth/callback`, `/auth/session`, `/auth/logout`。PKCE + SESSION Cookie を管理。 |
| `functions/utils/` | セッション・Google ID トークン検証などの共通ロジック。 |
| `functions/config.js` | `/config` エンドポイントで `GAS_EXEC_URL` と `GOOGLE_CLIENT_ID` を埋め込む。 |
| `backend/gas/` | Apps Script プロジェクト。現在は診断ログ受信 (`logAuthProxyEvent`) やレガシー互換のみに利用。 |
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
| `GAS_EXEC_URL` | Apps Script `/exec` URL（`GAS_WEB_APP_URL` でも可）。診断ログ送信 (`captureDiagnostics`) で利用。未設定でも API 実行自体は可能。 |
| `SHIFT_FLOW_SHARED_SECRET` / `_NEXT` | Functions → GAS 通信用シークレット。ローテーション時は `_NEXT` に新値を入れておく。 |
| `CFG_CF_AUTH`, `CFG_CACHE_BOOTSTRAP`, `CFG_CACHE_HOME`, `CFG_D1_READ`, `CFG_D1_WRITE`, `CFG_D1_PRIMARY`, `CFG_USE_JWKS` | 機能フラグ。未指定時は `readFeatureFlags` のデフォルトを採用。 |
| `CFG_FLAG_KV_KEY`（任意） | KV 上のフラグキー。デフォルト `shiftflow:flags`。 |

### バインディング（`wrangler.toml`）

- `DB` : Cloudflare D1（`app_d1_dev` / `app_d1_prod`）。  
  `wrangler d1 migrations apply app_d1_dev` でスキーマ適用。
- `APP_KV` : KV。セッション / PKCE 状態 / フラグを保存。
- `R2` : 添付・プロフィール画像用 R2 バケット。
- `compatibility_date` : `2025-11-02`（Pages Functions, Worker 共通）。

Preview / Production でそれぞれ正しい ID / バケット名に更新すること。

### Feature Flag 運用

`APP_KV` に JSON を保存することで本番稼働中でも即時切り替えが可能。

```bash
wrangler kv key put --binding=APP_KV shiftflow:flags '{"d1Read":true,"d1Primary":true}'
```

---

## Google OAuth とセッションフロー

1. `/auth/start` で PKCE の `code_verifier` / `code_challenge` を生成し、`APP_KV` に初期状態を保管。`CANONICAL_DOMAIN`（`shiftflow.pages.dev`）向けに Google OAuth へ 302。  
   - カスタムドメインを使う場合は `functions/auth/start.js` / `callback.js` の `CANONICAL_DOMAIN` を合わせて更新し、Google Cloud 側の **認証済みリダイレクト URI** も更新すること。
2. Google から `/auth/callback` へ戻り、`code` + `code_verifier` でトークン交換。`verifyGoogleIdToken` で ID トークンを検証。
3. `APP_KV` にセッションを保存し、`SESSION=<id>.<key>` Cookie を SameSite=None で発行。
4. フロントは `/auth/session` へ定期ポーリングし、`SESSION` Cookie を検証。期限が近ければリフレッシュトークンで Google トークンを延命。
5. `/auth/logout` でセッション破棄 & Cookie 失効。

---

## API / データフロー（`functions/api/[route].js`）

1. すべての `/api/<route>` が単一ファイルで完結。
2. `GOOGLE_OAUTH_CLIENT_ID` を使って ID トークンを JWKS または TokenInfo API で検証。
3. `resolveAccessContextFromD1` が `users` / `memberships` を参照し、`status=active` かつロール（`admin` / `manager` / `member` / `guest`）を評価。結果はメモリキャッシュ (`ACTIVE_ACCESS_CACHE_TTL_MS`) に短時間保持。
4. 許可されたリクエストだけが D1 にアクセス。代表的なルート:
   - **Bootstrap**: `getBootstrapData`, `getHomeContent`, `listActiveUsers`, `listActiveFolders`
   - **タスク**: `addNewTask`, `updateTask`, `completeTask`, `deleteTaskById`, `listMyTasks`, `listCreatedTasks`, `listAllTasks`, `getTaskById`
   - **メッセージ/メモ**: `getMessages`, `getMessageById`, `addNewMessage`, `deleteMessageById`, `toggleMemoRead`, `markMemosReadBulk`
   - **添付 / 設定**: `downloadAttachment`, `getUserSettings`, `saveUserSettings`
   - **フォルダ / テンプレート**: `listActiveFolders` に加え、フォルダ作成・更新・アーカイブ、フォルダ紐付きテンプレートの取得 / 作成（管理者権限のみ）。
5. 添付データは base64 Data URI を `storeDataUriInR2` 経由で R2 へ保存。  
   - プロフィール画像: 2MB, `profiles/` プレフィックス。  
   - メッセージ添付: 4MB × 最大 3 件, `attachments/` または `orgs/<org_id>/attachments/`。
6. R2 に配置したファイルは `attachments` テーブルへメタデータを書き込み、`task_attachments` / `message_attachments` で紐付け。ダウンロードは `downloadAttachment` が認可チェック後に R2 からストリーム。
7. 重要なイベントは `captureDiagnostics` で Apps Script に転送し、Sheets (`T_LoginAudit`, `T_AuthProxyLogs`) に記録。`SHIFT_FLOW_SHARED_SECRET` で署名を共通化。

---

## D1 データベース

### スキーマ

`migrations/` に段階的な SQL を用意：

- `000_init.sql`: `organizations`, `users`, `memberships`, `messages`, `message_reads`.
- `001_extend_users.sql`: GAS シート互換のユーザーメタ列（`status`, `theme`, `approved_at_ms` 等）。
- `002_add_tasks_attachments_audit.sql`: `tasks`, `task_assignees`, `attachments`, `task_attachments`, `message_attachments`, `audit_logs`, `login_audits`, `auth_proxy_logs`.
- `003_extend_organizations.sql`: `organizations` に短縮名・ブランドカラー・タイムゾーン・通知先メール・メタ情報列を追加。
- `004_add_folders_features.sql`: `folders` / `folder_members` / `templates` を追加し、メッセージのフォルダ紐付けとピン留めをサポート。
- `999_qc_checks.sql`: テーブル間の参照整合性・NULL チェック用。

### 運用コマンド

```bash
# スキーマ適用（dev）
npx wrangler d1 migrations apply app_d1_dev
# 品質チェック SQL
npm run qc:dev
# サンプルデータ投入（seeds/*.sql を生成済みの場合）
npm run seed:dev
```

`npm run seed:*` は `scripts/etl/to-sql.js` が生成した `seeds/090_organizations.sql` などを順番に実行する想定（リポジトリには seeds は含まれないため必要に応じて生成）。  
CSV からの変換手順例:

```bash
node scripts/etl/normalize.js --kind users --input data/templates/users.csv
node scripts/etl/to-sql.js users
```

---

## R2 ストレージとバックアップ

### ライフサイクル

`infra/r2/lifecycle.json` を各バケットへ適用し、プレフィックスごとの保持ポリシーを統一。

```bash
wrangler r2 bucket lifecycle put app-r2-dev --file infra/r2/lifecycle.json
wrangler r2 bucket lifecycle put app-r2-prod --file infra/r2/lifecycle.json
```

- `attachments/` : 90 日で Infrequent Access に移行、削除しない。
- `profiles/` : 30 日で削除（最新のみ保持）。
- `temp/`, `thumbnails/` : 短期で自動削除 + 未完了 MPU の強制中断。
- `logs/` : 90 日保持。

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
5. **ログ確認**: `npx wrangler tail`。`requestId` を基点に Apps Script 側シート (`T_LoginAudit`, `T_AuthProxyLogs`) と突き合わせる。
6. **事前チェック**: `node scripts/predeploy-scan.js` で秘匿ファイルが Git に混入していないか確認。
7. **デプロイ**:
   - GitHub 連携で Pages が自動デプロイ。
   - もしくは `wrangler pages deploy --branch=main frontend/public` を使用。

---

## 動作確認チェックリスト

1. **認証**: `pending` ユーザーでサインイン → `/api/*` が 403、D1 の `login_audits.status` に `pending` が追加される。`active` へ更新後は `getBootstrapData` が 200。
2. **RBAC**: `member` が `listAllTasks` を呼ぶと 403、`manager` 以上で 200。`X-ShiftFlow-Request-Id` をログで追跡。
3. **タスク CRUD**: `addNewTask` 成功後、`tasks` / `task_assignees` にレコードが作成され、`downloadAttachment` で添付を取得できる。
4. **メッセージ既読管理**: `toggleMemoRead` → `message_reads` に `membership_id` が追加され、再実行で `read_at_ms` 更新。
5. **セッション更新**: `/auth/session` が `authenticated: true` を返し、`expiresAt` が Google ID トークンの期限より 60 秒以上先になっている。
6. **R2 バックアップ**: Worker のログに `mode=incremental` / `mode=full` が出力され、`copied` 件数が期待値内である。

---

## ログ / 監視 / トラブルシューティング

- Cloudflare: `wrangler tail` で Functions / Auth / Cron Worker のログをリアルタイム確認。
- Apps Script: `backend/gas` の `logAuthProxyEvent` で `T_AuthProxyLogs`, `T_LoginAudit` に書き込み。`requestId` と `route` を基点に突合。
- D1: `wrangler d1 execute app_d1_dev --command "SELECT * FROM tasks LIMIT 5"` でデータ確認。`migrations/999_qc_checks.sql` を定期的に実行して参照整合性を担保。
- 失敗時は `functions/api/[route].js` の `errorResponse(where='cf-api')` が JSON で理由 (`code`, `reason`, `requestId`) を返す。R2 関連は `code=attachment_upload_failed` 等で判別可能。

---

ShiftFlow は「まず動く最小プロダクト」を優先する方針です。各コンポーネントは単独で差し替えられるように責務を分離しているため、必要に応じて Cloudflare / Google 側の設定を更新しつつ、最小構成でのデプロイから育ててください。
