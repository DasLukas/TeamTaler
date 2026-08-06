package email

import (
	"context"
	"database/sql"
	"errors"
	"io"
	"log/slog"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

type recordingSender struct {
	mu            sync.Mutex
	available     bool
	err           error
	messages      []InvitationMessage
	notifications []NotificationMessage
}

func (s *recordingSender) Available() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.available
}

func (s *recordingSender) SendInvitation(_ context.Context, message InvitationMessage) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.messages = append(s.messages, message)
	return s.err
}

func (s *recordingSender) SendNotification(_ context.Context, message NotificationMessage) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.notifications = append(s.notifications, message)
	return s.err
}

func (s *recordingSender) snapshot() []InvitationMessage {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]InvitationMessage(nil), s.messages...)
}

type recordingOpener struct {
	mu          sync.Mutex
	plaintext   string
	err         error
	ciphertexts []string
}

func (o *recordingOpener) Open(ciphertext string) (string, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.ciphertexts = append(o.ciphertexts, ciphertext)
	return o.plaintext, o.err
}

type outboxFixture struct {
	t          *testing.T
	db         *sql.DB
	now        time.Time
	sender     *recordingSender
	opener     *recordingOpener
	dispatcher *Dispatcher
}

func newOutboxFixture(t *testing.T) *outboxFixture {
	t.Helper()
	db, err := storage.Open(context.Background(), filepath.Join(t.TempDir(), "teamtaler.db"))
	if err != nil {
		t.Fatalf("open test database: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	now := time.Date(2026, time.August, 4, 12, 0, 0, 0, time.UTC)
	nowText := platform.Timestamp(now)
	if _, err := db.Exec(`INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES('grp_email','Example Team','EUR',?,?)`, nowText, nowText); err != nil {
		t.Fatalf("insert test group: %v", err)
	}
	sender := &recordingSender{available: true}
	opener := &recordingOpener{plaintext: "plain-invitation-token"}
	publicURL, err := url.Parse("https://teamtaler.example.test/")
	if err != nil {
		t.Fatalf("parse public URL: %v", err)
	}
	dispatcher, err := NewDispatcher(db, sender, opener, publicURL, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("create dispatcher: %v", err)
	}
	dispatcher.now = func() time.Time { return now }
	return &outboxFixture{t: t, db: db, now: now, sender: sender, opener: opener, dispatcher: dispatcher}
}

func (f *outboxFixture) insertPending(invitationID string) {
	f.t.Helper()
	f.insertInvitation(invitationID, f.now.Add(24*time.Hour), nil, nil)
	nowText := platform.Timestamp(f.now)
	if _, err := f.db.Exec(`INSERT INTO invitation_email_outbox(
		invitation_id,group_id,token_ciphertext,status,attempt_count,next_attempt_at,created_at,updated_at
	) VALUES(?,'grp_email',?,'PENDING',0,?,?,?)`, invitationID, "ciphertext-"+invitationID, nowText, nowText, nowText); err != nil {
		f.t.Fatalf("insert pending outbox job: %v", err)
	}
}

func (f *outboxFixture) insertInvitation(invitationID string, expiresAt time.Time, acceptedAt, revokedAt any) {
	f.t.Helper()
	nowText := platform.Timestamp(f.now)
	if _, err := f.db.Exec(`INSERT INTO invitations(
		id,group_id,email,display_name,token_hash,roles_json,expires_at,accepted_at,revoked_at,created_by,created_at
	) VALUES(?,'grp_email',?,?,?,'[]',?,?,?,?,?)`, invitationID, invitationID+"@example.test", "Member "+invitationID,
		"hash-"+invitationID, platform.Timestamp(expiresAt), acceptedAt, revokedAt, "usr_admin", nowText); err != nil {
		f.t.Fatalf("insert invitation: %v", err)
	}
}

func TestDispatcherSendsInvitationAndClearsCiphertext(t *testing.T) {
	fixture := newOutboxFixture(t)
	fixture.insertPending("inv_send")

	processed, err := fixture.dispatcher.processOne(context.Background())
	if err != nil || !processed {
		t.Fatalf("processOne: processed=%v err=%v", processed, err)
	}
	messages := fixture.sender.snapshot()
	if len(messages) != 1 {
		t.Fatalf("sent messages = %d, want 1", len(messages))
	}
	message := messages[0]
	if message.ToAddress != "inv_send@example.test" || message.ToName != "Member inv_send" || message.GroupName != "Example Team" {
		t.Fatalf("unexpected message metadata: %#v", message)
	}
	if message.AcceptURL != "https://teamtaler.example.test/invite#token=plain-invitation-token" {
		t.Fatalf("accept URL = %q", message.AcceptURL)
	}

	var status string
	var attempts int
	var ciphertext, sentAt, leaseToken, errorCode sql.NullString
	if err := fixture.db.QueryRow(`SELECT status,attempt_count,token_ciphertext,sent_at,lease_token,last_error_code
		FROM invitation_email_outbox WHERE invitation_id='inv_send'`).
		Scan(&status, &attempts, &ciphertext, &sentAt, &leaseToken, &errorCode); err != nil {
		t.Fatalf("read sent job: %v", err)
	}
	if status != string(OutboxStatusSent) || attempts != 1 || ciphertext.Valid || !sentAt.Valid || leaseToken.Valid || errorCode.Valid {
		t.Fatalf("unexpected sent state: status=%s attempts=%d ciphertext=%#v sentAt=%#v lease=%#v code=%#v", status, attempts, ciphertext, sentAt, leaseToken, errorCode)
	}
}

func TestDispatcherUsesChronologicalDueTimeComparison(t *testing.T) {
	fixture := newOutboxFixture(t)
	fixture.insertPending("inv_fractional_due")
	fixture.dispatcher.now = func() time.Time { return fixture.now.Add(500 * time.Millisecond) }

	processed, err := fixture.dispatcher.processOne(context.Background())
	if err != nil || !processed {
		t.Fatalf("whole-second job was not due at a later fractional instant: processed=%v err=%v", processed, err)
	}
	if len(fixture.sender.snapshot()) != 1 {
		t.Fatal("chronologically due invitation was not sent")
	}
}

func TestInvitationEmailOutboxEnforcesInvitationTenant(t *testing.T) {
	fixture := newOutboxFixture(t)
	fixture.insertInvitation("inv_tenant", fixture.now.Add(time.Hour), nil, nil)
	nowText := platform.Timestamp(fixture.now)
	if _, err := fixture.db.Exec(`INSERT INTO groups(id,name,currency,created_at,updated_at)
		VALUES('grp_other','Other Team','EUR',?,?)`, nowText, nowText); err != nil {
		t.Fatalf("insert other group: %v", err)
	}
	_, err := fixture.db.Exec(`INSERT INTO invitation_email_outbox(
		invitation_id,group_id,token_ciphertext,status,attempt_count,next_attempt_at,created_at,updated_at
	) VALUES('inv_tenant','grp_other','ciphertext','PENDING',0,?,?,?)`, nowText, nowText, nowText)
	if err == nil {
		t.Fatal("outbox accepted an invitation from a different group")
	}
}

func TestDispatcherCancelsInactiveInvitations(t *testing.T) {
	tests := []struct {
		name       string
		expiresAt  func(time.Time) time.Time
		acceptedAt func(time.Time) any
		revokedAt  func(time.Time) any
		wantCode   FailureCode
	}{
		{name: "accepted", expiresAt: func(now time.Time) time.Time { return now.Add(time.Hour) }, acceptedAt: func(now time.Time) any { return platform.Timestamp(now.Add(-time.Minute)) }, revokedAt: func(time.Time) any { return nil }, wantCode: FailureCodeInvitationAccepted},
		{name: "revoked", expiresAt: func(now time.Time) time.Time { return now.Add(time.Hour) }, acceptedAt: func(time.Time) any { return nil }, revokedAt: func(now time.Time) any { return platform.Timestamp(now.Add(-time.Minute)) }, wantCode: FailureCodeInvitationRevoked},
		{name: "expired", expiresAt: func(now time.Time) time.Time { return now }, acceptedAt: func(time.Time) any { return nil }, revokedAt: func(time.Time) any { return nil }, wantCode: FailureCodeInvitationExpired},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newOutboxFixture(t)
			invitationID := "inv_" + test.name
			fixture.insertInvitation(invitationID, test.expiresAt(fixture.now), test.acceptedAt(fixture.now), test.revokedAt(fixture.now))
			nowText := platform.Timestamp(fixture.now)
			if _, err := fixture.db.Exec(`INSERT INTO invitation_email_outbox(
				invitation_id,group_id,token_ciphertext,status,attempt_count,next_attempt_at,created_at,updated_at
			) VALUES(?,'grp_email',?,'PENDING',0,?,?,?)`, invitationID, "ciphertext-"+invitationID, nowText, nowText, nowText); err != nil {
				t.Fatalf("insert pending job: %v", err)
			}

			processed, err := fixture.dispatcher.processOne(context.Background())
			if err != nil || !processed {
				t.Fatalf("processOne: processed=%v err=%v", processed, err)
			}
			if len(fixture.sender.snapshot()) != 0 {
				t.Fatal("inactive invitation was sent")
			}
			var status, code string
			var attempts int
			var ciphertext sql.NullString
			if err := fixture.db.QueryRow(`SELECT status,attempt_count,token_ciphertext,last_error_code
				FROM invitation_email_outbox WHERE invitation_id=?`, invitationID).Scan(&status, &attempts, &ciphertext, &code); err != nil {
				t.Fatalf("read cancelled job: %v", err)
			}
			if status != string(OutboxStatusCancelled) || attempts != 0 || ciphertext.Valid || code != string(test.wantCode) {
				t.Fatalf("unexpected cancelled state: status=%s attempts=%d ciphertext=%#v code=%q", status, attempts, ciphertext, code)
			}
		})
	}
}

