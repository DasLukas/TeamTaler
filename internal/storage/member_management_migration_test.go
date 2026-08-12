package storage

import (
	"context"
	"testing"
)

func TestMemberManagementMigrationSeparatesAdministrationAndPreservesDirectoryReads(t *testing.T) {
	ctx := context.Background()
	db := openDatabaseThroughMigration(t, "0025_optional_settlements.sql")
	defer db.Close()
	statements := []string{
		`INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES('group-existing','Existing Group','EUR','2026-08-11T12:00:00Z','2026-08-11T12:00:00Z')`,
		`INSERT INTO roles(id,group_id,name,description,name_locked,deletable,version,created_at,updated_at) VALUES('role-group-admin','group-existing','Group configuration','',0,1,1,'2026-08-11T12:00:00Z','2026-08-11T12:00:00Z')`,
		`INSERT INTO roles(id,group_id,name,description,name_locked,deletable,version,created_at,updated_at) VALUES('role-directory-reader','group-existing','Directory reader','',0,1,1,'2026-08-11T12:00:00Z','2026-08-11T12:00:00Z')`,
		`INSERT INTO role_permission_grants(group_id,role_id,permission_key,scope_type,version,created_at,updated_at) VALUES('group-existing','role-group-admin','GROUP_ADMINISTRATION','GROUP',1,'2026-08-11T12:00:00Z','2026-08-11T12:00:00Z')`,
		`INSERT INTO role_permission_grants(group_id,role_id,permission_key,scope_type,version,created_at,updated_at) VALUES('group-existing','role-directory-reader','VIEW_MEMBER_DIRECTORY','GROUP',1,'2026-08-11T12:00:00Z','2026-08-11T12:00:00Z')`,
	}
	for index, statement := range statements {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("seed member-management migration fixture %d: %v", index, err)
		}
	}

	if err := Migrate(ctx, db); err != nil {
		t.Fatalf("apply member-management migration: %v", err)
	}

	var implication string
	if err := db.QueryRowContext(ctx, `SELECT implied_permissions_json FROM permission_definitions WHERE key='MEMBER_MANAGEMENT'`).Scan(&implication); err != nil {
		t.Fatalf("read member-management definition: %v", err)
	}
	if implication != `["VIEW_MEMBER_DIRECTORY"]` {
		t.Fatalf("member-management implication = %q, want directory read", implication)
	}

	var migratedGrantCount, preservedReadCount, widenedReaderCount int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM role_permission_grants WHERE role_id='role-group-admin' AND permission_key='MEMBER_MANAGEMENT' AND scope_type='GROUP'`).Scan(&migratedGrantCount); err != nil {
		t.Fatalf("read migrated administration grant: %v", err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM role_permission_grants WHERE role_id='role-directory-reader' AND permission_key='VIEW_MEMBER_DIRECTORY' AND scope_type='GROUP'`).Scan(&preservedReadCount); err != nil {
		t.Fatalf("read preserved directory grant: %v", err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM role_permission_grants WHERE role_id='role-directory-reader' AND permission_key='MEMBER_MANAGEMENT'`).Scan(&widenedReaderCount); err != nil {
		t.Fatalf("check directory-reader widening: %v", err)
	}
	if migratedGrantCount != 1 || preservedReadCount != 1 || widenedReaderCount != 0 {
		t.Fatalf("migration grants = %d/%d/%d, want 1/1/0", migratedGrantCount, preservedReadCount, widenedReaderCount)
	}
}
