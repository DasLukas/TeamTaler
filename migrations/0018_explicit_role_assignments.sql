INSERT INTO permission_definitions(key, description, implied_permissions_json, display_order, created_at)
VALUES (
    'CREATE_OWN_BOOKING',
    'Create a booking that charges the current membership.',
    '[]',
    65,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);

INSERT INTO role_permission_grants(
    group_id, role_id, permission_key, scope_type, version,
    created_at, updated_at, created_by, updated_by
)
SELECT
    r.group_id,
    r.id,
    'CREATE_OWN_BOOKING',
    'GROUP',
    1,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    NULL,
    NULL
FROM roles r
WHERE r.preset_key IN ('GROUP_ADMINISTRATOR', 'MEMBER');

CREATE TABLE _0018_roles_backup AS SELECT * FROM roles;
CREATE TABLE _0018_role_grants_backup AS SELECT * FROM role_permission_grants;
CREATE TABLE _0018_membership_roles_backup AS SELECT * FROM membership_role_assignments;
CREATE TABLE _0018_invitation_roles_backup AS SELECT * FROM invitation_role_assignments;

DROP TRIGGER roles_preset_identity_immutable;
DROP TRIGGER roles_protected_delete;
DROP TRIGGER roles_assigned_delete;
DROP TRIGGER role_permission_grants_admin_core_delete;
DROP TRIGGER role_permission_grants_admin_core_update;
DROP TRIGGER role_permission_grants_increment_role_insert;
DROP TRIGGER role_permission_grants_increment_role_update;
DROP TRIGGER role_permission_grants_increment_role_delete;
DROP TRIGGER membership_role_assignments_required_member_delete;
DROP TRIGGER membership_role_assignments_last_admin_delete;
DROP TRIGGER membership_role_assignments_increment_target_insert;
DROP TRIGGER membership_role_assignments_increment_target_update;
DROP TRIGGER membership_role_assignments_increment_target_delete;
DROP TRIGGER invitation_role_assignments_required_member_delete;
DROP TRIGGER invitation_role_assignments_increment_target_insert;
DROP TRIGGER invitation_role_assignments_increment_target_update;
DROP TRIGGER invitation_role_assignments_increment_target_delete;
DROP TRIGGER groups_seed_roles_after_insert;
DROP TRIGGER memberships_assign_member_role_after_insert;
DROP TRIGGER memberships_assign_initial_administrator_after_insert;
DROP TRIGGER memberships_assign_member_role_after_reactivation;
DROP TRIGGER invitations_assign_member_role_after_insert;

PRAGMA defer_foreign_keys = ON;
DROP TABLE roles;

CREATE TABLE roles (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    preset_key TEXT CHECK (
        preset_key IS NULL OR preset_key IN (
            'GROUP_ADMINISTRATOR',
            'MEMBER',
            'FINANCE_MANAGER',
            'CATALOG_MANAGER'
        )
    ),
    name TEXT NOT NULL COLLATE NOCASE
        CHECK (
            name = trim(name)
            AND length(name) BETWEEN 1 AND 120
            AND name NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || ']*')
        ),
    description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 500),
    name_locked INTEGER NOT NULL DEFAULT 0 CHECK (name_locked IN (0, 1)),
    deletable INTEGER NOT NULL DEFAULT 1 CHECK (deletable IN (0, 1)),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    created_by TEXT,
    updated_by TEXT,
    UNIQUE (group_id, id),
    UNIQUE (group_id, preset_key),
    CHECK (
        preset_key != 'GROUP_ADMINISTRATOR' OR (
            name = 'Group administrator' COLLATE BINARY
            AND name_locked = 1
            AND deletable = 0
        )
    )
) STRICT;

CREATE UNIQUE INDEX roles_group_name_idx ON roles(group_id, name COLLATE NOCASE);
CREATE INDEX roles_group_order_idx ON roles(group_id, preset_key, lower(name), id);

