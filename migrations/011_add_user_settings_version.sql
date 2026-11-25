-- v2: プロフィール設定を1つのaggregateとして楽観ロックする。
PRAGMA foreign_keys = ON;

ALTER TABLE users
  ADD COLUMN settings_version TEXT NOT NULL DEFAULT '0';
