package groups

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/DasLukas/TeamTaler/internal/auth"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

func TestImportInvitationsCreatesEncryptedOutboxAndReplays(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	db, err := storage.Open(ctx, filepath.Join(t.TempDir(), "teamtaler.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer db.Close()
	authService := auth.Service{DB: db, SessionLifetime: 24 * time.Hour}
	if err := authService.Bootstrap(ctx, "admin@example.test", "Admin", "correct-horse-battery-staple", "Import Team", "EUR"); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	session, err := authService.Login(ctx, "admin@example.test", "correct-horse-battery-staple")
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	box, err := platform.NewSecretBox([]byte("0123456789abcdef0123456789abcdef"))
	if err != nil {
		t.Fatalf("secret box: %v", err)
	}
	service := Service{DB: db, TokenSealer: box}
	groupItems, err := service.List(ctx, session.Principal.UserID)
	if err != nil || len(groupItems) != 1 {
		t.Fatalf("list groups: groups=%d err=%v", len(groupItems), err)
	}
	membership := groupItems[0].Membership
	candidates := []InvitationImportCandidate{
		{Row: 2, Email: "NEW@Example.test", DisplayName: "New Member"},
		{Row: 3, ValidationCode: "invalid_email"},
		{Row: 4, Email: "admin@example.test", DisplayName: "Existing"},
		{Row: 5, Email: "new@example.test", DisplayName: "Duplicate"},
	}

	result, err := service.ImportInvitations(ctx, session.Principal, membership, "import-key-one", candidates)
	if err != nil {
		t.Fatalf("ImportInvitations: %v", err)
	}
	if result.Summary != (InvitationImportSummary{TotalRows: 4, Created: 1, Invalid: 1, Skipped: 2}) {
		t.Fatalf("summary = %#v", result.Summary)
	}
	if result.Rows[0].InvitationStatus != InvitationImportCreated || result.Rows[0].EmailDeliveryStatus != EmailDeliveryPending {
		t.Fatalf("created row = %#v", result.Rows[0])
	}
	if result.Rows[2].InvitationStatus != InvitationImportSkippedMember || result.Rows[3].InvitationStatus != InvitationImportSkippedInvitation {
		t.Fatalf("skipped rows = %#v", result.Rows[2:])
	}
	if result.Rows[3].InvitationID != result.Rows[0].InvitationID || result.Rows[3].EmailDeliveryStatus != EmailDeliveryPending {
		t.Fatalf("existing invitation delivery = %#v", result.Rows[3])
	}

	var encryptedToken, tokenHash string
	if err := db.QueryRowContext(ctx, `SELECT o.token_ciphertext,i.token_hash FROM invitation_email_outbox o
		JOIN invitations i ON i.id=o.invitation_id`).Scan(&encryptedToken, &tokenHash); err != nil {
		t.Fatalf("read outbox: %v", err)
	}
	plaintextToken, err := box.Open(encryptedToken)
	if err != nil {
		t.Fatalf("decrypt outbox token: %v", err)
	}
	if platform.HashSecret(plaintextToken) != tokenHash || strings.Contains(encryptedToken, plaintextToken) {
		t.Fatal("outbox token encryption does not match invitation hash")
	}
	encodedResult, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("marshal result: %v", err)
	}
	if strings.Contains(string(encodedResult), plaintextToken) {
		t.Fatal("import result contains plaintext invitation token")
	}
	listed, err := service.ListInvitations(ctx, membership)
	if err != nil || len(listed) != 1 {
		t.Fatalf("ListInvitations: invitations=%d err=%v", len(listed), err)
	}
	if listed[0].Roles == nil || len(listed[0].Roles) != 0 {
		t.Fatalf("listed invitation roles = %#v, want an empty array", listed[0].Roles)
	}

	replayed, err := service.ImportInvitations(ctx, session.Principal, membership, "import-key-one", candidates)
	if err != nil {
		t.Fatalf("replay import: %v", err)
	}
	if string(mustJSON(t, replayed)) != string(mustJSON(t, result)) {
		t.Fatalf("replay = %#v, want %#v", replayed, result)
	}
	var jobs int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM invitation_email_outbox`).Scan(&jobs); err != nil || jobs != 1 {
		t.Fatalf("outbox jobs = %d err=%v, want 1", jobs, err)
	}
	invitationID := result.Rows[0].InvitationID
	if _, err := db.ExecContext(ctx, `UPDATE invitation_email_outbox
		SET status='FAILED',attempt_count=5,next_attempt_at=NULL,lease_token=NULL,lease_until=NULL,last_error_code='smtp_delivery_failed'
		WHERE invitation_id=?`, invitationID); err != nil {
		t.Fatalf("mark email failed: %v", err)
	}
	retried, err := service.RetryInvitationEmail(ctx, session.Principal, membership, "retry-key-one", invitationID)
	if err != nil {
		t.Fatalf("RetryInvitationEmail: %v", err)
	}
	if retried.InvitationID != invitationID || retried.EmailDeliveryStatus != EmailDeliveryPending {
		t.Fatalf("retry result = %#v", retried)
	}
	var deliveryStatus string
	var attempts int
	if err := db.QueryRowContext(ctx, `SELECT status,attempt_count FROM invitation_email_outbox WHERE invitation_id=?`, invitationID).Scan(&deliveryStatus, &attempts); err != nil || deliveryStatus != "PENDING" || attempts != 0 {
		t.Fatalf("retried outbox status=%q attempts=%d err=%v", deliveryStatus, attempts, err)
	}

	different := []InvitationImportCandidate{{Row: 2, Email: "other@example.test"}}
	if _, err := service.ImportInvitations(ctx, session.Principal, membership, "import-key-one", different); !errors.Is(err, domain.ErrIdempotencyReuse) {
		t.Fatalf("reused key error = %v, want idempotency reuse", err)
	}
}

func TestInvitationEmailOperationsRequireConfiguredTokenSealer(t *testing.T) {
	t.Parallel()

	membership := domain.Membership{GroupID: "grp_test", Roles: []domain.Role{domain.RoleAdmin}}
	service := Service{}
	_, err := service.ImportInvitations(context.Background(), domain.Principal{UserID: "usr_test"}, membership, "import-key-two", []InvitationImportCandidate{{Row: 2, Email: "member@example.test"}})
	if !errors.Is(err, domain.ErrServiceUnavailable) {
		t.Fatalf("ImportInvitations error = %v, want unavailable", err)
	}
	_, err = service.RetryInvitationEmail(context.Background(), domain.Principal{UserID: "usr_test"}, membership, "retry-key-two", "inv_test")
	if !errors.Is(err, domain.ErrServiceUnavailable) {
		t.Fatalf("RetryInvitationEmail error = %v, want unavailable", err)
	}
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal JSON: %v", err)
	}
	return encoded
}
