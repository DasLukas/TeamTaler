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
		`CREATE TABLE products(id TEXT PRIMARY KEY, price_minor INTEGER NOT NULL CHECK(price_minor > 0)) STRICT`,
		`CREATE TABLE bookings(id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT, category_name TEXT NOT NULL, category_type TEXT NOT NULL) STRICT`,
		`INSERT INTO categories(id,name,type) VALUES('cat-drinks','Drinks','STANDARD')`,
		`INSERT INTO products(id,price_minor) VALUES('product-water',100)`,
		`INSERT INTO bookings(id,product_id,category_name,category_type) VALUES('booking-one','product-water','Drinks','STANDARD')`,
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
	var priceMinor int64
	var pricingMode string
	if err := db.QueryRowContext(ctx, `SELECT price_minor,pricing_mode FROM products WHERE id='product-water'`).Scan(&priceMinor, &pricingMode); err != nil {
		t.Fatalf("read migrated product pricing: %v", err)
	}
	if priceMinor != 100 || pricingMode != "FIXED" {
		t.Fatalf("migrated product pricing = %d/%s, want 100/FIXED", priceMinor, pricingMode)
	}
	if rows, err := db.QueryContext(ctx, `PRAGMA foreign_key_check`); err != nil {
		t.Fatalf("check migrated foreign keys: %v", err)
	} else {
		defer rows.Close()
		if rows.Next() {
			t.Fatal("product pricing migration left a foreign-key violation")
		}
	}
}

func TestProductPricingConstraintRejectsInconsistentRows(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, filepath.Join(t.TempDir(), "pricing.db"))
	if err != nil {
		t.Fatalf("open pricing database: %v", err)
	}
	defer db.Close()

	var groupID, categoryID string
	if err := db.QueryRowContext(ctx, `SELECT id FROM groups LIMIT 1`).Scan(&groupID); err == nil {
		t.Fatal("fresh database unexpectedly contains a group")
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES('group-test','Test','EUR','2026-08-04T00:00:00Z','2026-08-04T00:00:00Z')`); err != nil {
		t.Fatalf("insert group fixture: %v", err)
	}
	groupID = "group-test"
	if _, err := db.ExecContext(ctx, `INSERT INTO categories(id,group_id,name,active,sort_order,created_at,updated_at) VALUES('category-test',?,'Test',1,0,'2026-08-04T00:00:00Z','2026-08-04T00:00:00Z')`, groupID); err != nil {
		t.Fatalf("insert category fixture: %v", err)
	}
	categoryID = "category-test"
	insert := `INSERT INTO products(id,group_id,category_id,name,price_minor,pricing_mode,active,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?,1,0,'2026-08-04T00:00:00Z','2026-08-04T00:00:00Z')`
	if _, err := db.ExecContext(ctx, insert, "product-custom", groupID, categoryID, "Custom", nil, "USER_DEFINED"); err != nil {
		t.Fatalf("insert user-defined product: %v", err)
	}
	if _, err := db.ExecContext(ctx, insert, "product-invalid-fixed", groupID, categoryID, "Invalid fixed", nil, "FIXED"); err == nil {
		t.Fatal("fixed product without price unexpectedly passed the database constraint")
	}
	if _, err := db.ExecContext(ctx, insert, "product-invalid-custom", groupID, categoryID, "Invalid custom", 100, "USER_DEFINED"); err == nil {
		t.Fatal("user-defined product with catalog price unexpectedly passed the database constraint")
	}
}
