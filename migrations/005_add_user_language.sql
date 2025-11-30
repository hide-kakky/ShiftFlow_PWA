-- Add language preference to users for persisted UI localization
ALTER TABLE users ADD COLUMN language TEXT DEFAULT 'ja';
