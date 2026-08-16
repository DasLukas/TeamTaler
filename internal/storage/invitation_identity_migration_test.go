package storage

import (
	"context"
	"testing"
)

func TestInvitationIdentityBindingMigrationAddsStableUserReference(t *testing.T) {
	ctx := context.Background()
	database := openDatabaseThroughMigration(t, "0033_invitation_identity_binding.sql")
	defer database.Close()

	const now = "2026-08-16T12:00:00Z"
	if _, err := database.ExecContext(ctx, `INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at)
		VALUES('user-one','one@example.test','One','hash',?,?)`, now, now); err != nil {
		t.Fatalf("insert target account: %v", err)
	}
	if _, err := database.ExecContext(ctx, `INSERT INTO groups(id,name,currency,status,created_at,updated_at)
		VALUES('group-one','One','EUR','ACTIVE',?,?)`, now, now); err != nil {
		t.Fatalf("insert group: %v", err)
	}
	insert := `INSERT INTO invitations(id,group_id,email,token_hash,expires_at,created_by,created_at,target_user_id)
		VALUES(?,?,?,?,?,?,?,?)`
	if _, err := database.ExecContext(ctx, insert, "invitation-one", "group-one", "one@example.test", "hash-one", "2099-01-01T00:00:00Z", "user-one", now, "user-one"); err != nil {
		t.Fatalf("insert stable invitation target: %v", err)
	}
	if _, err := database.ExecContext(ctx, insert, "invitation-invalid", "group-one", "other@example.test", "hash-two", "2099-01-01T00:00:00Z", "user-one", now, "missing-user"); err == nil {
		t.Fatal("unknown stable invitation target unexpectedly passed foreign-key validation")
	}

	var targetUserID string
	if err := database.QueryRowContext(ctx, `SELECT target_user_id FROM invitations WHERE id='invitation-one'`).Scan(&targetUserID); err != nil {
		t.Fatalf("read stable invitation target: %v", err)
	}
	if targetUserID != "user-one" {
		t.Fatalf("target_user_id=%q, want user-one", targetUserID)
	}
}
