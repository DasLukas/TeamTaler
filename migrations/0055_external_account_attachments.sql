CREATE TABLE IF NOT EXISTS external_account_transaction_attachments (
    transaction_id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    storage_key TEXT NOT NULL CHECK (
        length(storage_key) = 68
        AND substr(storage_key, 1, 64) NOT GLOB '*[^0-9a-f]*'
        AND substr(storage_key, 65, 4) IN ('.jpg', '.png', '.pdf')
    ),
    original_filename TEXT NOT NULL CHECK (length(trim(original_filename)) BETWEEN 1 AND 240),
    media_type TEXT NOT NULL CHECK (media_type IN ('image/jpeg', 'image/png', 'application/pdf')),
    size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 52428800),
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
    created_by_membership_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (group_id,transaction_id),
    CHECK (sha256 = substr(storage_key, 1, 64)),
    FOREIGN KEY (group_id,transaction_id) REFERENCES external_account_transactions(group_id,id) ON DELETE RESTRICT,
    FOREIGN KEY (group_id,created_by_membership_id) REFERENCES memberships(group_id,id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS external_account_transaction_attachments_group_idx
ON external_account_transaction_attachments(group_id,created_at DESC,transaction_id);

CREATE INDEX IF NOT EXISTS external_account_transaction_attachments_storage_idx
ON external_account_transaction_attachments(storage_key);

CREATE TRIGGER IF NOT EXISTS external_account_transaction_attachments_no_update
BEFORE UPDATE ON external_account_transaction_attachments
BEGIN
    SELECT RAISE(ABORT,'external account transaction attachments are immutable');
END;

CREATE TRIGGER IF NOT EXISTS external_account_transaction_attachments_no_delete
BEFORE DELETE ON external_account_transaction_attachments
WHEN NOT EXISTS (
    SELECT 1 FROM system_group_purge_context context
    WHERE context.group_id=OLD.group_id
)
BEGIN
    SELECT RAISE(ABORT,'external account transaction attachments are immutable');
END;
