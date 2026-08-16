ALTER TABLE groups ADD COLUMN archived_from_status TEXT
    CHECK (archived_from_status IS NULL OR archived_from_status IN ('PROVISIONING', 'ACTIVE'));

CREATE TRIGGER groups_archived_source_consistent_after_insert
AFTER INSERT ON groups
WHEN (NEW.status IN ('ARCHIVED', 'PURGING')) != (NEW.archived_from_status IS NOT NULL)
BEGIN
    SELECT RAISE(ABORT, 'group archived source must match lifecycle status');
END;

CREATE TRIGGER groups_archived_source_consistent_after_update
AFTER UPDATE OF status, archived_from_status ON groups
WHEN (NEW.status IN ('ARCHIVED', 'PURGING')) != (NEW.archived_from_status IS NOT NULL)
BEGIN
    SELECT RAISE(ABORT, 'group archived source must match lifecycle status');
END;

CREATE TABLE system_step_up_challenges (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose TEXT NOT NULL CHECK (purpose = 'GROUP_PURGE'),
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL
) STRICT;

CREATE INDEX system_step_up_challenges_user_expiry_idx
    ON system_step_up_challenges(user_id, expires_at);

CREATE TABLE system_media_delete_jobs (
    image_key TEXT PRIMARY KEY CHECK (image_key GLOB '[0-9a-f]*.png' AND length(image_key) = 68),
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'DONE')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at TEXT NOT NULL,
    last_error_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX system_media_delete_jobs_due_idx
    ON system_media_delete_jobs(status, next_attempt_at);

CREATE TABLE system_wal_checkpoint_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    pending INTEGER NOT NULL DEFAULT 0 CHECK (pending IN (0, 1)),
    last_error_code TEXT,
    updated_at TEXT NOT NULL
) STRICT;

INSERT INTO system_wal_checkpoint_state(singleton, pending, updated_at)
VALUES (1, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- This row exists only for the duration of the purge transaction. Every
-- delete guard below remains installed and opens only for this exact group.
CREATE TABLE system_group_purge_context (
    group_id TEXT PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
    actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    started_at TEXT NOT NULL
) STRICT;

DROP TRIGGER IF EXISTS audit_events_no_delete;
CREATE TRIGGER audit_events_no_delete
BEFORE DELETE ON audit_events
WHEN NOT EXISTS (
    SELECT 1 FROM system_group_purge_context context
    WHERE context.group_id = OLD.group_id
)
BEGIN
    SELECT RAISE(ABORT, 'audit events are immutable');
END;

DROP TRIGGER IF EXISTS ledger_entries_no_delete;
CREATE TRIGGER ledger_entries_no_delete
BEFORE DELETE ON ledger_entries
WHEN NOT EXISTS (
    SELECT 1 FROM system_group_purge_context context
    WHERE context.group_id = OLD.group_id
)
BEGIN
    SELECT RAISE(ABORT, 'ledger entries are immutable');
END;

DROP TRIGGER IF EXISTS period_statements_no_delete;
CREATE TRIGGER period_statements_no_delete
BEFORE DELETE ON period_statements
WHEN NOT EXISTS (
    SELECT 1 FROM system_group_purge_context context
    WHERE context.group_id = OLD.group_id
)
BEGIN
    SELECT RAISE(ABORT, 'period statements are immutable');
END;

DROP TRIGGER IF EXISTS roles_protected_delete;
CREATE TRIGGER roles_protected_delete
BEFORE DELETE ON roles
WHEN NOT EXISTS (
    SELECT 1 FROM system_group_purge_context context
    WHERE context.group_id = OLD.group_id
)
AND OLD.preset_key = 'GROUP_ADMINISTRATOR'
BEGIN
    SELECT RAISE(ABORT, 'protected role cannot be deleted');
END;

DROP TRIGGER IF EXISTS role_permission_grants_admin_core_delete;
CREATE TRIGGER role_permission_grants_admin_core_delete
BEFORE DELETE ON role_permission_grants
WHEN NOT EXISTS (
    SELECT 1 FROM system_group_purge_context context
    WHERE context.group_id = OLD.group_id
)
AND OLD.permission_key IN ('GROUP_ADMINISTRATION', 'MEMBER_MANAGEMENT', 'ROLE_MANAGEMENT')
AND EXISTS (
    SELECT 1 FROM roles
    WHERE id = OLD.role_id
      AND group_id = OLD.group_id
      AND preset_key = 'GROUP_ADMINISTRATOR'
)
BEGIN
    SELECT RAISE(ABORT, 'administrator core permissions cannot be removed');
END;

DROP TRIGGER IF EXISTS membership_role_assignments_minimum_delete;
CREATE TRIGGER membership_role_assignments_minimum_delete
BEFORE DELETE ON membership_role_assignments
WHEN NOT EXISTS (
    SELECT 1 FROM system_group_purge_context context
    WHERE context.group_id = OLD.group_id
)
AND EXISTS (
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

DROP TRIGGER IF EXISTS membership_role_assignments_last_admin_delete;
CREATE TRIGGER membership_role_assignments_last_admin_delete
BEFORE DELETE ON membership_role_assignments
WHEN NOT EXISTS (
    SELECT 1 FROM system_group_purge_context context
    WHERE context.group_id = OLD.group_id
)
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

DROP TRIGGER IF EXISTS system_audit_events_no_delete;
CREATE TRIGGER system_audit_events_no_delete
BEFORE DELETE ON system_audit_events
WHEN NOT EXISTS (
    SELECT 1 FROM system_group_purge_context context
    WHERE context.group_id = OLD.resource_id
)
BEGIN
    SELECT RAISE(ABORT, 'system audit events are immutable');
END;
