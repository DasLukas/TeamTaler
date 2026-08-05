ALTER TABLE categories
ADD COLUMN icon TEXT NOT NULL DEFAULT 'other'
CHECK (icon IN ('other', 'drink', 'food', 'penalty', 'sport', 'event', 'transport', 'money'));

UPDATE categories
SET icon = CASE
    WHEN lower(name) LIKE '%getränk%' OR lower(name) LIKE '%drink%' OR lower(name) LIKE '%beverage%' THEN 'drink'
    WHEN lower(name) LIKE '%straf%' OR lower(name) LIKE '%penalty%' OR lower(name) LIKE '%fine%' THEN 'penalty'
    ELSE 'other'
END;
