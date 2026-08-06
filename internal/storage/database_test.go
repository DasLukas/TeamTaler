package storage

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"

	"github.com/DasLukas/TeamTaler/migrations"
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

func TestSelfPaymentPermissionMigrationUsesSafeDefaultsAndConstraints(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, filepath.Join(t.TempDir(), "self-payment-permissions.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer db.Close()

	now := "2026-08-06T12:00:00Z"
	statements := []string{
		`INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('user-one','one@example.test','One','hash',?,?)`,
		`INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES('group-one','One','EUR',?,?)`,
		`INSERT INTO memberships(id,group_id,user_id,status,joined_at) VALUES('member-one','group-one','user-one','ACTIVE',?)`,
		`INSERT INTO invitations(id,group_id,email,token_hash,expires_at,created_by,created_at) VALUES('inv-one','group-one','invited@example.test','token-hash','2099-01-01T00:00:00Z','user-one',?)`,
	}
	for index, statement := range statements {
		arguments := []any{now}
		if index < 2 {
			arguments = []any{now, now}
		}
		if _, err := db.ExecContext(ctx, statement, arguments...); err != nil {
			t.Fatalf("prepare fixture %d: %v", index, err)
		}
	}

	var invitationPermissions string
	if err := db.QueryRowContext(ctx, `SELECT group_permissions_json FROM invitations WHERE id='inv-one'`).Scan(&invitationPermissions); err != nil || invitationPermissions != "[]" {
		t.Fatalf("invitation group permissions=%q err=%v, want []", invitationPermissions, err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO membership_permissions(group_id,membership_id,permission,granted_at,granted_by) VALUES('group-one','member-one','SELF_RECORD_PAYMENT',?, 'user-one')`, now); err != nil {
		t.Fatalf("insert supported permission: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO membership_permissions(group_id,membership_id,permission,granted_at) VALUES('group-one','member-one','UNSUPPORTED',?)`, now); err == nil {
		t.Fatal("unsupported group permission unexpectedly passed the database constraint")
	}
}

func TestPayPalPaymentMethodMigrationPreservesFinancialRows(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "legacy-payments.db")
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path)+"?_pragma=foreign_keys(1)")
	if err != nil {
		t.Fatalf("open legacy payments database: %v", err)
	}
	defer db.Close()

	statements := []string{
		`CREATE TABLE schema_migrations(version TEXT PRIMARY KEY) STRICT`,
		`CREATE TABLE groups(id TEXT PRIMARY KEY) STRICT`,
		`CREATE TABLE memberships(id TEXT PRIMARY KEY, group_id TEXT NOT NULL, UNIQUE(group_id,id)) STRICT`,
		`CREATE TABLE periods(id TEXT PRIMARY KEY, group_id TEXT NOT NULL, UNIQUE(group_id,id)) STRICT`,
		`CREATE TABLE categories(id TEXT PRIMARY KEY, group_id TEXT NOT NULL, UNIQUE(group_id,id)) STRICT`,
		`CREATE TABLE bookings(id TEXT PRIMARY KEY, group_id TEXT NOT NULL, UNIQUE(group_id,id)) STRICT`,
		`CREATE TABLE payments(
			id TEXT PRIMARY KEY, group_id TEXT NOT NULL, membership_id TEXT NOT NULL,
			amount_minor INTEGER NOT NULL CHECK(amount_minor > 0), received_at TEXT NOT NULL,
			method TEXT NOT NULL CHECK(method IN ('CASH','BANK_TRANSFER','OTHER')), reference TEXT, note TEXT,
			created_by TEXT NOT NULL, created_at TEXT NOT NULL, reversed_at TEXT, reversed_by TEXT, reversal_reason TEXT,
			UNIQUE(group_id,id), FOREIGN KEY(group_id,membership_id) REFERENCES memberships(group_id,id) ON DELETE RESTRICT
		) STRICT`,
		`CREATE INDEX payments_member_idx ON payments(group_id,membership_id,received_at DESC)`,
		`CREATE TABLE payment_allocations(
			group_id TEXT NOT NULL, payment_id TEXT NOT NULL, period_id TEXT NOT NULL,
			amount_minor INTEGER NOT NULL CHECK(amount_minor > 0), PRIMARY KEY(payment_id,period_id),
			FOREIGN KEY(group_id,payment_id) REFERENCES payments(group_id,id) ON DELETE RESTRICT,
			FOREIGN KEY(group_id,period_id) REFERENCES periods(group_id,id) ON DELETE RESTRICT
		) STRICT`,
		`CREATE TABLE ledger_entries(
			id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE RESTRICT,
			period_id TEXT, membership_id TEXT, category_id TEXT, booking_id TEXT, payment_id TEXT, reversal_of TEXT,
			account TEXT NOT NULL CHECK(account IN ('MEMBER_RECEIVABLE','CATEGORY_REVENUE','GROUP_CASH')),
			amount_minor INTEGER NOT NULL CHECK(amount_minor <> 0), description TEXT NOT NULL, created_at TEXT NOT NULL,
			UNIQUE(group_id,id), FOREIGN KEY(group_id,period_id) REFERENCES periods(group_id,id) ON DELETE RESTRICT,
			FOREIGN KEY(group_id,membership_id) REFERENCES memberships(group_id,id) ON DELETE RESTRICT,
			FOREIGN KEY(group_id,category_id) REFERENCES categories(group_id,id) ON DELETE RESTRICT,
			FOREIGN KEY(group_id,booking_id) REFERENCES bookings(group_id,id) ON DELETE RESTRICT,
			FOREIGN KEY(group_id,payment_id) REFERENCES payments(group_id,id) ON DELETE RESTRICT,
			FOREIGN KEY(group_id,reversal_of) REFERENCES ledger_entries(group_id,id) ON DELETE RESTRICT
		) STRICT`,
		`CREATE INDEX ledger_group_member_idx ON ledger_entries(group_id,membership_id,created_at)`,
		`CREATE INDEX ledger_booking_idx ON ledger_entries(booking_id)`,
		`CREATE INDEX ledger_payment_idx ON ledger_entries(payment_id)`,
		`CREATE UNIQUE INDEX ledger_one_reversal_idx ON ledger_entries(reversal_of) WHERE reversal_of IS NOT NULL`,
		`INSERT INTO groups(id) VALUES('group-one')`,
		`INSERT INTO memberships(id,group_id) VALUES('member-one','group-one')`,
		`INSERT INTO periods(id,group_id) VALUES('period-one','group-one')`,
		`INSERT INTO payments(id,group_id,membership_id,amount_minor,received_at,method,reference,created_by,created_at)
		 VALUES('payment-one','group-one','member-one',500,'2026-08-01T00:00:00Z','BANK_TRANSFER','Legacy reference','member-one','2026-08-01T00:00:00Z')`,
		`INSERT INTO payment_allocations(group_id,payment_id,period_id,amount_minor) VALUES('group-one','payment-one','period-one',500)`,
		`INSERT INTO ledger_entries(id,group_id,period_id,membership_id,payment_id,account,amount_minor,description,created_at)
		 VALUES('ledger-one','group-one','period-one','member-one','payment-one','GROUP_CASH',500,'Payment received','2026-08-01T00:00:00Z')`,
		`INSERT INTO ledger_entries(id,group_id,period_id,membership_id,payment_id,reversal_of,account,amount_minor,description,created_at)
		 VALUES('ledger-reversal','group-one','period-one','member-one','payment-one','ledger-one','GROUP_CASH',-500,'Reversal: Payment received','2026-08-02T00:00:00Z')`,
	}
	for index, statement := range statements {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("prepare legacy payment fixture %d: %v", index, err)
		}
	}
	migrationEntries, err := migrations.Files.ReadDir(".")
	if err != nil {
		t.Fatalf("read embedded migrations: %v", err)
	}
	for _, entry := range migrationEntries {
		if entry.Name() == "0013_add_paypal_payment_method.sql" {
			continue
		}
		if _, err := db.ExecContext(ctx, `INSERT INTO schema_migrations(version) VALUES(?)`, entry.Name()); err != nil {
			t.Fatalf("mark migration %s applied: %v", entry.Name(), err)
		}
	}

	if err := Migrate(ctx, db); err != nil {
		t.Fatalf("migrate PayPal payment method: %v", err)
	}
	var method, reference string
	if err := db.QueryRowContext(ctx, `SELECT method,reference FROM payments WHERE id='payment-one'`).Scan(&method, &reference); err != nil || method != "BANK_TRANSFER" || reference != "Legacy reference" {
		t.Fatalf("preserved payment = %q/%q err=%v", method, reference, err)
	}
	var allocationCount, ledgerCount int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM payment_allocations WHERE payment_id='payment-one'`).Scan(&allocationCount); err != nil || allocationCount != 1 {
		t.Fatalf("preserved allocations=%d err=%v", allocationCount, err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM ledger_entries WHERE payment_id='payment-one'`).Scan(&ledgerCount); err != nil || ledgerCount != 2 {
		t.Fatalf("preserved ledger entries=%d err=%v", ledgerCount, err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO payments(id,group_id,membership_id,amount_minor,received_at,method,reference,created_by,created_at)
		VALUES('payment-paypal','group-one','member-one',100,'2026-08-03T00:00:00Z','PAYPAL','PayPal reference','member-one','2026-08-03T00:00:00Z')`); err != nil {
		t.Fatalf("insert PayPal payment after migration: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO payments(id,group_id,membership_id,amount_minor,received_at,method,reference,created_by,created_at)
		VALUES('payment-unsupported','group-one','member-one',100,'2026-08-03T00:00:00Z','CARD','Card reference','member-one','2026-08-03T00:00:00Z')`); err == nil {
		t.Fatal("unsupported payment method unexpectedly passed the database constraint")
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
		`INSERT INTO schema_migrations(version) VALUES('0013_add_paypal_payment_method.sql')`,
		`CREATE TABLE users(id TEXT PRIMARY KEY) STRICT`,
		`CREATE TABLE groups(id TEXT PRIMARY KEY) STRICT`,
		`CREATE TABLE invitations(id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE) STRICT`,
		`CREATE TABLE notifications(id TEXT PRIMARY KEY, group_id TEXT NOT NULL, membership_id TEXT NOT NULL, created_at TEXT NOT NULL) STRICT`,
		`CREATE TABLE categories(id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL) STRICT`,
		`CREATE TABLE products(id TEXT PRIMARY KEY, price_minor INTEGER NOT NULL CHECK(price_minor > 0)) STRICT`,
		`CREATE TABLE periods(id TEXT PRIMARY KEY, label TEXT NOT NULL, status TEXT NOT NULL) STRICT`,
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
	var categoryName, categoryIcon, bookingCategoryName string
	if err := db.QueryRowContext(ctx, `SELECT name,icon FROM categories WHERE id='cat-drinks'`).Scan(&categoryName, &categoryIcon); err != nil {
		t.Fatalf("read migrated category: %v", err)
	}
	if err := db.QueryRowContext(ctx, `SELECT category_name FROM bookings WHERE id='booking-one'`).Scan(&bookingCategoryName); err != nil {
		t.Fatalf("read migrated booking: %v", err)
	}
	if categoryName != "Drinks" || categoryIcon != "drink" || bookingCategoryName != "Drinks" {
		t.Fatalf("migrated category/booking = %q/%q/%q, want Drinks/drink/Drinks", categoryName, categoryIcon, bookingCategoryName)
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
	if _, err := db.ExecContext(ctx, `UPDATE categories SET icon='unsupported' WHERE id=?`, categoryID); err == nil {
		t.Fatal("unsupported category icon unexpectedly passed the database constraint")
	}
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

func TestOpenPeriodLabelMigrationPreservesCustomAndClosedLabels(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, filepath.Join(t.TempDir(), "period-labels.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer db.Close()

	fixtures := []struct {
		groupID  string
		periodID string
		label    string
		status   string
	}{
		{groupID: "group-current", periodID: "period-current", label: "Current period", status: "OPEN"},
		{groupID: "group-next", periodID: "period-next", label: "Next period", status: "OPEN"},
		{groupID: "group-custom", periodID: "period-custom", label: "August 2026", status: "OPEN"},
		{groupID: "group-closed", periodID: "period-closed", label: "Current period", status: "CLOSED"},
	}
	for _, fixture := range fixtures {
		if _, err := db.ExecContext(ctx, `INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES(?,?, 'EUR','2026-08-01T00:00:00Z','2026-08-01T00:00:00Z')`, fixture.groupID, fixture.groupID); err != nil {
			t.Fatalf("insert group %s: %v", fixture.groupID, err)
		}
		if _, err := db.ExecContext(ctx, `INSERT INTO periods(id,group_id,label,status,starts_at,created_at) VALUES(?,?,?,?, '2026-08-01T00:00:00Z','2026-08-01T00:00:00Z')`, fixture.periodID, fixture.groupID, fixture.label, fixture.status); err != nil {
			t.Fatalf("insert period %s: %v", fixture.periodID, err)
		}
	}
	migration, err := migrations.Files.ReadFile("0011_localize_open_period_labels.sql")
	if err != nil {
		t.Fatalf("read period-label migration: %v", err)
	}
	if _, err := db.ExecContext(ctx, string(migration)); err != nil {
		t.Fatalf("apply period-label migration: %v", err)
	}

	wantLabels := map[string]string{
		"period-current": "Aktueller Zeitraum",
		"period-next":    "Aktueller Zeitraum",
		"period-custom":  "August 2026",
		"period-closed":  "Current period",
	}
	for periodID, want := range wantLabels {
		var label string
		if err := db.QueryRowContext(ctx, `SELECT label FROM periods WHERE id=?`, periodID).Scan(&label); err != nil || label != want {
			t.Fatalf("period %s label = %q err=%v, want %q", periodID, label, err, want)
		}
	}
}