func TestDispatcherRetriesFiveTimesWithSanitizedFailure(t *testing.T) {
	fixture := newOutboxFixture(t)
	fixture.insertPending("inv_retry")
	const rawFailure = "SMTP rejected secret plain-invitation-token"
	fixture.sender.err = errors.New(rawFailure)
	now := fixture.now
	fixture.dispatcher.now = func() time.Time { return now }

	for attempt := 1; attempt <= maximumDeliveryAttempts; attempt++ {
		processed, err := fixture.dispatcher.processOne(context.Background())
		if err != nil || !processed {
			t.Fatalf("attempt %d: processed=%v err=%v", attempt, processed, err)
		}
		var status, code string
		var attempts int
		var nextAttempt sql.NullString
		if err := fixture.db.QueryRow(`SELECT status,attempt_count,next_attempt_at,last_error_code
			FROM invitation_email_outbox WHERE invitation_id='inv_retry'`).Scan(&status, &attempts, &nextAttempt, &code); err != nil {
			t.Fatalf("read attempt %d: %v", attempt, err)
		}
		if attempts != attempt || code != string(FailureCodeDeliveryFailed) || strings.Contains(code, rawFailure) {
			t.Fatalf("attempt %d stored unsafe or incorrect result: attempts=%d code=%q", attempt, attempts, code)
		}
		if attempt < maximumDeliveryAttempts {
			if status != string(OutboxStatusPending) || !nextAttempt.Valid {
				t.Fatalf("attempt %d state: status=%s next=%#v", attempt, status, nextAttempt)
			}
			next, err := time.Parse(time.RFC3339Nano, nextAttempt.String)
			if err != nil {
				t.Fatalf("parse next attempt: %v", err)
			}
			wantNext := now.Add(retryDelay(attempt))
			if !next.Equal(wantNext) {
				t.Fatalf("attempt %d next=%s want=%s", attempt, next, wantNext)
			}
			now = next
		} else if status != string(OutboxStatusFailed) || nextAttempt.Valid {
			t.Fatalf("final state: status=%s next=%#v", status, nextAttempt)
		}
	}
	if len(fixture.sender.snapshot()) != maximumDeliveryAttempts {
		t.Fatalf("send attempts = %d, want %d", len(fixture.sender.snapshot()), maximumDeliveryAttempts)
	}
}

