package notifications

import (
	"context"
	"database/sql"
	"testing"
	"time"
)

func TestPlanningWorkerCreatesOneCanonicalNotificationAndRun(t *testing.T) {
	ctx := context.Background()
	db, membership := openNotificationPolicyFixture(t)
	defer db.Close()
	now := time.Date(2026, time.August, 30, 12, 0, 0, 0, time.UTC)
	seedPlanningTask(t, db, membership.GroupID, membership.ID, "event-published", "task-published",
		TypePlanningEventPublished, "APPOINTMENT", "PUBLISHED", 1, 1, now.Add(-time.Minute), now.Add(time.Hour), sql.NullString{}, sql.NullString{}, sql.NullInt64{})
	worker, err := NewPlanningWorker(db, Service{DB: db}, nil)
	if err != nil {
		t.Fatalf("create planning worker: %v", err)
	}
	created, err := worker.ProcessDue(ctx, now)
	if err != nil || created != 1 {
		t.Fatalf("process planning task: created=%d err=%v", created, err)
	}
	created, err = worker.ProcessDue(ctx, now.Add(time.Minute))
	if err != nil || created != 0 {
		t.Fatalf("repeat planning task: created=%d err=%v", created, err)
	}
	var taskStatus, notificationType string
	var runs int
	if err := db.QueryRowContext(ctx, `SELECT status FROM planning_notification_tasks WHERE id='task-published'`).Scan(&taskStatus); err != nil {
		t.Fatalf("read task status: %v", err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*),coalesce(max(notification.type),'')
		FROM planning_notification_runs run LEFT JOIN notifications notification ON notification.id=run.notification_id
		WHERE run.task_id='task-published'`).Scan(&runs, &notificationType); err != nil {
		t.Fatalf("read planning run: %v", err)
	}
	if taskStatus != "PROCESSED" || runs != 1 || notificationType != string(TypePlanningEventPublished) {
		t.Fatalf("planning result status=%s runs=%d type=%s", taskStatus, runs, notificationType)
	}
}

func TestPlanningWorkerCreatesOneBundledNotificationPerSeriesRevision(t *testing.T) {
	ctx := context.Background()
	db, membership := openNotificationPolicyFixture(t)
	defer db.Close()
	now := time.Date(2026, time.August, 30, 12, 0, 0, 0, time.UTC)
	timestamp := now.Format(time.RFC3339Nano)
	statements := []struct {
		query string
		args  []any
	}{
		{`UPDATE group_planning_settings SET enabled=1,updated_at=? WHERE group_id=?`, []any{timestamp, membership.GroupID}},
		{`INSERT OR IGNORE INTO group_notification_events(group_id,event_type,enabled_at) VALUES(?,?,?)`, []any{membership.GroupID, TypePlanningSeriesPublished, timestamp}},
		{`INSERT INTO planning_series(id,group_id,status,timezone,current_revision,version,created_by_membership_id,updated_by_membership_id,published_at,created_at,updated_at)
			VALUES('series-published',?,'PUBLISHED','Europe/Berlin',1,1,?,?,?, ?,?)`, []any{membership.GroupID, membership.ID, membership.ID, timestamp, timestamp, timestamp}},
		{`INSERT INTO planning_series_revisions(group_id,series_id,revision,effective_from_original_start_at,effective_from_sequence,title,description,location,event_type,audience_type,starts_at,duration_minutes,response_deadline_minutes_before,waitlist_enabled,frequency,interval_value,weekdays_json,range_type,occurrence_count,created_by_membership_id,created_at)
			VALUES(?,'series-published',1,?,1,'Weekly meal','','','APPOINTMENT','ALL_ACTIVE_MEMBERS',?,60,NULL,0,'WEEKLY',1,'["SU"]','COUNT',4,?,?)`, []any{membership.GroupID, timestamp, now.Add(24 * time.Hour).Format(time.RFC3339Nano), membership.ID, timestamp}},
		{`INSERT INTO planning_series_recipients(group_id,series_id,membership_id,first_notified_at,last_synced_at)
			VALUES(?,'series-published',?,?,?)`, []any{membership.GroupID, membership.ID, timestamp, timestamp}},
		{`INSERT INTO planning_series_notification_tasks(id,group_id,series_id,target_membership_id,event_type,series_revision,scheduled_for,created_at,updated_at)
			VALUES('series-task-published',?,'series-published',?,?,1,?,?,?)`, []any{membership.GroupID, membership.ID, TypePlanningSeriesPublished, now.Add(-time.Minute).Format(time.RFC3339Nano), timestamp, timestamp}},
	}
	for index, statement := range statements {
		if _, err := db.ExecContext(ctx, statement.query, statement.args...); err != nil {
			t.Fatalf("seed series notification fixture %d: %v", index, err)
		}
	}
	worker, err := NewPlanningWorker(db, Service{DB: db}, nil)
	if err != nil {
		t.Fatalf("create planning worker: %v", err)
	}
	processed, err := worker.ProcessDue(ctx, now)
	if err != nil || processed != 1 {
		t.Fatalf("process series task: processed=%d err=%v", processed, err)
	}
	processed, err = worker.ProcessDue(ctx, now.Add(time.Minute))
	if err != nil || processed != 0 {
		t.Fatalf("repeat series task: processed=%d err=%v", processed, err)
	}
	var taskStatus string
	var notifications int
	if err := db.QueryRowContext(ctx, `SELECT status FROM planning_series_notification_tasks WHERE id='series-task-published'`).Scan(&taskStatus); err != nil {
		t.Fatalf("read series task status: %v", err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM notifications WHERE resource_type='planning_series' AND resource_id='series-published' AND type=?`, TypePlanningSeriesPublished).Scan(&notifications); err != nil {
		t.Fatalf("read series notifications: %v", err)
	}
	if taskStatus != "PROCESSED" || notifications != 1 {
		t.Fatalf("series notification status=%s count=%d", taskStatus, notifications)
	}
}

