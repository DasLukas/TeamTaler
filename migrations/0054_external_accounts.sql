-- teamtaler:migration foreign-keys-off

ALTER TABLE group_settings
ADD COLUMN external_accounts_enabled INTEGER NOT NULL DEFAULT 0
CHECK (external_accounts_enabled IN (0, 1));

ALTER TABLE group_settings
ADD COLUMN external_accounts_version INTEGER NOT NULL DEFAULT 1
CHECK (external_accounts_version >= 1);

INSERT INTO permission_definitions(key,description,implied_permissions_json,display_order,created_at) VALUES
    ('VIEW_EXTERNAL_ACCOUNTS','View external account balances, payment-method links, and transaction history.','[]',31,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    ('MANAGE_EXTERNAL_ACCOUNTS','Manage external accounts, payment-method links, and manual account transactions.','["VIEW_EXTERNAL_ACCOUNTS"]',32,strftime('%Y-%m-%dT%H:%M:%fZ','now'));

UPDATE permission_definitions
SET implied_permissions_json = '["MANAGE_EXTERNAL_ACCOUNTS"]'
WHERE key = 'FINANCE_MANAGEMENT';

CREATE TABLE external_accounts (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    name TEXT NOT NULL COLLATE NOCASE CHECK (
        name = trim(name)
        AND length(name) BETWEEN 1 AND 120
        AND name NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || ']*')
    ),
    type TEXT NOT NULL CHECK (type IN ('CASH','BANK','PAYPAL','OTHER')),
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ARCHIVED')),
    sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
    paypal_me_handle TEXT CHECK (
        paypal_me_handle IS NULL OR (
            length(paypal_me_handle) BETWEEN 1 AND 20
            AND paypal_me_handle NOT GLOB '*[^A-Za-z0-9]*'
        )
    ),
    sepa_recipient_name TEXT CHECK (
        sepa_recipient_name IS NULL
        OR length(trim(sepa_recipient_name)) BETWEEN 1 AND 70
    ),
    sepa_iban TEXT CHECK (
        sepa_iban IS NULL OR (
            length(sepa_iban) BETWEEN 15 AND 34
            AND sepa_iban NOT GLOB '*[^A-Z0-9]*'
        )
    ),
    sepa_bic TEXT CHECK (
        sepa_bic IS NULL OR (
            length(sepa_bic) IN (8, 11)
            AND sepa_bic NOT GLOB '*[^A-Z0-9]*'
        )
    ),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    created_by_membership_id TEXT,
    updated_by_membership_id TEXT,
    UNIQUE (group_id,id),
    UNIQUE (group_id,sort_order),
    FOREIGN KEY (group_id,created_by_membership_id) REFERENCES memberships(group_id,id) ON DELETE RESTRICT,
    FOREIGN KEY (group_id,updated_by_membership_id) REFERENCES memberships(group_id,id) ON DELETE RESTRICT,
    CHECK (
        (type = 'BANK' AND paypal_me_handle IS NULL AND sepa_recipient_name IS NOT NULL AND sepa_iban IS NOT NULL)
        OR (type = 'PAYPAL' AND paypal_me_handle IS NOT NULL AND sepa_recipient_name IS NULL AND sepa_iban IS NULL AND sepa_bic IS NULL)
        OR (type IN ('CASH','OTHER') AND paypal_me_handle IS NULL AND sepa_recipient_name IS NULL AND sepa_iban IS NULL AND sepa_bic IS NULL)
    )
) STRICT;

CREATE UNIQUE INDEX external_accounts_group_name_idx
ON external_accounts(group_id,name COLLATE NOCASE);

CREATE UNIQUE INDEX external_accounts_group_paypal_idx
ON external_accounts(group_id,lower(paypal_me_handle))
WHERE paypal_me_handle IS NOT NULL;

CREATE UNIQUE INDEX external_accounts_group_bank_target_idx
ON external_accounts(group_id,sepa_iban,sepa_recipient_name,coalesce(sepa_bic,''))
WHERE sepa_iban IS NOT NULL;

CREATE INDEX external_accounts_group_status_order_idx
ON external_accounts(group_id,status,sort_order,id);

