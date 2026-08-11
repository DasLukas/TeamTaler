package auth_test

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/DasLukas/TeamTaler/internal/auth"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

func TestPasswordChangeRevokesEverySessionAndRejectsReuse(t *testing.T) {
	ctx, service, db, password, cleanup := newAccountSecurityService(t)
	defer cleanup()
	first, err := service.Login(ctx, "admin@example.test", password)
	if err != nil {
		t.Fatalf("first login: %v", err)
	}
	second, err := service.Login(ctx, "admin@example.test", password)
	if err != nil {
		t.Fatalf("second login: %v", err)
	}
	if err := service.ChangePassword(ctx, first.Principal, password, password); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("password reuse error=%v, want validation", err)
	}
	if err := service.ChangePassword(ctx, first.Principal, password, "new-password-that-is-long"); err != nil {
		t.Fatalf("change password: %v", err)
	}
	assertSessionRevoked(t, service, first)
	assertSessionRevoked(t, service, second)
	if _, err := service.Login(ctx, "admin@example.test", password); !errors.Is(err, domain.ErrUnauthenticated) {
		t.Fatalf("old password login error=%v, want unauthenticated", err)
	}
	if _, err := service.Login(ctx, "admin@example.test", "new-password-that-is-long"); err != nil {
		t.Fatalf("new password login: %v", err)
	}
	assertGlobalAudit(t, db, "account.password.changed")
}

func TestPasswordResetIsOneTimeAndConfirmationDoesNotRequireSMTP(t *testing.T) {
	ctx, service, db, _, cleanup := newAccountSecurityService(t)
	defer cleanup()
	if err := service.StartPasswordReset(ctx, "unknown@example.test"); err != nil {
		t.Fatalf("unknown reset request: %v", err)
	}
	var unknownCount int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM account_security_actions`).Scan(&unknownCount); err != nil || unknownCount != 0 {
		t.Fatalf("unknown account actions=%d err=%v", unknownCount, err)
	}
	if err := service.StartPasswordReset(ctx, "ADMIN@EXAMPLE.TEST"); err != nil {
		t.Fatalf("start reset: %v", err)
	}
	token := openPendingAccountToken(t, ctx, db, service, "PASSWORD_RESET")
	service.EmailDeliveryAvailable = false
	if err := service.ConfirmPasswordReset(ctx, token, "reset-password-that-is-long"); err != nil {
		t.Fatalf("confirm reset after SMTP disabled: %v", err)
	}
	if err := service.ConfirmPasswordReset(ctx, token, "another-reset-password-long"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("reused reset token error=%v, want not found", err)
	}
	if _, err := service.Login(ctx, "admin@example.test", "reset-password-that-is-long"); err != nil {
		t.Fatalf("login with reset password: %v", err)
	}
	assertGlobalAudit(t, db, "account.password.reset")
}

func TestEmailChangeConfirmsNewMailboxAndRevokesSessions(t *testing.T) {
	ctx, service, db, password, cleanup := newAccountSecurityService(t)
	defer cleanup()
	first, err := service.Login(ctx, "admin@example.test", password)
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	second, err := service.Login(ctx, "admin@example.test", password)
	if err != nil {
		t.Fatalf("second login: %v", err)
	}
	if err := service.StartEmailChange(ctx, first.Principal, "new@example.test", password); err != nil {
		t.Fatalf("start email change: %v", err)
	}
	token := openPendingAccountToken(t, ctx, db, service, "EMAIL_CHANGE")
	service.EmailDeliveryAvailable = false
	if err := service.ConfirmEmailChange(ctx, token); err != nil {
		t.Fatalf("confirm email change after SMTP disabled: %v", err)
	}
	assertSessionRevoked(t, service, first)
	assertSessionRevoked(t, service, second)
	if _, err := service.Login(ctx, "admin@example.test", password); !errors.Is(err, domain.ErrUnauthenticated) {
		t.Fatalf("old email login error=%v, want unauthenticated", err)
	}
	if _, err := service.Login(ctx, "new@example.test", password); err != nil {
		t.Fatalf("new email login: %v", err)
	}
	assertGlobalAudit(t, db, "account.email.changed")
}

func TestAccountCapabilitiesRequireSMTPAndTokenEncryption(t *testing.T) {
	service := auth.Service{}
	if capabilities := service.AccountCapabilities(); capabilities.PasswordResetAvailable || capabilities.EmailChangeAvailable {
		t.Fatalf("disabled capabilities=%#v", capabilities)
	}
	box, err := platform.NewSecretBox([]byte("0123456789abcdef0123456789abcdef"))
	if err != nil {
		t.Fatalf("secret box: %v", err)
	}
	service.EmailDeliveryAvailable = true
	service.TokenSealer = box
	if capabilities := service.AccountCapabilities(); !capabilities.PasswordResetAvailable || !capabilities.EmailChangeAvailable {
		t.Fatalf("enabled capabilities=%#v", capabilities)
	}
}

func TestExpiredEmailChangeDoesNotReserveTargetMailbox(t *testing.T) {
	ctx, service, db, password, cleanup := newAccountSecurityService(t)
	defer cleanup()
	first, err := service.Login(ctx, "admin@example.test", password)
	if err != nil {
		t.Fatalf("login first account: %v", err)
	}
	if err := service.StartEmailChange(ctx, first.Principal, "target@example.test", password); err != nil {
		t.Fatalf("start first email change: %v", err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE account_security_actions SET expires_at=? WHERE kind='EMAIL_CHANGE'`, platform.Timestamp(platform.Now().Add(-time.Minute))); err != nil {
		t.Fatalf("expire first action: %v", err)
	}
	secondPassword := "second-account-password-long"
	secondHash, err := auth.HashPassword(secondPassword)
	if err != nil {
		t.Fatalf("hash second password: %v", err)
	}
	now := platform.Timestamp(platform.Now())
	if _, err := db.ExecContext(ctx, `INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at)
		VALUES('usr_second','second@example.test','Second',?,?,?)`, secondHash, now, now); err != nil {
		t.Fatalf("insert second account: %v", err)
	}
	second, err := service.Login(ctx, "second@example.test", secondPassword)
	if err != nil {
		t.Fatalf("login second account: %v", err)
	}
	if err := service.StartEmailChange(ctx, second.Principal, "TARGET@example.test", secondPassword); err != nil {
		t.Fatalf("start second email change after first expired: %v", err)
	}
	var activeOwner string
	if err := db.QueryRowContext(ctx, `SELECT user_id FROM account_security_actions
		WHERE kind='EMAIL_CHANGE' AND target_email='target@example.test' COLLATE NOCASE
		AND consumed_at IS NULL AND invalidated_at IS NULL`).Scan(&activeOwner); err != nil {
		t.Fatalf("read active target owner: %v", err)
	}
	if activeOwner != second.Principal.UserID {
		t.Fatalf("active target owner=%q, want %q", activeOwner, second.Principal.UserID)
	}
}

