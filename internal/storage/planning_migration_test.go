package storage

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"

	"github.com/DasLukas/TeamTaler/migrations"
)

func TestPlanningMigrationSeedsDisabledFeaturePermissionsAndPushDefaults(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, filepath.Join(t.TempDir(), "planning.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	now := "2026-08-30T12:00:00Z"
	if _, err = db.ExecContext(ctx, `INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('u','u@example.test','User','hash',?,?)`, now, now); err != nil {
		t.Fatal(err)
	}
	if _, err = db.ExecContext(ctx, `INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES('g','Group','EUR',?,?)`, now, now); err != nil {
		t.Fatal(err)
	}
	if _, err = db.ExecContext(ctx, `INSERT INTO memberships(id,group_id,user_id,status,joined_at) VALUES('m','g','u','ACTIVE',?)`, now); err != nil {
		t.Fatal(err)
	}
	var enabled bool
	if err = db.QueryRowContext(ctx, `SELECT enabled FROM group_planning_settings WHERE group_id='g'`).Scan(&enabled); err != nil || enabled {
		t.Fatalf("enabled=%v err=%v", enabled, err)
	}
	var definitions, push int
	_ = db.QueryRowContext(ctx, `SELECT count(*) FROM permission_definitions WHERE key LIKE '%PLANNING%'`).Scan(&definitions)
	_ = db.QueryRowContext(ctx, `SELECT count(*) FROM membership_notification_channels WHERE membership_id='m' AND event_type LIKE 'PLANNING_%' AND channel='PUSH'`).Scan(&push)
	if definitions != 4 || push != 7 {
		t.Fatalf("definitions/push=%d/%d", definitions, push)
	}
	assertPlanningMigrationColumns(t, ctx, db, "planning_events", "series_id", "series_revision", "series_sequence", "original_start_at", "original_start_date", "is_series_exception", "response_deadline_minutes_before", "all_day", "timezone", "start_date", "end_date_exclusive", "starts_at_us", "ends_at_us", "response_deadline_us")
	assertPlanningMigrationColumns(t, ctx, db, "planning_series_revisions", "effective_from_original_start_at", "effective_from_sequence", "response_deadline_minutes_before", "all_day", "start_date", "duration_days")
	var cancelledRangesTable int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM sqlite_master WHERE type='table' AND name='planning_series_cancelled_ranges'`).Scan(&cancelledRangesTable); err != nil || cancelledRangesTable != 1 {
		t.Fatalf("planning_series_cancelled_ranges table=%d err=%v, want 1", cancelledRangesTable, err)
	}
	assertPlanningAllDayConstraints(t, ctx, db, now)
}

func TestPlanningCalendarRangeMigrationProjectsExactMicroseconds(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, filepath.Join(t.TempDir(), "planning-calendar-ranges.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	now := "2026-08-30T12:00:00Z"
	for _, statement := range []string{
		`INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('range-u','range@example.test','Range','hash','2026-08-30T12:00:00Z','2026-08-30T12:00:00Z')`,
		`INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES('range-g','Range','EUR','2026-08-30T12:00:00Z','2026-08-30T12:00:00Z')`,
		`INSERT INTO memberships(id,group_id,user_id,status,joined_at) VALUES('range-m','range-g','range-u','ACTIVE','2026-08-30T12:00:00Z')`,
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	_, err = db.ExecContext(ctx, `INSERT INTO planning_events(
		id,group_id,title,event_type,status,audience_type,timezone,starts_at,ends_at,response_deadline,response_deadline_minutes_before,
		created_by_membership_id,updated_by_membership_id,created_at,updated_at
	) VALUES('range-event','range-g','Fractional','APPOINTMENT_POLL','PUBLISHED','ALL_ACTIVE_MEMBERS','Europe/Berlin',?,?,?,?,?,?,?,?)`,
		"2026-09-01T10:00:00.123456Z", "2026-09-01T11:00:00.500001Z", "2026-09-01T09:59:59.999999Z", 1, "range-m", "range-m", now, now)
	if err != nil {
		t.Fatal(err)
	}
	var starts, ends, deadline int64
	if err := db.QueryRowContext(ctx, `SELECT starts_at_us,ends_at_us,response_deadline_us FROM planning_events WHERE id='range-event'`).Scan(&starts, &ends, &deadline); err != nil {
		t.Fatal(err)
	}
	if starts != 1788256800123456 || ends != 1788260400500001 || deadline != 1788256799999999 {
		t.Fatalf("projected microseconds=%d/%d/%d", starts, ends, deadline)
	}
	if _, err := db.ExecContext(ctx, `UPDATE planning_events SET starts_at='2026-09-01T10:00:00.9Z',starts_at_us=1 WHERE id='range-event'`); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRowContext(ctx, `SELECT starts_at_us FROM planning_events WHERE id='range-event'`).Scan(&starts); err != nil {
		t.Fatal(err)
	}
	if starts != 1788256800900000 {
		t.Fatalf("updated starts_at_us=%d", starts)
	}
}

func TestPlanningCalendarRangeMigrationBackfillsFractionalTimestamps(t *testing.T) {
	ctx := context.Background()
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(filepath.Join(t.TempDir(), "planning-calendar-range-upgrade.db")))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, statement := range []string{
		`CREATE TABLE planning_events(
			id TEXT PRIMARY KEY,group_id TEXT NOT NULL,status TEXT NOT NULL,all_day INTEGER NOT NULL,
			start_date TEXT,end_date_exclusive TEXT,starts_at TEXT NOT NULL,ends_at TEXT,response_deadline TEXT
		) STRICT`,
		`INSERT INTO planning_events(id,group_id,status,all_day,starts_at,ends_at,response_deadline)
		 VALUES('upgrade-range','upgrade-group','PUBLISHED',0,'2026-09-01T10:00:00.123456Z','2026-09-01T11:00:00.500001Z','2026-09-01T09:59:59.999999Z')`,
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	migration, err := migrations.Files.ReadFile("0048_planning_calendar_ranges.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, string(migration)); err != nil {
		t.Fatalf("apply calendar range migration: %v", err)
	}
	var starts, ends, deadline int64
	if err := db.QueryRowContext(ctx, `SELECT starts_at_us,ends_at_us,response_deadline_us FROM planning_events WHERE id='upgrade-range'`).Scan(&starts, &ends, &deadline); err != nil {
		t.Fatal(err)
	}
	if starts != 1788256800123456 || ends != 1788260400500001 || deadline != 1788256799999999 {
		t.Fatalf("backfilled microseconds=%d/%d/%d", starts, ends, deadline)
	}
}

func TestPlanningReconfirmationRemovalMigrationPreservesResponses(t *testing.T) {
	ctx := context.Background()
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(filepath.Join(t.TempDir(), "planning-reconfirmation-upgrade.db")))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, statement := range []string{
		`CREATE TABLE planning_events(id TEXT PRIMARY KEY,confirmation_revision INTEGER NOT NULL) STRICT`,
		`CREATE TABLE planning_participations(event_id TEXT NOT NULL,confirmed_revision INTEGER NOT NULL) STRICT`,
		`INSERT INTO planning_events(id,confirmation_revision) VALUES('changed-event',3),('current-event',1)`,
		`INSERT INTO planning_participations(event_id,confirmed_revision) VALUES('changed-event',1),('current-event',1)`,
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	migration, err := migrations.Files.ReadFile("0049_remove_planning_reconfirmation.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, string(migration)); err != nil {
		t.Fatalf("apply reconfirmation removal migration: %v", err)
	}
	var changedRevision, currentRevision int64
	if err := db.QueryRowContext(ctx, `SELECT confirmed_revision FROM planning_participations WHERE event_id='changed-event'`).Scan(&changedRevision); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRowContext(ctx, `SELECT confirmed_revision FROM planning_participations WHERE event_id='current-event'`).Scan(&currentRevision); err != nil {
		t.Fatal(err)
	}
	if changedRevision != 3 || currentRevision != 1 {
		t.Fatalf("confirmed revisions=%d/%d, want 3/1", changedRevision, currentRevision)
	}
}

func assertPlanningAllDayConstraints(t *testing.T, ctx context.Context, db *sql.DB, now string) {
	t.Helper()
	base := `INSERT INTO planning_events(id,group_id,title,event_type,status,audience_type,timezone,starts_at,created_by_membership_id,updated_by_membership_id,created_at,updated_at)`
	if _, err := db.ExecContext(ctx, base+` VALUES('timed-with-date','g','Invalid timed','APPOINTMENT','PUBLISHED','ALL_ACTIVE_MEMBERS','Europe/Berlin',?,'m','m',?,?)`, now, now, now); err != nil {
		t.Fatalf("insert valid timed baseline: %v", err)
	}
	var allDay bool
	var timeZone, startDate, endDateExclusive sql.NullString
	if err := db.QueryRowContext(ctx, `SELECT all_day,timezone,start_date,end_date_exclusive FROM planning_events WHERE id='timed-with-date'`).Scan(&allDay, &timeZone, &startDate, &endDateExclusive); err != nil {
		t.Fatalf("read timed all-day defaults: %v", err)
	}
	if allDay || !timeZone.Valid || timeZone.String != "Europe/Berlin" || startDate.Valid || endDateExclusive.Valid {
		t.Fatalf("timed all-day defaults=%t/%v/%v/%v", allDay, timeZone, startDate, endDateExclusive)
	}
	if _, err := db.ExecContext(ctx, `UPDATE planning_events SET timezone=NULL WHERE id='timed-with-date'`); err == nil {
		t.Fatal("timed event accepted a missing pinned time zone")
	}
	if _, err := db.ExecContext(ctx, `UPDATE planning_events SET start_date='2026-09-01' WHERE id='timed-with-date'`); err == nil {
		t.Fatal("timed event accepted an all-day date")
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO planning_events(id,group_id,title,event_type,status,audience_type,starts_at,ends_at,created_by_membership_id,updated_by_membership_id,created_at,updated_at,all_day,timezone,start_date,end_date_exclusive) VALUES('all-day-valid','g','Valid all day','APPOINTMENT','PUBLISHED','ALL_ACTIVE_MEMBERS','2026-08-31T22:00:00Z','2026-09-01T22:00:00Z','m','m',?,?,1,'Europe/Berlin','2026-09-01','2026-09-02')`, now, now); err != nil {
		t.Fatalf("insert valid all-day event: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO planning_events(id,group_id,title,event_type,status,audience_type,starts_at,created_by_membership_id,updated_by_membership_id,created_at,updated_at,all_day,timezone,start_date,end_date_exclusive) VALUES('all-day-invalid','g','Invalid all day','APPOINTMENT','PUBLISHED','ALL_ACTIVE_MEMBERS',?,'m','m',?,?,1,'Europe/Berlin','2026-09-02','2026-09-02')`, now, now, now); err == nil {
		t.Fatal("all-day event accepted a non-positive calendar range")
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO planning_events(id,group_id,title,event_type,status,audience_type,starts_at,ends_at,created_by_membership_id,updated_by_membership_id,created_at,updated_at,all_day,timezone,start_date,end_date_exclusive) VALUES('all-day-impossible-date','g','Impossible date','APPOINTMENT','PUBLISHED','ALL_ACTIVE_MEMBERS','2026-02-28T23:00:00Z','2026-03-01T23:00:00Z','m','m',?,?,1,'Europe/Berlin','2026-02-30','2026-03-02')`, now, now); err == nil {
		t.Fatal("all-day event accepted a non-existent calendar date")
	}
}

func TestPlanningDraftRetirementMigrationCancelsExistingRowsAndRejectsNewOnes(t *testing.T) {
	ctx := context.Background()
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(filepath.Join(t.TempDir(), "planning-draft-retirement.db")))
	if err != nil {
		t.Fatalf("open retirement fixture: %v", err)
	}
	defer db.Close()
	for _, statement := range []string{
		`CREATE TABLE planning_events(id TEXT PRIMARY KEY,status TEXT NOT NULL,cancelled_at TEXT,version INTEGER NOT NULL,updated_at TEXT NOT NULL) STRICT`,
		`CREATE TABLE planning_series(id TEXT PRIMARY KEY,status TEXT NOT NULL,cancelled_at TEXT,version INTEGER NOT NULL,updated_at TEXT NOT NULL) STRICT`,
		`INSERT INTO planning_events(id,status,version,updated_at) VALUES('event-draft','DRAFT',1,'2026-08-30T10:00:00Z')`,
		`INSERT INTO planning_series(id,status,version,updated_at) VALUES('series-draft','DRAFT',1,'2026-08-30T10:00:00Z')`,
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("prepare retirement fixture: %v", err)
		}
	}
	migration, err := migrations.Files.ReadFile("0047_remove_planning_drafts.sql")
	if err != nil {
		t.Fatalf("read retirement migration: %v", err)
	}
	if _, err := db.ExecContext(ctx, string(migration)); err != nil {
		t.Fatalf("apply retirement migration: %v", err)
	}
	for _, table := range []string{"planning_events", "planning_series"} {
		var status string
		var cancelledAt sql.NullString
		var version int64
		if err := db.QueryRowContext(ctx, `SELECT status,cancelled_at,version FROM `+table+` LIMIT 1`).Scan(&status, &cancelledAt, &version); err != nil {
			t.Fatalf("read retired %s row: %v", table, err)
		}
		if status != "CANCELLED" || !cancelledAt.Valid || version != 2 {
			t.Fatalf("retired %s status/cancelledAt/version=%q/%v/%d", table, status, cancelledAt, version)
		}
		if _, err := db.ExecContext(ctx, `UPDATE `+table+` SET status='DRAFT'`); err == nil {
			t.Fatalf("%s accepted the retired planning status", table)
		}
	}
}

func TestPlanningAllDayMigrationBackfillsExistingEventTimeZones(t *testing.T) {
	ctx := context.Background()
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(filepath.Join(t.TempDir(), "planning-all-day-upgrade.db")))
	if err != nil {
		t.Fatalf("open upgrade fixture: %v", err)
	}
	defer db.Close()
	statements := []string{
		`CREATE TABLE group_notification_settings(group_id TEXT PRIMARY KEY,timezone TEXT NOT NULL) STRICT`,
		`CREATE TABLE planning_events(id TEXT PRIMARY KEY,group_id TEXT NOT NULL,series_id TEXT,starts_at TEXT NOT NULL,ends_at TEXT) STRICT`,
		`CREATE TABLE planning_series_revisions(duration_minutes INTEGER) STRICT`,
		`INSERT INTO group_notification_settings(group_id,timezone) VALUES('group-upgrade','Europe/Berlin')`,
		`INSERT INTO planning_events(id,group_id,starts_at) VALUES('event-upgrade','group-upgrade','2026-09-01T10:00:00Z')`,
	}
	for _, statement := range statements {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("prepare upgrade fixture: %v", err)
		}
	}
	migration, err := migrations.Files.ReadFile("0046_planning_all_day.sql")
	if err != nil {
		t.Fatalf("read all-day migration: %v", err)
	}
	if _, err := db.ExecContext(ctx, string(migration)); err != nil {
		t.Fatalf("apply all-day migration: %v", err)
	}
	var allDay bool
	var timeZone string
	var startDate sql.NullString
	if err := db.QueryRowContext(ctx, `SELECT all_day,timezone,start_date FROM planning_events WHERE id='event-upgrade'`).Scan(&allDay, &timeZone, &startDate); err != nil {
		t.Fatalf("read upgraded event: %v", err)
	}
	if allDay || timeZone != "Europe/Berlin" || startDate.Valid {
		t.Fatalf("upgraded event allDay/timeZone/startDate=%t/%q/%v", allDay, timeZone, startDate)
	}
}

// assertPlanningMigrationColumns verifies recurrence identity columns required
// for stable future-segment edits and individually preserved exceptions.
func assertPlanningMigrationColumns(t *testing.T, ctx context.Context, db interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}, table string, wanted ...string) {
	t.Helper()
	rows, err := db.QueryContext(ctx, `PRAGMA table_info(`+table+`)`)
	if err != nil {
		t.Fatalf("read %s columns: %v", table, err)
	}
	defer rows.Close()
	columns := map[string]struct{}{}
	for rows.Next() {
		var id, notNull, primaryKey int
		var name, columnType string
		var defaultValue any
		if err := rows.Scan(&id, &name, &columnType, &notNull, &defaultValue, &primaryKey); err != nil {
			t.Fatalf("scan %s columns: %v", table, err)
		}
		columns[name] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate %s columns: %v", table, err)
	}
	for _, name := range wanted {
		if _, exists := columns[name]; !exists {
			t.Fatalf("%s missing required column %q", table, name)
		}
	}
}
