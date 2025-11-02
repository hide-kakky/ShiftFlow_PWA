-- Extend users table with metadata columns aligned with M_Users sheet
ALTER TABLE users ADD COLUMN status TEXT DEFAULT 'active';
ALTER TABLE users ADD COLUMN profile_image_url TEXT;
ALTER TABLE users ADD COLUMN theme TEXT;
ALTER TABLE users ADD COLUMN first_login_at_ms INTEGER;
ALTER TABLE users ADD COLUMN last_login_at_ms INTEGER;
ALTER TABLE users ADD COLUMN approved_by TEXT;
ALTER TABLE users ADD COLUMN approved_at_ms INTEGER;
ALTER TABLE users ADD COLUMN notes TEXT;
