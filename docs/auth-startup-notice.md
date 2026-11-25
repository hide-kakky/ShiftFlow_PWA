# 起動時に残るログイン案内の修正

APP_VERSION=2.2.6。基点baad353（2.2.5）、branchはcodex/fix-push-delivery。

## 問題と原因

ログイン済みのHomeに「Google でログインしてから再試行してください。」という赤い案内が残る報告を調査した。原因候補は起動時の言語初期化、復帰時の認証競合、真正のsession失効。文言を発生させる処理を追うと、I18nがDOMContentLoadedでlanguagechangeを発火し、window.loadのinitializeAuthGatewayより前にloadHomeへ入る経路があった。HAS_ACTIVE_EMAILは本人のbootstrapが揃ってから設定されるので、この時点ではfalse。未ログイン用カードと赤toastを作り、後で認証とHome読込が成功してもtoastが残る。

固定した基点の実i18n.js、実languagechange handler、実Home loaderをVMで動かし、認証確認前に同じ案内が1件発生することを再現した。独立agentも同じ順序で再現した。実iPhoneの当該操作履歴を採取した結果ではないため、報告された全ケースがこの原因だったとは断定しない。Cookie失効の証拠としても扱わない。

## 修正

languagechangeでは翻訳・見出し・ツールバーの更新を先に行う。その後、本人bootstrap未準備またはprivate stateを閉じている間は、業務sourceの無効化とHome/メッセージ読込へ進まない。通常のbootstrap完了後の表示と、ログイン後の言語切替による再描画は維持する。

```diff
 syncMessageToolbarLabels();
+// 言語の初期化は認証確認より先に発火する。本人の初期データが揃ってから一覧を更新する。
+if (!HAS_ACTIVE_EMAIL || PRIVATE_STORAGE_BLOCKED) return;
 MESSAGE_SOURCE.renderedRows = null;
```

認証判定、Cookie、セッション期限、失効、復帰時の本人確認、サーバーの401/403/503、APIエラー処理は変更していない。エラー通知全体を消す修正ではない。通知Worker、DB、鍵、権限、依存も変更していない。

## 確認

- 新規tests/auth-startup-language.test.mjsは基点で4件失敗/1件成功、修正後5件成功。実I18n初期化前後、認証済みでも本人bootstrap前、本人bootstrap後の言語変更、メッセージ再描画、private purge中を含む。
- npm run checkは258件成功、predeploy scan成功、Functions build成功。inline JSの6scriptも構文確認。既存のsession・401・本人変更・失効テストを維持。
- CodeGraph 0.9.9は55 JavaScript filesからsession箇所を同定した。inline HTMLのイベント順序は索引対象外なのでrg、直接読解、VMを使用。.codegraphはignore済み。
- 実iPhoneでの再現・実ユーザーでの本番ログイン操作は未確認。次回のアプリ更新後、ログイン済みHomeで同じ赤い案内が出ないことが本人利用での確認点。

## 実行・切戻し

```sh
npm run check
npx wrangler pages deploy frontend/public --project-name shiftflow --branch auth-startup-preview --commit-dirty=false
npx wrangler pages deploy frontend/public --project-name shiftflow --branch main --commit-dirty=false
```

切戻しは直前2.2.5のPages `b3f9f385-dbe9-45fa-9376-b914897af0a7`、またはbaad353の対象UIを次のAPP_VERSIONで再配布。PWAへ反映済みの場合は新しい版での再配布を優先する。DBと通知Workerは維持し、GitHubへのpush/mergeはしない。

保存時のコマンド:

```sh
git commit -m '認証確認前の言語初期化で出るログイン案内を修正'
```

## 公開結果

2026-11-13公開。Productionは`6685c6c9-071e-47f8-99c7-0b0c59d1dc2a`、source commitは`9642d40`、previewは`fc056bc1`。preview、本番URL、固定Deployment URLのindex/app-config/sw/compact-ui/i18nが保存版とSHA-256一致。indexはPagesが正規化するルート本文で照合した。

匿名auth/sessionは200・authenticated=false、メッセージと通知設定APIは401。公開直前の本番が2.2.5/source f226697のままかも確認した。実ユーザーのCookie確認・本番データ操作・通知送信は行っていない。

## 再利用と改善

既存のsession永続化と認証境界テストを再利用し、サーバーの認証契約を変えずに起動順だけを直した。起動時の自動イベントは明示操作と分けて検証する。Rizo接続は失敗予防・method asset候補、正本はこのrepoの記録とし、VaultとLedgerには変更を加えない。
