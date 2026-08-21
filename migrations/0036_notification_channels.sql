ALTER TABLE system_settings_state
    ADD COLUMN web_push_revision INTEGER NOT NULL DEFAULT 0
    CHECK (web_push_revision >= 0);

ALTER TABLE system_setting_overrides RENAME TO system_setting_overrides_legacy;

CREATE TABLE system_setting_overrides (
    setting_key TEXT PRIMARY KEY CHECK (setting_key IN (
        'instance.name',
        'instance.default_currency',
        'media.upload_max_bytes',
        'access.public_join_enabled',
        'maintenance.enabled',
        'maintenance.message',
        'smtp.enabled',
        'smtp.host',
        'smtp.port',
        'smtp.tls_mode',
        'smtp.username',
        'smtp.from_address',
        'smtp.from_name',
        'smtp.password',
        'web_push.enabled',
        'web_push.subject',
        'web_push.vapid_private_key'
    )),
    value_type TEXT NOT NULL CHECK (value_type IN ('STRING', 'INTEGER', 'BOOLEAN', 'SECRET')),
    value_text TEXT,
    secret_ciphertext TEXT,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    updated_at TEXT NOT NULL,
    updated_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
    CHECK (
        (value_type = 'SECRET' AND value_text IS NULL AND secret_ciphertext IS NOT NULL AND length(secret_ciphertext) > 0)
        OR
        (value_type != 'SECRET' AND value_text IS NOT NULL AND secret_ciphertext IS NULL)
    ),
    CHECK (
        (setting_key IN ('smtp.password', 'web_push.vapid_private_key') AND value_type = 'SECRET')
        OR (setting_key IN ('media.upload_max_bytes', 'smtp.port') AND value_type = 'INTEGER')
        OR (setting_key IN ('access.public_join_enabled', 'maintenance.enabled', 'smtp.enabled', 'web_push.enabled') AND value_type = 'BOOLEAN')
        OR (setting_key IN (
            'instance.name', 'instance.default_currency', 'maintenance.message',
            'smtp.host', 'smtp.tls_mode', 'smtp.username', 'smtp.from_address', 'smtp.from_name',
            'web_push.subject'
        ) AND value_type = 'STRING')
    ),
    CHECK (value_type != 'BOOLEAN' OR value_text IN ('true', 'false')),
    CHECK (value_type != 'INTEGER' OR (
        value_text NOT GLOB '*[^0-9]*' AND length(value_text) BETWEEN 1 AND 20
    ))
) STRICT;

INSERT INTO system_setting_overrides(
    setting_key,value_type,value_text,secret_ciphertext,version,updated_at,updated_by_user_id
)
SELECT setting_key,value_type,value_text,secret_ciphertext,version,updated_at,updated_by_user_id
FROM system_setting_overrides_legacy;

DROP TABLE system_setting_overrides_legacy;

CREATE INDEX system_setting_overrides_updated_idx
    ON system_setting_overrides(updated_at, setting_key);

