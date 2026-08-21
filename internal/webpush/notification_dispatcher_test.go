package webpush

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/DasLukas/TeamTaler/internal/storage"
	push "github.com/marknefedov/go-webpush/v2"
)

type pushSendCall struct {
	payload []byte
	ttl     time.Duration
	urgency push.Urgency
}

type recordingPushSender struct {
	mu    sync.Mutex
	err   error
	calls []pushSendCall
}

func (sender *recordingPushSender) Send(_ context.Context, payload []byte, _ *push.Subscription, _, _ string, ttl time.Duration, urgency push.Urgency) error {
	sender.mu.Lock()
	defer sender.mu.Unlock()
	sender.calls = append(sender.calls, pushSendCall{payload: append([]byte(nil), payload...), ttl: ttl, urgency: urgency})
	return sender.err
}

func (sender *recordingPushSender) snapshot() []pushSendCall {
	sender.mu.Lock()
	defer sender.mu.Unlock()
	return append([]pushSendCall(nil), sender.calls...)
}

type pushDispatcherFixture struct {
	db            *sql.DB
	subscriptions *SubscriptionService
	dispatcher    *NotificationDispatcher
	sender        *recordingPushSender
	configuration RuntimeConfiguration
	deviceID      string
	now           time.Time
}

func newPushDispatcherFixture(t *testing.T) *pushDispatcherFixture {
	t.Helper()
	ctx := context.Background()
	db, err := storage.Open(ctx, filepath.Join(t.TempDir(), "teamtaler.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	for _, statement := range []string{
		`INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('usr_push','push@example.test','Push User','hash','2026-08-20T10:00:00Z','2026-08-20T10:00:00Z')`,
		`INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES('grp_push','Example Group','EUR','2026-08-20T10:00:00Z','2026-08-20T10:00:00Z')`,
		`INSERT INTO memberships(id,group_id,user_id,joined_at) VALUES('mem_push','grp_push','usr_push','2026-08-20T10:00:00Z')`,
		`INSERT INTO notifications(id,group_id,membership_id,type,title,body,context_json,created_at) VALUES('ntf_push','grp_push','mem_push','BOOKING_ASSIGNED','Secret title','Contains a private amount 500 EUR','{}','2026-08-20T10:00:00Z')`,
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("seed dispatcher database: %v", err)
		}
	}
	secrets, err := NewSecrets(bytes.Repeat([]byte{0x18}, 32))
	if err != nil {
		t.Fatalf("NewSecrets: %v", err)
	}
	subscriptions, err := NewSubscriptionService(db, secrets, staticResolver{
		"push.example.test": {mustAddress(t, "93.184.216.34")},
	})
	if err != nil {
		t.Fatalf("NewSubscriptionService: %v", err)
	}
	privateKey, _, keyID, err := GenerateVAPIDKey()
	if err != nil {
		t.Fatalf("GenerateVAPIDKey: %v", err)
	}
	device, err := subscriptions.Register(ctx, "usr_push", keyID, "Test browser", validSubscriptionInput(t))
	if err != nil {
		t.Fatalf("register subscription: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO notification_delivery_jobs(
		id,notification_id,group_id,channel,push_subscription_id,status,attempt_count,next_attempt_at,expires_at,created_at,updated_at
	) VALUES('job_push','ntf_push','grp_push','PUSH',?,'PENDING',0,'2026-08-20T10:00:00Z','2026-08-21T10:00:00Z','2026-08-20T10:00:00Z','2026-08-20T10:00:00Z')`, device.ID); err != nil {
		t.Fatalf("seed push job: %v", err)
	}
	sender := &recordingPushSender{}
	fixture := &pushDispatcherFixture{
		db: db, subscriptions: subscriptions, sender: sender, deviceID: device.ID,
		now:           time.Date(2026, time.August, 20, 10, 1, 0, 0, time.UTC),
		configuration: RuntimeConfiguration{Enabled: true, Subject: "mailto:operator@example.test", PrivateKey: privateKey, KeyID: keyID},
	}
	dispatcher, err := NewNotificationDispatcher(db, subscriptions, sender, func(context.Context) (RuntimeConfiguration, error) {
		return fixture.configuration, nil
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("NewNotificationDispatcher: %v", err)
	}
	dispatcher.now = func() time.Time { return fixture.now }
	dispatcher.workerCount = 1
	fixture.dispatcher = dispatcher
	return fixture
}

func TestNotificationDispatcherSendsPrivacySafeCatalogPayload(t *testing.T) {
	fixture := newPushDispatcherFixture(t)
	processed, err := fixture.dispatcher.processOne(context.Background())
	if err != nil || !processed {
		t.Fatalf("processOne: processed=%t err=%v", processed, err)
	}
	calls := fixture.sender.snapshot()
	if len(calls) != 1 {
		t.Fatalf("send calls=%d, want 1", len(calls))
	}
	if calls[0].ttl != 6*time.Hour || calls[0].urgency != push.UrgencyNormal {
		t.Fatalf("delivery metadata ttl=%s urgency=%s", calls[0].ttl, calls[0].urgency)
	}
	var payload map[string]string
	if err := json.Unmarshal(calls[0].payload, &payload); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	if payload["notificationId"] != "ntf_push" || payload["groupName"] != "Example Group" || payload["eventLabel"] != "In deiner Gruppe wurde etwas auf dein Konto gebucht." {
		t.Fatalf("unexpected push payload: %#v", payload)
	}
	if strings.Contains(string(calls[0].payload), "500") || strings.Contains(string(calls[0].payload), "Secret title") {
		t.Fatalf("push payload exposed detailed notification copy: %s", calls[0].payload)
	}
	assertPushJobState(t, fixture, "SENT", "")
}

func TestNotificationDispatcherHonorsRetryAfterAndAttemptBudget(t *testing.T) {
	fixture := newPushDispatcherFixture(t)
	fixture.sender.err = DeliveryError{Code: "http_429", Temporary: true, RetryAfter: fixture.now.Add(30 * time.Minute)}
	processed, err := fixture.dispatcher.processOne(context.Background())
	if err != nil || !processed {
		t.Fatalf("processOne: processed=%t err=%v", processed, err)
	}
	var status, code, next string
	var attempts int
	if err := fixture.db.QueryRow(`SELECT status,last_error_code,next_attempt_at,attempt_count FROM notification_delivery_jobs WHERE id='job_push'`).
		Scan(&status, &code, &next, &attempts); err != nil {
		t.Fatalf("read retry state: %v", err)
	}
	if status != "PENDING" || code != "http_429" || next != fixture.now.Add(30*time.Minute).Format(time.RFC3339Nano) || attempts != 1 {
		t.Fatalf("retry state status=%s code=%s next=%s attempts=%d", status, code, next, attempts)
	}
}

func TestNotificationDispatcherRevokesExpiredSubscription(t *testing.T) {
	fixture := newPushDispatcherFixture(t)
	fixture.sender.err = DeliveryError{Code: "http_410", Revoke: true}
	processed, err := fixture.dispatcher.processOne(context.Background())
	if err != nil || !processed {
		t.Fatalf("processOne: processed=%t err=%v", processed, err)
	}
	assertPushJobState(t, fixture, "FAILED", "subscription_expired")
	var revoked string
	if err := fixture.db.QueryRow(`SELECT revoked_at FROM web_push_subscriptions WHERE id=?`, fixture.deviceID).Scan(&revoked); err != nil || revoked == "" {
		t.Fatalf("subscription revokedAt=%q err=%v", revoked, err)
	}
}

func TestNotificationDispatcherRejectsChangedRecipientIdentity(t *testing.T) {
	fixture := newPushDispatcherFixture(t)
	if _, err := fixture.db.Exec(`INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('usr_other','other@example.test','Other','hash','2026-08-20T10:00:00Z','2026-08-20T10:00:00Z')`); err != nil {
		t.Fatalf("seed other user: %v", err)
	}
	if _, err := fixture.db.Exec(`UPDATE web_push_subscriptions SET user_id='usr_other' WHERE id=?`, fixture.deviceID); err != nil {
		t.Fatalf("change subscription owner: %v", err)
	}
	processed, err := fixture.dispatcher.processOne(context.Background())
	if err != nil || !processed {
		t.Fatalf("processOne: processed=%t err=%v", processed, err)
	}
	if len(fixture.sender.snapshot()) != 0 {
		t.Fatal("dispatcher sent after recipient/subscription identity diverged")
	}
	assertPushJobState(t, fixture, "FAILED", "recipient_or_subscription_unavailable")
}

func TestNotificationDispatcherPausesWhileSystemDisabled(t *testing.T) {
	fixture := newPushDispatcherFixture(t)
	fixture.configuration.Enabled = false
	processed, err := fixture.dispatcher.processOne(context.Background())
	if err != nil || processed {
		t.Fatalf("processOne: processed=%t err=%v", processed, err)
	}
	assertPushJobState(t, fixture, "PENDING", "")
	if len(fixture.sender.snapshot()) != 0 {
		t.Fatal("disabled dispatcher sent a notification")
	}
}

func TestNotificationDispatcherExpiresJobsAndRecoversStaleLease(t *testing.T) {
	t.Run("expired", func(t *testing.T) {
		fixture := newPushDispatcherFixture(t)
		if _, err := fixture.db.Exec(`UPDATE notification_delivery_jobs SET expires_at=? WHERE id='job_push'`, fixture.now.Format(time.RFC3339Nano)); err != nil {
			t.Fatalf("expire fixture job: %v", err)
		}
		processed, err := fixture.dispatcher.processOne(context.Background())
		if err != nil || processed {
			t.Fatalf("processOne: processed=%t err=%v", processed, err)
		}
		assertPushJobState(t, fixture, "EXPIRED", "expired")
	})
	t.Run("stale lease", func(t *testing.T) {
		fixture := newPushDispatcherFixture(t)
		if _, err := fixture.db.Exec(`UPDATE notification_delivery_jobs SET status='SENDING',attempt_count=1,
			next_attempt_at=NULL,lease_token='stale',lease_until=? WHERE id='job_push'`, fixture.now.Add(-time.Minute).Format(time.RFC3339Nano)); err != nil {
			t.Fatalf("lease fixture job: %v", err)
		}
		processed, err := fixture.dispatcher.processOne(context.Background())
		if err != nil || !processed {
			t.Fatalf("processOne: processed=%t err=%v", processed, err)
		}
		assertPushJobState(t, fixture, "SENT", "")
	})
}

func assertPushJobState(t *testing.T, fixture *pushDispatcherFixture, wantStatus, wantCode string) {
	t.Helper()
	var status string
	var code sql.NullString
	if err := fixture.db.QueryRow(`SELECT status,last_error_code FROM notification_delivery_jobs WHERE id='job_push'`).Scan(&status, &code); err != nil {
		t.Fatalf("read push job state: %v", err)
	}
	if status != wantStatus || code.String != wantCode || code.Valid != (wantCode != "") {
		t.Fatalf("push job status=%q code=%#v, want status=%q code=%q", status, code, wantStatus, wantCode)
	}
}

type staticHTTPClient struct {
	status int
}

func (client staticHTTPClient) Do(*http.Request) (*http.Response, error) {
	return &http.Response{StatusCode: client.status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("discarded remote detail"))}, nil
}

func TestSenderClassifiesGoneResponseWithoutRemoteBody(t *testing.T) {
	privateKey, _, _, err := GenerateVAPIDKey()
	if err != nil {
		t.Fatalf("GenerateVAPIDKey: %v", err)
	}
	subscription, err := validatedSubscription(validSubscriptionInput(t))
	if err != nil {
		t.Fatalf("validatedSubscription: %v", err)
	}
	err = NewSender(staticHTTPClient{status: http.StatusGone}).Send(context.Background(), []byte(`{"test":true}`), subscription,
		"mailto:operator@example.test", privateKey, time.Hour, push.UrgencyNormal)
	var deliveryErr DeliveryError
	if !errors.As(err, &deliveryErr) || !deliveryErr.Revoke || deliveryErr.Code != "http_410" || strings.Contains(err.Error(), "remote detail") {
		t.Fatalf("classified error=%#v raw=%v", deliveryErr, err)
	}
}
