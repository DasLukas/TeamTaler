package integration_test

import (
	"errors"
	"testing"

	"github.com/DasLukas/TeamTaler/internal/auth"
	"github.com/DasLukas/TeamTaler/internal/authorization"
	"github.com/DasLukas/TeamTaler/internal/bookings"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/finance"
	"github.com/DasLukas/TeamTaler/internal/groups"
)

func TestInvitationPermissionsPreviewArchiveAndReactivation(t *testing.T) {
	f := newFixture(t)
	if _, err := f.auth.PreviewInvitation(f.ctx, "not-a-real-token"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("invalid preview error = %v, want not found", err)
	}
	otherGroup, err := f.groups.Create(f.ctx, f.admin, "Other Team", "EUR")
	if err != nil {
		t.Fatalf("create other group: %v", err)
	}
	otherRoles, err := f.groups.ListRoles(f.ctx, otherGroup.Membership)
	if err != nil {
		t.Fatalf("list other-group roles: %v", err)
	}
	otherFinanceRoleID := authorization.TemplateRoleID(otherGroup.ID, domain.RoleTemplateFinance)
	foundOtherFinanceRole := false
	for _, role := range otherRoles {
		foundOtherFinanceRole = foundOtherFinanceRole || role.ID == otherFinanceRoleID
	}
	if !foundOtherFinanceRole {
		t.Fatalf("other-group finance template role %q not found", otherFinanceRoleID)
	}
	if _, err := f.groups.CreateInvitationWithRoles(f.ctx, f.admin, f.membership, "cross-group@example.test", "Cross Group", []string{otherFinanceRoleID}); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("cross-group invitation role error = %v, want forbidden", err)
	}
	expired, err := f.createStarterInvitation("expired@example.test", "Expired")
	if err != nil {
		t.Fatalf("create expired invitation: %v", err)
	}
	if _, err := f.db.ExecContext(f.ctx, `UPDATE invitations SET expires_at='2000-01-01T00:00:00Z' WHERE id=?`, expired.ID); err != nil {
		t.Fatalf("expire invitation: %v", err)
	}
	if _, err := f.auth.PreviewInvitation(f.ctx, expired.Token); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("expired preview error = %v, want conflict", err)
	}
	unnamed, err := f.createStarterInvitation("unnamed@example.test", "")
	if err != nil {
		t.Fatalf("create unnamed invitation: %v", err)
	}
	unnamedPreview, err := f.auth.PreviewInvitation(f.ctx, unnamed.Token)
	if err != nil || unnamedPreview.DisplayName != "" || unnamedPreview.ExistingAccount {
		t.Fatalf("unnamed preview = %#v err=%v", unnamedPreview, err)
	}
	first, err := f.groups.CreateInvitation(f.ctx, f.admin, f.membership, "member@example.test", "Suggested Member", []domain.Role{domain.RoleFinanceManager}, []domain.GroupPermission{domain.PermissionSelfRecordPayment}, nil)
	if err != nil {
		t.Fatalf("create invitation: %v", err)
	}
	if _, err := f.groups.UpdateInvitation(f.ctx, f.admin, f.membership, first.ID, "Suggested Member", []domain.Role{domain.Role("UNSUPPORTED")}, nil, nil, first.RoleAssignmentsVersion); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("unsupported invitation role error = %v, want validation", err)
	}
	if _, err := f.groups.UpdateInvitation(f.ctx, f.admin, f.membership, first.ID, "Suggested Member", nil, []domain.GroupPermission{domain.GroupPermission("UNSUPPORTED")}, nil, first.RoleAssignmentsVersion); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("unsupported invitation group permission error = %v, want validation", err)
	}
	if _, err := f.groups.UpdateInvitation(f.ctx, f.admin, f.membership, first.ID, "Suggested Member", nil, nil, map[string][]domain.CategoryPermission{
		"cat_legacy": {domain.PermissionVoidBookings},
	}, first.RoleAssignmentsVersion); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("legacy category invitation update error = %v, want validation", err)
	}
	updated, err := f.groups.UpdateInvitation(f.ctx, f.admin, f.membership, first.ID, "Suggested Member", []domain.Role{domain.RoleFinanceManager}, []domain.GroupPermission{domain.PermissionSelfRecordPayment}, nil, first.RoleAssignmentsVersion)
	if err != nil || updated.Email != "member@example.test" || updated.DisplayName != "Suggested Member" {
		t.Fatalf("updated invitation = %#v err=%v", updated, err)
	}
	preview, err := f.auth.PreviewInvitation(f.ctx, first.Token)
	if err != nil || preview.DisplayName != "Suggested Member" || preview.ExistingAccount {
		t.Fatalf("preview = %#v err=%v", preview, err)
	}
	firstSession, firstMembership, err := f.auth.AcceptInvitation(f.ctx, auth.InvitationAcceptance{
		Token: first.Token, DisplayName: "Chosen Member", Password: testPassword,
	})
	if err != nil {
		t.Fatalf("accept first invitation: %v", err)
	}
	if firstSession.Principal.DisplayName != "Chosen Member" || !hasLegacyRole(firstMembership, domain.RoleFinanceManager) {
		t.Fatalf("accepted membership = %#v", firstMembership)
	}
	if len(firstMembership.GroupPermissions) != 1 || firstMembership.GroupPermissions[0] != domain.PermissionSelfRecordPayment {
		t.Fatalf("accepted group permissions = %#v", firstMembership.GroupPermissions)
	}
	if len(firstMembership.CategoryGrants) != 0 {
		t.Fatalf("accepted legacy category grants = %#v, want none", firstMembership.CategoryGrants)
	}
	if _, err := f.auth.PreviewInvitation(f.ctx, first.Token); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("consumed preview error = %v, want not found", err)
	}
	_, historyProduct := f.catalogItem("Archived member history", 250)
	historyBooking, err := f.bookings.Create(f.ctx, f.admin, f.membership, "archive-history-booking", bookings.CreateInput{
		ProductID: historyProduct.ID, ProductVersion: historyProduct.Version, ExpectedPeriodID: f.openPeriodID(),
		Quantity: 1, TargetMembershipID: firstMembership.ID, Reason: "history retention test",
	})
	if err != nil {
		t.Fatalf("create archived-member booking: %v", err)
	}
	historyPayment, err := f.finance.CreatePayment(f.ctx, f.admin, f.membership, "archive-history-payment", finance.CreatePaymentInput{
		MembershipID: firstMembership.ID, AmountMinor: 100, Method: "BANK_TRANSFER", Reference: "history-retention",
	})
	if err != nil {
		t.Fatalf("create archived-member payment: %v", err)
	}
	var auditEventsBeforeArchive int
	if err := f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM audit_events WHERE group_id=?`, f.group.ID).Scan(&auditEventsBeforeArchive); err != nil {
		t.Fatalf("count audit events before archive: %v", err)
	}

	if err := f.groups.ArchiveMember(f.ctx, f.admin, f.membership, firstMembership.ID, false); err != nil {
		t.Fatalf("archive member: %v", err)
	}
	var status string
	if err := f.db.QueryRowContext(f.ctx, `SELECT status FROM memberships WHERE id=?`, firstMembership.ID).Scan(&status); err != nil || status != "ARCHIVED" {
		t.Fatalf("archived status=%q err=%v", status, err)
	}
	var retainedMemberships, roles, groupPermissions, grants, dynamicAssignments int
	_ = f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM memberships WHERE id=?`, firstMembership.ID).Scan(&retainedMemberships)
	_ = f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM membership_roles WHERE membership_id=?`, firstMembership.ID).Scan(&roles)
	_ = f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM membership_permissions WHERE membership_id=?`, firstMembership.ID).Scan(&groupPermissions)
	_ = f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM category_permissions WHERE membership_id=?`, firstMembership.ID).Scan(&grants)
	_ = f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM membership_role_assignments WHERE membership_id=?`, firstMembership.ID).Scan(&dynamicAssignments)
	if retainedMemberships != 1 || roles != 0 || groupPermissions != 0 || grants != 0 || dynamicAssignments != 0 {
		t.Fatalf("archive retained=%d roles=%d groupPermissions=%d grants=%d dynamicAssignments=%d", retainedMemberships, roles, groupPermissions, grants, dynamicAssignments)
	}
	var retainedBookings, retainedPayments, retainedLedgerEntries, auditEventsAfterArchive int
	_ = f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM bookings WHERE id=? AND target_membership_id=?`, historyBooking.ID, firstMembership.ID).Scan(&retainedBookings)
	_ = f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM payments WHERE id=? AND membership_id=?`, historyPayment.ID, firstMembership.ID).Scan(&retainedPayments)
	_ = f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM ledger_entries WHERE membership_id=?`, firstMembership.ID).Scan(&retainedLedgerEntries)
	_ = f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM audit_events WHERE group_id=?`, f.group.ID).Scan(&auditEventsAfterArchive)
	if retainedBookings != 1 || retainedPayments != 1 || retainedLedgerEntries < 2 || auditEventsAfterArchive != auditEventsBeforeArchive+1 {
		t.Fatalf("archive history bookings=%d payments=%d ledger=%d auditBefore=%d auditAfter=%d", retainedBookings, retainedPayments, retainedLedgerEntries, auditEventsBeforeArchive, auditEventsAfterArchive)
	}

	second, err := f.groups.CreateInvitation(f.ctx, f.admin, f.membership, "member@example.test", "Second Suggestion", []domain.Role{domain.RoleCatalogManager}, nil, nil)
	if err != nil {
		t.Fatalf("create reactivation invitation: %v", err)
	}
	preview, err = f.auth.PreviewInvitation(f.ctx, second.Token)
	if err != nil || preview.DisplayName != "Second Suggestion" || !preview.ExistingAccount {
		t.Fatalf("reactivation preview = %#v err=%v", preview, err)
	}
	secondSession, secondMembership, err := f.auth.AcceptInvitation(f.ctx, auth.InvitationAcceptance{
		Token: second.Token, DisplayName: "Ignored Replacement", Password: testPassword,
	})
	if err != nil {
		t.Fatalf("accept reactivation invitation: %v", err)
	}
	if secondMembership.ID != firstMembership.ID {
		t.Fatalf("reactivated membership ID=%q, want %q", secondMembership.ID, firstMembership.ID)
	}
	if secondSession.Principal.DisplayName != "Chosen Member" {
		t.Fatalf("existing account display name=%q", secondSession.Principal.DisplayName)
	}
	if !hasLegacyRole(secondMembership, domain.RoleCatalogManager) || hasLegacyRole(secondMembership, domain.RoleFinanceManager) || len(secondMembership.GroupPermissions) != 0 || len(secondMembership.CategoryGrants) != 0 {
		t.Fatalf("reactivated permissions = %#v", secondMembership)
	}
}

