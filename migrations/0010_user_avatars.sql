ALTER TABLE users ADD COLUMN avatar_key TEXT
    CHECK (
        avatar_key IS NULL OR (
            length(avatar_key) = 68
            AND substr(avatar_key, 65, 4) = '.png'
            AND substr(avatar_key, 1, 64) NOT GLOB '*[^0-9a-f]*'
        )
    );
