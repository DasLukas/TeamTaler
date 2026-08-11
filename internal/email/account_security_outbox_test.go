package email

import (
	"context"
	"database/sql"
	"errors"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/DasLukas/TeamTaler/internal/auth"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

const accountSecurityTestPassword = "correct-horse-battery-staple"

type recordingAccountSecuritySender struct {
	mu            sync.Mutex
	err           error
	passwordReset []AccountSecurityMessage
	emailChange   []AccountSecurityMessage
}

func (sender *recordingAccountSecuritySender) Available() bool { return true }

func (sender *recordingAccountSecuritySender) SendPasswordReset(_ context.Context, message AccountSecurityMessage) error {
	sender.mu.Lock()
	defer sender.mu.Unlock()
	sender.passwordReset = append(sender.passwordReset, message)
	return sender.err
}

func (sender *recordingAccountSecuritySender) SendEmailChangeVerification(_ context.Context, message AccountSecurityMessage) error {
	sender.mu.Lock()
	defer sender.mu.Unlock()
	sender.emailChange = append(sender.emailChange, message)
	return sender.err
}

func (sender *recordingAccountSecuritySender) snapshot() ([]AccountSecurityMessage, []AccountSecurityMessage) {
	sender.mu.Lock()
	defer sender.mu.Unlock()
	return append([]AccountSecurityMessage(nil), sender.passwordReset...), append([]AccountSecurityMessage(nil), sender.emailChange...)
}

type accountSecurityOutboxFixture struct {
	ctx        context.Context
	db         *sql.DB
	box        platform.SecretBox
	service    auth.Service
	principal  auth.Session
	sender     *recordingAccountSecuritySender
	dispatcher *AccountSecurityDispatcher
	now        time.Time
}

type accountSecurityOutboxState struct {
	status       string
	attemptCount int
	ciphertext   sql.NullString
	sentAt       sql.NullString
	leaseToken   sql.NullString
	errorCode    sql.NullString
}

func TestAccountSecurityDispatcherDeliversBothMailKindsWithFragmentTokens(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name        string
		kind        string
		start       func(*testing.T, *accountSecurityOutboxFixture)
		wantAddress string
		wantPath    string
	}{
		{
			name: "password reset", kind: "PASSWORD_RESET", wantAddress: "admin@example.test", wantPath: "/reset-password",
			start: func(t *testing.T, fixture *accountSecurityOutboxFixture) {
				if err := fixture.service.StartPasswordReset(fixture.ctx, "admin@example.test"); err != nil {
					t.Fatalf("start password reset: %v", err)
				}
			},
		},
		{
			name: "email change", kind: "EMAIL_CHANGE", wantAddress: "new@example.test", wantPath: "/email-change/confirm",
			start: func(t *testing.T, fixture *accountSecurityOutboxFixture) {
				if err := fixture.service.StartEmailChange(fixture.ctx, fixture.principal.Principal, "new@example.test", accountSecurityTestPassword); err != nil {
					t.Fatalf("start email change: %v", err)
				}
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			fixture := newAccountSecurityOutboxFixture(t)
			test.start(t, fixture)
			assertAccountSecurityProcessed(t, fixture)

			passwordMessages, emailMessages := fixture.sender.snapshot()
			var message AccountSecurityMessage
			switch test.kind {
			case "PASSWORD_RESET":
				if len(passwordMessages) != 1 || len(emailMessages) != 0 {
					t.Fatalf("password messages=%d email messages=%d", len(passwordMessages), len(emailMessages))
				}
				message = passwordMessages[0]
			case "EMAIL_CHANGE":
				if len(passwordMessages) != 0 || len(emailMessages) != 1 {
					t.Fatalf("password messages=%d email messages=%d", len(passwordMessages), len(emailMessages))
				}
				message = emailMessages[0]
			}
			actionURL, err := url.Parse(message.ActionURL)
			if err != nil || actionURL.Path != test.wantPath || actionURL.RawQuery != "" || !strings.HasPrefix(actionURL.Fragment, "token=") || strings.TrimPrefix(actionURL.Fragment, "token=") == "" {
				t.Fatalf("action URL=%q parsed=%#v err=%v", message.ActionURL, actionURL, err)
			}
			if message.ToAddress != test.wantAddress || message.ToName != "Admin" {
				t.Fatalf("unexpected message recipient: %#v", message)
			}
			state := readAccountSecurityOutboxState(t, fixture, test.kind)
			if state.status != string(OutboxStatusSent) || state.attemptCount != 1 || state.ciphertext.Valid || !state.sentAt.Valid || state.leaseToken.Valid || state.errorCode.Valid {
				t.Fatalf("unexpected sent state: %#v", state)
			}
		})
	}
}

