-- Add priority column to messages table so worker queries can reference it safely
PRAGMA foreign_keys = ON;

ALTER TABLE messages ADD COLUMN priority TEXT NOT NULL DEFAULT 'medium';

UPDATE messages
   SET priority = 'medium'
 WHERE priority IS NULL
    OR TRIM(priority) = '';
