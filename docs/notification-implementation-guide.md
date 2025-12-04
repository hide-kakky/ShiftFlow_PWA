# 通知機能実装ガイド

ShiftFlow をホーム画面/PWA から利用している従業員が、アプリを起動していない状態でも最新状況を把握できるようにするための通知機能の設計資料。現状のフロントエンド構成（`frontend/public/index.html`＋`sw.js`）を前提に、必要なバックエンド要件やデータモデルも含めて整理する。

## 1. 目的とスコープ
- 目的: PWA がバックグラウンドでも Push 通知を受信し、タップで ShiftFlow を起動できる状態を作る。
- 対象プラットフォーム: iOS/iPadOS Safari（17.4+）/Android Chrome/デスクトップ Chrome/Edge。
- スコープ: 許可取得 UI、Push 購読管理、Service Worker の `push`/`notificationclick` 処理、API 連携、DB 永続化。
- 非スコープ: 通知本文の多言語化ロジック、サーバー側ジョブスケジューラの詳細実装。

## 2. 全体アーキテクチャ
1. ユーザーが ShiftFlow (PWA) を起動 → `NotificationController` が `Notification.permission` を確認し、未許可なら UI で案内。
2. 権限が許可されたら `navigator.serviceWorker.ready` / `PushManager.subscribe()` で購読を取得。
3. 端末固有の購読情報（エンドポイント URL、鍵）を `POST /api/push-subscriptions` へ送信 → DB に保存。
4. バックエンドは業務イベント（例: 緊急タスク、承認待ち）を検知すると Web Push API を使って対象ユーザーの購読へ配信。
5. Service Worker (`sw.js`) が `push` を受信 → `showNotification()` でユーザーに提示 → クリック時に `clients.openWindow('/')` でアプリ再開。
   - 通知権限の案内・テスト導線は **ユーザー設定画面（`#view-settings`）の専用カード** に集約し、ホーム画面には通知カードを置かない。

### 2.1 通知トリガー（必須要件）
| トリガー | 対象ユーザー | 備考 |
| --- | --- | --- |
| 新規メッセージ作成 | メッセージが投稿されたフォルダに含まれる全ユーザー | GAS/Cloudflare 側でフォルダメンバーを解決し、既読メンバー管理と連動。 |
| 自分宛てのタスクが作成された時 | タスクの担当者（複数可） | メンションや代理入力でも担当者に含まれれば通知。 |
| タスク期限の前日 | 各タスク担当者 | 期限の 24 時間前にバッチ/スケジューラで一括送信。完了済みタスクは除外。 |

実装上は以下のジョブ/イベントが必要:
- **リアルタイム通知**: メッセージ or タスク作成 API 完了時に該当ユーザーの購読一覧を取得し即座に push。
- **期限前バッチ**: 毎日 9:00（または任意）に D1/Cloudflare Worker Cron などで「明日が期限」「未完了」のタスクを抽出して送信。重複送信防止のため送信ログテーブルを保持。
- **送信ログ**: `notification_dispatch_logs` (message_id/task_id/due_date + target_user + sent_at) を設け、再送/再計算時のガードとする。

## 3. データモデル/DB 変更
| テーブル | カラム例 | 用途 |
| --- | --- | --- |
| `user_settings` (JSONB も可) | `language`, `notification_opt_in`, `last_notification_channel` | 言語や通知希望をサーバー側で保持して端末間の差異を吸収。 |
| `user_push_subscriptions` | `id`, `user_id`, `endpoint`, `p256dh`, `auth`, `ua_hash`, `platform`, `created_at`, `revoked_at` | Push 購読を複数端末分保持。`revoked_at` で無効化管理。 |

- `notification_opt_in` は「ユーザーが通知を望むか」のビジネス設定。Push 権限自体は端末側なので、両方の状態を組み合わせて配信判定する。
- 端末の指紋値（`ua_hash`）で重複購読を整理し、ログアウトや退職時に `DELETE`/`revoke` ができるようにする。

## 4. API 設計
| メソッド/パス | 説明 | 認可 |
| --- | --- | --- |
| `POST /api/push-subscriptions` | `PushSubscription.toJSON()` の結果を受け取り、`user_id` と紐付けて保存。既存 `endpoint` があれば更新。 | 要ログイン |
| `DELETE /api/push-subscriptions/:id` | ユーザー自身または管理者が購読を解除。 | 要ログイン |
| `POST /api/notifications/test` | マネージャー向け検証用。指定端末 or すべてにテスト通知。 | 管理者限定 |
| `POST /api/notifications/dispatch` | 実運用の通知配送エンドポイント（タスク作成/承認時に呼び出し）。 | 内部呼び出し |

レスポンスは JSON で統一し、購読登録後には WebHook 的にログへ記録を残す。

## 5. フロントエンド実装要件
### 5.1 設定値 (`app-config.js`)
- `APP_VERSION` を更新するたびに `sw.js` も同一値へ揃える。
- Push 公開鍵や購読 API を環境変数から注入するため、以下プロパティを追加する。
  - `PUSH_PUBLIC_KEY`
  - `PUSH_SUBSCRIBE_ENDPOINT`

