package integration_test

import (
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/platform"
)

func TestProfileUpdateIsGlobalValidatedAndAudited(t *testing.T) {
	f := newFixture(t)
	secondGroup, err := f.groups.Create(f.ctx, f.admin, "Second Team", "EUR")
	if err != nil {
		t.Fatalf("create second group: %v", err)
	}
	if secondGroup.Membership.UserID != f.admin.UserID {
		t.Fatalf("second-group user=%q, want %q", secondGroup.Membership.UserID, f.admin.UserID)
	}

	updated, err := f.auth.UpdateProfile(f.ctx, f.admin, "  Renamed Admin  ")
	if err != nil {
		t.Fatalf("update profile: %v", err)
	}
	if updated.UserID != f.admin.UserID || updated.DisplayName != "Renamed Admin" {
		t.Fatalf("updated principal=%#v, want preserved ID and trimmed display name", updated)
	}

	groups, err := f.groups.List(f.ctx, f.admin.UserID)
	if err != nil {
		t.Fatalf("list groups after profile update: %v", err)
	}
	if len(groups) != 2 {
		t.Fatalf("group count=%d, want 2", len(groups))
	}
	for _, group := range groups {
		if group.Membership.UserID != f.admin.UserID || group.Membership.DisplayName != "Renamed Admin" {
			t.Fatalf("group %q membership=%#v, want shared user and updated display name", group.ID, group.Membership)
		}
	}

	var auditCount int
	if err := f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM audit_events
		WHERE group_id IS NULL AND actor_user_id=? AND actor_membership_id IS NULL
		AND action='account.profile.updated' AND resource_type='user' AND resource_id=?`,
		f.admin.UserID, f.admin.UserID).Scan(&auditCount); err != nil {
		t.Fatalf("count global profile audit: %v", err)
	}
	if auditCount != 1 {
		t.Fatalf("global profile audit count=%d, want 1", auditCount)
	}

	for name, displayName := range map[string]string{
		"blank after trimming": " \t ",
		"control character":    "Admin\nName",
		"more than 120 runes":  strings.Repeat("ä", 121),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := f.auth.UpdateProfile(f.ctx, updated, displayName); !errors.Is(err, domain.ErrValidation) {
				t.Fatalf("UpdateProfile error=%v, want validation", err)
			}
		})
	}

	var storedName string
	if err := f.db.QueryRowContext(f.ctx, `SELECT display_name FROM users WHERE id=?`, f.admin.UserID).Scan(&storedName); err != nil {
		t.Fatalf("read display name after rejected updates: %v", err)
	}
	if storedName != "Renamed Admin" {
		t.Fatalf("display name after rejected updates=%q, want Renamed Admin", storedName)
	}
}

func TestConcurrentEmailChangeConfirmationConsumesTokenOnce(t *testing.T) {
	f := newFixture(t)
	box, err := platform.NewSecretBox([]byte("0123456789abcdef0123456789abcdef"))
	if err != nil {
		t.Fatalf("create account-security token box: %v", err)
	}
	f.auth.TokenSealer = box
	f.auth.EmailDeliveryAvailable = true
	if err := f.auth.StartEmailChange(f.ctx, f.admin, "concurrent@example.test", testPassword); err != nil {
		t.Fatalf("start email change: %v", err)
	}
	token := openPendingAccountSecurityToken(t, f, box, "EMAIL_CHANGE")

	const attempts = 8
	start := make(chan struct{})
	results := make(chan error, attempts)
	var workers sync.WaitGroup
	workers.Add(attempts)
	for range attempts {
		go func() {
			defer workers.Done()
			<-start
			results <- f.auth.ConfirmEmailChange(f.ctx, token)
		}()
	}
	close(start)
	workers.Wait()
	close(results)

	successes := 0
	neutralFailures := 0
	for err := range results {
		switch {
		case err == nil:
			successes++
		case errors.Is(err, domain.ErrNotFound), errors.Is(err, domain.ErrConflict):
			neutralFailures++
		default:
			t.Fatalf("concurrent confirmation returned unexpected error: %v", err)
		}
	}
	if successes != 1 || neutralFailures != attempts-1 {
		t.Fatalf("concurrent confirmations: successes=%d neutral failures=%d, want 1 and %d", successes, neutralFailures, attempts-1)
	}
	var email string
	if err := f.db.QueryRowContext(f.ctx, `SELECT email FROM users WHERE id=?`, f.admin.UserID).Scan(&email); err != nil {
		t.Fatalf("read confirmed email: %v", err)
	}
	if email != "concurrent@example.test" {
		t.Fatalf("confirmed email=%q, want concurrent@example.test", email)
	}
}

func TestEmailChangeConflictDoesNotRevealForeignAddress(t *testing.T) {
	f := newFixture(t)
	f.inviteMember("member@example.test", "Member", nil)
	box, err := platform.NewSecretBox([]byte("0123456789abcdef0123456789abcdef"))
	if err != nil {
		t.Fatalf("create account-security token box: %v", err)
	}
	f.auth.TokenSealer = box
	f.auth.EmailDeliveryAvailable = true

	err = f.auth.StartEmailChange(f.ctx, f.admin, "MEMBER@example.test", testPassword)
	if !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("StartEmailChange error=%v, want conflict", err)
	}
	if strings.Contains(strings.ToLower(err.Error()), "member@example.test") {
		t.Fatalf("generic conflict leaked foreign address: %q", err)
	}
	var actionCount int
	if queryErr := f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM account_security_actions WHERE user_id=?`, f.admin.UserID).Scan(&actionCount); queryErr != nil {
		t.Fatalf("count account actions: %v", queryErr)
	}
	if actionCount != 0 {
		t.Fatalf("account actions after email conflict=%d, want 0", actionCount)
	}
}
