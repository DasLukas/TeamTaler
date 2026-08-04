ALTER TABLE products ADD COLUMN migrated_price_minor INTEGER;

UPDATE products SET migrated_price_minor = price_minor;

ALTER TABLE products DROP COLUMN price_minor;

ALTER TABLE products RENAME COLUMN migrated_price_minor TO price_minor;

ALTER TABLE products ADD COLUMN pricing_mode TEXT NOT NULL DEFAULT 'FIXED'
    CHECK (
        pricing_mode IN ('FIXED', 'USER_DEFINED')
        AND (
            (pricing_mode = 'FIXED' AND price_minor IS NOT NULL AND price_minor BETWEEN 1 AND 100000000000)
            OR (pricing_mode = 'USER_DEFINED' AND price_minor IS NULL)
        )
    );
