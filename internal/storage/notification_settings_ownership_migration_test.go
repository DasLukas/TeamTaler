package storage

import (
	"context"
	"database/sql"
	"testing"
)

func TestNotificationSettingsOwnershipMigrationMovesCadenceAndCommonTimeZone(t *testing.T) {
	ctx := context.Background()
	db := openDatabaseThroughMigration(t, "0049_remove_planning_reconfirmation.sql")
	defer db.Close()
	seedLegacyNotificationGroups(t, db, "Europe/Berlin")
	if _, err := db.ExecContext(ctx, `UPDATE group_notification_settings SET settlement_due_soon_days=5,settlement_overdue_repeat_days=11 WHERE group_id='group-one'`); err != nil {
		t.Fatalf("configure legacy reminder cadence: %v", err)
	}

	if err := Migrate(ctx, db); err != nil {
		t.Fatalf("apply notification ownership migration: %v", err)
	}

	var dueSoonDays, repeatDays int
	if err := db.QueryRowContext(ctx, `SELECT settlement_due_soon_days,settlement_overdue_repeat_days FROM group_settings WHERE group_id='group-one'`).Scan(&dueSoonDays, &repeatDays); err != nil {
		t.Fatalf("read migrated reminder cadence: %v", err)
	}
	if dueSoonDays != 5 || repeatDays != 11 {
		t.Fatalf("migrated reminder cadence=%d/%d, want 5/11", dueSoonDays, repeatDays)
	}
	var timeZone string
	if err := db.QueryRowContext(ctx, `SELECT value_text FROM system_setting_overrides WHERE setting_key='instance.timezone'`).Scan(&timeZone); err != nil || timeZone != "Europe/Berlin" {
		t.Fatalf("migrated common time zone=%q err=%v", timeZone, err)
	}
	for _, table := range []string{"group_notification_settings", "group_notification_events"} {
		var count int
		if err := db.QueryRowContext(ctx, `SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?`, table).Scan(&count); err != nil || count != 0 {
			t.Fatalf("removed table %s count=%d err=%v", table, count, err)
		}
	}
}

func TestNotificationSettingsOwnershipMigrationFallsBackForDivergentTimeZones(t *testing.T) {
	ctx := context.Background()
	db := openDatabaseThroughMigration(t, "0049_remove_planning_reconfirmation.sql")
	defer db.Close()
	seedLegacyNotificationGroups(t, db, "UTC")

	if err := Migrate(ctx, db); err != nil {
		t.Fatalf("apply divergent notification ownership migration: %v", err)
	}
	var count int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM system_setting_overrides WHERE setting_key='instance.timezone'`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("divergent time-zone override count=%d err=%v, want 0", count, err)
	}
}

func seedLegacyNotificationGroups(t *testing.T, db *sql.DB, secondTimeZone string) {
	t.Helper()
	ctx := context.Background()
	const now = "2026-09-03T08:00:00Z"
	for _, group := range []string{"group-one", "group-two"} {
		if _, err := db.ExecContext(ctx, `INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES(?,?,?,?,?)`, group, group, "EUR", now, now); err != nil {
			t.Fatalf("insert legacy group %s: %v", group, err)
		}
		if _, err := db.ExecContext(ctx, `INSERT INTO group_settings(group_id,members_can_view_all_bookings,notification_emails_enabled,updated_at) VALUES(?,0,0,?)`, group, now); err != nil {
			t.Fatalf("insert legacy group settings %s: %v", group, err)
		}
	}
	if _, err := db.ExecContext(ctx, `UPDATE group_notification_settings SET timezone=? WHERE group_id='group-two'`, secondTimeZone); err != nil {
		t.Fatalf("configure second legacy time zone: %v", err)
	}
}
