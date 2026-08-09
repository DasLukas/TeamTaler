CREATE TABLE permission_definitions (
    key TEXT PRIMARY KEY
        CHECK (
            length(key) BETWEEN 3 AND 64
            AND key NOT GLOB '*[^A-Z0-9_]*'
        ),
    description TEXT NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 500),
    implied_permissions_json TEXT NOT NULL DEFAULT '[]'
        CHECK (
            json_valid(implied_permissions_json)
            AND json_type(implied_permissions_json) = 'array'
        ),
    display_order INTEGER NOT NULL UNIQUE CHECK (display_order >= 0),
    created_at TEXT NOT NULL
) STRICT;

INSERT INTO permission_definitions(key, description, implied_permissions_json, display_order, created_at)
VALUES
    ('GROUP_ADMINISTRATION', 'Manage the group, settings, memberships, invitations, audit access, and protected administrator assignments.', '[]', 10, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    ('ROLE_MANAGEMENT', 'Manage roles, permission grants, and unprotected role assignments.', '[]', 20, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    ('FINANCE_MANAGEMENT', 'Manage payments, payment reversals, accounts, and accounting periods.', '[]', 30, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    ('CATALOG_MANAGEMENT', 'Manage categories, products, sorting, and product images.', '[]', 40, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    ('VIEW_ALL_BOOKING_ACTIVITY', 'View identified booking activity for every member in the group activity feed.', '[]', 50, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    ('RECORD_OWN_PAYMENT', 'Record a payment for the current membership through the self-service endpoint.', '[]', 60, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    ('VOID_OWN_BOOKING', 'Void bookings where the current membership is either actor or target.', '[]', 70, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    ('VOID_ANY_BOOKING', 'Void every booking in the group.', '["VOID_OWN_BOOKING","VIEW_ALL_BOOKING_ACTIVITY"]', 80, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    ('BOOK_FOR_OTHERS', 'Create a booking that targets another active membership.', '[]', 90, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

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
    ),
    CHECK (preset_key != 'MEMBER' OR deletable = 0)
) STRICT;

CREATE UNIQUE INDEX roles_group_name_idx ON roles(group_id, name COLLATE NOCASE);
CREATE INDEX roles_group_order_idx ON roles(group_id, preset_key, lower(name), id);

CREATE TABLE role_permission_grants (
    group_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    permission_key TEXT NOT NULL REFERENCES permission_definitions(key) ON DELETE RESTRICT,
    scope_type TEXT NOT NULL CHECK (scope_type IN ('GROUP', 'CATEGORY', 'PRODUCT')),
    category_id TEXT,
    product_id TEXT,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    created_by TEXT,
    updated_by TEXT,
    FOREIGN KEY (group_id, role_id) REFERENCES roles(group_id, id) ON DELETE CASCADE,
    FOREIGN KEY (group_id, category_id) REFERENCES categories(group_id, id) ON DELETE CASCADE,
    FOREIGN KEY (group_id, product_id) REFERENCES products(group_id, id) ON DELETE CASCADE,
    CHECK (
        (scope_type = 'GROUP' AND category_id IS NULL AND product_id IS NULL)
        OR (scope_type = 'CATEGORY' AND category_id IS NOT NULL AND product_id IS NULL)
        OR (scope_type = 'PRODUCT' AND category_id IS NULL AND product_id IS NOT NULL)
    )
) STRICT;

CREATE UNIQUE INDEX role_permission_grants_identity_idx ON role_permission_grants(
    role_id,
    permission_key,
    scope_type,
    ifnull(category_id, ''),
    ifnull(product_id, '')
);
CREATE INDEX role_permission_grants_role_idx ON role_permission_grants(group_id, role_id, permission_key);
CREATE INDEX role_permission_grants_category_idx ON role_permission_grants(group_id, category_id, permission_key)
    WHERE category_id IS NOT NULL;
CREATE INDEX role_permission_grants_product_idx ON role_permission_grants(group_id, product_id, permission_key)
    WHERE product_id IS NOT NULL;

ALTER TABLE memberships
    ADD COLUMN role_assignments_version INTEGER NOT NULL DEFAULT 1 CHECK (role_assignments_version >= 1);

ALTER TABLE invitations
    ADD COLUMN role_assignments_version INTEGER NOT NULL DEFAULT 1 CHECK (role_assignments_version >= 1);

CREATE TABLE membership_role_assignments (
    group_id TEXT NOT NULL,
    membership_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    assigned_at TEXT NOT NULL,
    assigned_by TEXT,
    PRIMARY KEY (membership_id, role_id),
    FOREIGN KEY (group_id, membership_id) REFERENCES memberships(group_id, id) ON DELETE CASCADE,
    FOREIGN KEY (group_id, role_id) REFERENCES roles(group_id, id) ON DELETE CASCADE
) STRICT;
CREATE INDEX membership_role_assignments_group_role_idx
    ON membership_role_assignments(group_id, role_id, membership_id);

CREATE TABLE invitation_role_assignments (
    group_id TEXT NOT NULL,
    invitation_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    assigned_at TEXT NOT NULL,
    assigned_by TEXT,
    PRIMARY KEY (invitation_id, role_id),
    FOREIGN KEY (group_id, invitation_id) REFERENCES invitations(group_id, id) ON DELETE CASCADE,
    FOREIGN KEY (group_id, role_id) REFERENCES roles(group_id, id) ON DELETE CASCADE
) STRICT;
CREATE INDEX invitation_role_assignments_group_role_idx
    ON invitation_role_assignments(group_id, role_id, invitation_id);

INSERT INTO roles(
    id, group_id, preset_key, name, description, name_locked, deletable,
    version, created_at, updated_at
)
SELECT
    'role:GROUP_ADMINISTRATOR:' || id,
    id,
    'GROUP_ADMINISTRATOR',
    'Group administrator',
    'Required administrator role with full group access.',
    1,
    0,
    1,
    created_at,
    updated_at
FROM groups;

INSERT INTO roles(
    id, group_id, preset_key, name, description, name_locked, deletable,
    version, created_at, updated_at
)
SELECT
    'role:MEMBER:' || id,
    id,
    'MEMBER',
    'Member',
    'Required base role assigned to every active membership.',
    0,
    0,
    1,
    created_at,
    updated_at
FROM groups;

INSERT INTO roles(
    id, group_id, preset_key, name, description, name_locked, deletable,
    version, created_at, updated_at
)
SELECT
    'role:FINANCE_MANAGER:' || id,
    id,
    'FINANCE_MANAGER',
    'Finance manager',
    'Seeded role for financial management.',
    0,
    1,
    1,
    created_at,
    updated_at
FROM groups;

INSERT INTO roles(
    id, group_id, preset_key, name, description, name_locked, deletable,
    version, created_at, updated_at
)
SELECT
    'role:CATALOG_MANAGER:' || id,
    id,
    'CATALOG_MANAGER',
    'Catalog manager',
    'Seeded role for catalog management.',
    0,
    1,
    1,
    created_at,
    updated_at
FROM groups;

INSERT INTO role_permission_grants(
    group_id, role_id, permission_key, scope_type, version, created_at, updated_at
)
SELECT
    g.id,
    'role:GROUP_ADMINISTRATOR:' || g.id,
    p.key,
    'GROUP',
    1,
    g.created_at,
    g.updated_at
FROM groups g
CROSS JOIN permission_definitions p;

INSERT INTO role_permission_grants(
    group_id, role_id, permission_key, scope_type, version, created_at, updated_at
)
SELECT id, 'role:MEMBER:' || id, 'VOID_OWN_BOOKING', 'GROUP', 1, created_at, updated_at
FROM groups;

INSERT INTO role_permission_grants(
    group_id, role_id, permission_key, scope_type, version, created_at, updated_at
)
SELECT g.id, 'role:FINANCE_MANAGER:' || g.id, p.permission_key, 'GROUP', 1, g.created_at, g.updated_at
FROM groups g
CROSS JOIN (
    SELECT 'FINANCE_MANAGEMENT' AS permission_key
    UNION ALL SELECT 'VIEW_ALL_BOOKING_ACTIVITY'
    UNION ALL SELECT 'RECORD_OWN_PAYMENT'
) p;

INSERT INTO role_permission_grants(
    group_id, role_id, permission_key, scope_type, version, created_at, updated_at
)
SELECT id, 'role:CATALOG_MANAGER:' || id, 'CATALOG_MANAGEMENT', 'GROUP', 1, created_at, updated_at
FROM groups;

INSERT INTO membership_role_assignments(
    group_id, membership_id, role_id, version, assigned_at, assigned_by
)
SELECT
    m.group_id,
    m.id,
    'role:MEMBER:' || m.group_id,
    1,
    m.joined_at,
    NULL
FROM memberships m
WHERE m.status = 'ACTIVE';

INSERT OR IGNORE INTO membership_role_assignments(
    group_id, membership_id, role_id, version, assigned_at, assigned_by
)
SELECT
    mr.group_id,
    mr.membership_id,
    'role:' || CASE mr.role
        WHEN 'ADMIN' THEN 'GROUP_ADMINISTRATOR'
        ELSE mr.role
    END || ':' || mr.group_id,
    1,
    mr.granted_at,
    mr.granted_by
FROM membership_roles mr
JOIN memberships m ON m.group_id = mr.group_id AND m.id = mr.membership_id
WHERE m.status = 'ACTIVE';

INSERT OR IGNORE INTO membership_role_assignments(
    group_id, membership_id, role_id, version, assigned_at, assigned_by
)
SELECT
    m.group_id,
    m.id,
    'role:GROUP_ADMINISTRATOR:' || m.group_id,
    1,
    m.joined_at,
    NULL
FROM memberships m
WHERE m.status = 'ACTIVE'
  AND m.id = (
      SELECT first_member.id
      FROM memberships first_member
      WHERE first_member.group_id = m.group_id AND first_member.status = 'ACTIVE'
      ORDER BY first_member.joined_at, first_member.id
      LIMIT 1
  )
  AND NOT EXISTS (
      SELECT 1
      FROM membership_role_assignments existing
      JOIN roles existing_role
        ON existing_role.group_id = existing.group_id AND existing_role.id = existing.role_id
      JOIN memberships existing_member
        ON existing_member.group_id = existing.group_id AND existing_member.id = existing.membership_id
      WHERE existing.group_id = m.group_id
        AND existing_role.preset_key = 'GROUP_ADMINISTRATOR'
        AND existing_member.status = 'ACTIVE'
  );

INSERT INTO invitation_role_assignments(
    group_id, invitation_id, role_id, version, assigned_at, assigned_by
)
SELECT
    i.group_id,
    i.id,
    'role:MEMBER:' || i.group_id,
    1,
    i.created_at,
    i.created_by
FROM invitations i
WHERE i.accepted_at IS NULL
  AND i.revoked_at IS NULL
  AND julianday(i.expires_at) > julianday('now');

INSERT OR IGNORE INTO invitation_role_assignments(
    group_id, invitation_id, role_id, version, assigned_at, assigned_by
)
SELECT
    i.group_id,
    i.id,
    'role:' || CASE legacy_role.value
        WHEN 'ADMIN' THEN 'GROUP_ADMINISTRATOR'
        ELSE legacy_role.value
    END || ':' || i.group_id,
    1,
    i.created_at,
    i.created_by
FROM invitations i
JOIN json_each(i.roles_json) legacy_role
WHERE i.accepted_at IS NULL
  AND i.revoked_at IS NULL
  AND julianday(i.expires_at) > julianday('now')
  AND legacy_role.value IN ('ADMIN', 'FINANCE_MANAGER', 'CATALOG_MANAGER');

INSERT INTO role_permission_grants(
    group_id, role_id, permission_key, scope_type, version, created_at, updated_at
)
SELECT
    s.group_id,
    'role:MEMBER:' || s.group_id,
    'VIEW_ALL_BOOKING_ACTIVITY',
    'GROUP',
    1,
    s.updated_at,
    s.updated_at
FROM group_settings s
WHERE s.members_can_view_all_bookings = 1;

INSERT INTO roles(
    id, group_id, preset_key, name, description, name_locked, deletable,
    version, created_at, updated_at
)
SELECT
    'role:LEGACY_SELF_PAYMENT:' || affected.group_id,
    affected.group_id,
    NULL,
    'Self-payment access (migrated)',
    'Migrated from direct self-service payment permissions.',
    0,
    1,
    1,
    min(affected.created_at),
    min(affected.created_at)
FROM (
    SELECT mp.group_id, min(mp.granted_at) AS created_at
    FROM membership_permissions mp
    JOIN memberships m ON m.group_id = mp.group_id AND m.id = mp.membership_id
    WHERE mp.permission = 'SELF_RECORD_PAYMENT' AND m.status = 'ACTIVE'
    GROUP BY mp.group_id
    UNION
    SELECT i.group_id, min(i.created_at) AS created_at
    FROM invitations i
    JOIN json_each(i.group_permissions_json) legacy_permission
    WHERE i.accepted_at IS NULL
      AND i.revoked_at IS NULL
      AND julianday(i.expires_at) > julianday('now')
      AND legacy_permission.value = 'SELF_RECORD_PAYMENT'
    GROUP BY i.group_id
) affected
GROUP BY affected.group_id;

INSERT INTO role_permission_grants(
    group_id, role_id, permission_key, scope_type, version, created_at, updated_at
)
SELECT
    r.group_id,
    r.id,
    'RECORD_OWN_PAYMENT',
    'GROUP',
    1,
    r.created_at,
    r.updated_at
FROM roles r
WHERE r.id = 'role:LEGACY_SELF_PAYMENT:' || r.group_id;

INSERT OR IGNORE INTO membership_role_assignments(
    group_id, membership_id, role_id, version, assigned_at, assigned_by
)
SELECT
    mp.group_id,
    mp.membership_id,
    'role:LEGACY_SELF_PAYMENT:' || mp.group_id,
    1,
    mp.granted_at,
    mp.granted_by
FROM membership_permissions mp
JOIN memberships m ON m.group_id = mp.group_id AND m.id = mp.membership_id
WHERE mp.permission = 'SELF_RECORD_PAYMENT' AND m.status = 'ACTIVE';

INSERT OR IGNORE INTO invitation_role_assignments(
    group_id, invitation_id, role_id, version, assigned_at, assigned_by
)
SELECT
    i.group_id,
    i.id,
    'role:LEGACY_SELF_PAYMENT:' || i.group_id,
    1,
    i.created_at,
    i.created_by
FROM invitations i
JOIN json_each(i.group_permissions_json) legacy_permission
WHERE i.accepted_at IS NULL
  AND i.revoked_at IS NULL
  AND julianday(i.expires_at) > julianday('now')
  AND legacy_permission.value = 'SELF_RECORD_PAYMENT';

DELETE FROM category_permissions;
UPDATE invitations
SET category_grants_json = '{}'
WHERE category_grants_json != '{}';

CREATE TRIGGER roles_preset_identity_immutable
BEFORE UPDATE OF group_id, preset_key ON roles
WHEN NEW.group_id != OLD.group_id OR NEW.preset_key IS NOT OLD.preset_key
BEGIN
    SELECT RAISE(ABORT, 'role group and preset identity are immutable');
END;

CREATE TRIGGER roles_protected_delete
BEFORE DELETE ON roles
WHEN OLD.preset_key IN ('GROUP_ADMINISTRATOR', 'MEMBER')
BEGIN
    SELECT RAISE(ABORT, 'protected role cannot be deleted');
END;

CREATE TRIGGER roles_assigned_delete
BEFORE DELETE ON roles
WHEN coalesce(OLD.preset_key, '') NOT IN ('GROUP_ADMINISTRATOR', 'MEMBER')
AND (
EXISTS (
    SELECT 1
    FROM membership_role_assignments a
    JOIN memberships m ON m.group_id = a.group_id AND m.id = a.membership_id
    WHERE a.group_id = OLD.group_id AND a.role_id = OLD.id AND m.status = 'ACTIVE'
)
OR EXISTS (
    SELECT 1
    FROM invitation_role_assignments a
    JOIN invitations i ON i.group_id = a.group_id AND i.id = a.invitation_id
    WHERE a.group_id = OLD.group_id
      AND a.role_id = OLD.id
      AND i.accepted_at IS NULL
      AND i.revoked_at IS NULL
      AND julianday(i.expires_at) > julianday('now')
)
)
BEGIN
    SELECT RAISE(ABORT, 'assigned role cannot be deleted');
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
    UPDATE roles
    SET version = version + 1,
        updated_at = NEW.updated_at,
        updated_by = NEW.updated_by
    WHERE id = NEW.role_id AND group_id = NEW.group_id;
END;

CREATE TRIGGER role_permission_grants_increment_role_update
AFTER UPDATE ON role_permission_grants
BEGIN
    UPDATE roles
    SET version = version + 1,
        updated_at = NEW.updated_at,
        updated_by = NEW.updated_by
    WHERE id = NEW.role_id AND group_id = NEW.group_id;
END;

CREATE TRIGGER role_permission_grants_increment_role_delete
AFTER DELETE ON role_permission_grants
BEGIN
    UPDATE roles
    SET version = version + 1,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = OLD.role_id AND group_id = OLD.group_id;
END;

CREATE TRIGGER membership_role_assignments_active_insert
BEFORE INSERT ON membership_role_assignments
WHEN NOT EXISTS (
    SELECT 1 FROM memberships
    WHERE id = NEW.membership_id AND group_id = NEW.group_id AND status = 'ACTIVE'
)
BEGIN
    SELECT RAISE(ABORT, 'roles can only be assigned to active memberships');
END;

CREATE TRIGGER membership_role_assignments_identity_immutable
BEFORE UPDATE OF group_id, membership_id, role_id ON membership_role_assignments
WHEN NEW.group_id != OLD.group_id
  OR NEW.membership_id != OLD.membership_id
  OR NEW.role_id != OLD.role_id
BEGIN
    SELECT RAISE(ABORT, 'role assignment identity is immutable');
END;

CREATE TRIGGER membership_role_assignments_required_member_delete
BEFORE DELETE ON membership_role_assignments
WHEN EXISTS (
    SELECT 1
    FROM roles r
    JOIN memberships m ON m.group_id = OLD.group_id AND m.id = OLD.membership_id
    WHERE r.group_id = OLD.group_id
      AND r.id = OLD.role_id
      AND r.preset_key = 'MEMBER'
      AND m.status = 'ACTIVE'
)
BEGIN
    SELECT RAISE(ABORT, 'active memberships must retain the member role');
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

CREATE TRIGGER memberships_last_admin_archive
BEFORE UPDATE OF status ON memberships
WHEN OLD.status = 'ACTIVE'
 AND NEW.status = 'ARCHIVED'
 AND EXISTS (
     SELECT 1
     FROM membership_role_assignments a
     JOIN roles r ON r.group_id = a.group_id AND r.id = a.role_id
     WHERE a.group_id = OLD.group_id
       AND a.membership_id = OLD.id
       AND r.preset_key = 'GROUP_ADMINISTRATOR'
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

CREATE TRIGGER memberships_remove_roles_on_archive
AFTER UPDATE OF status ON memberships
WHEN OLD.status = 'ACTIVE' AND NEW.status = 'ARCHIVED'
BEGIN
    DELETE FROM membership_role_assignments
    WHERE group_id = NEW.group_id AND membership_id = NEW.id;
END;

CREATE TRIGGER membership_role_assignments_increment_target_insert
AFTER INSERT ON membership_role_assignments
BEGIN
    UPDATE memberships
    SET role_assignments_version = role_assignments_version + 1
    WHERE id = NEW.membership_id AND group_id = NEW.group_id;
END;

CREATE TRIGGER membership_role_assignments_increment_target_update
AFTER UPDATE ON membership_role_assignments
BEGIN
    UPDATE memberships
    SET role_assignments_version = role_assignments_version + 1
    WHERE id = NEW.membership_id AND group_id = NEW.group_id;
END;

CREATE TRIGGER membership_role_assignments_increment_target_delete
AFTER DELETE ON membership_role_assignments
BEGIN
    UPDATE memberships
    SET role_assignments_version = role_assignments_version + 1
    WHERE id = OLD.membership_id AND group_id = OLD.group_id;
END;

CREATE TRIGGER invitation_role_assignments_pending_insert
BEFORE INSERT ON invitation_role_assignments
WHEN NOT EXISTS (
    SELECT 1 FROM invitations
    WHERE id = NEW.invitation_id
      AND group_id = NEW.group_id
      AND accepted_at IS NULL
      AND revoked_at IS NULL
      AND julianday(expires_at) > julianday('now')
)
BEGIN
    SELECT RAISE(ABORT, 'roles can only be assigned to pending invitations');
END;

CREATE TRIGGER invitation_role_assignments_identity_immutable
BEFORE UPDATE OF group_id, invitation_id, role_id ON invitation_role_assignments
WHEN NEW.group_id != OLD.group_id
  OR NEW.invitation_id != OLD.invitation_id
  OR NEW.role_id != OLD.role_id
BEGIN
    SELECT RAISE(ABORT, 'role assignment identity is immutable');
END;

CREATE TRIGGER invitation_role_assignments_required_member_delete
BEFORE DELETE ON invitation_role_assignments
WHEN EXISTS (
    SELECT 1
    FROM roles r
    JOIN invitations i ON i.group_id = OLD.group_id AND i.id = OLD.invitation_id
    WHERE r.group_id = OLD.group_id
      AND r.id = OLD.role_id
      AND r.preset_key = 'MEMBER'
      AND i.accepted_at IS NULL
      AND i.revoked_at IS NULL
      AND julianday(i.expires_at) > julianday('now')
)
BEGIN
    SELECT RAISE(ABORT, 'pending invitations must retain the member role');
END;

CREATE TRIGGER invitations_remove_roles_after_close
AFTER UPDATE OF accepted_at, revoked_at ON invitations
WHEN (OLD.accepted_at IS NULL AND NEW.accepted_at IS NOT NULL)
  OR (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL)
BEGIN
    DELETE FROM invitation_role_assignments
    WHERE group_id = NEW.group_id AND invitation_id = NEW.id;
END;

CREATE TRIGGER invitation_role_assignments_increment_target_insert
AFTER INSERT ON invitation_role_assignments
BEGIN
    UPDATE invitations
    SET role_assignments_version = role_assignments_version + 1
    WHERE id = NEW.invitation_id AND group_id = NEW.group_id;
END;

CREATE TRIGGER invitation_role_assignments_increment_target_update
AFTER UPDATE ON invitation_role_assignments
BEGIN
    UPDATE invitations
    SET role_assignments_version = role_assignments_version + 1
    WHERE id = NEW.invitation_id AND group_id = NEW.group_id;
END;

CREATE TRIGGER invitation_role_assignments_increment_target_delete
AFTER DELETE ON invitation_role_assignments
BEGIN
    UPDATE invitations
    SET role_assignments_version = role_assignments_version + 1
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
        ('role:MEMBER:' || NEW.id, NEW.id, 'MEMBER', 'Member', 'Required base role assigned to every active membership.', 0, 0, 1, NEW.created_at, NEW.updated_at),
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
        (NEW.id, 'role:MEMBER:' || NEW.id, 'VOID_OWN_BOOKING', 'GROUP', 1, NEW.created_at, NEW.updated_at),
        (NEW.id, 'role:FINANCE_MANAGER:' || NEW.id, 'FINANCE_MANAGEMENT', 'GROUP', 1, NEW.created_at, NEW.updated_at),
        (NEW.id, 'role:FINANCE_MANAGER:' || NEW.id, 'VIEW_ALL_BOOKING_ACTIVITY', 'GROUP', 1, NEW.created_at, NEW.updated_at),
        (NEW.id, 'role:FINANCE_MANAGER:' || NEW.id, 'RECORD_OWN_PAYMENT', 'GROUP', 1, NEW.created_at, NEW.updated_at),
        (NEW.id, 'role:CATALOG_MANAGER:' || NEW.id, 'CATALOG_MANAGEMENT', 'GROUP', 1, NEW.created_at, NEW.updated_at);

    UPDATE roles SET version = 1 WHERE group_id = NEW.id;
END;

CREATE TRIGGER memberships_assign_member_role_after_insert
AFTER INSERT ON memberships
WHEN NEW.status = 'ACTIVE'
BEGIN
    INSERT INTO membership_role_assignments(
        group_id, membership_id, role_id, version, assigned_at, assigned_by
    ) VALUES (
        NEW.group_id,
        NEW.id,
        'role:MEMBER:' || NEW.group_id,
        1,
        NEW.joined_at,
        NULL
    );
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

CREATE TRIGGER memberships_assign_member_role_after_reactivation
AFTER UPDATE OF status ON memberships
WHEN OLD.status = 'ARCHIVED' AND NEW.status = 'ACTIVE'
BEGIN
    INSERT OR IGNORE INTO membership_role_assignments(
        group_id, membership_id, role_id, version, assigned_at, assigned_by
    ) VALUES (
        NEW.group_id,
        NEW.id,
        'role:MEMBER:' || NEW.group_id,
        1,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        NULL
    );

    INSERT OR IGNORE INTO membership_role_assignments(
        group_id, membership_id, role_id, version, assigned_at, assigned_by
    )
    SELECT
        NEW.group_id,
        NEW.id,
        'role:GROUP_ADMINISTRATOR:' || NEW.group_id,
        1,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        NULL
    WHERE NOT EXISTS (
        SELECT 1
        FROM membership_role_assignments a
        JOIN roles r ON r.group_id = a.group_id AND r.id = a.role_id
        JOIN memberships m ON m.group_id = a.group_id AND m.id = a.membership_id
        WHERE a.group_id = NEW.group_id
          AND r.preset_key = 'GROUP_ADMINISTRATOR'
          AND m.status = 'ACTIVE'
    );
END;

CREATE TRIGGER membership_roles_copy_legacy_insert
AFTER INSERT ON membership_roles
BEGIN
    INSERT OR IGNORE INTO membership_role_assignments(
        group_id, membership_id, role_id, version, assigned_at, assigned_by
    )
    SELECT
        NEW.group_id,
        NEW.membership_id,
        'role:' || CASE NEW.role
            WHEN 'ADMIN' THEN 'GROUP_ADMINISTRATOR'
            ELSE NEW.role
        END || ':' || NEW.group_id,
        1,
        NEW.granted_at,
        NEW.granted_by
    FROM memberships
    WHERE id = NEW.membership_id AND group_id = NEW.group_id AND status = 'ACTIVE';
END;

CREATE TRIGGER invitations_assign_member_role_after_insert
AFTER INSERT ON invitations
WHEN NEW.accepted_at IS NULL
 AND NEW.revoked_at IS NULL
 AND julianday(NEW.expires_at) > julianday('now')
BEGIN
    INSERT INTO invitation_role_assignments(
        group_id, invitation_id, role_id, version, assigned_at, assigned_by
    ) VALUES (
        NEW.group_id,
        NEW.id,
        'role:MEMBER:' || NEW.group_id,
        1,
        NEW.created_at,
        NEW.created_by
    );
END;
