package periods

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"

	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/notifications"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

func TestSnapshotStatementsSkipsOnlyIdleTemporaryGuestsAndKeepsNullableEmail(t *testing.T) {
	ctx := context.Background()
	db, err := storage.Open(ctx, filepath.Join(t.TempDir(), "managed-statements.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer db.Close()
	now := "2026-08-08T12:00:00Z"
	seed := []string{
		`INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('user-admin','admin@example.test','Admin','hash','2026-08-08T12:00:00Z','2026-08-08T12:00:00Z')`,
		`INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('user-regular','regular@example.test','Regular','hash','2026-08-08T12:00:00Z','2026-08-08T12:00:00Z')`,
		`INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('user-managed-idle',NULL,'Idle Guest',NULL,'2026-08-08T12:00:00Z','2026-08-08T12:00:00Z')`,
		`INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('user-managed-active',NULL,'Active Guest',NULL,'2026-08-08T12:00:00Z','2026-08-08T12:00:00Z')`,
		`INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES('group-one','One','EUR','2026-08-08T12:00:00Z','2026-08-08T12:00:00Z')`,
		`INSERT INTO memberships(id,group_id,user_id,status,joined_at) VALUES('member-admin','group-one','user-admin','ACTIVE','2026-08-08T12:00:00Z')`,
		`INSERT INTO memberships(id,group_id,user_id,status,joined_at) VALUES('member-regular','group-one','user-regular','ACTIVE','2026-08-08T12:00:00Z')`,
		`INSERT INTO memberships(id,group_id,user_id,status,joined_at,temporary_guest_name_key) VALUES('member-managed-idle','group-one','user-managed-idle','ACTIVE','2026-08-08T12:00:00Z','idle guest')`,
		`INSERT INTO memberships(id,group_id,user_id,status,joined_at,temporary_guest_name_key) VALUES('member-managed-active','group-one','user-managed-active','ACTIVE','2026-08-08T12:00:00Z','active guest')`,
		`INSERT INTO periods(id,group_id,label,status,starts_at,due_at,created_at) VALUES('period-one','group-one','One','OPEN','2026-08-08T12:00:00Z','2026-08-31','2026-08-08T12:00:00Z')`,
		`INSERT INTO ledger_entries(id,group_id,period_id,membership_id,account,amount_minor,description,created_at) VALUES('ledger-managed','group-one','period-one','member-managed-active','MEMBER_RECEIVABLE',500,'Managed booking','2026-08-08T12:00:00Z')`,
	}
	for index, statement := range seed {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("seed period fixture %d: %v", index, err)
		}
	}
	service := Service{DB: db, Notifications: notifications.Service{DB: db}}
	var statementCount int64
	if err := storage.WithTx(ctx, db, func(tx *sql.Tx) error {
		var err error
		statementCount, err = service.snapshotStatements(ctx, tx, "group-one", "period-one", "One", now)
		return err
	}); err != nil {
		t.Fatalf("snapshot statements: %v", err)
	}
	if statementCount != 3 {
		t.Fatalf("statement count=%d, want 3", statementCount)
	}
	var idleCount, credentialedCount int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM period_statements WHERE membership_id='member-managed-idle'`).Scan(&idleCount); err != nil || idleCount != 0 {
		t.Fatalf("idle managed statements=%d err=%v, want 0", idleCount, err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM period_statements WHERE membership_id IN ('member-admin','member-regular')`).Scan(&credentialedCount); err != nil || credentialedCount != 2 {
		t.Fatalf("credentialed zero-activity statements=%d err=%v, want 2", credentialedCount, err)
	}
	var managedEmail sql.NullString
	if err := db.QueryRowContext(ctx, `SELECT email FROM period_statements WHERE membership_id='member-managed-active'`).Scan(&managedEmail); err != nil {
		t.Fatalf("read managed statement email: %v", err)
	}
	if managedEmail.Valid {
		t.Fatalf("managed statement email=%q, want NULL", managedEmail.String)
	}
	items, err := service.Statements(ctx, domain.Membership{ID: "member-managed-active", GroupID: "group-one"}, "period-one")
	if err != nil {
		t.Fatalf("list managed statement: %v", err)
	}
	if len(items) != 1 || items[0].Email != nil || items[0].AmountDueMinor != 500 {
		t.Fatalf("managed statements=%#v", items)
	}
}
