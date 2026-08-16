package auth

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

func TestCredentiallessIdentityCannotAuthenticateEvenWithPersistedSession(t *testing.T) {
	ctx := context.Background()
	db, err := storage.Open(ctx, filepath.Join(t.TempDir(), "credentialless-auth.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer db.Close()
	now := "2026-08-08T12:00:00Z"
	if _, err := db.ExecContext(ctx, `INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('managed-user',NULL,'Managed',NULL,?,?)`, now, now); err != nil {
		t.Fatalf("insert managed identity: %v", err)
	}
	service := Service{DB: db, SessionLifetime: time.Hour}
	if _, err := service.Login(ctx, "managed@example.test", "irrelevant-password"); !errors.Is(err, domain.ErrUnauthenticated) {
		t.Fatalf("managed login error=%v, want unauthenticated", err)
	}

	// Simulate a legacy or externally corrupted session to verify the service
	// query independently rejects credential-less users.
	if _, err := db.ExecContext(ctx, `DROP TRIGGER sessions_require_credentials`); err != nil {
		t.Fatalf("drop session guard for legacy fixture: %v", err)
	}
	token := "legacy-managed-session"
	if _, err := db.ExecContext(ctx, `INSERT INTO sessions(id_hash,user_id,csrf_hash,expires_at,last_seen_at,created_at) VALUES(?,?,?,?,?,?)`,
		platform.HashSecret(token), "managed-user", platform.HashSecret("csrf"), "2099-01-01T00:00:00Z", now, now); err != nil {
		t.Fatalf("insert legacy managed session: %v", err)
	}
	if _, err := service.Authenticate(ctx, token, ""); !errors.Is(err, domain.ErrUnauthenticated) {
		t.Fatalf("authenticate managed legacy session error=%v, want unauthenticated", err)
	}
}

func TestAcceptClaimInvitationUpgradesManagedIdentityInPlace(t *testing.T) {
	ctx := context.Background()
	db, service := newClaimFixture(t, ctx)
	defer db.Close()

	seedClaimTarget(t, ctx, db, "managed-user", "managed-member", "Managed Guest", "managed guest", "claim-in-place", "claimed@example.test")
	session, membership, err := service.AcceptInvitation(ctx, InvitationAcceptance{
		Token: "claim-in-place", DisplayName: "Claimed Guest", Password: "claim-password-long",
	})
	if err != nil {
		t.Fatalf("accept in-place claim: %v", err)
	}
	if session.Principal.UserID != "managed-user" || membership.ID != "managed-member" || membership.UserID != "managed-user" {
		t.Fatalf("claimed identity/session=%#v membership=%#v", session.Principal, membership)
	}
	if membership.Email == nil || *membership.Email != "claimed@example.test" || membership.IsTemporaryGuest {
		t.Fatalf("claimed membership email/isTemporaryGuest=%v/%v", membership.Email, membership.IsTemporaryGuest)
	}
	var email, nameKey any
	if err := db.QueryRowContext(ctx, `SELECT u.email,m.temporary_guest_name_key FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.id='managed-member'`).Scan(&email, &nameKey); err != nil {
		t.Fatalf("read claimed membership: %v", err)
	}
	if email != "claimed@example.test" || nameKey != nil {
		t.Fatalf("claimed email/name key=%v/%v, want email and released key", email, nameKey)
	}
	assertClaimedRoles(t, ctx, db, "managed-member", "role:MEMBER:group-claim")
	if _, err := service.Login(ctx, "claimed@example.test", "claim-password-long"); err != nil {
		t.Fatalf("login claimed account: %v", err)
	}
}

func TestAcceptClaimInvitationRebindsExistingAccountWithoutMergingMemberships(t *testing.T) {
	ctx := context.Background()
	db, service := newClaimFixture(t, ctx)
	defer db.Close()
	passwordHash, err := HashPassword("existing-password-long")
	if err != nil {
		t.Fatalf("hash existing password: %v", err)
	}
	now := "2026-08-08T12:00:00Z"
	if _, err := db.ExecContext(ctx, `INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('existing-user','existing@example.test','Existing User',?,?,?)`, passwordHash, now, now); err != nil {
		t.Fatalf("insert existing account: %v", err)
	}
	seedClaimTarget(t, ctx, db, "managed-user", "managed-member", "Managed Guest", "managed guest", "claim-existing", "existing@example.test")

	_, membership, err := service.AcceptInvitation(ctx, InvitationAcceptance{Token: "claim-existing", Password: "existing-password-long", ExpectedAccountState: InvitationAccountExisting})
	if err != nil {
		t.Fatalf("accept existing-account claim: %v", err)
	}
	if membership.ID != "managed-member" || membership.UserID != "existing-user" || membership.DisplayName != "Existing User" {
		t.Fatalf("rebound membership=%#v", membership)
	}
	var managedUsers, rebound int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM users WHERE id='managed-user'`).Scan(&managedUsers); err != nil {
		t.Fatalf("count retired managed identity: %v", err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM memberships WHERE id='managed-member' AND user_id='existing-user' AND temporary_guest_name_key IS NULL`).Scan(&rebound); err != nil {
		t.Fatalf("read rebound membership: %v", err)
	}
	if managedUsers != 0 || rebound != 1 {
		t.Fatalf("managed users/rebound memberships=%d/%d, want 0/1", managedUsers, rebound)
	}
	assertClaimedRoles(t, ctx, db, "managed-member", "role:MEMBER:group-claim")
}

func TestAcceptClaimInvitationRejectsExistingSameGroupMembership(t *testing.T) {
	for _, membershipStatus := range []string{"ACTIVE", "ARCHIVED"} {
		t.Run(membershipStatus, func(t *testing.T) {
			ctx := context.Background()
			db, service := newClaimFixture(t, ctx)
			defer db.Close()
			passwordHash, err := HashPassword("existing-password-long")
			if err != nil {
				t.Fatalf("hash existing password: %v", err)
			}
			now := "2026-08-08T12:00:00Z"
			if _, err := db.ExecContext(ctx, `INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('existing-user','existing@example.test','Existing User',?,?,?)`, passwordHash, now, now); err != nil {
				t.Fatalf("seed existing account: %v", err)
			}
			if _, err := db.ExecContext(ctx, `INSERT INTO memberships(id,group_id,user_id,status,joined_at) VALUES('existing-member','group-claim','existing-user',?,?)`, membershipStatus, now); err != nil {
				t.Fatalf("seed %s existing membership: %v", membershipStatus, err)
			}
			if membershipStatus == "ACTIVE" {
				if _, err := db.ExecContext(ctx, `INSERT INTO membership_role_assignments(group_id,membership_id,role_id,assigned_at) VALUES('group-claim','existing-member','role:MEMBER:group-claim',?)`, now); err != nil {
					t.Fatalf("seed existing membership role: %v", err)
				}
			}
			seedClaimTarget(t, ctx, db, "managed-user", "managed-member", "Managed Guest", "managed guest", "claim-conflict", "existing@example.test")

			_, _, err = service.AcceptInvitation(ctx, InvitationAcceptance{Token: "claim-conflict", Password: "existing-password-long", ExpectedAccountState: InvitationAccountExisting})
			if !errors.Is(err, domain.ErrConflict) {
				t.Fatalf("same-group %s claim error=%v, want conflict", membershipStatus, err)
			}
			var unchanged int
			if err := db.QueryRowContext(ctx, `SELECT count(*) FROM memberships WHERE id='managed-member' AND user_id='managed-user' AND temporary_guest_name_key='managed guest'`).Scan(&unchanged); err != nil || unchanged != 1 {
				t.Fatalf("rolled-back managed membership=%d err=%v, want unchanged", unchanged, err)
			}
			var persistedStatus string
			if err := db.QueryRowContext(ctx, `SELECT status FROM memberships WHERE id='existing-member' AND user_id='existing-user'`).Scan(&persistedStatus); err != nil || persistedStatus != membershipStatus {
				t.Fatalf("existing membership status=%q err=%v, want %q", persistedStatus, err, membershipStatus)
			}
		})
	}
}

func newClaimFixture(t *testing.T, ctx context.Context) (*sql.DB, Service) {
	t.Helper()
	db, err := storage.Open(ctx, filepath.Join(t.TempDir(), "claim.db"))
	if err != nil {
		t.Fatalf("open claim database: %v", err)
	}
	seed := []string{
		`INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('admin-user','admin@example.test','Admin','hash','2026-08-08T12:00:00Z','2026-08-08T12:00:00Z')`,
		`INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES('group-claim','Claim Group','EUR','2026-08-08T12:00:00Z','2026-08-08T12:00:00Z')`,
		`INSERT INTO group_settings(group_id,members_can_view_all_bookings,notification_emails_enabled,default_role_id,updated_at) VALUES('group-claim',0,0,'role:MEMBER:group-claim','2026-08-08T12:00:00Z')`,
		`INSERT INTO memberships(id,group_id,user_id,status,joined_at) VALUES('admin-member','group-claim','admin-user','ACTIVE','2026-08-08T12:00:00Z')`,
	}
	for index, statement := range seed {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			db.Close()
			t.Fatalf("seed claim fixture %d: %v", index, err)
		}
	}
	return db, Service{DB: db, SessionLifetime: time.Hour}
}

