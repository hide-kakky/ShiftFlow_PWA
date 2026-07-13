---
plan_id: "2026-07-13-mobile-navigation-density"
title: "スワイプ遷移の改善とモバイル画面密度の最適化"
status: "complete"
owner: "."
profile: "rizo"
opened_at: "2026-07-13"
closed_at: "2026-07-13"
archived_from: "PLANS.md"
source_lines: 128
source_sha256: "201093c9a5fbca45d026aca3b257af494f1c7669cc3e60ea25bc9e9491e73770"
continuation_of: null
supersedes: null
archive_visibility: "local_private"
sanitized: true
immutable: true
read_policy: "explicit_continuation_or_promotion_audit"
---

# Sealed Plan Snapshot

<!-- plan-source-begin -->
---
plan_id: "2026-07-13-mobile-navigation-density"
status: "active"
owner: "."
profile: "rizo"
opened_at: "2026-07-13"
continuation_of: null
archive_visibility: "local_private"
---

# スワイプ遷移の改善とモバイル画面密度の最適化

## 現在のタスク

- スワイプ画面遷移のカクつきをコードと実画面から特定し、タスク／メッセージ画面をスマホで素早く一覧へ到達できる構成へ改善する。

## 目的

- 画面遷移の引っかかりを減らし、本文上部の操作カードが占有する高さを縮める。
- ホーム以外ではヘッダーを画面名・画面アイコン・その画面の主要操作へ切り替え、本文を検索とカード一覧中心にする。

## 成功条件

- スワイプ中に不要な待機、重い再描画、競合するアニメーションを発生させる原因が説明でき、最小差分で修正される。
- ホームではブランドヘッダーを維持し、タスク／メッセージ／設定では各画面のアイコンと名称がヘッダーに表示される。
- タスクの「あなたのタスク／依頼したタスク／全タスク」と再読み込みをヘッダー内で操作でき、本文はキーワード検索とタスクカードが中心になる。
- メッセージのフォルダ、未読のみ、一括既読がスマホでコンパクトに操作でき、不要な説明文と「この範囲を」の文言が除かれる。
- FABの既存の視認性とグラデーションを保ちつつ、近未来的な質感へ改善し、`prefers-reduced-motion` とタップ領域を損なわない。
- `frontend/public/sw.js` と `frontend/public/app-config.js` の版が同じ新しい `APP_VERSION` になり、READMEの記載も同期する。

## 再利用した知識

- `CODEx_PROMPT.md` / `AGENTS.md`: フロント変更時のService Worker版更新、検証・戻し方・日本語コミット案の契約。
- `[[手順_実環境フィードバックをUI改善へ落とす]]`: スマホで1画面1タスクに近づけ、表示ラベルの変更と保存値/API互換を分離する判断。
- `[[手順_Cloudflare_PWA運用]]`: フロント変更とService Worker版を同時に更新し、PWAキャッシュ影響を検証する手順。
- `codegraph-local-code-intelligence`: 22 JavaScriptファイルの索引を確認し、HTML内の動的UIは索引対象外のため `rg`・直接読解・実画面で補完する境界。
- Product Design監査: 現行画面を証拠として確認し、既存のデザイントークンと操作パターンを維持して改善する。

## Scope

- `frontend/public/index.html` のスワイプ遷移、共通ヘッダー、タスク／メッセージ操作部、FABのHTML/CSS/JavaScript。
- `frontend/public/i18n.js` の変更文言と支援技術向けラベル、`frontend/public/sw.js`、`frontend/public/app-config.js`、READMEのバージョン同期。
- 変更に直結するローカル静的チェック、既存テスト、モバイル幅での手動UI確認。

## 非スコープ

- API、D1、認証、権限、保存値、デプロイ、本番データの変更。
- ホーム画面のブランド構成、メッセージ／タスクカード本体の業務仕様変更。
- ユーザーの既存差分 `.DS_Store` と `AGENTS.md` の変更・整理。

## 実行計画

1. CodeGraphで対応ソースの索引状態を確認し、HTML内UIは `rg` と直接読解でスワイプ・画面描画・ヘッダー・フィルターの呼び出し順を特定する。
2. 現行画面をモバイル幅でキャプチャし、遷移挙動と上部UI占有量を確認する。
3. スワイプ遷移を最小差分で軽量化し、画面別ヘッダーとコンパクトなタスク／メッセージ操作UIを実装する。
4. FABを既存デザインに沿って調整し、モーション低減設定とアクセシビリティを確認する。
5. APP_VERSIONを同期更新し、静的チェック・既存テスト・モバイル表示・PWA版整合を検証する。

## 検証方法

- Static: HTML内JavaScriptの構文、重複ID、参照先、`APP_VERSION`同期を機械確認する。
- Unit/regression: repo既存のNodeテストを実行する。
- Manual UI: スマホ幅でホーム／タスク／メッセージ／設定のヘッダー、フィルター、カード到達性、FAB、左右スワイプを確認する。
- Accessibility: 操作名、フォーカス可能性、タップ領域、`prefers-reduced-motion`、選択状態の伝達を確認する。
- 未検証を分離: スマホ実機、本番Cloudflare、実データ、デプロイはこの作業では実施しない。

