-- teamtaler:migration foreign-keys-off

INSERT INTO permission_definitions(
    key,
    description,
    implied_permissions_json,
    display_order,
    created_at
)
VALUES
    (
        'VIEW_MEMBER_DIRECTORY',
        'View the active member directory without administrative account details.',
        '[]',
        45,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    ),
    (
        'VIEW_GROUP_STATISTICS',
        'View aggregate group booking and financial statistics.',
        '[]',
        46,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    );

UPDATE permission_definitions
SET implied_permissions_json = '["VIEW_MEMBER_DIRECTORY"]'
WHERE key = 'BOOK_FOR_OTHERS';

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
    roles.group_id,
    roles.id,
    permissions.key,
    'GROUP',
    1,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    NULL,
    NULL
FROM roles
CROSS JOIN (
    SELECT 'VIEW_MEMBER_DIRECTORY' AS key
    UNION ALL
    SELECT 'VIEW_GROUP_STATISTICS'
) permissions;

DROP TRIGGER groups_seed_roles_after_insert;

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
        (NEW.id, 'role:MEMBER:' || NEW.id, 'VIEW_MEMBER_DIRECTORY', 'GROUP', 1, NEW.created_at, NEW.updated_at),
        (NEW.id, 'role:MEMBER:' || NEW.id, 'VIEW_GROUP_STATISTICS', 'GROUP', 1, NEW.created_at, NEW.updated_at),
        (NEW.id, 'role:MEMBER:' || NEW.id, 'CREATE_OWN_BOOKING', 'GROUP', 1, NEW.created_at, NEW.updated_at),
        (NEW.id, 'role:MEMBER:' || NEW.id, 'VOID_OWN_BOOKING', 'GROUP', 1, NEW.created_at, NEW.updated_at),
        (NEW.id, 'role:FINANCE_MANAGER:' || NEW.id, 'FINANCE_MANAGEMENT', 'GROUP', 1, NEW.created_at, NEW.updated_at),
        (NEW.id, 'role:FINANCE_MANAGER:' || NEW.id, 'VIEW_MEMBER_DIRECTORY', 'GROUP', 1, NEW.created_at, NEW.updated_at),
        (NEW.id, 'role:FINANCE_MANAGER:' || NEW.id, 'VIEW_GROUP_STATISTICS', 'GROUP', 1, NEW.created_at, NEW.updated_at),
        (NEW.id, 'role:FINANCE_MANAGER:' || NEW.id, 'VIEW_ALL_BOOKING_ACTIVITY', 'GROUP', 1, NEW.created_at, NEW.updated_at),
        (NEW.id, 'role:FINANCE_MANAGER:' || NEW.id, 'RECORD_OWN_PAYMENT', 'GROUP', 1, NEW.created_at, NEW.updated_at),
        (NEW.id, 'role:CATALOG_MANAGER:' || NEW.id, 'CATALOG_MANAGEMENT', 'GROUP', 1, NEW.created_at, NEW.updated_at),
        (NEW.id, 'role:CATALOG_MANAGER:' || NEW.id, 'VIEW_MEMBER_DIRECTORY', 'GROUP', 1, NEW.created_at, NEW.updated_at),
        (NEW.id, 'role:CATALOG_MANAGER:' || NEW.id, 'VIEW_GROUP_STATISTICS', 'GROUP', 1, NEW.created_at, NEW.updated_at);

    UPDATE roles SET version = 1 WHERE group_id = NEW.id;
END;

DROP TRIGGER group_settings_default_role_insert;
DROP TRIGGER group_settings_default_role_update;
DROP TRIGGER role_grants_protect_default_role_insert;
DROP TRIGGER role_grants_protect_default_role_update;

