package storage

import (
	"context"
	"database/sql"
	"path/filepath"
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

	assertQueryPlanUsesIndex(t, db, `SELECT id FROM bookings WHERE group_id=? ORDER BY strftime('%Y-%m-%dT%H:%M:%fZ',created_at) DESC,id DESC LIMIT 101`, "bookings_group_created_page_idx", "grp")
	assertQueryPlanUsesIndex(t, db, `SELECT id FROM payments WHERE group_id=? ORDER BY strftime('%Y-%m-%dT%H:%M:%fZ',received_at) DESC,id DESC LIMIT 101`, "payments_group_received_page_idx", "grp")
	assertQueryPlanUsesIndex(t, db, `SELECT id FROM ledger_entries WHERE group_id=? AND membership_id=? AND account='MEMBER_RECEIVABLE' ORDER BY strftime('%Y-%m-%dT%H:%M:%fZ',created_at) DESC,id DESC LIMIT 101`, "ledger_member_movements_page_idx", "grp", "mem")
	assertQueryPlanUsesIndex(t, db, `SELECT id FROM audit_events WHERE group_id=? ORDER BY strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) DESC,id DESC LIMIT 101`, "audit_group_time_page_idx", "grp")
	assertQueryPlanUsesIndex(t, db, `SELECT id FROM system_audit_events ORDER BY strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) DESC,id DESC LIMIT 101`, "system_audit_time_page_idx")
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
