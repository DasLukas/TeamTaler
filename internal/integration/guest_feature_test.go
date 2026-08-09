package integration_test

import (
	"database/sql"
	"errors"
	"testing"

	"github.com/DasLukas/TeamTaler/internal/auth"
	"github.com/DasLukas/TeamTaler/internal/authorization"
	"github.com/DasLukas/TeamTaler/internal/bookings"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/finance"
	"github.com/DasLukas/TeamTaler/internal/groups"
	"github.com/DasLukas/TeamTaler/internal/notifications"
	"github.com/DasLukas/TeamTaler/internal/periods"
)

func TestManagedGuestBatchCreationIsAtomicIdempotentAndSurvivesDisable(t *testing.T) {
	f := newFixture(t)
	settings, err := f.groups.UpdateGuestSettings(f.ctx, f.admin, f.membership, groups.GuestSettingsUpdate{GuestsEnabled: true})
	if err != nil || !settings.GuestsEnabled || settings.GuestRoleID != nil {
		t.Fatalf("enable role-less managed guests: settings=%#v err=%v", settings, err)
	}
	_, product := f.catalogItem("Guest items", 275)
	command := bookings.BatchCreateInput{
		ProductID:                product.ID,
		ProductVersion:           product.Version,
		ExpectedPeriodID:         f.openPeriodID(),
		Quantity:                 2,
		ManagedGuestDisplayNames: []string{" Walk-In Guest "},
		Reason:                   "Guest purchase",
	}
	created, err := f.bookings.CreateBatch(f.ctx, f.admin, f.membership, "guest-batch-create-1", command)
	if err != nil || len(created) != 1 || created[0].TargetDisplayName != "Walk-In Guest" {
		t.Fatalf("create managed guest booking: bookings=%#v err=%v", created, err)
	}
	replayed, err := f.bookings.CreateBatch(f.ctx, f.admin, f.membership, "guest-batch-create-1", command)
	if err != nil || len(replayed) != 1 || replayed[0].ID != created[0].ID {
		t.Fatalf("replay managed guest booking: bookings=%#v err=%v", replayed, err)
	}

	var guestMembershipID, guestUserID string
	var guestEmail, guestPassword sql.NullString
	var guestRoles, guestBookings int
	if err := f.db.QueryRowContext(f.ctx, `SELECT m.id,m.user_id,u.email,u.password_hash,
		(SELECT count(*) FROM membership_role_assignments a WHERE a.group_id=m.group_id AND a.membership_id=m.id),
		(SELECT count(*) FROM bookings b WHERE b.group_id=m.group_id AND b.target_membership_id=m.id)
		FROM memberships m JOIN users u ON u.id=m.user_id
		WHERE m.group_id=? AND m.managed_guest_name_key='walk-in guest'`, f.membership.GroupID).
		Scan(&guestMembershipID, &guestUserID, &guestEmail, &guestPassword, &guestRoles, &guestBookings); err != nil {
		t.Fatalf("load managed guest: %v", err)
	}
	if guestEmail.Valid || guestPassword.Valid || guestRoles != 0 || guestBookings != 1 {
		t.Fatalf("managed guest credentials/roles/bookings = email:%#v password:%#v roles:%d bookings:%d", guestEmail, guestPassword, guestRoles, guestBookings)
	}
	var balance int64
	if err := f.db.QueryRowContext(f.ctx, `SELECT coalesce(sum(amount_minor),0) FROM ledger_entries WHERE group_id=? AND membership_id=? AND account='MEMBER_RECEIVABLE'`, f.membership.GroupID, guestMembershipID).Scan(&balance); err != nil || balance != 550 {
		t.Fatalf("managed guest balance=%d err=%v, want 550", balance, err)
	}

	conflicting := command
	conflicting.ManagedGuestDisplayNames = []string{"Fresh Guest", "walk-in GUEST"}
	if _, err := f.bookings.CreateBatch(f.ctx, f.admin, f.membership, "guest-batch-create-2", conflicting); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("duplicate guest name error=%v, want conflict", err)
	}
	var freshGuests int
	if err := f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM memberships WHERE group_id=? AND managed_guest_name_key='fresh guest'`, f.membership.GroupID).Scan(&freshGuests); err != nil || freshGuests != 0 {
		t.Fatalf("rolled-back guest count=%d err=%v, want zero", freshGuests, err)
	}
	secondGroup, err := f.groups.Create(f.ctx, f.admin, "Managed Guest Tenant", "EUR")
	if err != nil {
		t.Fatalf("create second guest tenant: %v", err)
	}
	crossTenant := command
	crossTenant.TargetMembershipIDs = []string{secondGroup.Membership.ID}
	crossTenant.ManagedGuestDisplayNames = []string{"Cross-Tenant Rollback Guest"}
	if _, err := f.bookings.CreateBatch(f.ctx, f.admin, f.membership, "guest-cross-tenant", crossTenant); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("cross-tenant target error=%v, want not found", err)
	}
	var crossTenantGuests int
	if err := f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM memberships WHERE group_id=? AND managed_guest_name_key='cross-tenant rollback guest'`, f.membership.GroupID).Scan(&crossTenantGuests); err != nil || crossTenantGuests != 0 {
		t.Fatalf("cross-tenant rollback guest count=%d err=%v, want zero", crossTenantGuests, err)
	}

	renamed, err := f.groups.RenameManagedGuest(f.ctx, f.admin, f.membership, guestMembershipID, "Renamed Guest")
	if err != nil || renamed.ID != guestMembershipID || renamed.DisplayName != "Renamed Guest" || renamed.RoleAssignmentsVersion < 1 {
		t.Fatalf("rename managed guest: membership=%#v err=%v", renamed, err)
	}
	settings, err = f.groups.UpdateGuestSettings(f.ctx, f.admin, f.membership, groups.GuestSettingsUpdate{GuestsEnabled: false})
	if err != nil || settings.GuestsEnabled {
		t.Fatalf("disable managed guests: settings=%#v err=%v", settings, err)
	}
	context, err := f.bookings.Context(f.ctx, f.membership)
	if err != nil {
		t.Fatalf("booking context after disable: %v", err)
	}
	foundExistingGuest := false
	for _, target := range context.Targets {
		if target.MembershipID == guestMembershipID && target.IsGuest && target.DisplayName == "Renamed Guest" {
			foundExistingGuest = true
		}
	}
	if !foundExistingGuest || context.CanCreateManagedGuests {
		t.Fatalf("disabled booking context=%#v", context)
	}
	disabledCommand := command
	disabledCommand.ManagedGuestDisplayNames = []string{"Disabled Guest"}
	if _, err := f.bookings.CreateBatch(f.ctx, f.admin, f.membership, "guest-batch-create-3", disabledCommand); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("feature-off guest creation error=%v, want conflict", err)
	}

	if err := f.groups.ArchiveMember(f.ctx, f.admin, f.membership, guestMembershipID, false); err != nil {
		t.Fatalf("archive managed guest: %v", err)
	}
	var archivedUserID string
	if err := f.db.QueryRowContext(f.ctx, `SELECT user_id FROM memberships WHERE id=? AND status='ARCHIVED'`, guestMembershipID).Scan(&archivedUserID); err != nil || archivedUserID != guestUserID {
		t.Fatalf("archived identity=%q err=%v, want %q", archivedUserID, err, guestUserID)
	}
}