CREATE TABLE _0021_group_settings (
    group_id TEXT PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
    members_can_view_all_bookings INTEGER NOT NULL DEFAULT 0
        CHECK (members_can_view_all_bookings IN (0, 1)),
    notification_emails_enabled INTEGER NOT NULL DEFAULT 0
        CHECK (notification_emails_enabled IN (0, 1)),
    default_role_id TEXT,
    guests_enabled INTEGER NOT NULL DEFAULT 0
        CHECK (guests_enabled IN (0, 1)),
    guest_role_id TEXT,
    updated_at TEXT NOT NULL,
    CHECK (
        guests_enabled = 0
        OR guest_role_id IS NULL
        OR default_role_id = guest_role_id
    ),
    FOREIGN KEY (group_id, default_role_id)
        REFERENCES roles(group_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (group_id, guest_role_id)
        REFERENCES roles(group_id, id) ON DELETE RESTRICT
) STRICT;

INSERT INTO _0021_group_settings(
    group_id,
    members_can_view_all_bookings,
    notification_emails_enabled,
    default_role_id,
    guests_enabled,
    guest_role_id,
    updated_at
)
SELECT
    group_id,
    members_can_view_all_bookings,
    notification_emails_enabled,
    default_role_id,
    0,
    NULL,
    updated_at
FROM group_settings;

DROP TABLE group_settings;
ALTER TABLE _0021_group_settings RENAME TO group_settings;

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

CREATE TRIGGER group_settings_guest_role_insert
BEFORE INSERT ON group_settings
WHEN NEW.guest_role_id IS NOT NULL
BEGIN
    SELECT CASE WHEN EXISTS (
        SELECT 1
        FROM role_permission_grants grants
        WHERE grants.group_id = NEW.group_id
          AND grants.role_id = NEW.guest_role_id
          AND grants.permission_key = 'GROUP_ADMINISTRATION'
          AND grants.scope_type = 'GROUP'
    ) THEN RAISE(ABORT, 'guest role cannot grant group administration') END;

    SELECT CASE WHEN EXISTS (
        SELECT 1
        FROM membership_role_assignments guest_assignment
        JOIN membership_role_assignments other_assignment
          ON other_assignment.group_id = guest_assignment.group_id
         AND other_assignment.membership_id = guest_assignment.membership_id
         AND other_assignment.role_id != guest_assignment.role_id
        WHERE guest_assignment.group_id = NEW.group_id
          AND guest_assignment.role_id = NEW.guest_role_id
    ) OR EXISTS (
        SELECT 1
        FROM invitation_role_assignments guest_assignment
        JOIN invitation_role_assignments other_assignment
          ON other_assignment.group_id = guest_assignment.group_id
         AND other_assignment.invitation_id = guest_assignment.invitation_id
         AND other_assignment.role_id != guest_assignment.role_id
        JOIN invitations invitation
          ON invitation.group_id = guest_assignment.group_id
         AND invitation.id = guest_assignment.invitation_id
        WHERE guest_assignment.group_id = NEW.group_id
          AND guest_assignment.role_id = NEW.guest_role_id
          AND invitation.accepted_at IS NULL
          AND invitation.revoked_at IS NULL
          AND julianday(invitation.expires_at) > julianday('now')
    ) THEN RAISE(ABORT, 'guest role must be assigned exclusively') END;
END;

CREATE TRIGGER group_settings_guest_role_update
BEFORE UPDATE OF group_id, guest_role_id ON group_settings
WHEN NEW.guest_role_id IS NOT NULL
BEGIN
    SELECT CASE WHEN EXISTS (
        SELECT 1
        FROM role_permission_grants grants
        WHERE grants.group_id = NEW.group_id
          AND grants.role_id = NEW.guest_role_id
          AND grants.permission_key = 'GROUP_ADMINISTRATION'
          AND grants.scope_type = 'GROUP'
    ) THEN RAISE(ABORT, 'guest role cannot grant group administration') END;

    SELECT CASE WHEN EXISTS (
        SELECT 1
        FROM membership_role_assignments guest_assignment
        JOIN membership_role_assignments other_assignment
          ON other_assignment.group_id = guest_assignment.group_id
         AND other_assignment.membership_id = guest_assignment.membership_id
         AND other_assignment.role_id != guest_assignment.role_id
        WHERE guest_assignment.group_id = NEW.group_id
          AND guest_assignment.role_id = NEW.guest_role_id
    ) OR EXISTS (
        SELECT 1
        FROM invitation_role_assignments guest_assignment
        JOIN invitation_role_assignments other_assignment
          ON other_assignment.group_id = guest_assignment.group_id
         AND other_assignment.invitation_id = guest_assignment.invitation_id
         AND other_assignment.role_id != guest_assignment.role_id
        JOIN invitations invitation
          ON invitation.group_id = guest_assignment.group_id
         AND invitation.id = guest_assignment.invitation_id
        WHERE guest_assignment.group_id = NEW.group_id
          AND guest_assignment.role_id = NEW.guest_role_id
          AND invitation.accepted_at IS NULL
          AND invitation.revoked_at IS NULL
          AND julianday(invitation.expires_at) > julianday('now')
    ) THEN RAISE(ABORT, 'guest role must be assigned exclusively') END;
END;

CREATE TRIGGER role_grants_protect_guest_role_insert
BEFORE INSERT ON role_permission_grants
WHEN NEW.permission_key = 'GROUP_ADMINISTRATION'
 AND NEW.scope_type = 'GROUP'
 AND EXISTS (
     SELECT 1
     FROM group_settings settings
     WHERE settings.group_id = NEW.group_id
       AND settings.guest_role_id = NEW.role_id
 )
BEGIN
    SELECT RAISE(ABORT, 'guest role cannot grant group administration');
END;

CREATE TRIGGER role_grants_protect_guest_role_update
BEFORE UPDATE ON role_permission_grants
WHEN NEW.permission_key = 'GROUP_ADMINISTRATION'
 AND NEW.scope_type = 'GROUP'
 AND EXISTS (
     SELECT 1
     FROM group_settings settings
     WHERE settings.group_id = NEW.group_id
       AND settings.guest_role_id = NEW.role_id
 )
BEGIN
    SELECT RAISE(ABORT, 'guest role cannot grant group administration');
END;

CREATE TABLE _0021_users (
    id TEXT PRIMARY KEY,
    email TEXT COLLATE NOCASE UNIQUE,
    display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 120),
    password_hash TEXT,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    avatar_key TEXT
        CHECK (
            avatar_key IS NULL OR (
                length(avatar_key) = 68
                AND substr(avatar_key, 65, 4) = '.png'
                AND substr(avatar_key, 1, 64) NOT GLOB '*[^0-9a-f]*'
            )
        ),
    CHECK (
        (email IS NULL AND password_hash IS NULL)
        OR (email IS NOT NULL AND password_hash IS NOT NULL)
    )
) STRICT;

