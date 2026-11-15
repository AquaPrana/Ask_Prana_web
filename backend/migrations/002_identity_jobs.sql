-- Additive migration: preserve the already-applied initial schema.
ALTER TABLE users
  ADD CONSTRAINT users_phone_nonblank CHECK (phone IS NULL OR CHAR_LENGTH(TRIM(phone)) > 0),
  ADD CONSTRAINT users_email_normalized CHECK (email IS NULL OR email = LOWER(TRIM(email)));

CREATE TABLE IF NOT EXISTS verification_proofs (
  id CHAR(36) PRIMARY KEY,
  identity_value VARCHAR(320) NOT NULL,
  identity_type ENUM('phone','email') NOT NULL,
  purpose ENUM('login','registration','change_phone','change_email') NOT NULL,
  user_id CHAR(36) NULL,
  expires_at DATETIME(3) NOT NULL,
  consumed_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX verification_proofs_lookup (identity_value, purpose, expires_at, consumed_at),
  CONSTRAINT verification_proofs_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS durable_jobs (
  id CHAR(36) PRIMARY KEY,
  kind VARCHAR(80) NOT NULL,
  dedupe_key VARCHAR(255) NOT NULL,
  payload JSON NOT NULL,
  status ENUM('queued','running','completed','failed') NOT NULL DEFAULT 'queued',
  attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
  run_after DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  locked_at DATETIME(3) NULL,
  locked_by VARCHAR(120) NULL,
  last_error VARCHAR(1000) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY durable_jobs_dedupe (kind, dedupe_key),
  INDEX durable_jobs_ready (status, run_after, id)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS request_rate_limits (
  scope VARCHAR(120) NOT NULL,
  subject_hash CHAR(64) NOT NULL,
  window_start DATETIME(3) NOT NULL,
  count INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, subject_hash, window_start)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
