package storage

import (
	"context"
	"testing"
)

func TestNotificationChannelsMigrationPreservesPoliciesAndOutboxStatuses(t *testing.T) {
	ctx := context.Background()
	db := openDatabaseThroughMigration(t, "0035_table_query_indexes.sql")
	defer db.Close()
	const now = "2026-08-20T08:00:00Z"
	statements := []string{
		`INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('user-one','one@example.test','One','hash',?,?)`,
		`INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES('group-one','One','EUR',?,?)`,
		`INSERT INTO memberships(id,group_id,user_id,joined_at) VALUES('member-one','group-one','user-one',?)`,
		`INSERT INTO group_settings(group_id,members_can_view_all_bookings,notification_emails_enabled,updated_at) VALUES('group-one',0,1,?)`,
		`INSERT INTO notifications(id,group_id,membership_id,type,title,body,context_json,created_at) VALUES('notice-pending','group-one','member-one','BOOKING_ASSIGNED','Pending','Pending','{}',?)`,
		`INSERT INTO notifications(id,group_id,membership_id,type,title,body,context_json,created_at) VALUES('notice-sending','group-one','member-one','BOOKING_ASSIGNED','Sending','Sending','{}',?)`,
		`INSERT INTO notifications(id,group_id,membership_id,type,title,body,context_json,created_at) VALUES('notice-sent','group-one','member-one','BOOKING_ASSIGNED','Sent','Sent','{}',?)`,
		`INSERT INTO notifications(id,group_id,membership_id,type,title,body,context_json,created_at) VALUES('notice-failed','group-one','member-one','BOOKING_ASSIGNED','Failed','Failed','{}',?)`,
	}
	for index, statement := range statements {
		arguments := make([]any, 0, 2)
		for placeholder := 0; placeholder < countQuestionMarks(statement); placeholder++ {
			arguments = append(arguments, now)
		}
		if _, err := db.ExecContext(ctx, statement, arguments...); err != nil {
			t.Fatalf("seed legacy notification fixture %d: %v", index, err)
		}
	}
	outboxStatements := []string{
		`INSERT INTO notification_email_outbox(notification_id,group_id,status,attempt_count,next_attempt_at,created_at,updated_at) VALUES('notice-pending','group-one','PENDING',1,?,?,?)`,
		`INSERT INTO notification_email_outbox(notification_id,group_id,status,attempt_count,lease_token,lease_until,created_at,updated_at) VALUES('notice-sending','group-one','SENDING',2,'lease-token',?,?,?)`,
		`INSERT INTO notification_email_outbox(notification_id,group_id,status,attempt_count,sent_at,created_at,updated_at) VALUES('notice-sent','group-one','SENT',1,?,?,?)`,
		`INSERT INTO notification_email_outbox(notification_id,group_id,status,attempt_count,last_error_code,created_at,updated_at) VALUES('notice-failed','group-one','FAILED',5,'delivery_failed',?,?)`,
	}
	for index, statement := range outboxStatements {
		arguments := make([]any, 0, 4)
		for placeholder := 0; placeholder < countQuestionMarks(statement); placeholder++ {
			arguments = append(arguments, now)
		}
		if _, err := db.ExecContext(ctx, statement, arguments...); err != nil {
			t.Fatalf("seed legacy outbox fixture %d: %v", index, err)
		}
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO system_setting_overrides(setting_key,value_type,value_text,version,updated_at) VALUES('smtp.enabled','BOOLEAN','true',3,?)`, now); err != nil {
		t.Fatalf("seed system override: %v", err)
	}

	if err := Migrate(ctx, db); err != nil {
		t.Fatalf("apply notification channel migration: %v", err)
	}

	var groupEvents, emailPreferences, pushPreferences int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM group_notification_events WHERE group_id='group-one'`).Scan(&groupEvents); err != nil || groupEvents != 14 {
		t.Fatalf("default group events=%d err=%v, want 14", groupEvents, err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM membership_notification_channels WHERE membership_id='member-one' AND channel='EMAIL'`).Scan(&emailPreferences); err != nil || emailPreferences != 7 {
		t.Fatalf("migrated email preferences=%d err=%v, want 7", emailPreferences, err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM membership_notification_channels WHERE membership_id='member-one' AND channel='PUSH'`).Scan(&pushPreferences); err != nil || pushPreferences != 14 {
		t.Fatalf("migrated push preferences=%d err=%v, want 14", pushPreferences, err)
	}
	rows, err := db.QueryContext(ctx, `SELECT status,attempt_count FROM notification_delivery_jobs ORDER BY status`)
	if err != nil {
		t.Fatalf("read migrated delivery jobs: %v", err)
	}
	got := make(map[string]int)
	for rows.Next() {
		var status string
		var attempts int
		if err := rows.Scan(&status, &attempts); err != nil {
			rows.Close()
			t.Fatalf("scan migrated delivery job: %v", err)
		}
		got[status] = attempts
	}
	rows.Close()
	for status, attempts := range map[string]int{"PENDING": 1, "SENDING": 2, "SENT": 1, "FAILED": 5} {
		if got[status] != attempts {
			t.Fatalf("migrated status %s attempts=%d, want %d", status, got[status], attempts)
		}
	}
	var overrideValue string
	var overrideVersion int
	if err := db.QueryRowContext(ctx, `SELECT value_text,version FROM system_setting_overrides WHERE setting_key='smtp.enabled'`).Scan(&overrideValue, &overrideVersion); err != nil || overrideValue != "true" || overrideVersion != 3 {
		t.Fatalf("preserved override=%q/v%d err=%v", overrideValue, overrideVersion, err)
	}
	if _, err := db.ExecContext(ctx, `SELECT count(*) FROM notification_email_outbox`); err == nil {
		t.Fatal("legacy email outbox still exists after migration")
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('user-two','two@example.test','Two','hash',?,?)`, now, now); err != nil {
		t.Fatalf("insert user after migration: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES('group-two','Two','EUR',?,?)`, now, now); err != nil {
		t.Fatalf("insert group after migration: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO memberships(id,group_id,user_id,joined_at) VALUES('member-two','group-two','user-two',?)`, now); err != nil {
		t.Fatalf("insert membership after migration: %v", err)
	}
	var seededEvents, seededPreferenceVersion, seededPushPreferences, seededEmailPreferences int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM group_notification_events WHERE group_id='group-two'`).Scan(&seededEvents); err != nil || seededEvents != 14 {
		t.Fatalf("new group event defaults=%d err=%v, want 14", seededEvents, err)
	}
	if err := db.QueryRowContext(ctx, `SELECT version FROM membership_notification_settings WHERE membership_id='member-two'`).Scan(&seededPreferenceVersion); err != nil || seededPreferenceVersion != 1 {
		t.Fatalf("new membership preference version=%d err=%v, want 1", seededPreferenceVersion, err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM membership_notification_channels WHERE membership_id='member-two' AND channel='PUSH'`).Scan(&seededPushPreferences); err != nil || seededPushPreferences != 14 {
		t.Fatalf("new membership push preferences=%d err=%v, want 14", seededPushPreferences, err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM membership_notification_channels WHERE membership_id='member-two' AND channel='EMAIL'`).Scan(&seededEmailPreferences); err != nil || seededEmailPreferences != 3 {
		t.Fatalf("new membership settlement email preferences=%d err=%v, want 3", seededEmailPreferences, err)
	}
}

func TestDefaultPushMigrationPreservesCustomizedMembershipPreferences(t *testing.T) {
	ctx := context.Background()
	db := openDatabaseThroughMigration(t, "0036_notification_channels.sql")
	defer db.Close()
	const now = "2026-08-20T08:00:00Z"
	for _, statement := range []string{
		`INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('user-custom','custom@example.test','Custom','hash','2026-08-20T08:00:00Z','2026-08-20T08:00:00Z')`,
		`INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES('group-custom','Custom','EUR','2026-08-20T08:00:00Z','2026-08-20T08:00:00Z')`,
		`INSERT INTO memberships(id,group_id,user_id,joined_at) VALUES('member-custom','group-custom','user-custom','2026-08-20T08:00:00Z')`,
		`INSERT INTO membership_notification_channels(group_id,membership_id,event_type,channel,enabled_at,updated_at) VALUES('group-custom','member-custom','BOOKING_ASSIGNED','PUSH','2026-08-20T08:00:00Z','2026-08-20T08:00:00Z')`,
		`UPDATE membership_notification_settings SET version=2,updated_at='2026-08-20T08:01:00Z' WHERE membership_id='member-custom'`,
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("seed customized push preferences: %v", err)
		}
	}

	if err := Migrate(ctx, db); err != nil {
		t.Fatalf("apply default push migration: %v", err)
	}

	var pushPreferences, emailPreferences int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM membership_notification_channels WHERE membership_id='member-custom' AND channel='PUSH'`).Scan(&pushPreferences); err != nil || pushPreferences != 8 {
		t.Fatalf("customized push preferences=%d err=%v, want 8", pushPreferences, err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM membership_notification_channels WHERE membership_id='member-custom' AND channel='EMAIL'`).Scan(&emailPreferences); err != nil || emailPreferences != 0 {
		t.Fatalf("customized email preferences=%d err=%v, want 0", emailPreferences, err)
	}
}

func countQuestionMarks(value string) int {
	count := 0
	for _, character := range value {
		if character == '?' {
			count++
		}
	}
	return count
}
