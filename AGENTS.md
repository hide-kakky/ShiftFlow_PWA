# AGENTS.md

この repo の Codex ルールです。共通の行動原理は `/Users/hide_kakky/.codex/AGENTS.md` と `/Users/hide_kakky/Dev/codex-obsidian/AGENTS.md` を正本とし、このファイルには ShiftFlow_PWA 固有の制約だけを残します。

## Rizo Context

開発、レビュー、執筆素材化では `/Users/hide_kakky/Hide_vault/リゾ計画/実行正本/Repo_Work_Context.md` を背景として使う。ShiftFlow_PWA の成果や失敗は、必要に応じてリゾ計画の実績素材または検証境界として接続する。

Obsidian知識や他repo成果との接続分類に迷う場合は `/Users/hide_kakky/Hide_vault/リゾ計画/知識接続/Knowledge_Connection_Map.md` を確認する。

Rizoに関係する重要作業では `/Users/hide_kakky/Hide_vault/リゾ計画/実行正本/Operating_Loop.md` を確認し、作業前の知識再利用と作業後レビューを残す。

## 最初に読むもの

1. `CODEx_PROMPT.md`
2. この repo の README / docs
3. 関連する `PLANS.md` または作業メモ

## 固有ルール

- この repo では `CODEx_PROMPT.md` を常に最優先で参照する。
- フロントのファイルを一行でも変更したら、`frontend/public/sw.js` の `APP_VERSION` を必ず上げ、回答に新しい値を明記する。
- コード修正がなくても、依頼があれば `APP_VERSION` を確認し回答に記載する。

## 出力ルール

- 回答は日本語で行う。
- 実行手順、検証手順、ロールバック手順をセットで示す。
- コミットを提案する場合は、日本語のコミットメッセージ案と `git commit` コマンド例を提示する。

## 高リスク領域

- Service Worker とキャッシュ。
- PWA のバージョン管理。
- デプロイ設定。
- 認証、DB、環境変数。

## 検証

- フロント変更時は `APP_VERSION` 更新を確認する。
- PWA キャッシュの影響を確認する。
- `PLANS.md` がある場合は、判断理由と検証結果を追記する。