## 戻し方

- このタスクで変更した `frontend/public/index.html`、`sw.js`、`app-config.js`、README、PLANSの該当差分だけを逆パッチで戻す。
- ユーザーの既存差分へ `git checkout` / `git reset --hard` は使わない。

## 許可境界

- ユーザーが依頼したフロントUIと遷移改善、および必須のバージョン・Plan同期までを実施する。
- deploy、外部送信、Cloudflare設定、DB/API/認証変更、Vaultへの新規保存は実施しない。

## Git / 作業ツリー境界

- 現在は `feature/session-persistence-ui-1.6.0` 上。開始時点で `.DS_Store` と `AGENTS.md` に既存差分があり、このタスクでは触れない。
- コミット、push、branch切替は依頼範囲外として実施しない。

## 実装判断

- APIルートやフィルター値は変更せず、既存状態をヘッダーUIから操作する。
- 画面遷移の性能修正は、原因を直接説明できる部分に限定し、全面的なルーター再設計は行わない。
- 表示密度を上げても、操作対象は原則44px前後を確保し、説明削除後も `aria-label` などで意味を残す。

## Test matrix

- static: HTML内の実行可能なinline script 6本を構文解析、284 IDの重複なし、不要文言・旧hook・`offsetLeft`参照なし、`git diff --check`成功。
- unit/regression: `npm test` 13件すべて成功、`scripts/predeploy-scan.js`成功。
- manual UI: ローカルの390 / 375 / 320px幅で実施。ヘッダー60px・1行、主要操作44px以上、タスク一覧開始位置約142px、メッセージ一覧開始位置約212pxを確認。
- live data / production / user acceptance: 未実施として明記。

## High-risk boundary

- Service Workerは版文字列の同期のみ変更し、キャッシュ更新ロジック自体は変えない。
- 認証、API、DB、環境変数、デプロイには触れない。

## Rizo接続

- 接続分類: `evidence_asset`
- 再利用した知識: 実環境フィードバックをモバイル導線・表示密度・未検証境界へ分ける手順。
- 増える資産: ShiftFlowを現場課題からUI改善・検証まで落とした実績素材。
- 接続しないもの: UI差分をそのまま公開記事やVault新規ノートにはしない。
- 反省と改善: 完了後に原因、効いた差分、実機未検証を分離して残す。

## 完了後レビュー

- 状態: `complete`
- 原因として確認した事実:
  - 非選択パネルを `visibility: hidden; height: 0` にしたままtrackだけを指へ追従させていたため、ドラッグ中に隣画面が描画されなかった。
  - `touchend` でパネル切替、`offsetLeft`の同期計測、スクロール、一覧再描画、横移動とopacityが重なっていた。
  - 端の循環遷移では3画面分を短時間で移動していた。
- 実装結果:
  - 現在画面と隣接画面だけをスワイプ中に表示し、遷移完了後に非対象画面を隠す。位置計算をwrapper幅に統一し、描画を遷移後へ送った。
  - transform更新を`requestAnimationFrame`へ集約し、touch listenerをview wrapperへ限定、端の循環を停止した。
  - ホーム以外を画面別ヘッダーへ切り替え、タスク範囲と再読み込みをヘッダーに移動した。メッセージ操作部を2段・約109pxへ圧縮し、不要説明文を削除した。
  - FABを既存の青・ピンク系グラデーションから外さず、halo、奥行き、明確なfocus ringを追加した。
  - 日英の画面名、タスク範囲、再読み込み、メッセージ支援ラベルを追従させた。
- 検証結果:
  - CodeGraph 0.9.9の索引は最新（22 JavaScriptファイル、514 nodes、1890 edges）。主要UIはHTML内inline JavaScriptのため、最終確認は`rg`、直接読解、テスト、実画面で補完した。
  - ローカルの320〜390px幅でヘッダー、dropdown、メッセージ操作、panel位置、高さ凍結、`inert` / `aria-hidden`の整合を確認した。
  - `APP_VERSION`は`1.7.0`へ同期した。
- 未検証境界: iPhone/Android実機のPerformance trace、Cloudflare本番、実データ、deploy、ユーザー受入は未実施。
- ロールバック: このPlanに列挙したファイルだけを逆パッチまたは当該コミットのrevertで戻し、ユーザー既存差分`.DS_Store` / `AGENTS.md`は除外する。
- Knowledge Update判断: 既存のUIフィードバック手順とPWA運用手順で再利用可能だったためVaultは更新しない。今回の原因・検証境界はsealed Planへ固定する。
- Rizo再接続: `evidence_asset`として、現場のスマホ導線問題を原因分解、最小実装、モバイル検証まで閉じた実績素材が増えた。公開素材化は別判断とする。

<!-- plan-source-end -->
