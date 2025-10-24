# ShiftFlow PWA

## Frontend (Cloudflare Pages)
- Static assets served by Cloudflare Pages live in `frontend/public`.
- Set the Cloudflare Pages **Build Output Directory** to `frontend/public`.

## Backend (Apps Script API)
- Google Apps Script source is isolated in `backend/gas`.
- Managed through clasp; deploy independently from the frontend.
- Cloudflare Functions proxy (planned) should live under `functions/api/proxy` when switching away from direct redirects.

## Cloudflare Pages 設定手順
1. Pages プロジェクト設定の **Build output directory** を `frontend/public` に指定します。
2. デプロイトリガーは `main` ブランチに設定するのが一般的です（必要に応じて変更してください）。
3. 環境変数を Production / Preview ともに設定します。
   - `CF_ORIGIN`: Cloudflare Pages の公開 URL（例 `https://shiftflow.pages.dev`）。複数許可する場合はカンマ区切り。
   - `GAS_EXEC_URL`: Apps Script 公開デプロイの `/exec` URL。
   - `GOOGLE_OAUTH_CLIENT_ID`: Google Identity Services の OAuth クライアント ID。
   - `SHIFT_FLOW_SHARED_SECRET`: Cloudflare ⇔ Apps Script 間で共有するシークレット文字列（任意のランダム値）。
4. `_redirects` で直接 Apps Script へリダイレクトしていた箇所は不要です。Functions から `GAS_EXEC_URL` へプロキシされます。
5. カスタムドメインはあとで追加できます。初期構築ではデフォルトの `*.pages.dev` を利用します。

## API プロキシ (Cloudflare Functions)
- Cloudflare Pages の Functions で `/api/*` を `functions/api/[route].js` が受け取り、Apps Script Web App へプロキシします。
- ルートパラメータは `route` クエリに渡されるため、GAS 側では `e.parameter.route` でハンドリングできます。
- 追加のクエリ・POST ボディもそのまま転送され、レスポンスには CORS ヘッダーが付与されます。

## Apps Script 設定
1. `backend/gas/appsscript.json` の `webapp.executeAs` は `USER_DEPLOYING` のままを維持します（すべての処理は Apps Script オーナー権限で実行されます）。
2. スクリプト プロパティに以下を登録してください。
   - `GOOGLE_OAUTH_CLIENT_ID`: Google Identity Services のクライアント ID。
   - `SHIFT_FLOW_SHARED_SECRET`: Cloudflare Pages と共有するシークレット文字列（Cloudflare 側と同じ値）。
   - 既存の `PROFILE_IMAGE_FOLDER_ID` や `MESSAGE_ATTACHMENT_FOLDER_ID` などもこれまでどおり利用します。
3. `M_Users` シートには以下の列を追加済みであることを確認してください。
   - 追加列: `AuthSubject`, `Status`, `FirstLoginAt`, `LastLoginAt`, `ApprovedBy`, `ApprovedAt`, `Notes`
   - 既存列 (Email / Role など) と併せて `_ensureColumns` が自動補完します。
   - 新規ユーザーは `Status=pending` として仮登録されるため、管理者が `Status=active` (`IsActive=TRUE`) に変更してから利用を開始します。
4. `T_LoginAudit` シートを新規作成し、`LoginID,UserEmail,UserSub,Status,Reason,RequestID,TokenIat,AttemptedAt,ClientIp,UserAgent,Role` のヘッダーを設定してください。Apps Script がログイン試行を追記します。
5. 変更後は `clasp push` → `clasp deploy` で Apps Script を更新してください。

## RBAC の挙動と承認フロー
- Cloudflare Functions で Google ID トークンを `tokeninfo` で検証し、`resolveAccessContext` ルートを通じて Apps Script 側の RBAC 判定を取得します。
- `M_Users` の `Status` が `active` のユーザーのみ API 実行が許可されます。`pending` や `suspended` の場合は 403 が返り、「承認待ちです」などのメッセージがサインイン画面に表示されます。
- ルートごとの必要ロールは `functions/api/config.js` / `backend/gas/code.js` の `ROUTE_PERMISSIONS` で一元管理しています（例: `deleteTaskById` は `admin / manager / member`）。
- すべての API リクエストは `T_Audit` に `api` エントリとして記録されます（`allow/deny/error` + `requestId` 等）。ログイン試行は `T_LoginAudit` に記録され、手動承認の判断材料として利用できます。

## テスト観点
1. 未承認ユーザーでサインイン → API 呼び出しが 403 となり `T_LoginAudit` に `pending` が残ることを確認。
2. `M_Users` の `Status` を `active` に変更 → 同ユーザーが API 実行でき、`T_Audit` に `allow` が追加されることを確認。
3. ロールごとの権限制御
   - `member` ユーザーでメッセージ投稿・自身のメッセージ削除が成功すること。
   - `guest` ユーザーで更新系 API が 403 になること。
   - `manager` / `admin` のみ実行可能なルート（例: `getAuditLogs`）が一般ユーザーでは弾かれること。
4. CORS: Cloudflare Pages 以外のオリジンから `fetch` すると 403 が返ること。
5. トークン失効: ブラウザのシークレットウィンドウでサインイン後、トークン有効期限切れで再サインインが要求されることを確認。

テスト時は `functions/api/[route].js` の `CF_ORIGIN` が本番ドメインのみ許可されている点に注意し、必要に応じて Preview 用のオリジンを環境変数に追加してください。

## デプロイ前チェック
- ローカルで `node scripts/predeploy-scan.js` を実行し、リポジトリ直下に `.clasp.json` や `appsscript.json` などの公開非推奨ファイルがないか確認します（警告が出た場合は `backend/gas` へ移動するなどで対応）。
- VSCode のタスク化も可能です。必要に応じて `.vscode/tasks.json` へ追加してください。
