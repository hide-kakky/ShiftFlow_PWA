-- v2: request IDのTTL再利用を、同一世代の再送と新しい操作に分離する。
PRAGMA foreign_keys = ON;

ALTER TABLE audit_logs
  ADD COLUMN request_payload_sha256 TEXT;

ALTER TABLE audit_logs
  ADD COLUMN request_generation_ms INTEGER;

DROP INDEX IF EXISTS idx_audit_logs_request_action_target;

CREATE UNIQUE INDEX idx_audit_logs_request_action_target
  ON audit_logs(
    org_id,
    COALESCE(actor_membership_id, ''),
    request_id,
    action,
    COALESCE(target_id, ''),
    COALESCE(request_payload_sha256, ''),
    COALESCE(request_generation_ms, 0)
  )
  WHERE request_id IS NOT NULL AND request_id <> '';
