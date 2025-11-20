-- Introduce folders / folder_members / templates tables and pinning for messages
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,                    -- ULID
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  color TEXT,                             -- HEX Color
  is_active INTEGER NOT NULL DEFAULT 1,   -- 1:Active, 0:Archived
  is_public INTEGER NOT NULL DEFAULT 1,   -- 1:Public, 0:Private
  is_system INTEGER NOT NULL DEFAULT 0,   -- 1:Main folder etc
  archived_at_ms INTEGER,
  archive_year INTEGER,
  archive_category TEXT,
  notes TEXT,
  meta_json TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_folders_org_active ON folders(org_id, is_active);
CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_org_name ON folders(org_id, lower(name));

CREATE TABLE IF NOT EXISTS folder_members (
  folder_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  added_at_ms INTEGER NOT NULL,
  PRIMARY KEY (folder_id, user_id),
  FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_folder_members_user ON folder_members(user_id);

CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  folder_id TEXT NOT NULL,
  name TEXT NOT NULL,
  title_format TEXT,
  body_format TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_templates_folder ON templates(folder_id);
CREATE INDEX IF NOT EXISTS idx_templates_org ON templates(org_id);

ALTER TABLE messages ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0;

DROP INDEX IF EXISTS idx_messages_org_folder_created;
CREATE INDEX IF NOT EXISTS idx_messages_folder_pinned
  ON messages(org_id, folder_id, is_pinned DESC, created_at_ms DESC);

-- Seed folders and migrate existing messages into the default Main folder.
CREATE TABLE IF NOT EXISTS _folder_seed (
  org_id TEXT NOT NULL,
  source_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  is_system INTEGER NOT NULL DEFAULT 0,
  is_public INTEGER NOT NULL DEFAULT 1,
  color TEXT,
  folder_id TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_folder_seed_unique
  ON _folder_seed(org_id, source_name);

INSERT OR IGNORE INTO _folder_seed (org_id, source_name, display_name, is_system, is_public, color)
SELECT org_id,
       '__DEFAULT__' AS source_name,
       'Main' AS display_name,
       1 AS is_system,
       1 AS is_public,
       '#517CB2' AS color
  FROM organizations;

INSERT OR IGNORE INTO _folder_seed (org_id, source_name, display_name, is_system, is_public, color)
SELECT DISTINCT m.org_id,
       CASE
         WHEN TRIM(COALESCE(m.folder_id, '')) = '' THEN '__DEFAULT__'
         ELSE TRIM(m.folder_id)
       END AS source_name,
       CASE
         WHEN TRIM(COALESCE(m.folder_id, '')) = '' THEN 'Main'
         ELSE TRIM(m.folder_id)
       END AS display_name,
       CASE
         WHEN TRIM(COALESCE(m.folder_id, '')) = '' THEN 1
         ELSE 0
       END AS is_system,
       1 AS is_public,
       NULL AS color
  FROM messages m
 WHERE m.org_id IS NOT NULL;

UPDATE _folder_seed
   SET folder_id = COALESCE(
     folder_id,
     'fld_' || lower(hex(randomblob(12)))
   );

INSERT OR IGNORE INTO folders (
  id,
  org_id,
  name,
  sort_order,
  color,
  is_active,
  is_public,
  is_system,
  created_at_ms,
  updated_at_ms
)
SELECT folder_id,
       org_id,
       display_name,
       CASE WHEN source_name = '__DEFAULT__' THEN 0 ELSE 100 END AS sort_order,
       COALESCE(color, '#CCCCCC'),
       1 AS is_active,
       is_public,
       is_system,
       CAST(strftime('%s', 'now') * 1000 AS INTEGER) AS created_at_ms,
       CAST(strftime('%s', 'now') * 1000 AS INTEGER) AS updated_at_ms
  FROM _folder_seed;

UPDATE messages
   SET folder_id = (
     SELECT folder_id
       FROM _folder_seed seed
      WHERE seed.org_id = messages.org_id
        AND seed.source_name = CASE
          WHEN TRIM(COALESCE(messages.folder_id, '')) = '' THEN '__DEFAULT__'
          ELSE TRIM(messages.folder_id)
        END
      LIMIT 1
   )
 WHERE EXISTS (
   SELECT 1
     FROM _folder_seed seed
    WHERE seed.org_id = messages.org_id
      AND seed.source_name = CASE
        WHEN TRIM(COALESCE(messages.folder_id, '')) = '' THEN '__DEFAULT__'
        ELSE TRIM(messages.folder_id)
      END
 );

DROP TABLE IF EXISTS _folder_seed;
