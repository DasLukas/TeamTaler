package storage

import (
	"context"
	"database/sql"
	"testing"
)

func TestMembershipLifecycleMigrationPreservesHistoryAndConstrainsDeletedMemberships(t *testing.T) {
	ctx := context.Background()
	db := openDatabaseThroughMigration(t, "0022_account_security.sql")
	defer db.Close()

	for index, statement := range []string{
		`INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('user-admin','admin@example.test','Admin','hash-admin','2026-08-10T12:00:00Z','2026-08-10T12:00:00Z')`,
		`INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('user-member','member@example.test','Member','hash-member','2026-08-10T12:00:00Z','2026-08-10T12:00:00Z')`,
		`INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES('group-one','One Group','EUR','2026-08-10T12:00:00Z','2026-08-10T12:00:00Z')`,
		`INSERT INTO group_settings(group_id,members_can_view_all_bookings,notification_emails_enabled,default_role_id,updated_at) VALUES('group-one',0,0,'role:MEMBER:group-one','2026-08-10T12:00:00Z')`,
		`INSERT INTO memberships(id,group_id,user_id,status,joined_at) VALUES('membership-admin','group-one','user-admin','ACTIVE','2026-08-10T12:00:00Z')`,
		`INSERT INTO memberships(id,group_id,user_id,status,joined_at,archived_at) VALUES('membership-member','group-one','user-member','ARCHIVED','2026-08-10T12:00:00Z','2026-08-10T12:30:00Z')`,
		`INSERT INTO periods(id,group_id,label,status,starts_at,created_at) VALUES('period-one','group-one','One','OPEN','2026-08-10T12:00:00Z','2026-08-10T12:00:00Z')`,
		`INSERT INTO payments(id,group_id,membership_id,amount_minor,received_at,method,reference,created_by,created_at) VALUES('payment-one','group-one','membership-member',250,'2026-08-10T12:20:00Z','CASH','Fixture','membership-admin','2026-08-10T12:20:00Z')`,
		`INSERT INTO ledger_entries(id,group_id,period_id,membership_id,payment_id,account,amount_minor,description,created_at) VALUES('ledger-member','group-one','period-one','membership-member','payment-one','MEMBER_RECEIVABLE',-250,'Fixture payment','2026-08-10T12:20:00Z')`,
		`INSERT INTO ledger_entries(id,group_id,period_id,payment_id,account,amount_minor,description,created_at) VALUES('ledger-cash','group-one','period-one','payment-one','GROUP_CASH',250,'Fixture payment','2026-08-10T12:20:00Z')`,
		`INSERT INTO period_statements(id,group_id,period_id,membership_id,display_name,email,charges_minor,payments_allocated_minor,adjustments_applied_minor,adjustments_provided_minor,amount_due_minor,status,created_at) VALUES('statement-one','group-one','period-one','membership-member','Member','member@example.test',250,250,0,0,0,'PAID','2026-08-10T12:30:00Z')`,
		`INSERT INTO audit_events(id,group_id,actor_user_id,actor_membership_id,action,resource_type,resource_id,metadata_json,occurred_at) VALUES('audit-one','group-one','user-admin','membership-admin','membership.archived','membership','membership-member','{}','2026-08-10T12:30:00Z')`,
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("seed pre-lifecycle fixture %d: %v", index, err)
		}
	}

	if err := Migrate(ctx, db); err != nil {
		t.Fatalf("apply membership lifecycle migration: %v", err)
	}

	var deletedAt sql.NullString
	if err := db.QueryRowContext(ctx, `SELECT deleted_at FROM memberships WHERE id='membership-member'`).Scan(&deletedAt); err != nil || deletedAt.Valid {
		t.Fatalf("archived membership deleted_at=%v err=%v, want null", deletedAt, err)
	}
	var preservedPayments, preservedLedger, preservedStatements, preservedAudits int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM payments WHERE id='payment-one' AND membership_id='membership-member'`).Scan(&preservedPayments); err != nil || preservedPayments != 1 {
		t.Fatalf("preserved payments=%d err=%v, want 1", preservedPayments, err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM ledger_entries WHERE id IN ('ledger-member','ledger-cash')`).Scan(&preservedLedger); err != nil || preservedLedger != 2 {
		t.Fatalf("preserved ledger entries=%d err=%v, want 2", preservedLedger, err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM period_statements WHERE id='statement-one' AND email='member@example.test'`).Scan(&preservedStatements); err != nil || preservedStatements != 1 {
		t.Fatalf("preserved statements=%d err=%v, want 1", preservedStatements, err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM audit_events WHERE id='audit-one' AND resource_id='membership-member'`).Scan(&preservedAudits); err != nil || preservedAudits != 1 {
		t.Fatalf("preserved audits=%d err=%v, want 1", preservedAudits, err)
	}

	const deletedTimestamp = "2026-08-10T13:00:00Z"
	if _, err := db.ExecContext(ctx, `UPDATE memberships SET deleted_at=? WHERE id='membership-admin'`, deletedTimestamp); err == nil {
		t.Fatal("active membership was unexpectedly marked deleted")
	}
	if _, err := db.ExecContext(ctx, `UPDATE memberships SET temporary_guest_name_key='member',deleted_at=? WHERE id='membership-member'`, deletedTimestamp); err == nil {
		t.Fatal("deleted membership unexpectedly retained a temporary guest name key")
	}
	if _, err := db.ExecContext(ctx, `UPDATE memberships SET deleted_at=? WHERE id='membership-member'`, deletedTimestamp); err != nil {
		t.Fatalf("mark archived membership deleted: %v", err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE memberships SET status='ACTIVE',archived_at=NULL WHERE id='membership-member'`); err == nil {
		t.Fatal("deleted membership was unexpectedly reactivated")
	}
	if _, err := db.ExecContext(ctx, `UPDATE memberships SET user_id='user-admin' WHERE id='membership-member'`); err == nil {
		t.Fatal("deleted membership identity was unexpectedly changed")
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO membership_role_assignments(group_id,membership_id,role_id,version,assigned_at,assigned_by)
		VALUES('group-one','membership-member','role:MEMBER:group-one',1,?, 'user-admin')`, deletedTimestamp); err == nil {
		t.Fatal("role was unexpectedly assigned to a deleted membership")
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO invitations(id,group_id,email,display_name,token_hash,expires_at,target_membership_id,created_at)
		VALUES('invitation-deleted','group-one','new@example.test','Deleted','hash-deleted','2026-08-11T13:00:00Z','membership-member',?)`, deletedTimestamp); err == nil {
		t.Fatal("claim invitation unexpectedly targeted a deleted membership")
	}

	var lifecycleIndexes int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM pragma_index_list('memberships') WHERE name IN ('memberships_group_lifecycle_idx','memberships_deleted_finance_idx')`).Scan(&lifecycleIndexes); err != nil || lifecycleIndexes != 2 {
		t.Fatalf("membership lifecycle indexes=%d err=%v, want 2", lifecycleIndexes, err)
	}
	var migrationCount int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM schema_migrations WHERE version='0023_membership_lifecycle.sql'`).Scan(&migrationCount); err != nil || migrationCount != 1 {
		t.Fatalf("membership lifecycle migration markers=%d err=%v, want 1", migrationCount, err)
	}
	rows, err := db.QueryContext(ctx, `PRAGMA foreign_key_check`)
	if err != nil {
		t.Fatalf("check membership lifecycle foreign keys: %v", err)
	}
	defer rows.Close()
	if rows.Next() {
		var table, parent string
		var rowID sql.NullInt64
		var constraint int
		if err := rows.Scan(&table, &rowID, &parent, &constraint); err != nil {
			t.Fatalf("scan foreign-key violation: %v", err)
		}
		t.Fatalf("foreign-key violation in %s referencing %s", table, parent)
	}
}