func TestAccountSecurityDispatcherRetriesFiveTimesWithSanitizedFailure(t *testing.T) {
	t.Parallel()
	fixture := newAccountSecurityOutboxFixture(t)
	if err := fixture.service.StartPasswordReset(fixture.ctx, "admin@example.test"); err != nil {
		t.Fatalf("start password reset: %v", err)
	}
	// Keep the action valid for the complete retry schedule so this test
	// isolates delivery exhaustion from the separately covered expiry path.
	if _, err := fixture.db.ExecContext(fixture.ctx, `UPDATE account_security_actions SET expires_at=? WHERE kind='PASSWORD_RESET'`, platform.Timestamp(fixture.now.Add(24*time.Hour))); err != nil {
		t.Fatalf("extend action lifetime for retry test: %v", err)
	}
	const sensitiveTransportError = "smtp failure containing secret-token-and-password"
	fixture.sender.err = errors.New(sensitiveTransportError)

	for attempt := 1; attempt <= maximumDeliveryAttempts; attempt++ {
		assertAccountSecurityProcessed(t, fixture)
		state := readAccountSecurityOutboxState(t, fixture, "PASSWORD_RESET")
		if state.attemptCount != attempt || !state.errorCode.Valid || state.errorCode.String != string(FailureCodeDeliveryFailed) || strings.Contains(state.errorCode.String, sensitiveTransportError) {
			t.Fatalf("attempt %d state=%#v", attempt, state)
		}
		if attempt < maximumDeliveryAttempts {
			if state.status != string(OutboxStatusPending) || !state.ciphertext.Valid {
				t.Fatalf("retry attempt %d state=%#v, want pending encrypted token", attempt, state)
			}
			fixture.now = fixture.now.Add(retryDelay(attempt) + time.Second)
		} else if state.status != string(OutboxStatusFailed) || !state.ciphertext.Valid || state.sentAt.Valid || state.leaseToken.Valid {
			t.Fatalf("exhausted state=%#v", state)
		}
	}
	passwordMessages, _ := fixture.sender.snapshot()
	if len(passwordMessages) != maximumDeliveryAttempts {
		t.Fatalf("send attempts=%d, want %d", len(passwordMessages), maximumDeliveryAttempts)
	}
}

func TestAccountSecurityDispatcherRecoversExpiredLease(t *testing.T) {
	t.Parallel()
	fixture := newAccountSecurityOutboxFixture(t)
	if err := fixture.service.StartPasswordReset(fixture.ctx, "admin@example.test"); err != nil {
		t.Fatalf("start password reset: %v", err)
	}
	if _, err := fixture.db.ExecContext(fixture.ctx, `UPDATE account_security_email_outbox SET
		status='SENDING',attempt_count=1,next_attempt_at=NULL,lease_token='stale-lease',lease_until=?,updated_at=?`,
		platform.Timestamp(fixture.now.Add(-time.Minute)), platform.Timestamp(fixture.now.Add(-time.Minute))); err != nil {
		t.Fatalf("create stale lease: %v", err)
	}
	assertAccountSecurityProcessed(t, fixture)
	state := readAccountSecurityOutboxState(t, fixture, "PASSWORD_RESET")
	if state.status != string(OutboxStatusSent) || state.attemptCount != 2 || state.ciphertext.Valid || state.leaseToken.Valid {
		t.Fatalf("recovered state=%#v", state)
	}
}

