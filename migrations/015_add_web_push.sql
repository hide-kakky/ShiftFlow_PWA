-- Web Push: 既存業務テーブルは変更しないexpand migration。
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS push_preferences (
  org_id TEXT NOT NULL REFERENCES organizations(org_id),
  user_id TEXT NOT NULL REFERENCES users(user_id),
  task_assigned INTEGER NOT NULL DEFAULT 1 CHECK(task_assigned IN (0,1)),
  task_updated INTEGER NOT NULL DEFAULT 1 CHECK(task_updated IN (0,1)),
  version TEXT NOT NULL DEFAULT '0',
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY(org_id,user_id)
);
CREATE TABLE IF NOT EXISTS push_folder_preferences (
  org_id TEXT NOT NULL REFERENCES organizations(org_id),
  user_id TEXT NOT NULL REFERENCES users(user_id),
  folder_id TEXT NOT NULL REFERENCES folders(id),
  message_created INTEGER NOT NULL DEFAULT 1 CHECK(message_created IN (0,1)),
  comment_created INTEGER NOT NULL DEFAULT 1 CHECK(comment_created IN (0,1)),
  task_assigned INTEGER NOT NULL DEFAULT 1 CHECK(task_assigned IN (0,1)),
  task_updated INTEGER NOT NULL DEFAULT 1 CHECK(task_updated IN (0,1)),
  PRIMARY KEY(org_id,user_id,folder_id)
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  subscription_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(org_id),
  user_id TEXT NOT NULL REFERENCES users(user_id),
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  session_fingerprint TEXT NOT NULL,
  session_expires_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_subscription_owner ON push_subscriptions(org_id,user_id);
CREATE TRIGGER IF NOT EXISTS enforce_push_device_quota
BEFORE INSERT ON push_subscriptions
WHEN NOT EXISTS(SELECT 1 FROM push_subscriptions WHERE subscription_id=NEW.subscription_id)
  AND (SELECT COUNT(*) FROM push_subscriptions WHERE org_id=NEW.org_id AND user_id=NEW.user_id)>=10
BEGIN
  SELECT RAISE(ABORT,'push_device_quota');
END;
CREATE TABLE IF NOT EXISTS push_events (
  event_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(org_id),
  actor_user_id TEXT NOT NULL REFERENCES users(user_id),
  kind TEXT NOT NULL CHECK(kind IN ('task_assigned','task_updated','message_created','comment_created','test')),
  resource_id TEXT NOT NULL,
  folder_id TEXT,
  target_subscription_id TEXT,
  recipient_user_ids TEXT,
  excluded_user_ids TEXT NOT NULL DEFAULT '[]',
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  expansion_cursor TEXT NOT NULL DEFAULT '',
  expanded INTEGER NOT NULL DEFAULT 0 CHECK(expanded IN (0,1))
);
CREATE INDEX IF NOT EXISTS idx_push_event_pending ON push_events(expanded,expires_at_ms,created_at_ms);
CREATE INDEX IF NOT EXISTS idx_push_event_test_limit ON push_events(org_id,actor_user_id,kind,created_at_ms);
CREATE TABLE IF NOT EXISTS push_deliveries (
  event_id TEXT NOT NULL REFERENCES push_events(event_id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','skipped','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at_ms INTEGER NOT NULL,
  lease_token TEXT,
  lease_until_ms INTEGER,
  result_code TEXT,
  PRIMARY KEY(event_id,subscription_id)
);
CREATE INDEX IF NOT EXISTS idx_push_delivery_pending ON push_deliveries(status,next_attempt_at_ms,lease_until_ms);
