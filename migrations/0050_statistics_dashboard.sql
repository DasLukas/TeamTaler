ALTER TABLE group_settings
    ADD COLUMN statistics_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (statistics_enabled IN (0, 1));

INSERT INTO permission_definitions(
    key,
    description,
    implied_permissions_json,
    display_order,
    created_at
)
VALUES(
    'VIEW_MEMBER_STATISTICS',
    'View anonymized member activity statistics for the group.',
    '[]',
    47,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);

UPDATE permission_definitions
SET implied_permissions_json = '["VIEW_MEMBER_STATISTICS"]'
WHERE key = 'VIEW_ALL_BOOKING_ACTIVITY';

UPDATE permission_definitions
SET description = 'View aggregate group financial statistics.'
WHERE key = 'VIEW_GROUP_STATISTICS';

DROP TRIGGER groups_seed_roles_after_insert;

CREATE TRIGGER groups_seed_roles_after_insert
AFTER INSERT ON groups
BEGIN
    INSERT INTO roles(
        id, group_id, preset_key, name, description, name_locked, deletable,
        version, created_at, updated_at
    ) VALUES
        ('role:GROUP_ADMINISTRATOR:' || NEW.id, NEW.id, 'GROUP_ADMINISTRATOR', 'Group administrator', 'Standardrolle für Administratorrolle mit vollständigem Zugriff auf die Gruppe', 1, 0, 1, NEW.created_at, NEW.updated_at),
        ('role:MEMBER:' || NEW.id, NEW.id, NULL, 'Mitglied', 'Standardrolle für reguläre Gruppenmitglieder', 0, 1, 1, NEW.created_at, NEW.updated_at),
        ('role:FINANCE_MANAGER:' || NEW.id, NEW.id, NULL, 'Finanzverwaltung', 'Standardrolle für Finanzverwaltung', 0, 1, 1, NEW.created_at, NEW.updated_at),
        ('role:CATALOG_MANAGER:' || NEW.id, NEW.id, NULL, 'Katalogverwaltung', 'Standardrolle für Katalogverwaltung', 0, 1, 1, NEW.created_at, NEW.updated_at),
        ('role:GUEST:' || NEW.id, NEW.id, NULL, 'Gast', 'Standardrolle für Gäste', 0, 1, 1, NEW.created_at, NEW.updated_at);

    INSERT INTO role_permission_grants(
        group_id, role_id, permission_key, scope_type, version, created_at, updated_at
    ) VALUES
        (NEW.id, 'role:GROUP_ADMINISTRATOR:' || NEW.id, 'GROUP_ADMINISTRATION', 'GROUP', 1, NEW.created_at, NEW.updated_at),
        (NEW.id, 'role:GROUP_ADMINISTRATOR:' || NEW.id, 'MEMBER_MANAGEMENT', 'GROUP', 1, NEW.created_at, NEW.updated_at),
        (NEW.id, 'role:GROUP_ADMINISTRATOR:' || NEW.id, 'ROLE_MANAGEMENT', 'GROUP', 1, NEW.created_at, NEW.updated_at),
        (NEW.id, 'role:GROUP_ADMINISTRATOR:' || NEW.id, 'VIEW_MEMBER_DIRECTORY', 'GROUP', 1, NEW.created_at, NEW.updated_at),
        (NEW.id, 'role:MEMBER:' || NEW.id, 'CREATE_OWN_BOOKING', 'GROUP', 1, NEW.created_at, NEW.updated_at),
        (NEW.id, 'role:MEMBER:' || NEW.id, 'VIEW_MEMBER_DIRECTORY', 'GROUP', 1, NEW.created_at, NEW.updated_at),
        (NEW.id, 'role:MEMBER:' || NEW.id, 'VIEW_MEMBER_STATISTICS', 'GROUP', 1, NEW.created_at, NEW.updated_at),
        (NEW.id, 'role:FINANCE_MANAGER:' || NEW.id, 'FINANCE_MANAGEMENT', 'GROUP', 1, NEW.created_at, NEW.updated_at),
        (NEW.id, 'role:FINANCE_MANAGER:' || NEW.id, 'RECORD_OWN_PAYMENT', 'GROUP', 1, NEW.created_at, NEW.updated_at),
        (NEW.id, 'role:FINANCE_MANAGER:' || NEW.id, 'VIEW_ALL_BOOKING_ACTIVITY', 'GROUP', 1, NEW.created_at, NEW.updated_at),
        (NEW.id, 'role:FINANCE_MANAGER:' || NEW.id, 'VIEW_GROUP_STATISTICS', 'GROUP', 1, NEW.created_at, NEW.updated_at),
        (NEW.id, 'role:FINANCE_MANAGER:' || NEW.id, 'VIEW_MEMBER_DIRECTORY', 'GROUP', 1, NEW.created_at, NEW.updated_at),
        (NEW.id, 'role:CATALOG_MANAGER:' || NEW.id, 'CATALOG_MANAGEMENT', 'GROUP', 1, NEW.created_at, NEW.updated_at),
        (NEW.id, 'role:CATALOG_MANAGER:' || NEW.id, 'VIEW_MEMBER_DIRECTORY', 'GROUP', 1, NEW.created_at, NEW.updated_at),
        (NEW.id, 'role:GUEST:' || NEW.id, 'CREATE_OWN_BOOKING', 'GROUP', 1, NEW.created_at, NEW.updated_at);

    UPDATE roles SET version = 1 WHERE group_id = NEW.id;
END;

CREATE INDEX ledger_statistics_group_account_created_idx
    ON ledger_entries(group_id, account, created_at);

CREATE INDEX bookings_statistics_group_created_idx
    ON bookings(group_id, created_at);

CREATE INDEX bookings_statistics_group_voided_idx
    ON bookings(group_id, voided_at)
    WHERE voided_at IS NOT NULL;

CREATE INDEX payment_allocations_statistics_group_period_idx
    ON payment_allocations(group_id, period_id, payment_id);
