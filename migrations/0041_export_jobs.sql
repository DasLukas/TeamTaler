CREATE TABLE export_jobs (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL CHECK (scope IN ('GROUP', 'PERSONAL')),
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    requested_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    requested_by_membership_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'QUEUED'
        CHECK (status IN ('QUEUED', 'RUNNING', 'READY', 'FAILED', 'CANCELLED', 'EXPIRED')),
    progress_completed INTEGER NOT NULL DEFAULT 0 CHECK (progress_completed >= 0),
    progress_total INTEGER NOT NULL CHECK (progress_total > 0),
    started_at TEXT,
    completed_at TEXT,
    expires_at TEXT,
    size_bytes INTEGER CHECK (size_bytes IS NULL OR size_bytes >= 0),
    sha256 TEXT CHECK (
        sha256 IS NULL OR (
            length(sha256) = 64
            AND sha256 NOT GLOB '*[^0-9a-f]*'
        )
    ),
    artifact_name TEXT CHECK (
        artifact_name IS NULL OR (
            length(artifact_name) = length(id) + 37
            AND artifact_name GLOB id || '-[0-9a-f]*.zip'
            AND substr(artifact_name, length(id) + 2, 32) NOT GLOB '*[^0-9a-f]*'
            AND artifact_name NOT GLOB '*[^a-zA-Z0-9_.-]*'
        )
    ),
    error_code TEXT CHECK (
        error_code IS NULL OR (
            length(error_code) BETWEEN 1 AND 64
            AND error_code NOT GLOB '*[^a-z0-9_]*'
        )
    ),
    completion_notified_at TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 10),
    lease_token TEXT,
    lease_until TEXT,
    idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
    request_hash TEXT NOT NULL CHECK (
        length(request_hash) = 64
        AND request_hash NOT GLOB '*[^0-9a-f]*'
    ),
    requested_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (group_id, requested_by_user_id, scope, idempotency_key),
    FOREIGN KEY (group_id, requested_by_membership_id)
        REFERENCES memberships(group_id, id) ON DELETE CASCADE,
    CHECK ((lease_token IS NULL) = (lease_until IS NULL)),
    CHECK (status = 'RUNNING' OR (lease_token IS NULL AND lease_until IS NULL)),
    CHECK (status != 'RUNNING' OR (started_at IS NOT NULL AND lease_token IS NOT NULL)),
    CHECK (status != 'READY' OR (
        completed_at IS NOT NULL AND expires_at IS NOT NULL
        AND size_bytes IS NOT NULL AND sha256 IS NOT NULL AND artifact_name IS NOT NULL
    )),
    CHECK (status != 'FAILED' OR (completed_at IS NOT NULL AND error_code IS NOT NULL)),
    CHECK (status NOT IN ('READY', 'FAILED', 'CANCELLED', 'EXPIRED') OR lease_token IS NULL)
) STRICT;

CREATE UNIQUE INDEX export_jobs_one_running_idx
    ON export_jobs(group_id, requested_by_user_id, scope)
    WHERE status IN ('QUEUED', 'RUNNING');

CREATE INDEX export_jobs_pending_idx
    ON export_jobs(status, requested_at, id)
    WHERE status IN ('QUEUED', 'RUNNING');

CREATE INDEX export_jobs_actor_idx
    ON export_jobs(requested_by_user_id, group_id, requested_at DESC, id DESC);

CREATE INDEX export_jobs_expiry_idx
    ON export_jobs(expires_at, id)
    WHERE status = 'READY';

CREATE INDEX export_jobs_completion_notification_idx
    ON export_jobs(completed_at, id)
    WHERE status IN ('READY', 'FAILED') AND completion_notified_at IS NULL;
