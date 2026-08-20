INSERT INTO group_notification_events(group_id,event_type,enabled_at)
SELECT settings.group_id,event.event_type,strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM group_notification_settings settings
CROSS JOIN (
    SELECT 'SETTLEMENT_DUE_SOON' AS event_type
    UNION ALL SELECT 'SETTLEMENT_OVERDUE'
) event
WHERE settings.version=1
ON CONFLICT(group_id,event_type) DO NOTHING;

INSERT INTO membership_notification_channels(
    group_id,membership_id,event_type,channel,enabled_at,updated_at
)
SELECT settings.group_id,settings.membership_id,event.event_type,'PUSH',
       strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM membership_notification_settings settings
CROSS JOIN (
    SELECT 'BOOKING_ASSIGNED' AS event_type
    UNION ALL SELECT 'BOOKING_REVERSED'
    UNION ALL SELECT 'PAYMENT_RECORDED'
    UNION ALL SELECT 'PAYMENT_REVERSED'
    UNION ALL SELECT 'SETTLEMENT_CREATED'
    UNION ALL SELECT 'SETTLEMENT_DUE_SOON'
    UNION ALL SELECT 'SETTLEMENT_OVERDUE'
) event
WHERE settings.version=1
ON CONFLICT(membership_id,event_type,channel) DO NOTHING;

INSERT INTO membership_notification_channels(
    group_id,membership_id,event_type,channel,enabled_at,updated_at
)
SELECT settings.group_id,settings.membership_id,event.event_type,'EMAIL',
       strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM membership_notification_settings settings
CROSS JOIN (
    SELECT 'SETTLEMENT_CREATED' AS event_type
    UNION ALL SELECT 'SETTLEMENT_DUE_SOON'
    UNION ALL SELECT 'SETTLEMENT_OVERDUE'
) event
WHERE settings.version=1
ON CONFLICT(membership_id,event_type,channel) DO NOTHING;

DROP TRIGGER groups_seed_notification_configuration;

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
        (NEW.id,'SETTLEMENT_CREATED',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        (NEW.id,'SETTLEMENT_DUE_SOON',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        (NEW.id,'SETTLEMENT_OVERDUE',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

DROP TRIGGER memberships_seed_notification_configuration;

CREATE TRIGGER memberships_seed_notification_configuration
AFTER INSERT ON memberships
BEGIN
    INSERT INTO membership_notification_settings(group_id,membership_id,updated_at)
    VALUES(NEW.group_id,NEW.id,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
    INSERT INTO membership_notification_channels(
        group_id,membership_id,event_type,channel,enabled_at,updated_at
    )
    VALUES
        (NEW.group_id,NEW.id,'BOOKING_ASSIGNED','PUSH',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        (NEW.group_id,NEW.id,'BOOKING_REVERSED','PUSH',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        (NEW.group_id,NEW.id,'PAYMENT_RECORDED','PUSH',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        (NEW.group_id,NEW.id,'PAYMENT_REVERSED','PUSH',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        (NEW.group_id,NEW.id,'SETTLEMENT_CREATED','PUSH',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        (NEW.group_id,NEW.id,'SETTLEMENT_DUE_SOON','PUSH',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        (NEW.group_id,NEW.id,'SETTLEMENT_OVERDUE','PUSH',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
    INSERT INTO membership_notification_channels(
        group_id,membership_id,event_type,channel,enabled_at,updated_at
    )
    VALUES
        (NEW.group_id,NEW.id,'SETTLEMENT_CREATED','EMAIL',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        (NEW.group_id,NEW.id,'SETTLEMENT_DUE_SOON','EMAIL',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        (NEW.group_id,NEW.id,'SETTLEMENT_OVERDUE','EMAIL',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
