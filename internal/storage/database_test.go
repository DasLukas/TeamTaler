package storage

import (
	"context"
	"database/sql"
	"path/filepath"
	"sort"
	"strings"
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

func TestProductTombstoneMigrationDefaultsToVisible(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, filepath.Join(t.TempDir(), "product-tombstones.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer db.Close()

	statements := []string{
		`INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES('group-one','One','EUR','2026-08-06T12:00:00Z','2026-08-06T12:00:00Z')`,
		`INSERT INTO categories(id,group_id,name,icon,active,sort_order,created_at,updated_at) VALUES('category-one','group-one','One','other',1,0,'2026-08-06T12:00:00Z','2026-08-06T12:00:00Z')`,
		`INSERT INTO products(id,group_id,category_id,name,price_minor,pricing_mode,active,sort_order,created_at,updated_at) VALUES('product-one','group-one','category-one','One',100,'FIXED',1,0,'2026-08-06T12:00:00Z','2026-08-06T12:00:00Z')`,
	}
	for index, statement := range statements {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("prepare tombstone fixture %d: %v", index, err)
		}
	}

	var deletedAt sql.NullString
	if err := db.QueryRowContext(ctx, `SELECT deleted_at FROM products WHERE id='product-one'`).Scan(&deletedAt); err != nil || deletedAt.Valid {
		t.Fatalf("new product deleted_at=%q err=%v, want NULL", deletedAt.String, err)
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
		`CREATE TRIGGER ledger_entries_no_update
			BEFORE UPDATE ON ledger_entries BEGIN SELECT RAISE(ABORT, 'ledger entries are immutable'); END`,
		`CREATE TRIGGER ledger_entries_no_delete
			BEFORE DELETE ON ledger_entries BEGIN SELECT RAISE(ABORT, 'ledger entries are immutable'); END`,
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
	if _, err := db.ExecContext(ctx, `UPDATE ledger_entries SET description='Changed' WHERE id='ledger-one'`); err == nil || !strings.Contains(err.Error(), "ledger entries are immutable") {
		t.Fatalf("update migrated ledger entry error=%v, want immutable trigger rejection", err)
	}
	if _, err := db.ExecContext(ctx, `DELETE FROM ledger_entries WHERE id='ledger-reversal'`); err == nil || !strings.Contains(err.Error(), "ledger entries are immutable") {
		t.Fatalf("delete migrated ledger entry error=%v, want immutable trigger rejection", err)
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
		`INSERT INTO schema_migrations(version) VALUES('0017_dynamic_role_permissions.sql')`,
		`INSERT INTO schema_migrations(version) VALUES('0018_explicit_role_assignments.sql')`,
		`INSERT INTO schema_migrations(version) VALUES('0019_default_membership_role.sql')`,
		`INSERT INTO schema_migrations(version) VALUES('0021_guest_feature.sql')`,
		`INSERT INTO schema_migrations(version) VALUES('0023_membership_lifecycle.sql')`,
		`INSERT INTO schema_migrations(version) VALUES('0024_transaction_settings.sql')`,
		`INSERT INTO schema_migrations(version) VALUES('0026_member_management.sql')`,
		`INSERT INTO schema_migrations(version) VALUES('0027_transaction_reason_modes.sql')`,
		`INSERT INTO schema_migrations(version) VALUES('0028_system_role_semantics.sql')`,
		`INSERT INTO schema_migrations(version) VALUES('0030_system_administration.sql')`,
		`INSERT INTO schema_migrations(version) VALUES('0031_system_group_purge.sql')`,
		`INSERT INTO schema_migrations(version) VALUES('0032_whole_mib_media_limit.sql')`,
		`INSERT INTO schema_migrations(version) VALUES('0035_table_query_indexes.sql')`,
		`INSERT INTO schema_migrations(version) VALUES('0036_notification_channels.sql')`,
		`INSERT INTO schema_migrations(version) VALUES('0037_default_push_notifications.sql')`,
		`INSERT INTO schema_migrations(version) VALUES('0038_payment_attachments.sql')`,
		`INSERT INTO schema_migrations(version) VALUES('0039_activity_payment_created_indexes.sql')`,
		`INSERT INTO schema_migrations(version) VALUES('0040_appearance_preferences.sql')`,
		`INSERT INTO schema_migrations(version) VALUES('0043_activity_reversal_feed_indexes.sql')`,
		`INSERT INTO schema_migrations(version) VALUES('0044_payment_targets.sql')`,
		`INSERT INTO schema_migrations(version) VALUES('0045_planning.sql')`,
		`INSERT INTO schema_migrations(version) VALUES('0046_planning_all_day.sql')`,
		`INSERT INTO schema_migrations(version) VALUES('0047_remove_planning_drafts.sql')`,
		`INSERT INTO schema_migrations(version) VALUES('0048_planning_calendar_ranges.sql')`,
		`INSERT INTO schema_migrations(version) VALUES('0049_remove_planning_reconfirmation.sql')`,
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

func TestDynamicRoleMigrationBackfillsLegacyAccessAndDropsCategoryGrants(t *testing.T) {
	ctx := context.Background()
	db := openDatabaseThroughMigration(t, "0016_product_tombstones.sql")
	defer db.Close()

	now := "2026-08-07T09:00:00Z"
	statements := []struct {
		query string
		args  []any
	}{
		{`INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('user-admin','admin@example.test','Admin','hash',?,?)`, []any{now, now}},
		{`INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('user-finance','finance@example.test','Finance','hash',?,?)`, []any{now, now}},
		{`INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('user-member','member@example.test','Member','hash',?,?)`, []any{now, now}},
		{`INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('user-archived','archived@example.test','Archived','hash',?,?)`, []any{now, now}},
		{`INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES('group-main','Main','EUR',?,?)`, []any{now, now}},
		{`INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES('group-second','Second','EUR',?,?)`, []any{now, now}},
		{`INSERT INTO group_settings(group_id,members_can_view_all_bookings,notification_emails_enabled,updated_at) VALUES('group-main',1,0,?)`, []any{now}},
		{`INSERT INTO group_settings(group_id,members_can_view_all_bookings,notification_emails_enabled,updated_at) VALUES('group-second',0,0,?)`, []any{now}},
		{`INSERT INTO memberships(id,group_id,user_id,status,joined_at) VALUES('member-admin','group-main','user-admin','ACTIVE',?)`, []any{now}},
		{`INSERT INTO memberships(id,group_id,user_id,status,joined_at) VALUES('member-finance','group-main','user-finance','ACTIVE',?)`, []any{now}},
		{`INSERT INTO memberships(id,group_id,user_id,status,joined_at) VALUES('member-regular','group-main','user-member','ACTIVE',?)`, []any{now}},
		{`INSERT INTO memberships(id,group_id,user_id,status,joined_at,archived_at) VALUES('member-archived','group-main','user-archived','ARCHIVED',?,?)`, []any{now, now}},
		{`INSERT INTO memberships(id,group_id,user_id,status,joined_at) VALUES('member-second-admin','group-second','user-admin','ACTIVE',?)`, []any{now}},
		{`INSERT INTO membership_roles(group_id,membership_id,role,granted_at,granted_by) VALUES('group-main','member-admin','ADMIN',?,'user-admin')`, []any{now}},
		{`INSERT INTO membership_roles(group_id,membership_id,role,granted_at,granted_by) VALUES('group-main','member-finance','FINANCE_MANAGER',?,'user-admin')`, []any{now}},
		{`INSERT INTO membership_roles(group_id,membership_id,role,granted_at,granted_by) VALUES('group-main','member-regular','CATALOG_MANAGER',?,'user-admin')`, []any{now}},
		{`INSERT INTO membership_roles(group_id,membership_id,role,granted_at,granted_by) VALUES('group-main','member-archived','CATALOG_MANAGER',?,'user-admin')`, []any{now}},
		{`INSERT INTO membership_roles(group_id,membership_id,role,granted_at,granted_by) VALUES('group-second','member-second-admin','ADMIN',?,'user-admin')`, []any{now}},
		{`INSERT INTO membership_permissions(group_id,membership_id,permission,granted_at,granted_by) VALUES('group-main','member-regular','SELF_RECORD_PAYMENT',?,'user-admin')`, []any{now}},
		{`INSERT INTO categories(id,group_id,name,icon,active,sort_order,created_at,updated_at) VALUES('category-main','group-main','Main','other',1,0,?,?)`, []any{now, now}},
		{`INSERT INTO category_permissions(group_id,membership_id,category_id,permission,granted_at,granted_by) VALUES('group-main','member-regular','category-main','ASSIGN_TO_OTHERS',?,'user-admin')`, []any{now}},
		{`INSERT INTO invitations(id,group_id,email,display_name,token_hash,roles_json,group_permissions_json,category_grants_json,expires_at,created_by,created_at) VALUES('inv-pending','group-main','pending@example.test','Pending','pending-token','["CATALOG_MANAGER"]','["SELF_RECORD_PAYMENT"]','{"category-main":["VOID_BOOKINGS"]}','2099-01-01T00:00:00Z','user-admin',?)`, []any{now}},
		{`INSERT INTO invitations(id,group_id,email,display_name,token_hash,roles_json,group_permissions_json,category_grants_json,expires_at,created_by,created_at) VALUES('inv-expired','group-main','expired@example.test','Expired','expired-token','["FINANCE_MANAGER"]','[]','{}','2000-01-01T00:00:00Z','user-admin',?)`, []any{now}},
	}
	for index, statement := range statements {
		if _, err := db.ExecContext(ctx, statement.query, statement.args...); err != nil {
			t.Fatalf("prepare dynamic-role legacy fixture %d: %v", index, err)
		}
	}

	if err := Migrate(ctx, db); err != nil {
		t.Fatalf("apply dynamic-role migration: %v", err)
	}

	var permissionCount, mainRoleCount, secondRoleCount int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM permission_definitions`).Scan(&permissionCount); err != nil {
		t.Fatalf("count permission definitions: %v", err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM roles WHERE group_id='group-main'`).Scan(&mainRoleCount); err != nil {
		t.Fatalf("count main roles: %v", err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM roles WHERE group_id='group-second'`).Scan(&secondRoleCount); err != nil {
		t.Fatalf("count second roles: %v", err)
	}
	if permissionCount != 18 || mainRoleCount != 5 || secondRoleCount != 4 {
		t.Fatalf("definitions/main roles/second roles = %d/%d/%d, want 18/5/4", permissionCount, mainRoleCount, secondRoleCount)
	}
	wantPresetGrantCounts := map[string]int{
		"role:GROUP_ADMINISTRATOR:group-main": 18,
		"role:MEMBER:group-main":              6,
		"role:FINANCE_MANAGER:group-main":     6,
		"role:CATALOG_MANAGER:group-main":     4,
		"role:LEGACY_SELF_PAYMENT:group-main": 3,
		"role:MEMBER:group-second":            5,
	}
	for roleID, want := range wantPresetGrantCounts {
		var got int
		if err := db.QueryRowContext(ctx, `SELECT count(*) FROM role_permission_grants WHERE role_id=?`, roleID).Scan(&got); err != nil || got != want {
			t.Fatalf("role %s grant count = %d, %v, want %d, nil", roleID, got, err, want)
		}
	}

	wantMembershipPresets := map[string][]string{
		"member-admin":        {"GROUP_ADMINISTRATOR"},
		"member-finance":      {},
		"member-regular":      {},
		"member-archived":     {},
		"member-second-admin": {"GROUP_ADMINISTRATOR"},
	}
	for membershipID, want := range wantMembershipPresets {
		rows, err := db.QueryContext(ctx, `
			SELECT r.preset_key
			FROM membership_role_assignments a
			JOIN roles r ON r.group_id=a.group_id AND r.id=a.role_id
			WHERE a.membership_id=? AND r.preset_key IS NOT NULL
			ORDER BY r.preset_key`, membershipID)
		if err != nil {
			t.Fatalf("list %s presets: %v", membershipID, err)
		}
		var got []string
		for rows.Next() {
			var preset string
			if err := rows.Scan(&preset); err != nil {
				rows.Close()
				t.Fatalf("scan %s preset: %v", membershipID, err)
			}
			got = append(got, preset)
		}
		if err := rows.Close(); err != nil {
			t.Fatalf("close %s presets: %v", membershipID, err)
		}
		if strings.Join(got, ",") != strings.Join(want, ",") {
			t.Fatalf("%s presets = %#v, want %#v", membershipID, got, want)
		}
	}

	var regularSelfPaymentRole, pendingRoleCount, expiredRoleCount int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM membership_role_assignments WHERE membership_id='member-regular' AND role_id='role:LEGACY_SELF_PAYMENT:group-main'`).Scan(&regularSelfPaymentRole); err != nil {
		t.Fatalf("read migrated self-payment membership role: %v", err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM invitation_role_assignments WHERE invitation_id='inv-pending'`).Scan(&pendingRoleCount); err != nil {
		t.Fatalf("count pending invitation roles: %v", err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM invitation_role_assignments WHERE invitation_id='inv-expired'`).Scan(&expiredRoleCount); err != nil {
		t.Fatalf("count expired invitation roles: %v", err)
	}
	if regularSelfPaymentRole != 1 || pendingRoleCount != 3 || expiredRoleCount != 0 {
		t.Fatalf("self-payment/pending/expired assignments = %d/%d/%d, want 1/3/0", regularSelfPaymentRole, pendingRoleCount, expiredRoleCount)
	}

	var memberViewAllGrant, legacyCategoryGrantCount int
	var invitationCategoryGrants string
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM role_permission_grants WHERE role_id='role:MEMBER:group-main' AND permission_key='VIEW_ALL_BOOKING_ACTIVITY' AND scope_type='GROUP'`).Scan(&memberViewAllGrant); err != nil {
		t.Fatalf("read migrated group activity grant: %v", err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM category_permissions`).Scan(&legacyCategoryGrantCount); err != nil {
		t.Fatalf("count discarded membership category grants: %v", err)
	}
	if err := db.QueryRowContext(ctx, `SELECT category_grants_json FROM invitations WHERE id='inv-pending'`).Scan(&invitationCategoryGrants); err != nil {
		t.Fatalf("read discarded invitation category grants: %v", err)
	}
	if memberViewAllGrant != 1 || legacyCategoryGrantCount != 0 || invitationCategoryGrants != "{}" {
		t.Fatalf("activity/category migration = %d/%d/%q, want 1/0/{}", memberViewAllGrant, legacyCategoryGrantCount, invitationCategoryGrants)
	}

	if rows, err := db.QueryContext(ctx, `PRAGMA foreign_key_check`); err != nil {
		t.Fatalf("check dynamic-role migration foreign keys: %v", err)
	} else {
		defer rows.Close()
		if rows.Next() {
			t.Fatal("dynamic-role migration left a foreign-key violation")
		}
	}
}

func TestDynamicRoleSchemaEnforcesProtectedRoleAndAssignmentInvariants(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, filepath.Join(t.TempDir(), "dynamic-role-invariants.db"))
	if err != nil {
		t.Fatalf("open dynamic-role database: %v", err)
	}
	defer db.Close()

	now := "2026-08-07T09:00:00Z"
	statements := []string{
		`INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('user-one','one@example.test','One','hash','2026-08-07T09:00:00Z','2026-08-07T09:00:00Z')`,
		`INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('user-two','two@example.test','Two','hash','2026-08-07T09:00:00Z','2026-08-07T09:00:00Z')`,
		`INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES('group-one','One','EUR','2026-08-07T09:00:00Z','2026-08-07T09:00:00Z')`,
		`INSERT INTO group_settings(group_id,default_role_id,updated_at) VALUES('group-one','role:MEMBER:group-one','2026-08-07T09:00:00Z')`,
		`INSERT INTO memberships(id,group_id,user_id,status,joined_at) VALUES('member-one','group-one','user-one','ACTIVE','2026-08-07T09:00:00Z')`,
		`INSERT INTO memberships(id,group_id,user_id,status,joined_at) VALUES('member-two','group-one','user-two','ACTIVE','2026-08-07T09:00:00Z')`,
		`INSERT INTO membership_role_assignments(group_id,membership_id,role_id,assigned_at) VALUES('group-one','member-two','role:MEMBER:group-one','2026-08-07T09:00:00Z')`,
	}
	for index, statement := range statements {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("prepare role invariant fixture %d: %v", index, err)
		}
	}

	assertRejected := func(name, statement, fragment string) {
		t.Helper()
		if _, err := db.ExecContext(ctx, statement); err == nil || !strings.Contains(err.Error(), fragment) {
			t.Fatalf("%s error = %v, want fragment %q", name, err, fragment)
		}
	}
	assertRejected("rename administrator role", `UPDATE roles SET name='Renamed' WHERE id='role:GROUP_ADMINISTRATOR:group-one'`, "CHECK constraint failed")
	assertRejected("delete administrator role", `DELETE FROM roles WHERE id='role:GROUP_ADMINISTRATOR:group-one'`, "protected role cannot be deleted")
	assertRejected("delete assigned member starter role", `DELETE FROM roles WHERE id='role:MEMBER:group-one'`, "assigned role cannot be deleted")
	for _, permission := range []string{"GROUP_ADMINISTRATION", "MEMBER_MANAGEMENT", "ROLE_MANAGEMENT"} {
		assertRejected("remove administrator core permission "+permission, `DELETE FROM role_permission_grants WHERE role_id='role:GROUP_ADMINISTRATOR:group-one' AND permission_key='`+permission+`'`, "administrator core permissions cannot be removed")
	}
	assertRejected("grant member administration to the default role", `INSERT INTO role_permission_grants(group_id,role_id,permission_key,scope_type,version,created_at,updated_at) VALUES('group-one','role:MEMBER:group-one','MEMBER_MANAGEMENT','GROUP',1,'2026-08-07T09:00:00Z','2026-08-07T09:00:00Z')`, "default role cannot grant administration permissions")
	assertRejected("remove final active member role", `DELETE FROM membership_role_assignments WHERE membership_id='member-two' AND role_id='role:MEMBER:group-one'`, "credentialed active memberships must retain at least one role")
	assertRejected("remove last administrator", `DELETE FROM membership_role_assignments WHERE membership_id='member-one' AND role_id='role:GROUP_ADMINISTRATOR:group-one'`, "group must retain an active group administrator")
	assertRejected("archive last administrator", `UPDATE memberships SET status='ARCHIVED',archived_at='2026-08-07T10:00:00Z' WHERE id='member-one'`, "group must retain an active group administrator")
	assertRejected("duplicate case-insensitive role name", `INSERT INTO roles(id,group_id,name,created_at,updated_at) VALUES('role-duplicate','group-one','mitglied','2026-08-07T09:00:00Z','2026-08-07T09:00:00Z')`, "UNIQUE constraint failed")
	assertRejected("role name control character", "INSERT INTO roles(id,group_id,name,created_at,updated_at) VALUES('role-control','group-one','Bad\nName','2026-08-07T09:00:00Z','2026-08-07T09:00:00Z')", "CHECK constraint failed")

	if _, err := db.ExecContext(ctx, `INSERT INTO membership_role_assignments(group_id,membership_id,role_id,assigned_at,assigned_by) VALUES('group-one','member-two','role:GROUP_ADMINISTRATOR:group-one',?,'user-one')`, now); err != nil {
		t.Fatalf("assign second administrator: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO membership_role_assignments(group_id,membership_id,role_id,assigned_at,assigned_by) VALUES('group-one','member-one','role:MEMBER:group-one',?,'user-one')`, now); err != nil {
		t.Fatalf("assign replacement role before administrator transfer: %v", err)
	}
	if _, err := db.ExecContext(ctx, `DELETE FROM membership_role_assignments WHERE membership_id='member-one' AND role_id='role:GROUP_ADMINISTRATOR:group-one'`); err != nil {
		t.Fatalf("remove administrator when a second remains: %v", err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE memberships SET status='ARCHIVED',archived_at=? WHERE id='member-one'`, now); err != nil {
		t.Fatalf("archive non-administrator membership: %v", err)
	}
	var archivedAssignments int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM membership_role_assignments WHERE membership_id='member-one'`).Scan(&archivedAssignments); err != nil || archivedAssignments != 0 {
		t.Fatalf("archived membership assignments = %d, %v, want 0, nil", archivedAssignments, err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO membership_role_assignments(group_id,membership_id,role_id,assigned_at) VALUES('group-one','member-one','role:CATALOG_MANAGER:group-one',?)`, now); err == nil || !strings.Contains(err.Error(), "roles can only be assigned to active memberships") {
		t.Fatalf("archived membership assignment error = %v, want active-membership rejection", err)
	}

	if _, err := db.ExecContext(ctx, `INSERT INTO roles(id,group_id,name,description,created_at,updated_at) VALUES('role-custom','group-one','Custom','Custom role',?,?)`, now, now); err != nil {
		t.Fatalf("insert custom role: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO membership_role_assignments(group_id,membership_id,role_id,assigned_at) VALUES('group-one','member-two','role-custom',?)`, now); err != nil {
		t.Fatalf("assign custom role: %v", err)
	}
	assertRejected("delete assigned custom role", `DELETE FROM roles WHERE id='role-custom'`, "assigned role cannot be deleted")
	if _, err := db.ExecContext(ctx, `DELETE FROM membership_role_assignments WHERE membership_id='member-two' AND role_id='role-custom'`); err != nil {
		t.Fatalf("remove custom membership assignment: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO invitations(id,group_id,email,token_hash,expires_at,created_by,created_at) VALUES('inv-expiring','group-one','expiring@example.test','expiring-token','2099-01-01T00:00:00Z','user-two',?)`, now); err != nil {
		t.Fatalf("insert expiring invitation: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO invitation_role_assignments(group_id,invitation_id,role_id,assigned_at) VALUES('group-one','inv-expiring','role-custom',?)`, now); err != nil {
		t.Fatalf("assign custom invitation role: %v", err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE invitations SET expires_at='2000-01-01T00:00:00Z' WHERE id='inv-expiring'`); err != nil {
		t.Fatalf("expire invitation: %v", err)
	}
	if _, err := db.ExecContext(ctx, `DELETE FROM roles WHERE id='role-custom'`); err != nil {
		t.Fatalf("delete role assigned only to expired invitation: %v", err)
	}
}

func TestDynamicRoleGrantScopeSchemaIsTenantSafeAndForwardCompatible(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, filepath.Join(t.TempDir(), "dynamic-role-scopes.db"))
	if err != nil {
		t.Fatalf("open dynamic-role scope database: %v", err)
	}
	defer db.Close()

	now := "2026-08-07T09:00:00Z"
	statements := []string{
		`INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES('group-one','One','EUR','2026-08-07T09:00:00Z','2026-08-07T09:00:00Z')`,
		`INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES('group-two','Two','EUR','2026-08-07T09:00:00Z','2026-08-07T09:00:00Z')`,
		`INSERT INTO categories(id,group_id,name,icon,active,sort_order,created_at,updated_at) VALUES('category-one','group-one','One','other',1,0,'2026-08-07T09:00:00Z','2026-08-07T09:00:00Z')`,
		`INSERT INTO categories(id,group_id,name,icon,active,sort_order,created_at,updated_at) VALUES('category-two','group-two','Two','other',1,0,'2026-08-07T09:00:00Z','2026-08-07T09:00:00Z')`,
		`INSERT INTO products(id,group_id,category_id,name,price_minor,pricing_mode,active,sort_order,created_at,updated_at) VALUES('product-one','group-one','category-one','One',100,'FIXED',1,0,'2026-08-07T09:00:00Z','2026-08-07T09:00:00Z')`,
	}
	for index, statement := range statements {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("prepare role scope fixture %d: %v", index, err)
		}
	}

	insert := `INSERT INTO role_permission_grants(group_id,role_id,permission_key,scope_type,category_id,product_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`
	if _, err := db.ExecContext(ctx, insert, "group-one", "role:MEMBER:group-one", "BOOK_FOR_OTHERS", "CATEGORY", "category-one", nil, now, now); err != nil {
		t.Fatalf("insert prepared category grant: %v", err)
	}
	if _, err := db.ExecContext(ctx, insert, "group-one", "role:MEMBER:group-one", "BOOK_FOR_OTHERS", "PRODUCT", nil, "product-one", now, now); err != nil {
		t.Fatalf("insert prepared product grant: %v", err)
	}
	if _, err := db.ExecContext(ctx, insert, "group-one", "role:MEMBER:group-one", "FINANCE_MANAGEMENT", "CATEGORY", "category-two", nil, now, now); err == nil {
		t.Fatal("cross-group category grant unexpectedly passed foreign keys")
	}
	if _, err := db.ExecContext(ctx, insert, "group-one", "role:MEMBER:group-one", "FINANCE_MANAGEMENT", "GROUP", "category-one", nil, now, now); err == nil {
		t.Fatal("malformed group grant unexpectedly passed scope constraint")
	}
	if _, err := db.ExecContext(ctx, insert, "group-one", "role:MEMBER:group-two", "FINANCE_MANAGEMENT", "GROUP", nil, nil, now, now); err == nil {
		t.Fatal("cross-group role grant unexpectedly passed foreign keys")
	}
}

func openDatabaseThroughMigration(t *testing.T, lastMigration string) *sql.DB {
	t.Helper()
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "legacy-through-"+lastMigration+".db")
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path)+"?_pragma=foreign_keys(1)")
	if err != nil {
		t.Fatalf("open legacy migration database: %v", err)
	}
	if _, err := db.ExecContext(ctx, `CREATE TABLE schema_migrations(version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))) STRICT`); err != nil {
		db.Close()
		t.Fatalf("create legacy migration table: %v", err)
	}
	entries, err := migrations.Files.ReadDir(".")
	if err != nil {
		db.Close()
		t.Fatalf("read migrations: %v", err)
	}
	var names []string
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".sql") && entry.Name() <= lastMigration {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)
	for _, name := range names {
		body, err := migrations.Files.ReadFile(name)
		if err != nil {
			db.Close()
			t.Fatalf("read migration %s: %v", name, err)
		}
		if _, err := db.ExecContext(ctx, string(body)); err != nil {
			db.Close()
			t.Fatalf("apply legacy migration %s: %v", name, err)
		}
		if _, err := db.ExecContext(ctx, `INSERT INTO schema_migrations(version) VALUES(?)`, name); err != nil {
			db.Close()
			t.Fatalf("mark legacy migration %s: %v", name, err)
		}
	}
	return db
}