func TestDispatcherSanitizesTokenOpeningFailure(t *testing.T) {
	fixture := newOutboxFixture(t)
	fixture.insertPending("inv_open")
	fixture.opener.err = errors.New("cannot decrypt ciphertext-inv_open using private material")

	processed, err := fixture.dispatcher.processOne(context.Background())
	if err != nil || !processed {
		t.Fatalf("processOne: processed=%v err=%v", processed, err)
	}
	if len(fixture.sender.snapshot()) != 0 {
		t.Fatal("message was sent after token opening failed")
	}
	var code string
	if err := fixture.db.QueryRow(`SELECT last_error_code FROM invitation_email_outbox WHERE invitation_id='inv_open'`).Scan(&code); err != nil {
		t.Fatalf("read failure code: %v", err)
	}
	if code != string(FailureCodeTokenOpenFailed) {
		t.Fatalf("failure code = %q", code)
	}
}

func TestDispatcherReclaimsExpiredLease(t *testing.T) {
	fixture := newOutboxFixture(t)
	fixture.insertInvitation("inv_stale", fixture.now.Add(time.Hour), nil, nil)
	nowText := platform.Timestamp(fixture.now)
	if _, err := fixture.db.Exec(`INSERT INTO invitation_email_outbox(
		invitation_id,group_id,token_ciphertext,status,attempt_count,next_attempt_at,lease_token,lease_until,created_at,updated_at
	) VALUES('inv_stale','grp_email','ciphertext-inv_stale','SENDING',1,NULL,'old-lease',?,?,?)`,
		platform.Timestamp(fixture.now.Add(-time.Minute)), nowText, nowText); err != nil {
		t.Fatalf("insert stale job: %v", err)
	}

	processed, err := fixture.dispatcher.processOne(context.Background())
	if err != nil || !processed {
		t.Fatalf("processOne: processed=%v err=%v", processed, err)
	}
	var status string
	var attempts int
	if err := fixture.db.QueryRow(`SELECT status,attempt_count FROM invitation_email_outbox WHERE invitation_id='inv_stale'`).Scan(&status, &attempts); err != nil {
		t.Fatalf("read reclaimed job: %v", err)
	}
	if status != string(OutboxStatusSent) || attempts != 2 {
		t.Fatalf("reclaimed state: status=%s attempts=%d", status, attempts)
	}
}

