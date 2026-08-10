CREATE TABLE account_security_actions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('PASSWORD_RESET', 'EMAIL_CHANGE')),
    source_email TEXT NOT NULL COLLATE NOCASE,
    target_email TEXT COLLATE NOCASE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    invalidated_at TEXT,
    created_at TEXT NOT NULL,
    CHECK (
        (kind = 'PASSWORD_RESET' AND target_email IS NULL)
        OR (kind = 'EMAIL_CHANGE' AND target_email IS NOT NULL)
    ),
    CHECK (consumed_at IS NULL OR invalidated_at IS NULL)
) STRICT;

CREATE UNIQUE INDEX account_security_actions_open_kind_idx
    ON account_security_actions(user_id, kind)
    WHERE consumed_at IS NULL AND invalidated_at IS NULL;

CREATE UNIQUE INDEX account_security_actions_open_email_target_idx
    ON account_security_actions(target_email COLLATE NOCASE)
    WHERE kind = 'EMAIL_CHANGE'
      AND consumed_at IS NULL
      AND invalidated_at IS NULL;

CREATE INDEX account_security_actions_expiry_idx
    ON account_security_actions(expires_at)
    WHERE consumed_at IS NULL AND invalidated_at IS NULL;

CREATE TABLE account_security_email_outbox (
    action_id TEXT PRIMARY KEY REFERENCES account_security_actions(id) ON DELETE CASCADE,
    token_ciphertext TEXT,
    status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'FAILED', 'CANCELLED')),
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
    CHECK (status = 'SENT' OR sent_at IS NULL)
) STRICT;

CREATE INDEX account_security_email_outbox_pending_idx
    ON account_security_email_outbox(next_attempt_at, created_at)
    WHERE status = 'PENDING';

CREATE INDEX account_security_email_outbox_lease_idx
    ON account_security_email_outbox(lease_until)
    WHERE status = 'SENDING';
