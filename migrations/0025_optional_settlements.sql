ALTER TABLE group_settings
ADD COLUMN settlements_enabled INTEGER NOT NULL DEFAULT 0
CHECK (settlements_enabled IN (0, 1));
