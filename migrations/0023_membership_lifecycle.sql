ALTER TABLE memberships
    ADD COLUMN deleted_at TEXT
    CHECK (
        deleted_at IS NULL OR (
            status = 'ARCHIVED'
            AND archived_at IS NOT NULL
            AND temporary_guest_name_key IS NULL
        )
    );

CREATE INDEX memberships_group_lifecycle_idx
    ON memberships(group_id, status, deleted_at);

CREATE INDEX memberships_deleted_finance_idx
    ON memberships(group_id, deleted_at)
    WHERE deleted_at IS NOT NULL;

CREATE TRIGGER memberships_deleted_lifecycle_immutable
BEFORE UPDATE OF group_id, user_id, status, archived_at, temporary_guest_name_key, deleted_at ON memberships
WHEN OLD.deleted_at IS NOT NULL
 AND (
    NEW.group_id IS NOT OLD.group_id
    OR NEW.user_id IS NOT OLD.user_id
    OR NEW.status IS NOT OLD.status
    OR NEW.archived_at IS NOT OLD.archived_at
    OR NEW.temporary_guest_name_key IS NOT OLD.temporary_guest_name_key
    OR NEW.deleted_at IS NOT OLD.deleted_at
 )
BEGIN
    SELECT RAISE(ABORT, 'deleted membership lifecycle is immutable');
END;

CREATE TRIGGER membership_role_assignments_deleted_membership_insert
BEFORE INSERT ON membership_role_assignments
WHEN EXISTS (
    SELECT 1
    FROM memberships
    WHERE id = NEW.membership_id
      AND group_id = NEW.group_id
      AND deleted_at IS NOT NULL
)
BEGIN
    SELECT RAISE(ABORT, 'deleted memberships cannot receive roles');
END;

CREATE TRIGGER invitations_deleted_claim_target_insert
BEFORE INSERT ON invitations
WHEN NEW.target_membership_id IS NOT NULL
 AND EXISTS (
    SELECT 1
    FROM memberships
    WHERE id = NEW.target_membership_id
      AND deleted_at IS NOT NULL
 )
BEGIN
    SELECT RAISE(ABORT, 'deleted memberships cannot receive claim invitations');
END;

CREATE TRIGGER invitations_deleted_claim_target_update
BEFORE UPDATE OF target_membership_id ON invitations
WHEN NEW.target_membership_id IS NOT NULL
 AND EXISTS (
    SELECT 1
    FROM memberships
    WHERE id = NEW.target_membership_id
      AND deleted_at IS NOT NULL
 )
BEGIN
    SELECT RAISE(ABORT, 'deleted memberships cannot receive claim invitations');
END;
