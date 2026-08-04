ALTER TABLE groups ADD COLUMN logo_key TEXT
    CHECK (
        logo_key IS NULL OR (
            length(logo_key) = 68
            AND substr(logo_key, 65, 4) = '.png'
            AND substr(logo_key, 1, 64) NOT GLOB '*[^0-9a-f]*'
        )
    );
