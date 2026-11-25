-- v2: 大容量Data URIを廃止し、R2へ1件ずつ一時保存してから業務更新へclaimする。
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS staged_attachments (
  staged_attachment_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  owner_membership_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('message', 'profile')),
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (
    size_bytes > 0
    AND (
      (purpose = 'profile' AND size_bytes <= 8388608)
      OR (purpose = 'message' AND size_bytes <= 10485760)
    )
  ),
  checksum TEXT NOT NULL CHECK (
    LENGTH(checksum) = 64
    AND checksum NOT GLOB '*[^0-9a-f]*'
  ),
  r2_key TEXT NOT NULL UNIQUE,
  request_id TEXT NOT NULL,
  request_payload_sha256 TEXT NOT NULL CHECK (
    LENGTH(request_payload_sha256) = 64
    AND request_payload_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  request_generation_ms INTEGER NOT NULL CHECK (request_generation_ms > 0),
  status TEXT NOT NULL DEFAULT 'uploading'
    CHECK (status IN ('uploading', 'ready', 'claimed', 'superseded', 'failed')),
  claimed_target_type TEXT,
  claimed_target_id TEXT,
  claimed_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  CHECK (expires_at_ms > created_at_ms),
  CHECK (
    (status <> 'claimed'
      AND claimed_target_type IS NULL
      AND claimed_target_id IS NULL
      AND claimed_at_ms IS NULL)
    OR
    (status = 'claimed'
      AND (
        (purpose = 'message' AND claimed_target_type = 'message')
        OR (purpose = 'profile' AND claimed_target_type = 'user_settings')
      )
      AND claimed_target_id IS NOT NULL
      AND claimed_at_ms IS NOT NULL)
  ),
  FOREIGN KEY (org_id) REFERENCES organizations(org_id),
  FOREIGN KEY (owner_user_id) REFERENCES users(user_id),
  FOREIGN KEY (owner_membership_id) REFERENCES memberships(membership_id)
);

CREATE INDEX IF NOT EXISTS idx_staged_attachments_owner_pending
  ON staged_attachments(org_id, owner_user_id, purpose, status, expires_at_ms);

CREATE INDEX IF NOT EXISTS idx_staged_attachments_expiry
  ON staged_attachments(status, expires_at_ms ASC);

CREATE INDEX IF NOT EXISTS idx_staged_attachments_request_generation
  ON staged_attachments(org_id, owner_user_id, request_id, request_generation_ms);

CREATE TRIGGER IF NOT EXISTS enforce_staged_attachment_owner_scope
BEFORE INSERT ON staged_attachments
WHEN NOT EXISTS (
  SELECT 1
    FROM memberships owner_scope
   WHERE owner_scope.membership_id = NEW.owner_membership_id
     AND owner_scope.org_id = NEW.org_id
     AND owner_scope.user_id = NEW.owner_user_id
     AND owner_scope.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'staged_attachment_owner_scope_mismatch');
END;

-- R2 put前の台帳作成だけをINSERT入口とする。ready/claimed等の直挿しで
-- upload・cleanup outbox・one-time claimを迂回することをDB境界で拒否する。
CREATE TRIGGER IF NOT EXISTS enforce_staged_attachment_initial_state
BEFORE INSERT ON staged_attachments
WHEN NEW.status <> 'uploading'
  OR NEW.claimed_target_type IS NOT NULL
  OR NEW.claimed_target_id IS NOT NULL
  OR NEW.claimed_at_ms IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'staged_attachment_initial_state_invalid');
END;

-- 未使用objectのDoSをDBの直列化境界で抑える。messageは既存仕様どおり5件、profileは1件。
CREATE TRIGGER IF NOT EXISTS enforce_staged_attachment_pending_quota
BEFORE INSERT ON staged_attachments
WHEN NEW.status IN ('uploading', 'ready')
 AND NOT EXISTS (
   SELECT 1
     FROM staged_attachments existing_stage
    WHERE existing_stage.staged_attachment_id = NEW.staged_attachment_id
 )
 AND (
   (
     NEW.purpose = 'message'
     AND (
       (SELECT COUNT(*)
          FROM staged_attachments pending_stage
         WHERE pending_stage.org_id = NEW.org_id
           AND pending_stage.owner_user_id = NEW.owner_user_id
           AND pending_stage.purpose = 'message'
           AND pending_stage.status IN ('uploading', 'ready')
           AND pending_stage.expires_at_ms > NEW.created_at_ms) >= 5
       OR
       COALESCE((SELECT SUM(pending_stage.size_bytes)
                   FROM staged_attachments pending_stage
                  WHERE pending_stage.org_id = NEW.org_id
                    AND pending_stage.owner_user_id = NEW.owner_user_id
                    AND pending_stage.purpose = 'message'
                    AND pending_stage.status IN ('uploading', 'ready')
                    AND pending_stage.expires_at_ms > NEW.created_at_ms), 0)
         + NEW.size_bytes > 52428800
       OR
       (SELECT COUNT(*)
          FROM staged_attachments retained_stage
         WHERE retained_stage.org_id = NEW.org_id
           AND retained_stage.owner_user_id = NEW.owner_user_id
           AND retained_stage.purpose = 'message'
           AND retained_stage.status IN ('uploading', 'ready', 'failed')
           AND retained_stage.expires_at_ms > NEW.created_at_ms) >= 10
     )
   )
   OR
   (
     NEW.purpose = 'profile'
     AND (
       EXISTS (
         SELECT 1
           FROM staged_attachments pending_stage
          WHERE pending_stage.org_id = NEW.org_id
            AND pending_stage.owner_user_id = NEW.owner_user_id
            AND pending_stage.purpose = 'profile'
            AND pending_stage.status IN ('uploading', 'ready')
            AND pending_stage.expires_at_ms > NEW.created_at_ms
       )
       OR
       (SELECT COUNT(*)
          FROM staged_attachments retained_stage
         WHERE retained_stage.org_id = NEW.org_id
           AND retained_stage.owner_user_id = NEW.owner_user_id
           AND retained_stage.purpose = 'profile'
           AND retained_stage.status IN ('uploading', 'ready', 'failed')
           AND retained_stage.expires_at_ms > NEW.created_at_ms) >= 3
     )
   )
 )