INSERT INTO roles(
    id, group_id, preset_key, name, description, name_locked, deletable,
    version, created_at, updated_at, created_by, updated_by
)
SELECT
    id,
    group_id,
    preset_key,
    name,
    CASE
        WHEN preset_key = 'MEMBER' AND description = 'Required base role assigned to every active membership.'
            THEN 'Editable starter role for regular group members.'
        ELSE description
    END,
    name_locked,
    CASE WHEN preset_key = 'MEMBER' THEN 1 ELSE deletable END,
    version,
    created_at,
    updated_at,
    created_by,
    updated_by
FROM _0018_roles_backup;

INSERT INTO role_permission_grants SELECT * FROM _0018_role_grants_backup;
INSERT INTO membership_role_assignments SELECT * FROM _0018_membership_roles_backup;
INSERT INTO invitation_role_assignments SELECT * FROM _0018_invitation_roles_backup;

DROP TABLE _0018_invitation_roles_backup;
DROP TABLE _0018_membership_roles_backup;
DROP TABLE _0018_role_grants_backup;
DROP TABLE _0018_roles_backup;

CREATE TRIGGER roles_preset_identity_immutable
BEFORE UPDATE OF group_id, preset_key ON roles
WHEN NEW.group_id != OLD.group_id OR NEW.preset_key IS NOT OLD.preset_key
BEGIN
    SELECT RAISE(ABORT, 'role group and preset identity are immutable');
END;

CREATE TRIGGER roles_protected_delete
BEFORE DELETE ON roles
WHEN OLD.preset_key = 'GROUP_ADMINISTRATOR'
BEGIN
    SELECT RAISE(ABORT, 'protected role cannot be deleted');
END;

CREATE TRIGGER roles_assigned_delete
BEFORE DELETE ON roles
WHEN OLD.preset_key != 'GROUP_ADMINISTRATOR' OR OLD.preset_key IS NULL
BEGIN
    SELECT CASE WHEN EXISTS (
        SELECT 1
        FROM membership_role_assignments a
        JOIN memberships m ON m.group_id = a.group_id AND m.id = a.membership_id
        WHERE a.group_id = OLD.group_id AND a.role_id = OLD.id AND m.status = 'ACTIVE'
    ) OR EXISTS (
        SELECT 1
        FROM invitation_role_assignments a
        JOIN invitations i ON i.group_id = a.group_id AND i.id = a.invitation_id
        WHERE a.group_id = OLD.group_id
          AND a.role_id = OLD.id
          AND i.accepted_at IS NULL
          AND i.revoked_at IS NULL
          AND julianday(i.expires_at) > julianday('now')
    ) THEN RAISE(ABORT, 'assigned role cannot be deleted') END;
END;

CREATE TRIGGER role_permission_grants_admin_core_delete
BEFORE DELETE ON role_permission_grants
WHEN OLD.permission_key IN ('GROUP_ADMINISTRATION', 'ROLE_MANAGEMENT')
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
WHEN OLD.permission_key IN ('GROUP_ADMINISTRATION', 'ROLE_MANAGEMENT')
 AND EXISTS (
     SELECT 1 FROM roles
     WHERE id = OLD.role_id
       AND group_id = OLD.group_id
       AND preset_key = 'GROUP_ADMINISTRATOR'
 )
BEGIN
    SELECT RAISE(ABORT, 'administrator core permissions cannot be changed');
END;

CREATE TRIGGER role_permission_grants_increment_role_insert
AFTER INSERT ON role_permission_grants
BEGIN
    UPDATE roles SET version = version + 1, updated_at = NEW.updated_at, updated_by = NEW.updated_by
    WHERE id = NEW.role_id AND group_id = NEW.group_id;
END;

CREATE TRIGGER role_permission_grants_increment_role_update
AFTER UPDATE ON role_permission_grants
BEGIN
    UPDATE roles SET version = version + 1, updated_at = NEW.updated_at, updated_by = NEW.updated_by
    WHERE id = NEW.role_id AND group_id = NEW.group_id;
END;

