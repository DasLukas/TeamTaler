CREATE TRIGGER invitations_prevent_active_email_duplicate
BEFORE INSERT ON invitations
WHEN EXISTS (
    SELECT 1
    FROM invitations
    WHERE group_id = NEW.group_id
      AND email = NEW.email COLLATE NOCASE
      AND accepted_at IS NULL
      AND revoked_at IS NULL
      AND julianday(expires_at) > julianday('now')
)
BEGIN
    SELECT RAISE(ABORT, 'teamtaler_active_invitation_email_exists');
END;

CREATE TRIGGER invitations_prevent_active_email_duplicate_update
BEFORE UPDATE OF group_id, email, expires_at, accepted_at, revoked_at ON invitations
WHEN NEW.accepted_at IS NULL
 AND NEW.revoked_at IS NULL
 AND julianday(NEW.expires_at) > julianday('now')
 AND EXISTS (
    SELECT 1
    FROM invitations
    WHERE group_id = NEW.group_id
      AND email = NEW.email COLLATE NOCASE
      AND id <> NEW.id
      AND accepted_at IS NULL
      AND revoked_at IS NULL
      AND julianday(expires_at) > julianday('now')
)
BEGIN
    SELECT RAISE(ABORT, 'teamtaler_active_invitation_email_exists');
END;
