package auth_test

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/DasLukas/TeamTaler/internal/auth"
	"github.com/DasLukas/TeamTaler/internal/authorization"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/groups"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

func TestPublicJoinRegistrationVerifiesEmailAndUsesCurrentDefaultRole(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	db, err := storage.Open(ctx, filepath.Join(t.TempDir(), "public-join-registration.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer db.Close()
	box, err := platform.NewSecretBox([]byte("0123456789abcdef0123456789abcdef"))
	if err != nil {
		t.Fatalf("secret box: %v", err)
	}
	authService := auth.Service{DB: db, SessionLifetime: 24 * time.Hour, TokenSealer: box, EmailDeliveryAvailable: true}
	if err := authService.Bootstrap(ctx, "admin@example.test", "Admin", "correct-horse-battery-staple", "Join Group", "EUR"); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	adminSession, err := authService.Login(ctx, "admin@example.test", "correct-horse-battery-staple")
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	groupService := groups.Service{DB: db, TokenSealer: box, TokenOpener: box, EmailDeliveryAvailable: true}
	groupItems, err := groupService.List(ctx, adminSession.Principal.UserID)
	if err != nil || len(groupItems) != 1 {
		t.Fatalf("list groups: groups=%d err=%v", len(groupItems), err)
	}
	adminMembership := groupItems[0].Membership
	link, err := groupService.PutPublicJoinLink(ctx, adminSession.Principal, adminMembership, true, nil, 0)
	if err != nil {
		t.Fatalf("create public join link: %v", err)
	}
	if err := authService.StartPublicJoinRegistration(ctx, auth.PublicJoinRegistration{
		JoinToken: link.Token, Email: "NEW@Example.test", DisplayName: "New Member", Password: "new-member-password-long",
	}); err != nil {
		t.Fatalf("start registration: %v", err)
	}

	financeRoleID := authorization.PresetRoleID(adminMembership.GroupID, domain.RolePresetFinanceManager)
	if _, err := groupService.UpdateSettings(ctx, adminSession.Principal, adminMembership, groups.SettingsUpdate{DefaultRoleID: &financeRoleID}); err != nil {
		t.Fatalf("change current default role: %v", err)
	}
	var encryptedVerificationToken string
	if err := db.QueryRowContext(ctx, `SELECT token_ciphertext FROM public_join_email_outbox WHERE group_id=? AND status='PENDING'`, adminMembership.GroupID).Scan(&encryptedVerificationToken); err != nil {
		t.Fatalf("read verification outbox: %v", err)
	}
	verificationToken, err := box.Open(encryptedVerificationToken)
	if err != nil {
		t.Fatalf("open verification token: %v", err)
	}
	joinedSession, joinedMembership, err := authService.ConfirmPublicJoinRegistration(ctx, verificationToken)
	if err != nil {
		t.Fatalf("confirm registration: %v", err)
	}
	if joinedSession.Token == "" || joinedSession.CSRFToken == "" || joinedMembership.GroupID != adminMembership.GroupID || joinedSession.Principal.Email != "new@example.test" {
		t.Fatalf("joined session=%#v membership=%#v", joinedSession, joinedMembership)
	}
	var assignedRoleID string
	if err := db.QueryRowContext(ctx, `SELECT role_id FROM membership_role_assignments WHERE group_id=? AND membership_id=?`, adminMembership.GroupID, joinedMembership.ID).Scan(&assignedRoleID); err != nil {
		t.Fatalf("read assigned default role: %v", err)
	}
	if assignedRoleID != financeRoleID {
		t.Fatalf("assigned role=%q, want current default %q", assignedRoleID, financeRoleID)
	}
	if _, _, err := authService.ConfirmPublicJoinRegistration(ctx, verificationToken); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("reused verification token error=%v, want not found", err)
	}
	var outboxStatus string
	var outboxToken any
	if err := db.QueryRowContext(ctx, `SELECT status,token_ciphertext FROM public_join_email_outbox WHERE group_id=?`, adminMembership.GroupID).Scan(&outboxStatus, &outboxToken); err != nil || outboxStatus != "CANCELLED" || outboxToken != nil {
		t.Fatalf("consumed outbox status=%q token=%#v err=%v", outboxStatus, outboxToken, err)
	}
}

func TestAuthenticatedPublicJoinReactivatesWithOnlyCurrentDefaultRole(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	db, err := storage.Open(ctx, filepath.Join(t.TempDir(), "public-join-reactivation.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer db.Close()
	box, err := platform.NewSecretBox([]byte("0123456789abcdef0123456789abcdef"))
	if err != nil {
		t.Fatalf("secret box: %v", err)
	}
	authService := auth.Service{DB: db, SessionLifetime: 24 * time.Hour}
	if err := authService.Bootstrap(ctx, "admin@example.test", "Admin", "correct-horse-battery-staple", "Join Group", "EUR"); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	adminSession, err := authService.Login(ctx, "admin@example.test", "correct-horse-battery-staple")
	if err != nil {
		t.Fatalf("admin login: %v", err)
	}
	groupService := groups.Service{DB: db, TokenSealer: box, TokenOpener: box, EmailDeliveryAvailable: true}
	groupItems, err := groupService.List(ctx, adminSession.Principal.UserID)
	if err != nil || len(groupItems) != 1 {
		t.Fatalf("list groups: groups=%d err=%v", len(groupItems), err)
	}
	adminMembership := groupItems[0].Membership
	link, err := groupService.PutPublicJoinLink(ctx, adminSession.Principal, adminMembership, true, nil, 0)
	if err != nil {
		t.Fatalf("create public join link: %v", err)
	}

	passwordHash, err := auth.HashPassword("existing-password-long")
	if err != nil {
		t.Fatalf("hash existing password: %v", err)
	}
	userID := "usr_existing_public_join"
	now := platform.Timestamp(platform.Now())
	if _, err := db.ExecContext(ctx, `INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,?)`, userID, "existing@example.test", "Existing Member", passwordHash, now, now); err != nil {
		t.Fatalf("insert existing account: %v", err)
	}
	existingSession, err := authService.Login(ctx, "existing@example.test", "existing-password-long")
	if err != nil {
		t.Fatalf("existing login: %v", err)
	}
	joined, err := authService.AcceptPublicJoinLink(ctx, existingSession.Principal, link.Token)
	if err != nil {
		t.Fatalf("join existing account: %v", err)
	}
	memberRoleID := authorization.PresetRoleID(adminMembership.GroupID, domain.RolePresetMember)
	assertOnlyAssignedRole(t, db, adminMembership.GroupID, joined.ID, memberRoleID)

	financeRoleID := authorization.PresetRoleID(adminMembership.GroupID, domain.RolePresetFinanceManager)
	if _, err := db.ExecContext(ctx, `INSERT INTO membership_role_assignments(group_id,membership_id,role_id,version,assigned_at,assigned_by) VALUES(?,?,?,1,?,?)`, adminMembership.GroupID, joined.ID, financeRoleID, now, adminSession.Principal.UserID); err != nil {
		t.Fatalf("assign second role: %v", err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE memberships SET status='ARCHIVED',archived_at=? WHERE id=? AND group_id=?`, now, joined.ID, adminMembership.GroupID); err != nil {
		t.Fatalf("archive membership: %v", err)
	}
	catalogRoleID := authorization.PresetRoleID(adminMembership.GroupID, domain.RolePresetCatalogManager)
	if _, err := groupService.UpdateSettings(ctx, adminSession.Principal, adminMembership, groups.SettingsUpdate{DefaultRoleID: &catalogRoleID}); err != nil {
		t.Fatalf("change default role: %v", err)
	}
	reactivated, err := authService.AcceptPublicJoinLink(ctx, existingSession.Principal, link.Token)
	if err != nil || reactivated.ID != joined.ID || reactivated.Status != "ACTIVE" {
		t.Fatalf("reactivated membership=%#v err=%v", reactivated, err)
	}
	assertOnlyAssignedRole(t, db, adminMembership.GroupID, joined.ID, catalogRoleID)
}

func assertOnlyAssignedRole(t *testing.T, db *sql.DB, groupID, membershipID, expectedRoleID string) {
	t.Helper()
	rows, err := db.QueryContext(context.Background(), `SELECT role_id FROM membership_role_assignments WHERE group_id=? AND membership_id=? ORDER BY role_id`, groupID, membershipID)
	if err != nil {
		t.Fatalf("query assigned roles: %v", err)
	}
	defer rows.Close()
	var roleIDs []string
	for rows.Next() {
		var roleID string
		if err := rows.Scan(&roleID); err != nil {
			t.Fatalf("scan assigned role: %v", err)
		}
		roleIDs = append(roleIDs, roleID)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate assigned roles: %v", err)
	}
	if len(roleIDs) != 1 || roleIDs[0] != expectedRoleID {
		t.Fatalf("assigned roles=%v, want only %q", roleIDs, expectedRoleID)
	}
}
