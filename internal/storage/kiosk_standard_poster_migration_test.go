package storage

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"

	"github.com/DasLukas/TeamTaler/migrations"
)

func TestStandardPosterMigrationPreservesLegacyTemplatesAndSeedsGroups(t *testing.T) {
	ctx := context.Background()
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(filepath.Join(t.TempDir(), "legacy.db"))+"?_pragma=foreign_keys(1)")
	if err != nil {
		t.Fatalf("open legacy database: %v", err)
	}
	defer db.Close()
	if _, err := db.ExecContext(ctx, `CREATE TABLE groups(id TEXT PRIMARY KEY) STRICT;
		INSERT INTO groups(id) VALUES('old-group');`); err != nil {
		t.Fatalf("prepare legacy group: %v", err)
	}
	previousSchema, err := migrations.Files.ReadFile("0059_kiosk_posters.sql")
	if err != nil {
		t.Fatalf("read previous migration: %v", err)
	}
	if _, err := db.ExecContext(ctx, string(previousSchema)); err != nil {
		t.Fatalf("create previous poster schema: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO kiosk_posters(id,group_id,name,text,created_at,updated_at)
		VALUES('old-standard','old-group','Standard','Keep this text','2026-09-23T00:00:00Z','2026-09-23T00:00:00Z'),
		('old-empty','old-group','Legacy empty','Another text','2026-09-23T00:00:00Z','2026-09-23T00:00:00Z')`); err != nil {
		t.Fatalf("prepare old posters: %v", err)
	}
	currentMigration, err := migrations.Files.ReadFile("0060_kiosk_standard_poster.sql")
	if err != nil {
		t.Fatalf("read current migration: %v", err)
	}
	if _, err := db.ExecContext(ctx, string(currentMigration)); err != nil {
		t.Fatalf("migrate posters: %v", err)
	}
	var defaults int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM kiosk_posters WHERE group_id='old-group' AND is_default=1 AND name='Standard'`).Scan(&defaults); err != nil || defaults != 1 {
		t.Fatalf("old group defaults=%d error=%v, want one", defaults, err)
	}
	var name, text string
	var version int64
	if err := db.QueryRowContext(ctx, `SELECT name,text,version FROM kiosk_posters WHERE id='old-standard'`).Scan(&name, &text, &version); err != nil || name != "Standard (previous)" || text != "Keep this text" || version != 2 {
		t.Fatalf("legacy poster=%q/%q/v%d error=%v", name, text, version, err)
	}
	if err := db.QueryRowContext(ctx, `SELECT text FROM kiosk_posters WHERE id='old-empty'`).Scan(&text); err != nil || text != "Another text" {
		t.Fatalf("old empty poster text=%q error=%v", text, err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO groups(id) VALUES('new-group')`); err != nil {
		t.Fatalf("insert new group: %v", err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM kiosk_posters WHERE group_id='new-group' AND is_default=1 AND name='Standard'`).Scan(&defaults); err != nil || defaults != 1 {
		t.Fatalf("new group defaults=%d error=%v, want one", defaults, err)
	}
}
