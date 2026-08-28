package storage

import (
	"context"
	"strings"
	"testing"
)

func TestStatisticsDashboardMigrationPreservesExistingRolesAndSeedsFutureMembers(t *testing.T) {
	ctx := context.Background()
	db := openDatabaseThroughMigration(t, "0044_payment_targets.sql")
	defer db.Close()
	const now = "2026-08-28T10:00:00Z"

	if _, err := db.ExecContext(ctx, `INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES('statistics-existing','Existing','EUR',?,?)`, now, now); err != nil {
		t.Fatalf("insert existing statistics group: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO group_settings(group_id,default_role_id,updated_at) VALUES('statistics-existing','role:MEMBER:statistics-existing',?)`, now); err != nil {
		t.Fatalf("insert existing statistics settings: %v", err)
	}
	if err := Migrate(ctx, db); err != nil {
		t.Fatalf("apply statistics dashboard migration: %v", err)
	}

	var enabled bool
	if err := db.QueryRowContext(ctx, `SELECT statistics_enabled FROM group_settings WHERE group_id='statistics-existing'`).Scan(&enabled); err != nil || enabled {
		t.Fatalf("existing statistics default=%t err=%v, want false", enabled, err)
	}
	var permissionCount, existingDirectGrantCount int
	var implication string
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM permission_definitions WHERE key='VIEW_MEMBER_STATISTICS'`).Scan(&permissionCount); err != nil || permissionCount != 1 {
		t.Fatalf("member statistics definitions=%d err=%v, want one", permissionCount, err)
	}
	if err := db.QueryRowContext(ctx, `SELECT implied_permissions_json FROM permission_definitions WHERE key='VIEW_ALL_BOOKING_ACTIVITY'`).Scan(&implication); err != nil || implication != `["VIEW_MEMBER_STATISTICS"]` {
		t.Fatalf("booking-activity implication=%q err=%v", implication, err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM role_permission_grants WHERE group_id='statistics-existing' AND permission_key='VIEW_MEMBER_STATISTICS'`).Scan(&existingDirectGrantCount); err != nil || existingDirectGrantCount != 0 {
		t.Fatalf("existing direct member-statistics grants=%d err=%v, want zero", existingDirectGrantCount, err)
	}

	if _, err := db.ExecContext(ctx, `INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES('statistics-new','New','EUR',?,?)`, now, now); err != nil {
		t.Fatalf("insert future statistics group: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO group_settings(group_id,default_role_id,updated_at) VALUES('statistics-new','role:MEMBER:statistics-new',?)`, now); err != nil {
		t.Fatalf("insert future statistics settings: %v", err)
	}
	var memberGrantCount, financeGroupGrantCount, financeMemberDirectCount int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM role_permission_grants WHERE group_id='statistics-new' AND role_id='role:MEMBER:statistics-new' AND permission_key='VIEW_MEMBER_STATISTICS'`).Scan(&memberGrantCount); err != nil {
		t.Fatalf("count future member statistics grant: %v", err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM role_permission_grants WHERE group_id='statistics-new' AND role_id='role:FINANCE_MANAGER:statistics-new' AND permission_key='VIEW_GROUP_STATISTICS'`).Scan(&financeGroupGrantCount); err != nil {
		t.Fatalf("count future finance statistics grant: %v", err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM role_permission_grants WHERE group_id='statistics-new' AND role_id='role:FINANCE_MANAGER:statistics-new' AND permission_key='VIEW_MEMBER_STATISTICS'`).Scan(&financeMemberDirectCount); err != nil {
		t.Fatalf("count future finance direct member grant: %v", err)
	}
	if memberGrantCount != 1 || financeGroupGrantCount != 1 || financeMemberDirectCount != 0 {
		t.Fatalf("future member/finance/direct grants=%d/%d/%d, want 1/1/0", memberGrantCount, financeGroupGrantCount, financeMemberDirectCount)
	}
	if _, err := db.ExecContext(ctx, `UPDATE group_settings SET statistics_enabled=2 WHERE group_id='statistics-new'`); err == nil {
		t.Fatal("invalid statistics_enabled value unexpectedly passed CHECK constraint")
	}
	for _, index := range []string{
		"ledger_statistics_group_account_created_idx",
		"bookings_statistics_group_created_idx",
		"bookings_statistics_group_voided_idx",
		"payment_allocations_statistics_group_period_idx",
	} {
		var count int
		if err := db.QueryRowContext(ctx, `SELECT count(*) FROM sqlite_master WHERE type='index' AND name=?`, index).Scan(&count); err != nil || count != 1 {
			t.Fatalf("statistics index %s count=%d err=%v", index, count, err)
		}
	}
	for _, plan := range []struct {
		query string
		args  []any
		index string
	}{
		{
			query: `EXPLAIN QUERY PLAN SELECT sum(amount_minor) FROM ledger_entries WHERE group_id=? AND account='MEMBER_RECEIVABLE' AND created_at>=? AND created_at<?`,
			args:  []any{"statistics-new", "2026-08-01T00:00:00Z", "2026-09-01T00:00:00Z"},
			index: "ledger_statistics_group_account_created_idx",
		},
		{
			query: `EXPLAIN QUERY PLAN SELECT sum(quantity) FROM bookings WHERE group_id=? AND created_at>=? AND created_at<?`,
			args:  []any{"statistics-new", "2026-08-01T00:00:00Z", "2026-09-01T00:00:00Z"},
			index: "bookings_statistics_group_created_idx",
		},
		{
			query: `EXPLAIN QUERY PLAN SELECT sum(quantity) FROM bookings WHERE group_id=? AND voided_at>=? AND voided_at<?`,
			args:  []any{"statistics-new", "2026-08-01T00:00:00Z", "2026-09-01T00:00:00Z"},
			index: "bookings_statistics_group_voided_idx",
		},
		{
			query: `EXPLAIN QUERY PLAN SELECT sum(amount_minor) FROM payment_allocations WHERE group_id=? AND period_id=?`,
			args:  []any{"statistics-new", "statistics-period"},
			index: "payment_allocations_statistics_group_period_idx",
		},
	} {
		rows, err := db.QueryContext(ctx, plan.query, plan.args...)
		if err != nil {
			t.Fatalf("explain statistics index %s: %v", plan.index, err)
		}
		used := false
		for rows.Next() {
			var id, parent, unused int
			var detail string
			if err := rows.Scan(&id, &parent, &unused, &detail); err != nil {
				rows.Close()
				t.Fatalf("scan statistics plan %s: %v", plan.index, err)
			}
			used = used || strings.Contains(detail, plan.index)
		}
		if err := rows.Close(); err != nil {
			t.Fatalf("close statistics plan %s: %v", plan.index, err)
		}
		if !used {
			t.Fatalf("statistics query plan did not use %s", plan.index)
		}
	}
}
