package email

import (
	"context"
	"database/sql"
	"io"
	"log/slog"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	appnotifications "github.com/DasLukas/TeamTaler/internal/notifications"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

func TestNotificationDispatcherSendsLocalizedEventAndMarksJobSent(t *testing.T) {
	ctx := context.Background()
	db, err := storage.Open(ctx, filepath.Join(t.TempDir(), "teamtaler.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer db.Close()
	const nowText = "2026-08-04T12:00:00Z"
	for _, statement := range []string{
		`INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('usr_notice','member@example.test','Alex Member','hash','2026-08-04T12:00:00Z','2026-08-04T12:00:00Z')`,
		`INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES('grp_notice','Example Team','EUR','2026-08-04T12:00:00Z','2026-08-04T12:00:00Z')`,
		`INSERT INTO memberships(id,group_id,user_id,joined_at) VALUES('mem_notice','grp_notice','usr_notice','2026-08-04T12:00:00Z')`,
		`INSERT INTO group_settings(group_id,members_can_view_all_bookings,notification_emails_enabled,updated_at) VALUES('grp_notice',0,1,'2026-08-04T12:00:00Z')`,
		`INSERT INTO membership_notification_channels(group_id,membership_id,event_type,channel,enabled_at,updated_at) VALUES('grp_notice','mem_notice','BOOKING_ASSIGNED','EMAIL','2026-08-04T12:00:00Z','2026-08-04T12:00:00Z')`,
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("seed database: %v", err)
		}
	}
	service := appnotifications.Service{DB: db, EmailDeliveryAvailable: true}
	if err := storage.WithTx(ctx, db, func(tx *sql.Tx) error {
		_, err := service.CreateTx(ctx, tx, appnotifications.CreateInput{
			GroupID: "grp_notice", MembershipID: "mem_notice", Type: appnotifications.TypeBookingAssigned,
			Title: "New booking", Body: "A booking was assigned.", ResourceType: "booking", ResourceID: "bok_notice", CreatedAt: nowText,
			Context: appnotifications.EventContext{ActorName: "Sam Admin", ItemName: "Training fine", Quantity: 1, AmountMinor: 500, Currency: "EUR"},
		})
		return err
	}); err != nil {
		t.Fatalf("create notification: %v", err)
	}
	sender := &recordingSender{available: true}
	publicURL, _ := url.Parse("https://teamtaler.example.test/")
	dispatcher, err := NewNotificationDispatcher(db, sender, publicURL, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("create dispatcher: %v", err)
	}
	dispatcher.now = func() time.Time { return time.Date(2026, time.August, 4, 12, 1, 0, 0, time.UTC) }
	claimed, found, err := dispatcher.claimNext(ctx)
	if err != nil || !found || claimed.leaseToken == "" {
		t.Fatalf("claim email notification: found=%v job=%#v err=%v", found, claimed, err)
	}
	if _, found, err := dispatcher.claimNext(ctx); err != nil || found {
		t.Fatalf("duplicate email lease claim: found=%v err=%v", found, err)
	}
	dispatcher.releaseAfterCancellation(claimed)
	processed, err := dispatcher.processOne(ctx)
	if err != nil || !processed {
		t.Fatalf("process notification: processed=%v err=%v", processed, err)
	}
	sender.mu.Lock()
	messages := append([]NotificationMessage(nil), sender.notifications...)
	sender.mu.Unlock()
	if len(messages) != 1 || messages[0].Title != "Neue Buchung" || !strings.HasPrefix(messages[0].ActionURL, "https://teamtaler.example.test/notifications?notification=") {
		t.Fatalf("notification messages=%#v", messages)
	}
	if messages[0].Body != "Sam Admin hat dir 1 × „Training fine“ über 5,00 EUR zugewiesen." {
		t.Fatalf("notification body=%q", messages[0].Body)
	}
	var status string
	if err := db.QueryRowContext(ctx, `SELECT status FROM notification_delivery_jobs WHERE channel='EMAIL'`).Scan(&status); err != nil || status != "SENT" {
		t.Fatalf("outbox status=%q err=%v", status, err)
	}
}

func TestNotificationDispatcherTerminatesLegacyJobWithoutRecipientEmail(t *testing.T) {
	ctx := context.Background()
	db, err := storage.Open(ctx, filepath.Join(t.TempDir(), "managed-notification.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer db.Close()
	const nowText = "2026-08-04T12:00:00Z"
	for _, statement := range []string{
		`INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('usr_admin','admin@example.test','Admin','hash','2026-08-04T12:00:00Z','2026-08-04T12:00:00Z')`,
		`INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('usr_managed',NULL,'Managed Guest',NULL,'2026-08-04T12:00:00Z','2026-08-04T12:00:00Z')`,
		`INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES('grp_managed','Example Team','EUR','2026-08-04T12:00:00Z','2026-08-04T12:00:00Z')`,
		`INSERT INTO memberships(id,group_id,user_id,joined_at) VALUES('mem_admin','grp_managed','usr_admin','2026-08-04T12:00:00Z')`,
		`INSERT INTO memberships(id,group_id,user_id,joined_at,temporary_guest_name_key) VALUES('mem_managed','grp_managed','usr_managed','2026-08-04T12:00:00Z','managed guest')`,
		`INSERT INTO notifications(id,group_id,membership_id,type,title,body,context_json,created_at) VALUES('notice_managed','grp_managed','mem_managed','BOOKING_ASSIGNED','New booking','Booking body','{}','2026-08-04T12:00:00Z')`,
		`INSERT INTO notification_delivery_jobs(id,notification_id,group_id,channel,target_membership_id,status,attempt_count,next_attempt_at,created_at,updated_at) VALUES('job_managed','notice_managed','grp_managed','EMAIL','mem_managed','PENDING',0,'2026-08-04T12:00:00Z','2026-08-04T12:00:00Z','2026-08-04T12:00:00Z')`,
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("seed managed notification: %v", err)
		}
	}
	sender := &recordingSender{available: true}
	publicURL, _ := url.Parse("https://teamtaler.example.test/")
	dispatcher, err := NewNotificationDispatcher(db, sender, publicURL, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("create dispatcher: %v", err)
	}
	dispatcher.now = func() time.Time { return time.Date(2026, time.August, 4, 12, 1, 0, 0, time.UTC) }
	processed, err := dispatcher.processOne(ctx)
	if err != nil || !processed {
		t.Fatalf("process managed notification: processed=%v err=%v", processed, err)
	}
	sender.mu.Lock()
	messages := len(sender.notifications)
	sender.mu.Unlock()
	if messages != 0 {
		t.Fatalf("managed notification sends=%d, want 0", messages)
	}
	var status, code string
	if err := db.QueryRowContext(ctx, `SELECT status,last_error_code FROM notification_delivery_jobs WHERE notification_id='notice_managed' AND channel='EMAIL'`).Scan(&status, &code); err != nil {
		t.Fatalf("read managed outbox status: %v", err)
	}
	if status != string(OutboxStatusFailed) || code != string(FailureCodeRecipientUnavailable) {
		t.Fatalf("managed outbox status/code=%s/%s", status, code)
	}
}

func TestFormatEmailMoneyUsesCurrencyExponentWithoutFloatingPoint(t *testing.T) {
	for _, test := range []struct {
		amount   int64
		currency string
		want     string
	}{
		{amount: 123, currency: "EUR", want: "1,23 EUR"},
		{amount: 123, currency: "JPY", want: "123 JPY"},
		{amount: 1234, currency: "KWD", want: "1,234 KWD"},
	} {
		if got := formatEmailMoney(test.amount, test.currency); got != test.want {
			t.Fatalf("formatEmailMoney(%d,%q)=%q want %q", test.amount, test.currency, got, test.want)
		}
	}
}
