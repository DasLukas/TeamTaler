package storage

import (
	"context"
	"database/sql"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestTableQueryIndexesMigration(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	db, err := Open(ctx, filepath.Join(t.TempDir(), "teamtaler.db"))
	if err != nil {
		t.Fatalf("open migrated database: %v", err)
	}
	defer db.Close()

	want := []string{
		"bookings_group_created_page_idx", "bookings_group_actor_created_page_idx",
		"bookings_group_target_created_page_idx", "bookings_group_category_created_page_idx",
		"bookings_group_product_created_page_idx", "payments_group_received_page_idx",
		"payments_group_member_received_page_idx", "payments_group_method_received_page_idx",
		"payments_group_reversed_received_page_idx", "ledger_member_movements_page_idx",
		"payments_group_created_page_idx", "payments_group_member_created_page_idx",
		"audit_group_time_page_idx", "audit_group_actor_time_page_idx",
		"audit_group_action_time_page_idx", "audit_group_resource_time_page_idx",
		"system_audit_time_page_idx", "system_audit_actor_time_page_idx", "system_audit_action_time_page_idx",
		"system_audit_resource_time_page_idx",
	}
	for _, name := range want {
		var count int
		if err := db.QueryRowContext(ctx, `SELECT count(*) FROM sqlite_schema WHERE type='index' AND name=?`, name).Scan(&count); err != nil {
			t.Fatalf("read index %s: %v", name, err)
		}
		if count != 1 {
			t.Errorf("index %s count = %d, want 1", name, count)
		}
	}
	var migrationCount int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM schema_migrations WHERE version='0035_table_query_indexes.sql'`).Scan(&migrationCount); err != nil {
		t.Fatalf("read migration ledger: %v", err)
	}
	if migrationCount != 1 {
		t.Fatalf("migration ledger count = %d, want 1", migrationCount)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM schema_migrations WHERE version='0039_activity_payment_created_indexes.sql'`).Scan(&migrationCount); err != nil {
		t.Fatalf("read activity payment index migration ledger: %v", err)
	}
	if migrationCount != 1 {
		t.Fatalf("activity payment index migration ledger count = %d, want 1", migrationCount)
	}

	assertQueryPlanUsesIndex(t, db, `SELECT id FROM bookings WHERE group_id=? ORDER BY strftime('%Y-%m-%dT%H:%M:%fZ',created_at) DESC,id DESC LIMIT 101`, "bookings_group_created_page_idx", "grp")
	assertQueryPlanUsesIndex(t, db, `SELECT id FROM payments WHERE group_id=? ORDER BY strftime('%Y-%m-%dT%H:%M:%fZ',received_at) DESC,id DESC LIMIT 101`, "payments_group_received_page_idx", "grp")
	assertQueryPlanUsesIndex(t, db, `SELECT id FROM payments WHERE group_id=? ORDER BY strftime('%Y-%m-%dT%H:%M:%fZ',created_at) DESC,id DESC LIMIT 101`, "payments_group_created_page_idx", "grp")
	assertQueryPlanUsesIndex(t, db, `SELECT id FROM ledger_entries WHERE group_id=? AND membership_id=? AND account='MEMBER_RECEIVABLE' ORDER BY strftime('%Y-%m-%dT%H:%M:%fZ',created_at) DESC,id DESC LIMIT 101`, "ledger_member_movements_page_idx", "grp", "mem")
	assertQueryPlanUsesIndex(t, db, `SELECT id FROM audit_events WHERE group_id=? ORDER BY strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) DESC,id DESC LIMIT 101`, "audit_group_time_page_idx", "grp")
	assertQueryPlanUsesIndex(t, db, `SELECT id FROM system_audit_events ORDER BY strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) DESC,id DESC LIMIT 101`, "system_audit_time_page_idx")
}