func TestAccountSecurityDispatcherHandlesExhaustedExpiredLease(t *testing.T) {
	t.Parallel()
	fixture := newAccountSecurityOutboxFixture(t)
	if err := fixture.service.StartPasswordReset(fixture.ctx, "admin@example.test"); err != nil {
		t.Fatalf("start password reset: %v", err)
	}
	if _, err := fixture.db.ExecContext(fixture.ctx, `UPDATE account_security_email_outbox SET
		status='SENDING',attempt_count=5,next_attempt_at=NULL,lease_token='stale-lease',lease_until=?,updated_at=?`,
		platform.Timestamp(fixture.now.Add(-time.Minute)), platform.Timestamp(fixture.now.Add(-time.Minute))); err != nil {
		t.Fatalf("create exhausted stale lease: %v", err)
	}
	if err := fixture.service.StartEmailChange(fixture.ctx, fixture.principal.Principal, "new@example.test", accountSecurityTestPassword); err != nil {
		t.Fatalf("start email change behind exhausted lease: %v", err)
	}
	assertAccountSecurityProcessed(t, fixture)
	state := readAccountSecurityOutboxState(t, fixture, "PASSWORD_RESET")
	if state.status != string(OutboxStatusFailed) || state.attemptCount != maximumDeliveryAttempts || state.leaseToken.Valid || !state.ciphertext.Valid || !state.errorCode.Valid || state.errorCode.String != string(FailureCodeDeliveryFailed) {
		t.Fatalf("exhausted stale lease state=%#v", state)
	}
	emailState := readAccountSecurityOutboxState(t, fixture, "EMAIL_CHANGE")
	if emailState.status != string(OutboxStatusSent) || emailState.attemptCount != 1 || emailState.ciphertext.Valid || emailState.leaseToken.Valid {
		t.Fatalf("job behind exhausted stale lease state=%#v", emailState)
	}
}

func TestAccountSecurityDispatcherCancelsInvalidatedAndExpiredActions(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name     string
		kind     string
		prepare  func(*testing.T, *accountSecurityOutboxFixture)
		wantCode FailureCode
	}{
		{
			name: "invalidated", kind: "PASSWORD_RESET", wantCode: FailureCodeAccountActionInvalidated,
			prepare: func(t *testing.T, fixture *accountSecurityOutboxFixture) {
				if err := fixture.service.StartPasswordReset(fixture.ctx, "admin@example.test"); err != nil {
					t.Fatalf("start password reset: %v", err)
				}
				if _, err := fixture.db.ExecContext(fixture.ctx, `UPDATE account_security_actions SET invalidated_at=? WHERE kind='PASSWORD_RESET'`, platform.Timestamp(fixture.now)); err != nil {
					t.Fatalf("invalidate action: %v", err)
				}
			},
		},
		{
			name: "expired", kind: "EMAIL_CHANGE", wantCode: FailureCodeAccountActionExpired,
			prepare: func(t *testing.T, fixture *accountSecurityOutboxFixture) {
				if err := fixture.service.StartEmailChange(fixture.ctx, fixture.principal.Principal, "new@example.test", accountSecurityTestPassword); err != nil {
					t.Fatalf("start email change: %v", err)
				}
				if _, err := fixture.db.ExecContext(fixture.ctx, `UPDATE account_security_actions SET expires_at=? WHERE kind='EMAIL_CHANGE'`, platform.Timestamp(fixture.now.Add(-time.Minute))); err != nil {
					t.Fatalf("expire action: %v", err)
				}
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			fixture := newAccountSecurityOutboxFixture(t)
			test.prepare(t, fixture)
			advanceAccountSecurityClockToPresent(fixture)
			processed, err := fixture.dispatcher.processOne(fixture.ctx)
			if err != nil {
				t.Fatalf("process cancelled action: %v", err)
			}
			// Expired jobs are cleaned before claim; invalidated jobs are claimed
			// and then cancelled after reloading authoritative action state.
			if test.name == "invalidated" && !processed {
				t.Fatal("invalidated pending job was not processed")
			}
			state := readAccountSecurityOutboxState(t, fixture, test.kind)
			if state.status != string(OutboxStatusCancelled) || state.ciphertext.Valid || state.sentAt.Valid || state.leaseToken.Valid || !state.errorCode.Valid || state.errorCode.String != string(test.wantCode) {
				t.Fatalf("cancelled state=%#v", state)
			}
			var invalidatedAt sql.NullString
			if err := fixture.db.QueryRowContext(fixture.ctx, `SELECT invalidated_at FROM account_security_actions WHERE kind=?`, test.kind).Scan(&invalidatedAt); err != nil || !invalidatedAt.Valid {
				t.Fatalf("action invalidated_at=%#v err=%v", invalidatedAt, err)
			}
			passwordMessages, emailMessages := fixture.sender.snapshot()
			if len(passwordMessages) != 0 || len(emailMessages) != 0 {
				t.Fatalf("cancelled action sent password=%d email=%d messages", len(passwordMessages), len(emailMessages))
			}
		})
	}
}

