ALTER TABLE group_settings
    ADD COLUMN notification_emails_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (notification_emails_enabled IN (0, 1));

ALTER TABLE notifications
    ADD COLUMN context_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(context_json));

CREATE TABLE notification_email_outbox (
    notification_id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'FAILED')),
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
    CHECK (status NOT IN ('SENT', 'FAILED') OR next_attempt_at IS NULL),
    CHECK (status != 'SENT' OR sent_at IS NOT NULL),
    CHECK (status = 'SENT' OR sent_at IS NULL),
    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
    FOREIGN KEY (notification_id) REFERENCES notifications(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX notification_email_outbox_pending_idx
    ON notification_email_outbox(next_attempt_at, created_at)
    WHERE status = 'PENDING';

CREATE INDEX notification_email_outbox_lease_idx
    ON notification_email_outbox(lease_until)
    WHERE status = 'SENDING';

CREATE INDEX notification_email_outbox_group_idx
    ON notification_email_outbox(group_id, created_at DESC);

CREATE INDEX notifications_member_order_idx
    ON notifications(group_id, membership_id, created_at DESC, id DESC);