func TestActivityPaymentCreatedIndexesMigrationPreservesExistingFinancialData(t *testing.T) {
	ctx := context.Background()
	db := openDatabaseThroughMigration(t, "0038_payment_attachments.sql")
	defer db.Close()

	const (
		now        = "2026-08-20T10:00:00Z"
		storageKey = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.pdf"
	)
	statements := []string{
		`INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('user-existing','existing@example.test','Existing Member','hash',?,?)`,
		`INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES('group-existing','Existing Group','EUR',?,?)`,
		`INSERT INTO group_settings(group_id,updated_at) VALUES('group-existing',?)`,
		`INSERT INTO memberships(id,group_id,user_id,status,joined_at) VALUES('member-existing','group-existing','user-existing','ACTIVE',?)`,
		`INSERT INTO periods(id,group_id,label,status,starts_at,created_at) VALUES('period-existing','group-existing','Existing Period','OPEN',?,?)`,
		`INSERT INTO categories(id,group_id,name,icon,active,sort_order,created_at,updated_at) VALUES('category-existing','group-existing','Existing Category','other',1,0,?,?)`,
		`INSERT INTO products(id,group_id,category_id,name,price_minor,pricing_mode,active,sort_order,created_at,updated_at) VALUES('product-existing','group-existing','category-existing','Existing Product',500,'FIXED',1,0,?,?)`,
		`INSERT INTO bookings(id,group_id,period_id,category_id,product_id,actor_membership_id,target_membership_id,quantity,unit_price_minor,total_minor,product_name,category_name,reason,created_at,voided_at,voided_by,void_reason)
			VALUES('booking-existing','group-existing','period-existing','category-existing','product-existing','member-existing','member-existing',1,500,500,'Existing Product','Existing Category','Legacy booking',?,'2026-08-20T11:00:00Z','member-existing','Duplicate')`,
		`INSERT INTO payments(id,group_id,membership_id,amount_minor,received_at,method,method_label,reference,note,created_by,created_at,reversed_at,reversed_by,reversal_reason)
			VALUES('payment-existing','group-existing','member-existing',750,'2026-08-19T00:00:00Z','CASH',NULL,'Legacy payment','Imported before configurable methods','member-existing',?,'2026-08-20T12:00:00Z','member-existing','Duplicate')`,
		`INSERT INTO ledger_entries(id,group_id,period_id,membership_id,category_id,booking_id,account,amount_minor,description,created_at)
			VALUES('ledger-booking','group-existing','period-existing','member-existing','category-existing','booking-existing','MEMBER_RECEIVABLE',500,'Existing booking',?)`,
		`INSERT INTO ledger_entries(id,group_id,period_id,membership_id,category_id,booking_id,reversal_of,account,amount_minor,description,created_at)
			VALUES('ledger-booking-reversal','group-existing','period-existing','member-existing','category-existing','booking-existing','ledger-booking','MEMBER_RECEIVABLE',-500,'Reversal: Existing booking','2026-08-20T11:00:00Z')`,
		`INSERT INTO ledger_entries(id,group_id,period_id,membership_id,payment_id,account,amount_minor,description,created_at)
			VALUES('ledger-payment','group-existing','period-existing','member-existing','payment-existing','MEMBER_RECEIVABLE',-750,'Existing payment',?)`,
		`INSERT INTO ledger_entries(id,group_id,period_id,membership_id,payment_id,reversal_of,account,amount_minor,description,created_at)
			VALUES('ledger-payment-reversal','group-existing','period-existing','member-existing','payment-existing','ledger-payment','MEMBER_RECEIVABLE',750,'Reversal: Existing payment','2026-08-20T12:00:00Z')`,
		`INSERT INTO payment_attachments(payment_id,group_id,storage_key,original_filename,media_type,size_bytes,sha256,created_by_membership_id,created_at)
			VALUES('payment-existing','group-existing',?,'legacy.pdf','application/pdf',128,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','member-existing',?)`,
	}
	for index, statement := range statements {
		arguments := []any{now}
		switch index {
		case 0, 1, 4, 5, 6:
			arguments = []any{now, now}
		case 10, 12:
			arguments = nil
		case 13:
			arguments = []any{storageKey, now}
		}
		if _, err := db.ExecContext(ctx, statement, arguments...); err != nil {
			t.Fatalf("seed pre-activity-index data %d: %v", index, err)
		}
	}

	before := readActivityMigrationSnapshot(t, db)
	if err := Migrate(ctx, db); err != nil {
		t.Fatalf("upgrade populated database through activity indexes: %v", err)
	}
	after := readActivityMigrationSnapshot(t, db)
	if !reflect.DeepEqual(after, before) {
		t.Fatalf("financial data changed during index-only migration:\nbefore=%#v\nafter=%#v", before, after)
	}
	for _, index := range []string{"payments_group_created_page_idx", "payments_group_member_created_page_idx"} {
		var count int
		if err := db.QueryRowContext(ctx, `SELECT count(*) FROM sqlite_schema WHERE type='index' AND name=?`, index).Scan(&count); err != nil || count != 1 {
			t.Fatalf("activity index %s count=%d err=%v, want 1", index, count, err)
		}
	}
	if err := Migrate(ctx, db); err != nil {
		t.Fatalf("re-run activity index migration: %v", err)
	}
	if repeated := readActivityMigrationSnapshot(t, db); !reflect.DeepEqual(repeated, before) {
		t.Fatalf("repeated migration changed financial data: got=%#v want=%#v", repeated, before)
	}
	var migrationCount int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM schema_migrations WHERE version='0039_activity_payment_created_indexes.sql'`).Scan(&migrationCount); err != nil || migrationCount != 1 {
		t.Fatalf("activity migration ledger count=%d err=%v, want 1", migrationCount, err)
	}
	var integrity string
	if err := db.QueryRowContext(ctx, `PRAGMA integrity_check`).Scan(&integrity); err != nil || integrity != "ok" {
		t.Fatalf("post-migration integrity=%q err=%v", integrity, err)
	}
	rows, err := db.QueryContext(ctx, `PRAGMA foreign_key_check`)
	if err != nil {
		t.Fatalf("post-migration foreign-key check: %v", err)
	}
	defer rows.Close()
	if rows.Next() {
		t.Fatal("activity index migration left a foreign-key violation")
	}
}

type activityMigrationSnapshot struct {
	BookingCount, PaymentCount, LedgerCount, AttachmentCount int
	BookingTotal, PaymentTotal, ReceivableBalance            int64
	BookingReason, BookingVoidedAt                           string
	PaymentMethod, PaymentReference, PaymentCreatedAt        string
	PaymentMethodLabel                                       sql.NullString
	PaymentReversedAt                                        string
}

func readActivityMigrationSnapshot(t *testing.T, db *sql.DB) activityMigrationSnapshot {
	t.Helper()
	ctx := context.Background()
	var snapshot activityMigrationSnapshot
	if err := db.QueryRowContext(ctx, `SELECT count(*),coalesce(sum(total_minor),0) FROM bookings WHERE group_id='group-existing'`).Scan(&snapshot.BookingCount, &snapshot.BookingTotal); err != nil {
		t.Fatalf("snapshot bookings: %v", err)
	}
	if err := db.QueryRowContext(ctx, `SELECT reason,voided_at FROM bookings WHERE id='booking-existing'`).Scan(&snapshot.BookingReason, &snapshot.BookingVoidedAt); err != nil {
		t.Fatalf("snapshot booking detail: %v", err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*),coalesce(sum(amount_minor),0) FROM payments WHERE group_id='group-existing'`).Scan(&snapshot.PaymentCount, &snapshot.PaymentTotal); err != nil {
		t.Fatalf("snapshot payments: %v", err)
	}
	if err := db.QueryRowContext(ctx, `SELECT method,method_label,reference,created_at,reversed_at FROM payments WHERE id='payment-existing'`).
		Scan(&snapshot.PaymentMethod, &snapshot.PaymentMethodLabel, &snapshot.PaymentReference, &snapshot.PaymentCreatedAt, &snapshot.PaymentReversedAt); err != nil {
		t.Fatalf("snapshot payment detail: %v", err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*),coalesce(sum(amount_minor),0) FROM ledger_entries WHERE group_id='group-existing' AND membership_id='member-existing' AND account='MEMBER_RECEIVABLE'`).
		Scan(&snapshot.LedgerCount, &snapshot.ReceivableBalance); err != nil {
		t.Fatalf("snapshot ledger: %v", err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM payment_attachments WHERE group_id='group-existing'`).Scan(&snapshot.AttachmentCount); err != nil {
		t.Fatalf("snapshot payment attachments: %v", err)
	}
	return snapshot
}

func assertQueryPlanUsesIndex(t *testing.T, db interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}, query, index string, args ...any) {
	t.Helper()
	rows, err := db.QueryContext(context.Background(), "EXPLAIN QUERY PLAN "+query, args...)
	if err != nil {
		t.Fatalf("explain query for %s: %v", index, err)
	}
	defer rows.Close()
	var details []string
	for rows.Next() {
		var id, parent, unused int
		var detail string
		if err := rows.Scan(&id, &parent, &unused, &detail); err != nil {
			t.Fatalf("scan query plan for %s: %v", index, err)
		}
		details = append(details, detail)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate query plan for %s: %v", index, err)
	}
	if !strings.Contains(strings.Join(details, "\n"), index) {
		t.Fatalf("query plan does not use %s: %v", index, details)
	}
}
