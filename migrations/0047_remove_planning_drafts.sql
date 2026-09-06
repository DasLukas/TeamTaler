-- Retire unpublished planning records without deleting their audit history.
UPDATE planning_events
SET status = 'CANCELLED',
    cancelled_at = COALESCE(cancelled_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    version = version + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE status = 'DRAFT';

UPDATE planning_series
SET status = 'CANCELLED',
    cancelled_at = COALESCE(cancelled_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    version = version + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE status = 'DRAFT';

-- Historical table constraints still list DRAFT for forward-only migration
-- compatibility. These guards make that state unreachable for current code.
CREATE TRIGGER planning_events_reject_draft_insert
BEFORE INSERT ON planning_events
WHEN NEW.status = 'DRAFT'
BEGIN
    SELECT RAISE(ABORT, 'planning event drafts are not supported');
END;

CREATE TRIGGER planning_events_reject_draft_update
BEFORE UPDATE OF status ON planning_events
WHEN NEW.status = 'DRAFT'
BEGIN
    SELECT RAISE(ABORT, 'planning event drafts are not supported');
END;

CREATE TRIGGER planning_series_reject_draft_insert
BEFORE INSERT ON planning_series
WHEN NEW.status = 'DRAFT'
BEGIN
    SELECT RAISE(ABORT, 'planning series drafts are not supported');
END;

CREATE TRIGGER planning_series_reject_draft_update
BEFORE UPDATE OF status ON planning_series
WHEN NEW.status = 'DRAFT'
BEGIN
    SELECT RAISE(ABORT, 'planning series drafts are not supported');
END;
