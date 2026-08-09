package notifications

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"testing"

	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

func TestNotificationPaginationBatchReadAndEmailEnqueue(t *testing.T) {
	ctx := context.Background()
	db, err := storage.Open(ctx, filepath.Join(t.TempDir(), "teamtaler.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer db.Close()
	for _, statement := range []string{
		`INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('usr_a','a@example.test','Member A','hash','2026-08-04T12:00:00Z','2026-08-04T12:00:00Z')`,
		`INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('usr_b','b@example.test','Member B','hash','2026-08-04T12:00:00Z','2026-08-04T12:00:00Z')`,
		`INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('usr_managed',NULL,'Managed Guest',NULL,'2026-08-04T12:00:00Z','2026-08-04T12:00:00Z')`,
		`INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES('grp_a','Group A','EUR','2026-08-04T12:00:00Z','2026-08-04T12:00:00Z')`,
		`INSERT INTO memberships(id,group_id,user_id,joined_at) VALUES('mem_a','grp_a','usr_a','2026-08-04T12:00:00Z')`,
		`INSERT INTO memberships(id,group_id,user_id,joined_at) VALUES('mem_b','grp_a','usr_b','2026-08-04T12:00:00Z')`,
		`INSERT INTO memberships(id,group_id,user_id,joined_at,managed_guest_name_key) VALUES('mem_managed','grp_a','usr_managed','2026-08-04T12:00:00Z','managed guest')`,
		`INSERT INTO group_settings(group_id,members_can_view_all_bookings,notification_emails_enabled,updated_at) VALUES('grp_a',0,1,'2026-08-04T12:00:00Z')`,
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("seed database: %v", err)
		}
	}
	service := Service{DB: db, EmailDeliveryAvailable: true}
	if err := storage.WithTx(ctx, db, func(tx *sql.Tx) error {
		_, err := service.CreateTx(ctx, tx, CreateInput{
			GroupID: "grp_a", MembershipID: "mem_managed", Type: TypeBookingAssigned,
			Title: "New booking", Body: "Booking body", ResourceType: "booking",
			ResourceID: "booking-managed", CreatedAt: "2026-08-04T12:00:04Z",
			Context: EventContext{ActorName: "Member B", AmountMinor: 100, Currency: "EUR"},
		})
		return err
	}); err != nil {
		t.Fatalf("create managed notification: %v", err)
	}
	for index, createdAt := range []string{"2026-08-04T12:00:01Z", "2026-08-04T12:00:02Z", "2026-08-04T12:00:03Z"} {
		err := storage.WithTx(ctx, db, func(tx *sql.Tx) error {
			_, err := service.CreateTx(ctx, tx, CreateInput{
				GroupID: "grp_a", MembershipID: "mem_a", Type: TypePaymentRecorded,
				Title: "Payment recorded", Body: "Payment body", ResourceType: "payment",
				ResourceID: fmt.Sprintf("pay_%d", index), CreatedAt: createdAt,
				Context: EventContext{ActorName: "Member B", AmountMinor: int64(100 + index), Currency: "EUR"},
			})
			return err
		})
		if err != nil {
			t.Fatalf("create notification %d: %v", index, err)
		}
	}

	membership := domain.Membership{ID: "mem_a", GroupID: "grp_a"}
	first, err := service.ListPage(ctx, membership, 2, "")
	if err != nil || len(first.Items) != 2 || first.NextCursor == "" {
		t.Fatalf("first page=%#v err=%v", first, err)
	}
	second, err := service.ListPage(ctx, membership, 2, first.NextCursor)
	if err != nil || len(second.Items) != 1 || second.NextCursor != "" {
		t.Fatalf("second page=%#v err=%v", second, err)
	}
	if first.Items[0].ID == first.Items[1].ID || first.Items[1].ID == second.Items[0].ID {
		t.Fatal("cursor pagination returned duplicate notifications")
	}
	result, err := service.MarkReadMany(ctx, membership, []string{first.Items[0].ID, first.Items[1].ID})
	if err != nil || result.UnreadCount != 1 || result.ReadAt == "" {
		t.Fatalf("mark visible result=%#v err=%v", result, err)
	}
	if _, err := service.MarkReadMany(ctx, membership, []string{first.Items[0].ID, first.Items[0].ID}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("duplicate IDs error=%v, want validation", err)
	}
	var outboxCount int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM notification_email_outbox WHERE group_id='grp_a'`).Scan(&outboxCount); err != nil || outboxCount != 3 {
		t.Fatalf("notification email jobs=%d err=%v, want 3", outboxCount, err)
	}
	var managedNotificationCount int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM notifications WHERE membership_id='mem_managed'`).Scan(&managedNotificationCount); err != nil || managedNotificationCount != 1 {
		t.Fatalf("managed in-app notifications=%d err=%v, want 1", managedNotificationCount, err)
	}
}