func newAccountSecurityService(t *testing.T) (context.Context, auth.Service, *sql.DB, string, func()) {
	t.Helper()
	ctx := context.Background()
	db, err := storage.Open(ctx, filepath.Join(t.TempDir(), "account-security.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	box, err := platform.NewSecretBox([]byte("0123456789abcdef0123456789abcdef"))
	if err != nil {
		db.Close()
		t.Fatalf("secret box: %v", err)
	}
	service := auth.Service{DB: db, SessionLifetime: 24 * time.Hour, TokenSealer: box, EmailDeliveryAvailable: true}
	password := "correct-horse-battery-staple"
	if err := service.Bootstrap(ctx, "admin@example.test", "Admin", password, "Test Group", "EUR"); err != nil {
		db.Close()
		t.Fatalf("bootstrap: %v", err)
	}
	return ctx, service, db, password, func() { _ = db.Close() }
}

func openPendingAccountToken(t *testing.T, ctx context.Context, db *sql.DB, service auth.Service, kind string) string {
	t.Helper()
	var ciphertext string
	if err := db.QueryRowContext(ctx, `SELECT o.token_ciphertext FROM account_security_email_outbox o
		JOIN account_security_actions a ON a.id=o.action_id WHERE a.kind=? AND o.status='PENDING'`, kind).Scan(&ciphertext); err != nil {
		t.Fatalf("read account token ciphertext: %v", err)
	}
	opener, ok := service.TokenSealer.(interface{ Open(string) (string, error) })
	if !ok {
		t.Fatal("configured token sealer cannot open tokens")
	}
	token, err := opener.Open(ciphertext)
	if err != nil {
		t.Fatalf("open account token: %v", err)
	}
	return token
}

func assertSessionRevoked(t *testing.T, service auth.Service, session auth.Session) {
	t.Helper()
	if _, err := service.Authenticate(context.Background(), session.Token, session.CSRFToken); !errors.Is(err, domain.ErrUnauthenticated) {
		t.Fatalf("authenticate revoked session error=%v, want unauthenticated", err)
	}
}

func assertGlobalAudit(t *testing.T, db *sql.DB, action string) {
	t.Helper()
	var groupID, metadata sql.NullString
	if err := db.QueryRow(`SELECT group_id,metadata_json FROM audit_events WHERE action=? ORDER BY occurred_at DESC LIMIT 1`, action).Scan(&groupID, &metadata); err != nil {
		t.Fatalf("read %s audit: %v", action, err)
	}
	if groupID.Valid || metadata.String != "{}" {
		t.Fatalf("audit group=%#v metadata=%q, want global empty metadata", groupID, metadata.String)
	}
}
