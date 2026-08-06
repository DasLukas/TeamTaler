CREATE TABLE group_settings (
    group_id TEXT PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
    members_can_view_all_bookings INTEGER NOT NULL DEFAULT 0 CHECK (members_can_view_all_bookings IN (0, 1)),
    updated_at TEXT NOT NULL
) STRICT;

INSERT INTO group_settings(group_id, members_can_view_all_bookings, updated_at)
SELECT id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM groups;
