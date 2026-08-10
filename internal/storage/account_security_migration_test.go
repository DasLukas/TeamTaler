package storage

import (
	"context"
	"database/sql"
	"testing"
)

func TestAccountSecurityMigrationIsAdditiveAndConstrainsSecretState(t *testing.T) {
	ctx := context.Background()
	db := openDatabaseThroughMigration(t, "0021_guest_feature.sql")
	defer db.Close()

	const now = "2026-08-10T12:00:00Z"
	const expiry = "2026-08-10T13:00:00Z"
	for index, statement := range []string{
		`INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('user-one','one@example.test','One','hash-one','2026-08-10T12:00:00Z','2026-08-10T12:00:00Z')`,
		`INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('user-two','two@example.test','Two','hash-two','2026-08-10T12:00:00Z','2026-08-10T12:00:00Z')`,
		`INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('guest-one',NULL,'Guest',NULL,'2026-08-10T12:00:00Z','2026-08-10T12:00:00Z')`,
		`INSERT INTO sessions(id_hash,user_id,csrf_hash,expires_at,last_seen_at,created_at) VALUES('session-one','user-one','csrf-one','2099-01-01T00:00:00Z','2026-08-10T12:00:00Z','2026-08-10T12:00:00Z')`,
		`INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES('group-one','One Group','EUR','2026-08-10T12:00:00Z','2026-08-10T12:00:00Z')`,
		`INSERT INTO group_settings(group_id,members_can_view_all_bookings,notification_emails_enabled,default_role_id,updated_at) VALUES('group-one',0,0,'role:MEMBER:group-one','2026-08-10T12:00:00Z')`,
		`INSERT INTO memberships(id,group_id,user_id,status,joined_at) VALUES('membership-one','group-one','user-one','ACTIVE','2026-08-10T12:00:00Z')`,
		`INSERT INTO memberships(id,group_id,user_id,status,joined_at,temporary_guest_name_key) VALUES('membership-guest','group-one','guest-one','ACTIVE','2026-08-10T12:00:00Z','guest')`,
		`INSERT INTO roles(id,group_id,name,description,name_locked,deletable,version,created_at,updated_at,created_by,updated_by) VALUES('role-custom','group-one','Custom','Account security migration fixture',0,1,1,'2026-08-10T12:00:00Z','2026-08-10T12:00:00Z','user-one','user-one')`,
		`INSERT INTO role_permission_grants(group_id,role_id,permission_key,scope_type,version,created_at,updated_at,created_by,updated_by) VALUES('group-one','role-custom','CREATE_OWN_BOOKING','GROUP',1,'2026-08-10T12:00:00Z','2026-08-10T12:00:00Z','user-one','user-one')`,
		`INSERT INTO membership_role_assignments(group_id,membership_id,role_id,version,assigned_at,assigned_by) VALUES('group-one','membership-one','role-custom',1,'2026-08-10T12:00:00Z','user-one')`,
		`INSERT INTO categories(id,group_id,name,icon,active,sort_order,created_at,updated_at) VALUES('category-one','group-one','Fixture category','other',1,0,'2026-08-10T12:00:00Z','2026-08-10T12:00:00Z')`,
		`INSERT INTO products(id,group_id,category_id,name,price_minor,pricing_mode,active,sort_order,created_at,updated_at) VALUES('product-one','group-one','category-one','Fixture product',250,'FIXED',1,0,'2026-08-10T12:00:00Z','2026-08-10T12:00:00Z')`,
		`INSERT INTO periods(id,group_id,label,status,starts_at,created_at) VALUES('period-one','group-one','One','OPEN','2026-08-10T12:00:00Z','2026-08-10T12:00:00Z')`,
		`INSERT INTO bookings(id,group_id,period_id,category_id,product_id,actor_membership_id,target_membership_id,quantity,unit_price_minor,total_minor,product_name,category_name,reason,created_at) VALUES('booking-one','group-one','period-one','category-one','product-one','membership-one','membership-guest',1,250,250,'Fixture product','Fixture category','Migration fixture','2026-08-10T12:00:00Z')`,
		`INSERT INTO ledger_entries(id,group_id,period_id,membership_id,category_id,booking_id,account,amount_minor,description,created_at) VALUES('ledger-receivable','group-one','period-one','membership-guest','category-one','booking-one','MEMBER_RECEIVABLE',250,'Fixture booking','2026-08-10T12:00:00Z')`,
		`INSERT INTO ledger_entries(id,group_id,period_id,category_id,booking_id,account,amount_minor,description,created_at) VALUES('ledger-revenue','group-one','period-one','category-one','booking-one','CATEGORY_REVENUE',-250,'Fixture booking','2026-08-10T12:00:00Z')`,
		`INSERT INTO period_statements(id,group_id,period_id,membership_id,display_name,email,charges_minor,payments_allocated_minor,adjustments_applied_minor,adjustments_provided_minor,amount_due_minor,status,created_at) VALUES('statement-guest','group-one','period-one','membership-guest','Guest',NULL,250,0,0,0,250,'OPEN','2026-08-10T12:00:00Z')`,
		`INSERT INTO audit_events(id,group_id,actor_user_id,actor_membership_id,action,resource_type,resource_id,metadata_json,occurred_at) VALUES('audit-one','group-one','user-one','membership-one','booking.created','booking','booking-one','{"fixture":true}','2026-08-10T12:00:00Z')`,
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("seed pre-account-security fixture %d: %v", index, err)
		}
	}

	if err := Migrate(ctx, db); err != nil {
		t.Fatalf("apply account-security migration: %v", err)
	}

	var preservedUsers, preservedSessions int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM users WHERE id IN ('user-one','user-two','guest-one')`).Scan(&preservedUsers); err != nil || preservedUsers != 3 {
		t.Fatalf("preserved users=%d err=%v, want 3", preservedUsers, err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM sessions WHERE id_hash='session-one' AND user_id='user-one'`).Scan(&preservedSessions); err != nil || preservedSessions != 1 {
		t.Fatalf("preserved sessions=%d err=%v, want 1", preservedSessions, err)
	}
	var preservedMemberships, preservedRoleGraph, preservedBookings, preservedLedger, preservedStatements, preservedAudits int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM memberships WHERE id IN ('membership-one','membership-guest')`).Scan(&preservedMemberships); err != nil || preservedMemberships != 2 {
		t.Fatalf("preserved memberships=%d err=%v, want 2", preservedMemberships, err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM roles role
		JOIN role_permission_grants grant ON grant.group_id=role.group_id AND grant.role_id=role.id
		JOIN membership_role_assignments assignment ON assignment.group_id=role.group_id AND assignment.role_id=role.id
		WHERE role.id='role-custom' AND grant.permission_key='CREATE_OWN_BOOKING' AND assignment.membership_id='membership-one'`).Scan(&preservedRoleGraph); err != nil || preservedRoleGraph != 1 {
		t.Fatalf("preserved role graph=%d err=%v, want 1", preservedRoleGraph, err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM bookings WHERE id='booking-one' AND actor_membership_id='membership-one' AND target_membership_id='membership-guest'`).Scan(&preservedBookings); err != nil || preservedBookings != 1 {
		t.Fatalf("preserved bookings=%d err=%v, want 1", preservedBookings, err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM ledger_entries WHERE id IN ('ledger-receivable','ledger-revenue') AND booking_id='booking-one'`).Scan(&preservedLedger); err != nil || preservedLedger != 2 {
		t.Fatalf("preserved ledger entries=%d err=%v, want 2", preservedLedger, err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM period_statements WHERE id='statement-guest' AND membership_id='membership-guest' AND email IS NULL`).Scan(&preservedStatements); err != nil || preservedStatements != 1 {
		t.Fatalf("preserved statements=%d err=%v, want 1", preservedStatements, err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM audit_events WHERE id='audit-one' AND actor_user_id='user-one' AND resource_id='booking-one'`).Scan(&preservedAudits); err != nil || preservedAudits != 1 {
		t.Fatalf("preserved audits=%d err=%v, want 1", preservedAudits, err)
	}

	insertAction := `INSERT INTO account_security_actions
		(id,user_id,kind,source_email,target_email,token_hash,expires_at,created_at)
		VALUES(?,?,?,?,?,?,?,?)`
	if _, err := db.ExecContext(ctx, insertAction, "action-reset", "user-one", "PASSWORD_RESET", "one@example.test", nil, "reset-hash", expiry, now); err != nil {
		t.Fatalf("insert password-reset action: %v", err)
	}
	if _, err := db.ExecContext(ctx, insertAction, "action-email", "user-one", "EMAIL_CHANGE", "one@example.test", "new@example.test", "email-hash", expiry, now); err != nil {
		t.Fatalf("insert email-change action: %v", err)
	}
	if _, err := db.ExecContext(ctx, insertAction, "invalid-reset-target", "user-two", "PASSWORD_RESET", "two@example.test", "target@example.test", "invalid-reset-hash", expiry, now); err == nil {
		t.Fatal("password-reset action with a target email unexpectedly passed")
	}
	if _, err := db.ExecContext(ctx, insertAction, "invalid-email-target", "user-two", "EMAIL_CHANGE", "two@example.test", nil, "invalid-email-hash", expiry, now); err == nil {
		t.Fatal("email-change action without a target email unexpectedly passed")
	}
	if _, err := db.ExecContext(ctx, insertAction, "duplicate-kind", "user-one", "PASSWORD_RESET", "one@example.test", nil, "other-reset-hash", expiry, now); err == nil {
		t.Fatal("second open password-reset action unexpectedly passed")
	}
	if _, err := db.ExecContext(ctx, insertAction, "duplicate-target", "user-two", "EMAIL_CHANGE", "two@example.test", "NEW@EXAMPLE.TEST", "other-email-hash", expiry, now); err == nil {
		t.Fatal("case-insensitive duplicate open email target unexpectedly passed")
	}
	if _, err := db.ExecContext(ctx, `UPDATE account_security_actions SET consumed_at=?,invalidated_at=? WHERE id='action-reset'`, now, now); err == nil {
		t.Fatal("action marked both consumed and invalidated unexpectedly passed")
	}

	insertOutbox := `INSERT INTO account_security_email_outbox
		(action_id,token_ciphertext,status,attempt_count,next_attempt_at,sent_at,created_at,updated_at)
		VALUES(?,?,?,?,?,?,?,?)`
	if _, err := db.ExecContext(ctx, insertOutbox, "action-reset", "ciphertext", "PENDING", 0, now, nil, now, now); err != nil {
		t.Fatalf("insert pending account-security outbox: %v", err)
	}
	if _, err := db.ExecContext(ctx, insertOutbox, "action-email", nil, "PENDING", 0, now, nil, now, now); err == nil {
		t.Fatal("pending account-security outbox without ciphertext unexpectedly passed")
	}
	if _, err := db.ExecContext(ctx, insertOutbox, "missing-action", "ciphertext", "PENDING", 0, now, nil, now, now); err == nil {
		t.Fatal("account-security outbox without an action unexpectedly passed")
	}
	if _, err := db.ExecContext(ctx, `UPDATE account_security_email_outbox SET
		status='SENT',sent_at=?,next_attempt_at=NULL,token_ciphertext=NULL WHERE action_id='action-reset'`, now); err != nil {
		t.Fatalf("complete account-security outbox: %v", err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE account_security_email_outbox SET token_ciphertext='retained' WHERE action_id='action-reset'`); err == nil {
		t.Fatal("sent account-security outbox retained ciphertext unexpectedly")
	}

	var migrationCount int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM schema_migrations WHERE version='0022_account_security.sql'`).Scan(&migrationCount); err != nil || migrationCount != 1 {
		t.Fatalf("account-security migration markers=%d err=%v, want 1", migrationCount, err)
	}
	rows, err := db.QueryContext(ctx, `PRAGMA foreign_key_check`)
	if err != nil {
		t.Fatalf("check account-security foreign keys: %v", err)
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
