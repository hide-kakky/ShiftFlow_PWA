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
3. 現状は環境変数の設定は不要です。
4. カスタムドメインはあとで追加できます。初期構築ではデフォルトの `*.pages.dev` を利用します。
5. `_redirects` の GAS URL を実環境の URL に差し替えるときは、`frontend/public/_redirects` の `https://script.google.com/macros/s/AKfycbx.../exec` 部分を、Apps Script デプロイ画面で取得した **Web アプリ URL** に置き換えてから再デプロイしてください（外部リダイレクトは `302` など 3xx を用いる点に注意。Functions プロキシ利用時は自動で同一オリジン化されます）。

## API プロキシ (Cloudflare Functions)
- Cloudflare Pages の Functions で `/api/*` を `functions/api/[route].js` が受け取り、Apps Script Web App へプロキシします。
- ルートパラメータは `route` クエリに渡されるため、GAS 側では `e.parameter.route` でハンドリングできます。
- 追加のクエリ・POST ボディもそのまま転送され、レスポンスには CORS ヘッダーが付与されます。

## デプロイ前チェック
- ローカルで `node scripts/predeploy-scan.js` を実行し、リポジトリ直下に `.clasp.json` や `appsscript.json` などの公開非推奨ファイルがないか確認します（警告が出た場合は `backend/gas` へ移動するなどで対応）。
- VSCode のタスク化も可能です。必要に応じて `.vscode/tasks.json` へ追加してください。
