INSERT INTO permission_definitions(key,description,implied_permissions_json,display_order,created_at) VALUES
('USE_PLANNING','View planning events and manage the current membership participation.','[]',110,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('CREATE_PLANNING_EVENTS','Create and manage own planning events.','["USE_PLANNING"]',120,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('VIEW_PLANNING_PARTICIPANTS','View identified planning participants.','["USE_PLANNING"]',130,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('MANAGE_PLANNING_EVENTS','Manage all planning events, recurring series, and participants.','["USE_PLANNING","CREATE_PLANNING_EVENTS","VIEW_PLANNING_PARTICIPANTS"]',140,strftime('%Y-%m-%dT%H:%M:%fZ','now'));

INSERT INTO role_permission_grants(group_id,role_id,permission_key,scope_type,version,created_at,updated_at)
SELECT role.group_id,role.id,permission.key,'GROUP',1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM roles role
JOIN (SELECT 'USE_PLANNING' key UNION ALL SELECT 'CREATE_PLANNING_EVENTS' UNION ALL SELECT 'VIEW_PLANNING_PARTICIPANTS' UNION ALL SELECT 'MANAGE_PLANNING_EVENTS') permission
WHERE role.preset_key='GROUP_ADMINISTRATOR';

INSERT INTO role_permission_grants(group_id,role_id,permission_key,scope_type,version,created_at,updated_at)
SELECT role.group_id,role.id,'USE_PLANNING','GROUP',1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM roles role WHERE role.id IN ('role:MEMBER:' || role.group_id,'role:FINANCE_MANAGER:' || role.group_id,'role:CATALOG_MANAGER:' || role.group_id)
ON CONFLICT DO NOTHING;

CREATE TRIGGER roles_seed_planning_permissions AFTER INSERT ON roles BEGIN
 INSERT OR IGNORE INTO role_permission_grants(group_id,role_id,permission_key,scope_type,version,created_at,updated_at)
 SELECT NEW.group_id,NEW.id,permission.key,'GROUP',1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
 FROM (SELECT 'USE_PLANNING' key UNION ALL SELECT 'CREATE_PLANNING_EVENTS' UNION ALL SELECT 'VIEW_PLANNING_PARTICIPANTS' UNION ALL SELECT 'MANAGE_PLANNING_EVENTS') permission
 WHERE NEW.preset_key='GROUP_ADMINISTRATOR';
 INSERT OR IGNORE INTO role_permission_grants(group_id,role_id,permission_key,scope_type,version,created_at,updated_at)
 SELECT NEW.group_id,NEW.id,'USE_PLANNING','GROUP',1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE NEW.id IN ('role:MEMBER:' || NEW.group_id,'role:FINANCE_MANAGER:' || NEW.group_id,'role:CATALOG_MANAGER:' || NEW.group_id);
END;

CREATE TABLE group_planning_settings (
    group_id TEXT PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
    enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
    version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
    updated_at TEXT NOT NULL,
    updated_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT
) STRICT;

INSERT INTO group_planning_settings(group_id,updated_at)
SELECT id,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM groups;

CREATE TRIGGER groups_seed_planning_settings AFTER INSERT ON groups BEGIN
    INSERT INTO group_planning_settings(group_id,updated_at)
    VALUES(NEW.id,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TABLE planning_series (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','PUBLISHED','CANCELLED')),
    timezone TEXT NOT NULL CHECK(length(trim(timezone)) BETWEEN 1 AND 120),
    current_revision INTEGER NOT NULL DEFAULT 1 CHECK(current_revision>=1),
    materialized_through TEXT,
    version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
    created_by_membership_id TEXT NOT NULL,
    updated_by_membership_id TEXT NOT NULL,
    published_at TEXT,
    cancelled_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(group_id,id),
    FOREIGN KEY(group_id,created_by_membership_id) REFERENCES memberships(group_id,id) ON DELETE RESTRICT,
    FOREIGN KEY(group_id,updated_by_membership_id) REFERENCES memberships(group_id,id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE planning_series_revisions (
    group_id TEXT NOT NULL,
    series_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision>=1),
    effective_from_original_start_at TEXT NOT NULL,
    effective_from_sequence INTEGER NOT NULL CHECK(effective_from_sequence>=1),
    title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 160),
    description TEXT NOT NULL DEFAULT '' CHECK(length(description)<=4000),
    location TEXT NOT NULL DEFAULT '' CHECK(length(location)<=240),
    event_type TEXT NOT NULL CHECK(event_type IN ('APPOINTMENT','APPOINTMENT_POLL','APPOINTMENT_REGISTRATION')),
    audience_type TEXT NOT NULL CHECK(audience_type IN ('ALL_ACTIVE_MEMBERS','SELECTED_ROLES','SELECTED_MEMBERS','SELECTED_TARGETS')),
    starts_at TEXT NOT NULL,
    duration_minutes INTEGER CHECK(duration_minutes BETWEEN 1 AND 10080),
    response_deadline_minutes_before INTEGER CHECK(response_deadline_minutes_before BETWEEN 0 AND 525600),
    capacity INTEGER CHECK(capacity BETWEEN 1 AND 100000),
    waitlist_enabled INTEGER NOT NULL DEFAULT 0 CHECK(waitlist_enabled IN (0,1)),
    frequency TEXT NOT NULL CHECK(frequency IN ('DAILY','WEEKLY','MONTHLY','YEARLY')),
    interval_value INTEGER NOT NULL CHECK(interval_value BETWEEN 1 AND 99),
    weekdays_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(weekdays_json)),
    monthly_mode TEXT CHECK(monthly_mode IN ('DAY_OF_MONTH','NTH_WEEKDAY','LAST_DAY')),
    range_type TEXT NOT NULL CHECK(range_type IN ('COUNT','UNTIL','NEVER')),
    occurrence_count INTEGER CHECK(occurrence_count BETWEEN 2 AND 500),
    until_at TEXT,
    created_by_membership_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(series_id,revision),
    UNIQUE(group_id,series_id,revision),
    FOREIGN KEY(group_id,series_id) REFERENCES planning_series(group_id,id) ON DELETE CASCADE,
    FOREIGN KEY(group_id,created_by_membership_id) REFERENCES memberships(group_id,id) ON DELETE RESTRICT,
    CHECK(event_type='APPOINTMENT_REGISTRATION' OR (capacity IS NULL AND waitlist_enabled=0)),
    CHECK(capacity IS NOT NULL OR waitlist_enabled=0),
    CHECK(event_type!='APPOINTMENT' OR response_deadline_minutes_before IS NULL),
    CHECK((range_type='COUNT')=(occurrence_count IS NOT NULL)),
    CHECK((range_type='UNTIL')=(until_at IS NOT NULL))
) STRICT;
CREATE INDEX planning_series_revisions_effective_idx ON planning_series_revisions(series_id,effective_from_original_start_at DESC,revision DESC);

CREATE TABLE planning_series_target_roles (
 group_id TEXT NOT NULL,series_id TEXT NOT NULL,revision INTEGER NOT NULL,role_id TEXT NOT NULL,
 PRIMARY KEY(series_id,revision,role_id),
 FOREIGN KEY(group_id,series_id,revision) REFERENCES planning_series_revisions(group_id,series_id,revision) ON DELETE CASCADE,
 FOREIGN KEY(group_id,role_id) REFERENCES roles(group_id,id) ON DELETE CASCADE
) STRICT;
CREATE TABLE planning_series_target_memberships (
 group_id TEXT NOT NULL,series_id TEXT NOT NULL,revision INTEGER NOT NULL,membership_id TEXT NOT NULL,
 PRIMARY KEY(series_id,revision,membership_id),
 FOREIGN KEY(group_id,series_id,revision) REFERENCES planning_series_revisions(group_id,series_id,revision) ON DELETE CASCADE,
 FOREIGN KEY(group_id,membership_id) REFERENCES memberships(group_id,id) ON DELETE CASCADE
) STRICT;
CREATE TABLE planning_series_recipients (
 group_id TEXT NOT NULL,series_id TEXT NOT NULL,membership_id TEXT NOT NULL,
 first_notified_at TEXT NOT NULL,last_synced_at TEXT NOT NULL,
 PRIMARY KEY(series_id,membership_id),
 FOREIGN KEY(group_id,series_id) REFERENCES planning_series(group_id,id) ON DELETE CASCADE,
 FOREIGN KEY(group_id,membership_id) REFERENCES memberships(group_id,id) ON DELETE RESTRICT
) STRICT;
CREATE TABLE planning_series_cancelled_ranges (
 group_id TEXT NOT NULL,series_id TEXT NOT NULL,from_sequence INTEGER NOT NULL CHECK(from_sequence>=1),from_original_start_at TEXT NOT NULL,
 created_by_membership_id TEXT NOT NULL,created_at TEXT NOT NULL,
 PRIMARY KEY(series_id,from_sequence),
 FOREIGN KEY(group_id,series_id) REFERENCES planning_series(group_id,id) ON DELETE CASCADE,
 FOREIGN KEY(group_id,created_by_membership_id) REFERENCES memberships(group_id,id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE planning_events (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    series_id TEXT,
    series_revision INTEGER,
    series_sequence INTEGER,
    original_start_at TEXT,
    is_series_exception INTEGER NOT NULL DEFAULT 0 CHECK(is_series_exception IN (0,1)),
    title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 160),
    description TEXT NOT NULL DEFAULT '' CHECK(length(description)<=4000),
    location TEXT NOT NULL DEFAULT '' CHECK(length(location)<=240),
    event_type TEXT NOT NULL CHECK(event_type IN ('APPOINTMENT','APPOINTMENT_POLL','APPOINTMENT_REGISTRATION')),
    status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','PUBLISHED','CLOSED','COMPLETED','CANCELLED')),
    audience_type TEXT NOT NULL CHECK(audience_type IN ('ALL_ACTIVE_MEMBERS','SELECTED_ROLES','SELECTED_MEMBERS','SELECTED_TARGETS')),
    starts_at TEXT NOT NULL,
    ends_at TEXT,
    response_deadline TEXT,
    response_deadline_minutes_before INTEGER CHECK(response_deadline_minutes_before BETWEEN 0 AND 525600),
    capacity INTEGER CHECK(capacity BETWEEN 1 AND 100000),
    waitlist_enabled INTEGER NOT NULL DEFAULT 0 CHECK(waitlist_enabled IN (0,1)),
    confirmation_revision INTEGER NOT NULL DEFAULT 1 CHECK(confirmation_revision>=1),
    version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
    created_by_membership_id TEXT NOT NULL,
    updated_by_membership_id TEXT NOT NULL,
    published_at TEXT,
    closed_at TEXT,
    completed_at TEXT,
    cancelled_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(group_id,id),
    UNIQUE(series_id,series_sequence),
    FOREIGN KEY(group_id,series_id) REFERENCES planning_series(group_id,id) ON DELETE CASCADE,
    FOREIGN KEY(group_id,series_id,series_revision) REFERENCES planning_series_revisions(group_id,series_id,revision) ON DELETE RESTRICT,
    FOREIGN KEY(group_id,created_by_membership_id) REFERENCES memberships(group_id,id) ON DELETE RESTRICT,
    FOREIGN KEY(group_id,updated_by_membership_id) REFERENCES memberships(group_id,id) ON DELETE RESTRICT,
    CHECK(event_type='APPOINTMENT_REGISTRATION' OR (capacity IS NULL AND waitlist_enabled=0)),
    CHECK(capacity IS NOT NULL OR waitlist_enabled=0),
    CHECK(event_type!='APPOINTMENT' OR response_deadline IS NULL),
    CHECK(event_type!='APPOINTMENT' OR response_deadline_minutes_before IS NULL),
    CHECK((response_deadline IS NULL)=(response_deadline_minutes_before IS NULL)),
    CHECK((series_id IS NULL AND series_revision IS NULL AND series_sequence IS NULL AND original_start_at IS NULL AND is_series_exception=0) OR
          (series_id IS NOT NULL AND series_revision IS NOT NULL AND series_sequence IS NOT NULL AND original_start_at IS NOT NULL))
) STRICT;
CREATE INDEX planning_events_calendar_idx ON planning_events(group_id,starts_at,id);
CREATE INDEX planning_events_series_idx ON planning_events(series_id,series_sequence,id);

CREATE TABLE planning_event_target_roles (
    group_id TEXT NOT NULL,event_id TEXT NOT NULL,role_id TEXT NOT NULL,
    PRIMARY KEY(event_id,role_id),
    FOREIGN KEY(group_id,event_id) REFERENCES planning_events(group_id,id) ON DELETE CASCADE,
    FOREIGN KEY(group_id,role_id) REFERENCES roles(group_id,id) ON DELETE CASCADE
) STRICT;
CREATE TABLE planning_event_target_memberships (
    group_id TEXT NOT NULL,event_id TEXT NOT NULL,membership_id TEXT NOT NULL,
    PRIMARY KEY(event_id,membership_id),
    FOREIGN KEY(group_id,event_id) REFERENCES planning_events(group_id,id) ON DELETE CASCADE,
    FOREIGN KEY(group_id,membership_id) REFERENCES memberships(group_id,id) ON DELETE CASCADE
) STRICT;
CREATE TABLE planning_event_audience (
    group_id TEXT NOT NULL,event_id TEXT NOT NULL,membership_id TEXT NOT NULL,
    display_name_snapshot TEXT NOT NULL,invited_at TEXT NOT NULL,
    PRIMARY KEY(event_id,membership_id),
    FOREIGN KEY(group_id,event_id) REFERENCES planning_events(group_id,id) ON DELETE CASCADE,
    FOREIGN KEY(group_id,membership_id) REFERENCES memberships(group_id,id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX planning_audience_member_idx ON planning_event_audience(group_id,membership_id,event_id);

CREATE TABLE planning_participations (
    group_id TEXT NOT NULL,event_id TEXT NOT NULL,membership_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('YES','MAYBE','NO','REGISTERED','WAITLISTED','WITHDRAWN')),
    waitlist_position INTEGER CHECK(waitlist_position IS NULL OR waitlist_position>=1),
    confirmed_revision INTEGER NOT NULL CHECK(confirmed_revision>=1),
    version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
    responded_at TEXT NOT NULL,updated_at TEXT NOT NULL,
    PRIMARY KEY(event_id,membership_id),
    FOREIGN KEY(group_id,event_id) REFERENCES planning_events(group_id,id) ON DELETE CASCADE,
    FOREIGN KEY(event_id,membership_id) REFERENCES planning_event_audience(event_id,membership_id) ON DELETE CASCADE,
    CHECK(status='WAITLISTED' OR waitlist_position IS NULL)
) STRICT;
CREATE INDEX planning_participation_state_idx ON planning_participations(group_id,event_id,status,waitlist_position);

CREATE TABLE planning_notification_tasks (
    id TEXT PRIMARY KEY,group_id TEXT NOT NULL,event_id TEXT NOT NULL,target_membership_id TEXT NOT NULL,
    event_type TEXT NOT NULL,scheduled_for TEXT NOT NULL,event_revision INTEGER NOT NULL CHECK(event_revision>=1),
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PROCESSED','CANCELLED')),
    created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
    UNIQUE(event_id,target_membership_id,event_type,scheduled_for),
    FOREIGN KEY(group_id,event_id) REFERENCES planning_events(group_id,id) ON DELETE CASCADE,
    FOREIGN KEY(event_id,target_membership_id) REFERENCES planning_event_audience(event_id,membership_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX planning_notification_tasks_due_idx ON planning_notification_tasks(status,scheduled_for,id) WHERE status='PENDING';
CREATE TABLE planning_series_notification_tasks (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    series_id TEXT NOT NULL,
    target_membership_id TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK(event_type IN ('PLANNING_SERIES_PUBLISHED','PLANNING_SERIES_UPDATED','PLANNING_SERIES_CANCELLED')),
    series_revision INTEGER NOT NULL CHECK(series_revision>=1),
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PROCESSED','CANCELLED')),
    scheduled_for TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(series_id,target_membership_id,event_type,series_revision),
    FOREIGN KEY(group_id,series_id) REFERENCES planning_series(group_id,id) ON DELETE CASCADE,
    FOREIGN KEY(series_id,target_membership_id) REFERENCES planning_series_recipients(series_id,membership_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX planning_series_notification_tasks_due_idx ON planning_series_notification_tasks(status,scheduled_for,id) WHERE status='PENDING';
CREATE TABLE planning_notification_runs (
    id TEXT PRIMARY KEY,task_id TEXT NOT NULL UNIQUE REFERENCES planning_notification_tasks(id) ON DELETE CASCADE,
    group_id TEXT NOT NULL,event_id TEXT NOT NULL,target_membership_id TEXT NOT NULL,event_type TEXT NOT NULL,
    notification_id TEXT REFERENCES notifications(id) ON DELETE SET NULL,processed_at TEXT NOT NULL,
    FOREIGN KEY(group_id,event_id) REFERENCES planning_events(group_id,id) ON DELETE CASCADE,
    FOREIGN KEY(event_id,target_membership_id) REFERENCES planning_event_audience(event_id,membership_id) ON DELETE CASCADE
) STRICT;

INSERT OR IGNORE INTO group_notification_events(group_id,event_type,enabled_at)
SELECT groups.id,event.event_type,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM groups CROSS JOIN (
 SELECT 'PLANNING_EVENT_PUBLISHED' event_type UNION ALL SELECT 'PLANNING_EVENT_UPDATED'
 UNION ALL SELECT 'PLANNING_EVENT_CANCELLED'
 UNION ALL SELECT 'PLANNING_WAITLIST_PROMOTED' UNION ALL SELECT 'PLANNING_SERIES_PUBLISHED'
 UNION ALL SELECT 'PLANNING_SERIES_UPDATED' UNION ALL SELECT 'PLANNING_SERIES_CANCELLED'
) event;

INSERT OR IGNORE INTO membership_notification_channels(group_id,membership_id,event_type,channel,enabled_at,updated_at)
SELECT memberships.group_id,memberships.id,event.event_type,'PUSH',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM memberships CROSS JOIN (
 SELECT 'PLANNING_EVENT_PUBLISHED' event_type UNION ALL SELECT 'PLANNING_EVENT_UPDATED'
 UNION ALL SELECT 'PLANNING_EVENT_CANCELLED'
 UNION ALL SELECT 'PLANNING_WAITLIST_PROMOTED' UNION ALL SELECT 'PLANNING_SERIES_PUBLISHED'
 UNION ALL SELECT 'PLANNING_SERIES_UPDATED' UNION ALL SELECT 'PLANNING_SERIES_CANCELLED'
) event;

DROP TRIGGER groups_seed_notification_configuration;
CREATE TRIGGER groups_seed_notification_configuration AFTER INSERT ON groups BEGIN
 INSERT INTO group_notification_settings(group_id,updated_at) VALUES(NEW.id,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
 INSERT INTO group_notification_events(group_id,event_type,enabled_at) VALUES
 (NEW.id,'BOOKING_ASSIGNED',strftime('%Y-%m-%dT%H:%M:%fZ','now')),(NEW.id,'BOOKING_REVERSED',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 (NEW.id,'PAYMENT_RECORDED',strftime('%Y-%m-%dT%H:%M:%fZ','now')),(NEW.id,'PAYMENT_REVERSED',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 (NEW.id,'SETTLEMENT_CREATED',strftime('%Y-%m-%dT%H:%M:%fZ','now')),(NEW.id,'SETTLEMENT_DUE_SOON',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 (NEW.id,'SETTLEMENT_OVERDUE',strftime('%Y-%m-%dT%H:%M:%fZ','now')),(NEW.id,'PLANNING_EVENT_PUBLISHED',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 (NEW.id,'PLANNING_EVENT_UPDATED',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 (NEW.id,'PLANNING_EVENT_CANCELLED',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 (NEW.id,'PLANNING_WAITLIST_PROMOTED',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 (NEW.id,'PLANNING_SERIES_PUBLISHED',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 (NEW.id,'PLANNING_SERIES_UPDATED',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 (NEW.id,'PLANNING_SERIES_CANCELLED',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

DROP TRIGGER memberships_seed_notification_configuration;
CREATE TRIGGER memberships_seed_notification_configuration AFTER INSERT ON memberships BEGIN
 INSERT INTO membership_notification_settings(group_id,membership_id,updated_at) VALUES(NEW.group_id,NEW.id,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
 INSERT INTO membership_notification_channels(group_id,membership_id,event_type,channel,enabled_at,updated_at) VALUES
 (NEW.group_id,NEW.id,'BOOKING_ASSIGNED','PUSH',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 (NEW.group_id,NEW.id,'BOOKING_REVERSED','PUSH',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 (NEW.group_id,NEW.id,'PAYMENT_RECORDED','PUSH',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 (NEW.group_id,NEW.id,'PAYMENT_REVERSED','PUSH',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 (NEW.group_id,NEW.id,'SETTLEMENT_CREATED','PUSH',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 (NEW.group_id,NEW.id,'SETTLEMENT_DUE_SOON','PUSH',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 (NEW.group_id,NEW.id,'SETTLEMENT_OVERDUE','PUSH',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 (NEW.group_id,NEW.id,'PLANNING_EVENT_PUBLISHED','PUSH',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 (NEW.group_id,NEW.id,'PLANNING_EVENT_UPDATED','PUSH',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 (NEW.group_id,NEW.id,'PLANNING_EVENT_CANCELLED','PUSH',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 (NEW.group_id,NEW.id,'PLANNING_WAITLIST_PROMOTED','PUSH',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 (NEW.group_id,NEW.id,'PLANNING_SERIES_PUBLISHED','PUSH',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 (NEW.group_id,NEW.id,'PLANNING_SERIES_UPDATED','PUSH',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 (NEW.group_id,NEW.id,'PLANNING_SERIES_CANCELLED','PUSH',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
 INSERT INTO membership_notification_channels(group_id,membership_id,event_type,channel,enabled_at,updated_at) VALUES
 (NEW.group_id,NEW.id,'SETTLEMENT_CREATED','EMAIL',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 (NEW.group_id,NEW.id,'SETTLEMENT_DUE_SOON','EMAIL',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 (NEW.group_id,NEW.id,'SETTLEMENT_OVERDUE','EMAIL',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