INSERT INTO _0021_users(
    id,
    email,
    display_name,
    password_hash,
    active,
    created_at,
    updated_at,
    avatar_key
)
SELECT
    id,
    email,
    display_name,
    password_hash,
    active,
    created_at,
    updated_at,
    avatar_key
FROM users;

DROP TABLE users;
ALTER TABLE _0021_users RENAME TO users;

ALTER TABLE memberships
    ADD COLUMN managed_guest_name_key TEXT
    CHECK (
        managed_guest_name_key IS NULL OR (
            managed_guest_name_key = trim(managed_guest_name_key)
            AND length(managed_guest_name_key) BETWEEN 1 AND 120
            AND managed_guest_name_key NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || ']*')
        )
    );

CREATE UNIQUE INDEX memberships_active_managed_guest_name_idx
    ON memberships(group_id, managed_guest_name_key)
    WHERE status = 'ACTIVE' AND managed_guest_name_key IS NOT NULL;

CREATE TRIGGER memberships_managed_guest_name_insert
BEFORE INSERT ON memberships
WHEN NEW.managed_guest_name_key IS NOT NULL
 AND NOT EXISTS (
    SELECT 1
    FROM users
    WHERE id = NEW.user_id
      AND email IS NULL
      AND password_hash IS NULL
 )
BEGIN
    SELECT RAISE(ABORT, 'managed guest name keys require a credential-less user');
END;

