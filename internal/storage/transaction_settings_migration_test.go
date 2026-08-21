package storage

import (
	"context"
	"database/sql"
	"testing"
)

func TestTransactionSettingsMigrationPreservesPaymentsAndSeedsEditableDefaults(t *testing.T) {
	ctx := context.Background()
	db := openDatabaseThroughMigration(t, "0023_membership_lifecycle.sql")
	defer db.Close()
	const now = "2026-08-11T12:00:00Z"
	for index, statement := range []string{
		`INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('user-one','one@example.test','One','hash-one','2026-08-11T12:00:00Z','2026-08-11T12:00:00Z')`,
		`INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES('group-one','One Group','EUR','2026-08-11T12:00:00Z','2026-08-11T12:00:00Z')`,
		`INSERT INTO group_settings(group_id,members_can_view_all_bookings,notification_emails_enabled,default_role_id,updated_at) VALUES('group-one',0,0,'role:MEMBER:group-one','2026-08-11T12:00:00Z')`,
		`INSERT INTO memberships(id,group_id,user_id,status,joined_at) VALUES('membership-one','group-one','user-one','ACTIVE','2026-08-11T12:00:00Z')`,
		`INSERT INTO payments(id,group_id,membership_id,amount_minor,received_at,method,reference,created_by,created_at) VALUES('payment-one','group-one','membership-one',500,'2026-08-11T12:00:00Z','CASH','Fixture','membership-one','2026-08-11T12:00:00Z')`,
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("seed pre-transaction-settings fixture %d: %v", index, err)
		}
	}

	if err := Migrate(ctx, db); err != nil {
		t.Fatalf("apply transaction-settings migration: %v", err)
	}
	var paymentMethod string
	var methodLabel sql.NullString
	if err := db.QueryRowContext(ctx, `SELECT method,method_label FROM payments WHERE id='payment-one'`).Scan(&paymentMethod, &methodLabel); err != nil {
		t.Fatalf("read preserved payment: %v", err)
	}
	if paymentMethod != "CASH" || methodLabel.Valid {
		t.Fatalf("preserved payment method=%q label=%#v", paymentMethod, methodLabel)
	}
	var foreignReason, ownReason, otherReason bool
	if err := db.QueryRowContext(ctx, `SELECT foreign_booking_reason_required,own_payment_reason_required,other_payment_reason_required FROM group_settings WHERE group_id='group-one'`).Scan(&foreignReason, &ownReason, &otherReason); err != nil {
		t.Fatalf("read reason defaults: %v", err)
	}
	if !foreignReason || !ownReason || otherReason {
		t.Fatalf("reason defaults=%t/%t/%t", foreignReason, ownReason, otherReason)
	}
	rows, err := db.QueryContext(ctx, `SELECT id FROM group_payment_methods WHERE group_id='group-one' ORDER BY sort_order`)
	if err != nil {
		t.Fatalf("list seeded methods: %v", err)
	}
	defer rows.Close()
	want := []string{"BANK_TRANSFER", "CASH", "PAYPAL", "OTHER"}
	seededCount := 0
	for rows.Next() {
		index := seededCount
		if index >= len(want) {
			t.Fatal("too many seeded payment methods")
		}
		var id string
		if err := rows.Scan(&id); err != nil || id != want[index] {
			t.Fatalf("seeded method %d=%q err=%v, want %q", index, id, err, want[index])
		}
		seededCount++
	}
	if seededCount != len(want) {
		t.Fatalf("seeded method count=%d, want %d", seededCount, len(want))
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES('group-two','Two Group','EUR',?,?)`, now, now); err != nil {
		t.Fatalf("insert post-migration group: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO group_settings(group_id,updated_at) VALUES('group-two',?)`, now); err != nil {
		t.Fatalf("insert post-migration group settings: %v", err)
	}
	newRows, err := db.QueryContext(ctx, `SELECT id,label,attachment_mode FROM group_payment_methods WHERE group_id='group-two' ORDER BY sort_order`)
	if err != nil {
		t.Fatalf("list post-migration payment methods: %v", err)
	}
	wantNew := []struct {
		id, label, attachmentMode string
	}{
		{id: "BANK_TRANSFER", label: "Bank transfer", attachmentMode: "OFF"},
		{id: "SHOPPING", label: "Shopping", attachmentMode: "REQUIRED"},
		{id: "CASH", label: "Cash", attachmentMode: "OFF"},
		{id: "PAYPAL", label: "PayPal", attachmentMode: "OFF"},
		{id: "OTHER", label: "Other", attachmentMode: "OPTIONAL"},
	}
	newIndex := 0
	for newRows.Next() {
		if newIndex >= len(wantNew) {
			newRows.Close()
			t.Fatal("too many post-migration payment methods")
		}
		var id, label, attachmentMode string
		if err := newRows.Scan(&id, &label, &attachmentMode); err != nil {
			newRows.Close()
			t.Fatalf("scan post-migration payment method: %v", err)
		}
		if got := (struct{ id, label, attachmentMode string }{id, label, attachmentMode}); got != wantNew[newIndex] {
			newRows.Close()
			t.Fatalf("post-migration payment method %d=%#v, want %#v", newIndex, got, wantNew[newIndex])
		}
		newIndex++
	}
	if err := newRows.Close(); err != nil {
		t.Fatalf("close post-migration payment methods: %v", err)
	}
	if newIndex != len(wantNew) {
		t.Fatalf("post-migration payment method count=%d, want %d", newIndex, len(wantNew))
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO group_payment_methods(group_id,id,label,sort_order,created_at) VALUES('group-one','DUPLICATE','cash',4,?)`, now); err == nil {
		t.Fatal("case-insensitive duplicate method label unexpectedly passed")
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO group_reason_suggestions(group_id,id,kind,label,sort_order,created_at) VALUES('group-one','reason-one','UNKNOWN','Reason',0,?)`, now); err == nil {
		t.Fatal("unknown reason kind unexpectedly passed")
	}
	checkRows, err := db.QueryContext(ctx, `PRAGMA foreign_key_check`)
	if err != nil {
		t.Fatalf("check foreign keys: %v", err)
	}
	defer checkRows.Close()
	if checkRows.Next() {
		t.Fatal("transaction-settings migration left a foreign-key violation")
	}
}
