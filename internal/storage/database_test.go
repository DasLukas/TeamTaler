package storage

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
)

func TestMigrateRejectsUnknownFutureMigration(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "teamtaler.db")
	db, err := Open(ctx, path)
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO schema_migrations(version) VALUES('9999_future.sql')`); err != nil {
		db.Close()
		t.Fatalf("insert future migration fixture: %v", err)
	}
	if err := db.Close(); err != nil {
		t.Fatalf("close database: %v", err)
	}
	if _, err := Open(ctx, path); err == nil {
		t.Fatal("database with unknown migration unexpectedly opened")
	}
}

func TestMigrateRemovesSecondaryCategoryType(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, filepath.Join(t.TempDir(), "teamtaler.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer db.Close()

	for table, removedColumn := range map[string]string{"categories": "type", "bookings": "category_type"} {
		rows, err := db.QueryContext(ctx, `SELECT name FROM pragma_table_info(?)`, table)
		if err != nil {
			t.Fatalf("inspect %s schema: %v", table, err)
		}
		for rows.Next() {
			var column string
			if err := rows.Scan(&column); err != nil {
				rows.Close()
				t.Fatalf("scan %s schema: %v", table, err)
			}
			if column == removedColumn {
				rows.Close()
				t.Fatalf("%s still contains redundant %s column", table, removedColumn)
			}
		}
		if err := rows.Close(); err != nil {
			t.Fatalf("close %s schema rows: %v", table, err)
		}
	}
}

func TestRemoveCategoryTypeMigrationPreservesExistingRows(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "legacy.db")
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path))
	if err != nil {
		t.Fatalf("open legacy database: %v", err)
	}
	defer db.Close()

	legacyStatements := []string{
		`CREATE TABLE schema_migrations(version TEXT PRIMARY KEY) STRICT`,
		`INSERT INTO schema_migrations(version) VALUES('0001_initial.sql')`,
		`CREATE TABLE groups(id TEXT PRIMARY KEY) STRICT`,
		`CREATE TABLE invitations(id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE) STRICT`,
		`CREATE TABLE categories(id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL) STRICT`,
		`CREATE TABLE bookings(id TEXT PRIMARY KEY, category_name TEXT NOT NULL, category_type TEXT NOT NULL) STRICT`,
		`INSERT INTO categories(id,name,type) VALUES('cat-drinks','Drinks','STANDARD')`,
		`INSERT INTO bookings(id,category_name,category_type) VALUES('booking-one','Drinks','STANDARD')`,
	}
	for _, statement := range legacyStatements {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("prepare legacy database: %v", err)
		}
	}

	if err := Migrate(ctx, db); err != nil {
		t.Fatalf("migrate legacy database: %v", err)
	}
	var categoryName, bookingCategoryName string
	if err := db.QueryRowContext(ctx, `SELECT name FROM categories WHERE id='cat-drinks'`).Scan(&categoryName); err != nil {
		t.Fatalf("read migrated category: %v", err)
	}
	if err := db.QueryRowContext(ctx, `SELECT category_name FROM bookings WHERE id='booking-one'`).Scan(&bookingCategoryName); err != nil {
		t.Fatalf("read migrated booking: %v", err)
	}
	if categoryName != "Drinks" || bookingCategoryName != "Drinks" {
		t.Fatalf("migration changed category snapshots: category=%q booking=%q", categoryName, bookingCategoryName)
	}
}
