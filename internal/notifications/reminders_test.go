package notifications

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/DasLukas/TeamTaler/internal/storage"
)

func TestReminderWorkerUsesLocalScheduleCatchUpAndDedupeAcrossDST(t *testing.T) {
	ctx := context.Background()
	db, err := storage.Open(ctx, filepath.Join(t.TempDir(), "reminders.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer db.Close()
	const seededAt = "2026-10-01T08:00:00Z"
	for _, statement := range []string{
		`INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('user-reminder','member@example.test','Member','hash','2026-10-01T08:00:00Z','2026-10-01T08:00:00Z')`,
		`INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES('group-reminder','Reminder group','EUR','2026-10-01T08:00:00Z','2026-10-01T08:00:00Z')`,
		`INSERT INTO memberships(id,group_id,user_id,joined_at) VALUES('member-reminder','group-reminder','user-reminder','2026-10-01T08:00:00Z')`,
		`INSERT INTO group_settings(group_id,members_can_view_all_bookings,notification_emails_enabled,updated_at) VALUES('group-reminder',0,0,'2026-10-01T08:00:00Z')`,
		`INSERT INTO periods(id,group_id,label,status,starts_at,closed_at,due_at,created_at) VALUES('period-reminder','group-reminder','October','CLOSED','2026-10-01T08:00:00Z','2026-10-02T08:00:00Z','2026-10-25','2026-10-01T08:00:00Z')`,
		`INSERT INTO period_statements(id,group_id,period_id,membership_id,display_name,email,charges_minor,payments_allocated_minor,adjustments_applied_minor,adjustments_provided_minor,amount_due_minor,status,created_at) VALUES('statement-reminder','group-reminder','period-reminder','member-reminder','Member','member@example.test',1000,0,0,0,1000,'OPEN','2026-10-02T08:00:00Z')`,
		`INSERT INTO group_notification_events(group_id,event_type,enabled_at) VALUES('group-reminder','SETTLEMENT_DUE_SOON','2026-10-01T08:00:00Z')`,
		`INSERT INTO group_notification_events(group_id,event_type,enabled_at) VALUES('group-reminder','SETTLEMENT_OVERDUE','2026-10-01T08:00:00Z')`,
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("seed reminder fixture: %v", err)
		}
	}
	if _, err := db.ExecContext(ctx, `UPDATE group_notification_settings SET timezone='Europe/Berlin',settlement_due_soon_days=3,settlement_overdue_repeat_days=7,updated_at=? WHERE group_id='group-reminder'`, seededAt); err != nil {
		t.Fatalf("configure reminders: %v", err)
	}
	service := Service{DB: db}
	worker, err := NewReminderWorker(db, service, nil)
	if err != nil {
		t.Fatalf("create reminder worker: %v", err)
	}

	beforeNine := time.Date(2026, time.October, 22, 6, 59, 0, 0, time.UTC) // 08:59 CEST.
	if created, err := worker.ProcessDue(ctx, beforeNine); err != nil || created != 0 {
		t.Fatalf("before-nine reminders=%d err=%v, want 0", created, err)
	}
	afterNine := time.Date(2026, time.October, 22, 7, 1, 0, 0, time.UTC) // 09:01 CEST.
	if created, err := worker.ProcessDue(ctx, afterNine); err != nil || created != 1 {
		t.Fatalf("due-soon reminders=%d err=%v, want 1", created, err)
	}
	if created, err := worker.ProcessDue(ctx, afterNine.Add(time.Hour)); err != nil || created != 0 {
		t.Fatalf("deduplicated due-soon reminders=%d err=%v, want 0", created, err)
	}

	// The latest scheduled repeat on November 20 is November 16. The local UTC
	// offset changed after October 25, so duration-based date arithmetic would be
	// incorrect here; calendar arithmetic still produces one catch-up event.
	overdueCatchUp := time.Date(2026, time.November, 20, 9, 0, 0, 0, time.UTC)
	if created, err := worker.ProcessDue(ctx, overdueCatchUp); err != nil || created != 1 {
		t.Fatalf("overdue catch-up reminders=%d err=%v, want 1", created, err)
	}
	var occurrence string
	if err := db.QueryRowContext(ctx, `SELECT occurrence_date FROM notification_reminder_runs WHERE statement_id='statement-reminder' AND event_type='SETTLEMENT_OVERDUE'`).Scan(&occurrence); err != nil || occurrence != "2026-11-16" {
		t.Fatalf("overdue occurrence=%q err=%v, want 2026-11-16", occurrence, err)
	}
	if created, err := worker.ProcessDue(ctx, overdueCatchUp.Add(time.Hour)); err != nil || created != 0 {
		t.Fatalf("deduplicated overdue reminders=%d err=%v, want 0", created, err)
	}
}

func TestReminderWorkerSkipsCurrentlyPaidStatement(t *testing.T) {
	ctx := context.Background()
	db, err := storage.Open(ctx, filepath.Join(t.TempDir(), "paid-reminder.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer db.Close()
	for _, statement := range []string{
		`INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('user-paid','paid@example.test','Paid','hash','2026-10-01T08:00:00Z','2026-10-01T08:00:00Z')`,
		`INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES('group-paid','Paid group','EUR','2026-10-01T08:00:00Z','2026-10-01T08:00:00Z')`,
		`INSERT INTO memberships(id,group_id,user_id,joined_at) VALUES('member-paid','group-paid','user-paid','2026-10-01T08:00:00Z')`,
		`INSERT INTO group_settings(group_id,members_can_view_all_bookings,notification_emails_enabled,updated_at) VALUES('group-paid',0,0,'2026-10-01T08:00:00Z')`,
		`INSERT INTO periods(id,group_id,label,status,starts_at,closed_at,due_at,created_at) VALUES('period-paid','group-paid','October','CLOSED','2026-10-01T08:00:00Z','2026-10-02T08:00:00Z','2026-10-25','2026-10-01T08:00:00Z')`,
		`INSERT INTO period_statements(id,group_id,period_id,membership_id,display_name,email,charges_minor,payments_allocated_minor,adjustments_applied_minor,adjustments_provided_minor,amount_due_minor,status,created_at) VALUES('statement-paid','group-paid','period-paid','member-paid','Paid','paid@example.test',1000,0,0,0,1000,'OPEN','2026-10-02T08:00:00Z')`,
		`INSERT INTO payments(id,group_id,membership_id,amount_minor,received_at,method,created_by,created_at) VALUES('payment-paid','group-paid','member-paid',1000,'2026-10-20','BANK_TRANSFER','member-paid','2026-10-20T08:00:00Z')`,
		`INSERT INTO payment_allocations(group_id,payment_id,period_id,amount_minor) VALUES('group-paid','payment-paid','period-paid',1000)`,
		`INSERT INTO group_notification_events(group_id,event_type,enabled_at) VALUES('group-paid','SETTLEMENT_OVERDUE','2026-10-01T08:00:00Z')`,
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("seed paid reminder fixture: %v", err)
		}
	}
	worker, err := NewReminderWorker(db, Service{DB: db}, nil)
	if err != nil {
		t.Fatalf("create reminder worker: %v", err)
	}
	if created, err := worker.ProcessDue(ctx, time.Date(2026, time.November, 20, 10, 0, 0, 0, time.UTC)); err != nil || created != 0 {
		t.Fatalf("paid statement reminders=%d err=%v, want 0", created, err)
	}
	var notificationCount int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM notifications WHERE membership_id='member-paid' AND type='SETTLEMENT_OVERDUE'`).Scan(&notificationCount); err != nil || notificationCount != 0 {
		t.Fatalf("paid statement notifications=%d err=%v, want 0", notificationCount, err)
	}
}
