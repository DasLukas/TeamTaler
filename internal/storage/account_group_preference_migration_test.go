package storage

import (
	"context"
	"database/sql"
	"testing"
)

func TestAccountGroupPreferenceMigrationPreservesUsersAndValidatesGroupReferences(t *testing.T) {
	ctx := context.Background()
	db := openDatabaseThroughMigration(t, "0028_system_role_semantics.sql")
	defer db.Close()

	const now = "2026-08-15T10:00:00Z"
	if _, err := db.ExecContext(ctx, `INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('user-one','one@example.test','One','hash',?,?)`, now, now); err != nil {
		t.Fatalf("insert existing user: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES('group-one','One','EUR',?,?)`, now, now); err != nil {
		t.Fatalf("insert existing group: %v", err)
	}
	if err := Migrate(ctx, db); err != nil {
		t.Fatalf("apply account group-preference migration: %v", err)
	}

	var defaultGroupID, lastUsedGroupID sql.NullString
	if err := db.QueryRowContext(ctx, `SELECT default_group_id,last_used_group_id FROM users WHERE id='user-one'`).Scan(&defaultGroupID, &lastUsedGroupID); err != nil {
		t.Fatalf("read migrated preference: %v", err)
	}
	if defaultGroupID.Valid || lastUsedGroupID.Valid {
		t.Fatalf("migrated preference=%q/%q, want NULL/NULL", defaultGroupID.String, lastUsedGroupID.String)
	}
	if _, err := db.ExecContext(ctx, `UPDATE users SET default_group_id='group-missing' WHERE id='user-one'`); err == nil {
		t.Fatal("unknown default group unexpectedly passed foreign-key validation")
	}
	if _, err := db.ExecContext(ctx, `UPDATE users SET default_group_id='group-one',last_used_group_id='group-one' WHERE id='user-one'`); err != nil {
		t.Fatalf("set valid group references: %v", err)
	}
}
