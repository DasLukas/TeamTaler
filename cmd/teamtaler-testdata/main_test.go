package main

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"testing"
	"time"

	_ "modernc.org/sqlite"
)

// TestRunSeedsDiverseGermanEnvironment verifies the fixture topology through
// the same command entry point used by the local test server.
func TestRunSeedsDiverseGermanEnvironment(t *testing.T) {
	seedStartedAt := time.Now().UTC().Truncate(time.Second)
	dataDirectory := filepath.Join(t.TempDir(), "data")
	if err := os.Mkdir(dataDirectory, 0o700); err != nil {
		t.Fatalf("create test data directory: %v", err)
	}
	databasePath := filepath.Join(dataDirectory, "teamtaler.db")
	t.Setenv("TEAMTALER_DATA_DIR", dataDirectory)
	t.Setenv("TEAMTALER_DATABASE_PATH", databasePath)
	t.Setenv("TEAMTALER_PUBLIC_URL", "http://127.0.0.1:8080")
	for _, name := range []string{
		"TEAMTALER_SMTP_HOST",
		"TEAMTALER_SMTP_PORT",
		"TEAMTALER_SMTP_USERNAME",
		"TEAMTALER_SMTP_PASSWORD",
		"TEAMTALER_SMTP_FROM_ADDRESS",
		"TEAMTALER_SMTP_FROM_NAME",
		"TEAMTALER_SMTP_TLS_MODE",
		"TEAMTALER_EMAIL_TOKEN_KEY",
	} {
		t.Setenv(name, "")
	}

	if err := run(); err != nil {
		t.Fatalf("seed test data: %v", err)
	}
	seedFinishedAt := time.Now().UTC().Truncate(time.Second)

	db, err := sql.Open("sqlite", databasePath)
	if err != nil {
		t.Fatalf("open seeded database: %v", err)
	}
	defer db.Close()
	ctx := context.Background()
	fixtureLocation, err := time.LoadLocation(planningFixtureZone)
	if err != nil {
		t.Fatalf("load planning fixture timezone: %v", err)
	}
	planningReference := seededPlanningReference(t, ctx, db)
	planningRanges := newPlanningFixtureRanges(planningReference, fixtureLocation)

	assertCount(t, ctx, db, `SELECT count(*) FROM groups`, nil, 2)
	assertCount(t, ctx, db, `SELECT count(*) FROM groups WHERE name IN (?,?)`, []any{primaryGroupName, secondaryGroupName}, 2)
	assertCount(t, ctx, db, `SELECT count(*) FROM groups WHERE logo_key IS NOT NULL`, nil, 1)
	assertCount(t, ctx, db, `SELECT count(*) FROM memberships m JOIN users u ON u.id=m.user_id WHERE u.email=? AND m.status='ACTIVE'`, []any{adminEmail}, 2)
	assertCount(t, ctx, db, `SELECT count(*) FROM memberships m JOIN users u ON u.id=m.user_id WHERE u.email=? AND m.status='ACTIVE'`, []any{"lena@example.test"}, 2)
	assertCount(t, ctx, db, `SELECT count(*) FROM memberships m JOIN users u ON u.id=m.user_id WHERE u.email=? AND m.status='ACTIVE'`, []any{secondaryMemberEmail}, 1)
	assertCount(t, ctx, db, `SELECT count(*) FROM memberships m JOIN users u ON u.id=m.user_id JOIN groups g ON g.id=m.group_id WHERE u.email=? AND g.name=? AND m.status='ACTIVE'`, []any{secondaryMemberEmail, secondaryGroupName}, 1)
	assertCount(t, ctx, db, `SELECT count(*) FROM memberships m JOIN groups g ON g.id=m.group_id WHERE g.name=? AND m.status='ACTIVE'`, []any{secondaryGroupName}, 4)
	assertCount(t, ctx, db, `SELECT count(*) FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.status='ACTIVE' AND u.email IS NULL AND u.password_hash IS NULL`, nil, 3)
	assertCount(t, ctx, db, `SELECT count(*) FROM categories c JOIN groups g ON g.id=c.group_id WHERE g.name=? AND c.name=?`, []any{secondaryGroupName, secondaryCategory}, 1)
	assertCount(t, ctx, db, `SELECT count(*) FROM products p JOIN categories c ON c.id=p.category_id JOIN groups g ON g.id=c.group_id WHERE g.name=? AND p.name=? AND p.price_minor=180`, []any{secondaryGroupName, secondaryProduct}, 1)
	assertCount(t, ctx, db, `SELECT count(*) FROM products WHERE deleted_at IS NULL`, nil, 9)
	assertCount(t, ctx, db, `SELECT count(*) FROM products WHERE deleted_at IS NULL AND image_key IS NOT NULL`, nil, 5)
	assertCount(t, ctx, db, `SELECT count(*) FROM products WHERE deleted_at IS NULL AND image_key IS NULL`, nil, 4)
	assertCount(t, ctx, db, `SELECT count(*) FROM users WHERE active=1 AND email IS NOT NULL`, nil, 7)
	assertCount(t, ctx, db, `SELECT count(*) FROM users WHERE active=1 AND email IS NOT NULL AND avatar_key IS NOT NULL`, nil, 4)
	assertCount(t, ctx, db, `SELECT count(*) FROM users WHERE active=1 AND email IS NOT NULL AND avatar_key IS NULL`, nil, 3)
	assertCount(t, ctx, db, `SELECT count(*) FROM memberships m JOIN users u ON u.id=m.user_id WHERE u.email=?`, []any{systemOnlyAdminEmail}, 0)
	assertCount(t, ctx, db, `SELECT count(*) FROM system_role_assignments assignment JOIN users u ON u.id=assignment.user_id WHERE u.email=? AND assignment.role='SYSTEM_ADMINISTRATOR'`, []any{systemOnlyAdminEmail}, 1)
	for _, groupName := range []string{primaryGroupName, secondaryGroupName} {
		assertCount(t, ctx, db, `SELECT count(*) FROM group_reason_suggestions r JOIN groups g ON g.id=r.group_id WHERE g.name=? AND r.kind='BOOKING'`, []any{groupName}, 4)
		assertCount(t, ctx, db, `SELECT count(*) FROM group_reason_suggestions r JOIN groups g ON g.id=r.group_id WHERE g.name=? AND r.kind='PAYMENT'`, []any{groupName}, 4)
	}
	assertCount(t, ctx, db, `SELECT count(*) FROM group_settings WHERE settlements_enabled=1 AND settlement_due_soon_days=7 AND settlement_overdue_repeat_days=3`, nil, 2)
	assertCount(t, ctx, db, `SELECT count(*) FROM group_planning_settings WHERE enabled=1`, nil, 2)
	assertCount(t, ctx, db, `SELECT count(*) FROM planning_series WHERE status='PUBLISHED'`, nil, 12)
	for eventType := range map[string]struct{}{
		"APPOINTMENT":              {},
		"APPOINTMENT_POLL":         {},
		"APPOINTMENT_REGISTRATION": {},
	} {
		assertCount(t, ctx, db, `SELECT count(*) FROM planning_series_revisions WHERE event_type=?`, []any{eventType}, 4)
	}
	assertCount(t, ctx, db, `SELECT count(*) FROM planning_series_revisions WHERE all_day=1 AND start_date IS NOT NULL AND duration_days BETWEEN 1 AND 2 AND duration_minutes IS NULL`, nil, 6)
	assertCount(t, ctx, db, `SELECT count(*) FROM planning_series_recipients`, nil, 48)
	assertCount(t, ctx, db, `SELECT count(*) FROM planning_series_notification_tasks WHERE event_type='PLANNING_SERIES_PUBLISHED'`, nil, 48)
	assertCount(t, ctx, db, `SELECT count(*) FROM planning_events WHERE series_id IS NOT NULL`, nil, 60)
	assertCount(t, ctx, db, `SELECT count(*) FROM planning_events WHERE series_id IS NOT NULL AND series_sequence IS NOT NULL AND original_start_at IS NOT NULL`, nil, 60)
	assertCount(t, ctx, db, `SELECT count(*) FROM (SELECT series_id FROM planning_events WHERE series_id IS NOT NULL GROUP BY series_id HAVING count(*)=5 AND count(DISTINCT series_sequence)=5 AND min(series_sequence)=1 AND max(series_sequence)=5)`, nil, 12)
	assertCount(t, ctx, db, `SELECT count(*) FROM planning_events WHERE series_id IS NOT NULL AND is_series_exception=1`, nil, 6)
	assertCount(t, ctx, db, `SELECT count(*) FROM planning_events WHERE series_id IS NOT NULL AND status='CANCELLED'`, nil, 2)
	assertCount(t, ctx, db, `SELECT count(*) FROM planning_events WHERE series_id IS NOT NULL AND title='Verschobener Teamabend'`, nil, 2)
	assertCount(t, ctx, db, `SELECT count(*) FROM planning_events WHERE series_id IS NOT NULL AND title='Verlängerte ganztägige Schichtanmeldung' AND all_day=1 AND original_start_date IS NOT NULL`, nil, 2)
	assertCount(t, ctx, db, `SELECT count(*) FROM planning_events WHERE series_id IS NOT NULL AND title<>'Ganztägige DST-Teamtage' AND starts_at<?`, []any{planningRanges.day.start}, 20)
	assertCount(t, ctx, db, `SELECT count(*) FROM planning_events WHERE series_id IS NOT NULL AND title<>'Ganztägige DST-Teamtage' AND starts_at>=? AND starts_at<?`, []any{planningRanges.day.start, planningRanges.day.end}, 10)
	assertCount(t, ctx, db, `SELECT count(*) FROM planning_events WHERE series_id IS NOT NULL AND title<>'Ganztägige DST-Teamtage' AND starts_at>=?`, []any{planningRanges.day.end}, 20)
	assertCount(t, ctx, db, `SELECT count(*) FROM planning_events WHERE status='PUBLISHED'`, nil, 74)
	for eventType, expected := range map[string]int{
		"APPOINTMENT":              28,
		"APPOINTMENT_POLL":         24,
		"APPOINTMENT_REGISTRATION": 24,
	} {
		assertCount(t, ctx, db, `SELECT count(*) FROM planning_events WHERE event_type=?`, []any{eventType}, expected)
	}
	assertCount(t, ctx, db, `SELECT count(*) FROM planning_events WHERE all_day=1 AND timezone='Europe/Berlin' AND start_date IS NOT NULL AND end_date_exclusive>start_date AND original_start_date IS NOT NULL`, nil, 30)
	assertCount(t, ctx, db, `SELECT count(*) FROM planning_events WHERE all_day=1 AND event_type=?`, []any{"APPOINTMENT"}, 12)
	assertCount(t, ctx, db, `SELECT count(*) FROM planning_events WHERE all_day=1 AND event_type=?`, []any{"APPOINTMENT_POLL"}, 10)
	assertCount(t, ctx, db, `SELECT count(*) FROM planning_events WHERE all_day=1 AND event_type=?`, []any{"APPOINTMENT_REGISTRATION"}, 10)
	assertCount(t, ctx, db, `SELECT count(*) FROM planning_events WHERE all_day=1 AND CAST(julianday(end_date_exclusive)-julianday(start_date) AS INTEGER)>=2`, nil, 24)
	assertCount(t, ctx, db, `SELECT count(*) FROM planning_events WHERE all_day=1 AND title='Ganztägige DST-Teamtage' AND abs((julianday(ends_at)-julianday(starts_at))*24-48)>0.5`, nil, 4)
	assertCount(t, ctx, db, `SELECT count(*) FROM planning_events WHERE response_deadline_minutes_before=720`, nil, 48)
	assertMinimumCount(t, ctx, db, `SELECT count(*) FROM planning_events WHERE ends_at<?`, []any{seedStartedAt.Format(time.RFC3339)}, 26)
	assertMinimumCount(t, ctx, db, `SELECT count(*) FROM planning_events WHERE starts_at<? AND ends_at>?`, []any{seedStartedAt.Format(time.RFC3339), seedFinishedAt.Format(time.RFC3339)}, 8)
	assertMinimumCount(t, ctx, db, `SELECT count(*) FROM planning_events WHERE starts_at>=?`, []any{planningRanges.day.end}, 26)
	assertMinimumCount(t, ctx, db, `SELECT count(DISTINCT substr(starts_at,1,10)) FROM planning_events`, nil, 16)
	assertCount(t, ctx, db, `SELECT count(*) FROM planning_events WHERE title='Laufender Teamtermin' AND starts_at<? AND ends_at>?`, []any{planningReference.Format(time.RFC3339), planningReference.Format(time.RFC3339)}, 2)
	assertCount(t, ctx, db, `SELECT count(*) FROM planning_events WHERE title='Mehrtägiges Planungstreffen' AND all_day=1 AND start_date<? AND end_date_exclusive>?`, []any{planningRanges.localDate, planningRanges.nextLocalDate}, 2)
	for view, fixtureRange := range map[string]planningFixtureRange{
		"day":    planningRanges.day,
		"week":   planningRanges.week,
		"month":  planningRanges.month,
		"agenda": planningRanges.agenda,
	} {
		t.Run("planning "+view+" range", func(t *testing.T) {
			assertCount(t, ctx, db, `SELECT count(*) FROM (
				SELECT group_id,event_type,all_day
				FROM planning_events
				WHERE status='PUBLISHED' AND starts_at<? AND coalesce(ends_at,starts_at)>?
				GROUP BY group_id,event_type,all_day
			)`, []any{fixtureRange.end, fixtureRange.start}, 12)
		})
	}
	assertPlanningWallClockStarts(t, ctx, db, planningRanges.day, fixtureLocation)
	assertCount(t, ctx, db, `SELECT count(DISTINCT earlier.group_id)
		FROM planning_events earlier
		JOIN planning_events later ON later.group_id=earlier.group_id AND later.id>earlier.id
		WHERE earlier.status='PUBLISHED' AND later.status='PUBLISHED'
		AND earlier.all_day=0 AND later.all_day=0
		AND earlier.starts_at<? AND coalesce(earlier.ends_at,earlier.starts_at)>?
		AND later.starts_at<? AND coalesce(later.ends_at,later.starts_at)>?
		AND earlier.starts_at<coalesce(later.ends_at,later.starts_at)
		AND later.starts_at<coalesce(earlier.ends_at,earlier.starts_at)`, []any{
		planningRanges.day.end,
		planningRanges.day.start,
		planningRanges.day.end,
		planningRanges.day.start,
	}, 2)
	assertCount(t, ctx, db, `SELECT count(DISTINCT group_id) FROM planning_events WHERE series_id IS NOT NULL AND starts_at<? AND coalesce(ends_at,starts_at)>?`, []any{planningRanges.month.end, planningRanges.month.start}, 2)
	assertCount(t, ctx, db, `SELECT count(*) FROM planning_events WHERE is_series_exception=1 AND status='PUBLISHED' AND starts_at>=? AND starts_at<?`, []any{planningRanges.agenda.start, planningRanges.agenda.end}, 2)
	assertCount(t, ctx, db, `SELECT count(*) FROM planning_event_audience`, nil, 304)
	assertCount(t, ctx, db, `SELECT count(*) FROM planning_participations WHERE status='YES'`, nil, 2)
	assertCount(t, ctx, db, `SELECT count(*) FROM planning_participations WHERE status='MAYBE'`, nil, 2)
	assertCount(t, ctx, db, `SELECT count(*) FROM planning_participations WHERE status='REGISTERED'`, nil, 4)
	assertCount(t, ctx, db, `SELECT count(*) FROM membership_notification_channels`, nil, 308)
	assertCount(t, ctx, db, `SELECT count(*) FROM roles`, nil, 10)
	assertCount(t, ctx, db, `SELECT count(*) FROM roles WHERE preset_key='GROUP_ADMINISTRATOR'`, nil, 2)
	assertCount(t, ctx, db, `SELECT count(*) FROM roles WHERE id NOT IN (
		'role:GROUP_ADMINISTRATOR:' || group_id,
		'role:MEMBER:' || group_id,
		'role:FINANCE_MANAGER:' || group_id,
		'role:CATALOG_MANAGER:' || group_id,
		'role:GUEST:' || group_id
	)`, nil, 0)
	assertCount(t, ctx, db, `SELECT count(*) FROM role_permission_grants`, nil, 42)
	assertCount(t, ctx, db, `SELECT count(*) FROM role_permission_grants WHERE permission_key IN ('BOOK_FOR_OTHERS','BOOK_FOR_GUESTS')`, nil, 0)
	assertCount(t, ctx, db, `SELECT count(*) FROM bookings WHERE voided_at IS NULL`, nil, 28)
	assertCount(t, ctx, db, `SELECT count(*) FROM bookings WHERE voided_at IS NOT NULL AND void_reason=? AND voided_by IS NOT NULL`, []any{"Doppelte Testbuchung"}, 1)
	assertCount(t, ctx, db, `SELECT count(*) FROM payments WHERE reversed_at IS NULL`, nil, 9)
	assertCount(t, ctx, db, `SELECT count(*) FROM payments WHERE reversed_at IS NOT NULL AND reversal_reason=? AND reversed_by IS NOT NULL`, []any{"Doppelte Testzahlung"}, 1)
	assertCount(t, ctx, db, `SELECT count(*) FROM periods WHERE status='CLOSED'`, nil, 3)
	assertCount(t, ctx, db, `SELECT count(*) FROM periods WHERE status='OPEN'`, nil, 2)
	assertMinimumCount(t, ctx, db, `SELECT count(*) FROM period_statements`, nil, 12)
	assertCount(t, ctx, db, `SELECT count(DISTINCT image_key) FROM (
		SELECT image_key FROM products WHERE image_key IS NOT NULL
		UNION ALL
		SELECT avatar_key AS image_key FROM users WHERE avatar_key IS NOT NULL
		UNION ALL
		SELECT logo_key AS image_key FROM groups WHERE logo_key IS NOT NULL
	)`, nil, 10)
	storedImages, err := os.ReadDir(filepath.Join(dataDirectory, "images"))
	if err != nil {
		t.Fatalf("read stored fixture images: %v", err)
	}
	if len(storedImages) != 10 {
		t.Fatalf("stored fixture images=%d, want 10", len(storedImages))
	}
}

