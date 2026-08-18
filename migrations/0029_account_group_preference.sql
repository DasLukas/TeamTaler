ALTER TABLE users
ADD COLUMN default_group_id TEXT REFERENCES groups(id) ON DELETE SET NULL;

ALTER TABLE users
ADD COLUMN last_used_group_id TEXT REFERENCES groups(id) ON DELETE SET NULL;

CREATE INDEX users_default_group_idx ON users(default_group_id) WHERE default_group_id IS NOT NULL;
CREATE INDEX users_last_used_group_idx ON users(last_used_group_id) WHERE last_used_group_id IS NOT NULL;
