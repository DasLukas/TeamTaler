CREATE TABLE payment_allocations_0013_backup AS
SELECT group_id, payment_id, period_id, amount_minor
FROM payment_allocations;

CREATE TABLE ledger_entries_0013_backup AS
SELECT id, group_id, period_id, membership_id, category_id, booking_id, payment_id,
       reversal_of, account, amount_minor, description, created_at
FROM ledger_entries;

DROP TRIGGER IF EXISTS ledger_entries_no_update;
DROP TRIGGER IF EXISTS ledger_entries_no_delete;

DELETE FROM ledger_entries WHERE reversal_of IS NOT NULL;
DELETE FROM ledger_entries;
DROP TABLE payment_allocations;
DROP TABLE ledger_entries;

CREATE TABLE payments_0013 (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    membership_id TEXT NOT NULL,
    amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
    received_at TEXT NOT NULL,
    method TEXT NOT NULL CHECK (method IN ('CASH', 'BANK_TRANSFER', 'PAYPAL', 'OTHER')),
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

INSERT INTO payments_0013(
    id, group_id, membership_id, amount_minor, received_at, method, reference, note,
    created_by, created_at, reversed_at, reversed_by, reversal_reason
)
SELECT id, group_id, membership_id, amount_minor, received_at, method, reference, note,
       created_by, created_at, reversed_at, reversed_by, reversal_reason
FROM payments;

DROP TABLE payments;
ALTER TABLE payments_0013 RENAME TO payments;
CREATE INDEX payments_member_idx ON payments(group_id, membership_id, received_at DESC);

CREATE TABLE payment_allocations (
    group_id TEXT NOT NULL,
    payment_id TEXT NOT NULL,
    period_id TEXT NOT NULL,
    amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
    PRIMARY KEY (payment_id, period_id),
    FOREIGN KEY (group_id, payment_id) REFERENCES payments(group_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (group_id, period_id) REFERENCES periods(group_id, id) ON DELETE RESTRICT
) STRICT;

INSERT INTO payment_allocations(group_id, payment_id, period_id, amount_minor)
SELECT group_id, payment_id, period_id, amount_minor
FROM payment_allocations_0013_backup;

CREATE TABLE ledger_entries (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE RESTRICT,
    period_id TEXT,
    membership_id TEXT,
    category_id TEXT,
    booking_id TEXT,
    payment_id TEXT,
    reversal_of TEXT,
    account TEXT NOT NULL CHECK (account IN ('MEMBER_RECEIVABLE', 'CATEGORY_REVENUE', 'GROUP_CASH')),
    amount_minor INTEGER NOT NULL CHECK (amount_minor <> 0),
    description TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (group_id, id),
    FOREIGN KEY (group_id, period_id) REFERENCES periods(group_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (group_id, membership_id) REFERENCES memberships(group_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (group_id, category_id) REFERENCES categories(group_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (group_id, booking_id) REFERENCES bookings(group_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (group_id, payment_id) REFERENCES payments(group_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (group_id, reversal_of) REFERENCES ledger_entries(group_id, id) ON DELETE RESTRICT
) STRICT;

INSERT INTO ledger_entries(
    id, group_id, period_id, membership_id, category_id, booking_id, payment_id,
    reversal_of, account, amount_minor, description, created_at
)
SELECT id, group_id, period_id, membership_id, category_id, booking_id, payment_id,
       reversal_of, account, amount_minor, description, created_at
FROM ledger_entries_0013_backup
WHERE reversal_of IS NULL;

INSERT INTO ledger_entries(
    id, group_id, period_id, membership_id, category_id, booking_id, payment_id,
    reversal_of, account, amount_minor, description, created_at
)
SELECT id, group_id, period_id, membership_id, category_id, booking_id, payment_id,
       reversal_of, account, amount_minor, description, created_at
FROM ledger_entries_0013_backup
WHERE reversal_of IS NOT NULL;

CREATE INDEX ledger_group_member_idx ON ledger_entries(group_id, membership_id, created_at);
CREATE INDEX ledger_booking_idx ON ledger_entries(booking_id);
CREATE INDEX ledger_payment_idx ON ledger_entries(payment_id);
CREATE UNIQUE INDEX ledger_one_reversal_idx ON ledger_entries(reversal_of) WHERE reversal_of IS NOT NULL;

CREATE TRIGGER ledger_entries_no_update
BEFORE UPDATE ON ledger_entries BEGIN SELECT RAISE(ABORT, 'ledger entries are immutable'); END;
CREATE TRIGGER ledger_entries_no_delete
BEFORE DELETE ON ledger_entries BEGIN SELECT RAISE(ABORT, 'ledger entries are immutable'); END;

DROP TABLE payment_allocations_0013_backup;
DROP TABLE ledger_entries_0013_backup;
