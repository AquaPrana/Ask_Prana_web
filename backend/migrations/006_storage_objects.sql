-- Files (generated PDF/Excel/Word answers, chat uploads, profile photos) are
-- stored in MySQL so they survive on any host, including serverless ones whose
-- disk is wiped. `key_hash` is SHA-256 of "<bucket>/<object_key>" so long or
-- non-ASCII paths still fit in a primary key.
CREATE TABLE IF NOT EXISTS storage_objects (key_hash BINARY(32) PRIMARY KEY, bucket VARCHAR(63) NOT NULL, object_key VARCHAR(1000) NOT NULL, content_type VARCHAR(255) NOT NULL DEFAULT 'application/octet-stream', byte_size BIGINT NOT NULL, data LONGBLOB NOT NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), INDEX storage_objects_bucket (bucket)) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
