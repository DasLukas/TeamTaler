-- Notification delivery is member-owned, settlement reminder cadence belongs
-- to group finance settings, and the installation owns one shared time zone.

ALTER TABLE group_settings
ADD COLUMN settlement_due_soon_days INTEGER NOT NULL DEFAULT 3
    CHECK (settlement_due_soon_days BETWEEN 1 AND 30);

ALTER TABLE group_settings
ADD COLUMN settlement_overdue_repeat_days INTEGER NOT NULL DEFAULT 7
    CHECK (settlement_overdue_repeat_days BETWEEN 0 AND 90);

UPDATE group_settings
SET settlement_due_soon_days = (
        SELECT notification.settlement_due_soon_days
        FROM group_notification_settings notification
        WHERE notification.group_id = group_settings.group_id
    ),
    settlement_overdue_repeat_days = (
        SELECT notification.settlement_overdue_repeat_days
        FROM group_notification_settings notification
        WHERE notification.group_id = group_settings.group_id
    )
WHERE EXISTS (
    SELECT 1 FROM group_notification_settings notification
    WHERE notification.group_id = group_settings.group_id
);

-- The setting-key constraint is closed, so rebuild the table while retaining
-- every existing override and its optimistic-concurrency metadata.
ALTER TABLE system_setting_overrides RENAME TO system_setting_overrides_0050;

CREATE TABLE system_setting_overrides (
    setting_key TEXT PRIMARY KEY CHECK (setting_key IN (
        'instance.name',
        'instance.default_currency',
        'instance.timezone',
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
            'instance.name', 'instance.default_currency', 'instance.timezone', 'maintenance.message',
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
FROM system_setting_overrides_0050;

-- Preserve an unambiguous legacy installation-wide value. Divergent group
-- values intentionally fall back to TEAMTALER_TIMEZONE (Europe/Berlin by default).
INSERT INTO system_setting_overrides(
    setting_key,value_type,value_text,secret_ciphertext,version,updated_at,updated_by_user_id
)
SELECT 'instance.timezone','STRING',min(timezone),NULL,1,max(updated_at),NULL
FROM group_notification_settings
HAVING count(DISTINCT timezone) = 1;

DROP TABLE system_setting_overrides_0050;

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

DROP TRIGGER groups_seed_notification_configuration;
DROP TABLE group_notification_events;
DROP TABLE group_notification_settings;

ALTER TABLE group_settings DROP COLUMN notification_emails_enabled;