CREATE TRIGGER role_permission_grants_increment_role_delete
AFTER DELETE ON role_permission_grants
BEGIN
    UPDATE roles SET version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = OLD.role_id AND group_id = OLD.group_id;
END;

CREATE TRIGGER membership_role_assignments_minimum_delete
BEFORE DELETE ON membership_role_assignments
WHEN EXISTS (
    SELECT 1 FROM memberships
    WHERE id = OLD.membership_id AND group_id = OLD.group_id AND status = 'ACTIVE'
)
AND (
    SELECT count(*) FROM membership_role_assignments
    WHERE group_id = OLD.group_id AND membership_id = OLD.membership_id
) <= 1
BEGIN
    SELECT RAISE(ABORT, 'active memberships must retain at least one role');
END;

CREATE TRIGGER membership_role_assignments_last_admin_delete
BEFORE DELETE ON membership_role_assignments
WHEN EXISTS (
    SELECT 1
    FROM roles r
    JOIN memberships m ON m.group_id = OLD.group_id AND m.id = OLD.membership_id
    WHERE r.group_id = OLD.group_id
      AND r.id = OLD.role_id
      AND r.preset_key = 'GROUP_ADMINISTRATOR'
      AND m.status = 'ACTIVE'
)
AND (
    SELECT count(*)
    FROM membership_role_assignments a
    JOIN roles r ON r.group_id = a.group_id AND r.id = a.role_id
    JOIN memberships m ON m.group_id = a.group_id AND m.id = a.membership_id
    WHERE a.group_id = OLD.group_id
      AND r.preset_key = 'GROUP_ADMINISTRATOR'
      AND m.status = 'ACTIVE'
) <= 1
BEGIN
    SELECT RAISE(ABORT, 'group must retain an active group administrator');
END;

CREATE TRIGGER membership_role_assignments_increment_target_insert
AFTER INSERT ON membership_role_assignments
BEGIN
    UPDATE memberships SET role_assignments_version = role_assignments_version + 1
    WHERE id = NEW.membership_id AND group_id = NEW.group_id;
END;

CREATE TRIGGER membership_role_assignments_increment_target_update
AFTER UPDATE ON membership_role_assignments
BEGIN
    UPDATE memberships SET role_assignments_version = role_assignments_version + 1
    WHERE id = NEW.membership_id AND group_id = NEW.group_id;
END;

CREATE TRIGGER membership_role_assignments_increment_target_delete
AFTER DELETE ON membership_role_assignments
BEGIN
    UPDATE memberships SET role_assignments_version = role_assignments_version + 1
    WHERE id = OLD.membership_id AND group_id = OLD.group_id;
END;

CREATE TRIGGER invitation_role_assignments_minimum_delete
BEFORE DELETE ON invitation_role_assignments
WHEN EXISTS (
    SELECT 1 FROM invitations
    WHERE id = OLD.invitation_id
      AND group_id = OLD.group_id
      AND accepted_at IS NULL
      AND revoked_at IS NULL
      AND julianday(expires_at) > julianday('now')
)
AND (
    SELECT count(*) FROM invitation_role_assignments
    WHERE group_id = OLD.group_id AND invitation_id = OLD.invitation_id
) <= 1
BEGIN
    SELECT RAISE(ABORT, 'pending invitations must retain at least one role');
END;

CREATE TRIGGER invitation_role_assignments_increment_target_insert
AFTER INSERT ON invitation_role_assignments
BEGIN
    UPDATE invitations SET role_assignments_version = role_assignments_version + 1
    WHERE id = NEW.invitation_id AND group_id = NEW.group_id;
END;

CREATE TRIGGER invitation_role_assignments_increment_target_update
AFTER UPDATE ON invitation_role_assignments
BEGIN
    UPDATE invitations SET role_assignments_version = role_assignments_version + 1
    WHERE id = NEW.invitation_id AND group_id = NEW.group_id;
END;

