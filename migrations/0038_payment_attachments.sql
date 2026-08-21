-- Payment methods can require immutable, content-addressed payment evidence.

ALTER TABLE group_payment_methods
ADD COLUMN attachment_mode TEXT NOT NULL DEFAULT 'OFF'
    CHECK (attachment_mode IN ('OFF', 'OPTIONAL', 'REQUIRED'));

-- Keep existing group configuration unchanged, but seed the receipt-aware
-- defaults for every group created after this migration.
DROP TRIGGER group_settings_seed_payment_methods;

CREATE TRIGGER group_settings_seed_payment_methods
AFTER INSERT ON group_settings
BEGIN
    INSERT INTO group_payment_methods(group_id,id,label,sort_order,created_at,attachment_mode) VALUES
        (NEW.group_id,'BANK_TRANSFER','Bank transfer',0,NEW.updated_at,'OFF'),
        (NEW.group_id,'SHOPPING','Shopping',1,NEW.updated_at,'REQUIRED'),
        (NEW.group_id,'CASH','Cash',2,NEW.updated_at,'OFF'),
        (NEW.group_id,'PAYPAL','PayPal',3,NEW.updated_at,'OFF'),
        (NEW.group_id,'OTHER','Other',4,NEW.updated_at,'OPTIONAL');
END;

