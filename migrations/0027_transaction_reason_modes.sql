ALTER TABLE group_settings
ADD COLUMN own_booking_reason_mode TEXT NOT NULL DEFAULT 'OFF'
CHECK (own_booking_reason_mode IN ('OFF', 'OPTIONAL', 'REQUIRED'));

ALTER TABLE group_settings
ADD COLUMN foreign_booking_reason_mode TEXT NOT NULL DEFAULT 'REQUIRED'
CHECK (foreign_booking_reason_mode IN ('OFF', 'OPTIONAL', 'REQUIRED'));

ALTER TABLE group_settings
ADD COLUMN own_payment_reason_mode TEXT NOT NULL DEFAULT 'REQUIRED'
CHECK (own_payment_reason_mode IN ('OFF', 'OPTIONAL', 'REQUIRED'));

ALTER TABLE group_settings
ADD COLUMN other_payment_reason_mode TEXT NOT NULL DEFAULT 'OPTIONAL'
CHECK (other_payment_reason_mode IN ('OFF', 'OPTIONAL', 'REQUIRED'));

UPDATE group_settings
SET foreign_booking_reason_mode = CASE foreign_booking_reason_required WHEN 1 THEN 'REQUIRED' ELSE 'OPTIONAL' END,
    own_payment_reason_mode = CASE own_payment_reason_required WHEN 1 THEN 'REQUIRED' ELSE 'OPTIONAL' END,
    other_payment_reason_mode = CASE other_payment_reason_required WHEN 1 THEN 'REQUIRED' ELSE 'OPTIONAL' END;
