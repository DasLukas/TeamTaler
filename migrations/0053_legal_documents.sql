CREATE TABLE legal_documents_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    updated_at TEXT NOT NULL,
    updated_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT
) STRICT;

INSERT INTO legal_documents_state(singleton, revision, updated_at)
VALUES (1, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'));

CREATE TABLE legal_document_overrides (
    document_key TEXT PRIMARY KEY CHECK (document_key IN ('IMPRINT', 'PRIVACY_POLICY')),
    content TEXT NOT NULL CHECK (length(trim(content)) BETWEEN 1 AND 65536),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    updated_at TEXT NOT NULL,
    updated_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX legal_document_overrides_updated_idx
    ON legal_document_overrides(updated_at, document_key);
