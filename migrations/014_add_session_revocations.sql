-- v2: KVのeventual consistencyに依存せず、logout済みsessionをD1 primaryで強整合に拒否する。
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS session_revocations (
  session_fingerprint TEXT PRIMARY KEY CHECK (
    LENGTH(session_fingerprint) = 64
    AND session_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  revoked_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  CHECK (expires_at_ms > revoked_at_ms)
);

CREATE INDEX IF NOT EXISTS idx_session_revocations_expiry
  ON session_revocations(expires_at_ms ASC);
