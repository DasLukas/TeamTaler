package storage

import (
	"context"
	"database/sql"
	"strings"
	"testing"
)

func TestSystemRoleSemanticsMigrationNormalizesPresetMetadataAndSeedsNewGroups(t *testing.T) {
	ctx := context.Background()
	db := openDatabaseThroughMigration(t, "0027_transaction_reason_modes.sql")
	defer db.Close()

	const now = "2026-08-15T06:00:00Z"
	if _, err := db.ExecContext(ctx, `INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES('group-existing','Existing','EUR',?,?)`, now, now); err != nil {
		t.Fatalf("insert existing group: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO group_settings(group_id,default_role_id,updated_at) VALUES('group-existing','role:MEMBER:group-existing',?)`, now); err != nil {
		t.Fatalf("insert existing settings: %v", err)
	}

	if err := Migrate(ctx, db); err != nil {
		t.Fatalf("apply system-role semantics migration: %v", err)
	}

	var existingRoleCount, existingAdministratorGrantCount, existingGuestCount, existingSystemPresetCount int
	var existingMemberName, existingDefaultRoleID string
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM roles WHERE group_id='group-existing'`).Scan(&existingRoleCount); err != nil {
		t.Fatalf("count existing roles: %v", err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM role_permission_grants WHERE group_id='group-existing' AND role_id='role:GROUP_ADMINISTRATOR:group-existing'`).Scan(&existingAdministratorGrantCount); err != nil {
		t.Fatalf("count existing administrator grants: %v", err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM roles WHERE group_id='group-existing' AND id='role:GUEST:group-existing'`).Scan(&existingGuestCount); err != nil {
		t.Fatalf("count existing guest roles: %v", err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM roles WHERE group_id='group-existing' AND preset_key IS NOT NULL`).Scan(&existingSystemPresetCount); err != nil {
		t.Fatalf("count existing system presets: %v", err)
	}
	if err := db.QueryRowContext(ctx, `SELECT name FROM roles WHERE id='role:MEMBER:group-existing'`).Scan(&existingMemberName); err != nil {
		t.Fatalf("read existing member role: %v", err)
	}
	if err := db.QueryRowContext(ctx, `SELECT default_role_id FROM group_settings WHERE group_id='group-existing'`).Scan(&existingDefaultRoleID); err != nil {
		t.Fatalf("read existing default role: %v", err)
	}
	if existingRoleCount != 4 || existingAdministratorGrantCount != 18 || existingGuestCount != 0 || existingSystemPresetCount != 1 || existingMemberName != "Member" || existingDefaultRoleID != "role:MEMBER:group-existing" {
		t.Fatalf("existing role state after preset normalization: roles=%d adminGrants=%d guests=%d presets=%d member=%q default=%q", existingRoleCount, existingAdministratorGrantCount, existingGuestCount, existingSystemPresetCount, existingMemberName, existingDefaultRoleID)
	}

	if _, err := db.ExecContext(ctx, `INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES('group-new','New','EUR',?,?)`, now, now); err != nil {
		t.Fatalf("insert new group: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO group_settings(group_id,default_role_id,updated_at) VALUES('group-new','role:GUEST:group-new',?)`, now); err != nil {
		t.Fatalf("insert new settings: %v", err)
	}

	type expectedRole struct {
		id          string
		presetKey   sql.NullString
		name        string
		description string
		grants      string
	}
	want := []expectedRole{
		{id: "role:CATALOG_MANAGER:group-new", name: "Katalogverwaltung", description: "Standardrolle für Katalogverwaltung", grants: "CATALOG_MANAGEMENT,USE_PLANNING,VIEW_MEMBER_DIRECTORY"},
		{id: "role:FINANCE_MANAGER:group-new", name: "Finanzverwaltung", description: "Standardrolle für Finanzverwaltung", grants: "FINANCE_MANAGEMENT,RECORD_OWN_PAYMENT,USE_PLANNING,VIEW_ALL_BOOKING_ACTIVITY,VIEW_MEMBER_DIRECTORY,VIEW_STATISTICS"},
		{id: "role:GROUP_ADMINISTRATOR:group-new", presetKey: sql.NullString{String: "GROUP_ADMINISTRATOR", Valid: true}, name: "Group administrator", description: "Standardrolle für Administratorrolle mit vollständigem Zugriff auf die Gruppe", grants: "CREATE_PLANNING_EVENTS,GROUP_ADMINISTRATION,MANAGE_PLANNING_EVENTS,MEMBER_MANAGEMENT,ROLE_MANAGEMENT,USE_PLANNING,VIEW_MEMBER_DIRECTORY,VIEW_PLANNING_PARTICIPANTS"},
		{id: "role:GUEST:group-new", name: "Gast", description: "Standardrolle für Gäste", grants: "CREATE_OWN_BOOKING"},
		{id: "role:MEMBER:group-new", name: "Mitglied", description: "Standardrolle für reguläre Gruppenmitglieder", grants: "CREATE_OWN_BOOKING,USE_PLANNING,VIEW_MEMBER_DIRECTORY"},
	}
	rows, err := db.QueryContext(ctx, `SELECT id,preset_key,name,description FROM roles WHERE group_id='group-new' ORDER BY id`)
	if err != nil {
		t.Fatalf("list new roles: %v", err)
	}
	defer rows.Close()
	var got []expectedRole
	for rows.Next() {
		var role expectedRole
		if err := rows.Scan(&role.id, &role.presetKey, &role.name, &role.description); err != nil {
			t.Fatalf("scan new role: %v", err)
		}
		grantRows, err := db.QueryContext(ctx, `SELECT permission_key FROM role_permission_grants WHERE group_id='group-new' AND role_id=? ORDER BY permission_key`, role.id)
		if err != nil {
			t.Fatalf("list grants for %s: %v", role.id, err)
		}
		var grants []string
		for grantRows.Next() {
			var grant string
			if err := grantRows.Scan(&grant); err != nil {
				grantRows.Close()
				t.Fatalf("scan grant for %s: %v", role.id, err)
			}
			grants = append(grants, grant)
		}
		if err := grantRows.Close(); err != nil {
			t.Fatalf("close grants for %s: %v", role.id, err)
		}
		role.grants = strings.Join(grants, ",")
		got = append(got, role)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate new roles: %v", err)
	}
	if len(got) != len(want) {
		t.Fatalf("new role count=%d, want %d", len(got), len(want))
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("new role %d=%#v, want %#v", index, got[index], want[index])
		}
	}
	var newDefaultRoleID string
	if err := db.QueryRowContext(ctx, `SELECT default_role_id FROM group_settings WHERE group_id='group-new'`).Scan(&newDefaultRoleID); err != nil || newDefaultRoleID != "role:GUEST:group-new" {
		t.Fatalf("new default role=%q err=%v, want guest role", newDefaultRoleID, err)
	}
}