func TestAccountSecurityDispatcherSanitizesTokenOpeningFailure(t *testing.T) {
	t.Parallel()
	fixture := newAccountSecurityOutboxFixture(t)
	if err := fixture.service.StartPasswordReset(fixture.ctx, "admin@example.test"); err != nil {
		t.Fatalf("start password reset: %v", err)
	}
	if _, err := fixture.db.ExecContext(fixture.ctx, `UPDATE account_security_email_outbox SET token_ciphertext='corrupt-secret-bearing-ciphertext'`); err != nil {
		t.Fatalf("corrupt ciphertext: %v", err)
	}
	assertAccountSecurityProcessed(t, fixture)
	state := readAccountSecurityOutboxState(t, fixture, "PASSWORD_RESET")
	if state.status != string(OutboxStatusPending) || state.attemptCount != 1 || !state.ciphertext.Valid || !state.errorCode.Valid || state.errorCode.String != string(FailureCodeTokenOpenFailed) || strings.Contains(state.errorCode.String, "corrupt") {
		t.Fatalf("token-opening failure state=%#v", state)
	}
}

func newAccountSecurityOutboxFixture(t *testing.T) *accountSecurityOutboxFixture {
	t.Helper()
	ctx := context.Background()
	db, err := storage.Open(ctx, filepath.Join(t.TempDir(), "account-security-outbox.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	box, err := platform.NewSecretBox([]byte("0123456789abcdef0123456789abcdef"))
	if err != nil {
		t.Fatalf("secret box: %v", err)
	}
	service := auth.Service{DB: db, SessionLifetime: 24 * time.Hour, TokenSealer: box, EmailDeliveryAvailable: true}
	if err := service.Bootstrap(ctx, "admin@example.test", "Admin", accountSecurityTestPassword, "Test Group", "EUR"); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	principal, err := service.Login(ctx, "admin@example.test", accountSecurityTestPassword)
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	publicURL, err := url.Parse("https://teamtaler.example")
	if err != nil {
		t.Fatalf("parse public URL: %v", err)
	}
	sender := &recordingAccountSecuritySender{}
	dispatcher, err := NewAccountSecurityDispatcher(db, sender, box, publicURL, nil)
	if err != nil {
		t.Fatalf("new dispatcher: %v", err)
	}
	fixture := &accountSecurityOutboxFixture{
		ctx: ctx, db: db, box: box, service: service, principal: principal,
		sender: sender, dispatcher: dispatcher, now: platform.Now().Add(time.Second),
	}
	dispatcher.now = func() time.Time { return fixture.now }
	return fixture
}

func assertAccountSecurityProcessed(t *testing.T, fixture *accountSecurityOutboxFixture) {
	t.Helper()
	advanceAccountSecurityClockToPresent(fixture)
	processed, err := fixture.dispatcher.processOne(fixture.ctx)
	if err != nil || !processed {
		t.Fatalf("process account-security job: processed=%t err=%v", processed, err)
	}
}

func advanceAccountSecurityClockToPresent(fixture *accountSecurityOutboxFixture) {
	now := platform.Now().Add(time.Second)
	if now.After(fixture.now) {
		fixture.now = now
	}
}

func readAccountSecurityOutboxState(t *testing.T, fixture *accountSecurityOutboxFixture, kind string) accountSecurityOutboxState {
	t.Helper()
	var state accountSecurityOutboxState
	if err := fixture.db.QueryRowContext(fixture.ctx, `SELECT o.status,o.attempt_count,o.token_ciphertext,o.sent_at,o.lease_token,o.last_error_code
		FROM account_security_email_outbox o JOIN account_security_actions a ON a.id=o.action_id WHERE a.kind=?`, kind).
		Scan(&state.status, &state.attemptCount, &state.ciphertext, &state.sentAt, &state.leaseToken, &state.errorCode); err != nil {
		t.Fatalf("read %s outbox state: %v", kind, err)
	}
	return state
}
