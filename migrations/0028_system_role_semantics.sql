DROP TRIGGER IF EXISTS groups_seed_roles_after_insert;
DROP TRIGGER IF EXISTS roles_preset_identity_immutable;

UPDATE roles
SET preset_key = NULL
WHERE preset_key IN ('MEMBER', 'FINANCE_MANAGER', 'CATALOG_MANAGER');

CREATE TRIGGER roles_preset_identity_immutable
BEFORE UPDATE OF group_id, preset_key ON roles
WHEN NEW.group_id != OLD.group_id OR NEW.preset_key IS NOT OLD.preset_key
BEGIN
    SELECT RAISE(ABORT, 'role group and preset identity are immutable');
END;

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