CREATE TRIGGER memberships_managed_guest_name_update
BEFORE UPDATE OF user_id, managed_guest_name_key ON memberships
WHEN NEW.managed_guest_name_key IS NOT NULL
 AND NOT EXISTS (
    SELECT 1
    FROM users
    WHERE id = NEW.user_id
      AND email IS NULL
      AND password_hash IS NULL
 )
BEGIN
    SELECT RAISE(ABORT, 'managed guest name keys require a credential-less user');
END;

DROP TRIGGER period_statements_no_update;
DROP TRIGGER period_statements_no_delete;

CREATE TABLE _0021_period_statements (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    period_id TEXT NOT NULL,
    membership_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    email TEXT,
    charges_minor INTEGER NOT NULL,
    payments_allocated_minor INTEGER NOT NULL,
    adjustments_applied_minor INTEGER NOT NULL DEFAULT 0,
    adjustments_provided_minor INTEGER NOT NULL DEFAULT 0,
    amount_due_minor INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('OPEN', 'PARTIAL', 'PAID', 'CREDIT')),
    created_at TEXT NOT NULL,
    UNIQUE (period_id, membership_id),
    FOREIGN KEY (group_id, period_id) REFERENCES periods(group_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (group_id, membership_id) REFERENCES memberships(group_id, id) ON DELETE RESTRICT
) STRICT;

INSERT INTO _0021_period_statements(
    id,
    group_id,
    period_id,
    membership_id,
    display_name,
    email,
    charges_minor,
    payments_allocated_minor,
    adjustments_applied_minor,
    adjustments_provided_minor,
    amount_due_minor,
    status,
    created_at
)
SELECT
    id,
    group_id,
    period_id,
    membership_id,
    display_name,
    email,
    charges_minor,
    payments_allocated_minor,
    adjustments_applied_minor,
    adjustments_provided_minor,
    amount_due_minor,
    status,
    created_at
FROM period_statements;

DROP TABLE period_statements;
ALTER TABLE _0021_period_statements RENAME TO period_statements;

CREATE TRIGGER period_statements_no_update
BEFORE UPDATE ON period_statements
BEGIN
    SELECT RAISE(ABORT, 'period statements are immutable');
END;

CREATE TRIGGER period_statements_no_delete
BEFORE DELETE ON period_statements
BEGIN
    SELECT RAISE(ABORT, 'period statements are immutable');
END;

ALTER TABLE invitations
    ADD COLUMN target_membership_id TEXT REFERENCES memberships(id) ON DELETE RESTRICT;

CREATE INDEX invitations_claim_target_idx
    ON invitations(group_id, target_membership_id, created_at DESC)
    WHERE target_membership_id IS NOT NULL;

DROP TRIGGER membership_role_assignments_minimum_delete;
DROP TRIGGER membership_role_assignments_identity_immutable;
DROP TRIGGER membership_role_assignments_last_admin_delete;
DROP TRIGGER invitation_role_assignments_identity_immutable;

CREATE TRIGGER membership_role_assignments_minimum_delete
BEFORE DELETE ON membership_role_assignments
WHEN EXISTS (
    SELECT 1
    FROM memberships membership
    JOIN users user ON user.id = membership.user_id
    WHERE membership.id = OLD.membership_id
      AND membership.group_id = OLD.group_id
      AND membership.status = 'ACTIVE'
      AND user.email IS NOT NULL
      AND user.password_hash IS NOT NULL
)
AND (
    SELECT count(*)
    FROM membership_role_assignments
    WHERE group_id = OLD.group_id
      AND membership_id = OLD.membership_id
) <= 1
BEGIN
    SELECT RAISE(ABORT, 'credentialed active memberships must retain at least one role');
END;

