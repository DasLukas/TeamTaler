CREATE TABLE public_join_links (
    group_id TEXT PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
    token_hash TEXT UNIQUE,
    token_ciphertext TEXT,
    enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
    expires_at TEXT,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    updated_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
        (enabled = 1 AND token_hash IS NOT NULL AND token_ciphertext IS NOT NULL)
        OR (enabled = 0 AND token_hash IS NULL AND token_ciphertext IS NULL)
    )
) STRICT;

CREATE INDEX public_join_links_status_idx
    ON public_join_links(enabled, expires_at);

CREATE TABLE public_join_registrations (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    join_link_version INTEGER NOT NULL CHECK (join_link_version >= 1),
    email TEXT NOT NULL COLLATE NOCASE,
    display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 120),
    password_hash TEXT NOT NULL,
    verification_token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    invalidated_at TEXT,
    created_at TEXT NOT NULL,
    CHECK (consumed_at IS NULL OR invalidated_at IS NULL)
) STRICT;

CREATE UNIQUE INDEX public_join_registrations_pending_email_idx
    ON public_join_registrations(group_id, email COLLATE NOCASE)
    WHERE consumed_at IS NULL AND invalidated_at IS NULL;

CREATE INDEX public_join_registrations_expiry_idx
    ON public_join_registrations(expires_at)
    WHERE consumed_at IS NULL AND invalidated_at IS NULL;

CREATE UNIQUE INDEX public_join_registrations_group_identity_idx
    ON public_join_registrations(group_id, id);

CREATE TABLE public_join_email_outbox (
    registration_id TEXT PRIMARY KEY REFERENCES public_join_registrations(id) ON DELETE CASCADE,
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
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
    CHECK (status = 'SENT' OR sent_at IS NULL),
    FOREIGN KEY (group_id, registration_id)
        REFERENCES public_join_registrations(group_id, id) ON DELETE CASCADE
) STRICT;

CREATE INDEX public_join_email_outbox_pending_idx
    ON public_join_email_outbox(next_attempt_at, created_at)
    WHERE status = 'PENDING';

CREATE INDEX public_join_email_outbox_lease_idx
    ON public_join_email_outbox(lease_until)
    WHERE status = 'SENDING';

CREATE INDEX public_join_email_outbox_group_idx
    ON public_join_email_outbox(group_id, created_at DESC);
