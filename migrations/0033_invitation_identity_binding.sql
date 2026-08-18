ALTER TABLE invitations
    ADD COLUMN target_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT;

CREATE INDEX invitations_target_user_idx
    ON invitations(target_user_id);
