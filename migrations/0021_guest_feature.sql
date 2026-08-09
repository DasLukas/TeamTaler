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
    ),
    (
        'BOOK_FOR_GUESTS',
        'Create bookings for existing or newly created temporary guests.',
        '[]',
        100,
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
    'BOOK_FOR_GUESTS',
    'GROUP',
    1,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    NULL,
    NULL
FROM roles
WHERE roles.preset_key = 'GROUP_ADMINISTRATOR';

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
    ADD COLUMN temporary_guest_name_key TEXT
    CHECK (
        temporary_guest_name_key IS NULL OR (
            temporary_guest_name_key = trim(temporary_guest_name_key)
            AND length(temporary_guest_name_key) BETWEEN 1 AND 120
            AND temporary_guest_name_key NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || ']*')
        )
    );

CREATE UNIQUE INDEX memberships_active_temporary_guest_name_idx
    ON memberships(group_id, temporary_guest_name_key)
    WHERE status = 'ACTIVE' AND temporary_guest_name_key IS NOT NULL;

CREATE TRIGGER memberships_temporary_guest_name_insert
BEFORE INSERT ON memberships
WHEN NEW.temporary_guest_name_key IS NOT NULL
 AND NOT EXISTS (
    SELECT 1
    FROM users
    WHERE id = NEW.user_id
      AND email IS NULL
      AND password_hash IS NULL
 )
BEGIN
    SELECT RAISE(ABORT, 'temporary guest name keys require a credential-less user');
END;

CREATE TRIGGER memberships_temporary_guest_name_update
BEFORE UPDATE OF user_id, temporary_guest_name_key ON memberships
WHEN NEW.temporary_guest_name_key IS NOT NULL
 AND NOT EXISTS (
    SELECT 1
    FROM users
    WHERE id = NEW.user_id
      AND email IS NULL
      AND password_hash IS NULL
 )
BEGIN
    SELECT RAISE(ABORT, 'temporary guest name keys require a credential-less user');
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

CREATE TRIGGER membership_role_assignments_temporary_guest_insert
BEFORE INSERT ON membership_role_assignments
WHEN EXISTS (
    SELECT 1
    FROM memberships membership
    JOIN users user ON user.id = membership.user_id
    WHERE membership.id = NEW.membership_id
      AND membership.group_id = NEW.group_id
      AND membership.status = 'ACTIVE'
      AND user.email IS NULL
      AND user.password_hash IS NULL
)
AND NOT EXISTS (
    SELECT 1
    FROM invitations invitation
    JOIN invitation_role_assignments assignment
      ON assignment.group_id = invitation.group_id
     AND assignment.invitation_id = invitation.id
     AND assignment.role_id = NEW.role_id
    WHERE invitation.group_id = NEW.group_id
      AND invitation.target_membership_id = NEW.membership_id
      AND invitation.accepted_at IS NULL
      AND invitation.revoked_at IS NULL
      AND julianday(invitation.expires_at) > julianday('now')
)
BEGIN
    SELECT RAISE(ABORT, 'temporary guests can receive only roles prepared by an open claim invitation');
END;

CREATE TRIGGER membership_role_assignments_temporary_guest_update
BEFORE UPDATE OF role_id ON membership_role_assignments
WHEN EXISTS (
    SELECT 1
    FROM memberships membership
    JOIN users user ON user.id = membership.user_id
    WHERE membership.id = NEW.membership_id
      AND membership.group_id = NEW.group_id
      AND membership.status = 'ACTIVE'
      AND user.email IS NULL
      AND user.password_hash IS NULL
)
AND NOT EXISTS (
    SELECT 1
    FROM invitations invitation
    JOIN invitation_role_assignments assignment
      ON assignment.group_id = invitation.group_id
     AND assignment.invitation_id = invitation.id
     AND assignment.role_id = NEW.role_id
    WHERE invitation.group_id = NEW.group_id
      AND invitation.target_membership_id = NEW.membership_id
      AND invitation.accepted_at IS NULL
      AND invitation.revoked_at IS NULL
      AND julianday(invitation.expires_at) > julianday('now')
)
BEGIN
    SELECT RAISE(ABORT, 'temporary guests can receive only roles prepared by an open claim invitation');
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

CREATE TRIGGER users_membership_credentials_are_one_way
BEFORE UPDATE OF email, password_hash ON users
WHEN OLD.email IS NOT NULL
 AND OLD.password_hash IS NOT NULL
 AND NEW.email IS NULL
 AND NEW.password_hash IS NULL
 AND EXISTS (
    SELECT 1 FROM memberships WHERE user_id = OLD.id
 )
BEGIN
    SELECT RAISE(ABORT, 'membership credentials cannot be removed');
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
    SELECT RAISE(ABORT, 'claim target must be an active temporary guest in the invitation group');
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
    SELECT RAISE(ABORT, 'claim target must be an active temporary guest in the invitation group');
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
