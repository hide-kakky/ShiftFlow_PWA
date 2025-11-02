-- Create task, attachment, and audit related tables for ShiftFlow D1
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,              -- ULID
  org_id TEXT NOT NULL,
  folder_id TEXT,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  priority TEXT,
  created_by_email TEXT,
  created_by_membership_id TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  due_at_ms INTEGER,
  legacy_task_id TEXT,
  meta_json TEXT,
  FOREIGN KEY (org_id) REFERENCES organizations(org_id),
  FOREIGN KEY (created_by_membership_id) REFERENCES memberships(membership_id)
);

CREATE INDEX IF NOT EXISTS idx_tasks_org ON tasks(org_id);
CREATE INDEX IF NOT EXISTS idx_tasks_created_by ON tasks(created_by_membership_id);

CREATE TABLE IF NOT EXISTS task_assignees (
  task_id TEXT NOT NULL,
  email TEXT NOT NULL,
  membership_id TEXT,
  assigned_at_ms INTEGER NOT NULL,
  PRIMARY KEY (task_id, email),
  FOREIGN KEY (task_id) REFERENCES tasks(task_id),
  FOREIGN KEY (membership_id) REFERENCES memberships(membership_id)
);

CREATE INDEX IF NOT EXISTS idx_task_assignees_task ON task_assignees(task_id);
CREATE INDEX IF NOT EXISTS idx_task_assignees_member ON task_assignees(membership_id);

CREATE TABLE IF NOT EXISTS attachments (
  attachment_id TEXT PRIMARY KEY,        -- ULID
  org_id TEXT NOT NULL,
  file_name TEXT,
  content_type TEXT,
  size_bytes INTEGER,
  storage_path TEXT,
  checksum TEXT,
  created_at_ms INTEGER NOT NULL,
  created_by_membership_id TEXT,
  extra_json TEXT,
  FOREIGN KEY (org_id) REFERENCES organizations(org_id),
  FOREIGN KEY (created_by_membership_id) REFERENCES memberships(membership_id)
);

CREATE INDEX IF NOT EXISTS idx_attachments_org ON attachments(org_id);
CREATE INDEX IF NOT EXISTS idx_attachments_creator ON attachments(created_by_membership_id);

CREATE TABLE IF NOT EXISTS task_attachments (
  task_id TEXT NOT NULL,
  attachment_id TEXT NOT NULL,
  PRIMARY KEY (task_id, attachment_id),
  FOREIGN KEY (task_id) REFERENCES tasks(task_id),
  FOREIGN KEY (attachment_id) REFERENCES attachments(attachment_id)
);

CREATE TABLE IF NOT EXISTS message_attachments (
  message_id TEXT NOT NULL,
  attachment_id TEXT NOT NULL,
  PRIMARY KEY (message_id, attachment_id),
  FOREIGN KEY (message_id) REFERENCES messages(message_id),
  FOREIGN KEY (attachment_id) REFERENCES attachments(attachment_id)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  audit_id TEXT PRIMARY KEY,             -- ULID
  org_id TEXT NOT NULL,
  actor_membership_id TEXT,
  target_type TEXT NOT NULL,
  target_id TEXT,
  action TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  payload_json TEXT,
  FOREIGN KEY (org_id) REFERENCES organizations(org_id),
  FOREIGN KEY (actor_membership_id) REFERENCES memberships(membership_id)
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_org ON audit_logs(org_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor_membership_id);

CREATE TABLE IF NOT EXISTS login_audits (
  login_id TEXT PRIMARY KEY,             -- ULID
  org_id TEXT,
  user_email TEXT,
  user_sub TEXT,
  status TEXT,
  reason TEXT,
  request_id TEXT,
  token_iat_ms INTEGER,
  attempted_at_ms INTEGER NOT NULL,
  client_ip TEXT,
  user_agent TEXT,
  role TEXT
);

CREATE INDEX IF NOT EXISTS idx_login_audits_email ON login_audits(user_email);
CREATE INDEX IF NOT EXISTS idx_login_audits_sub ON login_audits(user_sub);

CREATE TABLE IF NOT EXISTS auth_proxy_logs (
  log_id TEXT PRIMARY KEY,               -- ULID
  level TEXT,
  event TEXT,
  message TEXT,
  request_id TEXT,
  route TEXT,
  email TEXT,
  status TEXT,
  meta_json TEXT,
  source TEXT,
  client_ip TEXT,
  user_agent TEXT,
  cf_ray TEXT,
  created_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_proxy_logs_request ON auth_proxy_logs(request_id);
CREATE INDEX IF NOT EXISTS idx_auth_proxy_logs_email ON auth_proxy_logs(email);
