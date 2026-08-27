package exportnotifications

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/DasLukas/TeamTaler/internal/exporting"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

func TestListenerCreatesOneInAppNotification(t *testing.T) {
	ctx := context.Background()
	db, err := storage.Open(ctx, filepath.Join(t.TempDir(), "export-notification.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer db.Close()
	statements := []string{
		`INSERT INTO users(id,email,display_name,password_hash,active,created_at,updated_at) VALUES('usr_export','export@example.test','Export User','hash',1,'2026-08-25T08:00:00Z','2026-08-25T08:00:00Z')`,
		`INSERT INTO groups(id,name,currency,status,created_at,updated_at) VALUES('grp_export','Export Group','EUR','ACTIVE','2026-08-25T08:00:00Z','2026-08-25T08:00:00Z')`,
		`INSERT INTO memberships(id,group_id,user_id,status,joined_at) VALUES('mem_export','grp_export','usr_export','ACTIVE','2026-08-25T08:00:00Z')`,
	}
	for _, statement := range statements {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("seed database: %v", err)
		}
	}
	listener := Listener{DB: db}
	completion := exporting.Completion{JobID: "exp_export", GroupID: "grp_export", MembershipID: "mem_export", UserID: "usr_export", Scope: exporting.ScopePersonal, Status: exporting.StatusReady}
	if err := listener.ExportCompleted(ctx, completion); err != nil {
		t.Fatalf("record completion: %v", err)
	}
	if err := listener.ExportCompleted(ctx, completion); err != nil {
		t.Fatalf("replay completion: %v", err)
	}
	var count int
	var eventType, contextJSON string
	if err := db.QueryRowContext(ctx, `SELECT count(*),type,context_json FROM notifications WHERE resource_id=?`, completion.JobID).Scan(&count, &eventType, &contextJSON); err != nil {
		t.Fatalf("read notification: %v", err)
	}
	if count != 1 || eventType != "DATA_EXPORT_READY" || contextJSON != `{"amountMinor":"0","exportId":"exp_export","exportScope":"PERSONAL"}` {
		t.Fatalf("notification count=%d type=%q context=%s", count, eventType, contextJSON)
	}
}
