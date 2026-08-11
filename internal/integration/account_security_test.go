package integration_test

import (
	"database/sql"
	"errors"
	"strings"
	"testing"

	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/platform"
)

func TestAccountSecurityLifecyclePreservesIdentityAndRevokesSessions(t *testing.T) {
	f := newFixture(t)
	if capabilities := f.auth.AccountCapabilities(); capabilities.PasswordResetAvailable || capabilities.EmailChangeAvailable {
		t.Fatalf("unconfigured capabilities=%#v, want both false", capabilities)
	}
	if err := f.auth.StartPasswordReset(f.ctx, "admin@example.test"); !errors.Is(err, domain.ErrServiceUnavailable) {
		t.Fatalf("unconfigured password reset error=%v, want service unavailable", err)
	}
	if err := f.auth.StartEmailChange(f.ctx, f.admin, "new-admin@example.test", testPassword); !errors.Is(err, domain.ErrServiceUnavailable) {
		t.Fatalf("unconfigured email change error=%v, want service unavailable", err)
	}

	box, err := platform.NewSecretBox([]byte("0123456789abcdef0123456789abcdef"))
	if err != nil {
		t.Fatalf("create account-security token box: %v", err)
	}
	f.auth.TokenSealer = box
	f.auth.EmailDeliveryAvailable = true
	if capabilities := f.auth.AccountCapabilities(); !capabilities.PasswordResetAvailable || !capabilities.EmailChangeAvailable {
		t.Fatalf("configured capabilities=%#v, want both true", capabilities)
	}

	if _, err := f.auth.Login(f.ctx, "admin@example.test", testPassword); err != nil {
		t.Fatalf("create second pre-reset session: %v", err)
	}
	var sessionsBefore int
	if err := f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM sessions WHERE user_id=?`, f.admin.UserID).Scan(&sessionsBefore); err != nil || sessionsBefore != 2 {
		t.Fatalf("pre-reset sessions=%d err=%v, want 2", sessionsBefore, err)
	}
	var actionsBefore int
	if err := f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM account_security_actions`).Scan(&actionsBefore); err != nil {
		t.Fatalf("count initial account actions: %v", err)
	}
	for _, unknown := range []string{"missing@example.test", "not-an-email"} {
		if err := f.auth.StartPasswordReset(f.ctx, unknown); err != nil {
			t.Fatalf("non-enumerating reset request for %q: %v", unknown, err)
		}
	}
	var actionsAfterUnknown int
	if err := f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM account_security_actions`).Scan(&actionsAfterUnknown); err != nil || actionsAfterUnknown != actionsBefore {
		t.Fatalf("unknown-address actions=%d err=%v, want %d", actionsAfterUnknown, err, actionsBefore)
	}

	if err := f.auth.StartPasswordReset(f.ctx, "ADMIN@example.test"); err != nil {
		t.Fatalf("start password reset: %v", err)
	}
	resetToken := openPendingAccountSecurityToken(t, f, box, "PASSWORD_RESET")
	const resetPassword = "a-new-correct-horse-battery-staple"
	if err := f.auth.ConfirmPasswordReset(f.ctx, resetToken, resetPassword); err != nil {
		t.Fatalf("confirm password reset: %v", err)
	}
	assertNoAccountSessions(t, f, f.admin.UserID)
	assertConsumedAccountSecurityAction(t, f, "PASSWORD_RESET")
	if _, err := f.auth.Login(f.ctx, "admin@example.test", testPassword); !errors.Is(err, domain.ErrUnauthenticated) {
		t.Fatalf("old password login error=%v, want unauthenticated", err)
	}
	resetSession, err := f.auth.Login(f.ctx, "admin@example.test", resetPassword)
	if err != nil {
		t.Fatalf("login with reset password: %v", err)
	}
	if err := f.auth.ConfirmPasswordReset(f.ctx, resetToken, resetPassword); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("reset token replay error=%v, want not found", err)
	}

	if err := f.auth.StartEmailChange(f.ctx, resetSession.Principal, "new-admin@example.test", resetPassword); err != nil {
		t.Fatalf("start email change: %v", err)
	}
	emailToken := openPendingAccountSecurityToken(t, f, box, "EMAIL_CHANGE")
	if _, err := f.auth.Login(f.ctx, "admin@example.test", resetPassword); err != nil {
		t.Fatalf("current email changed before confirmation: %v", err)
	}
	if err := f.auth.ConfirmEmailChange(f.ctx, emailToken); err != nil {
		t.Fatalf("confirm email change: %v", err)
	}
	assertNoAccountSessions(t, f, f.admin.UserID)
	assertConsumedAccountSecurityAction(t, f, "EMAIL_CHANGE")
	if _, err := f.auth.Login(f.ctx, "admin@example.test", resetPassword); !errors.Is(err, domain.ErrUnauthenticated) {
		t.Fatalf("old email login error=%v, want unauthenticated", err)
	}
	changedSession, err := f.auth.Login(f.ctx, "new-admin@example.test", resetPassword)
	if err != nil {
		t.Fatalf("login with confirmed email: %v", err)
	}
	if changedSession.Principal.UserID != f.admin.UserID {
		t.Fatalf("email change user=%q, want preserved %q", changedSession.Principal.UserID, f.admin.UserID)
	}
	var membershipUserID string
	if err := f.db.QueryRowContext(f.ctx, `SELECT user_id FROM memberships WHERE id=?`, f.membership.ID).Scan(&membershipUserID); err != nil || membershipUserID != f.admin.UserID {
		t.Fatalf("email change membership user=%q err=%v, want %q", membershipUserID, err, f.admin.UserID)
	}
	if err := f.auth.ConfirmEmailChange(f.ctx, emailToken); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("email token replay error=%v, want not found", err)
	}
}

func openPendingAccountSecurityToken(t *testing.T, f *fixture, box platform.SecretBox, kind string) string {
	t.Helper()
	var ciphertext string
	if err := f.db.QueryRowContext(f.ctx, `SELECT o.token_ciphertext
		FROM account_security_actions a JOIN account_security_email_outbox o ON o.action_id=a.id
		WHERE a.user_id=? AND a.kind=? AND a.consumed_at IS NULL AND a.invalidated_at IS NULL
		AND o.status='PENDING'`, f.admin.UserID, kind).Scan(&ciphertext); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			t.Fatalf("pending %s account-security message is missing", kind)
		}
		t.Fatalf("read pending %s account-security message: %v", kind, err)
	}
	token, err := box.Open(ciphertext)
	if err != nil {
		t.Fatalf("open pending %s token: %v", kind, err)
	}
	if strings.TrimSpace(token) == "" || strings.Contains(ciphertext, token) {
		t.Fatalf("pending %s token was empty or stored in plaintext", kind)
	}
	return token
}

func assertNoAccountSessions(t *testing.T, f *fixture, userID string) {
	t.Helper()
	var count int
	if err := f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM sessions WHERE user_id=?`, userID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("sessions after sensitive account change=%d err=%v, want 0", count, err)
	}
}

func assertConsumedAccountSecurityAction(t *testing.T, f *fixture, kind string) {
	t.Helper()
	var count int
	if err := f.db.QueryRowContext(f.ctx, `SELECT count(*)
		FROM account_security_actions a JOIN account_security_email_outbox o ON o.action_id=a.id
		WHERE a.user_id=? AND a.kind=? AND a.consumed_at IS NOT NULL AND a.invalidated_at IS NULL
		AND o.status='CANCELLED' AND o.token_ciphertext IS NULL`, f.admin.UserID, kind).Scan(&count); err != nil || count != 1 {
		t.Fatalf("consumed %s action with cleared secret=%d err=%v, want 1", kind, count, err)
	}
}
