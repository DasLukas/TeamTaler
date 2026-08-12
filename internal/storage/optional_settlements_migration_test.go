package storage

import (
	"context"
	"testing"
)

func TestOptionalSettlementsMigrationDisablesExistingAndNewGroupsByDefault(t *testing.T) {
	ctx := context.Background()
	db := openDatabaseThroughMigration(t, "0024_transaction_settings.sql")
	defer db.Close()
	const now = "2026-08-11T12:00:00Z"
	for index, statement := range []string{
		`INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('user-existing','existing@example.test','Existing User','hash','2026-08-11T12:00:00Z','2026-08-11T12:00:00Z')`,
		`INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES('group-existing','Existing Group','EUR','2026-08-11T12:00:00Z','2026-08-11T12:00:00Z')`,
		`INSERT INTO group_settings(group_id,members_can_view_all_bookings,notification_emails_enabled,updated_at) VALUES('group-existing',0,0,'2026-08-11T12:00:00Z')`,
		`INSERT INTO memberships(id,group_id,user_id,status,joined_at) VALUES('membership-existing','group-existing','user-existing','ACTIVE','2026-08-11T12:00:00Z')`,
		`INSERT INTO periods(id,group_id,label,status,starts_at,created_at) VALUES('period-existing','group-existing','Existing period','OPEN','2026-08-11T12:00:00Z','2026-08-11T12:00:00Z')`,
		`INSERT INTO ledger_entries(id,group_id,period_id,membership_id,account,amount_minor,description,created_at) VALUES('ledger-existing','group-existing','period-existing','membership-existing','MEMBER_RECEIVABLE',125,'Existing balance','2026-08-11T12:00:00Z')`,
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("seed pre-optional-settlements fixture %d: %v", index, err)
		}
	}

	if err := Migrate(ctx, db); err != nil {
		t.Fatalf("apply optional-settlements migration: %v", err)
	}
	var existingEnabled bool
	if err := db.QueryRowContext(ctx, `SELECT settlements_enabled FROM group_settings WHERE group_id='group-existing'`).Scan(&existingEnabled); err != nil {
		t.Fatalf("read existing group setting: %v", err)
	}
	if existingEnabled {
		t.Fatal("existing group unexpectedly has settlements enabled")
	}
	var openPeriodID string
	var balanceMinor int64
	if err := db.QueryRowContext(ctx, `SELECT id FROM periods WHERE group_id='group-existing' AND status='OPEN'`).Scan(&openPeriodID); err != nil || openPeriodID != "period-existing" {
		t.Fatalf("preserved open period=%q err=%v", openPeriodID, err)
	}
	if err := db.QueryRowContext(ctx, `SELECT coalesce(sum(amount_minor),0) FROM ledger_entries WHERE group_id='group-existing' AND membership_id='membership-existing' AND account='MEMBER_RECEIVABLE'`).Scan(&balanceMinor); err != nil || balanceMinor != 125 {
		t.Fatalf("preserved balance=%d err=%v, want 125", balanceMinor, err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES('group-new','New Group','EUR',?,?)`, now, now); err != nil {
		t.Fatalf("insert new group: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO group_settings(group_id,members_can_view_all_bookings,notification_emails_enabled,updated_at) VALUES('group-new',0,0,?)`, now); err != nil {
		t.Fatalf("insert new group settings: %v", err)
	}
	var newEnabled bool
	if err := db.QueryRowContext(ctx, `SELECT settlements_enabled FROM group_settings WHERE group_id='group-new'`).Scan(&newEnabled); err != nil {
		t.Fatalf("read new group setting: %v", err)
	}
	if newEnabled {
		t.Fatal("new group unexpectedly has settlements enabled")
	}
	if _, err := db.ExecContext(ctx, `UPDATE group_settings SET settlements_enabled=2 WHERE group_id='group-new'`); err == nil {
		t.Fatal("invalid settlement setting unexpectedly passed database constraint")
	}
}
