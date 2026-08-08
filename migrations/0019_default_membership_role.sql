CREATE TABLE _0019_group_settings (
    group_id TEXT PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
    members_can_view_all_bookings INTEGER NOT NULL DEFAULT 0
        CHECK (members_can_view_all_bookings IN (0, 1)),
    notification_emails_enabled INTEGER NOT NULL DEFAULT 0
        CHECK (notification_emails_enabled IN (0, 1)),
    default_role_id TEXT,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (group_id, default_role_id)
        REFERENCES roles(group_id, id) ON DELETE RESTRICT
) STRICT;

INSERT INTO _0019_group_settings(
    group_id,
    members_can_view_all_bookings,
    notification_emails_enabled,
    default_role_id,
    updated_at
)
SELECT
    settings.group_id,
    settings.members_can_view_all_bookings,
    settings.notification_emails_enabled,
    member_role.id,
    settings.updated_at
FROM group_settings settings
LEFT JOIN roles member_role
    ON member_role.group_id = settings.group_id
   AND member_role.preset_key = 'MEMBER';

DROP TABLE group_settings;
ALTER TABLE _0019_group_settings RENAME TO group_settings;

CREATE TRIGGER group_settings_default_role_insert
BEFORE INSERT ON group_settings
WHEN NEW.default_role_id IS NOT NULL
BEGIN
    SELECT CASE WHEN EXISTS (
        SELECT 1
        FROM role_permission_grants grants
        WHERE grants.group_id = NEW.group_id
          AND grants.role_id = NEW.default_role_id
          AND grants.permission_key = 'GROUP_ADMINISTRATION'
          AND grants.scope_type = 'GROUP'
    ) THEN RAISE(ABORT, 'default role cannot grant group administration') END;
END;

CREATE TRIGGER group_settings_default_role_update
BEFORE UPDATE OF group_id, default_role_id ON group_settings
WHEN NEW.default_role_id IS NOT NULL
BEGIN
    SELECT CASE WHEN EXISTS (
        SELECT 1
        FROM role_permission_grants grants
        WHERE grants.group_id = NEW.group_id
          AND grants.role_id = NEW.default_role_id
          AND grants.permission_key = 'GROUP_ADMINISTRATION'
          AND grants.scope_type = 'GROUP'
    ) THEN RAISE(ABORT, 'default role cannot grant group administration') END;
END;

CREATE TRIGGER role_grants_protect_default_role_insert
BEFORE INSERT ON role_permission_grants
WHEN NEW.permission_key = 'GROUP_ADMINISTRATION'
 AND NEW.scope_type = 'GROUP'
 AND EXISTS (
     SELECT 1
     FROM group_settings settings
     WHERE settings.group_id = NEW.group_id
       AND settings.default_role_id = NEW.role_id
 )
BEGIN
    SELECT RAISE(ABORT, 'default role cannot grant group administration');
END;

CREATE TRIGGER role_grants_protect_default_role_update
BEFORE UPDATE ON role_permission_grants
WHEN NEW.permission_key = 'GROUP_ADMINISTRATION'
 AND NEW.scope_type = 'GROUP'
 AND EXISTS (
     SELECT 1
     FROM group_settings settings
     WHERE settings.group_id = NEW.group_id
       AND settings.default_role_id = NEW.role_id
 )
BEGIN
    SELECT RAISE(ABORT, 'default role cannot grant group administration');
END;
