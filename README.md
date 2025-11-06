# ShiftFlow PWA

クラウドワークフロー管理ツール ShiftFlow のアーキテクチャとデプロイ手順をまとめた最新版ドキュメントです。フロントエンドは Cloudflare Pages、バックエンドは Google Apps Script (GAS) で構成され、Cloudflare Pages Functions が API プロキシとして両者を橋渡しします。

---

## 全体構成

| 層 | 役割 | ソース配置 |
| --- | --- | --- |
| フロントエンド | React/静的アセット配信 | `frontend/public`
| API プロキシ | Cloudflare Pages Functions ( `/api/*` ) | `functions/api/[route].js`
| バックエンド | Google Apps Script Web App | `backend/gas`

- Functions がブラウザから送られる Google ID トークンを検証し、Apps Script へ JSON でリクエストを転送します。
- `resolveAccessContext` ルートで RBAC 判定を行い、シート上のユーザー情報を元にアクセス制御します。
- GAS が返す 302 を Functions が追跡し、メソッド・ボディを適切に調整して最終レスポンスを JSON で取得します。

---

## 前提環境

- Node.js 18+
- `wrangler` 4.x
- `clasp` 最新版
- Google Workspace (Drive / Spreadsheet API 利用権限)

---

## Cloudflare Pages 設定

1. Pages プロジェクトの **Build output directory** を `frontend/public` に設定。
2. デプロイブランチは `main` を想定（必要に応じて変更可）。
3. Production / Preview 共通の環境変数を設定。
   - `CF_ORIGIN`: 許可するオリジン（カンマ区切り可）。
   - `GAS_EXEC_URL`: Apps Script デプロイの `/exec` URL。
   - `GOOGLE_OAUTH_CLIENT_ID`: Google Identity Services のクライアント ID。
   - `SHIFT_FLOW_SHARED_SECRET`: Functions ↔ GAS 間で共有するシークレット。
4. `_redirects` で直接 GAS を指す設定は不要。Functions がプロキシを担当します。
5. カスタムドメインは後から追加可能。初期は `*.pages.dev` のみで構いません。

---

## Cloudflare Functions (`functions/api/[route].js`)

### 概要
- `/api/<route>` を受け取り、ID トークンを `tokeninfo` で検証したうえで Apps Script にルーティング。
- `resolveAccessContext` を呼び出してロール・ステータスを確認し、必要なら 302/403 を返します。
- Apps Script が返す `script.googleusercontent.com` 向けの 302 を追跡し、POST → GET への変換や `Content-Type` / ボディのリセットを実施。
- Authorization がヘッダーで落ちた場合でも、JSON ボディ `authorization` / `headers.Authorization` に付与して再送することで GAS 側で復元可能にしています。
- 重要ログは `captureDiagnostics` を通じて Apps Script 側に転送し、`T_AuthProxyLogs` シートへ記録。

### 注意点
- `CF_ORIGIN` に Preview 用ドメインを忘れず追加する。
- リダイレクト追跡は 4 回まで。上限超過時は 401 もしくは 403 を返します。
- Functions 側でもルート毎のロールチェックを実施します（`getAuditLogs` は admin/manager のみ等）。

---

## Apps Script (`backend/gas`)

1. `appsscript.json` は `webapp.executeAs: USER_DEPLOYING` を維持（スクリプト所有者権限で実行）。
2. Script Properties に以下を設定。
   - `GOOGLE_OAUTH_CLIENT_ID`
   - `SHIFT_FLOW_SHARED_SECRET`
   - `SHIFT_FLOW_SECRET_OPTIONAL`（必要に応じて `true`）
   - `PROFILE_IMAGE_FOLDER_ID` / `MESSAGE_ATTACHMENT_FOLDER_ID` など既存値
3. スプレッドシート設定
   - `M_Users`: `AuthSubject`, `Status`, `FirstLoginAt`, `LastLoginAt`, `ApprovedBy`, `ApprovedAt`, `Notes` 列を追加。`Status=active` のユーザーが API 許可対象。
   - `T_LoginAudit`: `LoginID,UserEmail,UserSub,Status,Reason,RequestID,TokenIat,AttemptedAt,ClientIp,UserAgent,Role`
   - `T_AuthProxyLogs`: Functions からのログ置き場（初回アクセスで自動生成）。
4. `backend/gas/code.js` の `doPost` は `authorization` や `headers.Authorization` をボディから読み込み、ヘッダー欠損時でもトークン検証可能。
5. デプロイ: `clasp push` → `clasp deploy` で公開バージョン更新。公開後は `/exec` URL を `GAS_EXEC_URL` に反映。

---

## 認証フローと RBAC

1. ブラウザは Cloudflare Pages に ID トークンを送信。
2. Functions がトークン検証 → `resolveAccessContext` へ委譲。
3. GAS が `M_Users` を参照し、`Status=active` かつロールが許可されていれば `ok: true` を返す。
4. 以降の API 呼び出し (`getBootstrapData` など) は同一トークンで処理し、`T_Audit` に記録。
5. `pending` / `suspended` ユーザーは 403 とメッセージを返す。ログは `T_LoginAudit` と `T_Audit` に残る。