BEGIN
  SELECT RAISE(ABORT, 'staged_attachment_quota_exceeded');
END;

-- tenant・owner・R2 key・digestは作成後に変更不可とし、別scopeへの付け替えをDBでも拒否する。
CREATE TRIGGER IF NOT EXISTS prevent_staged_attachment_scope_update
BEFORE UPDATE OF org_id, owner_user_id, owner_membership_id, purpose,
  file_name, content_type, size_bytes, checksum, r2_key,
  request_id, request_payload_sha256, request_generation_ms, created_at_ms, expires_at_ms
ON staged_attachments
BEGIN
  SELECT RAISE(ABORT, 'staged_attachment_scope_immutable');
END;

-- readyからのclaimは一度だけ。claimed済みtargetの変更・claim解除をDB境界で拒否する。
CREATE TRIGGER IF NOT EXISTS enforce_staged_attachment_claim_transition
BEFORE UPDATE OF status, claimed_target_type, claimed_target_id, claimed_at_ms
ON staged_attachments
WHEN NOT (
  (OLD.status = 'uploading'
    AND NEW.status IN ('uploading', 'ready', 'superseded', 'failed')
    AND NEW.claimed_target_type IS NULL
    AND NEW.claimed_target_id IS NULL
    AND NEW.claimed_at_ms IS NULL)
  OR
  (OLD.status = 'failed'
    AND NEW.status IN ('failed', 'uploading', 'superseded')
    AND NEW.claimed_target_type IS NULL
    AND NEW.claimed_target_id IS NULL
    AND NEW.claimed_at_ms IS NULL)
  OR
  (OLD.status = 'ready'
    AND (
      (NEW.status = 'ready'
        AND NEW.claimed_target_type IS NULL
        AND NEW.claimed_target_id IS NULL
        AND NEW.claimed_at_ms IS NULL)
      OR
      (NEW.status = 'superseded'
        AND NEW.claimed_target_type IS NULL
        AND NEW.claimed_target_id IS NULL
        AND NEW.claimed_at_ms IS NULL)
      OR
      (NEW.status = 'claimed'
        AND (
          (OLD.purpose = 'message' AND NEW.claimed_target_type = 'message')
          OR (OLD.purpose = 'profile' AND NEW.claimed_target_type = 'user_settings')
        )
        AND NEW.claimed_target_id IS NOT NULL
        AND NEW.claimed_at_ms IS NOT NULL)
    ))
  OR
  (OLD.status = 'claimed'
    AND NEW.status = 'claimed'
    AND NEW.claimed_target_type = OLD.claimed_target_type
    AND NEW.claimed_target_id = OLD.claimed_target_id
    AND NEW.claimed_at_ms = OLD.claimed_at_ms)
)
BEGIN
  SELECT RAISE(ABORT, 'staged_attachment_claim_invalid');
END;

-- failed uploadの再試行もINSERT時と同じactive quotaを通し、UPDATE経路の上限迂回を防ぐ。
CREATE TRIGGER IF NOT EXISTS enforce_staged_attachment_retry_quota
BEFORE UPDATE OF status ON staged_attachments
WHEN OLD.status = 'failed'
 AND NEW.status = 'uploading'
 AND (
   (
     OLD.purpose = 'message'
     AND (
       (SELECT COUNT(*)
          FROM staged_attachments pending_stage
         WHERE pending_stage.org_id = OLD.org_id
           AND pending_stage.owner_user_id = OLD.owner_user_id
           AND pending_stage.purpose = 'message'
           AND pending_stage.status IN ('uploading', 'ready')
           AND pending_stage.staged_attachment_id <> OLD.staged_attachment_id
           AND pending_stage.expires_at_ms > NEW.updated_at_ms) >= 5
       OR
       COALESCE((SELECT SUM(pending_stage.size_bytes)
                   FROM staged_attachments pending_stage
                  WHERE pending_stage.org_id = OLD.org_id
                    AND pending_stage.owner_user_id = OLD.owner_user_id
                    AND pending_stage.purpose = 'message'
                    AND pending_stage.status IN ('uploading', 'ready')
                    AND pending_stage.staged_attachment_id <> OLD.staged_attachment_id
                    AND pending_stage.expires_at_ms > NEW.updated_at_ms), 0)
         + OLD.size_bytes > 52428800
     )
   )
   OR
   (
     OLD.purpose = 'profile'
     AND EXISTS (
       SELECT 1
         FROM staged_attachments pending_stage
        WHERE pending_stage.org_id = OLD.org_id
          AND pending_stage.owner_user_id = OLD.owner_user_id
          AND pending_stage.purpose = 'profile'
          AND pending_stage.status IN ('uploading', 'ready')
          AND pending_stage.staged_attachment_id <> OLD.staged_attachment_id
          AND pending_stage.expires_at_ms > NEW.updated_at_ms
     )
   )
 )
BEGIN
  SELECT RAISE(ABORT, 'staged_attachment_quota_exceeded');
END;