CREATE TRIGGER membership_role_assignments_last_admin_delete
BEFORE DELETE ON membership_role_assignments
WHEN EXISTS (
    SELECT 1
    FROM roles role
    JOIN memberships membership
      ON membership.group_id = OLD.group_id
     AND membership.id = OLD.membership_id
    WHERE role.group_id = OLD.group_id
      AND role.id = OLD.role_id
      AND role.preset_key = 'GROUP_ADMINISTRATOR'
      AND membership.status = 'ACTIVE'
)
AND (
    SELECT count(*)
    FROM membership_role_assignments assignment
    JOIN roles role
      ON role.group_id = assignment.group_id
     AND role.id = assignment.role_id
    JOIN memberships membership
      ON membership.group_id = assignment.group_id
     AND membership.id = assignment.membership_id
    WHERE assignment.group_id = OLD.group_id
      AND role.preset_key = 'GROUP_ADMINISTRATOR'
      AND membership.status = 'ACTIVE'
) <= 1
BEGIN
    SELECT RAISE(ABORT, 'group must retain an active group administrator');
END;

CREATE TRIGGER membership_role_assignments_identity_immutable
BEFORE UPDATE OF group_id, membership_id ON membership_role_assignments
WHEN NEW.group_id != OLD.group_id
  OR NEW.membership_id != OLD.membership_id
BEGIN
    SELECT RAISE(ABORT, 'role assignment group and target are immutable');
END;

CREATE TRIGGER invitation_role_assignments_identity_immutable
BEFORE UPDATE OF group_id, invitation_id ON invitation_role_assignments
WHEN NEW.group_id != OLD.group_id
  OR NEW.invitation_id != OLD.invitation_id
BEGIN
    SELECT RAISE(ABORT, 'role assignment group and target are immutable');
END;

CREATE TRIGGER membership_role_assignments_last_admin_update
BEFORE UPDATE OF role_id ON membership_role_assignments
WHEN NEW.role_id != OLD.role_id
 AND EXISTS (
    SELECT 1
    FROM roles role
    JOIN memberships membership
      ON membership.group_id = OLD.group_id
     AND membership.id = OLD.membership_id
    WHERE role.group_id = OLD.group_id
      AND role.id = OLD.role_id
      AND role.preset_key = 'GROUP_ADMINISTRATOR'
      AND membership.status = 'ACTIVE'
 )
 AND (
    SELECT count(*)
    FROM membership_role_assignments assignment
    JOIN roles role
      ON role.group_id = assignment.group_id
     AND role.id = assignment.role_id
    JOIN memberships membership
      ON membership.group_id = assignment.group_id
     AND membership.id = assignment.membership_id
    WHERE assignment.group_id = OLD.group_id
      AND role.preset_key = 'GROUP_ADMINISTRATOR'
      AND membership.status = 'ACTIVE'
 ) <= 1
BEGIN
    SELECT RAISE(ABORT, 'group must retain an active group administrator');
END;

CREATE TRIGGER membership_role_assignments_managed_insert
BEFORE INSERT ON membership_role_assignments
WHEN EXISTS (
    SELECT 1
    FROM memberships membership
    JOIN users user ON user.id=membership.user_id
    WHERE membership.id=NEW.membership_id
      AND membership.group_id=NEW.group_id
      AND membership.status='ACTIVE'
      AND user.email IS NULL
      AND user.password_hash IS NULL
)
AND NOT EXISTS (
    SELECT 1
    FROM group_settings settings
    JOIN invitations invitation
      ON invitation.group_id=settings.group_id
     AND invitation.target_membership_id=NEW.membership_id
     AND invitation.accepted_at IS NULL
     AND invitation.revoked_at IS NULL
     AND julianday(invitation.expires_at)>julianday('now')
    WHERE settings.group_id=NEW.group_id
      AND settings.guest_role_id=NEW.role_id
)
BEGIN
    SELECT RAISE(ABORT, 'managed memberships cannot receive role assignments');
END;

CREATE TRIGGER membership_role_assignments_managed_update
BEFORE UPDATE OF role_id ON membership_role_assignments
WHEN EXISTS (
    SELECT 1
    FROM memberships membership
    JOIN users user ON user.id=membership.user_id
    WHERE membership.id=NEW.membership_id
      AND membership.group_id=NEW.group_id
      AND membership.status='ACTIVE'
      AND user.email IS NULL
      AND user.password_hash IS NULL
)
AND NOT EXISTS (
    SELECT 1
    FROM group_settings settings
    JOIN invitations invitation
      ON invitation.group_id=settings.group_id
     AND invitation.target_membership_id=NEW.membership_id
     AND invitation.accepted_at IS NULL
     AND invitation.revoked_at IS NULL
     AND julianday(invitation.expires_at)>julianday('now')
    WHERE settings.group_id=NEW.group_id
      AND settings.guest_role_id=NEW.role_id
)
BEGIN
    SELECT RAISE(ABORT, 'managed memberships cannot receive role assignments');
