ALTER TABLE groups ADD COLUMN status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('PROVISIONING', 'ACTIVE', 'ARCHIVED', 'PURGING'));
ALTER TABLE groups ADD COLUMN version INTEGER NOT NULL DEFAULT 1
    CHECK (version >= 1);
ALTER TABLE groups ADD COLUMN archived_at TEXT;
ALTER TABLE groups ADD COLUMN archived_by TEXT REFERENCES users(id) ON DELETE RESTRICT;

CREATE INDEX groups_status_idx ON groups(status);

CREATE TRIGGER groups_archive_metadata_consistent_after_insert
AFTER INSERT ON groups
WHEN (NEW.status IN ('ARCHIVED', 'PURGING')) != (NEW.archived_at IS NOT NULL)
  OR (NEW.status IN ('ARCHIVED', 'PURGING')) != (NEW.archived_by IS NOT NULL)
BEGIN
    SELECT RAISE(ABORT, 'group archive metadata must match lifecycle status');
END;

CREATE TRIGGER groups_archive_metadata_consistent_after_update
AFTER UPDATE OF status, archived_at, archived_by ON groups
WHEN (NEW.status IN ('ARCHIVED', 'PURGING')) != (NEW.archived_at IS NOT NULL)
  OR (NEW.status IN ('ARCHIVED', 'PURGING')) != (NEW.archived_by IS NOT NULL)
BEGIN
    SELECT RAISE(ABORT, 'group archive metadata must match lifecycle status');
END;

CREATE TABLE system_role_assignments (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    role TEXT NOT NULL CHECK (role = 'SYSTEM_ADMINISTRATOR'),
    granted_at TEXT NOT NULL,
    granted_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
    PRIMARY KEY (user_id, role)
) STRICT;

CREATE INDEX system_role_assignments_role_idx
    ON system_role_assignments(role, granted_at, user_id);

CREATE TABLE system_settings_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    smtp_revision INTEGER NOT NULL DEFAULT 0 CHECK (smtp_revision >= 0),
    smtp_test_status TEXT NOT NULL DEFAULT 'UNTESTED'
        CHECK (smtp_test_status IN ('UNTESTED', 'VERIFIED', 'FAILED')),
    smtp_tested_revision INTEGER CHECK (
        smtp_tested_revision IS NULL
        OR (smtp_tested_revision >= 1 AND smtp_tested_revision <= smtp_revision)
    ),
    smtp_tested_at TEXT,
    smtp_tested_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
    updated_at TEXT NOT NULL,
    updated_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
    CHECK ((smtp_tested_revision IS NULL) = (smtp_tested_at IS NULL)),
    CHECK (smtp_tested_revision IS NOT NULL OR smtp_tested_by_user_id IS NULL),
    CHECK (smtp_test_status != 'VERIFIED' OR smtp_tested_revision IS NOT NULL)
) STRICT;

INSERT INTO system_settings_state(singleton, revision, updated_at)
VALUES (1, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'));

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
        'smtp.password'
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
        (setting_key = 'smtp.password' AND value_type = 'SECRET')
        OR (setting_key IN ('media.upload_max_bytes', 'smtp.port') AND value_type = 'INTEGER')
        OR (setting_key IN ('access.public_join_enabled', 'maintenance.enabled', 'smtp.enabled') AND value_type = 'BOOLEAN')
        OR (setting_key IN (
            'instance.name', 'instance.default_currency', 'maintenance.message',
            'smtp.host', 'smtp.tls_mode', 'smtp.username', 'smtp.from_address', 'smtp.from_name'
        ) AND value_type = 'STRING')
    ),
    CHECK (value_type != 'BOOLEAN' OR value_text IN ('true', 'false')),
    CHECK (value_type != 'INTEGER' OR (
        value_text NOT GLOB '*[^0-9]*' AND length(value_text) BETWEEN 1 AND 20
    ))
) STRICT;

CREATE INDEX system_setting_overrides_updated_idx
    ON system_setting_overrides(updated_at, setting_key);

CREATE TABLE system_audit_events (
    id TEXT PRIMARY KEY,
    actor_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
    action TEXT NOT NULL CHECK (length(trim(action)) BETWEEN 1 AND 120),
    resource_type TEXT NOT NULL CHECK (length(trim(resource_type)) BETWEEN 1 AND 80),
    resource_id TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    occurred_at TEXT NOT NULL
) STRICT;

CREATE INDEX system_audit_events_time_idx
    ON system_audit_events(occurred_at DESC, id DESC);

CREATE TRIGGER system_audit_events_no_update
BEFORE UPDATE ON system_audit_events
BEGIN
    SELECT RAISE(ABORT, 'system audit events are immutable');
END;

CREATE TRIGGER system_audit_events_no_delete
BEFORE DELETE ON system_audit_events
BEGIN
    SELECT RAISE(ABORT, 'system audit events are immutable');
END;
