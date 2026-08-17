package system_test

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/DasLukas/TeamTaler/internal/auth"
	"github.com/DasLukas/TeamTaler/internal/authorization"
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
	var initialAdministratorMembershipID string
	if err := database.QueryRowContext(ctx, `SELECT id FROM memberships WHERE group_id=? AND user_id=?`, created.ID, memberID).Scan(&initialAdministratorMembershipID); err != nil {
		t.Fatalf("load initial administrator membership: %v", err)
	}
	if _, err := database.ExecContext(ctx, `INSERT INTO ledger_entries(id,group_id,membership_id,account,amount_minor,description,created_at)
		VALUES(?,?,?,?,?,?,?)`, "ledger-system-purge-impact", created.ID, initialAdministratorMembershipID, "MEMBER_RECEIVABLE", 1234, "Purge impact fixture", now); err != nil {
		t.Fatalf("insert purge impact balance: %v", err)
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
	impact, err := service.PurgeGroup(ctx, administrator.Principal.UserID, created.ID, systemadmin.PurgeGroupInput{
		ExpectedVersion: archived.Version, GroupName: created.Name,
	})
	if err != nil {
		t.Fatalf("purge group: %v", err)
	}
	if impact.GroupID != created.ID || impact.MemberCount != 1 || impact.Currency != "EUR" || impact.OpenBalanceMinor != 1234 {
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
		ExpectedVersion: localGroup.Version, GroupName: "wrong name",
	}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("local purge with wrong name error=%v, want validation", err)
	}
	if _, err := service.PurgeGroupLocally(ctx, administrator.Principal.UserID, localGroup.ID, systemadmin.PurgeGroupInput{
		ExpectedVersion: localGroup.Version, GroupName: localGroup.Name,
	}); err != nil {
		var warning *systemadmin.PurgePostCommitWarning
		if !errors.As(err, &warning) {
			t.Fatalf("local purge: %v", err)
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
	if created.Status != systemadmin.GroupStatusProvisioning || created.InvitationToken == "" || created.InvitationToken != sealer.plaintext || created.InvitationEmailDeliveryStatus != systemadmin.InvitationEmailDeliveryPending || created.InvitationExpiresAt == "" {
		t.Fatalf("provisioning result=%#v tokenCaptured=%t", created, sealer.plaintext != "")
	}
	originalToken := created.InvitationToken
	resent, err := service.ResendProvisioningInvitation(ctx, administrator.Principal.UserID, created.ID, created.Version, sealer)
	if err != nil {
		t.Fatalf("resend provisioning invitation: %v", err)
	}
	if resent.Version != created.Version+1 || resent.InvitationToken == "" || resent.InvitationToken != sealer.plaintext || resent.InvitationToken == originalToken || resent.InvitationEmailDeliveryStatus != systemadmin.InvitationEmailDeliveryPending || resent.InvitationExpiresAt == "" {
		t.Fatalf("resent result=%#v tokenReplaced=%t", resent, resent.InvitationToken != originalToken)
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
		Token: resent.InvitationToken, DisplayName: "New Admin", Password: "new-administrator-password",
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

func TestConcurrentCrossGroupInvitationsConvergeOnOneStableAccount(t *testing.T) {
	ctx := context.Background()
	database, err := storage.Open(ctx, filepath.Join(t.TempDir(), "teamtaler.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer database.Close()

	password := "parallel-invitation-password"
	authentication := auth.Service{DB: database, SessionLifetime: 24 * time.Hour}
	if err := authentication.Bootstrap(ctx, "system@example.test", "System", "correct-horse-battery-staple", "Bootstrap", "EUR"); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	administrator, err := authentication.Login(ctx, "system@example.test", "correct-horse-battery-staple")
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	systemService, err := systemadmin.NewService(database, systemadmin.Defaults{
		InstanceName: "TeamTaler", DefaultCurrency: "EUR", MediaUploadMaxBytes: config.DefaultMediaUploadBytes,
		PublicJoinEnabled: true, MaxRequestBytes: 6 << 20,
	}, nil)
	if err != nil {
		t.Fatalf("new system service: %v", err)
	}
	groupService := groups.Service{DB: database}
	bootstrapGroups, err := groupService.List(ctx, administrator.Principal.UserID)
	if err != nil || len(bootstrapGroups) != 1 {
		t.Fatalf("list bootstrap group: groups=%#v err=%v", bootstrapGroups, err)
	}
	bootstrapGroup := bootstrapGroups[0]
	memberRoleID := authorization.TemplateRoleID(bootstrapGroup.ID, domain.RoleTemplateMember)
	memberInvitation, err := groupService.CreateInvitationWithRoles(ctx, administrator.Principal, bootstrapGroup.Membership, "parallel@example.test", "Parallel User", []string{memberRoleID})
	if err != nil {
		t.Fatalf("create member invitation: %v", err)
	}
	firstAdminGroup, err := systemService.CreateGroup(ctx, administrator.Principal.UserID, systemadmin.CreateGroupInput{
		Name: "Parallel Admin One", Currency: "EUR", InitialAdministratorEmail: "parallel@example.test",
	}, nil)
	if err != nil {
		t.Fatalf("create first provisioning group: %v", err)
	}
	secondAdminGroup, err := systemService.CreateGroup(ctx, administrator.Principal.UserID, systemadmin.CreateGroupInput{
		Name: "Parallel Admin Two", Currency: "EUR", InitialAdministratorEmail: "PARALLEL@example.test",
	}, nil)
	if err != nil {
		t.Fatalf("create second provisioning group: %v", err)
	}
	for name, token := range map[string]string{
		"member":               memberInvitation.Token,
		"first administrator":  firstAdminGroup.InvitationToken,
		"second administrator": secondAdminGroup.InvitationToken,
	} {
		preview, err := authentication.PreviewInvitation(ctx, token)
		if err != nil || preview.AccountState != auth.InvitationAccountNew {
			t.Fatalf("%s preview=%#v err=%v, want NEW", name, preview, err)
		}
	}

	type acceptanceResult struct {
		token string
		err   error
	}
	results := make([]acceptanceResult, 2)
	tokens := []string{memberInvitation.Token, firstAdminGroup.InvitationToken}
	start := make(chan struct{})
	var wait sync.WaitGroup
	for index, token := range tokens {
		wait.Add(1)
		go func(index int, token string) {
			defer wait.Done()
			<-start
			_, _, acceptErr := authentication.AcceptInvitation(ctx, auth.InvitationAcceptance{
				Token: token, DisplayName: "Parallel User", Password: password, ExpectedAccountState: auth.InvitationAccountNew,
			})
			results[index] = acceptanceResult{token: token, err: acceptErr}
		}(index, token)
	}
	close(start)
	wait.Wait()

	successes := 0
	stateChanges := 0
	staleToken := ""
	for _, result := range results {
		switch {
		case result.err == nil:
			successes++
		case errors.Is(result.err, auth.ErrInvitationAccountStateChanged):
			stateChanges++
			staleToken = result.token
		default:
			t.Fatalf("parallel acceptance returned unexpected error: %v", result.err)
		}
	}
	if successes != 1 || stateChanges != 1 {
		t.Fatalf("parallel results successes/stateChanges=%d/%d, want 1/1", successes, stateChanges)
	}
	stalePreview, err := authentication.PreviewInvitation(ctx, staleToken)
	if err != nil || stalePreview.AccountState != auth.InvitationAccountExisting {
		t.Fatalf("stale invitation preview=%#v err=%v, want EXISTING", stalePreview, err)
	}
	if _, _, err := authentication.AcceptInvitation(ctx, auth.InvitationAcceptance{
		Token: staleToken, Password: password, ExpectedAccountState: auth.InvitationAccountExisting,
	}); err != nil {
		t.Fatalf("accept refreshed stale invitation: %v", err)
	}
	if _, _, err := authentication.AcceptInvitation(ctx, auth.InvitationAcceptance{
		Token: secondAdminGroup.InvitationToken, Password: password, ExpectedAccountState: auth.InvitationAccountExisting,
	}); err != nil {
		t.Fatalf("accept second administrator invitation: %v", err)
	}

	var userID string
	var accountCount, membershipCount, boundInvitationCount int
	if err := database.QueryRowContext(ctx, `SELECT count(*),min(id) FROM users WHERE email='parallel@example.test' COLLATE NOCASE`).Scan(&accountCount, &userID); err != nil {
		t.Fatalf("load converged account: %v", err)
	}
	if err := database.QueryRowContext(ctx, `SELECT count(*) FROM memberships WHERE user_id=? AND group_id IN (?,?,?)`, userID, bootstrapGroup.ID, firstAdminGroup.ID, secondAdminGroup.ID).Scan(&membershipCount); err != nil {
		t.Fatalf("count independent memberships: %v", err)
	}
	if err := database.QueryRowContext(ctx, `SELECT count(*) FROM invitations WHERE email='parallel@example.test' COLLATE NOCASE AND target_user_id=?`, userID).Scan(&boundInvitationCount); err != nil {
		t.Fatalf("count stable invitation bindings: %v", err)
	}
	if accountCount != 1 || membershipCount != 3 || boundInvitationCount != 3 {
		t.Fatalf("accounts/memberships/bindings=%d/%d/%d, want 1/3/3", accountCount, membershipCount, boundInvitationCount)
	}

	roleChecks := []struct {
		groupID string
		roleID  string
	}{
		{groupID: bootstrapGroup.ID, roleID: memberRoleID},
		{groupID: firstAdminGroup.ID, roleID: authorization.PresetRoleID(firstAdminGroup.ID, domain.RolePresetGroupAdministrator)},
		{groupID: secondAdminGroup.ID, roleID: authorization.PresetRoleID(secondAdminGroup.ID, domain.RolePresetGroupAdministrator)},
	}
	for _, check := range roleChecks {
		var assignmentCount, expectedCount int
		if err := database.QueryRowContext(ctx, `SELECT count(*),sum(CASE WHEN assignment.role_id=? THEN 1 ELSE 0 END)
			FROM membership_role_assignments assignment
			JOIN memberships membership ON membership.group_id=assignment.group_id AND membership.id=assignment.membership_id
			WHERE assignment.group_id=? AND membership.user_id=?`, check.roleID, check.groupID, userID).Scan(&assignmentCount, &expectedCount); err != nil {
			t.Fatalf("read role assignments for %s: %v", check.groupID, err)
		}
		if assignmentCount != 1 || expectedCount != 1 {
			t.Fatalf("group %s role assignments=%d/%d, want only %s", check.groupID, assignmentCount, expectedCount, check.roleID)
		}
	}

	bindingGroup, err := groupService.Create(ctx, administrator.Principal, "Stable Binding", "EUR")
	if err != nil {
		t.Fatalf("create stable-binding group: %v", err)
	}
	boundInvitation, err := groupService.CreateInvitationWithRoles(ctx, administrator.Principal, bindingGroup.Membership, "parallel@example.test", "Parallel User", []string{
		authorization.TemplateRoleID(bindingGroup.ID, domain.RoleTemplateMember),
	})
	if err != nil {
		t.Fatalf("create stable-bound invitation: %v", err)
	}
	var storedTargetUserID string
	if err := database.QueryRowContext(ctx, `SELECT target_user_id FROM invitations WHERE id=?`, boundInvitation.ID).Scan(&storedTargetUserID); err != nil || storedTargetUserID != userID {
		t.Fatalf("stored stable target=%q err=%v, want %s", storedTargetUserID, err, userID)
	}
	if _, err := database.ExecContext(ctx, `UPDATE users SET email='renamed@example.test',updated_at=? WHERE id=?`, platform.Timestamp(platform.Now()), userID); err != nil {
		t.Fatalf("rename bound account email: %v", err)
	}
	replacementPasswordHash, err := auth.HashPassword("replacement-account-password")
	if err != nil {
		t.Fatalf("hash replacement password: %v", err)
	}
	if _, err := database.ExecContext(ctx, `INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('replacement-user','parallel@example.test','Replacement',?,?,?)`, replacementPasswordHash, platform.Timestamp(platform.Now()), platform.Timestamp(platform.Now())); err != nil {
		t.Fatalf("insert replacement mailbox account: %v", err)
	}
	preview, err := authentication.PreviewInvitation(ctx, boundInvitation.Token)
	if err != nil || preview.AccountState != auth.InvitationAccountExisting || preview.DisplayName != "Parallel User" {
		t.Fatalf("stable-bound preview=%#v err=%v", preview, err)
	}
	_, boundMembership, err := authentication.AcceptInvitation(ctx, auth.InvitationAcceptance{
		Token: boundInvitation.Token, Password: password, ExpectedAccountState: auth.InvitationAccountExisting,
	})
	if err != nil {
		t.Fatalf("accept invitation after mailbox reuse: %v", err)
	}
	if boundMembership.UserID != userID {
		t.Fatalf("bound invitation joined user=%s, want original %s", boundMembership.UserID, userID)
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