END;

CREATE TRIGGER membership_guest_role_exclusive_insert
BEFORE INSERT ON membership_role_assignments
WHEN EXISTS (
    SELECT 1
    FROM group_settings settings
    WHERE settings.group_id = NEW.group_id
      AND settings.guest_role_id IS NOT NULL
      AND (
          (
              NEW.role_id = settings.guest_role_id
              AND EXISTS (
                  SELECT 1
                  FROM membership_role_assignments assignment
                  WHERE assignment.group_id = NEW.group_id
                    AND assignment.membership_id = NEW.membership_id
              )
          )
          OR (
              NEW.role_id != settings.guest_role_id
              AND EXISTS (
                  SELECT 1
                  FROM membership_role_assignments assignment
                  WHERE assignment.group_id = NEW.group_id
                    AND assignment.membership_id = NEW.membership_id
                    AND assignment.role_id = settings.guest_role_id
              )
          )
      )
)
BEGIN
    SELECT RAISE(ABORT, 'guest role must be assigned exclusively');
END;

CREATE TRIGGER membership_guest_role_exclusive_update
BEFORE UPDATE OF role_id ON membership_role_assignments
WHEN NEW.role_id != OLD.role_id
 AND EXISTS (
    SELECT 1
    FROM group_settings settings
    WHERE settings.group_id = NEW.group_id
      AND settings.guest_role_id IS NOT NULL
      AND (
          (
              NEW.role_id = settings.guest_role_id
              AND EXISTS (
                  SELECT 1
                  FROM membership_role_assignments assignment
                  WHERE assignment.group_id = NEW.group_id
                    AND assignment.membership_id = NEW.membership_id
                    AND assignment.role_id != OLD.role_id
              )
          )
          OR (
              NEW.role_id != settings.guest_role_id
              AND EXISTS (
                  SELECT 1
                  FROM membership_role_assignments assignment
                  WHERE assignment.group_id = NEW.group_id
                    AND assignment.membership_id = NEW.membership_id
                    AND assignment.role_id = settings.guest_role_id
                    AND assignment.role_id != OLD.role_id
              )
          )
      )
 )
BEGIN
    SELECT RAISE(ABORT, 'guest role must be assigned exclusively');
END;

CREATE TRIGGER invitation_guest_role_exclusive_insert
BEFORE INSERT ON invitation_role_assignments
WHEN EXISTS (
    SELECT 1
    FROM group_settings settings
    WHERE settings.group_id = NEW.group_id
      AND settings.guest_role_id IS NOT NULL
      AND (
          (
              NEW.role_id = settings.guest_role_id
              AND EXISTS (
                  SELECT 1
                  FROM invitation_role_assignments assignment
                  WHERE assignment.group_id = NEW.group_id
                    AND assignment.invitation_id = NEW.invitation_id
              )
          )
          OR (
              NEW.role_id != settings.guest_role_id
              AND EXISTS (
                  SELECT 1
                  FROM invitation_role_assignments assignment
                  WHERE assignment.group_id = NEW.group_id
                    AND assignment.invitation_id = NEW.invitation_id
                    AND assignment.role_id = settings.guest_role_id
              )
          )
      )
)
BEGIN
    SELECT RAISE(ABORT, 'guest role must be assigned exclusively');
END;

