-- v2: mutation idempotencyをtenant + actor + routeへ分離する。
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS api_idempotency_keys (
  idempotency_key_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  route TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  UNIQUE (org_id, actor_user_id, request_id, route),
  CHECK (
    LENGTH(payload_sha256) = 64
    AND payload_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  FOREIGN KEY (org_id) REFERENCES organizations(org_id),
  FOREIGN KEY (actor_user_id) REFERENCES users(user_id)
);

CREATE INDEX IF NOT EXISTS idx_api_idempotency_keys_created
  ON api_idempotency_keys(created_at_ms ASC);

CREATE INDEX IF NOT EXISTS idx_api_idempotency_keys_actor_expiry
  ON api_idempotency_keys(org_id, actor_user_id, expires_at_ms ASC);

CREATE INDEX IF NOT EXISTS idx_api_idempotency_keys_expiry
  ON api_idempotency_keys(expires_at_ms ASC);

-- 異なるactorが同じclient request IDで同じ対象を操作しても、各監査を保持する。
DROP INDEX IF EXISTS idx_audit_logs_request_action_target;

CREATE UNIQUE INDEX idx_audit_logs_request_action_target
  ON audit_logs(
    org_id,
    COALESCE(actor_membership_id, ''),
    request_id,
    action,
    COALESCE(target_id, '')
  )
  WHERE request_id IS NOT NULL AND request_id <> '';