---

## ログと監視

- `wrangler tail` で Functions のリアルタイムログを確認。
- Apps Script の実行ログでは `doPost` のリクエスト ID・ボディを確認可能。
- `captureDiagnostics` の結果は `T_AuthProxyLogs` に書き込まれ、Cloudflare ↔ GAS でのエラーや 302 追跡状況を追跡できる。

---

## テストチェックリスト

1. `Status=pending` のユーザーでサインイン→403 & `T_LoginAudit` に `pending` エントリ。
2. `Status=active` に変更後、同ユーザーで API が成功し `T_Audit` に `allow` ログ。
3. ロール制限: `member` で更新系 API が成功、`guest` は 403、`admin`/`manager` のみのルートが一般ユーザーで拒否される。
4. トークン期限切れ時に再ログインが誘導される。
5. 許可外オリジンからのリクエストが 403 (CORS) になる。

---

## デプロイ前チェック

- `frontend/public` が最新ビルドになっているか。
- Functions の環境変数 (`GAS_EXEC_URL` 等) が本番値に更新済みか。
- Apps Script デプロイで最新バージョンが本番に適用されているか。
- `wrangler deploy` または Git 連携による Pages デプロイが成功しているか。
- Apps Script の実行ログにエラーがないか。

---

## 開発 Tips

- `wrangler dev --remote` で実環境に近い挙動を確認可能。
- `requestId` をログ間で突き合わせると、Functions ⇔ GAS 双方の処理を追跡しやすい。
- 認証回りの改修後は `resolveAccessContext` → `getBootstrapData` の 302/200 ログが順番通り出ることを必ず確認する。

---

## R2 ライフサイクル & バックアップ運用

### ライフサイクルポリシー

- `infra/r2/lifecycle.json` に本番バケット向けのルールを定義済み。
  - `attachments/`: 削除せず 90 日後に Infrequent Access へ自動遷移。
  - `profiles/`: 30 日後に削除（最新版のみを保持する想定）。
  - `temp/`: 24 時間で削除＋未完了 MPU を 1 日で強制中断。
  - `thumbnails/`: 30 日で削除（キャッシュ扱い）。
  - `logs/`: 90 日で削除。
  - グローバルルールで全オブジェクトの未完了 MPU を 1 日で強制中断。
- 適用コマンド例（dev/prod でそれぞれ実行）:

  ```bash
  wrangler r2 bucket lifecycle put app-r2-dev --file infra/r2/lifecycle.json
  wrangler r2 bucket lifecycle put app-r2-prod --file infra/r2/lifecycle.json
  ```

### Cron Worker によるバックアップ

- `workers/r2-backup/` は R2 → 別バケット（別リージョン推奨）への日次差分コピーと週次フル検証を行う Worker。
  - 日次: `0 13 * * *` (UTC) のスケジュールで実行し、`BACKUP_INCLUDE_PREFIXES` に一致するキーのみコピー。
  - 週次フル検証: `0 14 * * 0` (UTC) で、バックアップ側と突合し不足分を再コピー。
  - 進捗は `BACKUP_STATE`（KV）に保存し、再実行時に差分のみを走査。
  - `BACKUP_EXCLUDE_PREFIXES` で `temp/` や `thumbnails/` をバックアップ対象から除外。
  - `MAX_OBJECTS_PER_RUN`／`MAX_PUT_OPERATIONS_PER_RUN` で 1 回あたりの処理上限を制御（Cron 実行時間 15 分上限対策）。

#### セットアップ手順

1. バックアップ用 R2 バケット（地域を分ける）と KV ネームスペースを作成。
2. `workers/r2-backup/wrangler.toml` を編集し、バケット名・KV ID・スケジュールを実環境値に書き換え。
3. 必要に応じて `BACKUP_INCLUDE_PREFIXES` / `BACKUP_EXCLUDE_PREFIXES` を調整。
4. `wrangler deploy --config workers/r2-backup/wrangler.toml` でデプロイ。
5. `wrangler tail --config workers/r2-backup/wrangler.toml` で初回実行のログを確認。

### 運用ポイント

- バックアップ元・先どちらにもライフサイクル適用を忘れずに（バックアップ側は削除ポリシーを緩めて長期保持）。
- コスト最適化:
  - 添付（`attachments/`）は Infrequent Access の利用で保管コストを抑制。
  - サムネイルや一時ファイル（`thumbnails/`, `temp/`）は短期保持に限定し、生成コスト > 保存コストにならないよう整理。
- 週次フル検証時のログを定期的にチェックし、欠損オブジェクトが出ていないか監査。
- 将来的に監査ログが増える場合は `logs/` プレフィックスを別バケットに切り出す運用も検討。
