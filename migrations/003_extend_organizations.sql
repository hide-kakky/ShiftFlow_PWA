-- Extend organizations table with branding / notification metadata for admin UI
PRAGMA foreign_keys = ON;

ALTER TABLE organizations ADD COLUMN short_name TEXT;
ALTER TABLE organizations ADD COLUMN display_color TEXT;
ALTER TABLE organizations ADD COLUMN timezone TEXT;
ALTER TABLE organizations ADD COLUMN notification_email TEXT;
ALTER TABLE organizations ADD COLUMN updated_at_ms INTEGER;
ALTER TABLE organizations ADD COLUMN meta_json TEXT;