func TestManagedGuestClaimPreservesMembershipAndEnforcesGuestPrivacy(t *testing.T) {
	f := newFixture(t)
	settings, err := f.groups.UpdateGuestSettings(f.ctx, f.admin, f.membership, groups.GuestSettingsUpdate{GuestsEnabled: true, CreateGuestRole: true})
	if err != nil || settings.GuestRoleID == nil || settings.DefaultRoleID == nil || *settings.GuestRoleID != *settings.DefaultRoleID {
		t.Fatalf("configure guest role: settings=%#v err=%v", settings, err)
	}
	guestRoleID := *settings.GuestRoleID
	_, product := f.catalogItem("Claim items", 125)
	archivedClaimBookings, err := f.bookings.CreateBatch(f.ctx, f.admin, f.membership, "guest-archived-claim-booking", bookings.BatchCreateInput{
		ProductID:                product.ID,
		ProductVersion:           product.Version,
		ExpectedPeriodID:         f.openPeriodID(),
		Quantity:                 1,
		ManagedGuestDisplayNames: []string{"Archived Claim Guest"},
		Reason:                   "Guest purchase before archival",
	})
	if err != nil || len(archivedClaimBookings) != 1 {
		t.Fatalf("create guest for archived claim: bookings=%#v err=%v", archivedClaimBookings, err)
	}
	archivedClaim, err := f.groups.CreateClaimInvitation(f.ctx, f.admin, f.membership, archivedClaimBookings[0].TargetMembershipID, "archived-claim@example.test")
	if err != nil {
		t.Fatalf("create claim that will be revoked by archival: %v", err)
	}
	if err := f.groups.ArchiveMember(f.ctx, f.admin, f.membership, archivedClaimBookings[0].TargetMembershipID, false); err != nil {
		t.Fatalf("archive guest with open claim: %v", err)
	}
	if _, _, err := f.auth.AcceptInvitation(f.ctx, auth.InvitationAcceptance{Token: archivedClaim.Token, Password: testPassword}); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("archived guest claim error=%v, want not found", err)
	}
	var revokedClaimCount int
	if err := f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM invitations WHERE id=? AND revoked_at IS NOT NULL`, archivedClaim.ID).Scan(&revokedClaimCount); err != nil || revokedClaimCount != 1 {
		t.Fatalf("archived revoked claim count=%d err=%v, want one", revokedClaimCount, err)
	}

	created, err := f.bookings.CreateBatch(f.ctx, f.admin, f.membership, "guest-claim-booking", bookings.BatchCreateInput{
		ProductID:                product.ID,
		ProductVersion:           product.Version,
		ExpectedPeriodID:         f.openPeriodID(),
		Quantity:                 1,
		ManagedGuestDisplayNames: []string{"Claimable Guest"},
		Reason:                   "Claimable guest purchase",
	})
	if err != nil || len(created) != 1 {
		t.Fatalf("create claimable guest: bookings=%#v err=%v", created, err)
	}
	guestMembershipID := created[0].TargetMembershipID
	var originalUserID string
	if err := f.db.QueryRowContext(f.ctx, `SELECT user_id FROM memberships WHERE id=?`, guestMembershipID).Scan(&originalUserID); err != nil {
		t.Fatalf("load original guest user: %v", err)
	}
	invitation, err := f.groups.CreateClaimInvitation(f.ctx, f.admin, f.membership, guestMembershipID, "claimed@example.test")
	if err != nil || invitation.Token == "" {
		t.Fatalf("create claim invitation: invitation=%#v err=%v", invitation, err)
	}
	legacyUpdatedInvitation, err := f.groups.UpdateInvitation(f.ctx, f.admin, f.membership, invitation.ID, "Claimable Guest", nil, nil, nil, invitation.RoleAssignmentsVersion)
	if err != nil || legacyUpdatedInvitation.TargetMembershipID == nil || *legacyUpdatedInvitation.TargetMembershipID != guestMembershipID {
		t.Fatalf("legacy-update claim target: invitation=%#v err=%v", legacyUpdatedInvitation, err)
	}
	dynamicUpdatedInvitation, err := f.groups.UpdateInvitationWithRoles(f.ctx, f.admin, f.membership, invitation.ID, "Claimable Guest", []string{guestRoleID}, legacyUpdatedInvitation.RoleAssignmentsVersion)
	if err != nil || dynamicUpdatedInvitation.TargetMembershipID == nil || *dynamicUpdatedInvitation.TargetMembershipID != guestMembershipID {
		t.Fatalf("dynamic-update claim target: invitation=%#v err=%v", dynamicUpdatedInvitation, err)
	}
	var persistedClaimTarget string
	if err := f.db.QueryRowContext(f.ctx, `SELECT target_membership_id FROM invitations WHERE id=? AND group_id=?`, invitation.ID, f.membership.GroupID).Scan(&persistedClaimTarget); err != nil || persistedClaimTarget != guestMembershipID {
		t.Fatalf("persisted claim target=%q err=%v, want %q", persistedClaimTarget, err, guestMembershipID)
	}
	session, claimed, err := f.auth.AcceptInvitation(f.ctx, auth.InvitationAcceptance{Token: invitation.Token, Password: testPassword})
	if err != nil {
		t.Fatalf("accept claim invitation: %v", err)
	}
	if claimed.ID != guestMembershipID || claimed.UserID != originalUserID || session.Principal.UserID != originalUserID {
		t.Fatalf("claim changed stable identity: session=%#v membership=%#v originalUserID=%q", session, claimed, originalUserID)
	}
	if claimed.Email == nil || *claimed.Email != "claimed@example.test" || !claimed.IsGuest {
		t.Fatalf("claimed guest identity=%#v", claimed)
	}
	if len(claimed.RoleIDs) != 1 || claimed.RoleIDs[0] != guestRoleID {
		t.Fatalf("claimed guest roles=%v, want exclusive %q", claimed.RoleIDs, guestRoleID)
	}
	if _, err := f.groups.ListMembers(f.ctx, claimed); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("guest directory error=%v, want forbidden", err)
	}
	account, err := f.finance.Account(f.ctx, claimed, claimed.ID)
	if err != nil || len(account.GroupCategoryStats) != 0 || account.BalanceMinor != 125 {
		t.Fatalf("guest account=%#v err=%v", account, err)
	}
	bookingContext, err := f.bookings.Context(f.ctx, claimed)
	if err != nil || bookingContext.CanCreateManagedGuests || len(bookingContext.Targets) != 1 || bookingContext.Targets[0].MembershipID != claimed.ID {
		t.Fatalf("claimed guest booking context=%#v err=%v", bookingContext, err)
	}
	if _, err := f.auth.Login(f.ctx, "claimed@example.test", testPassword); err != nil {
		t.Fatalf("claimed guest login: %v", err)
	}
	var managedNameKey sql.NullString
	if err := f.db.QueryRowContext(f.ctx, `SELECT managed_guest_name_key FROM memberships WHERE id=?`, claimed.ID).Scan(&managedNameKey); err != nil || managedNameKey.Valid {
		t.Fatalf("claimed managed-name key=%#v err=%v, want NULL", managedNameKey, err)
	}

	memberRoleID := authorization.PresetRoleID(f.membership.GroupID, domain.RolePresetMember)
	if _, err := f.groups.UpdateGuestSettings(f.ctx, f.admin, f.membership, groups.GuestSettingsUpdate{GuestsEnabled: false}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("disable without replacement error=%v, want validation", err)
	}
	disabled, err := f.groups.UpdateGuestSettings(f.ctx, f.admin, f.membership, groups.GuestSettingsUpdate{GuestsEnabled: false, ReplacementDefaultRoleID: &memberRoleID})
	if err != nil || disabled.GuestsEnabled || disabled.GuestRoleID == nil || *disabled.GuestRoleID != guestRoleID || disabled.DefaultRoleID == nil || *disabled.DefaultRoleID != memberRoleID {
		t.Fatalf("disable with retained guest role: settings=%#v err=%v", disabled, err)
	}
}

func TestGroupAdministratorWithoutRoleManagementCanCreateClaimInvitation(t *testing.T) {
	f := newFixture(t)
	settings, err := f.groups.UpdateGuestSettings(f.ctx, f.admin, f.membership, groups.GuestSettingsUpdate{GuestsEnabled: true, CreateGuestRole: true})
	if err != nil || settings.GuestRoleID == nil {
		t.Fatalf("configure guest role: settings=%#v err=%v", settings, err)
	}
	_, product := f.catalogItem("Delegated claim", 100)
	created, err := f.bookings.CreateBatch(f.ctx, f.admin, f.membership, "delegated-claim-guest", bookings.BatchCreateInput{
		ProductID:                product.ID,
		ProductVersion:           product.Version,
		ExpectedPeriodID:         f.openPeriodID(),
		Quantity:                 1,
		ManagedGuestDisplayNames: []string{"Delegated Claim Guest"},
		Reason:                   "Create a managed guest for delegated claim administration",
	})
	if err != nil || len(created) != 1 {
		t.Fatalf("create delegated claim guest: bookings=%#v err=%v", created, err)
	}

	delegatedPrincipal, delegatedAdministrator, _ := f.inviteMember("delegated-claim-admin@example.test", "Delegated Claim Admin", nil)
	delegatedAdministrator = f.assignPermissionRole(delegatedAdministrator, "Delegated claim administration", domain.PermissionGroupAdministration)
	memberRoleID := authorization.PresetRoleID(f.membership.GroupID, domain.RolePresetMember)
	if _, err := f.groups.CreateInvitationWithRoles(f.ctx, delegatedPrincipal, delegatedAdministrator, "ordinary-role-change@example.test", "Ordinary Role Change", []string{memberRoleID}); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("ordinary invitation without role management error=%v, want forbidden", err)
	}

	claim, err := f.groups.CreateClaimInvitation(f.ctx, delegatedPrincipal, delegatedAdministrator, created[0].TargetMembershipID, "delegated-claimed@example.test")
	if err != nil || claim.TargetMembershipID == nil || *claim.TargetMembershipID != created[0].TargetMembershipID || len(claim.RoleIDs) != 1 || claim.RoleIDs[0] != *settings.GuestRoleID {
		t.Fatalf("delegated claim invitation=%#v err=%v", claim, err)
	}
}

func TestConfiguredGuestRoleRemainsEditableProtectedAndReusable(t *testing.T) {
	f := newFixture(t)
	settings, err := f.groups.UpdateGuestSettings(f.ctx, f.admin, f.membership, groups.GuestSettingsUpdate{GuestsEnabled: true, CreateGuestRole: true})
	if err != nil || settings.GuestRoleID == nil {
		t.Fatalf("create configured guest role: settings=%#v err=%v", settings, err)
	}
	guestRoleID := *settings.GuestRoleID
	guestRole, err := f.groups.GetRole(f.ctx, f.membership, guestRoleID)
	if err != nil {
		t.Fatalf("load configured guest role: %v", err)
	}
	customized, err := f.groups.UpdateRole(f.ctx, f.admin, f.membership, guestRoleID, guestRole.Version, groups.RoleCommand{
		Name:        guestRole.Name,
		Description: "Guest access with deliberately configured aggregate statistics.",
		Grants: []domain.PermissionGrant{
			{Permission: domain.PermissionCreateOwnBooking, Scope: domain.PermissionScope{Type: domain.PermissionScopeGroup}},
			{Permission: domain.PermissionViewGroupStatistics, Scope: domain.PermissionScope{Type: domain.PermissionScopeGroup}},
		},
	})
	if err != nil || len(customized.Grants) != 2 {
		t.Fatalf("customize configured guest role: role=%#v err=%v", customized, err)
	}

	memberRoleID := authorization.PresetRoleID(f.membership.GroupID, domain.RolePresetMember)
	if _, err := f.groups.UpdateGuestSettings(f.ctx, f.admin, f.membership, groups.GuestSettingsUpdate{
		GuestsEnabled: false, ReplacementDefaultRoleID: &memberRoleID,
	}); err != nil {
		t.Fatalf("disable customized guest role: %v", err)
	}
	reenabled, err := f.groups.UpdateGuestSettings(f.ctx, f.admin, f.membership, groups.GuestSettingsUpdate{
		GuestsEnabled: true, GuestRoleID: &guestRoleID,
	})
	if err != nil || !reenabled.GuestsEnabled || reenabled.DefaultRoleID == nil || *reenabled.DefaultRoleID != guestRoleID {
		t.Fatalf("reuse customized retained guest role: settings=%#v err=%v", reenabled, err)
	}
	if err := f.groups.DeleteRole(f.ctx, f.admin, f.membership, guestRoleID, customized.Version); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("delete configured guest role error=%v, want conflict", err)
	}

	unsafeRole, err := f.groups.CreateRole(f.ctx, f.admin, f.membership, groups.RoleCommand{
		Name: "Unsafe guest candidate",
		Grants: []domain.PermissionGrant{
			{Permission: domain.PermissionCreateOwnBooking, Scope: domain.PermissionScope{Type: domain.PermissionScopeGroup}},
			{Permission: domain.PermissionViewMemberDirectory, Scope: domain.PermissionScope{Type: domain.PermissionScopeGroup}},
		},
	})
	if err != nil {
		t.Fatalf("create non-minimal candidate: %v", err)
	}
	if _, err := f.groups.UpdateGuestSettings(f.ctx, f.admin, f.membership, groups.GuestSettingsUpdate{
		GuestsEnabled: true, GuestRoleID: &unsafeRole.ID,
	}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("select non-minimal guest role error=%v, want validation", err)
	}
}

func TestConfiguredGuestRoleSwitchIgnoresExpiredInvitationAssignments(t *testing.T) {
	f := newFixture(t)
	settings, err := f.groups.UpdateGuestSettings(f.ctx, f.admin, f.membership, groups.GuestSettingsUpdate{GuestsEnabled: true, CreateGuestRole: true})
	if err != nil || settings.GuestRoleID == nil {
		t.Fatalf("create configured guest role: settings=%#v err=%v", settings, err)
	}
	previousGuestRoleID := *settings.GuestRoleID
	invitation, err := f.groups.CreateInvitationWithRoles(f.ctx, f.admin, f.membership, "expired-guest-role@example.test", "", []string{previousGuestRoleID})
	if err != nil {
		t.Fatalf("create invitation assigned to guest role: %v", err)
	}
	replacement, err := f.groups.CreateRole(f.ctx, f.admin, f.membership, groups.RoleCommand{
		Name: "Replacement guest",
		Grants: []domain.PermissionGrant{{
			Permission: domain.PermissionCreateOwnBooking,
			Scope:      domain.PermissionScope{Type: domain.PermissionScopeGroup},
		}},
	})
	if err != nil {
		t.Fatalf("create replacement guest role: %v", err)
	}
	if _, err := f.groups.UpdateGuestSettings(f.ctx, f.admin, f.membership, groups.GuestSettingsUpdate{
		GuestsEnabled: true,
		GuestRoleID:   &replacement.ID,
	}); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("switch role with open invitation error=%v, want conflict", err)
	}
	if _, err := f.db.ExecContext(f.ctx, `UPDATE invitations SET expires_at='2000-01-01T00:00:00Z' WHERE id=?`, invitation.ID); err != nil {
		t.Fatalf("expire guest-role invitation: %v", err)
	}

	updated, err := f.groups.UpdateGuestSettings(f.ctx, f.admin, f.membership, groups.GuestSettingsUpdate{
		GuestsEnabled: true,
		GuestRoleID:   &replacement.ID,
	})
	if err != nil || updated.GuestRoleID == nil || *updated.GuestRoleID != replacement.ID {
		t.Fatalf("switch role past expired invitation: settings=%#v err=%v", updated, err)
	}
}

func TestInitialGuestRoleSelectionIgnoresExpiredInvitationAssignments(t *testing.T) {
	f := newFixture(t)
	candidate, err := f.groups.CreateRole(f.ctx, f.admin, f.membership, groups.RoleCommand{
		Name: "Initial guest candidate",
		Grants: []domain.PermissionGrant{{
			Permission: domain.PermissionCreateOwnBooking,
			Scope:      domain.PermissionScope{Type: domain.PermissionScopeGroup},
		}},
	})
	if err != nil {
		t.Fatalf("create initial guest candidate: %v", err)
	}
	memberRoleID := authorization.PresetRoleID(f.membership.GroupID, domain.RolePresetMember)
	invitation, err := f.groups.CreateInvitationWithRoles(f.ctx, f.admin, f.membership, "expired-initial-guest-role@example.test", "", []string{candidate.ID, memberRoleID})
	if err != nil {
		t.Fatalf("create non-exclusive candidate invitation: %v", err)
	}
	if _, err := f.groups.UpdateGuestSettings(f.ctx, f.admin, f.membership, groups.GuestSettingsUpdate{
		GuestsEnabled: true,
		GuestRoleID:   &candidate.ID,
	}); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("select candidate with open non-exclusive invitation error=%v, want conflict", err)
	}
	if _, err := f.db.ExecContext(f.ctx, `UPDATE invitations SET expires_at='2000-01-01T00:00:00Z' WHERE id=?`, invitation.ID); err != nil {
		t.Fatalf("expire candidate invitation: %v", err)
	}

	updated, err := f.groups.UpdateGuestSettings(f.ctx, f.admin, f.membership, groups.GuestSettingsUpdate{
		GuestsEnabled: true,
		GuestRoleID:   &candidate.ID,
	})
	if err != nil || updated.GuestRoleID == nil || *updated.GuestRoleID != candidate.ID {
		t.Fatalf("select candidate past expired invitation: settings=%#v err=%v", updated, err)
	}
}

func TestRoleAssignmentTransitionsToAndFromConfiguredGuestRole(t *testing.T) {
	f := newFixture(t)
	settings, err := f.groups.UpdateGuestSettings(f.ctx, f.admin, f.membership, groups.GuestSettingsUpdate{GuestsEnabled: true, CreateGuestRole: true})
	if err != nil || settings.GuestRoleID == nil {
		t.Fatalf("create configured guest role: settings=%#v err=%v", settings, err)
	}
	guestRoleID := *settings.GuestRoleID
	memberRoleID := authorization.PresetRoleID(f.membership.GroupID, domain.RolePresetMember)
	_, member, _ := f.inviteMember("guest-role-transition@example.test", "Role Transition", nil)

	guestAssignment, err := f.groups.ReplaceMemberRoles(f.ctx, f.admin, f.membership, member.ID, []string{guestRoleID}, member.RoleAssignmentsVersion)
	if err != nil || len(guestAssignment.RoleIDs) != 1 || guestAssignment.RoleIDs[0] != guestRoleID {
		t.Fatalf("normal-to-guest assignment=%#v err=%v", guestAssignment, err)
	}
	guestMembership, err := f.groups.MembershipForUser(f.ctx, f.membership.GroupID, member.UserID)
	if err != nil || !guestMembership.IsGuest || len(guestMembership.RoleIDs) != 1 || guestMembership.RoleIDs[0] != guestRoleID {
		t.Fatalf("normal-to-guest membership=%#v err=%v", guestMembership, err)
	}

	normalAssignment, err := f.groups.ReplaceMemberRoles(f.ctx, f.admin, f.membership, member.ID, []string{memberRoleID}, guestAssignment.Version)
	if err != nil || len(normalAssignment.RoleIDs) != 1 || normalAssignment.RoleIDs[0] != memberRoleID {
		t.Fatalf("guest-to-normal assignment=%#v err=%v", normalAssignment, err)
	}
	normalMembership, err := f.groups.MembershipForUser(f.ctx, f.membership.GroupID, member.UserID)
	if err != nil || normalMembership.IsGuest || len(normalMembership.RoleIDs) != 1 || normalMembership.RoleIDs[0] != memberRoleID {
		t.Fatalf("guest-to-normal membership=%#v err=%v", normalMembership, err)
	}
}

func TestManagedGuestMixedBatchPaymentReversalsAndPeriodClose(t *testing.T) {
	f := newFixture(t)
	if _, err := f.groups.UpdateGuestSettings(f.ctx, f.admin, f.membership, groups.GuestSettingsUpdate{GuestsEnabled: true}); err != nil {
		t.Fatalf("enable managed guests: %v", err)
	}
	if _, err := f.db.ExecContext(f.ctx, `UPDATE group_settings SET notification_emails_enabled=1 WHERE group_id=?`, f.membership.GroupID); err != nil {
		t.Fatalf("enable notification emails: %v", err)
	}
	notifier := notifications.Service{DB: f.db, EmailDeliveryAvailable: true}
	f.bookings.Notifications = notifier
	f.finance.Notifications = notifier
	f.periods.Notifications = notifier

	_, product := f.catalogItem("Mixed guest lifecycle", 200)
	periodID := f.openPeriodID()
	created, err := f.bookings.CreateBatch(f.ctx, f.admin, f.membership, "guest-mixed-batch", bookings.BatchCreateInput{
		ProductID:                product.ID,
		ProductVersion:           product.Version,
		ExpectedPeriodID:         periodID,
		Quantity:                 1,
		TargetMembershipIDs:      []string{f.membership.ID},
		ManagedGuestDisplayNames: []string{"Financial Guest"},
		Reason:                   "Mixed booking with a managed guest",
	})
	if err != nil || len(created) != 2 || created[0].TargetMembershipID != f.membership.ID || created[1].TargetDisplayName != "Financial Guest" {
		t.Fatalf("mixed managed batch=%#v err=%v", created, err)
	}
	guestMembershipID := created[1].TargetMembershipID
	assertGuestBalance := func(want int64) {
		t.Helper()
		account, err := f.finance.Account(f.ctx, f.membership, guestMembershipID)
		if err != nil || account.BalanceMinor != want {
			t.Fatalf("guest balance=%d err=%v, want %d", account.BalanceMinor, err, want)
		}
	}
	assertGuestBalance(200)

	payment, err := f.finance.CreatePayment(f.ctx, f.admin, f.membership, "guest-payment-create", finance.CreatePaymentInput{
		MembershipID: guestMembershipID,
		AmountMinor:  75,
		Method:       "CASH",
		Reference:    "Guest payment",
	})
	if err != nil {
		t.Fatalf("create guest payment: %v", err)
	}
	assertGuestBalance(125)
	if err := f.finance.ReversePayment(f.ctx, f.admin, f.membership, "guest-payment-reverse", payment.ID, "Payment correction"); err != nil {
		t.Fatalf("reverse guest payment: %v", err)
	}
	assertGuestBalance(200)
	if _, err := f.bookings.Void(f.ctx, f.admin, f.membership, "guest-booking-reverse", created[1].ID, "Guest booking correction"); err != nil {
		t.Fatalf("reverse guest booking: %v", err)
	}
	assertGuestBalance(0)

	closed, err := f.periods.Close(f.ctx, f.admin, f.membership, "guest-period-close", periodID, periods.CloseInput{
		Label: "Managed guest lifecycle", DueAt: "2099-01-01", NextPeriodLabel: "Next period",
	})
	if err != nil || closed.Statements != 2 {
		t.Fatalf("close guest period=%#v err=%v, want two active statements", closed, err)
	}
	statements, err := f.periods.Statements(f.ctx, f.membership, periodID)
	if err != nil {
		t.Fatalf("list guest lifecycle statements: %v", err)
	}
	var guestStatement *domain.Statement
	for index := range statements {
		if statements[index].MembershipID == guestMembershipID {
			guestStatement = &statements[index]
			break
		}
	}
	if guestStatement == nil || guestStatement.Email != nil || guestStatement.AmountDueMinor != 0 {
		t.Fatalf("managed guest statement=%#v", guestStatement)
	}
	var notificationCount, outboxCount int
	if err := f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM notifications WHERE membership_id=?`, guestMembershipID).Scan(&notificationCount); err != nil {
		t.Fatalf("count guest notifications: %v", err)
	}
	if err := f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM notification_email_outbox WHERE group_id=? AND notification_id IN (SELECT id FROM notifications WHERE membership_id=?)`, f.membership.GroupID, guestMembershipID).Scan(&outboxCount); err != nil {
		t.Fatalf("count guest email jobs: %v", err)
	}
	if notificationCount != 5 || outboxCount != 0 {
		t.Fatalf("guest notifications/outbox=%d/%d, want 5/0", notificationCount, outboxCount)
	}

	if err := f.groups.ArchiveMember(f.ctx, f.admin, f.membership, guestMembershipID, false); err != nil {
		t.Fatalf("archive financially active guest: %v", err)
	}
	var preservedBookings, preservedLedger, preservedStatements int
	if err := f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM bookings WHERE target_membership_id=?`, guestMembershipID).Scan(&preservedBookings); err != nil {
		t.Fatalf("count preserved guest bookings: %v", err)
	}
	if err := f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM ledger_entries WHERE membership_id=?`, guestMembershipID).Scan(&preservedLedger); err != nil {
		t.Fatalf("count preserved guest ledger: %v", err)
	}
	if err := f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM period_statements WHERE membership_id=?`, guestMembershipID).Scan(&preservedStatements); err != nil {
		t.Fatalf("count preserved guest statements: %v", err)
	}
	if preservedBookings != 1 || preservedLedger == 0 || preservedStatements != 1 {
		t.Fatalf("preserved guest bookings/ledger/statements=%d/%d/%d", preservedBookings, preservedLedger, preservedStatements)
	}
}
