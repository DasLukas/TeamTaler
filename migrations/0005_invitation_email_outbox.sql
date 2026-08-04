CREATE UNIQUE INDEX invitations_group_identity_idx ON invitations(group_id, id);

CREATE TABLE invitation_email_outbox (
    invitation_id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    token_ciphertext TEXT,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'FAILED', 'CANCELLED')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 5),
    next_attempt_at TEXT,
    lease_token TEXT,
    lease_until TEXT,
    sent_at TEXT,
    last_error_code TEXT CHECK (
        last_error_code IS NULL OR (
            length(last_error_code) BETWEEN 1 AND 64
            AND last_error_code NOT GLOB '*[^a-z0-9_]*'
        )
    ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK ((lease_token IS NULL) = (lease_until IS NULL)),
    CHECK (status = 'SENDING' OR (lease_token IS NULL AND lease_until IS NULL)),
    CHECK (status != 'SENDING' OR (lease_token IS NOT NULL AND lease_until IS NOT NULL)),
    CHECK (status != 'PENDING' OR next_attempt_at IS NOT NULL),
    CHECK (status NOT IN ('SENT', 'FAILED', 'CANCELLED') OR next_attempt_at IS NULL),
    CHECK (
        (status IN ('PENDING', 'SENDING', 'FAILED') AND token_ciphertext IS NOT NULL AND length(token_ciphertext) > 0)
        OR (status IN ('SENT', 'CANCELLED') AND token_ciphertext IS NULL)
    ),
    CHECK (status != 'SENT' OR sent_at IS NOT NULL),
    CHECK (status = 'SENT' OR sent_at IS NULL),
    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
    FOREIGN KEY (group_id, invitation_id) REFERENCES invitations(group_id, id) ON DELETE CASCADE
) STRICT;

CREATE INDEX invitation_email_outbox_pending_idx
    ON invitation_email_outbox(next_attempt_at, created_at)
    WHERE status = 'PENDING';

CREATE INDEX invitation_email_outbox_lease_idx
    ON invitation_email_outbox(lease_until)
    WHERE status = 'SENDING';

CREATE INDEX invitation_email_outbox_group_idx
    ON invitation_email_outbox(group_id, created_at DESC);