func TestDispatcherDoesNotStealActiveLease(t *testing.T) {
	fixture := newOutboxFixture(t)
	fixture.insertInvitation("inv_active", fixture.now.Add(time.Hour), nil, nil)
	nowText := platform.Timestamp(fixture.now)
	if _, err := fixture.db.Exec(`INSERT INTO invitation_email_outbox(
		invitation_id,group_id,token_ciphertext,status,attempt_count,next_attempt_at,lease_token,lease_until,created_at,updated_at
	) VALUES('inv_active','grp_email','ciphertext-inv_active','SENDING',1,NULL,'active-lease',?,?,?)`,
		platform.Timestamp(fixture.now.Add(time.Minute)), nowText, nowText); err != nil {
		t.Fatalf("insert active job: %v", err)
	}

	processed, err := fixture.dispatcher.processOne(context.Background())
	if err != nil || processed {
		t.Fatalf("processOne: processed=%v err=%v", processed, err)
	}
	if len(fixture.sender.snapshot()) != 0 {
		t.Fatal("actively leased job was sent")
	}
}

type blockingSender struct {
	active    atomic.Int32
	maxActive atomic.Int32
	started   chan struct{}
}

func (s *blockingSender) Available() bool { return true }

func (s *blockingSender) SendInvitation(ctx context.Context, _ InvitationMessage) error {
	active := s.active.Add(1)
	defer s.active.Add(-1)
	for {
		maximum := s.maxActive.Load()
		if active <= maximum || s.maxActive.CompareAndSwap(maximum, active) {
			break
		}
	}
	select {
	case s.started <- struct{}{}:
	default:
	}
	<-ctx.Done()
	return ctx.Err()
}

func (s *blockingSender) SendNotification(ctx context.Context, _ NotificationMessage) error {
	return s.SendInvitation(ctx, InvitationMessage{})
}

func TestDispatcherRunBoundsWorkersAndReleasesOnShutdown(t *testing.T) {
	fixture := newOutboxFixture(t)
	for index := 0; index < 8; index++ {
		fixture.insertPending("inv_run_" + string(rune('a'+index)))
	}
	blocking := &blockingSender{started: make(chan struct{}, defaultWorkerCount)}
	fixture.dispatcher.sender = blocking
	fixture.dispatcher.pollInterval = 5 * time.Millisecond

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- fixture.dispatcher.Run(ctx) }()
	for started := 0; started < defaultWorkerCount; started++ {
		select {
		case <-blocking.started:
		case <-time.After(5 * time.Second):
			cancel()
			t.Fatal("workers did not claim four jobs")
		}
	}
	if maximum := blocking.maxActive.Load(); maximum > defaultWorkerCount {
		t.Fatalf("maximum concurrent sends = %d", maximum)
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Run returned error: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not stop after cancellation")
	}

	var sending int
	if err := fixture.db.QueryRow(`SELECT count(*) FROM invitation_email_outbox WHERE status='SENDING'`).Scan(&sending); err != nil {
		t.Fatalf("count sending jobs: %v", err)
	}
	if sending != 0 {
		t.Fatalf("sending jobs after shutdown = %d", sending)
	}
}