CREATE TABLE group_notification_settings (
    group_id TEXT PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
    timezone TEXT NOT NULL DEFAULT 'Europe/Berlin'
        CHECK (length(trim(timezone)) BETWEEN 1 AND 64),
    settlement_due_soon_days INTEGER NOT NULL DEFAULT 3
        CHECK (settlement_due_soon_days BETWEEN 1 AND 30),
    settlement_overdue_repeat_days INTEGER NOT NULL DEFAULT 7
        CHECK (settlement_overdue_repeat_days BETWEEN 0 AND 90),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE group_notification_events (
    group_id TEXT NOT NULL,
    event_type TEXT NOT NULL
        CHECK (length(event_type) BETWEEN 3 AND 80 AND event_type NOT GLOB '*[^A-Z0-9_]*'),
    enabled_at TEXT NOT NULL,
    PRIMARY KEY (group_id,event_type),
    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE membership_notification_channels (
    group_id TEXT NOT NULL,
    membership_id TEXT NOT NULL,
    event_type TEXT NOT NULL
        CHECK (length(event_type) BETWEEN 3 AND 80 AND event_type NOT GLOB '*[^A-Z0-9_]*'),
    channel TEXT NOT NULL CHECK (channel IN ('EMAIL','PUSH')),
    enabled_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (membership_id,event_type,channel),
    FOREIGN KEY (group_id,membership_id) REFERENCES memberships(group_id,id) ON DELETE CASCADE
) STRICT;

CREATE TABLE membership_notification_settings (
    group_id TEXT NOT NULL,
    membership_id TEXT PRIMARY KEY,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    updated_at TEXT NOT NULL,
    FOREIGN KEY (group_id,membership_id) REFERENCES memberships(group_id,id) ON DELETE CASCADE
) STRICT;

CREATE INDEX membership_notification_channels_group_idx
    ON membership_notification_channels(group_id,membership_id,event_type);

CREATE TABLE web_push_subscriptions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint_hash TEXT NOT NULL UNIQUE
        CHECK (length(endpoint_hash)=64 AND endpoint_hash NOT GLOB '*[^0-9a-f]*'),
    encrypted_subscription TEXT NOT NULL CHECK (length(encrypted_subscription)>0),
    vapid_key_id TEXT NOT NULL CHECK (length(vapid_key_id) BETWEEN 16 AND 64),
    device_label TEXT NOT NULL CHECK (length(trim(device_label)) BETWEEN 1 AND 80),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_used_at TEXT NOT NULL,
    revoked_at TEXT
) STRICT;

CREATE INDEX web_push_subscriptions_user_idx
    ON web_push_subscriptions(user_id,revoked_at,last_used_at DESC);

CREATE INDEX web_push_subscriptions_key_idx
    ON web_push_subscriptions(vapid_key_id,revoked_at);

CREATE TABLE notification_delivery_jobs (
    id TEXT PRIMARY KEY,
    notification_id TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    channel TEXT NOT NULL CHECK (channel IN ('EMAIL','PUSH')),
    target_membership_id TEXT,
    push_subscription_id TEXT REFERENCES web_push_subscriptions(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING','SENDING','SENT','FAILED','EXPIRED')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 10),
    next_attempt_at TEXT,
    lease_token TEXT,
    lease_until TEXT,
    delivered_at TEXT,
    expires_at TEXT,
    last_error_code TEXT CHECK (
        last_error_code IS NULL OR (
            length(last_error_code) BETWEEN 1 AND 64
            AND last_error_code NOT GLOB '*[^a-z0-9_]*'
        )
    ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
        (channel='EMAIL' AND target_membership_id IS NOT NULL AND push_subscription_id IS NULL AND expires_at IS NULL)
        OR
        (channel='PUSH' AND target_membership_id IS NULL AND push_subscription_id IS NOT NULL AND expires_at IS NOT NULL)
    ),
    CHECK ((lease_token IS NULL) = (lease_until IS NULL)),
    CHECK (status = 'SENDING' OR (lease_token IS NULL AND lease_until IS NULL)),
    CHECK (status != 'SENDING' OR (lease_token IS NOT NULL AND lease_until IS NOT NULL)),
    CHECK (status != 'PENDING' OR next_attempt_at IS NOT NULL),
    CHECK (status NOT IN ('SENT','FAILED','EXPIRED') OR next_attempt_at IS NULL),
    CHECK (status != 'SENT' OR delivered_at IS NOT NULL),
    CHECK (status = 'SENT' OR delivered_at IS NULL),
    UNIQUE (notification_id,channel,target_membership_id),
    UNIQUE (notification_id,channel,push_subscription_id),
    FOREIGN KEY (group_id,target_membership_id) REFERENCES memberships(group_id,id) ON DELETE CASCADE
) STRICT;

CREATE INDEX notification_delivery_jobs_pending_idx
    ON notification_delivery_jobs(channel,next_attempt_at,created_at)
    WHERE status='PENDING';

CREATE INDEX notification_delivery_jobs_lease_idx
    ON notification_delivery_jobs(lease_until)
    WHERE status='SENDING';

CREATE INDEX notification_delivery_jobs_group_idx
    ON notification_delivery_jobs(group_id,created_at DESC);

INSERT INTO group_notification_settings(group_id,updated_at)
SELECT id,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM groups;

INSERT INTO group_notification_events(group_id,event_type,enabled_at)
SELECT groups.id,event.event_type,strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM groups
CROSS JOIN (
    SELECT 'BOOKING_ASSIGNED' AS event_type
    UNION ALL SELECT 'BOOKING_REVERSED'
    UNION ALL SELECT 'PAYMENT_RECORDED'
    UNION ALL SELECT 'PAYMENT_REVERSED'
    UNION ALL SELECT 'SETTLEMENT_CREATED'
) event;

INSERT INTO membership_notification_channels(group_id,membership_id,event_type,channel,enabled_at,updated_at)
SELECT memberships.group_id,memberships.id,event.event_type,'EMAIL',
       strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM memberships
JOIN group_settings ON group_settings.group_id=memberships.group_id
JOIN users ON users.id=memberships.user_id AND users.email IS NOT NULL
CROSS JOIN (
    SELECT 'BOOKING_ASSIGNED' AS event_type
    UNION ALL SELECT 'BOOKING_REVERSED'
    UNION ALL SELECT 'PAYMENT_RECORDED'
    UNION ALL SELECT 'PAYMENT_REVERSED'
    UNION ALL SELECT 'SETTLEMENT_CREATED'
) event
WHERE group_settings.notification_emails_enabled=1;

INSERT INTO membership_notification_settings(group_id,membership_id,updated_at)
SELECT group_id,id,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM memberships;

INSERT INTO notification_delivery_jobs(
    id,notification_id,group_id,channel,target_membership_id,status,attempt_count,
    next_attempt_at,lease_token,lease_until,delivered_at,last_error_code,created_at,updated_at
)
SELECT 'dlj_email_' || legacy.notification_id,legacy.notification_id,legacy.group_id,'EMAIL',
       notification.membership_id,legacy.status,legacy.attempt_count,legacy.next_attempt_at,
       legacy.lease_token,legacy.lease_until,legacy.sent_at,legacy.last_error_code,
       legacy.created_at,legacy.updated_at
FROM notification_email_outbox legacy
JOIN notifications notification ON notification.id=legacy.notification_id;

DROP TABLE notification_email_outbox;

CREATE TRIGGER groups_seed_notification_configuration
AFTER INSERT ON groups
BEGIN
    INSERT INTO group_notification_settings(group_id,updated_at)
    VALUES(NEW.id,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
    INSERT INTO group_notification_events(group_id,event_type,enabled_at)
    VALUES
        (NEW.id,'BOOKING_ASSIGNED',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        (NEW.id,'BOOKING_REVERSED',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        (NEW.id,'PAYMENT_RECORDED',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        (NEW.id,'PAYMENT_REVERSED',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        (NEW.id,'SETTLEMENT_CREATED',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER memberships_seed_notification_configuration
AFTER INSERT ON memberships
BEGIN
    INSERT INTO membership_notification_settings(group_id,membership_id,updated_at)
    VALUES(NEW.group_id,NEW.id,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TABLE notification_reminder_runs (
    group_id TEXT NOT NULL,
    statement_id TEXT NOT NULL REFERENCES period_statements(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL CHECK (event_type IN ('SETTLEMENT_DUE_SOON','SETTLEMENT_OVERDUE')),
    occurrence_date TEXT NOT NULL,
    notification_id TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (statement_id,event_type,occurrence_date),
    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX notification_reminder_runs_group_idx
    ON notification_reminder_runs(group_id,event_type,occurrence_date);

CREATE INDEX periods_notification_due_idx
    ON periods(due_at,group_id,id)
    WHERE due_at IS NOT NULL;
