package planning

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
	"time"

	"github.com/DasLukas/TeamTaler/internal/storage"
)

func TestLifecycleWorkerClosesRegistrationWithoutInvalidatingExistingSeat(t *testing.T) {
	ctx := context.Background()
	db := openLifecycleFixture(t)
	defer db.Close()
	const eventID = "event-registration"
	now := time.Date(2026, time.August, 30, 12, 0, 0, 0, time.UTC)
	for _, statement := range []string{
		`INSERT INTO planning_events(id,group_id,title,event_type,status,audience_type,timezone,starts_at,response_deadline,response_deadline_minutes_before,
		 capacity,waitlist_enabled,confirmation_revision,version,created_by_membership_id,updated_by_membership_id,published_at,created_at,updated_at)
		 VALUES('event-registration','group-lifecycle','Team meal','APPOINTMENT_REGISTRATION','PUBLISHED','ALL_ACTIVE_MEMBERS','Europe/Berlin',
		 '2026-08-30T14:00:00Z','2026-08-30T11:00:00Z',180,1,1,2,3,'member-owner','member-owner',
		 '2026-08-29T10:00:00Z','2026-08-29T10:00:00Z','2026-08-29T10:00:00Z')`,
		`INSERT INTO planning_event_audience(group_id,event_id,membership_id,display_name_snapshot,invited_at) VALUES
		 ('group-lifecycle','event-registration','member-owner','Owner','2026-08-29T10:00:00Z'),
		 ('group-lifecycle','event-registration','member-guest','Guest','2026-08-29T10:00:00Z'),
		 ('group-lifecycle','event-registration','member-waiting','Waiting','2026-08-29T10:00:00Z')`,
		`INSERT INTO planning_participations(group_id,event_id,membership_id,status,waitlist_position,confirmed_revision,responded_at,updated_at) VALUES
		 ('group-lifecycle','event-registration','member-owner','REGISTERED',NULL,1,'2026-08-29T10:00:00Z','2026-08-29T10:00:00Z'),
		 ('group-lifecycle','event-registration','member-guest','WAITLISTED',1,2,'2026-08-29T11:00:00Z','2026-08-29T11:00:00Z'),
		 ('group-lifecycle','event-registration','member-waiting','WAITLISTED',2,2,'2026-08-29T11:00:00Z','2026-08-29T11:00:00Z')`,
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("seed registration lifecycle: %v", err)
		}
	}
	worker, err := NewLifecycleWorker(db, nil)
	if err != nil {
		t.Fatalf("create lifecycle worker: %v", err)
	}
	changed, err := worker.ProcessDue(ctx, now)
	if err != nil || changed != 1 {
		t.Fatalf("process registration deadline: changed=%d err=%v", changed, err)
	}
	changed, err = worker.ProcessDue(ctx, now.Add(time.Minute))
	if err != nil || changed != 0 {
		t.Fatalf("repeat registration deadline: changed=%d err=%v", changed, err)
	}
	var eventStatus, ownerStatus, guestStatus, waitingStatus string
	var eventVersion int64
	if err := db.QueryRowContext(ctx, `SELECT status,version FROM planning_events WHERE id=?`, eventID).Scan(&eventStatus, &eventVersion); err != nil {
		t.Fatalf("read closed event: %v", err)
	}
	if err := db.QueryRowContext(ctx, `SELECT status FROM planning_participations WHERE event_id=? AND membership_id='member-owner'`, eventID).Scan(&ownerStatus); err != nil {
		t.Fatalf("read preserved registration: %v", err)
	}
	if err := db.QueryRowContext(ctx, `SELECT status FROM planning_participations WHERE event_id=? AND membership_id='member-guest'`, eventID).Scan(&guestStatus); err != nil {
		t.Fatalf("read invalid waitlist registration: %v", err)
	}
	if err := db.QueryRowContext(ctx, `SELECT status FROM planning_participations WHERE event_id=? AND membership_id='member-waiting'`, eventID).Scan(&waitingStatus); err != nil {
		t.Fatalf("read waiting registration: %v", err)
	}
	if eventStatus != "CLOSED" || eventVersion != 4 || ownerStatus != "REGISTERED" || guestStatus != "WITHDRAWN" || waitingStatus != "WAITLISTED" {
		t.Fatalf("lifecycle status=%s version=%d owner=%s guest=%s waiting=%s", eventStatus, eventVersion, ownerStatus, guestStatus, waitingStatus)
	}
	var auditCount int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM audit_events WHERE action='planning.event.closed.automatic' AND resource_id=?`, eventID).Scan(&auditCount); err != nil || auditCount != 1 {
		t.Fatalf("automatic close audits=%d err=%v", auditCount, err)
	}
	var promotionTasks int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM planning_notification_tasks
		WHERE event_id=? AND event_type='PLANNING_WAITLIST_PROMOTED'`, eventID).Scan(&promotionTasks); err != nil || promotionTasks != 0 {
		t.Fatalf("promotion tasks=%d err=%v, want 0", promotionTasks, err)
	}
}