CREATE TABLE payment_attachments (
    payment_id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    storage_key TEXT NOT NULL CHECK (
        length(storage_key) = 68
        AND substr(storage_key, 1, 64) NOT GLOB '*[^0-9a-f]*'
        AND substr(storage_key, 65, 4) IN ('.jpg', '.png', '.pdf')
    ),
    original_filename TEXT NOT NULL CHECK (length(trim(original_filename)) BETWEEN 1 AND 240),
    media_type TEXT NOT NULL CHECK (media_type IN ('image/jpeg', 'image/png', 'application/pdf')),
    size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 52428800),
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
    created_by_membership_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (group_id, payment_id),
    CHECK (sha256 = substr(storage_key, 1, 64)),
    FOREIGN KEY (group_id, payment_id) REFERENCES payments(group_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (group_id, created_by_membership_id) REFERENCES memberships(group_id, id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX payment_attachments_group_idx
    ON payment_attachments(group_id, created_at DESC, payment_id);
CREATE INDEX payment_attachments_storage_idx
    ON payment_attachments(storage_key);

CREATE TRIGGER payment_attachments_no_update
BEFORE UPDATE ON payment_attachments
BEGIN
    SELECT RAISE(ABORT, 'payment attachments are immutable');
END;

CREATE TRIGGER payment_attachments_no_delete
BEFORE DELETE ON payment_attachments
WHEN NOT EXISTS (
    SELECT 1 FROM system_group_purge_context context
    WHERE context.group_id = OLD.group_id
)
BEGIN
    SELECT RAISE(ABORT, 'payment attachments are immutable');
END;

CREATE TABLE system_attachment_delete_jobs (
    storage_key TEXT PRIMARY KEY CHECK (
        length(storage_key) = 68
        AND substr(storage_key, 1, 64) NOT GLOB '*[^0-9a-f]*'
        AND substr(storage_key, 65, 4) IN ('.jpg', '.png', '.pdf')
    ),
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'DONE')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at TEXT NOT NULL,
    last_error_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX system_attachment_delete_jobs_pending_idx
    ON system_attachment_delete_jobs(status, next_attempt_at, storage_key);

-- The original table uses a closed setting-key CHECK, so rebuild it while
-- preserving every override and its optimistic-concurrency metadata.
ALTER TABLE system_setting_overrides RENAME TO system_setting_overrides_0038;

CREATE TABLE system_setting_overrides (
    setting_key TEXT PRIMARY KEY CHECK (setting_key IN (
        'instance.name',
        'instance.default_currency',
        'media.upload_max_bytes',
        'attachment.upload_max_bytes',
        'access.public_join_enabled',
        'maintenance.enabled',
        'maintenance.message',
        'smtp.enabled',
        'smtp.host',
        'smtp.port',
        'smtp.tls_mode',
        'smtp.username',
        'smtp.from_address',
        'smtp.from_name',
        'smtp.password',
        'web_push.enabled',
        'web_push.subject',
        'web_push.vapid_private_key'
    )),
    value_type TEXT NOT NULL CHECK (value_type IN ('STRING', 'INTEGER', 'BOOLEAN', 'SECRET')),
    value_text TEXT,
    secret_ciphertext TEXT,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    updated_at TEXT NOT NULL,
    updated_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
    CHECK (
        (value_type = 'SECRET' AND value_text IS NULL AND secret_ciphertext IS NOT NULL AND length(secret_ciphertext) > 0)
        OR
        (value_type != 'SECRET' AND value_text IS NOT NULL AND secret_ciphertext IS NULL)
    ),
    CHECK (
        (setting_key IN ('smtp.password', 'web_push.vapid_private_key') AND value_type = 'SECRET')
        OR (setting_key IN ('media.upload_max_bytes', 'attachment.upload_max_bytes', 'smtp.port') AND value_type = 'INTEGER')
        OR (setting_key IN ('access.public_join_enabled', 'maintenance.enabled', 'smtp.enabled', 'web_push.enabled') AND value_type = 'BOOLEAN')
        OR (setting_key IN (
            'instance.name', 'instance.default_currency', 'maintenance.message',
            'smtp.host', 'smtp.tls_mode', 'smtp.username', 'smtp.from_address', 'smtp.from_name',
            'web_push.subject'
        ) AND value_type = 'STRING')
    ),
    CHECK (value_type != 'BOOLEAN' OR value_text IN ('true', 'false')),
    CHECK (value_type != 'INTEGER' OR (
        value_text NOT GLOB '*[^0-9]*' AND length(value_text) BETWEEN 1 AND 20
    ))
) STRICT;

INSERT INTO system_setting_overrides(
    setting_key,value_type,value_text,secret_ciphertext,version,updated_at,updated_by_user_id
)
SELECT setting_key,value_type,value_text,secret_ciphertext,version,updated_at,updated_by_user_id
FROM system_setting_overrides_0038;

DROP TABLE system_setting_overrides_0038;

CREATE INDEX system_setting_overrides_updated_idx
    ON system_setting_overrides(updated_at, setting_key);

CREATE TRIGGER system_media_limit_validate_insert
BEFORE INSERT ON system_setting_overrides
WHEN NEW.setting_key = 'media.upload_max_bytes'
 AND (
     CAST(NEW.value_text AS INTEGER) < 1048576
     OR CAST(NEW.value_text AS INTEGER) > 26214400
     OR CAST(NEW.value_text AS INTEGER) % 1048576 != 0
 )
BEGIN
    SELECT RAISE(ABORT, 'media upload limit must be a whole MiB value from 1 through 25 MiB');
END;

CREATE TRIGGER system_media_limit_validate_update
BEFORE UPDATE OF setting_key, value_text ON system_setting_overrides
WHEN NEW.setting_key = 'media.upload_max_bytes'
 AND (
     CAST(NEW.value_text AS INTEGER) < 1048576
     OR CAST(NEW.value_text AS INTEGER) > 26214400
     OR CAST(NEW.value_text AS INTEGER) % 1048576 != 0
 )
BEGIN
    SELECT RAISE(ABORT, 'media upload limit must be a whole MiB value from 1 through 25 MiB');
END;

CREATE TRIGGER system_attachment_limit_validate_insert
BEFORE INSERT ON system_setting_overrides
WHEN NEW.setting_key = 'attachment.upload_max_bytes'
 AND (
     CAST(NEW.value_text AS INTEGER) < 1048576
     OR CAST(NEW.value_text AS INTEGER) > 52428800
     OR CAST(NEW.value_text AS INTEGER) % 1048576 != 0
 )
BEGIN
    SELECT RAISE(ABORT, 'attachment upload limit must be a whole MiB value from 1 through 50 MiB');
END;

CREATE TRIGGER system_attachment_limit_validate_update
BEFORE UPDATE OF setting_key, value_text ON system_setting_overrides
WHEN NEW.setting_key = 'attachment.upload_max_bytes'
 AND (
     CAST(NEW.value_text AS INTEGER) < 1048576
     OR CAST(NEW.value_text AS INTEGER) > 52428800
     OR CAST(NEW.value_text AS INTEGER) % 1048576 != 0
 )
BEGIN
    SELECT RAISE(ABORT, 'attachment upload limit must be a whole MiB value from 1 through 50 MiB');
END;
