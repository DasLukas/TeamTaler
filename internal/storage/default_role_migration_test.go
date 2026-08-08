package storage

import (
	"context"
	"testing"
)

func TestDefaultRoleMigrationLeavesGroupsWithoutMemberPresetUnset(t *testing.T) {
	ctx := context.Background()
	db := openDatabaseThroughMigration(t, "0018_explicit_role_assignments.sql")
	defer db.Close()
	now := "2026-08-08T12:00:00Z"
	if _, err := db.ExecContext(ctx, `INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES('group-no-member','No Member','EUR',?,?)`, now, now); err != nil {
		t.Fatalf("insert group: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO group_settings(group_id,members_can_view_all_bookings,notification_emails_enabled,updated_at) VALUES('group-no-member',0,0,?)`, now); err != nil {
		t.Fatalf("insert settings: %v", err)
	}
	if _, err := db.ExecContext(ctx, `DELETE FROM roles WHERE group_id='group-no-member' AND preset_key='MEMBER'`); err != nil {
		t.Fatalf("delete member starter role: %v", err)
	}
	if err := Migrate(ctx, db); err != nil {
		t.Fatalf("apply default-role migration: %v", err)
	}
	var defaultRoleID any
	if err := db.QueryRowContext(ctx, `SELECT default_role_id FROM group_settings WHERE group_id='group-no-member'`).Scan(&defaultRoleID); err != nil {
		t.Fatalf("read default role: %v", err)
	}
	if defaultRoleID != nil {
		t.Fatalf("default role=%v, want NULL", defaultRoleID)
	}
}
