ALTER TABLE kiosk_posters ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1));

CREATE UNIQUE INDEX kiosk_posters_one_default_per_group
    ON kiosk_posters(group_id) WHERE is_default = 1;

-- Preserve older empty custom templates until an administrator adds products
-- or deletes them. Release the reserved name without losing template text.
UPDATE kiosk_posters
SET name = 'Standard (previous)', version = version + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE lower(trim(name)) = 'standard';

INSERT INTO kiosk_posters(id, group_id, name, text, version, created_at, updated_at, is_default)
SELECT 'kpost_default_' || lower(hex(randomblob(16))), id, 'Standard', '', 1,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 1
FROM groups;

CREATE TRIGGER kiosk_standard_poster_for_new_group
AFTER INSERT ON groups
BEGIN
    INSERT INTO kiosk_posters(id, group_id, name, text, version, created_at, updated_at, is_default)
    VALUES('kpost_default_' || lower(hex(randomblob(16))), NEW.id, 'Standard', '', 1,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 1);
END;