INSERT INTO external_accounts(
    id,group_id,name,type,status,sort_order,paypal_me_handle,sepa_recipient_name,sepa_iban,sepa_bic,
    version,created_at,updated_at
)
SELECT
    'ext:migrated:' || method.group_id || ':' || method.id,
    method.group_id,
    method.label,
    CASE method.payment_target_type WHEN 'PAYPAL_ME' THEN 'PAYPAL' ELSE 'BANK' END,
    'ACTIVE',
    method.sort_order,
    method.paypal_me_handle,
    method.sepa_recipient_name,
    method.sepa_iban,
    method.sepa_bic,
    1,
    method.created_at,
    strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM group_payment_methods method
WHERE method.payment_target_type IN ('PAYPAL_ME','SEPA_TRANSFER')
  AND NOT EXISTS (
      SELECT 1
      FROM group_payment_methods earlier
      WHERE earlier.group_id = method.group_id
        AND earlier.payment_target_type = method.payment_target_type
        AND (
            (method.payment_target_type = 'PAYPAL_ME' AND lower(earlier.paypal_me_handle) = lower(method.paypal_me_handle))
            OR (method.payment_target_type = 'SEPA_TRANSFER'
                AND earlier.sepa_iban = method.sepa_iban
                AND earlier.sepa_recipient_name = method.sepa_recipient_name
                AND coalesce(earlier.sepa_bic,'') = coalesce(method.sepa_bic,''))
        )
        AND (earlier.sort_order < method.sort_order OR (earlier.sort_order = method.sort_order AND earlier.id < method.id))
  );

DROP TRIGGER IF EXISTS group_settings_seed_payment_methods;

CREATE TABLE group_payment_methods_0054 (
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    label TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 120),
    sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
    created_at TEXT NOT NULL,
    attachment_mode TEXT NOT NULL DEFAULT 'OFF'
        CHECK (attachment_mode IN ('OFF','OPTIONAL','REQUIRED')),
    external_account_id TEXT,
    PRIMARY KEY (group_id,id),
    UNIQUE (group_id,sort_order),
    FOREIGN KEY (group_id,external_account_id) REFERENCES external_accounts(group_id,id) ON DELETE RESTRICT
) STRICT;

INSERT INTO group_payment_methods_0054(group_id,id,label,sort_order,created_at,attachment_mode,external_account_id)
SELECT
    method.group_id,
    method.id,
    method.label,
    method.sort_order,
    method.created_at,
    method.attachment_mode,
    CASE
        WHEN method.payment_target_type = 'PAYPAL_ME' THEN (
            SELECT account.id FROM external_accounts account
            WHERE account.group_id = method.group_id
              AND account.type = 'PAYPAL'
              AND lower(account.paypal_me_handle) = lower(method.paypal_me_handle)
        )
        WHEN method.payment_target_type = 'SEPA_TRANSFER' THEN (
            SELECT account.id FROM external_accounts account
            WHERE account.group_id = method.group_id
              AND account.type = 'BANK'
              AND account.sepa_iban = method.sepa_iban
              AND account.sepa_recipient_name = method.sepa_recipient_name
              AND coalesce(account.sepa_bic,'') = coalesce(method.sepa_bic,'')
        )
        ELSE NULL
    END
FROM group_payment_methods method;

DROP TABLE group_payment_methods;
ALTER TABLE group_payment_methods_0054 RENAME TO group_payment_methods;

CREATE UNIQUE INDEX group_payment_methods_label_idx
ON group_payment_methods(group_id,lower(label));

CREATE INDEX group_payment_methods_external_account_idx
ON group_payment_methods(group_id,external_account_id)
WHERE external_account_id IS NOT NULL;

CREATE TRIGGER group_settings_seed_payment_methods
AFTER INSERT ON group_settings
BEGIN
    INSERT INTO group_payment_methods(group_id,id,label,sort_order,created_at,attachment_mode) VALUES
        (NEW.group_id,'BANK_TRANSFER','Bank transfer',0,NEW.updated_at,'OFF'),
        (NEW.group_id,'SHOPPING','Shopping',1,NEW.updated_at,'REQUIRED'),
        (NEW.group_id,'CASH','Cash',2,NEW.updated_at,'OFF'),
        (NEW.group_id,'PAYPAL','PayPal',3,NEW.updated_at,'OFF'),
        (NEW.group_id,'OTHER','Other',4,NEW.updated_at,'OPTIONAL');
END;

