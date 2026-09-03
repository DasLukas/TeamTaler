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

	db, err := sql.Open("sqlite", databasePath)
	if err != nil {
		t.Fatalf("open seeded database: %v", err)
	}
	defer db.Close()
	ctx := context.Background()

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
	assertCount(t, ctx, db, `SELECT count(*) FROM group_settings WHERE settlements_enabled=1 AND notification_emails_enabled=1`, nil, 2)
	assertCount(t, ctx, db, `SELECT count(*) FROM group_notification_events`, nil, 14)
	assertCount(t, ctx, db, `SELECT count(*) FROM membership_notification_channels`, nil, 154)
	assertCount(t, ctx, db, `SELECT count(*) FROM roles`, nil, 10)
	assertCount(t, ctx, db, `SELECT count(*) FROM roles WHERE preset_key='GROUP_ADMINISTRATOR'`, nil, 2)
	assertCount(t, ctx, db, `SELECT count(*) FROM roles WHERE id NOT IN (
		'role:GROUP_ADMINISTRATOR:' || group_id,
		'role:MEMBER:' || group_id,
		'role:FINANCE_MANAGER:' || group_id,
		'role:CATALOG_MANAGER:' || group_id,
		'role:GUEST:' || group_id
	)`, nil, 0)
	assertCount(t, ctx, db, `SELECT count(*) FROM role_permission_grants`, nil, 28)
	assertCount(t, ctx, db, `SELECT count(*) FROM role_permission_grants WHERE permission_key IN ('BOOK_FOR_OTHERS','BOOK_FOR_GUESTS')`, nil, 0)
	assertCount(t, ctx, db, `SELECT count(*) FROM bookings WHERE voided_at IS NULL`, nil, 28)
	assertCount(t, ctx, db, `SELECT count(*) FROM bookings WHERE voided_at IS NOT NULL AND void_reason=? AND voided_by IS NOT NULL`, []any{"Doppelte Testbuchung"}, 1)
	assertCount(t, ctx, db, `SELECT count(*) FROM payments WHERE reversed_at IS NULL`, nil, 9)
	assertCount(t, ctx, db, `SELECT count(*) FROM payments WHERE reversed_at IS NOT NULL AND reversal_reason=? AND reversed_by IS NOT NULL`, []any{"Doppelte Testzahlung"}, 1)
	assertCount(t, ctx, db, `SELECT count(*) FROM periods WHERE status='CLOSED'`, nil, 3)
	assertCount(t, ctx, db, `SELECT count(*) FROM periods WHERE status='OPEN'`, nil, 2)
	fixtureNow := time.Now().UTC().Add(time.Second).Format(time.RFC3339Nano)
	assertCount(t, ctx, db, `SELECT count(*) FROM periods WHERE starts_at>?`, []any{fixtureNow}, 0)
	assertCount(t, ctx, db, `SELECT count(*) FROM bookings WHERE created_at>?`, []any{fixtureNow}, 0)
	assertCount(t, ctx, db, `SELECT count(*) FROM payments WHERE created_at>?`, []any{fixtureNow}, 0)
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
