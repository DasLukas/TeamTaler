package storage

import (
	"context"
	"database/sql"
	"testing"

	"github.com/DasLukas/TeamTaler/migrations"
)

func TestSystemAdministrationMigrationPreservesGroupsAndConstrainsGlobalState(t *testing.T) {
	ctx := context.Background()
	db := openDatabaseThroughMigration(t, "0029_account_group_preference.sql")
	defer db.Close()

	const now = "2026-08-15T12:00:00Z"
	statements := []struct {
		query string
		args  []any
	}{
		{`INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('user-one','one@example.test','One','hash',?,?)`, []any{now, now}},
		{`INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES('group-one','One','EUR',?,?)`, []any{now, now}},
	}
	for _, statement := range statements {
		if _, err := db.ExecContext(ctx, statement.query, statement.args...); err != nil {
			t.Fatalf("prepare migration fixture: %v", err)
		}
	}
	body, err := migrations.Files.ReadFile("0030_system_administration.sql")
	if err != nil {
		t.Fatalf("read system administration migration: %v", err)
	}
	if err := applyMigration(ctx, db, "0030_system_administration.sql", body); err != nil {
		t.Fatalf("apply system administration migration: %v", err)
	}

	var status string
	var version int64
	var archivedAt, archivedBy sql.NullString
	if err := db.QueryRowContext(ctx, `SELECT status,version,archived_at,archived_by FROM groups WHERE id='group-one'`).
		Scan(&status, &version, &archivedAt, &archivedBy); err != nil {
		t.Fatalf("read migrated group lifecycle: %v", err)
	}
	if status != "ACTIVE" || version != 1 || archivedAt.Valid || archivedBy.Valid {
		t.Fatalf("migrated group lifecycle=%q/%d/%q/%q", status, version, archivedAt.String, archivedBy.String)
	}
	if _, err := db.ExecContext(ctx, `UPDATE groups SET status='ARCHIVED' WHERE id='group-one'`); err == nil {
		t.Fatal("archived group without metadata unexpectedly passed lifecycle trigger")
	}
	if _, err := db.ExecContext(ctx, `UPDATE groups SET status='ARCHIVED',version=2,archived_at=?,archived_by='user-one' WHERE id='group-one'`, now); err != nil {
		t.Fatalf("archive group with metadata: %v", err)
	}

	var migratedAdministratorCount int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM system_role_assignments`).Scan(&migratedAdministratorCount); err != nil {
		t.Fatalf("count migrated system administrators: %v", err)
	}
	if migratedAdministratorCount != 0 {
		t.Fatalf("existing account was implicitly elevated during migration: count=%d", migratedAdministratorCount)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO system_role_assignments(user_id,role,granted_at) VALUES('user-one','GROUP_ADMINISTRATOR',?)`, now); err == nil {
		t.Fatal("group role unexpectedly entered system role assignments")
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO system_role_assignments(user_id,role,granted_at) VALUES('user-one','SYSTEM_ADMINISTRATOR',?)`, now); err != nil {
		t.Fatalf("insert global administrator role: %v", err)
	}

	var revision, smtpRevision int64
	var smtpTestStatus string
	if err := db.QueryRowContext(ctx, `SELECT revision,smtp_revision,smtp_test_status FROM system_settings_state WHERE singleton=1`).Scan(&revision, &smtpRevision, &smtpTestStatus); err != nil {
		t.Fatalf("read initial settings state: %v", err)
	}
	if revision != 1 || smtpRevision != 0 || smtpTestStatus != "UNTESTED" {
		t.Fatalf("initial settings state=%d/%d/%s, want 1/0/UNTESTED", revision, smtpRevision, smtpTestStatus)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO system_setting_overrides(setting_key,value_type,value_text,version,updated_at)
		VALUES('media.upload_max_bytes','STRING','5242880',1,?)`, now); err == nil {
		t.Fatal("incorrect persisted setting type unexpectedly passed constraint")
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO system_setting_overrides(setting_key,value_type,value_text,version,updated_at)
		VALUES('access.public_join_enabled','BOOLEAN','yes',1,?)`, now); err == nil {
		t.Fatal("incorrect persisted boolean unexpectedly passed constraint")
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO system_setting_overrides(setting_key,value_type,value_text,version,updated_at)
		VALUES('media.upload_max_bytes','INTEGER','5242880',1,?)`, now); err != nil {
		t.Fatalf("insert typed media setting: %v", err)
	}

	if _, err := db.ExecContext(ctx, `INSERT INTO system_audit_events(id,actor_user_id,action,resource_type,metadata_json,occurred_at)
		VALUES('audit-one','user-one','system.tested','system','{}',?)`, now); err != nil {
		t.Fatalf("insert global audit event: %v", err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE system_audit_events SET action='tampered' WHERE id='audit-one'`); err == nil {
		t.Fatal("system audit event update unexpectedly succeeded")
	}
	if _, err := db.ExecContext(ctx, `DELETE FROM system_audit_events WHERE id='audit-one'`); err == nil {
		t.Fatal("system audit event delete unexpectedly succeeded")
	}

	rows, err := db.QueryContext(ctx, `PRAGMA foreign_key_check`)
	if err != nil {
		t.Fatalf("check migrated foreign keys: %v", err)
	}
	defer rows.Close()
	if rows.Next() {
		t.Fatal("system administration migration left a foreign-key violation")
	}
}
