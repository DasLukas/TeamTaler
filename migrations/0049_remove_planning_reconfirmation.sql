-- Retire planning-response reconfirmation while preserving response history.
UPDATE planning_participations
SET confirmed_revision = (
    SELECT event.confirmation_revision
    FROM planning_events AS event
    WHERE event.id = planning_participations.event_id
)
WHERE confirmed_revision < (
    SELECT event.confirmation_revision
    FROM planning_events AS event
    WHERE event.id = planning_participations.event_id
);