func TestLifecycleWorkerCompletesElapsedEventsAndHonorsModuleGate(t *testing.T) {
	ctx := context.Background()
	db := openLifecycleFixture(t)
	defer db.Close()
	for _, statement := range []string{
		`INSERT INTO planning_events(id,group_id,title,event_type,status,audience_type,timezone,starts_at,
		 created_by_membership_id,updated_by_membership_id,published_at,created_at,updated_at)
		 VALUES('event-elapsed','group-lifecycle','Past information','APPOINTMENT','PUBLISHED','ALL_ACTIVE_MEMBERS','Europe/Berlin',
		 '2026-08-30T11:00:00Z','member-owner','member-owner','2026-08-29T10:00:00Z','2026-08-29T10:00:00Z','2026-08-29T10:00:00Z')`,
		`INSERT INTO planning_events(id,group_id,title,event_type,status,audience_type,timezone,starts_at,
		 created_by_membership_id,updated_by_membership_id,published_at,created_at,updated_at)
		 VALUES('event-disabled','group-disabled','Disabled information','APPOINTMENT','PUBLISHED','ALL_ACTIVE_MEMBERS','Europe/Berlin',
		 '2026-08-30T11:00:00Z','member-disabled','member-disabled','2026-08-29T10:00:00Z','2026-08-29T10:00:00Z','2026-08-29T10:00:00Z')`,
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("seed completion lifecycle: %v", err)
		}
	}
	worker, _ := NewLifecycleWorker(db, nil)
	changed, err := worker.ProcessDue(ctx, time.Date(2026, time.August, 30, 12, 0, 0, 0, time.UTC))
	if err != nil || changed != 1 {
		t.Fatalf("complete elapsed event: changed=%d err=%v", changed, err)
	}
	var enabledStatus, disabledStatus string
	_ = db.QueryRowContext(ctx, `SELECT status FROM planning_events WHERE id='event-elapsed'`).Scan(&enabledStatus)
	_ = db.QueryRowContext(ctx, `SELECT status FROM planning_events WHERE id='event-disabled'`).Scan(&disabledStatus)
	if enabledStatus != "COMPLETED" || disabledStatus != "PUBLISHED" {
		t.Fatalf("completion states enabled=%s disabled=%s", enabledStatus, disabledStatus)
	}
}

