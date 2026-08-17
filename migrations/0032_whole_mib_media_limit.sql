-- Normalize legacy fractional-MiB overrides and enforce whole-MiB limits.

UPDATE system_settings_state
SET revision = revision + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    updated_by_user_id = NULL
WHERE singleton = 1
  AND EXISTS (
      SELECT 1
      FROM system_setting_overrides
      WHERE setting_key = 'media.upload_max_bytes'
        AND (
            CAST(value_text AS INTEGER) < 1048576
            OR CAST(value_text AS INTEGER) > 26214400
            OR CAST(value_text AS INTEGER) % 1048576 != 0
        )
  );

UPDATE system_setting_overrides
SET value_text = CAST(
        CASE
            WHEN CAST((CAST(value_text AS INTEGER) + 524288) / 1048576 AS INTEGER) < 1 THEN 1
            WHEN CAST((CAST(value_text AS INTEGER) + 524288) / 1048576 AS INTEGER) > 25 THEN 25
            ELSE CAST((CAST(value_text AS INTEGER) + 524288) / 1048576 AS INTEGER)
        END * 1048576
        AS TEXT
    ),
    version = version + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    updated_by_user_id = NULL
WHERE setting_key = 'media.upload_max_bytes'
  AND (
      CAST(value_text AS INTEGER) < 1048576
      OR CAST(value_text AS INTEGER) > 26214400
      OR CAST(value_text AS INTEGER) % 1048576 != 0
  );

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
