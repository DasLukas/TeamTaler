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

type failingTokenSealer struct{}

func (failingTokenSealer) Seal(string) (string, error) {
	return "", errors.New("test token encryption failure")
}

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

	manualInvitation, err := service.CreateInvitation(ctx, session.Principal, membership, "MANUAL@example.test", "Manual Member", nil, nil, nil)
	if err != nil {
		t.Fatalf("CreateInvitation with email delivery: %v", err)
	}
	if manualInvitation.Email != "manual@example.test" || manualInvitation.Token == "" || manualInvitation.EmailDeliveryStatus != EmailDeliveryPending {
		t.Fatalf("manual invitation = %#v", manualInvitation)
	}
	if _, err := service.CreateInvitation(ctx, session.Principal, membership, "manual@example.test", "Duplicate Manual", nil, nil, nil); !errors.Is(err, ErrInvitationEmailExists) {
		t.Fatalf("duplicate manual invitation error = %v, want active invitation conflict", err)
	}
	_, err = db.ExecContext(ctx, `INSERT INTO invitations(
		id,group_id,email,display_name,token_hash,roles_json,expires_at,created_by,created_at
	) VALUES(?,?,?,?,?,'[]',?,?,?)`,
		"inv_database_duplicate", membership.GroupID, "MANUAL@example.test", "Concurrent Duplicate", platform.HashSecret("database-duplicate-token"),
		platform.Timestamp(time.Now().Add(7*24*time.Hour)), session.Principal.UserID, platform.Timestamp(time.Now()))
	if err == nil || !strings.Contains(err.Error(), activeInvitationEmailConstraint) {
		t.Fatalf("database duplicate error = %v, want active invitation constraint", err)
	}
	crossPathResult, err := service.ImportInvitations(ctx, session.Principal, membership, "import-key-cross-path", []InvitationImportCandidate{
		{Row: 2, Email: "manual@example.test", DisplayName: "Manual Again"},
		{Row: 3, Email: "new@example.test", DisplayName: "CSV Again"},
	})
	if err != nil {
		t.Fatalf("cross-path ImportInvitations: %v", err)
	}
	if crossPathResult.Summary != (InvitationImportSummary{TotalRows: 2, Skipped: 2}) {
		t.Fatalf("cross-path summary = %#v", crossPathResult.Summary)
	}
	for _, row := range crossPathResult.Rows {
		if row.InvitationStatus != InvitationImportSkippedInvitation || row.EmailDeliveryStatus != EmailDeliveryPending {
			t.Fatalf("cross-path row = %#v", row)
		}
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM invitation_email_outbox`).Scan(&jobs); err != nil || jobs != 2 {
		t.Fatalf("cross-path outbox jobs = %d err=%v, want 2", jobs, err)
	}

	linkOnlyService := Service{DB: db}
	linkOnlyInvitation, err := linkOnlyService.CreateInvitation(ctx, session.Principal, membership, "link-only@example.test", "Link Only", nil, nil, nil)
	if err != nil {
		t.Fatalf("CreateInvitation without email delivery: %v", err)
	}
	if linkOnlyInvitation.Token == "" || linkOnlyInvitation.EmailDeliveryStatus != EmailDeliveryNotRequested {
		t.Fatalf("link-only invitation = %#v", linkOnlyInvitation)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM invitation_email_outbox`).Scan(&jobs); err != nil || jobs != 2 {
		t.Fatalf("link-only outbox jobs = %d err=%v, want 2", jobs, err)
	}

	resendInvitation, err := service.CreateInvitation(ctx, session.Principal, membership, "resend@example.test", "Resend Member", nil, nil, nil)
	if err != nil {
		t.Fatalf("create resend invitation: %v", err)
	}
	oldToken := resendInvitation.Token
	if _, err := db.ExecContext(ctx, `UPDATE invitation_email_outbox SET
		status='SENT',token_ciphertext=NULL,next_attempt_at=NULL,sent_at=?,last_error_code=NULL,updated_at=?
		WHERE invitation_id=?`, platform.Timestamp(time.Now()), platform.Timestamp(time.Now()), resendInvitation.ID); err != nil {
		t.Fatalf("mark resend invitation sent: %v", err)
	}
	resent, err := service.ResendInvitationEmail(ctx, session.Principal, membership, "resend-key-one", resendInvitation.ID)
	if err != nil {
		t.Fatalf("ResendInvitationEmail: %v", err)
	}
	if resent.Token == "" || resent.Token == oldToken || resent.EmailDeliveryStatus != EmailDeliveryPending || resent.ExpiresAt == "" {
		t.Fatalf("resend result = %#v", resent)
	}
	if _, err := authService.PreviewInvitation(ctx, oldToken); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("old token preview error = %v, want not found", err)
	}
	if _, err := authService.PreviewInvitation(ctx, resent.Token); err != nil {
		t.Fatalf("new token preview: %v", err)
	}
	var resendJobs int
	var resendStatus string
	if err := db.QueryRowContext(ctx, `SELECT count(*),max(status) FROM invitation_email_outbox WHERE invitation_id=?`, resendInvitation.ID).Scan(&resendJobs, &resendStatus); err != nil || resendJobs != 1 || resendStatus != "PENDING" {
		t.Fatalf("resend outbox jobs=%d status=%q err=%v", resendJobs, resendStatus, err)
	}
	replayedResend, err := service.ResendInvitationEmail(ctx, session.Principal, membership, "resend-key-one", resendInvitation.ID)
	if err != nil || replayedResend.Token != "" || replayedResend.ExpiresAt != resent.ExpiresAt {
		t.Fatalf("replayed resend = %#v err=%v", replayedResend, err)
	}
	if _, err := service.ResendInvitationEmail(ctx, session.Principal, membership, "resend-key-blocked", resendInvitation.ID); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("in-progress resend error = %v, want conflict", err)
	}

	failedResendInvitation, err := service.CreateInvitation(ctx, session.Principal, membership, "resend-failure@example.test", "Resend Failure", nil, nil, nil)
	if err != nil {
		t.Fatalf("create failed resend invitation: %v", err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE invitation_email_outbox SET
		status='SENT',token_ciphertext=NULL,next_attempt_at=NULL,sent_at=?,last_error_code=NULL,updated_at=?
		WHERE invitation_id=?`, platform.Timestamp(time.Now()), platform.Timestamp(time.Now()), failedResendInvitation.ID); err != nil {
		t.Fatalf("mark failed resend invitation sent: %v", err)
	}
	var tokenHashBefore string
	if err := db.QueryRowContext(ctx, `SELECT token_hash FROM invitations WHERE id=?`, failedResendInvitation.ID).Scan(&tokenHashBefore); err != nil {
		t.Fatalf("read token hash before failed resend: %v", err)
	}
	failingService := Service{DB: db, TokenSealer: failingTokenSealer{}}
	if _, err := failingService.ResendInvitationEmail(ctx, session.Principal, membership, "resend-key-failure", failedResendInvitation.ID); err == nil {
		t.Fatal("failed token encryption unexpectedly allowed resend")
	}
	var tokenHashAfter, statusAfter string
	if err := db.QueryRowContext(ctx, `SELECT i.token_hash,o.status FROM invitations i JOIN invitation_email_outbox o ON o.invitation_id=i.id WHERE i.id=?`, failedResendInvitation.ID).Scan(&tokenHashAfter, &statusAfter); err != nil {
		t.Fatalf("read failed resend state: %v", err)
	}
	if tokenHashAfter != tokenHashBefore || statusAfter != "SENT" {
		t.Fatalf("failed resend changed token/status: before=%q after=%q status=%q", tokenHashBefore, tokenHashAfter, statusAfter)
	}

	expiredDuplicate, err := service.CreateInvitation(ctx, session.Principal, membership, "resend-duplicate@example.test", "Expired Duplicate", nil, nil, nil)
	if err != nil {
		t.Fatalf("create expired duplicate invitation: %v", err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE invitations SET expires_at='2000-01-01T00:00:00Z' WHERE id=?`, expiredDuplicate.ID); err != nil {
		t.Fatalf("expire duplicate invitation: %v", err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE invitation_email_outbox SET status='SENT',token_ciphertext=NULL,next_attempt_at=NULL,sent_at=?,updated_at=? WHERE invitation_id=?`, platform.Timestamp(time.Now()), platform.Timestamp(time.Now()), expiredDuplicate.ID); err != nil {
		t.Fatalf("mark expired duplicate sent: %v", err)
	}
	if _, err := service.CreateInvitation(ctx, session.Principal, membership, "resend-duplicate@example.test", "Current Duplicate", nil, nil, nil); err != nil {
		t.Fatalf("create current duplicate invitation: %v", err)
	}
	if _, err := service.ResendInvitationEmail(ctx, session.Principal, membership, "resend-key-duplicate", expiredDuplicate.ID); !errors.Is(err, ErrInvitationEmailExists) {
		t.Fatalf("duplicate resend error = %v, want active invitation conflict", err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE invitations SET expires_at=? WHERE id=?`, platform.Timestamp(time.Now().Add(7*24*time.Hour)), expiredDuplicate.ID); err == nil || !strings.Contains(err.Error(), activeInvitationEmailConstraint) {
		t.Fatalf("database duplicate update error = %v, want active invitation constraint", err)
	}

	revokedInvitation, err := service.CreateInvitation(ctx, session.Principal, membership, "revoked@example.test", "Revoked Member", nil, nil, nil)
	if err != nil {
		t.Fatalf("create revocation invitation: %v", err)
	}
	var revocationTokenHashBefore string
	if err := db.QueryRowContext(ctx, `SELECT token_hash FROM invitations WHERE id=?`, revokedInvitation.ID).Scan(&revocationTokenHashBefore); err != nil {
		t.Fatalf("read token before revocation: %v", err)
	}
	if err := service.RevokeInvitation(ctx, session.Principal, membership, revokedInvitation.ID, "administrator cancelled invitation"); err != nil {
		t.Fatalf("revoke invitation: %v", err)
	}
	if _, err := authService.PreviewInvitation(ctx, revokedInvitation.Token); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("revoked token preview error = %v, want not found", err)
	}
	var revocationTokenHashAfter, revokedAt, revokedDeliveryStatus string
	if err := db.QueryRowContext(ctx, `SELECT i.token_hash,i.revoked_at,o.status FROM invitations i
		JOIN invitation_email_outbox o ON o.invitation_id=i.id WHERE i.id=?`, revokedInvitation.ID).
		Scan(&revocationTokenHashAfter, &revokedAt, &revokedDeliveryStatus); err != nil {
		t.Fatalf("read revoked invitation state: %v", err)
	}
	if revocationTokenHashAfter == revocationTokenHashBefore || revokedAt == "" || revokedDeliveryStatus != "CANCELLED" {
		t.Fatalf("revoked invitation token/status before=%q after=%q revokedAt=%q delivery=%q", revocationTokenHashBefore, revocationTokenHashAfter, revokedAt, revokedDeliveryStatus)
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
	_, err = service.ResendInvitationEmail(context.Background(), domain.Principal{UserID: "usr_test"}, membership, "resend-key-two", "inv_test")
	if !errors.Is(err, domain.ErrServiceUnavailable) {
		t.Fatalf("ResendInvitationEmail error = %v, want unavailable", err)
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
