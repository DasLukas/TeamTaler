CREATE TABLE membership_permissions (
    group_id TEXT NOT NULL,
    membership_id TEXT NOT NULL,
    permission TEXT NOT NULL CHECK (permission IN ('SELF_RECORD_PAYMENT')),
    granted_at TEXT NOT NULL,
    granted_by TEXT,
    PRIMARY KEY (membership_id, permission),
    FOREIGN KEY (group_id, membership_id) REFERENCES memberships(group_id, id) ON DELETE CASCADE
) STRICT;
CREATE INDEX membership_permissions_group_idx ON membership_permissions(group_id, permission);

ALTER TABLE invitations
ADD COLUMN group_permissions_json TEXT NOT NULL DEFAULT '[]'
CHECK (json_valid(group_permissions_json) AND json_type(group_permissions_json) = 'array');
