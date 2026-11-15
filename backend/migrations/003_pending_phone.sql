ALTER TABLE users ADD COLUMN pending_phone VARCHAR(32) NULL AFTER phone;
CREATE INDEX users_pending_phone_lookup ON users (pending_phone);
