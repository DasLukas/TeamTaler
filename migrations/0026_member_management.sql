INSERT INTO permission_definitions(
    key,
    description,
    implied_permissions_json,
    display_order,
    created_at
)
VALUES (
    'MEMBER_MANAGEMENT',
    'Manage memberships, invitations, guests, join access, and role assignments.',
    '["VIEW_MEMBER_DIRECTORY"]',
    15,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);

UPDATE permission_definitions
SET description = 'Manage group identity, behavior settings, audit access, and protected administrator assignments.'
WHERE key = 'GROUP_ADMINISTRATION';

UPDATE permission_definitions
SET description = 'Manage roles and permission grants.'
WHERE key = 'ROLE_MANAGEMENT';

UPDATE permission_definitions
SET description = 'View the current consolidated group balance.'
WHERE key = 'VIEW_GROUP_STATISTICS';

INSERT INTO role_permission_grants(
    group_id,
    role_id,
    permission_key,
    scope_type,
    version,
    created_at,
    updated_at,
    created_by,
    updated_by
)
SELECT
    grants.group_id,
    grants.role_id,
    'MEMBER_MANAGEMENT',
    'GROUP',
    1,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    NULL,
    NULL
FROM role_permission_grants grants
WHERE grants.permission_key = 'GROUP_ADMINISTRATION'
  AND grants.scope_type = 'GROUP';

DROP TRIGGER role_permission_grants_admin_core_delete;
DROP TRIGGER role_permission_grants_admin_core_update;

CREATE TRIGGER role_permission_grants_admin_core_delete
BEFORE DELETE ON role_permission_grants
WHEN OLD.permission_key IN ('GROUP_ADMINISTRATION', 'MEMBER_MANAGEMENT', 'ROLE_MANAGEMENT')
 AND EXISTS (
     SELECT 1 FROM roles
     WHERE id = OLD.role_id
       AND group_id = OLD.group_id
       AND preset_key = 'GROUP_ADMINISTRATOR'
 )
BEGIN
    SELECT RAISE(ABORT, 'administrator core permissions cannot be removed');
END;

CREATE TRIGGER role_permission_grants_admin_core_update
BEFORE UPDATE ON role_permission_grants
WHEN OLD.permission_key IN ('GROUP_ADMINISTRATION', 'MEMBER_MANAGEMENT', 'ROLE_MANAGEMENT')
 AND EXISTS (
     SELECT 1 FROM roles
     WHERE id = OLD.role_id
       AND group_id = OLD.group_id
       AND preset_key = 'GROUP_ADMINISTRATOR'
 )
BEGIN
    SELECT RAISE(ABORT, 'administrator core permissions cannot be changed');
END;

DROP TRIGGER group_settings_default_role_insert;
DROP TRIGGER group_settings_default_role_update;
DROP TRIGGER role_grants_protect_default_role_insert;
DROP TRIGGER role_grants_protect_default_role_update;

CREATE TRIGGER group_settings_default_role_insert
BEFORE INSERT ON group_settings
WHEN NEW.default_role_id IS NOT NULL
BEGIN
    SELECT CASE WHEN EXISTS (
        SELECT 1
        FROM role_permission_grants grants
        WHERE grants.group_id = NEW.group_id
          AND grants.role_id = NEW.default_role_id
          AND grants.permission_key IN ('GROUP_ADMINISTRATION', 'MEMBER_MANAGEMENT')
          AND grants.scope_type = 'GROUP'
    ) THEN RAISE(ABORT, 'default role cannot grant administration permissions') END;
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
          AND grants.permission_key IN ('GROUP_ADMINISTRATION', 'MEMBER_MANAGEMENT')
          AND grants.scope_type = 'GROUP'
    ) THEN RAISE(ABORT, 'default role cannot grant administration permissions') END;
END;

CREATE TRIGGER role_grants_protect_default_role_insert
BEFORE INSERT ON role_permission_grants
WHEN NEW.permission_key IN ('GROUP_ADMINISTRATION', 'MEMBER_MANAGEMENT')
 AND NEW.scope_type = 'GROUP'
 AND EXISTS (
     SELECT 1
     FROM group_settings settings
     WHERE settings.group_id = NEW.group_id
       AND settings.default_role_id = NEW.role_id
 )
BEGIN
    SELECT RAISE(ABORT, 'default role cannot grant administration permissions');
END;

CREATE TRIGGER role_grants_protect_default_role_update
BEFORE UPDATE ON role_permission_grants
WHEN NEW.permission_key IN ('GROUP_ADMINISTRATION', 'MEMBER_MANAGEMENT')
 AND NEW.scope_type = 'GROUP'
 AND EXISTS (
     SELECT 1
     FROM group_settings settings
     WHERE settings.group_id = NEW.group_id
       AND settings.default_role_id = NEW.role_id
 )
BEGIN
    SELECT RAISE(ABORT, 'default role cannot grant administration permissions');
END;
