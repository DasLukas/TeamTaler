package storage

import (
	"context"
	"database/sql"
	"path/filepath"
	"strings"
	"testing"
)

func TestGuestFeatureMigrationPreservesReferencesAndEnforcesIdentityInvariants(t *testing.T) {
	ctx := context.Background()
	db := openDatabaseThroughMigration(t, "0020_public_join_links.sql")
	defer db.Close()

	now := "2026-08-08T12:00:00Z"
	seed := []string{
		`INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('user-admin','admin@example.test','Admin','hash','2026-08-08T12:00:00Z','2026-08-08T12:00:00Z')`,
		`INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES('group-main','Main','EUR','2026-08-08T12:00:00Z','2026-08-08T12:00:00Z')`,
		`INSERT INTO group_settings(group_id,members_can_view_all_bookings,notification_emails_enabled,default_role_id,updated_at) VALUES('group-main',0,1,'role:MEMBER:group-main','2026-08-08T12:00:00Z')`,
		`INSERT INTO memberships(id,group_id,user_id,status,joined_at) VALUES('member-admin','group-main','user-admin','ACTIVE','2026-08-08T12:00:00Z')`,
		`INSERT INTO roles(id,group_id,name,description,name_locked,deletable,version,created_at,updated_at,created_by,updated_by) VALUES('role-custom','group-main','Custom','Migration fixture role',0,1,1,'2026-08-08T12:00:00Z','2026-08-08T12:00:00Z','user-admin','user-admin')`,
		`INSERT INTO role_permission_grants(group_id,role_id,permission_key,scope_type,version,created_at,updated_at,created_by,updated_by) VALUES('group-main','role-custom','CREATE_OWN_BOOKING','GROUP',1,'2026-08-08T12:00:00Z','2026-08-08T12:00:00Z','user-admin','user-admin')`,
		`INSERT INTO membership_role_assignments(group_id,membership_id,role_id,version,assigned_at,assigned_by) VALUES('group-main','member-admin','role-custom',1,'2026-08-08T12:00:00Z','user-admin')`,
		`INSERT INTO sessions(id_hash,user_id,csrf_hash,expires_at,last_seen_at,created_at) VALUES('session-admin','user-admin','csrf','2099-01-01T00:00:00Z','2026-08-08T12:00:00Z','2026-08-08T12:00:00Z')`,
		`INSERT INTO categories(id,group_id,name,icon,active,sort_order,created_at,updated_at) VALUES('category-one','group-main','Fixture category','other',1,0,'2026-08-08T12:00:00Z','2026-08-08T12:00:00Z')`,
		`INSERT INTO products(id,group_id,category_id,name,price_minor,pricing_mode,active,sort_order,created_at,updated_at) VALUES('product-one','group-main','category-one','Fixture product',250,'FIXED',1,0,'2026-08-08T12:00:00Z','2026-08-08T12:00:00Z')`,
		`INSERT INTO periods(id,group_id,label,status,starts_at,created_at) VALUES('period-one','group-main','One','OPEN','2026-08-08T12:00:00Z','2026-08-08T12:00:00Z')`,
		`INSERT INTO bookings(id,group_id,period_id,category_id,product_id,actor_membership_id,target_membership_id,quantity,unit_price_minor,total_minor,product_name,category_name,reason,created_at) VALUES('booking-one','group-main','period-one','category-one','product-one','member-admin','member-admin',1,250,250,'Fixture product','Fixture category','Migration fixture','2026-08-08T12:00:00Z')`,
		`INSERT INTO ledger_entries(id,group_id,period_id,membership_id,category_id,booking_id,account,amount_minor,description,created_at) VALUES('ledger-receivable','group-main','period-one','member-admin','category-one','booking-one','MEMBER_RECEIVABLE',250,'Fixture booking','2026-08-08T12:00:00Z')`,
		`INSERT INTO ledger_entries(id,group_id,period_id,category_id,booking_id,account,amount_minor,description,created_at) VALUES('ledger-revenue','group-main','period-one','category-one','booking-one','CATEGORY_REVENUE',-250,'Fixture booking','2026-08-08T12:00:00Z')`,
		`INSERT INTO period_statements(id,group_id,period_id,membership_id,display_name,email,charges_minor,payments_allocated_minor,adjustments_applied_minor,adjustments_provided_minor,amount_due_minor,status,created_at) VALUES('statement-one','group-main','period-one','member-admin','Admin','admin@example.test',0,0,0,0,0,'PAID','2026-08-08T12:00:00Z')`,
		`INSERT INTO audit_events(id,group_id,actor_user_id,actor_membership_id,action,resource_type,resource_id,metadata_json,occurred_at) VALUES('audit-one','group-main','user-admin','member-admin','booking.created','booking','booking-one','{"fixture":true}','2026-08-08T12:00:00Z')`,
	}
	for index, statement := range seed {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("seed pre-guest migration fixture %d: %v", index, err)
		}
	}

	if err := Migrate(ctx, db); err != nil {
		t.Fatalf("apply guest feature migration: %v", err)
	}

	var foreignKeys int
	if err := db.QueryRowContext(ctx, `PRAGMA foreign_keys`).Scan(&foreignKeys); err != nil || foreignKeys != 1 {
		t.Fatalf("foreign_keys=%d err=%v, want 1", foreignKeys, err)
	}
	var sessionCount, statementCount int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM sessions WHERE user_id='user-admin'`).Scan(&sessionCount); err != nil || sessionCount != 1 {
		t.Fatalf("preserved sessions=%d err=%v, want 1", sessionCount, err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM period_statements WHERE id='statement-one' AND email='admin@example.test'`).Scan(&statementCount); err != nil || statementCount != 1 {
		t.Fatalf("preserved statements=%d err=%v, want 1", statementCount, err)
	}
	var customRoleCount, bookingCount, ledgerCount, auditCount int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM roles role
		JOIN membership_role_assignments assignment ON assignment.group_id=role.group_id AND assignment.role_id=role.id
		JOIN role_permission_grants grant ON grant.group_id=role.group_id AND grant.role_id=role.id
		WHERE role.id='role-custom' AND assignment.membership_id='member-admin' AND grant.permission_key='CREATE_OWN_BOOKING'`).Scan(&customRoleCount); err != nil || customRoleCount != 1 {
		t.Fatalf("preserved custom role references=%d err=%v, want 1", customRoleCount, err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM bookings WHERE id='booking-one' AND actor_membership_id='member-admin' AND target_membership_id='member-admin'`).Scan(&bookingCount); err != nil || bookingCount != 1 {
		t.Fatalf("preserved bookings=%d err=%v, want 1", bookingCount, err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM ledger_entries WHERE booking_id='booking-one' AND id IN ('ledger-receivable','ledger-revenue')`).Scan(&ledgerCount); err != nil || ledgerCount != 2 {
		t.Fatalf("preserved ledger entries=%d err=%v, want 2", ledgerCount, err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM audit_events WHERE id='audit-one' AND actor_user_id='user-admin' AND actor_membership_id='member-admin' AND resource_id='booking-one'`).Scan(&auditCount); err != nil || auditCount != 1 {
		t.Fatalf("preserved audit events=%d err=%v, want 1", auditCount, err)
	}

	if _, err := db.ExecContext(ctx, `INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('invalid-user',NULL,'Invalid','hash',?,?)`, now, now); err == nil {
		t.Fatal("unpaired credentials unexpectedly passed the users constraint")
	}
	if _, err := db.ExecContext(ctx, `UPDATE users SET email=NULL,password_hash=NULL WHERE id='user-admin'`); err == nil || !strings.Contains(err.Error(), "membership credentials cannot be removed") {
		t.Fatalf("credential downgrade error=%v, want one-way membership guard", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('temporary-one',NULL,'Temporary One',NULL,?,?)`, now, now); err != nil {
		t.Fatalf("insert temporary identity: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO memberships(id,group_id,user_id,status,joined_at,temporary_guest_name_key) VALUES('temporary-member-one','group-main','temporary-one','ACTIVE',?,'temporary one')`, now); err != nil {
		t.Fatalf("insert temporary membership: %v", err)
	}
	var temporaryRoleCount int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM membership_role_assignments WHERE membership_id='temporary-member-one'`).Scan(&temporaryRoleCount); err != nil || temporaryRoleCount != 0 {
		t.Fatalf("temporary role assignments=%d err=%v, want 0", temporaryRoleCount, err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO sessions(id_hash,user_id,csrf_hash,expires_at,last_seen_at,created_at) VALUES('temporary-session','temporary-one','csrf','2099-01-01T00:00:00Z',?,?)`, now, now); err == nil || !strings.Contains(err.Error(), "sessions require an active credentialed user") {
		t.Fatalf("temporary session error=%v, want credential guard", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('temporary-two',NULL,'Temporary Two',NULL,?,?)`, now, now); err != nil {
		t.Fatalf("insert second temporary identity: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO memberships(id,group_id,user_id,status,joined_at,temporary_guest_name_key) VALUES('temporary-member-two','group-main','temporary-two','ACTIVE',?,'temporary one')`, now); err == nil {
		t.Fatal("duplicate active temporary guest name key unexpectedly passed")
	}

	if _, err := db.ExecContext(ctx, `INSERT INTO membership_role_assignments(group_id,membership_id,role_id,assigned_at) VALUES('group-main','temporary-member-one','role:MEMBER:group-main',?)`, now); err == nil || !strings.Contains(err.Error(), "temporary guests can receive only roles prepared by an open claim invitation") {
		t.Fatalf("direct temporary role assignment error=%v, want claim guard", err)
	}

	if _, err := db.ExecContext(ctx, `INSERT INTO invitations(id,group_id,email,token_hash,expires_at,created_by,created_at) VALUES('claim-late','group-main','late@example.test','late-token','2099-01-01T00:00:00Z','user-admin',?)`, now); err != nil {
		t.Fatalf("insert invitation before setting claim target: %v", err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE invitations SET target_membership_id='temporary-member-one' WHERE id='claim-late'`); err != nil {
		t.Fatalf("set claim target once: %v", err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE invitations SET target_membership_id=NULL WHERE id='claim-late'`); err == nil || !strings.Contains(err.Error(), "claim target are immutable") {
		t.Fatalf("clear established claim target error=%v, want immutability guard", err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE invitations SET revoked_at=? WHERE id='claim-late'`, now); err != nil {
		t.Fatalf("revoke late-target claim fixture: %v", err)
	}

	if _, err := db.ExecContext(ctx, `INSERT INTO invitations(id,group_id,email,token_hash,expires_at,created_by,created_at,target_membership_id) VALUES('claim-one','group-main','claimed@example.test','claim-token','2099-01-01T00:00:00Z','user-admin',?,'temporary-member-one')`, now); err != nil {
		t.Fatalf("insert claim invitation: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO invitation_role_assignments(group_id,invitation_id,role_id,assigned_at,assigned_by) VALUES('group-main','claim-one','role:MEMBER:group-main',?,'user-admin')`, now); err != nil {
		t.Fatalf("prepare claim role: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO membership_role_assignments(group_id,membership_id,role_id,assigned_at) VALUES('group-main','temporary-member-one','role:MEMBER:group-main',?)`, now); err != nil {
		t.Fatalf("assign prepared role during claim transition: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO membership_role_assignments(group_id,membership_id,role_id,assigned_at) VALUES('group-main','temporary-member-one','role-custom',?)`, now); err == nil {
		t.Fatal("unprepared temporary guest role unexpectedly passed")
	}
	if _, err := db.ExecContext(ctx, `UPDATE memberships SET temporary_guest_name_key=NULL WHERE id='temporary-member-one'`); err != nil {
		t.Fatalf("release temporary guest name: %v", err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE users SET email='claimed@example.test',password_hash='hash',updated_at=? WHERE id='temporary-one'`, now); err != nil {
		t.Fatalf("upgrade temporary credentials: %v", err)
	}
	if _, err := db.ExecContext(ctx, `DELETE FROM membership_role_assignments WHERE membership_id='temporary-member-one' AND role_id='role:MEMBER:group-main'`); err == nil || !strings.Contains(err.Error(), "credentialed active memberships must retain at least one role") {
		t.Fatalf("remove credentialed final role error=%v, want minimum-role guard", err)
	}

	if _, err := db.ExecContext(ctx, `INSERT INTO invitations(id,group_id,email,token_hash,expires_at,created_by,created_at,target_membership_id) VALUES('invalid-claim','group-main','other@example.test','invalid-token','2099-01-01T00:00:00Z','user-admin',?,'member-admin')`, now); err == nil || !strings.Contains(err.Error(), "claim target must be an active temporary guest") {
		t.Fatalf("credentialed claim target error=%v, want temporary target guard", err)
	}

	var readGrantCount int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM role_permission_grants WHERE role_id='role:GROUP_ADMINISTRATOR:group-main' AND permission_key IN ('VIEW_MEMBER_DIRECTORY','VIEW_STATISTICS')`).Scan(&readGrantCount); err != nil || readGrantCount != 2 {
		t.Fatalf("backfilled read grants=%d err=%v, want 2", readGrantCount, err)
	}
	var implied string
	if err := db.QueryRowContext(ctx, `SELECT implied_permissions_json FROM permission_definitions WHERE key='BOOK_FOR_OTHERS'`).Scan(&implied); err != nil || implied != `["VIEW_MEMBER_DIRECTORY"]` {
		t.Fatalf("BOOK_FOR_OTHERS implications=%q err=%v", implied, err)
	}
	var guestBookingAdminGrants, guestBookingCustomGrants int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM role_permission_grants WHERE role_id='role:GROUP_ADMINISTRATOR:group-main' AND permission_key='BOOK_FOR_GUESTS'`).Scan(&guestBookingAdminGrants); err != nil || guestBookingAdminGrants != 1 {
		t.Fatalf("administrator BOOK_FOR_GUESTS grants=%d err=%v, want 1", guestBookingAdminGrants, err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM role_permission_grants WHERE role_id='role-custom' AND permission_key='BOOK_FOR_GUESTS'`).Scan(&guestBookingCustomGrants); err != nil || guestBookingCustomGrants != 0 {
		t.Fatalf("custom role BOOK_FOR_GUESTS grants=%d err=%v, want 0", guestBookingCustomGrants, err)
	}
	for _, column := range []string{"guests_enabled", "guest_role_id"} {
		var count int
		if err := db.QueryRowContext(ctx, `SELECT count(*) FROM pragma_table_info('group_settings') WHERE name=?`, column).Scan(&count); err != nil || count != 0 {
			t.Fatalf("removed group_settings column %s count=%d err=%v", column, count, err)
		}
	}

	rows, err := db.QueryContext(ctx, `PRAGMA foreign_key_check`)
	if err != nil {
		t.Fatalf("check migrated foreign keys: %v", err)
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

func TestForeignKeysOffMigrationDirectiveMustBeExactFirstLine(t *testing.T) {
	if !requiresDisabledForeignKeys([]byte(foreignKeysOffMigrationDirective + "\nSELECT 1;")) {
		t.Fatal("exact foreign-key migration directive was not recognized")
	}
	for _, body := range [][]byte{
		[]byte("\n" + foreignKeysOffMigrationDirective),
		[]byte("-- teamtaler:migration foreign-keys-on\nSELECT 1;"),
		[]byte("SELECT 1;\n" + foreignKeysOffMigrationDirective),
	} {
		if requiresDisabledForeignKeys(body) {
			t.Fatalf("non-leading or unsupported directive unexpectedly recognized: %q", string(body))
		}
	}
}

func TestForeignKeysOffMigrationRestoresEnforcementAfterFailure(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, filepath.Join(t.TempDir(), "failed-rebuild.db"))
	if err != nil {
		t.Fatalf("open migrated database: %v", err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)

	body := []byte(foreignKeysOffMigrationDirective + `
CREATE TABLE migration_failure_probe(id TEXT PRIMARY KEY) STRICT;
INSERT INTO missing_migration_table(id) VALUES('fail');`)
	if err := applyMigrationWithForeignKeysDisabled(ctx, db, "9999_expected_failure.sql", body); err == nil {
		t.Fatal("invalid rebuild migration unexpectedly succeeded")
	}

	var foreignKeys int
	if err := db.QueryRowContext(ctx, `PRAGMA foreign_keys`).Scan(&foreignKeys); err != nil || foreignKeys != 1 {
		t.Fatalf("foreign_keys=%d err=%v after failed rebuild, want 1", foreignKeys, err)
	}
	var probeTableCount, appliedCount int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM sqlite_master WHERE type='table' AND name='migration_failure_probe'`).Scan(&probeTableCount); err != nil {
		t.Fatalf("inspect rolled-back probe table: %v", err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM schema_migrations WHERE version='9999_expected_failure.sql'`).Scan(&appliedCount); err != nil {
		t.Fatalf("inspect failed migration marker: %v", err)
	}
	if probeTableCount != 0 || appliedCount != 0 {
		t.Fatalf("failed rebuild left table/marker=%d/%d, want 0/0", probeTableCount, appliedCount)
	}
}