CREATE TRIGGER invitation_role_assignments_increment_target_delete
AFTER DELETE ON invitation_role_assignments
BEGIN
    UPDATE invitations SET role_assignments_version = role_assignments_version + 1
    WHERE id = OLD.invitation_id AND group_id = OLD.group_id;
END;

CREATE TRIGGER groups_seed_roles_after_insert
AFTER INSERT ON groups
BEGIN
    INSERT INTO roles(
        id, group_id, preset_key, name, description, name_locked, deletable,
        version, created_at, updated_at
    ) VALUES
        ('role:GROUP_ADMINISTRATOR:' || NEW.id, NEW.id, 'GROUP_ADMINISTRATOR', 'Group administrator', 'Required administrator role with full group access.', 1, 0, 1, NEW.created_at, NEW.updated_at),
        ('role:MEMBER:' || NEW.id, NEW.id, 'MEMBER', 'Member', 'Editable starter role for regular group members.', 0, 1, 1, NEW.created_at, NEW.updated_at),
        ('role:FINANCE_MANAGER:' || NEW.id, NEW.id, 'FINANCE_MANAGER', 'Finance manager', 'Seeded role for financial management.', 0, 1, 1, NEW.created_at, NEW.updated_at),
        ('role:CATALOG_MANAGER:' || NEW.id, NEW.id, 'CATALOG_MANAGER', 'Catalog manager', 'Seeded role for catalog management.', 0, 1, 1, NEW.created_at, NEW.updated_at);

    INSERT INTO role_permission_grants(
        group_id, role_id, permission_key, scope_type, version, created_at, updated_at
    )
    SELECT NEW.id, 'role:GROUP_ADMINISTRATOR:' || NEW.id, key, 'GROUP', 1, NEW.created_at, NEW.updated_at
    FROM permission_definitions;

    INSERT INTO role_permission_grants(
        group_id, role_id, permission_key, scope_type, version, created_at, updated_at
    ) VALUES
        (NEW.id, 'role:MEMBER:' || NEW.id, 'CREATE_OWN_BOOKING', 'GROUP', 1, NEW.created_at, NEW.updated_at),
        (NEW.id, 'role:MEMBER:' || NEW.id, 'VOID_OWN_BOOKING', 'GROUP', 1, NEW.created_at, NEW.updated_at),
        (NEW.id, 'role:FINANCE_MANAGER:' || NEW.id, 'FINANCE_MANAGEMENT', 'GROUP', 1, NEW.created_at, NEW.updated_at),
        (NEW.id, 'role:FINANCE_MANAGER:' || NEW.id, 'VIEW_ALL_BOOKING_ACTIVITY', 'GROUP', 1, NEW.created_at, NEW.updated_at),
        (NEW.id, 'role:FINANCE_MANAGER:' || NEW.id, 'RECORD_OWN_PAYMENT', 'GROUP', 1, NEW.created_at, NEW.updated_at),
        (NEW.id, 'role:CATALOG_MANAGER:' || NEW.id, 'CATALOG_MANAGEMENT', 'GROUP', 1, NEW.created_at, NEW.updated_at);

    UPDATE roles SET version = 1 WHERE group_id = NEW.id;
END;

CREATE TRIGGER memberships_assign_initial_administrator_after_insert
AFTER INSERT ON memberships
WHEN NEW.status = 'ACTIVE'
 AND NOT EXISTS (
     SELECT 1
     FROM membership_role_assignments a
     JOIN roles r ON r.group_id = a.group_id AND r.id = a.role_id
     JOIN memberships m ON m.group_id = a.group_id AND m.id = a.membership_id
     WHERE a.group_id = NEW.group_id
       AND r.preset_key = 'GROUP_ADMINISTRATOR'
       AND m.status = 'ACTIVE'
 )
BEGIN
    INSERT INTO membership_role_assignments(
        group_id, membership_id, role_id, version, assigned_at, assigned_by
    ) VALUES (
        NEW.group_id,
        NEW.id,
        'role:GROUP_ADMINISTRATOR:' || NEW.group_id,
        1,
        NEW.joined_at,
        NULL
    );
END;