// assertPlanningWallClockStarts verifies the intentional half-hour collision
// pattern used to exercise Day and Week overlap layout.
func assertPlanningWallClockStarts(t *testing.T, ctx context.Context, db *sql.DB, fixtureRange planningFixtureRange, location *time.Location) {
	t.Helper()
	wantMinutes := map[string]int{
		"Wöchentlicher Teamabend":    9 * 60,
		"Wöchentliche Essensabfrage": 9*60 + 30,
		"Wöchentliches Schichtessen": 10 * 60,
	}
	rows, err := db.QueryContext(ctx, `SELECT title,starts_at FROM planning_events WHERE title IN (?,?,?) AND starts_at>=? AND starts_at<? ORDER BY title,group_id`,
		"Wöchentlicher Teamabend",
		"Wöchentliche Essensabfrage",
		"Wöchentliches Schichtessen",
		fixtureRange.start,
		fixtureRange.end,
	)
	if err != nil {
		t.Fatalf("load planning wall-clock fixtures: %v", err)
	}
	defer rows.Close()
	seen := make(map[string]int, len(wantMinutes))
	for rows.Next() {
		var title, value string
		if err := rows.Scan(&title, &value); err != nil {
			t.Fatalf("scan planning wall-clock fixture: %v", err)
		}
		start, err := time.Parse(time.RFC3339, value)
		if err != nil {
			t.Fatalf("parse planning wall-clock fixture %q: %v", value, err)
		}
		local := start.In(location)
		if got, want := local.Hour()*60+local.Minute(), wantMinutes[title]; got != want {
			t.Fatalf("planning wall-clock fixture %q starts at minute %d, want %d", title, got, want)
		}
		seen[title]++
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate planning wall-clock fixtures: %v", err)
	}
	for title := range wantMinutes {
		if seen[title] != 2 {
			t.Fatalf("planning wall-clock fixture %q count=%d, want 2", title, seen[title])
		}
	}
}

