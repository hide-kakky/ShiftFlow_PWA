-- 通知設定と日次リマインダーのexpand変更。既存queue/設定列は保持する。
ALTER TABLE push_preferences ADD COLUMN task_overdue_reminder INTEGER NOT NULL DEFAULT 0 CHECK(task_overdue_reminder IN (0,1));
ALTER TABLE push_preferences ADD COLUMN task_reminder_enabled_at_ms INTEGER;
ALTER TABLE push_events ADD COLUMN reminder_day TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_push_reminder_once
  ON push_events(org_id,actor_user_id,reminder_day) WHERE reminder_day IS NOT NULL;
