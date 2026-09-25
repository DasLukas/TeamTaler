ALTER TABLE group_settings
    ADD COLUMN kiosk_enabled INTEGER NOT NULL DEFAULT 0 CHECK (kiosk_enabled IN (0, 1));

INSERT INTO permission_definitions(key, description, implied_permissions_json, display_order, created_at)
VALUES ('USE_KIOSK', 'Use the camera scanner for kiosk and scan-and-go bookings.', '[]', 150, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE product_barcodes (
    group_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    format TEXT NOT NULL CHECK (format IN ('EAN_8', 'EAN_13', 'UPC_A', 'UPC_E', 'CODE_128')),
    value TEXT NOT NULL CHECK (length(value) BETWEEN 1 AND 80),
    normalized_key TEXT NOT NULL CHECK (length(normalized_key) BETWEEN 1 AND 88),
    sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
    PRIMARY KEY (group_id, normalized_key),
    UNIQUE (group_id, product_id, sort_order),
    FOREIGN KEY (group_id, product_id) REFERENCES products(group_id, id) ON DELETE CASCADE
) STRICT;

CREATE INDEX product_barcodes_product_idx ON product_barcodes(group_id, product_id, sort_order);
