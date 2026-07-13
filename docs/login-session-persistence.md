# ログインセッション永続化ガイド

ShiftFlow v1.6.0 では、Google OAuth を「ログイン時の本人確認」に限定し、その後の利用は Cloudflare KV に保存した ShiftFlow セッションで継続する。Google のアクセストークンやリフレッシュトークンを長期保存しないため、Google トークンの更新失敗で突然ログアウトする経路をなくしつつ、再訪時はすぐにアプリを開ける。

## ユーザー体験

- 初回ログイン、手動ログアウト後、30日以上利用しなかった場合、または90日の絶対期限後だけ Google ログインを求める。
- 通常の再訪、ページ更新、PWA再起動では `/auth/session` が保存済みセッションを確認し、そのままアプリを初期化する。
- 削除や権限変更では Google 再認証を挟まず、アプリ内の確認モーダルを表示する。
- 管理者が所属・状態・ロールを変更した結果は、次のAPIリクエストでD1から再評価する。

## セッションモデル

- Cookie: `SESSION=<id>.<key>`。`<key>` 自体はサーバーへ保存せず、SHA-256ハッシュだけをKVに保存する。
- KVキー: `sf:sessions:<id>`。
- 保存内容: `sessionVersion`, Googleの不変IDである`sub`, email, emailVerified, 表示名, 画像URL, 作成・最終利用時刻。Googleトークンは保存しない。
- アイドル期限: 30日。利用時にスライドする。
- 絶対期限: 90日。利用を続けても作成時刻から延長しない。
- Cookie寿命: 最大30日。ただし90日の絶対期限を超えないよう短縮する。
- KV書き込み: 最終利用時刻の更新は5分間隔に間引く。

Cookieは `Path=/; HttpOnly; Secure; SameSite=Lax` のhost-only Cookieとする。`Domain`を付けないため、Pagesのpreviewサブドメインへ本番セッションを送らない。v1.6.0への移行時は旧 `Domain=shiftflow.pages.dev` Cookieを同時に失効する。

## ログインフロー

1. `/auth/start` がPKCE verifier/challengeとstateを生成する。
2. state/verifierは5分有効のhost-only CookieとKVへ保存し、Google OAuthへ移動する。
3. `/auth/callback` はstate CookieとPKCE Cookieの両方を必須とし、ログインCSRFを防ぐ。
4. Googleから受け取ったID tokenを署名・issuer・audience・有効期限・email_verifiedまで検証する。
5. 検証済みの`sub`とユーザー情報からShiftFlowセッションを作り、Google tokenは破棄する。
6. host-only `SESSION` Cookieを発行して元の画面へ戻る。

## 通常リクエスト

- `/auth/session` と `/api/*` は `SESSION` Cookieを検証し、アイドル期限と絶対期限を確認する。
- セッションの`sub/email/emailVerified`を認証済みIDとして使い、D1の`users/memberships`で所属組織・状態・ロールを毎回評価する。
- Bearer tokenやGoogleへの再問い合わせには依存しない。
- 認証レスポンスは `Cache-Control: private, no-store`。Service Workerも `/auth/*` と `/api/*` をCache Storageへ保存しない。
- 所属なし、停止、剥奪、Google subject不一致は拒否する。既定組織へのフォールバックは行わない。

## 失効とログアウト

- `idle_timeout`: 最終利用から30日経過。
- `absolute_timeout`: セッション作成から90日経過。
- `no_session`: Cookieなし、KVレコードなし、Cookie改ざん、不正形式。
- `/auth/logout`: Originを確認し、正しいセッションキーを検証できた場合だけKVを削除する。ブラウザのhost-only/旧Domain Cookieは常に失効する。
- 旧v1セッションは、保存済みID tokenに`sub/email/email_verified=true`がある場合のみtokenを除去してv2へ一度だけ移行する。それ以外は再ログインを求める。

## 検証

```bash
npm test
npm run check
```

手動確認:

1. Googleでログインし、Applicationタブでhost-only `SESSION` Cookieと `SameSite=Lax` を確認する。
2. `/auth/session` が `authenticated: true`、30日以内の`expiresAt`、90日の`absoluteDeadline`を返すことを確認する。
3. ページ更新、タブを閉じて再訪、PWA再起動でGoogle画面を経由せずアプリが開くことを確認する。
4. Cookieのキー末尾を変更すると未認証になり、別セッションのKVが削除されないことを確認する。
5. ログアウト後は `/auth/session` が `authenticated: false` を返すことを確認する。

自動テストは、改ざんCookie、30日/90日期限、旧セッション移行、Google通信なしのセッション確認、logoutのOrigin/キー検証、Service WorkerのAPI非キャッシュを対象にする。
