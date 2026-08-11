package main

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"
)

// TestRunSeedsTwoIsolatedGroups verifies the disposable fixture's group and
// membership topology through the same command entry point used by the local
// test server.
func TestRunSeedsTwoIsolatedGroups(t *testing.T) {
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
	assertCount(t, ctx, db, `SELECT count(*) FROM memberships m JOIN users u ON u.id=m.user_id WHERE u.email=? AND m.status='ACTIVE'`, []any{adminEmail}, 2)
	assertCount(t, ctx, db, `SELECT count(*) FROM memberships m JOIN users u ON u.id=m.user_id WHERE u.email=? AND m.status='ACTIVE'`, []any{"lena@example.test"}, 2)
	assertCount(t, ctx, db, `SELECT count(*) FROM memberships m JOIN users u ON u.id=m.user_id WHERE u.email=? AND m.status='ACTIVE'`, []any{secondaryMemberEmail}, 1)
	assertCount(t, ctx, db, `SELECT count(*) FROM memberships m JOIN users u ON u.id=m.user_id JOIN groups g ON g.id=m.group_id WHERE u.email=? AND g.name=? AND m.status='ACTIVE'`, []any{secondaryMemberEmail, secondaryGroupName}, 1)
	assertCount(t, ctx, db, `SELECT count(*) FROM memberships m JOIN groups g ON g.id=m.group_id WHERE g.name=? AND m.status='ACTIVE'`, []any{secondaryGroupName}, 3)
	assertCount(t, ctx, db, `SELECT count(*) FROM categories c JOIN groups g ON g.id=c.group_id WHERE g.name=? AND c.name=?`, []any{secondaryGroupName, secondaryCategory}, 1)
	assertCount(t, ctx, db, `SELECT count(*) FROM products p JOIN categories c ON c.id=p.category_id JOIN groups g ON g.id=c.group_id WHERE g.name=? AND p.name=? AND p.price_minor=180`, []any{secondaryGroupName, secondaryProduct}, 1)
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
