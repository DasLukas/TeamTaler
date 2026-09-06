package storage

import (
	"context"
	"strings"
	"testing"
)

func TestUnifiedStatisticsPermissionMigrationUsesSafeGrantSemanticsAndSeedsFutureGroups(t *testing.T) {
	ctx := context.Background()
	db := openDatabaseThroughMigration(t, "0051_statistics_dashboard.sql")
	defer db.Close()
	const now = "2026-08-28T10:00:00Z"

	if _, err := db.ExecContext(ctx, `INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES('statistics-existing','Existing','EUR',?,?)`, now, now); err != nil {
		t.Fatalf("insert existing statistics group: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO group_settings(group_id,default_role_id,updated_at) VALUES('statistics-existing','role:MEMBER:statistics-existing',?)`, now); err != nil {
		t.Fatalf("insert existing statistics settings: %v", err)
	}

	roleGrants := map[string][]string{
		"role-statistics-finance-only":  {"VIEW_GROUP_STATISTICS"},
		"role-statistics-member-only":   {"VIEW_MEMBER_STATISTICS"},
		"role-statistics-both":          {"VIEW_GROUP_STATISTICS", "VIEW_MEMBER_STATISTICS"},
		"role-statistics-activity-only": {"VIEW_ALL_BOOKING_ACTIVITY"},
		"role-statistics-void-only":     {"VOID_ANY_BOOKING"},
		"role-statistics-none":          nil,
	}
	for roleID, grants := range roleGrants {
		if _, err := db.ExecContext(ctx, `
			INSERT INTO roles(id,group_id,name,description,created_at,updated_at)
			VALUES(?,'statistics-existing',?,'Migration fixture',?,?)`, roleID, roleID, now, now); err != nil {
			t.Fatalf("insert role %s: %v", roleID, err)
		}
		for _, permission := range grants {
			if _, err := db.ExecContext(ctx, `
				INSERT INTO role_permission_grants(
					group_id,role_id,permission_key,scope_type,version,
					created_at,updated_at,created_by,updated_by
				) VALUES('statistics-existing',?,?,'GROUP',1,?,?,?,?)`, roleID, permission, now, now, "migration-actor", "migration-actor"); err != nil {
				t.Fatalf("grant %s to %s: %v", permission, roleID, err)
			}
		}
	}
	roleVersion := func(roleID string) int {
		t.Helper()
		var version int
		if err := db.QueryRowContext(ctx, `SELECT version FROM roles WHERE id=?`, roleID).Scan(&version); err != nil {
			t.Fatalf("read role %s version: %v", roleID, err)
		}
		return version
	}
	versionsBefore := make(map[string]int, len(roleGrants))
	for roleID := range roleGrants {
		versionsBefore[roleID] = roleVersion(roleID)
	}

	if err := Migrate(ctx, db); err != nil {
		t.Fatalf("apply unified statistics permission migration: %v", err)
	}

	var enabled bool
	if err := db.QueryRowContext(ctx, `SELECT statistics_enabled FROM group_settings WHERE group_id='statistics-existing'`).Scan(&enabled); err != nil || enabled {
		t.Fatalf("existing statistics default=%t err=%v, want false", enabled, err)
	}
	var permissionCount, legacyPermissionCount, legacyGrantCount int
	var activityImplication, voidImplication string
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM permission_definitions WHERE key='VIEW_STATISTICS'`).Scan(&permissionCount); err != nil || permissionCount != 1 {
		t.Fatalf("statistics definitions=%d err=%v, want one", permissionCount, err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM permission_definitions WHERE key IN ('VIEW_MEMBER_STATISTICS','VIEW_GROUP_STATISTICS')`).Scan(&legacyPermissionCount); err != nil || legacyPermissionCount != 0 {
		t.Fatalf("legacy statistics definitions=%d err=%v, want zero", legacyPermissionCount, err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM role_permission_grants WHERE permission_key IN ('VIEW_MEMBER_STATISTICS','VIEW_GROUP_STATISTICS')`).Scan(&legacyGrantCount); err != nil || legacyGrantCount != 0 {
		t.Fatalf("legacy statistics grants=%d err=%v, want zero", legacyGrantCount, err)
	}
	if err := db.QueryRowContext(ctx, `SELECT implied_permissions_json FROM permission_definitions WHERE key='VIEW_ALL_BOOKING_ACTIVITY'`).Scan(&activityImplication); err != nil || activityImplication != `[]` {
		t.Fatalf("booking-activity implication=%q err=%v, want []", activityImplication, err)
	}
	if err := db.QueryRowContext(ctx, `SELECT implied_permissions_json FROM permission_definitions WHERE key='VOID_ANY_BOOKING'`).Scan(&voidImplication); err != nil || voidImplication != `["VOID_OWN_BOOKING","VIEW_ALL_BOOKING_ACTIVITY"]` {
		t.Fatalf("void-any implication=%q err=%v", voidImplication, err)
	}

	wantStatisticsGrant := map[string]int{
		"role-statistics-finance-only":                 1,
		"role-statistics-member-only":                  0,
		"role-statistics-both":                         1,
		"role-statistics-activity-only":                0,
		"role-statistics-void-only":                    0,
		"role-statistics-none":                         0,
		"role:FINANCE_MANAGER:statistics-existing":     1,
		"role:MEMBER:statistics-existing":              0,
		"role:GROUP_ADMINISTRATOR:statistics-existing": 0,
	}
	for roleID, want := range wantStatisticsGrant {
		var got int
		if err := db.QueryRowContext(ctx, `SELECT count(*) FROM role_permission_grants WHERE group_id='statistics-existing' AND role_id=? AND permission_key='VIEW_STATISTICS'`, roleID).Scan(&got); err != nil || got != want {
			t.Fatalf("role %s statistics grants=%d err=%v, want %d", roleID, got, err, want)
		}
	}
	for _, roleID := range []string{"role-statistics-finance-only", "role-statistics-member-only", "role-statistics-both"} {
		if got := roleVersion(roleID); got <= versionsBefore[roleID] {
			t.Fatalf("role %s version=%d, want greater than %d after grant migration", roleID, got, versionsBefore[roleID])
		}
	}
	for _, roleID := range []string{"role-statistics-activity-only", "role-statistics-void-only", "role-statistics-none"} {
		if got := roleVersion(roleID); got != versionsBefore[roleID] {
			t.Fatalf("unaffected role %s version=%d, want %d", roleID, got, versionsBefore[roleID])
		}
	}

	if _, err := db.ExecContext(ctx, `INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES('statistics-new','New','EUR',?,?)`, now, now); err != nil {
		t.Fatalf("insert future statistics group: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO group_settings(group_id,default_role_id,updated_at) VALUES('statistics-new','role:MEMBER:statistics-new',?)`, now); err != nil {
		t.Fatalf("insert future statistics settings: %v", err)
	}
	var memberGrantCount, financeGrantCount, otherGrantCount int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM role_permission_grants WHERE group_id='statistics-new' AND role_id='role:MEMBER:statistics-new' AND permission_key='VIEW_STATISTICS'`).Scan(&memberGrantCount); err != nil {
		t.Fatalf("count future member statistics grant: %v", err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM role_permission_grants WHERE group_id='statistics-new' AND role_id='role:FINANCE_MANAGER:statistics-new' AND permission_key='VIEW_STATISTICS'`).Scan(&financeGrantCount); err != nil {
		t.Fatalf("count future finance statistics grant: %v", err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM role_permission_grants WHERE group_id='statistics-new' AND role_id<>'role:FINANCE_MANAGER:statistics-new' AND permission_key='VIEW_STATISTICS'`).Scan(&otherGrantCount); err != nil {
		t.Fatalf("count future non-finance statistics grants: %v", err)
	}
	if memberGrantCount != 0 || financeGrantCount != 1 || otherGrantCount != 0 {
		t.Fatalf("future member/finance/other statistics grants=%d/%d/%d, want 0/1/0", memberGrantCount, financeGrantCount, otherGrantCount)
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