CREATE TRIGGER invitation_guest_role_exclusive_update
BEFORE UPDATE OF role_id ON invitation_role_assignments
WHEN NEW.role_id != OLD.role_id
 AND EXISTS (
    SELECT 1
    FROM group_settings settings
    WHERE settings.group_id = NEW.group_id
      AND settings.guest_role_id IS NOT NULL
      AND (
          (
              NEW.role_id = settings.guest_role_id
              AND EXISTS (
                  SELECT 1
                  FROM invitation_role_assignments assignment
                  WHERE assignment.group_id = NEW.group_id
                    AND assignment.invitation_id = NEW.invitation_id
                    AND assignment.role_id != OLD.role_id
              )
          )
          OR (
              NEW.role_id != settings.guest_role_id
              AND EXISTS (
                  SELECT 1
                  FROM invitation_role_assignments assignment
                  WHERE assignment.group_id = NEW.group_id
                    AND assignment.invitation_id = NEW.invitation_id
                    AND assignment.role_id = settings.guest_role_id
                    AND assignment.role_id != OLD.role_id
              )
          )
      )
 )
BEGIN
    SELECT RAISE(ABORT, 'guest role must be assigned exclusively');
END;

CREATE TRIGGER users_credentials_require_membership_roles
BEFORE UPDATE OF email, password_hash ON users
WHEN OLD.email IS NULL
 AND OLD.password_hash IS NULL
 AND NEW.email IS NOT NULL
 AND NEW.password_hash IS NOT NULL
 AND EXISTS (
    SELECT 1
    FROM memberships membership
    WHERE membership.user_id = OLD.id
      AND membership.status = 'ACTIVE'
      AND NOT EXISTS (
          SELECT 1
          FROM membership_role_assignments assignment
          WHERE assignment.group_id = membership.group_id
            AND assignment.membership_id = membership.id
      )
 )
BEGIN
    SELECT RAISE(ABORT, 'credentialed active memberships must have at least one role');
END;

CREATE TRIGGER users_credentials_required_by_sessions
BEFORE UPDATE OF email, password_hash ON users
WHEN NEW.email IS NULL
 AND NEW.password_hash IS NULL
 AND EXISTS (
    SELECT 1 FROM sessions WHERE user_id = OLD.id
 )
BEGIN
    SELECT RAISE(ABORT, 'users with sessions must retain credentials');
END;

CREATE TRIGGER sessions_require_credentials
BEFORE INSERT ON sessions
WHEN NOT EXISTS (
    SELECT 1
    FROM users
    WHERE id = NEW.user_id
      AND active = 1
      AND email IS NOT NULL
      AND password_hash IS NOT NULL
)
BEGIN
    SELECT RAISE(ABORT, 'sessions require an active credentialed user');
END;

CREATE TRIGGER invitation_claim_target_insert
BEFORE INSERT ON invitations
WHEN NEW.target_membership_id IS NOT NULL
 AND NOT EXISTS (
    SELECT 1
    FROM memberships membership
    JOIN users user ON user.id = membership.user_id
    WHERE membership.id = NEW.target_membership_id
      AND membership.group_id = NEW.group_id
      AND membership.status = 'ACTIVE'
      AND user.email IS NULL
      AND user.password_hash IS NULL
 )
BEGIN
    SELECT RAISE(ABORT, 'claim target must be an active managed membership in the invitation group');
END;

CREATE TRIGGER invitation_claim_target_update
BEFORE UPDATE OF target_membership_id ON invitations
WHEN OLD.target_membership_id IS NULL
 AND NEW.target_membership_id IS NOT NULL
 AND NOT EXISTS (
    SELECT 1
    FROM memberships membership
    JOIN users user ON user.id = membership.user_id
    WHERE membership.id = NEW.target_membership_id
      AND membership.group_id = NEW.group_id
      AND membership.status = 'ACTIVE'
      AND user.email IS NULL
      AND user.password_hash IS NULL
 )
BEGIN
    SELECT RAISE(ABORT, 'claim target must be an active managed membership in the invitation group');
END;

CREATE TRIGGER invitation_claim_target_immutable
BEFORE UPDATE OF group_id, target_membership_id ON invitations
WHEN NEW.group_id != OLD.group_id
  OR (
      OLD.target_membership_id IS NOT NULL
      AND NEW.target_membership_id IS NOT OLD.target_membership_id
  )
BEGIN
    SELECT RAISE(ABORT, 'invitation group and claim target are immutable');
END;