CREATE TABLE external_account_transactions (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE RESTRICT,
    kind TEXT NOT NULL CHECK (kind IN ('PAYMENT','OPENING_BALANCE','INCOME','EXPENSE','TRANSFER','ADJUSTMENT','REVERSAL')),
    primary_account_id TEXT NOT NULL,
    counterparty_account_id TEXT,
    payment_id TEXT,
    amount_minor INTEGER NOT NULL CHECK (amount_minor <> 0),
    booked_at TEXT NOT NULL,
    reason TEXT,
    reference TEXT,
    note TEXT,
    reversal_of TEXT,
    correction_of TEXT,
    created_by_membership_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (group_id,id),
    FOREIGN KEY (group_id,primary_account_id) REFERENCES external_accounts(group_id,id) ON DELETE RESTRICT,
    FOREIGN KEY (group_id,counterparty_account_id) REFERENCES external_accounts(group_id,id) ON DELETE RESTRICT,
    FOREIGN KEY (group_id,payment_id) REFERENCES payments(group_id,id) ON DELETE RESTRICT,
    FOREIGN KEY (group_id,reversal_of) REFERENCES external_account_transactions(group_id,id) ON DELETE RESTRICT,
    FOREIGN KEY (group_id,correction_of) REFERENCES external_account_transactions(group_id,id) ON DELETE RESTRICT,
    FOREIGN KEY (group_id,created_by_membership_id) REFERENCES memberships(group_id,id) ON DELETE RESTRICT,
    CHECK (counterparty_account_id IS NULL OR counterparty_account_id <> primary_account_id),
    CHECK (kind IN ('TRANSFER','REVERSAL') OR counterparty_account_id IS NULL),
    CHECK (kind != 'TRANSFER' OR counterparty_account_id IS NOT NULL),
    CHECK (kind IN ('PAYMENT','REVERSAL') OR payment_id IS NULL),
    CHECK (kind != 'PAYMENT' OR payment_id IS NOT NULL),
    CHECK ((kind = 'REVERSAL') = (reversal_of IS NOT NULL)),
    CHECK (kind NOT IN ('PAYMENT','REVERSAL') OR correction_of IS NULL)
) STRICT;

CREATE UNIQUE INDEX external_account_transactions_one_reversal_idx
ON external_account_transactions(reversal_of)
WHERE reversal_of IS NOT NULL;

CREATE UNIQUE INDEX external_account_transactions_one_correction_idx
ON external_account_transactions(correction_of)
WHERE correction_of IS NOT NULL;

CREATE INDEX external_account_transactions_group_booked_idx
ON external_account_transactions(group_id,booked_at DESC,id DESC);

CREATE INDEX external_account_transactions_primary_booked_idx
ON external_account_transactions(group_id,primary_account_id,booked_at DESC,id DESC);

CREATE INDEX external_account_transactions_counterparty_booked_idx
ON external_account_transactions(group_id,counterparty_account_id,booked_at DESC,id DESC)
WHERE counterparty_account_id IS NOT NULL;

CREATE UNIQUE INDEX external_account_transactions_payment_idx
ON external_account_transactions(group_id,payment_id,kind)
WHERE payment_id IS NOT NULL;

DROP TRIGGER IF EXISTS ledger_entries_no_update;
DROP TRIGGER IF EXISTS ledger_entries_no_delete;

ALTER TABLE ledger_entries RENAME TO ledger_entries_0054;

CREATE TABLE ledger_entries (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE RESTRICT,
    period_id TEXT,
    membership_id TEXT,
    category_id TEXT,
    booking_id TEXT,
    payment_id TEXT,
    external_account_id TEXT,
    external_transaction_id TEXT,
    reversal_of TEXT,
    account TEXT NOT NULL CHECK (account IN ('MEMBER_RECEIVABLE','CATEGORY_REVENUE','GROUP_CASH','EXTERNAL_ACCOUNT','EXTERNAL_OFFSET')),
    amount_minor INTEGER NOT NULL CHECK (amount_minor <> 0),
    description TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (group_id,id),
    FOREIGN KEY (group_id,period_id) REFERENCES periods(group_id,id) ON DELETE RESTRICT,
    FOREIGN KEY (group_id,membership_id) REFERENCES memberships(group_id,id) ON DELETE RESTRICT,
    FOREIGN KEY (group_id,category_id) REFERENCES categories(group_id,id) ON DELETE RESTRICT,
    FOREIGN KEY (group_id,booking_id) REFERENCES bookings(group_id,id) ON DELETE RESTRICT,
    FOREIGN KEY (group_id,payment_id) REFERENCES payments(group_id,id) ON DELETE RESTRICT,
    FOREIGN KEY (group_id,external_account_id) REFERENCES external_accounts(group_id,id) ON DELETE RESTRICT,
    FOREIGN KEY (group_id,external_transaction_id) REFERENCES external_account_transactions(group_id,id) ON DELETE RESTRICT,
    FOREIGN KEY (group_id,reversal_of) REFERENCES ledger_entries(group_id,id) ON DELETE RESTRICT,
    CHECK (
        (account = 'EXTERNAL_ACCOUNT' AND external_account_id IS NOT NULL AND external_transaction_id IS NOT NULL)
        OR (account = 'EXTERNAL_OFFSET' AND external_account_id IS NULL AND external_transaction_id IS NOT NULL)
        OR (account IN ('MEMBER_RECEIVABLE','CATEGORY_REVENUE','GROUP_CASH') AND external_account_id IS NULL)
    )
) STRICT;