func TestDynamicInvitationRolesReplaceArchivedMembershipAssignments(t *testing.T) {
	f := newFixture(t)
	bookerRole, err := f.groups.CreateRole(f.ctx, f.admin, f.membership, groups.RoleCommand{
		Name: "Invitation booker",
		Grants: []domain.PermissionGrant{{
			Permission: domain.PermissionBookForOthers,
			Scope:      domain.PermissionScope{Type: domain.PermissionScopeGroup},
		}},
	})
	if err != nil {
		t.Fatalf("create booking role: %v", err)
	}
	paymentRole, err := f.groups.CreateRole(f.ctx, f.admin, f.membership, groups.RoleCommand{
		Name: "Invitation self payment",
		Grants: []domain.PermissionGrant{{
			Permission: domain.PermissionRecordOwnPayment,
			Scope:      domain.PermissionScope{Type: domain.PermissionScopeGroup},
		}},
	})
	if err != nil {
		t.Fatalf("create payment role: %v", err)
	}

	firstInvitation, err := f.groups.CreateInvitationWithRoles(f.ctx, f.admin, f.membership, "dynamic-member@example.test", "Dynamic Member", []string{bookerRole.ID})
	if err != nil {
		t.Fatalf("create first dynamic invitation: %v", err)
	}
	_, firstMembership, err := f.auth.AcceptInvitation(f.ctx, auth.InvitationAcceptance{Token: firstInvitation.Token, DisplayName: "Dynamic Member", Password: testPassword})
	if err != nil {
		t.Fatalf("accept first dynamic invitation: %v", err)
	}
	if !containsRoleID(firstMembership.RoleIDs, bookerRole.ID) || !hasEffectivePermission(firstMembership, domain.PermissionBookForOthers) {
		t.Fatalf("first dynamic assignment = %#v", firstMembership)
	}

	if err := f.groups.ArchiveMember(f.ctx, f.admin, f.membership, firstMembership.ID, false); err != nil {
		t.Fatalf("archive dynamic member: %v", err)
	}
	var archivedAssignments int
	if err := f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM membership_role_assignments WHERE membership_id=?`, firstMembership.ID).Scan(&archivedAssignments); err != nil {
		t.Fatalf("count archived assignments: %v", err)
	}
	if archivedAssignments != 0 {
		t.Fatalf("archived assignment count = %d, want 0", archivedAssignments)
	}

	secondInvitation, err := f.groups.CreateInvitationWithRoles(f.ctx, f.admin, f.membership, "dynamic-member@example.test", "Dynamic Member", []string{paymentRole.ID})
	if err != nil {
		t.Fatalf("create reactivation invitation: %v", err)
	}
	_, reactivated, err := f.auth.AcceptInvitation(f.ctx, auth.InvitationAcceptance{Token: secondInvitation.Token, Password: testPassword})
	if err != nil {
		t.Fatalf("accept reactivation invitation: %v", err)
	}
	if reactivated.ID != firstMembership.ID {
		t.Fatalf("reactivated membership ID = %q, want %q", reactivated.ID, firstMembership.ID)
	}
	if containsRoleID(reactivated.RoleIDs, bookerRole.ID) || !containsRoleID(reactivated.RoleIDs, paymentRole.ID) {
		t.Fatalf("reactivated role IDs = %#v", reactivated.RoleIDs)
	}
	if hasEffectivePermission(reactivated, domain.PermissionBookForOthers) || !hasEffectivePermission(reactivated, domain.PermissionRecordOwnPayment) {
		t.Fatalf("reactivated effective grants = %#v", reactivated.EffectiveGrants)
	}
}

func hasLegacyRole(membership domain.Membership, expected domain.Role) bool {
	for _, role := range membership.Roles {
		if role == expected {
			return true
		}
	}
	return false
}

func containsRoleID(roleIDs []string, expected string) bool {
	for _, roleID := range roleIDs {
		if roleID == expected {
			return true
		}
	}
	return false
}

func hasEffectivePermission(membership domain.Membership, expected domain.PermissionKey) bool {
	for _, grant := range membership.EffectiveGrants {
		if grant.Permission == expected && grant.Scope.Type == domain.PermissionScopeGroup {
			return true
		}
	}
	return false
}

func TestArchiveMemberProtectsLastAdministratorAndSelfConfirmation(t *testing.T) {
	f := newFixture(t)
	if err := f.groups.ArchiveMember(f.ctx, f.admin, f.membership, f.membership.ID, true); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("archive last administrator error = %v, want conflict", err)
	}
	_, secondMembership, _ := f.inviteMember("second-admin@example.test", "Second Admin", []domain.Role{domain.RoleAdmin})
	if err := f.groups.ArchiveMember(f.ctx, f.admin, f.membership, f.membership.ID, false); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("unconfirmed self-removal error = %v, want validation", err)
	}
	if err := f.groups.ArchiveMember(f.ctx, f.admin, f.membership, f.membership.ID, true); err != nil {
		t.Fatalf("confirmed self-removal: %v", err)
	}
	if _, err := f.groups.MembershipForUser(f.ctx, f.group.ID, f.admin.UserID); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("archived administrator access error = %v, want forbidden", err)
	}
	if _, err := f.groups.MembershipForUser(f.ctx, f.group.ID, secondMembership.UserID); err != nil {
		t.Fatalf("remaining administrator access: %v", err)
	}
}

func TestConcurrentAdministratorDemotionsKeepOneReservedAdministrator(t *testing.T) {
	f := newFixture(t)
	secondPrincipal, secondMembership, _ := f.inviteMember("concurrent-admin@example.test", "Concurrent Admin", []domain.Role{domain.RoleAdmin})

	memberRoleID := authorization.TemplateRoleID(f.group.ID, domain.RoleTemplateMember)

	start := make(chan struct{})
	results := make(chan error, 2)
	go func() {
		<-start
		_, err := f.groups.ReplaceMemberRoles(f.ctx, f.admin, f.membership, secondMembership.ID, []string{memberRoleID}, secondMembership.RoleAssignmentsVersion)
		results <- err
	}()
	go func() {
		<-start
		_, err := f.groups.ReplaceMemberRoles(f.ctx, secondPrincipal, secondMembership, f.membership.ID, []string{memberRoleID}, f.membership.RoleAssignmentsVersion)
		results <- err
	}()
	close(start)

	firstErr, secondErr := <-results, <-results
	if (firstErr == nil) == (secondErr == nil) {
		t.Fatalf("concurrent demotions errors = (%v, %v), want exactly one success", firstErr, secondErr)
	}
	denied := firstErr
	if denied == nil {
		denied = secondErr
	}
	if !errors.Is(denied, domain.ErrForbidden) && !errors.Is(denied, domain.ErrConflict) {
		t.Fatalf("prevented demotion error = %v, want forbidden or conflict", denied)
	}

	var activeAdministrators int
	if err := f.db.QueryRowContext(f.ctx, `SELECT count(*)
		FROM membership_role_assignments a
		JOIN roles r ON r.group_id=a.group_id AND r.id=a.role_id
		JOIN memberships m ON m.group_id=a.group_id AND m.id=a.membership_id
		WHERE a.group_id=? AND r.preset_key='GROUP_ADMINISTRATOR' AND m.status='ACTIVE'`, f.group.ID).Scan(&activeAdministrators); err != nil {
		t.Fatalf("count active administrators: %v", err)
	}
	if activeAdministrators != 1 {
		t.Fatalf("active reserved administrators = %d, want 1", activeAdministrators)
	}
}
