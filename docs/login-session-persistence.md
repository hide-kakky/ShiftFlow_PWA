# ログイン状態保持実装ガイド

ShiftFlow で「Google でログイン」を一度行った後、ページ再訪や PWA 再起動時に再認証を要求せず安全に利用を続けるための実装メモ。Cloudflare Functions（`functions/auth/*`, `functions/api/[[route]].js`）とフロント（`frontend/public/index.html`）の現行構成を前提に、セッションの保持・更新・失効の扱いを整理する。

## 模擬プラン（LINE 風の長期ログインを目指しつつ安全性も担保）
- **トークン二段構え**: 短期トークン（id_token 1h 目安）＋長期トークン（refresh_token 30d 目安）。短期が切れたら自動で長期から再発行し、ユーザーは気付かず継続。
- **端末ごとに発行・失効**: 長期トークンは端末単位でサーバー保存（KV）。設定画面に「ログイン中の端末リスト＋強制ログアウト」を用意し、紛失端末をワンタップで無効化。
- **タイムアウト方針**: アイドル 12 時間／絶対 30 日案。延命と引き換えに、重要操作（承認/削除）前は再認証を挟む。現行の 6h/7d から段階的に緩和する。
- **自動更新の強化**: 残り 5 分でリフレッシュを試行し、失敗時は 1 回だけリトライ。その後失敗なら安全側に振ってサインアウト＋再ログイン案内。
- **異常検知**: IP/UA 変化が大きい場合は短期トークンを拒否し、長期トークンから再発行する際に追加確認（再認証 or メールワンタイムリンク）を要求。
- **Cookie/セキュリティ**: `SameSite=None; Secure; HttpOnly` を維持し、`credentials: 'include'` を前提にする。長期トークンはクライアントに置かずサーバー保存のみ。
- **監査と通知**: 端末追加・強制ログアウト・異常検知を `login_audits`/`auth_proxy_logs` に記録し、必要ならメール/アプリ内通知でユーザーへ告知。

## セッションモデル
- **セッション ID/キー**: Cookie `SESSION=<id>.<key>` を発行。`<key>` の SHA-256 を KV に保存するため、キー自体はサーバーに残らない。
- **ストレージ**: `APP_KV` に `sf:sessions:<id>` で JSON を保存。`user` 情報と Google トークン（`idToken`/`accessToken`/`refreshToken`/`expiry`）を含む。
- **タイムアウト**: アイドル 12 時間（`SESSION_IDLE_TIMEOUT_MS`）、絶対 30 日（`SESSION_ABSOLUTE_TIMEOUT_MS`）。KV の TTL も 30 日。
- **Cookie 属性**: `Domain=shiftflow.pages.dev; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=7d`。ログアウト時は `Max-Age=0`。
- **書き込み間引き**: 5 分以内の連続 `touchSession` はスキップして KV 負荷を抑制。

## ログイン〜セッション確立フロー
1. `/auth/start` で PKCE state を KV＋Cookie (`OAUTH_STATE`, `PKCE_CODE_VERIFIER`) に保存し、Google OAuth (offline, `prompt=select_account`) へリダイレクト。
2. `/auth/callback` で `code` を `id_token`/`refresh_token` に交換し、Google ID Token を検証。
3. KV にセッションを作成し、`SESSION` Cookie を `Set-Cookie`。`returnTo` パスへ 302。
4. 初回表示時、フロントの `syncAuthSession()` が `/auth/session` を `credentials: 'include'` で呼び、`authenticated: true` なら `SESSION` を採用し UI を初期化。

## セッション維持と自動更新
- **/auth/session**: 認証状態を返す GET エンドポイント。期限 5 分前に `refresh_token` で Google トークンを再発行し、KV と Cookie を更新する。アイドル/絶対タイムアウト超過時は `authenticated: false` と失効理由を返し、Cookie を破棄。
- **API 呼び出し時の自動付与** (`functions/api/[[route]].js`):
  - `Authorization` ヘッダーが無い場合、`SESSION` Cookie から idToken を抽出。
  - 残り 5 分以下なら `refresh_token` で更新し、`Set-Cookie` で新しい `SESSION` を返す（1 回リトライ付き）。
  - 更新に失敗した場合は Cookie を期限切れにして 401 を返却。
- **フロントのキャッシュ**: `syncAuthSession()` は 3 分キャッシュし、`expiresAt` が 60 秒未満なら強制更新。認証済みなら `setAuthToken('SESSION')` で API 呼び出しに Cookie を使わせる。

## セッション失効・ログアウト
- **手動ログアウト**: `/auth/logout` へ `POST`。KV のセッション削除＋失効 Cookie を返す。
- **自動失効ハンドリング**: `/auth/session` が `idle_timeout`/`absolute_timeout` を返した場合、フロントはオーバーレイで再ログインを促す。`no_session` は Cookie 不在または検証失敗。
- **異常系**: Google リフレッシュ失敗時はログに警告を残し、次回リクエストで再ログインを求める。Apps Script 側のアクセスポリシーに拒否された場合は 403 で理由を含む。

## 実装チェックリスト
- [ ] `APP_KV` バインディングが有効か確認（`session.js`/`[[route]].js` が前提）。
  - 不足時はエラーになるため、Pages/Functions の環境変数で `APP_KV` を設定。
- [ ] `Session` Cookie を必要な画面で送るため `fetch(..., { credentials: 'include' })` を徹底。
- [ ] `Set-Cookie` がブラウザにブロックされないよう、`https://shiftflow.pages.dev` からアクセスし `SameSite=None; Secure` を守る。
- [ ] タイムアウト理由を UI で表示し、再ログイン導線（Google ボタン）へ確実に戻す。
- [ ] バックエンドはセッション有効時のみ `login_audits`/`auth_proxy_logs` に `status=active` を残すことを確認し、失効時の挙動を手元で `/auth/session` → `/api/home` で再現する。

## 簡易テスト手順
1. ブラウザでサインイン後、DevTools → Application → Storage で Cookie `SESSION` を確認。
2. 新しいタブで `/auth/session` を開き `authenticated: true` になることを確認。レスポンスヘッダーに `Set-Cookie: SESSION=...; Max-Age=604800` が付く。
3. Network タブで `SESSION` を削除し `/auth/session` を再実行 → `authenticated: false, reason: "no_session"` になることを確認。
4. KV にある対象セッションキーを消す（管理者操作）→ `/auth/session` が失効扱いになることを確認。
