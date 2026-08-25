ALTER TABLE users
ADD COLUMN color_mode TEXT NOT NULL DEFAULT 'SYSTEM'
CHECK (color_mode IN ('SYSTEM', 'LIGHT', 'DARK'));

ALTER TABLE group_settings
ADD COLUMN default_theme TEXT NOT NULL DEFAULT 'TEAMTALER'
CHECK (default_theme IN ('TEAMTALER', 'NRW', 'TIEF_IM_WESTEN', 'FIRE'));

ALTER TABLE memberships
ADD COLUMN theme_override TEXT
CHECK (theme_override IS NULL OR theme_override IN ('TEAMTALER', 'NRW', 'TIEF_IM_WESTEN', 'FIRE'));