### 5.2 `NotificationController`（`index.html` 内スクリプト）
- 構成:
  - `init()` … UI のセットアップ、localStorage から通知ログ読込、権限確認。
  - `handlePermissionRequest()` … `Notification.requestPermission()` → 許可時に `ensureSubscription()` を呼ぶ。
  - `ensureSubscription()` … `registration.pushManager.subscribe()` → API へ購読POST。VAPID鍵は base64url→Uint8Array 変換して渡す。
  - `appendLog()` … Service Worker から `postMessage` された push ログを localStorage へ保存。
  - `sendTestNotification()` … `registration.showNotification()` を利用したクライアント内テスト。
- UI:
  - ユーザー設定画面の通知カード（`#view-settings` 内 `settings-block`）で許可状態・最終更新時刻・テストボタン・説明文をまとめ、ホーム画面には通知カードを配置しない。
  - `notification-area`（既存トースト）と連携し、設定画面からの権限操作やテスト通知でも同じエラー/成功メッセージを表示する。

### 5.3 グローバル通信
- `window.addEventListener('load', …)` 内で Service Worker の `message` イベントに `PUSH_EVENT_LOG`/`NAVIGATE` を追加し、`NotificationController` へ橋渡し。
- `window.__SHIFT_FLOW_PENDING_PUSH_LOG__` を使って、コントローラ初期化前のログをバッファリング。

### 5.4 ユーザー設定画面での通知カード
- `#view-settings` 内に `settings-block` を追加し、以下の UI をまとめる。
  - **カード全体**: `settings-notify-card`（破線枠＋淡い背景）で視認性を高める。
  - **状態表示**: `settings-notify-status` に現在の許可状態・最終更新時刻を表示。`NotificationController` から再利用できる getter を用意し共有する。
  - **操作ボタン**: `#btn-setting-notify-request`（許可リクエスト）、`#btn-setting-notify-test`（テスト通知）、`#btn-setting-notify-open`（端末設定を開く/手順案内）を配置し、NotificationController のイベントハンドラを共有する。
  - **アラート領域**: `settings-notify-alert` に拒否時のリカバリ手順や情報メッセージを表示。`Notification.permission` の値に応じて `alert-info`/`alert-danger` を切り替える。
  - **Tips リスト**: 通知が届く具体的なタイミング（新規メッセージ/担当タスク/期限前日）を箇条書きで説明し、ユーザーにメリットを伝える。
  - **コントローラ連携**: `NotificationController` に `bindToSettingsView()` を追加し、DOM 初期化・状態同期・イベント登録を一括管理する。
  - **アクセシビリティ**: 状態表示は `aria-live="polite"` を付与し、権限変更時にスクリーンリーダーへ通知する。

## 6. Service Worker (`frontend/public/sw.js`)
- `const APP_VERSION = 'x.y.z';` を更新すると APP Shell キャッシュキーも変わり、端末へ更新通知が届く。
- 新たに追加するイベント:
  - `self.addEventListener('push', handler)` … `event.data.json()` を安全にパースし、`showNotification()` で表示。`event.waitUntil()` で `broadcastPushLog()` を伝播。
  - `self.addEventListener('notificationclick', handler)` … 通知クリック時に対象 URL へフォーカス。既存クライアントが無ければ `clients.openWindow('/')`。
- ヘルパー:
  - `parsePushPayload(event)` … title/body/icon/tag/data/url を整理し、デフォルト値を持たせる。
  - `broadcastPushLog(detail)` … 受信ログをフロントへ `postMessage({ type: 'PUSH_EVENT_LOG', payload })`。
- 失敗時は `event.waitUntil(Promise.all([...]))` で例外を握りつぶし、最低限通知表示を保証する。

## 7. テストと検証
1. ローカル開発: `npm run dev` → HTTPS トンネル (Cloudflare Tunnel など) 経由で実機アクセス。
2. ブラウザ DevTools → Application → Push → `{"title":"Dev test","body":"hello"}` を送信し、通知表示を確認。
3. Cloudflare Functions/GAS から VAPID 鍵で push 送信テスト。購読解除後の挙動も確認。
4. iOS Safari (17.4+) でホーム追加 → 権限許可 → アプリを完全終了 → サーバーから通知を送信し、ロック画面に表示されるか確認。
5. ログ/監査: `user_push_subscriptions` に重複が無いか、無効化済みの購読へ送信すると 410 エラーが返るかを記録し再購読する。

## 8. セキュリティと運用
- VAPID 秘密鍵は Cloudflare Pages/Workers のシークレットで管理。ローカルには置かない。
- `PUSH_SUBSCRIBE_ENDPOINT` は CSRF 対策のため `SameSite=Lax` Cookie ＋ `token` ヘッダーを併用。
- 退職者や端末紛失時は購読一覧から該当エントリを `DELETE`。管理 UI に「通知端末」リストを追加すると便利。
- Service Worker 更新（`APP_VERSION`）は毎回 `sw.js` を bump する運用を継続する。

## 9. 今後の拡張案
- 通知カテゴリ別のサイレント/重要設定（DB の JSONB で柔軟化）。
- i18n 対応: ユーザーの `language` 設定を使い、サーバー側で文言変換。
- 分析用イベント: 通知開封率を計測し、Cloudflare Workers Analytics Engine へ送信。

---
この資料をベースに、`docs` 配下へ追加でシーケンス図や API スキーマを拡充していく想定。コード変更時は必ず `APP_VERSION` を更新し、Service Worker の再配信を確実に行うこと。
