package webpush

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/netip"
	"path/filepath"
	"testing"

	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

func TestRegisterEnforcesTenActiveDevicesButAllowsReconciliation(t *testing.T) {
	ctx := context.Background()
	db, err := storage.Open(ctx, filepath.Join(t.TempDir(), "teamtaler.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer db.Close()
	if _, err := db.ExecContext(ctx, `INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at)
		VALUES('usr_limit','limit@example.test','Limit User','hash','2026-08-20T10:00:00Z','2026-08-20T10:00:00Z')`); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	secrets, err := NewSecrets(bytes.Repeat([]byte{0x33}, 32))
	if err != nil {
		t.Fatalf("NewSecrets: %v", err)
	}
	service, err := NewSubscriptionService(db, secrets, staticResolver{"push.example.test": {mustAddress(t, "93.184.216.34")}})
	if err != nil {
		t.Fatalf("NewSubscriptionService: %v", err)
	}
	first := validSubscriptionInput(t)
	for index := 0; index < MaxDevicesPerUser; index++ {
		input := first
		input.Endpoint = fmt.Sprintf("https://push.example.test/send/browser-%d", index)
		if _, err := service.Register(ctx, "usr_limit", "0123456789abcdef", fmt.Sprintf("Browser %d", index), input); err != nil {
			t.Fatalf("register device %d: %v", index, err)
		}
	}
	refresh := first
	refresh.Endpoint = "https://push.example.test/send/browser-0"
	if _, err := service.Register(ctx, "usr_limit", "0123456789abcdef", "Renamed browser", refresh); err != nil {
		t.Fatalf("reconcile existing device at limit: %v", err)
	}
	extra := first
	extra.Endpoint = "https://push.example.test/send/browser-extra"
	if _, err := service.Register(ctx, "usr_limit", "0123456789abcdef", "Extra browser", extra); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("eleventh active device error=%v, want conflict", err)
	}
}

func TestRegisterReassignmentCreatesNewIdentityAndExpiresOldJobs(t *testing.T) {
	ctx := context.Background()
	db, err := storage.Open(ctx, filepath.Join(t.TempDir(), "teamtaler.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer db.Close()
	for _, statement := range []string{
		`INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('usr_old','old@example.test','Old User','hash','2026-08-20T10:00:00Z','2026-08-20T10:00:00Z')`,
		`INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('usr_new','new@example.test','New User','hash','2026-08-20T10:00:00Z','2026-08-20T10:00:00Z')`,
		`INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES('grp_old','Prior Group','EUR','2026-08-20T10:00:00Z','2026-08-20T10:00:00Z')`,
		`INSERT INTO memberships(id,group_id,user_id,joined_at) VALUES('mem_old','grp_old','usr_old','2026-08-20T10:00:00Z')`,
		`INSERT INTO notifications(id,group_id,membership_id,type,title,body,context_json,created_at) VALUES('ntf_old_pending','grp_old','mem_old','BOOKING_ASSIGNED','Title','Body','{}','2026-08-20T10:00:00Z')`,
		`INSERT INTO notifications(id,group_id,membership_id,type,title,body,context_json,created_at) VALUES('ntf_old_sending','grp_old','mem_old','BOOKING_ASSIGNED','Title','Body','{}','2026-08-20T10:00:00Z')`,
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("seed database: %v", err)
		}
	}
	secrets, err := NewSecrets(bytes.Repeat([]byte{0x77}, 32))
	if err != nil {
		t.Fatalf("NewSecrets: %v", err)
	}
	service, err := NewSubscriptionService(db, secrets, staticResolver{
		"push.example.test": {mustAddress(t, "93.184.216.34")},
	})
	if err != nil {
		t.Fatalf("NewSubscriptionService: %v", err)
	}
	input := validSubscriptionInput(t)
	oldDevice, err := service.Register(ctx, "usr_old", "0123456789abcdef", "Old browser", input)
	if err != nil {
		t.Fatalf("register old owner: %v", err)
	}
	for _, statement := range []string{
		`INSERT INTO notification_delivery_jobs(id,notification_id,group_id,channel,push_subscription_id,status,attempt_count,next_attempt_at,expires_at,created_at,updated_at) VALUES('job_old_pending','ntf_old_pending','grp_old','PUSH','` + oldDevice.ID + `','PENDING',0,'2026-08-20T10:00:00Z','2026-08-21T10:00:00Z','2026-08-20T10:00:00Z','2026-08-20T10:00:00Z')`,
		`INSERT INTO notification_delivery_jobs(id,notification_id,group_id,channel,push_subscription_id,status,attempt_count,lease_token,lease_until,expires_at,created_at,updated_at) VALUES('job_old_sending','ntf_old_sending','grp_old','PUSH','` + oldDevice.ID + `','SENDING',1,'lease','2026-08-20T10:05:00Z','2026-08-21T10:00:00Z','2026-08-20T10:00:00Z','2026-08-20T10:00:00Z')`,
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("seed delivery job: %v", err)
		}
	}
	newDevice, err := service.Register(ctx, "usr_new", "0123456789abcdef", "Shared browser", input)
	if err != nil {
		t.Fatalf("reassign endpoint: %v", err)
	}
	if newDevice.ID == oldDevice.ID {
		t.Fatal("cross-account endpoint reassignment reused subscription identity")
	}
	var oldRevoked string
	if err := db.QueryRowContext(ctx, `SELECT revoked_at FROM web_push_subscriptions WHERE id=?`, oldDevice.ID).Scan(&oldRevoked); err != nil || oldRevoked == "" {
		t.Fatalf("old subscription revokedAt=%q err=%v", oldRevoked, err)
	}
	var newOwner string
	if err := db.QueryRowContext(ctx, `SELECT user_id FROM web_push_subscriptions WHERE id=? AND revoked_at IS NULL`, newDevice.ID).Scan(&newOwner); err != nil || newOwner != "usr_new" {
		t.Fatalf("new subscription owner=%q err=%v", newOwner, err)
	}
	rows, err := db.QueryContext(ctx, `SELECT status,last_error_code,lease_token FROM notification_delivery_jobs WHERE push_subscription_id=? ORDER BY id`, oldDevice.ID)
	if err != nil {
		t.Fatalf("query old jobs: %v", err)
	}
	defer rows.Close()
	count := 0
	for rows.Next() {
		var status, code string
		var lease any
		if err := rows.Scan(&status, &code, &lease); err != nil {
			t.Fatalf("scan old job: %v", err)
		}
		if status != "EXPIRED" || code != "subscription_reassigned" || lease != nil {
			t.Fatalf("old job status=%q code=%q lease=%v", status, code, lease)
		}
		count++
	}
	if count != 2 {
		t.Fatalf("expired old jobs=%d, want 2", count)
	}
}

func mustAddress(t *testing.T, value string) netip.Addr {
	t.Helper()
	address, err := netip.ParseAddr(value)
	if err != nil {
		t.Fatalf("parse address: %v", err)
	}
	return address
}
