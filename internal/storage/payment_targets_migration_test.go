package storage

import (
	"context"
	"database/sql"
	"testing"
)

func TestPaymentTargetsMigrationPreservesMethodsAndEnforcesTargetShapes(t *testing.T) {
	ctx := context.Background()
	db := openDatabaseThroughMigration(t, "0043_activity_reversal_feed_indexes.sql")
	defer db.Close()
	const now = "2026-08-27T12:00:00Z"
	if _, err := db.ExecContext(ctx, `INSERT INTO groups(id,name,currency,created_at,updated_at)
		VALUES('group-one','One Group','EUR',?,?)`, now, now); err != nil {
		t.Fatalf("insert pre-migration group: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO group_settings(group_id,updated_at) VALUES('group-one',?)`, now); err != nil {
		t.Fatalf("insert pre-migration settings: %v", err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE group_payment_methods SET attachment_mode='OPTIONAL' WHERE group_id='group-one' AND id='PAYPAL'`); err != nil {
		t.Fatalf("customize pre-migration method: %v", err)
	}

	if err := Migrate(ctx, db); err != nil {
		t.Fatalf("apply payment-target migration: %v", err)
	}

	var targetType, attachmentMode string
	var handle, recipientName, iban, bic sql.NullString
	if err := db.QueryRowContext(ctx, `SELECT attachment_mode,payment_target_type,paypal_me_handle,sepa_recipient_name,sepa_iban,sepa_bic
		FROM group_payment_methods WHERE group_id='group-one' AND id='PAYPAL'`).
		Scan(&attachmentMode, &targetType, &handle, &recipientName, &iban, &bic); err != nil {
		t.Fatalf("read migrated method: %v", err)
	}
	if attachmentMode != "OPTIONAL" || targetType != "NONE" || handle.Valid || recipientName.Valid || iban.Valid || bic.Valid {
		t.Fatalf("migrated method = %q/%q/%#v/%#v/%#v/%#v", attachmentMode, targetType, handle, recipientName, iban, bic)
	}

	if _, err := db.ExecContext(ctx, `UPDATE group_payment_methods SET payment_target_type='PAYPAL_ME',paypal_me_handle='Club123'
		WHERE group_id='group-one' AND id='PAYPAL'`); err != nil {
		t.Fatalf("store valid PayPal.Me target: %v", err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE group_payment_methods SET payment_target_type='SEPA_TRANSFER',paypal_me_handle=NULL,
		sepa_recipient_name='Team Club',sepa_iban='DE89370400440532013000',sepa_bic='COBADEFFXXX'
		WHERE group_id='group-one' AND id='BANK_TRANSFER'`); err != nil {
		t.Fatalf("store valid SEPA target: %v", err)
	}

	invalidStatements := []string{
		`UPDATE group_payment_methods SET payment_target_type='NONE',paypal_me_handle='Unexpected' WHERE group_id='group-one' AND id='CASH'`,
		`UPDATE group_payment_methods SET payment_target_type='PAYPAL_ME',paypal_me_handle='bad-handle' WHERE group_id='group-one' AND id='CASH'`,
		`UPDATE group_payment_methods SET payment_target_type='SEPA_TRANSFER',sepa_recipient_name='Team',sepa_iban=NULL WHERE group_id='group-one' AND id='CASH'`,
		`UPDATE group_payment_methods SET payment_target_type='UNKNOWN' WHERE group_id='group-one' AND id='CASH'`,
	}
	for index, statement := range invalidStatements {
		if _, err := db.ExecContext(ctx, statement); err == nil {
			t.Fatalf("invalid target shape %d unexpectedly passed", index)
		}
	}

	if _, err := db.ExecContext(ctx, `INSERT INTO groups(id,name,currency,created_at,updated_at)
		VALUES('group-two','Two Group','EUR',?,?)`, now, now); err != nil {
		t.Fatalf("insert post-migration group: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO group_settings(group_id,updated_at) VALUES('group-two',?)`, now); err != nil {
		t.Fatalf("insert post-migration settings: %v", err)
	}
	var seededCount, seededNone int
	if err := db.QueryRowContext(ctx, `SELECT count(*),sum(payment_target_type='NONE') FROM group_payment_methods WHERE group_id='group-two'`).Scan(&seededCount, &seededNone); err != nil {
		t.Fatalf("read post-migration seed: %v", err)
	}
	if seededCount != 5 || seededNone != 5 {
		t.Fatalf("post-migration seed count/none = %d/%d, want 5/5", seededCount, seededNone)
	}
	rows, err := db.QueryContext(ctx, `PRAGMA foreign_key_check`)
	if err != nil {
		t.Fatalf("check foreign keys: %v", err)
	}
	defer rows.Close()
	if rows.Next() {
		t.Fatal("payment-target migration left a foreign-key violation")
	}
}
