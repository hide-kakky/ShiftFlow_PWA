-- メッセージのピン留めを組織共有からユーザー個人の状態へ分離する。
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS message_pins (
  message_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  pinned_at_ms INTEGER NOT NULL,
  PRIMARY KEY (message_id, membership_id),
  FOREIGN KEY (message_id) REFERENCES messages(message_id) ON DELETE CASCADE,
  FOREIGN KEY (membership_id) REFERENCES memberships(membership_id) ON DELETE CASCADE,
  FOREIGN KEY (org_id) REFERENCES organizations(org_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_message_pins_membership_pinned
  ON message_pins(membership_id, pinned_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_message_pins_org_message
  ON message_pins(org_id, message_id);

CREATE INDEX IF NOT EXISTS idx_message_comments_org_message_created
  ON message_comments(org_id, message_id, created_at_ms DESC);

-- messages.is_pinned はロールバック用に残す。
-- 旧共有ピンを個人の意図へ安全に変換できないため、自動backfillは行わない。