func TestLifecycleWorkerCompletesAllDayEventAtExclusiveLocalEnd(t *testing.T) {
	ctx := context.Background()
	db := openLifecycleFixture(t)
	defer db.Close()
	location, err := time.LoadLocation("Europe/Berlin")
	if err != nil {
		t.Fatalf("load timezone: %v", err)
	}
	start := time.Date(2026, time.October, 25, 0, 0, 0, 0, location).UTC()
	end := time.Date(2026, time.October, 26, 0, 0, 0, 0, location).UTC()
	if duration := end.Sub(start); duration != 25*time.Hour {
		t.Fatalf("fixture duration=%s, want 25h across DST", duration)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO planning_events(
		id,group_id,title,event_type,status,audience_type,all_day,timezone,start_date,end_date_exclusive,starts_at,ends_at,
		created_by_membership_id,updated_by_membership_id,published_at,created_at,updated_at
	) VALUES('event-all-day','group-lifecycle','DST all-day event','APPOINTMENT','PUBLISHED','ALL_ACTIVE_MEMBERS',1,'Europe/Berlin','2026-10-25','2026-10-26',?,?,
		'member-owner','member-owner','2026-10-20T10:00:00Z','2026-10-20T10:00:00Z','2026-10-20T10:00:00Z')`, start.Format(time.RFC3339Nano), end.Format(time.RFC3339Nano)); err != nil {
		t.Fatalf("seed all-day lifecycle: %v", err)
	}
	worker, err := NewLifecycleWorker(db, nil)
	if err != nil {
		t.Fatalf("create lifecycle worker: %v", err)
	}
	changed, err := worker.ProcessDue(ctx, end.Add(-time.Nanosecond))
	if err != nil || changed != 0 {
		t.Fatalf("process before exclusive end: changed=%d err=%v", changed, err)
	}
	changed, err = worker.ProcessDue(ctx, end)
	if err != nil || changed != 1 {
		t.Fatalf("process at exclusive end: changed=%d err=%v", changed, err)
	}
	var status string
	if err := db.QueryRowContext(ctx, `SELECT status FROM planning_events WHERE id='event-all-day'`).Scan(&status); err != nil {
		t.Fatalf("read all-day status: %v", err)
	}
	if status != "COMPLETED" {
		t.Fatalf("all-day status=%s, want COMPLETED", status)
	}
}

func TestLifecycleWorkerComparesFractionalInstantsNumerically(t *testing.T) {
	ctx := context.Background()
	db := openLifecycleFixture(t)
	defer db.Close()
	for _, statement := range []string{
		`INSERT INTO planning_events(id,group_id,title,event_type,status,audience_type,timezone,starts_at,response_deadline,response_deadline_minutes_before,
		 created_by_membership_id,updated_by_membership_id,published_at,created_at,updated_at)
		 VALUES('event-fraction-deadline','group-lifecycle','Fraction deadline','APPOINTMENT_POLL','PUBLISHED','ALL_ACTIVE_MEMBERS','Europe/Berlin',
		 '2026-09-01T12:00:00Z','2026-09-01T10:00:00Z',120,'member-owner','member-owner','2026-08-29T10:00:00Z','2026-08-29T10:00:00Z','2026-08-29T10:00:00Z')`,
		`INSERT INTO planning_events(id,group_id,title,event_type,status,audience_type,timezone,starts_at,
		 created_by_membership_id,updated_by_membership_id,published_at,created_at,updated_at)
		 VALUES('event-fraction-end','group-lifecycle','Fraction end','APPOINTMENT','PUBLISHED','ALL_ACTIVE_MEMBERS','Europe/Berlin',
		 '2026-09-01T10:00:00Z','member-owner','member-owner','2026-08-29T10:00:00Z','2026-08-29T10:00:00Z','2026-08-29T10:00:00Z')`,
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	worker, err := NewLifecycleWorker(db, nil)
	if err != nil {
		t.Fatal(err)
	}
	changed, err := worker.ProcessDue(ctx, time.Date(2026, time.September, 1, 10, 0, 0, 500_000_000, time.UTC))
	if err != nil || changed != 2 {
		t.Fatalf("fractional lifecycle changed=%d err=%v", changed, err)
	}
	var deadlineStatus, endStatus string
	if err := db.QueryRowContext(ctx, `SELECT status FROM planning_events WHERE id='event-fraction-deadline'`).Scan(&deadlineStatus); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRowContext(ctx, `SELECT status FROM planning_events WHERE id='event-fraction-end'`).Scan(&endStatus); err != nil {
		t.Fatal(err)
	}
	if deadlineStatus != "CLOSED" || endStatus != "COMPLETED" {
		t.Fatalf("fractional lifecycle statuses=%s/%s", deadlineStatus, endStatus)
	}
}

func openLifecycleFixture(t *testing.T) *sql.DB {
	t.Helper()
	ctx := context.Background()
	db, err := storage.Open(ctx, filepath.Join(t.TempDir(), "planning-lifecycle.db"))
	if err != nil {
		t.Fatalf("open lifecycle database: %v", err)
	}
	statements := []string{
		`INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES
		 ('user-owner','owner@example.test','Owner','hash','2026-08-29T10:00:00Z','2026-08-29T10:00:00Z'),
		 ('user-waiting','waiting@example.test','Waiting','hash','2026-08-29T10:00:00Z','2026-08-29T10:00:00Z'),
		 ('user-guest',NULL,'Guest',NULL,'2026-08-29T10:00:00Z','2026-08-29T10:00:00Z'),
		 ('user-disabled','disabled@example.test','Disabled','hash','2026-08-29T10:00:00Z','2026-08-29T10:00:00Z')`,
		`INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES
		 ('group-lifecycle','Lifecycle','EUR','2026-08-29T10:00:00Z','2026-08-29T10:00:00Z'),
		 ('group-disabled','Disabled','EUR','2026-08-29T10:00:00Z','2026-08-29T10:00:00Z')`,
		`INSERT INTO group_settings(group_id,members_can_view_all_bookings,notification_emails_enabled,updated_at) VALUES
		 ('group-lifecycle',0,0,'2026-08-29T10:00:00Z'),('group-disabled',0,0,'2026-08-29T10:00:00Z')`,
		`INSERT INTO memberships(id,group_id,user_id,status,joined_at,temporary_guest_name_key) VALUES
		 ('member-owner','group-lifecycle','user-owner','ACTIVE','2026-08-29T10:00:00Z',NULL),
		 ('member-waiting','group-lifecycle','user-waiting','ACTIVE','2026-08-29T10:00:00Z',NULL),
		 ('member-guest','group-lifecycle','user-guest','ACTIVE','2026-08-29T10:00:00Z','guest'),
		 ('member-disabled','group-disabled','user-disabled','ACTIVE','2026-08-29T10:00:00Z',NULL)`,
		`UPDATE group_planning_settings SET enabled=1,updated_at='2026-08-29T10:00:00Z' WHERE group_id='group-lifecycle'`,
	}
	for _, statement := range statements {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			db.Close()
			t.Fatalf("seed lifecycle fixture: %v", err)
		}
	}
	return db
}
