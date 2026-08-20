package storage

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
)

func TestPaymentAttachmentMigrationAddsModesTablesAndBoundedSetting(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, filepath.Join(t.TempDir(), "teamtaler.db"))
	if err != nil {
		t.Fatalf("open migrated database: %v", err)
	}
	defer db.Close()
	var attachmentModeDefault string
	rows, err := db.QueryContext(ctx, `PRAGMA table_info(group_payment_methods)`)
	if err != nil {
		t.Fatalf("read payment method schema: %v", err)
	}
	for rows.Next() {
		var position, notNull, primaryKey int
		var name, dataType string
		var defaultValue any
		if err := rows.Scan(&position, &name, &dataType, &notNull, &defaultValue, &primaryKey); err != nil {
			rows.Close()
			t.Fatalf("scan payment method schema: %v", err)
		}
		if name == "attachment_mode" && defaultValue != nil {
			attachmentModeDefault = fmt.Sprint(defaultValue)
		}
	}
	if err := rows.Close(); err != nil {
		t.Fatalf("close payment method schema: %v", err)
	}
	if attachmentModeDefault != "'OFF'" {
		t.Fatalf("attachment mode default=%q, want 'OFF'", attachmentModeDefault)
	}
	for _, table := range []string{"payment_attachments", "system_attachment_delete_jobs"} {
		var exists int
		if err := db.QueryRowContext(ctx, `SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?`, table).Scan(&exists); err != nil || exists != 1 {
			t.Fatalf("table %s exists=%d err=%v", table, exists, err)
		}
	}
	const now = "2026-08-20T12:00:00Z"
	if _, err := db.ExecContext(ctx, `INSERT INTO system_setting_overrides(setting_key,value_type,value_text,updated_at)
		VALUES('attachment.upload_max_bytes','INTEGER','15728640',?)`, now); err != nil {
		t.Fatalf("insert valid attachment limit: %v", err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE system_setting_overrides SET value_text='53477376' WHERE setting_key='attachment.upload_max_bytes'`); err == nil {
		t.Fatal("attachment limit above 50 MiB unexpectedly passed database trigger")
	}
	for _, invalid := range []string{"0", "1048577", "52428801"} {
		if _, err := db.ExecContext(ctx, `UPDATE system_setting_overrides SET value_text=? WHERE setting_key='attachment.upload_max_bytes'`, invalid); err == nil {
			t.Fatalf("invalid attachment limit %s unexpectedly passed database trigger", invalid)
		}
	}
	statements := []string{
		`INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('user-a','a@example.test','A','hash',?,?)`,
		`INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('user-b','b@example.test','B','hash',?,?)`,
		`INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES('group-a','A','EUR',?,?)`,
		`INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES('group-b','B','EUR',?,?)`,
		`INSERT INTO memberships(id,group_id,user_id,status,joined_at) VALUES('member-a','group-a','user-a','ACTIVE',?)`,
		`INSERT INTO memberships(id,group_id,user_id,status,joined_at) VALUES('member-b','group-b','user-b','ACTIVE',?)`,
		`INSERT INTO payments(id,group_id,membership_id,amount_minor,received_at,method,created_by,created_at) VALUES('payment-a','group-a','member-a',100,?,'CASH','member-a',?)`,
	}
	for index, statement := range statements {
		arguments := []any{now}
		if index < 4 || index == 6 {
			arguments = []any{now, now}
		}
		if _, err := db.ExecContext(ctx, statement, arguments...); err != nil {
			t.Fatalf("prepare cross-group attachment fixture %d: %v", index, err)
		}
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO group_payment_methods(group_id,id,label,position,attachment_mode)
		VALUES('group-a','INVALID','Invalid',0,'MAYBE')`); err == nil {
		t.Fatal("invalid attachment mode unexpectedly passed the database constraint")
	}
	hash := strings.Repeat("a", 64)
	if _, err := db.ExecContext(ctx, `INSERT INTO payment_attachments(
		payment_id,group_id,storage_key,original_filename,media_type,size_bytes,sha256,created_by_membership_id,created_at
	) VALUES('payment-a','group-a',?,'receipt.pdf','application/pdf',8,?,'member-b',?)`, hash+".pdf", hash, now); err == nil {
		t.Fatal("cross-group attachment creator unexpectedly passed the composite foreign key")
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO payment_attachments(
		payment_id,group_id,storage_key,original_filename,media_type,size_bytes,sha256,created_by_membership_id,created_at
	) VALUES('payment-a','group-b',?,'receipt.pdf','application/pdf',8,?,'member-b',?)`, hash+".pdf", hash, now); err == nil {
		t.Fatal("cross-group payment reference unexpectedly passed the composite foreign key")
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO payment_attachments(
		payment_id,group_id,storage_key,original_filename,media_type,size_bytes,sha256,created_by_membership_id,created_at
	) VALUES('payment-a','group-a',?,'receipt.pdf','application/pdf',8,?,'member-a',?)`, hash+".pdf", hash, now); err != nil {
		t.Fatalf("insert valid payment attachment: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO payment_attachments(
		payment_id,group_id,storage_key,original_filename,media_type,size_bytes,sha256,created_by_membership_id,created_at
	) VALUES('payment-a','group-a',?,'duplicate.pdf','application/pdf',8,?,'member-a',?)`, hash+".pdf", hash, now); err == nil {
		t.Fatal("second attachment for one payment unexpectedly passed the primary key")
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO system_attachment_delete_jobs(storage_key,next_attempt_at,created_at,updated_at)
		VALUES('../receipt.pdf',?,?,?)`, now, now, now); err == nil {
		t.Fatal("non-canonical attachment delete job key unexpectedly passed the database constraint")
	}
}
