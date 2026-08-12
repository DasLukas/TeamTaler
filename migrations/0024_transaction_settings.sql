-- teamtaler:migration foreign-keys-off

ALTER TABLE group_settings
ADD COLUMN foreign_booking_reason_required INTEGER NOT NULL DEFAULT 1 CHECK (foreign_booking_reason_required IN (0, 1));

ALTER TABLE group_settings
ADD COLUMN own_payment_reason_required INTEGER NOT NULL DEFAULT 1 CHECK (own_payment_reason_required IN (0, 1));

ALTER TABLE group_settings
ADD COLUMN other_payment_reason_required INTEGER NOT NULL DEFAULT 0 CHECK (other_payment_reason_required IN (0, 1));

CREATE TABLE group_payment_methods (
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    label TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 120),
    sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
    created_at TEXT NOT NULL,
    PRIMARY KEY (group_id, id),
    UNIQUE (group_id, sort_order)
) STRICT;

CREATE UNIQUE INDEX group_payment_methods_label_idx
ON group_payment_methods(group_id, lower(label));

CREATE TABLE group_reason_suggestions (
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('BOOKING', 'PAYMENT')),
    label TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 120),
    sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
    created_at TEXT NOT NULL,
    PRIMARY KEY (group_id, id),
    UNIQUE (group_id, kind, sort_order)
) STRICT;

CREATE UNIQUE INDEX group_reason_suggestions_label_idx
ON group_reason_suggestions(group_id, kind, lower(label));

INSERT INTO group_payment_methods(group_id,id,label,sort_order,created_at)
SELECT group_id,'BANK_TRANSFER','Bank transfer',0,updated_at FROM group_settings
UNION ALL
SELECT group_id,'CASH','Cash',1,updated_at FROM group_settings
UNION ALL
SELECT group_id,'PAYPAL','PayPal',2,updated_at FROM group_settings
UNION ALL
SELECT group_id,'OTHER','Other',3,updated_at FROM group_settings;

CREATE TRIGGER group_settings_seed_payment_methods
AFTER INSERT ON group_settings
BEGIN
    INSERT INTO group_payment_methods(group_id,id,label,sort_order,created_at) VALUES
        (NEW.group_id,'BANK_TRANSFER','Bank transfer',0,NEW.updated_at),
        (NEW.group_id,'CASH','Cash',1,NEW.updated_at),
        (NEW.group_id,'PAYPAL','PayPal',2,NEW.updated_at),
        (NEW.group_id,'OTHER','Other',3,NEW.updated_at);
END;

CREATE TABLE payments_0024 (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    membership_id TEXT NOT NULL,
    amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
    received_at TEXT NOT NULL,
    method TEXT NOT NULL CHECK (length(trim(method)) BETWEEN 1 AND 120),
    method_label TEXT CHECK (method_label IS NULL OR length(trim(method_label)) BETWEEN 1 AND 120),
    reference TEXT,
    note TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    reversed_at TEXT,
    reversed_by TEXT,
    reversal_reason TEXT,
    UNIQUE (group_id, id),
    FOREIGN KEY (group_id, membership_id) REFERENCES memberships(group_id, id) ON DELETE RESTRICT
) STRICT;

INSERT INTO payments_0024(
    id,group_id,membership_id,amount_minor,received_at,method,method_label,reference,note,
    created_by,created_at,reversed_at,reversed_by,reversal_reason
)
SELECT id,group_id,membership_id,amount_minor,received_at,method,NULL,reference,note,
       created_by,created_at,reversed_at,reversed_by,reversal_reason
FROM payments;

DROP TABLE payments;
ALTER TABLE payments_0024 RENAME TO payments;
CREATE INDEX payments_member_idx ON payments(group_id, membership_id, received_at DESC);
