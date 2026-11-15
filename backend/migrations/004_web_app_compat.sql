-- Columns the Ask Prana web features use (profile photo link, optional profile
-- fields, the same as the original schema). Additive: no data is removed.
ALTER TABLE users ADD COLUMN avatar_url VARCHAR(1000) NULL AFTER avatar_path;
UPDATE users SET avatar_url = avatar_path WHERE avatar_url IS NULL AND avatar_path IS NOT NULL;
ALTER TABLE users
  MODIFY name VARCHAR(160) NULL DEFAULT NULL,
  MODIFY state VARCHAR(120) NULL DEFAULT NULL,
  MODIFY district VARCHAR(120) NULL DEFAULT NULL,
  MODIFY language VARCHAR(32) NULL DEFAULT 'English';
-- Fast chat history lists (newest activity first).
CREATE INDEX chat_sessions_user_activity ON chat_sessions (user_id, last_message_at);
