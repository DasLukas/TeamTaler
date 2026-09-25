CREATE TABLE kiosk_posters (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
    text TEXT NOT NULL DEFAULT '' CHECK (length(text) <= 2000),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (group_id, id)
) STRICT;

CREATE INDEX kiosk_posters_group_idx ON kiosk_posters(group_id, updated_at DESC, id);

-- Product references are intentionally not foreign keys. Product tombstones and
-- archive states must remain visible in saved templates and block PDF creation.
CREATE TABLE kiosk_poster_products (
    group_id TEXT NOT NULL,
    poster_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
    PRIMARY KEY (group_id, poster_id, product_id),
    UNIQUE (group_id, poster_id, sort_order),
    FOREIGN KEY (group_id, poster_id) REFERENCES kiosk_posters(group_id, id) ON DELETE CASCADE
) STRICT;
