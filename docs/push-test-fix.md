# テスト通知の送信失敗と待ち時間表示の修正

対象版: APP_VERSION=2.2.1。公開元は作業branch `codex/fix-push-delivery`。

## 原因と修正

本番でテスト通知の登録は成功していたが、送信結果は`transport_unavailable`で再試行され、成功記録がなかった。Worker cronは正常終了していた。送信内のcatchが例外を吸収するため、cronの正常終了だけでは送信成功を示さない。

`fetch`へ渡した`redirect: 'error'`はCloudflare Workersでは未対応で、HTTP送信前のRequest構築時にTypeErrorになる。本番と同じcompatibility dateのworkerdで再現した。`manual`へ変更し、3xxを追従せず失敗扱いにする既存の宛先制約を維持した。[Cloudflare Request仕様](https://developers.cloudflare.com/workers/runtime-apis/request/)

Nodeのfetch stubだけではこの差を検出できなかったため、既存ロック版のMiniflareを直接devDependencyへ追加した。新テストはworkerdの暗号化・VAPID・native Request構築・stub transportの201/307応答を通す。外部providerへは送信しない。旧指定を戻した制御用baselineはTypeErrorで失敗し、修正版は成功した。

## 表示と回数制限

- 「この端末の通知：有効」とテスト通知の案内を別の領域へ表示する。
- 待ち時間中はテスト通知ボタンだけを無効にし、残り秒数を表示。サーバーの残り秒数を取得するため、再読込しても受付直後の連打を避けられる。
- 回数制限の429には`retryAfterSeconds`と`Retry-After`を返す。元の原子的な60秒制限、組織・本人・sessionの検証は維持する。
- callerが扱う回数制限では汎用エラーIDのtoastを重ねない。401・403・5xxは抑止せず、ErrorのrequestIdも保持する。
- 残り秒数はボタンだけを更新し、毎秒の読み上げ通知を避ける。案内領域は成功待ちと回数制限が起きた時に更新する。

## 検証と確認の境界

- 本番outboxは個人情報・endpoint・鍵を取得せず、状態/試行回数/結果codeの集計で調査。
- 合成鍵によるworkerd実行と、UI VMの連打・再読込・account変更・認証エラーのテストを追加。
- 393px幅のブラウザfixtureで、端末の有効表示を残し、テスト操作後に「再送まで59秒」の無効ボタンと送信待ち案内を確認した。実iPhoneのOS許可や受信を模擬した結果ではない。
- 最大試行回数に達した既存の失敗イベントは自動で再送しない。DBの試行回数を戻さず、必要なら本人が新しいテスト通知を操作する。

## 配布と切戻し

```sh
npm run check
npx wrangler deploy --env production --config workers/push-dispatch/wrangler.toml
npx wrangler pages deploy frontend/public --project-name shiftflow --branch main --commit-dirty=false
```

同じ送信関数を使うPagesと通知Workerの両方へ配布する。鍵、通知flag、DB、購読の登録は変更しない。新しいテスト通知や手動再送をこちらから追加せず、修正版の通常処理だけを再開する。

切戻しは修正前の互換Pages/Worker版へ戻せるが、旧送信不具合も再発する。通知を止める必要がある場合は両サービスのflagをfalseにし、鍵・購読・業務データを保持する。現在の本番設定と端末確認手順は[web-push.md](web-push.md)。

## 本番反映結果

- Pages production `8a142459-8657-4f55-9b24-e09adc31d35e`、配布元commit `725a997`、APP_VERSION=2.2.1。
- Worker version `e82ffe7d-32cc-4060-bdc3-91ad4470b837`。production DB、既存VAPIDの3secret、通知flag trueと毎分cronを維持。
- 本番URLとdeployment URLのindex/app-config/sw/push-settingsの4ファイルが保存版とSHA-256一致。匿名auth/session 200、通知設定API 401を確認。
- 196テスト、秘匿ファイルscan、Functions build成功。独立レビューで追加の不具合指摘なし。
- 観測時点では古いテスト3件は最大4試行に達しており、新しいテストイベントはまだなかった。本人の受信回答は直後に未着へ訂正された。端末未着を継続調査する。

旧版の画面が残る場合は、ヘッダーのメニューから「最新版を取得（再ログイン）」で更新する。再ログイン後に端末登録が必要な表示になった場合は「この端末で通知を有効にする」を押し、テスト通知を1回操作する。成功したら再送まで残り秒数を表示し、同時に端末の有効状態を保持する。

## 端末未着の追加調査

本人の受信回答は直後に未着へ訂正されたため、受信完了とは扱わない。OS側の「通知を許可」は本人がオンと確認した。

本番primaryの変更なし照会では、修正後のテスト1件は2026-11-13 07:34:37 JSTにAppleへ1回でHTTP201受理。テスト時に指定した購読と送信先も一致した。これはApple受付の証拠であり、端末表示の証拠ではない。暗号出力も合成鍵32件を別系統のOpenSSLで復号し、VAPID署名を検証した。今回の確認で明確な送信側の不備は見つかっていない。

2.2.2の「通知が届かないとき」へ「端末内で表示を確認」を追加。本人のクリックで、許可済みのactive Service WorkerにshowNotificationを1回呼び出す。外部API・購読変更・権限要求は行わず、外部テストの待ち時間も維持する。サーバーが利用不可でも端末内の確認は使える。呼出成功は通知センターでの本人確認と分けて表示する。

診断はPages production `545d023d-ba7e-4b81-a0c5-810ab78bdb67`（source`d34cffb`）へ反映した。その後、本人が「端末内で表示を確認」での通知表示と、「テスト通知」ボタンでの外部通知受信の両方を確認した。テスト通知の端末到達は確認済みとして調査を終了する。追加の送信や設定変更は行っていない。

過去にApple HTTP201でも表示されなかった理由は未特定。今回届いたことから過去の原因を推測して補完しない。フォルダ別の各自動イベントを実機で全種類試した結果とは区別する。
