package system_test

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/DasLukas/TeamTaler/internal/auth"
	"github.com/DasLukas/TeamTaler/internal/config"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/groups"
	"github.com/DasLukas/TeamTaler/internal/media"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
	systemadmin "github.com/DasLukas/TeamTaler/internal/system"
)

func TestSystemGroupLifecycleAndPurge(t *testing.T) {
	ctx := context.Background()
	directory := t.TempDir()
	database, err := storage.Open(ctx, filepath.Join(directory, "teamtaler.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer database.Close()

	password := "correct-horse-battery-staple"
	authentication := auth.Service{DB: database, SessionLifetime: 24 * time.Hour}
	if err := authentication.Bootstrap(ctx, "system@example.test", "System", password, "Bootstrap", "EUR"); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	administrator, err := authentication.Login(ctx, "system@example.test", password)
	if err != nil {
		t.Fatalf("login: %v", err)
	}

	memberPassword, err := auth.HashPassword("another-correct-password")
	if err != nil {
		t.Fatalf("hash member password: %v", err)
	}
	memberID, _ := platform.NewID("usr")
	now := platform.Timestamp(platform.Now())
	if _, err := database.ExecContext(ctx, `INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,?)`, memberID, "member@example.test", "Member", memberPassword, now, now); err != nil {
		t.Fatalf("insert member account: %v", err)
	}

	service, err := systemadmin.NewService(database, systemadmin.Defaults{
		InstanceName: "TeamTaler", DefaultCurrency: "EUR",
		MediaUploadMaxBytes: config.DefaultMediaUploadBytes, PublicJoinEnabled: true,
		MaxRequestBytes: 6 << 20,
	}, nil)
	if err != nil {
		t.Fatalf("new system service: %v", err)
	}
	created, err := service.CreateGroup(ctx, administrator.Principal.UserID, systemadmin.CreateGroupInput{
		Name: "Managed", Currency: "EUR", InitialAdministratorEmail: "member@example.test",
	}, nil)
	if err != nil {
		t.Fatalf("create managed group: %v", err)
	}
	if created.Status != systemadmin.GroupStatusActive {
		t.Fatalf("created status = %q", created.Status)
	}
	var actorMemberships int
	if err := database.QueryRowContext(ctx, `SELECT count(*) FROM memberships WHERE group_id=? AND user_id=?`, created.ID, administrator.Principal.UserID).Scan(&actorMemberships); err != nil {
		t.Fatalf("count actor memberships: %v", err)
	}
	if actorMemberships != 0 {
		t.Fatalf("system administrator unexpectedly became a group member")
	}
	var initialAdministratorAssignments int
	if err := database.QueryRowContext(ctx, `SELECT count(*) FROM membership_role_assignments assignment
		JOIN memberships membership ON membership.group_id=assignment.group_id AND membership.id=assignment.membership_id
		WHERE assignment.group_id=? AND membership.user_id=?`, created.ID, memberID).Scan(&initialAdministratorAssignments); err != nil {
		t.Fatalf("count initial administrator assignments: %v", err)
	}
	if initialAdministratorAssignments != 1 {
		t.Fatalf("initial administrator assignments=%d, want protected administrator role only", initialAdministratorAssignments)
	}

	archived, err := service.ArchiveGroup(ctx, administrator.Principal.UserID, created.ID, created.Version)
	if err != nil {
		t.Fatalf("archive group: %v", err)
	}
	listed, err := (groups.Service{DB: database}).List(ctx, memberID)
	if err != nil {
		t.Fatalf("list archived membership groups: %v", err)
	}
	if len(listed) != 0 {
		t.Fatalf("archived group remained in member list: %#v", listed)
	}
	restored, err := service.RestoreGroup(ctx, administrator.Principal.UserID, created.ID, archived.Version)
	if err != nil {
		t.Fatalf("restore group: %v", err)
	}
	archived, err = service.ArchiveGroup(ctx, administrator.Principal.UserID, created.ID, restored.Version)
	if err != nil {
		t.Fatalf("archive restored group: %v", err)
	}
	var bootstrapGroupID string
	if err := database.QueryRowContext(ctx, `SELECT id FROM groups WHERE id!=? ORDER BY id LIMIT 1`, created.ID).Scan(&bootstrapGroupID); err != nil {
		t.Fatalf("load unaffected group: %v", err)
	}
	guardTx, err := database.BeginTx(ctx, nil)
	if err != nil {
		t.Fatalf("begin scoped purge-guard test: %v", err)
	}
	if _, err := guardTx.ExecContext(ctx, `INSERT INTO system_group_purge_context(group_id,actor_user_id,started_at) VALUES(?,?,?)`, created.ID, administrator.Principal.UserID, platform.Timestamp(platform.Now())); err != nil {
		guardTx.Rollback()
		t.Fatalf("mark scoped purge context: %v", err)
	}
	if _, err := guardTx.ExecContext(ctx, `DELETE FROM audit_events WHERE group_id=?`, bootstrapGroupID); err == nil || !strings.Contains(err.Error(), "audit events are immutable") {
		guardTx.Rollback()
		t.Fatalf("unrelated group audit deletion error=%v, want immutable guard", err)
	}
	if _, err := guardTx.ExecContext(ctx, `DELETE FROM audit_events WHERE group_id=?`, created.ID); err != nil {
		guardTx.Rollback()
		t.Fatalf("marked group audit deletion remained guarded: %v", err)
	}
	if err := guardTx.Rollback(); err != nil {
		t.Fatalf("rollback scoped purge-guard test: %v", err)
	}
	stepUpToken, _, err := service.IssueStepUp(ctx, administrator.Principal.UserID, password, auth.VerifyPassword)
	if err != nil {
		t.Fatalf("issue step-up: %v", err)
	}
	impact, err := service.PurgeGroup(ctx, administrator.Principal.UserID, created.ID, systemadmin.PurgeGroupInput{
		ExpectedVersion: archived.Version, StepUpToken: stepUpToken, GroupName: created.Name,
		ConfirmationPhrase: systemadmin.GroupPurgeConfirmationPhrase,
	})
	if err != nil {
		t.Fatalf("purge group: %v", err)
	}
	if impact.GroupID != created.ID || impact.MemberCount != 1 {
		t.Fatalf("purge impact = %#v", impact)
	}
	var remaining int
	if err := database.QueryRowContext(ctx, `SELECT count(*) FROM groups WHERE id=?`, created.ID).Scan(&remaining); err != nil || remaining != 0 {
		t.Fatalf("remaining group count=%d err=%v", remaining, err)
	}
	assertNoForeignKeyViolation(t, ctx, database)
	var receiptCount, retainedGroupEventCount int
	if err := database.QueryRowContext(ctx, `SELECT count(*) FROM system_audit_events WHERE action='system.group.purged' AND resource_id=?`, created.ID).Scan(&receiptCount); err != nil || receiptCount != 1 {
		t.Fatalf("purge receipt count=%d err=%v", receiptCount, err)
	}
	if err := database.QueryRowContext(ctx, `SELECT count(*) FROM system_audit_events WHERE resource_id=?`, created.ID).Scan(&retainedGroupEventCount); err != nil || retainedGroupEventCount != 1 {
		t.Fatalf("retained group system-event count=%d err=%v, want only receipt", retainedGroupEventCount, err)
	}
	var triggerCount int
	if err := database.QueryRowContext(ctx, `SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name='ledger_entries_no_delete'`).Scan(&triggerCount); err != nil || triggerCount != 1 {
		t.Fatalf("restored trigger count=%d err=%v", triggerCount, err)
	}

	localGroup, err := service.CreateGroup(ctx, administrator.Principal.UserID, systemadmin.CreateGroupInput{
		Name: "Local Purge", Currency: "EUR", InitialAdministratorEmail: "member@example.test",
	}, nil)
	if err != nil {
		t.Fatalf("create locally purged group: %v", err)
	}
	localGroup, err = service.ArchiveGroup(ctx, administrator.Principal.UserID, localGroup.ID, localGroup.Version)
	if err != nil {
		t.Fatalf("archive locally purged group: %v", err)
	}
	if _, err := service.PurgeGroupLocally(ctx, administrator.Principal.UserID, localGroup.ID, systemadmin.PurgeGroupInput{
		ExpectedVersion: localGroup.Version, GroupName: "wrong name", ConfirmationPhrase: systemadmin.GroupPurgeConfirmationPhrase,
	}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("local purge with wrong name error=%v, want validation", err)
	}
	if _, err := service.PurgeGroupLocally(ctx, administrator.Principal.UserID, localGroup.ID, systemadmin.PurgeGroupInput{
		ExpectedVersion: localGroup.Version, GroupName: localGroup.Name, ConfirmationPhrase: systemadmin.GroupPurgeConfirmationPhrase,
	}); err != nil {
		var warning *systemadmin.PurgePostCommitWarning
		if !errors.As(err, &warning) {
			t.Fatalf("local purge without web step-up: %v", err)
		}
	}
}

func TestProvisioningGroupActivatesWhenInitialAdministratorAccepts(t *testing.T) {
	ctx := context.Background()
	database, err := storage.Open(ctx, filepath.Join(t.TempDir(), "teamtaler.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer database.Close()
	authentication := auth.Service{DB: database, SessionLifetime: 24 * time.Hour}
	if err := authentication.Bootstrap(ctx, "system@example.test", "System", "correct-horse-battery-staple", "Bootstrap", "EUR"); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	administrator, err := authentication.Login(ctx, "system@example.test", "correct-horse-battery-staple")
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	service, err := systemadmin.NewService(database, systemadmin.Defaults{
		InstanceName: "TeamTaler", DefaultCurrency: "EUR", MediaUploadMaxBytes: config.DefaultMediaUploadBytes,
		PublicJoinEnabled: true, MaxRequestBytes: 6 << 20,
		SMTP: systemadmin.SMTPConfiguration{
			Enabled: true, Host: "smtp.example.test", Port: 587, TLSMode: systemadmin.SMTPTLSModeStartTLS,
			Username: "mailer", Password: "secret", FromAddress: "teamtaler@example.test", FromName: "TeamTaler",
		},
	}, nil)
	if err != nil {
		t.Fatalf("new system service: %v", err)
	}
	sealer := &capturingSealer{}
	created, err := service.CreateGroup(ctx, administrator.Principal.UserID, systemadmin.CreateGroupInput{
		Name: "Provisioned", Currency: "EUR", InitialAdministratorEmail: "new-admin@example.test",
	}, sealer)
	if err != nil {
		t.Fatalf("create provisioning group: %v", err)
	}
	if created.Status != systemadmin.GroupStatusProvisioning || sealer.plaintext == "" {
		t.Fatalf("provisioning result=%#v tokenCaptured=%t", created, sealer.plaintext != "")
	}
	originalToken := sealer.plaintext
	resent, err := service.ResendProvisioningInvitation(ctx, administrator.Principal.UserID, created.ID, created.Version, sealer)
	if err != nil {
		t.Fatalf("resend provisioning invitation: %v", err)
	}
	if resent.Version != created.Version+1 || sealer.plaintext == "" || sealer.plaintext == originalToken {
		t.Fatalf("resent result=%#v tokenReplaced=%t", resent, sealer.plaintext != originalToken)
	}
	var invitationAssignments int
	if err := database.QueryRowContext(ctx, `SELECT count(*) FROM invitation_role_assignments assignment
		JOIN invitations invitation ON invitation.group_id=assignment.group_id AND invitation.id=assignment.invitation_id
		WHERE assignment.group_id=? AND invitation.revoked_at IS NULL`, created.ID).Scan(&invitationAssignments); err != nil {
		t.Fatalf("count provisioning invitation assignments: %v", err)
	}
	if invitationAssignments != 1 {
		t.Fatalf("provisioning invitation assignments=%d, want protected administrator role only", invitationAssignments)
	}
	if _, err := authentication.PreviewInvitation(ctx, originalToken); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("preview replaced invitation error=%v, want not found", err)
	}
	if _, _, err := authentication.AcceptInvitation(ctx, auth.InvitationAcceptance{
		Token: sealer.plaintext, DisplayName: "New Admin", Password: "new-administrator-password",
	}); err != nil {
		t.Fatalf("accept initial administrator invitation: %v", err)
	}
	var status string
	if err := database.QueryRowContext(ctx, `SELECT status FROM groups WHERE id=?`, created.ID).Scan(&status); err != nil {
		t.Fatalf("load activated group: %v", err)
	}
	if status != systemadmin.GroupStatusActive {
		t.Fatalf("activated status=%q", status)
	}
	var administratorAssignments int
	if err := database.QueryRowContext(ctx, `SELECT count(*) FROM membership_role_assignments assignment
		JOIN roles role ON role.group_id=assignment.group_id AND role.id=assignment.role_id
		WHERE assignment.group_id=? AND role.preset_key='GROUP_ADMINISTRATOR'`, created.ID).Scan(&administratorAssignments); err != nil {
		t.Fatalf("count initial administrator assignments: %v", err)
	}
	if administratorAssignments != 1 {
		t.Fatalf("administrator assignments=%d", administratorAssignments)
	}
}

func TestMediaGarbageCollectionRetriesSharedHashesUntilLastReferenceIsRemoved(t *testing.T) {
	ctx := context.Background()
	directory := t.TempDir()
	database, err := storage.Open(ctx, filepath.Join(directory, "teamtaler.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer database.Close()
	authentication := auth.Service{DB: database, SessionLifetime: 24 * time.Hour}
	if err := authentication.Bootstrap(ctx, "system@example.test", "System", "correct-horse-battery-staple", "Bootstrap", "EUR"); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	administrator, err := authentication.Login(ctx, "system@example.test", "correct-horse-battery-staple")
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	service, err := systemadmin.NewService(database, systemadmin.Defaults{
		InstanceName: "TeamTaler", DefaultCurrency: "EUR", MediaUploadMaxBytes: config.DefaultMediaUploadBytes,
		PublicJoinEnabled: true, MaxRequestBytes: 6 << 20,
	}, nil)
	if err != nil {
		t.Fatalf("new system service: %v", err)
	}
	imageKey := strings.Repeat("a", 64) + ".png"
	imageDirectory := filepath.Join(directory, "images")
	if err := os.MkdirAll(imageDirectory, 0o750); err != nil {
		t.Fatalf("create image directory: %v", err)
	}
	imagePath := filepath.Join(imageDirectory, imageKey)
	if err := os.WriteFile(imagePath, []byte("managed-image"), 0o640); err != nil {
		t.Fatalf("write managed image: %v", err)
	}
	now := platform.Timestamp(platform.Now())
	if _, err := database.ExecContext(ctx, `UPDATE users SET avatar_key=? WHERE id=?`, imageKey, administrator.Principal.UserID); err != nil {
		t.Fatalf("reference shared image: %v", err)
	}
	if _, err := database.ExecContext(ctx, `INSERT INTO system_media_delete_jobs(image_key,next_attempt_at,created_at,updated_at) VALUES(?,?,?,?)`, imageKey, now, now, now); err != nil {
		t.Fatalf("queue media deletion: %v", err)
	}
	if completed, err := service.RunMediaGarbageCollection(ctx, directory, 10); err != nil || completed != 0 {
		t.Fatalf("collect referenced image completed=%d err=%v", completed, err)
	}
	var status string
	if err := database.QueryRowContext(ctx, `SELECT status FROM system_media_delete_jobs WHERE image_key=?`, imageKey).Scan(&status); err != nil || status != "PENDING" {
		t.Fatalf("referenced image job status=%q err=%v, want PENDING", status, err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE users SET avatar_key=NULL WHERE id=?`, administrator.Principal.UserID); err != nil {
		t.Fatalf("remove shared image reference: %v", err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE system_media_delete_jobs SET next_attempt_at=? WHERE image_key=?`, platform.Timestamp(platform.Now().Add(-time.Minute)), imageKey); err != nil {
		t.Fatalf("make media deletion due: %v", err)
	}
	releaseImages := media.LockManagedImages()
	type collectionResult struct {
		completed int
		err       error
	}
	collectionDone := make(chan collectionResult, 1)
	go func() {
		completed, err := service.RunMediaGarbageCollection(ctx, directory, 10)
		collectionDone <- collectionResult{completed: completed, err: err}
	}()
	select {
	case result := <-collectionDone:
		releaseImages()
		t.Fatalf("garbage collection bypassed active image lease: %#v", result)
	case <-time.After(50 * time.Millisecond):
	}
	if _, err := database.ExecContext(ctx, `UPDATE users SET avatar_key=? WHERE id=?`, imageKey, administrator.Principal.UserID); err != nil {
		releaseImages()
		t.Fatalf("attach image while lease is held: %v", err)
	}
	releaseImages()
	if result := <-collectionDone; result.err != nil || result.completed != 0 {
		t.Fatalf("collect newly referenced image completed=%d err=%v", result.completed, result.err)
	}
	if _, err := os.Stat(imagePath); err != nil {
		t.Fatalf("newly referenced managed image disappeared: %v", err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE users SET avatar_key=NULL WHERE id=?`, administrator.Principal.UserID); err != nil {
		t.Fatalf("remove final shared image reference: %v", err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE system_media_delete_jobs SET next_attempt_at=? WHERE image_key=?`, platform.Timestamp(platform.Now().Add(-time.Minute)), imageKey); err != nil {
		t.Fatalf("make final media deletion due: %v", err)
	}
	if completed, err := service.RunMediaGarbageCollection(ctx, directory, 10); err != nil || completed != 1 {
		t.Fatalf("collect unreferenced image completed=%d err=%v", completed, err)
	}
	if _, err := os.Stat(imagePath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("managed image still exists or stat failed unexpectedly: %v", err)
	}
}

func TestPendingWALCheckpointRemainsDurableWhileReaderIsBusy(t *testing.T) {
	ctx := context.Background()
	database, err := storage.Open(ctx, filepath.Join(t.TempDir(), "checkpoint.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer database.Close()
	service, err := systemadmin.NewService(database, systemadmin.Defaults{
		InstanceName: "TeamTaler", DefaultCurrency: "EUR", MediaUploadMaxBytes: config.DefaultMediaUploadBytes,
		PublicJoinEnabled: true, MaxRequestBytes: 6 << 20,
	}, nil)
	if err != nil {
		t.Fatalf("new system service: %v", err)
	}
	readerConnection, err := database.Conn(ctx)
	if err != nil {
		t.Fatalf("acquire reader connection: %v", err)
	}
	defer readerConnection.Close()
	reader, err := readerConnection.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		t.Fatalf("begin reader: %v", err)
	}
	var snapshotRevision int64
	if err := reader.QueryRowContext(ctx, `SELECT revision FROM system_settings_state WHERE singleton=1`).Scan(&snapshotRevision); err != nil {
		reader.Rollback()
		t.Fatalf("establish reader snapshot: %v", err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE system_wal_checkpoint_state SET pending=1,updated_at=? WHERE singleton=1`, platform.Timestamp(platform.Now())); err != nil {
		reader.Rollback()
		t.Fatalf("schedule checkpoint: %v", err)
	}
	if err := service.RunPendingWALCheckpoint(ctx); err == nil || !strings.Contains(err.Error(), "busy") {
		reader.Rollback()
		t.Fatalf("checkpoint with retained reader error=%v, want busy", err)
	}
	var pending int
	if err := database.QueryRowContext(ctx, `SELECT pending FROM system_wal_checkpoint_state WHERE singleton=1`).Scan(&pending); err != nil || pending != 1 {
		reader.Rollback()
		t.Fatalf("busy checkpoint pending=%d err=%v, want 1", pending, err)
	}
	if err := reader.Rollback(); err != nil {
		t.Fatalf("release reader: %v", err)
	}
	if err := service.RunPendingWALCheckpoint(ctx); err != nil {
		t.Fatalf("retry checkpoint: %v", err)
	}
	if err := database.QueryRowContext(ctx, `SELECT pending FROM system_wal_checkpoint_state WHERE singleton=1`).Scan(&pending); err != nil || pending != 0 {
		t.Fatalf("completed checkpoint pending=%d err=%v, want 0", pending, err)
	}
}

type capturingSealer struct{ plaintext string }

func (sealer *capturingSealer) Seal(plaintext string) (string, error) {
	sealer.plaintext = plaintext
	return "encrypted-test-token", nil
}

func assertNoForeignKeyViolation(t *testing.T, ctx context.Context, database *sql.DB) {
	t.Helper()
	rows, err := database.QueryContext(ctx, `PRAGMA foreign_key_check`)
	if err != nil {
		t.Fatalf("foreign key check: %v", err)
	}
	defer rows.Close()
	if rows.Next() {
		t.Fatal("foreign key violation remained after purge")
	}
}
