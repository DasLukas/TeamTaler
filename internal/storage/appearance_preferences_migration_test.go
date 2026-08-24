package storage

import (
	"context"
	"database/sql"
	"testing"
)

func TestAppearancePreferencesMigrationBackfillsDefaultsAndEnforcesClosedValues(t *testing.T) {
	ctx := context.Background()
	db := openDatabaseThroughMigration(t, "0038_payment_attachments.sql")
	defer db.Close()

	const now = "2026-08-24T10:00:00Z"
	statements := []string{
		`INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('user-one','one@example.test','One','hash',?,?)`,
		`INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES('group-one','One','EUR',?,?)`,
		`INSERT INTO group_settings(group_id,updated_at) VALUES('group-one',?)`,
		`INSERT INTO memberships(id,group_id,user_id,status,joined_at) VALUES('member-one','group-one','user-one','ARCHIVED',?)`,
	}
	for index, statement := range statements {
		arguments := []any{now}
		if index < 2 {
			arguments = []any{now, now}
		}
		if _, err := db.ExecContext(ctx, statement, arguments...); err != nil {
			t.Fatalf("seed appearance fixture %d: %v", index, err)
		}
	}
	if err := Migrate(ctx, db); err != nil {
		t.Fatalf("apply appearance migration: %v", err)
	}

	var colorMode, defaultTheme string
	var themeOverride sql.NullString
	if err := db.QueryRowContext(ctx, `SELECT u.color_mode,settings.default_theme,m.theme_override
		FROM users u JOIN memberships m ON m.user_id=u.id JOIN group_settings settings ON settings.group_id=m.group_id
		WHERE u.id='user-one'`).Scan(&colorMode, &defaultTheme, &themeOverride); err != nil {
		t.Fatalf("read migrated appearance defaults: %v", err)
	}
	if colorMode != "SYSTEM" || defaultTheme != "TEAMTALER" || themeOverride.Valid {
		t.Fatalf("appearance defaults=%q/%q/%#v", colorMode, defaultTheme, themeOverride)
	}

	validStatements := []string{
		`UPDATE users SET color_mode='DARK' WHERE id='user-one'`,
		`UPDATE group_settings SET default_theme='NRW' WHERE group_id='group-one'`,
		`UPDATE memberships SET theme_override='TIEF_IM_WESTEN' WHERE id='member-one'`,
		`UPDATE memberships SET theme_override=NULL WHERE id='member-one'`,
	}
	for index, statement := range validStatements {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("persist valid appearance value %d: %v", index, err)
		}
	}
	invalidStatements := []string{
		`UPDATE users SET color_mode='AUTO' WHERE id='user-one'`,
		`UPDATE group_settings SET default_theme='UNKNOWN' WHERE group_id='group-one'`,
		`UPDATE memberships SET theme_override='UNKNOWN' WHERE id='member-one'`,
	}
	for index, statement := range invalidStatements {
		if _, err := db.ExecContext(ctx, statement); err == nil {
			t.Fatalf("invalid appearance value %d unexpectedly passed", index)
		}
	}
}
