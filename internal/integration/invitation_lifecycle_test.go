package integration_test

import (
	"errors"
	"testing"

	"github.com/DasLukas/TeamTaler/internal/auth"
	"github.com/DasLukas/TeamTaler/internal/bookings"
	"github.com/DasLukas/TeamTaler/internal/catalog"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/finance"
	"github.com/DasLukas/TeamTaler/internal/groups"
)

func TestInvitationPermissionsPreviewArchiveAndReactivation(t *testing.T) {
	f := newFixture(t)
	if _, err := f.auth.PreviewInvitation(f.ctx, "not-a-real-token"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("invalid preview error = %v, want not found", err)
	}
	category, err := f.catalog.CreateCategory(f.ctx, f.admin, f.membership, catalog.CreateCategoryInput{Name: "Invited category", Icon: domain.CategoryIconOther})
	if err != nil {
		t.Fatalf("create category: %v", err)
	}
	otherGroup, err := f.groups.Create(f.ctx, f.admin, "Other Team", "EUR")
	if err != nil {
		t.Fatalf("create other group: %v", err)
	}
	otherCategory, err := f.catalog.CreateCategory(f.ctx, f.admin, otherGroup.Membership, catalog.CreateCategoryInput{Name: "Other category", Icon: domain.CategoryIconOther})
	if err != nil {
		t.Fatalf("create other category: %v", err)
	}
	if _, err := f.groups.CreateInvitation(f.ctx, f.admin, f.membership, "cross-group@example.test", "Cross Group", nil, map[string][]domain.CategoryPermission{
		otherCategory.ID: {domain.PermissionAssignToOthers},
	}); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("cross-group invitation grant error = %v, want forbidden", err)
	}
	expired, err := f.groups.CreateInvitation(f.ctx, f.admin, f.membership, "expired@example.test", "Expired", nil, nil)
	if err != nil {
		t.Fatalf("create expired invitation: %v", err)
	}
	if _, err := f.db.ExecContext(f.ctx, `UPDATE invitations SET expires_at='2000-01-01T00:00:00Z' WHERE id=?`, expired.ID); err != nil {
		t.Fatalf("expire invitation: %v", err)
	}
	if _, err := f.auth.PreviewInvitation(f.ctx, expired.Token); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("expired preview error = %v, want conflict", err)
	}
	unnamed, err := f.groups.CreateInvitation(f.ctx, f.admin, f.membership, "unnamed@example.test", "", nil, nil)
	if err != nil {
		t.Fatalf("create unnamed invitation: %v", err)
	}
	unnamedPreview, err := f.auth.PreviewInvitation(f.ctx, unnamed.Token)
	if err != nil || unnamedPreview.DisplayName != "" || unnamedPreview.ExistingAccount {
		t.Fatalf("unnamed preview = %#v err=%v", unnamedPreview, err)
	}
	first, err := f.groups.CreateInvitation(f.ctx, f.admin, f.membership, "member@example.test", "Suggested Member", []domain.Role{domain.RoleFinanceManager}, map[string][]domain.CategoryPermission{
		category.ID: {domain.PermissionAssignToOthers},
	})
	if err != nil {
		t.Fatalf("create invitation: %v", err)
	}
	if _, err := f.groups.UpdateInvitation(f.ctx, f.admin, f.membership, first.ID, "Suggested Member", []domain.Role{domain.Role("UNSUPPORTED")}, nil); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("unsupported invitation role error = %v, want validation", err)
	}
	if _, err := f.groups.UpdateInvitation(f.ctx, f.admin, f.membership, first.ID, "Suggested Member", nil, map[string][]domain.CategoryPermission{
		otherCategory.ID: {domain.PermissionVoidBookings},
	}); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("cross-group invitation update error = %v, want forbidden", err)
	}
	updated, err := f.groups.UpdateInvitation(f.ctx, f.admin, f.membership, first.ID, "Suggested Member", []domain.Role{domain.RoleFinanceManager}, map[string][]domain.CategoryPermission{
		category.ID: {domain.PermissionAssignToOthers},
	})
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
	if firstSession.Principal.DisplayName != "Chosen Member" || !groups.HasRole(firstMembership, domain.RoleFinanceManager) {
		t.Fatalf("accepted membership = %#v", firstMembership)
	}
	if grants := firstMembership.CategoryGrants[category.ID]; len(grants) != 1 || grants[0] != domain.PermissionAssignToOthers {
		t.Fatalf("accepted grants = %#v", firstMembership.CategoryGrants)
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
	var retainedMemberships, roles, grants int
	_ = f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM memberships WHERE id=?`, firstMembership.ID).Scan(&retainedMemberships)
	_ = f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM membership_roles WHERE membership_id=?`, firstMembership.ID).Scan(&roles)
	_ = f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM category_permissions WHERE membership_id=?`, firstMembership.ID).Scan(&grants)
	if retainedMemberships != 1 || roles != 0 || grants != 0 {
		t.Fatalf("archive retained=%d roles=%d grants=%d", retainedMemberships, roles, grants)
	}
	var retainedBookings, retainedPayments, retainedLedgerEntries, auditEventsAfterArchive int
	_ = f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM bookings WHERE id=? AND target_membership_id=?`, historyBooking.ID, firstMembership.ID).Scan(&retainedBookings)
	_ = f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM payments WHERE id=? AND membership_id=?`, historyPayment.ID, firstMembership.ID).Scan(&retainedPayments)
	_ = f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM ledger_entries WHERE membership_id=?`, firstMembership.ID).Scan(&retainedLedgerEntries)
	_ = f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM audit_events WHERE group_id=?`, f.group.ID).Scan(&auditEventsAfterArchive)
	if retainedBookings != 1 || retainedPayments != 1 || retainedLedgerEntries < 2 || auditEventsAfterArchive != auditEventsBeforeArchive+1 {
		t.Fatalf("archive history bookings=%d payments=%d ledger=%d auditBefore=%d auditAfter=%d", retainedBookings, retainedPayments, retainedLedgerEntries, auditEventsBeforeArchive, auditEventsAfterArchive)
	}

	second, err := f.groups.CreateInvitation(f.ctx, f.admin, f.membership, "member@example.test", "Second Suggestion", []domain.Role{domain.RoleCatalogManager}, nil)
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
	if !groups.HasRole(secondMembership, domain.RoleCatalogManager) || groups.HasRole(secondMembership, domain.RoleFinanceManager) || len(secondMembership.CategoryGrants) != 0 {
		t.Fatalf("reactivated permissions = %#v", secondMembership)
	}
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
