-- v2: 認証イベント・API診断を旧login_attempt誤分類から分離する。
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS auth_events (
  event_id TEXT PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  outcome TEXT NOT NULL,
  reason_code TEXT,
  org_id TEXT,
  user_id TEXT,
  user_email TEXT,
  user_sub TEXT,
  status TEXT,
  role TEXT,
  request_id TEXT,
  route TEXT,
  source TEXT NOT NULL DEFAULT 'cloudflare',
  session_fingerprint TEXT,
  occurred_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_events_org_occurred
  ON auth_events(org_id, occurred_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_auth_events_user_occurred
  ON auth_events(user_id, occurred_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_auth_events_request
  ON auth_events(request_id);

-- callback stateはraw値を保存せずfingerprintだけを一度claimする。
-- INSERT OR IGNOREの一意制約で、複数isolateへの同時callbackを直列化する。
CREATE TABLE IF NOT EXISTS oauth_callback_claims (
  state_fingerprint TEXT PRIMARY KEY,
  claimed_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_callback_claims_expiry
  ON oauth_callback_claims(expires_at_ms ASC);

-- 既存列と行は保持し、新しい診断だけ発生時点のtenant snapshotを持たせる。
ALTER TABLE auth_proxy_logs ADD COLUMN org_id TEXT;
ALTER TABLE auth_proxy_logs ADD COLUMN user_id TEXT;

CREATE INDEX IF NOT EXISTS idx_auth_proxy_logs_org_created
  ON auth_proxy_logs(org_id, created_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_auth_proxy_logs_user_created
  ON auth_proxy_logs(user_id, created_at_ms DESC);

-- manual cleanup前のpaired/unpaired preflightを相関全走査にしない。
-- 非破壊indexとして通常expand migrationで先に適用する。
CREATE INDEX IF NOT EXISTS idx_login_audits_request
  ON login_audits(request_id);

-- 同一 request id の再送で同じ業務監査を増殖させない。
ALTER TABLE audit_logs ADD COLUMN request_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_logs_request_action_target
  ON audit_logs(org_id, request_id, action, COALESCE(target_id, ''))
  WHERE request_id IS NOT NULL AND request_id <> '';

-- D1 の参照行を削除した後に R2 cleanup が失敗しても、object key を失わない。
CREATE TABLE IF NOT EXISTS storage_cleanup_jobs (
  job_id TEXT PRIMARY KEY,
  r2_key TEXT NOT NULL UNIQUE,
  org_id TEXT,
  target_type TEXT,
  target_id TEXT,
  reason TEXT NOT NULL,
  request_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  lease_token TEXT,
  lease_expires_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_storage_cleanup_jobs_created
  ON storage_cleanup_jobs(created_at_ms ASC);

CREATE INDEX IF NOT EXISTS idx_storage_cleanup_jobs_lease
  ON storage_cleanup_jobs(org_id, lease_expires_at_ms, updated_at_ms);

-- cleanup lease中の物理objectをattachmentへ再採用するraceをDB境界で拒否する。
CREATE TRIGGER IF NOT EXISTS prevent_attachment_insert_during_cleanup_lease
BEFORE INSERT ON attachments
WHEN JSON_VALID(COALESCE(NEW.extra_json, '')) = 1
 AND EXISTS (
   SELECT 1
     FROM storage_cleanup_jobs cleanup_guard
    WHERE cleanup_guard.r2_key = JSON_EXTRACT(NEW.extra_json, '$.r2Key')
      AND cleanup_guard.org_id = NEW.org_id
      AND cleanup_guard.lease_token IS NOT NULL
 )
BEGIN
  SELECT RAISE(ABORT, 'storage_cleanup_lease_active');
END;

CREATE TRIGGER IF NOT EXISTS prevent_attachment_update_during_cleanup_lease
BEFORE UPDATE OF org_id, extra_json ON attachments
WHEN JSON_VALID(COALESCE(NEW.extra_json, '')) = 1
 AND EXISTS (
   SELECT 1
     FROM storage_cleanup_jobs cleanup_guard
    WHERE cleanup_guard.r2_key = JSON_EXTRACT(NEW.extra_json, '$.r2Key')
      AND cleanup_guard.org_id = NEW.org_id
      AND cleanup_guard.lease_token IS NOT NULL
 )
BEGIN
  SELECT RAISE(ABORT, 'storage_cleanup_lease_active');
END;
