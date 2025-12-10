-- Add table for message comments
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS message_comments (
  comment_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  membership_id TEXT,
  author_email TEXT,
  author_display_name TEXT,
  body TEXT NOT NULL,
  mentions TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  FOREIGN KEY (message_id) REFERENCES messages(message_id) ON DELETE CASCADE,
  FOREIGN KEY (org_id) REFERENCES organizations(org_id) ON DELETE CASCADE,
  FOREIGN KEY (membership_id) REFERENCES memberships(membership_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_message_comments_message_id ON message_comments(message_id);
CREATE INDEX IF NOT EXISTS idx_message_comments_org_id ON message_comments(org_id);