func TestPlanningWorkerCancelsStaleTasks(t *testing.T) {
	ctx := context.Background()
	db, membership := openNotificationPolicyFixture(t)
	defer db.Close()
	now := time.Date(2026, time.August, 30, 12, 0, 0, 0, time.UTC)
	seedPlanningTask(t, db, membership.GroupID, membership.ID, "event-stale", "task-stale",
		TypePlanningEventUpdated, "APPOINTMENT", "PUBLISHED", 1, 2, now.Add(-time.Minute), now.Add(time.Hour), sql.NullString{}, sql.NullString{}, sql.NullInt64{})
	worker, err := NewPlanningWorker(db, Service{DB: db}, nil)
	if err != nil {
		t.Fatalf("create planning worker: %v", err)
	}
	processed, err := worker.ProcessDue(ctx, now)
	if err != nil || processed != 1 {
		t.Fatalf("cancel invalid planning tasks: processed=%d err=%v", processed, err)
	}
	var cancelled int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM planning_notification_tasks WHERE status='CANCELLED'`).Scan(&cancelled); err != nil || cancelled != 1 {
		t.Fatalf("cancelled planning tasks=%d err=%v", cancelled, err)
	}
	var notifications int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM notifications WHERE resource_type='planning_event'`).Scan(&notifications); err != nil || notifications != 0 {
		t.Fatalf("stale planning notifications=%d err=%v", notifications, err)
	}
}

func seedPlanningTask(t *testing.T, db *sql.DB, groupID, membershipID, eventID, taskID string, notificationType EventType,
	planningType, eventStatus string, taskRevision, eventRevision int64, scheduledFor, startsAt time.Time,
	deadline, participation sql.NullString, participationRevision sql.NullInt64,
) {
	t.Helper()
	const timestamp = "2026-08-30T10:00:00Z"
	if _, err := db.Exec(`UPDATE group_planning_settings SET enabled=1,updated_at=? WHERE group_id=?`, timestamp, groupID); err != nil {
		t.Fatalf("enable planning: %v", err)
	}
	var deadlineValue any
	if deadline.Valid {
		deadlineValue = deadline.String
	}
	if _, err := db.Exec(`INSERT INTO planning_events(
		id,group_id,title,event_type,status,audience_type,timezone,starts_at,response_deadline,confirmation_revision,version,
		created_by_membership_id,updated_by_membership_id,published_at,created_at,updated_at
	) VALUES(?,?,?,?,?,'ALL_ACTIVE_MEMBERS','Europe/Berlin',?,?,?,?,?,?,?, ?,?)`, eventID, groupID, "Team meal", planningType, eventStatus,
		startsAt.Format(time.RFC3339Nano), deadlineValue, int64(1), eventRevision, membershipID, membershipID, timestamp, timestamp, timestamp); err != nil {
		t.Fatalf("seed planning event: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO planning_event_audience(group_id,event_id,membership_id,display_name_snapshot,invited_at)
		VALUES(?,?,?,?,?)`, groupID, eventID, membershipID, "Member", timestamp); err != nil {
		t.Fatalf("seed planning audience: %v", err)
	}
	if participation.Valid {
		confirmedRevision := int64(1)
		if participationRevision.Valid {
			confirmedRevision = participationRevision.Int64
		}
		if _, err := db.Exec(`INSERT INTO planning_participations(
			group_id,event_id,membership_id,status,confirmed_revision,responded_at,updated_at
		) VALUES(?,?,?,?,?,?,?)`, groupID, eventID, membershipID, participation.String, confirmedRevision, timestamp, timestamp); err != nil {
			t.Fatalf("seed planning participation: %v", err)
		}
	}
	if _, err := db.Exec(`INSERT INTO planning_notification_tasks(
		id,group_id,event_id,target_membership_id,event_type,scheduled_for,event_revision,created_at,updated_at
	) VALUES(?,?,?,?,?,?,?,?,?)`, taskID, groupID, eventID, membershipID, notificationType,
		scheduledFor.Format(time.RFC3339Nano), taskRevision, timestamp, timestamp); err != nil {
		t.Fatalf("seed planning notification task: %v", err)
	}
}