func seedClaimTarget(t *testing.T, ctx context.Context, db *sql.DB, userID, membershipID, displayName, nameKey, token, email string) {
	t.Helper()
	now := "2026-08-08T12:00:00Z"
	statements := []struct {
		query string
		args  []any
	}{
		{`INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES(?,NULL,?,NULL,?,?)`, []any{userID, displayName, now, now}},
		{`INSERT INTO memberships(id,group_id,user_id,status,joined_at,temporary_guest_name_key) VALUES(?,'group-claim',?,'ACTIVE',?,?)`, []any{membershipID, userID, now, nameKey}},
		{`INSERT INTO invitations(id,group_id,email,token_hash,expires_at,created_by,created_at,target_membership_id) VALUES(?,'group-claim',?,?,?,'admin-user',?,?)`, []any{"invitation-" + membershipID, email, platform.HashSecret(token), "2099-01-01T00:00:00Z", now, membershipID}},
		{`INSERT INTO invitation_role_assignments(group_id,invitation_id,role_id,assigned_at,assigned_by) VALUES('group-claim',?,'role:MEMBER:group-claim',?,'admin-user')`, []any{"invitation-" + membershipID, now}},
	}
	for index, statement := range statements {
		if _, err := db.ExecContext(ctx, statement.query, statement.args...); err != nil {
			t.Fatalf("seed claim target %d: %v", index, err)
		}
	}
}

func assertClaimedRoles(t *testing.T, ctx context.Context, db *sql.DB, membershipID string, expectedRoleID string) {
	t.Helper()
	var roleCount, expectedRoleCount int
	if err := db.QueryRowContext(ctx, `SELECT count(*),sum(CASE WHEN role_id=? THEN 1 ELSE 0 END) FROM membership_role_assignments WHERE membership_id=?`, expectedRoleID, membershipID).Scan(&roleCount, &expectedRoleCount); err != nil {
		t.Fatalf("read claimed roles: %v", err)
	}
	if roleCount != 1 || expectedRoleCount != 1 {
		t.Fatalf("claimed role counts=%d/%d, want exactly %s", roleCount, expectedRoleCount, expectedRoleID)
	}
}
