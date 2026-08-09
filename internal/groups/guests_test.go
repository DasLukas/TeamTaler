package groups

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/DasLukas/TeamTaler/internal/auth"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

func TestManagedGuestNameConstraintErrorCanBeResolvedAfterStatementFailure(t *testing.T) {
	ctx := context.Background()
	db, err := storage.Open(ctx, filepath.Join(t.TempDir(), "managed-guest-name.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer db.Close()

	authService := auth.Service{DB: db, SessionLifetime: 24 * time.Hour}
	if err := authService.Bootstrap(ctx, "admin@example.test", "Admin", "correct-horse-battery-staple", "Guest Group", "EUR"); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	session, err := authService.Login(ctx, "admin@example.test", "correct-horse-battery-staple")
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	service := Service{DB: db}
	groupItems, err := service.List(ctx, session.Principal.UserID)
	if err != nil || len(groupItems) != 1 {
		t.Fatalf("list groups: groups=%d err=%v", len(groupItems), err)
	}
	groupID := groupItems[0].ID
	now := "2026-08-08T12:00:00Z"
	for index, statement := range []string{
		`INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('managed-one',NULL,'Guest One',NULL,'2026-08-08T12:00:00Z','2026-08-08T12:00:00Z')`,
		`INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('managed-two',NULL,'Guest Two',NULL,'2026-08-08T12:00:00Z','2026-08-08T12:00:00Z')`,
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("seed managed identity %d: %v", index, err)
		}
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO memberships(id,group_id,user_id,status,joined_at,managed_guest_name_key) VALUES('managed-member-one',?,'managed-one','ACTIVE',?,'guest one')`, groupID, now); err != nil {
		t.Fatalf("seed first managed membership: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO memberships(id,group_id,user_id,status,joined_at,managed_guest_name_key) VALUES('managed-member-two',?,'managed-two','ACTIVE',?,'guest two')`, groupID, now); err != nil {
		t.Fatalf("seed second managed membership: %v", err)
	}

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatalf("begin transaction: %v", err)
	}
	defer tx.Rollback()
	_, constraintErr := tx.ExecContext(ctx, `UPDATE memberships SET managed_guest_name_key='guest two' WHERE id='managed-member-one' AND group_id=?`, groupID)
	if constraintErr == nil {
		t.Fatal("duplicate managed guest name unexpectedly passed")
	}
	mapped := mapManagedGuestNameConstraintError(ctx, tx, groupID, "guest two", "managed-member-one", constraintErr)
	var conflict ManagedGuestNameConflictError
	if !errors.As(mapped, &conflict) || conflict.MembershipID != "managed-member-two" {
		t.Fatalf("mapped conflict=%v (%#v), want managed-member-two", mapped, conflict)
	}
}