INSERT INTO ledger_entries(
    id,group_id,period_id,membership_id,category_id,booking_id,payment_id,reversal_of,
    account,amount_minor,description,created_at
)
SELECT id,group_id,period_id,membership_id,category_id,booking_id,payment_id,reversal_of,
       account,amount_minor,description,created_at
FROM ledger_entries_0054
WHERE reversal_of IS NULL;

INSERT INTO ledger_entries(
    id,group_id,period_id,membership_id,category_id,booking_id,payment_id,reversal_of,
    account,amount_minor,description,created_at
)
SELECT id,group_id,period_id,membership_id,category_id,booking_id,payment_id,reversal_of,
       account,amount_minor,description,created_at
FROM ledger_entries_0054
WHERE reversal_of IS NOT NULL;

DROP TABLE ledger_entries_0054;

CREATE INDEX ledger_group_member_idx ON ledger_entries(group_id,membership_id,created_at);
CREATE INDEX ledger_booking_idx ON ledger_entries(booking_id);
CREATE INDEX ledger_payment_idx ON ledger_entries(payment_id);
CREATE UNIQUE INDEX ledger_one_reversal_idx ON ledger_entries(reversal_of) WHERE reversal_of IS NOT NULL;
CREATE INDEX ledger_member_movements_page_idx
    ON ledger_entries(group_id,membership_id,account,strftime('%Y-%m-%dT%H:%M:%fZ',created_at) DESC,id DESC);
CREATE INDEX ledger_statistics_group_account_created_idx
    ON ledger_entries(group_id,account,created_at);
CREATE INDEX ledger_external_account_created_idx
    ON ledger_entries(group_id,external_account_id,created_at DESC,id DESC)
    WHERE external_account_id IS NOT NULL;
CREATE INDEX ledger_external_transaction_idx
    ON ledger_entries(group_id,external_transaction_id)
    WHERE external_transaction_id IS NOT NULL;

CREATE TRIGGER ledger_entries_no_update
BEFORE UPDATE ON ledger_entries
BEGIN
    SELECT RAISE(ABORT,'ledger entries are immutable');
END;

CREATE TRIGGER ledger_entries_no_delete
BEFORE DELETE ON ledger_entries
WHEN NOT EXISTS (
    SELECT 1 FROM system_group_purge_context context
    WHERE context.group_id = OLD.group_id
)
BEGIN
    SELECT RAISE(ABORT,'ledger entries are immutable');
END;

CREATE TRIGGER external_accounts_identity_immutable
BEFORE UPDATE OF group_id ON external_accounts
WHEN NEW.group_id != OLD.group_id
BEGIN
    SELECT RAISE(ABORT,'external account group identity is immutable');
END;

CREATE TRIGGER external_accounts_used_type_immutable
BEFORE UPDATE OF type ON external_accounts
WHEN NEW.type != OLD.type AND EXISTS (
    SELECT 1 FROM ledger_entries entry
    WHERE entry.group_id = OLD.group_id AND entry.external_account_id = OLD.id
)
BEGIN
    SELECT RAISE(ABORT,'a used external account type is immutable');
END;

CREATE TRIGGER external_account_transactions_no_update
BEFORE UPDATE ON external_account_transactions
BEGIN
    SELECT RAISE(ABORT,'external account transactions are immutable');
END;

CREATE TRIGGER external_account_transactions_no_delete
BEFORE DELETE ON external_account_transactions
WHEN NOT EXISTS (
    SELECT 1 FROM system_group_purge_context context
    WHERE context.group_id = OLD.group_id
)
BEGIN
    SELECT RAISE(ABORT,'external account transactions are immutable');
END;