type planningFixtureRange struct {
	start string
	end   string
}

type planningFixtureRanges struct {
	localDate     string
	nextLocalDate string
	day           planningFixtureRange
	week          planningFixtureRange
	month         planningFixtureRange
	agenda        planningFixtureRange
}

// seededPlanningReference recovers the stable seed clock from the intentionally
// centered standalone event instead of coupling assertions to test duration.
func seededPlanningReference(t *testing.T, ctx context.Context, db *sql.DB) time.Time {
	t.Helper()
	var value string
	if err := db.QueryRowContext(ctx, `SELECT starts_at FROM planning_events WHERE title='Laufender Teamtermin' ORDER BY id LIMIT 1`).Scan(&value); err != nil {
		t.Fatalf("load planning fixture reference: %v", err)
	}
	start, err := time.Parse(time.RFC3339, value)
	if err != nil {
		t.Fatalf("parse planning fixture reference %q: %v", value, err)
	}
	return start.Add(30 * time.Minute)
}

// newPlanningFixtureRanges builds the exact exclusive API intervals exercised
// by the Day, Week, Month, and 90-day Agenda calendar views.
func newPlanningFixtureRanges(reference time.Time, location *time.Location) planningFixtureRanges {
	local := reference.In(location)
	dayStart := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, location)
	dayEnd := dayStart.AddDate(0, 0, 1)
	daysSinceMonday := (int(dayStart.Weekday()) + 6) % 7
	weekStart := dayStart.AddDate(0, 0, -daysSinceMonday)
	weekEnd := weekStart.AddDate(0, 0, 7)
	monthFirst := time.Date(local.Year(), local.Month(), 1, 0, 0, 0, 0, location)
	monthDaysSinceMonday := (int(monthFirst.Weekday()) + 6) % 7
	monthStart := monthFirst.AddDate(0, 0, -monthDaysSinceMonday)
	monthEnd := monthStart.AddDate(0, 0, 42)
	formatRange := func(start, end time.Time) planningFixtureRange {
		return planningFixtureRange{
			start: start.UTC().Format(time.RFC3339),
			end:   end.UTC().Format(time.RFC3339),
		}
	}
	return planningFixtureRanges{
		localDate:     dayStart.Format(time.DateOnly),
		nextLocalDate: dayEnd.Format(time.DateOnly),
		day:           formatRange(dayStart, dayEnd),
		week:          formatRange(weekStart, weekEnd),
		month:         formatRange(monthStart, monthEnd),
		agenda:        formatRange(dayStart, dayStart.AddDate(0, 0, 90)),
	}
}

// assertCount compares one scalar query result with want and fails the current
// test with the query text when the database topology differs.
func assertCount(t *testing.T, ctx context.Context, db *sql.DB, query string, args []any, want int) {
	t.Helper()
	var got int
	if err := db.QueryRowContext(ctx, query, args...).Scan(&got); err != nil {
		t.Fatalf("query %q: %v", query, err)
	}
	if got != want {
		t.Fatalf("query %q returned %d, want %d", query, got, want)
	}
}

// assertMinimumCount verifies that a scalar count meets a lower bound.
func assertMinimumCount(t *testing.T, ctx context.Context, db *sql.DB, query string, args []any, minimum int) {
	t.Helper()
	var got int
	if err := db.QueryRowContext(ctx, query, args...).Scan(&got); err != nil {
		t.Fatalf("query %q: %v", query, err)
	}
	if got < minimum {
		t.Fatalf("query %q returned %d, want at least %d", query, got, minimum)
	}
}
