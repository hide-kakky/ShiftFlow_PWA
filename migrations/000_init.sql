-- Minimal D1 schema for ShiftFlow v2 migration dry-run
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS organizations (
  org_id TEXT PRIMARY KEY,            -- ULID
  name TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL      -- Unix time in milliseconds (UTC)
);

CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,           -- ULID
  email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  auth_subject TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
  membership_id TEXT PRIMARY KEY,     -- ULID
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  status TEXT NOT NULL DEFAULT 'active',
  created_at_ms INTEGER NOT NULL,
  UNIQUE (org_id, user_id),
  FOREIGN KEY (org_id) REFERENCES organizations(org_id),
  FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  message_id TEXT PRIMARY KEY,        -- ULID
  org_id TEXT NOT NULL,
  folder_id TEXT,
  author_membership_id TEXT,
  title TEXT,
  body TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  FOREIGN KEY (org_id) REFERENCES organizations(org_id),
  FOREIGN KEY (author_membership_id) REFERENCES memberships(membership_id)
);

CREATE TABLE IF NOT EXISTS message_reads (
  message_read_id TEXT PRIMARY KEY,   -- ULID
  message_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  read_at_ms INTEGER NOT NULL,
  UNIQUE (message_id, membership_id),
  FOREIGN KEY (message_id) REFERENCES messages(message_id),
  FOREIGN KEY (membership_id) REFERENCES memberships(membership_id)
);

-- Optional: seed a default organization placeholder to simplify dev testing.
INSERT INTO organizations (org_id, name, created_at_ms)
SELECT '01H00000000000000000000000', 'Default Org', strftime('%s', 'now') * 1000
WHERE NOT EXISTS (SELECT 1 FROM organizations);
