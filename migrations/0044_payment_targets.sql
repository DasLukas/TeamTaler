-- Payment methods may expose one normalized external payment instruction to
-- active group members. NONE remains the storage-only representation of a
-- nullable public paymentTarget.

DROP TRIGGER IF EXISTS group_settings_seed_payment_methods;

CREATE TABLE group_payment_methods_0044 (
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    label TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 120),
    sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
    created_at TEXT NOT NULL,
    attachment_mode TEXT NOT NULL DEFAULT 'OFF'
        CHECK (attachment_mode IN ('OFF', 'OPTIONAL', 'REQUIRED')),
    payment_target_type TEXT NOT NULL DEFAULT 'NONE'
        CHECK (payment_target_type IN ('NONE', 'PAYPAL_ME', 'SEPA_TRANSFER')),
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
    PRIMARY KEY (group_id, id),
    UNIQUE (group_id, sort_order),
    CHECK (
        (
            payment_target_type = 'NONE'
            AND paypal_me_handle IS NULL
            AND sepa_recipient_name IS NULL
            AND sepa_iban IS NULL
            AND sepa_bic IS NULL
        ) OR (
            payment_target_type = 'PAYPAL_ME'
            AND paypal_me_handle IS NOT NULL
            AND sepa_recipient_name IS NULL
            AND sepa_iban IS NULL
            AND sepa_bic IS NULL
        ) OR (
            payment_target_type = 'SEPA_TRANSFER'
            AND paypal_me_handle IS NULL
            AND sepa_recipient_name IS NOT NULL
            AND sepa_iban IS NOT NULL
        )
    )
) STRICT;

INSERT INTO group_payment_methods_0044(
    group_id,id,label,sort_order,created_at,attachment_mode
)
SELECT group_id,id,label,sort_order,created_at,attachment_mode
FROM group_payment_methods;

DROP TABLE group_payment_methods;
ALTER TABLE group_payment_methods_0044 RENAME TO group_payment_methods;

CREATE UNIQUE INDEX group_payment_methods_label_idx
ON group_payment_methods(group_id, lower(label));

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
