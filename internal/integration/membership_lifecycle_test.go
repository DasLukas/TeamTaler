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
)

func TestRegularMemberLifecyclePreservesHistoryAndDetachesOnlyOneGroup(t *testing.T) {
	f := newFixture(t)
	memberPrincipal, member, _ := f.inviteMember("lifecycle-member@example.test", "Lifecycle Member", nil)
	originalUserID := member.UserID
	otherGroup, err := f.groups.Create(f.ctx, memberPrincipal, "Other Lifecycle Group", "EUR")
	if err != nil {
		t.Fatalf("create second membership for lifecycle account: %v", err)
	}
	_, product := f.catalogItem("Lifecycle history", 250)
	booking, err := f.bookings.Create(f.ctx, f.admin, f.membership, "lifecycle-booking", bookings.CreateInput{
		ProductID: product.ID, ProductVersion: product.Version, ExpectedPeriodID: f.openPeriodID(),
		Quantity: 1, TargetMembershipID: member.ID, Reason: "Lifecycle fixture",
	})
	if err != nil {
		t.Fatalf("create lifecycle booking: %v", err)
	}
	payment, err := f.finance.CreatePayment(f.ctx, f.admin, f.membership, "lifecycle-payment", finance.CreatePaymentInput{
		MembershipID: member.ID, AmountMinor: 250, ReceivedAt: "2026-08-10T13:00:00Z", Method: "CASH", Reference: "Lifecycle settlement",
	})
	if err != nil {
		t.Fatalf("settle lifecycle account: %v", err)
	}

	if err := f.groups.ArchiveMember(f.ctx, f.admin, f.membership, member.ID, false); err != nil {
		t.Fatalf("archive regular member: %v", err)
	}
	defaultRoleID := authorization.TemplateRoleID(f.group.ID, domain.RoleTemplateMember)
	reactivated, err := f.groups.ReactivateMember(f.ctx, f.admin, f.membership, member.ID, groups.ReactivateMemberInput{RoleIDs: []string{defaultRoleID}})
	if err != nil || reactivated.ID != member.ID || reactivated.Status != domain.MembershipStatusActive {
		t.Fatalf("reactivate regular member=%#v err=%v", reactivated, err)
	}
	if err := f.groups.ArchiveMember(f.ctx, f.admin, f.membership, member.ID, false); err != nil {
		t.Fatalf("archive regular member before deletion: %v", err)
	}
	if err := f.groups.PermanentlyDeleteMember(f.ctx, f.admin, otherGroup.Membership, member.ID); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("cross-tenant permanent deletion error=%v, want forbidden", err)
	}
	if err := f.groups.PermanentlyDeleteMember(f.ctx, f.admin, f.membership, member.ID); err != nil {
		t.Fatalf("permanently delete regular member: %v", err)
	}
	if _, err := f.groups.ReactivateMember(f.ctx, f.admin, f.membership, member.ID, groups.ReactivateMemberInput{RoleIDs: []string{defaultRoleID}}); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("deleted membership reactivation error=%v, want conflict", err)
	}

	var tombstoneUserID, status string
	var deletedAt sql.NullString
	if err := f.db.QueryRowContext(f.ctx, `SELECT user_id,status,deleted_at FROM memberships WHERE id=?`, member.ID).Scan(&tombstoneUserID, &status, &deletedAt); err != nil {
		t.Fatalf("load deleted membership: %v", err)
	}
	if tombstoneUserID == originalUserID || status != domain.MembershipStatusArchived || !deletedAt.Valid {
		t.Fatalf("deleted membership identity/status=%q/%q/%#v", tombstoneUserID, status, deletedAt)
	}
	var tombstoneEmail, tombstonePassword, tombstoneAvatar sql.NullString
	var tombstoneName string
	var tombstoneActive bool
	if err := f.db.QueryRowContext(f.ctx, `SELECT display_name,email,password_hash,avatar_key,active FROM users WHERE id=?`, tombstoneUserID).
		Scan(&tombstoneName, &tombstoneEmail, &tombstonePassword, &tombstoneAvatar, &tombstoneActive); err != nil {
		t.Fatalf("load tombstone identity: %v", err)
	}
	if tombstoneName != "Lifecycle Member" || tombstoneEmail.Valid || tombstonePassword.Valid || tombstoneAvatar.Valid || tombstoneActive {
		t.Fatalf("tombstone identity=%q email=%#v password=%#v avatar=%#v active=%t", tombstoneName, tombstoneEmail, tombstonePassword, tombstoneAvatar, tombstoneActive)
	}
	var originalEmail string
	var originalActive bool
	if err := f.db.QueryRowContext(f.ctx, `SELECT email,active FROM users WHERE id=?`, originalUserID).Scan(&originalEmail, &originalActive); err != nil {
		t.Fatalf("load original account: %v", err)
	}
	if originalEmail != "lifecycle-member@example.test" || !originalActive {
		t.Fatalf("original account email/active=%q/%t", originalEmail, originalActive)
	}
	var otherMembershipUserID string
	if err := f.db.QueryRowContext(f.ctx, `SELECT user_id FROM memberships WHERE id=? AND status='ACTIVE'`, otherGroup.Membership.ID).Scan(&otherMembershipUserID); err != nil || otherMembershipUserID != originalUserID {
		t.Fatalf("other group membership user=%q err=%v, want %q", otherMembershipUserID, err, originalUserID)
	}

	members, err := f.groups.ListMembers(f.ctx, f.membership)
	if err != nil {
		t.Fatalf("list members after deletion: %v", err)
	}
	for _, item := range members {
		if item.ID == member.ID {
			t.Fatalf("deleted membership remained in member directory: %#v", item)
		}
	}
	bookingsHistory, err := f.bookings.List(f.ctx, f.membership, f.openPeriodID(), 100)
	if err != nil {
		t.Fatalf("list booking history: %v", err)
	}
	foundBooking := false
	for _, item := range bookingsHistory {
		if item.ID == booking.ID {
			foundBooking = item.TargetMembershipID == member.ID && item.TargetDisplayName == "Lifecycle Member" && item.TargetMembershipStatus == domain.MembershipStatusDeleted
		}
	}
	if !foundBooking {
		t.Fatalf("booking history did not retain deleted target: %#v", bookingsHistory)
	}
	paymentsHistory, err := f.finance.ListPayments(f.ctx, f.membership, 100)
	if err != nil {
		t.Fatalf("list payment history: %v", err)
	}
	foundPayment := false
	for _, item := range paymentsHistory {
		if item.ID == payment.ID {
			foundPayment = item.MembershipID == member.ID && item.MemberName == "Lifecycle Member" && item.MemberStatus == domain.MembershipStatusDeleted
		}
	}
	if !foundPayment {
		t.Fatalf("payment history did not retain deleted target: %#v", paymentsHistory)
	}
	var ledgerCount, auditCount int
	if err := f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM ledger_entries WHERE membership_id=?`, member.ID).Scan(&ledgerCount); err != nil || ledgerCount != 2 {
		t.Fatalf("deleted membership ledger count=%d err=%v, want 2", ledgerCount, err)
	}
	if err := f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM audit_events WHERE resource_id=? AND action IN ('membership.archived','membership.reactivated','membership.deleted')`, member.ID).Scan(&auditCount); err != nil || auditCount < 4 {
		t.Fatalf("deleted membership lifecycle audits=%d err=%v, want at least 4", auditCount, err)
	}

	if err := f.finance.ReversePayment(f.ctx, f.admin, f.membership, "lifecycle-payment-reversal", payment.ID, "Lifecycle correction"); err != nil {
		t.Fatalf("reverse deleted account payment: %v", err)
	}
	summaries, err := f.finance.ListAccountSummaries(f.ctx, f.membership)
	if err != nil {
		t.Fatalf("list deleted account after reversal: %v", err)
	}
	foundDeletedBalance := false
	for _, summary := range summaries {
		if summary.MembershipID == member.ID {
			foundDeletedBalance = summary.Status == domain.MembershipStatusDeleted && summary.BalanceMinor == 250
		}
	}
	if !foundDeletedBalance {
		t.Fatalf("deleted account with reopened balance missing: %#v", summaries)
	}
	if _, err := f.finance.CreatePayment(f.ctx, f.admin, f.membership, "deleted-account-settlement", finance.CreatePaymentInput{
		MembershipID: member.ID, AmountMinor: 250, ReceivedAt: "2026-08-10T14:00:00Z", Method: "BANK_TRANSFER", Reference: "Final settlement",
	}); err != nil {
		t.Fatalf("settle reopened deleted account: %v", err)
	}
	summaries, err = f.finance.ListAccountSummaries(f.ctx, f.membership)
	if err != nil {
		t.Fatalf("list accounts after final settlement: %v", err)
	}
	for _, summary := range summaries {
		if summary.MembershipID == member.ID {
			t.Fatalf("zero-balance deleted account remained operational: %#v", summary)
		}
	}

	invitation, err := f.groups.CreateInvitationWithRoles(f.ctx, f.admin, f.membership, originalEmail, "Lifecycle Member Rejoined", []string{defaultRoleID})
	if err != nil {
		t.Fatalf("invite original account after permanent deletion: %v", err)
	}
	_, rejoinedMembership, err := f.auth.AcceptInvitation(f.ctx, auth.InvitationAcceptance{Token: invitation.Token, DisplayName: "Lifecycle Member Rejoined", Password: testPassword, ExpectedAccountState: auth.InvitationAccountExisting})
	if err != nil {
		t.Fatalf("accept invitation after permanent deletion: %v", err)
	}
	if rejoinedMembership.ID == member.ID || rejoinedMembership.UserID != originalUserID {
		t.Fatalf("rejoined membership id/user=%q/%q, want new id and original user %q", rejoinedMembership.ID, rejoinedMembership.UserID, originalUserID)
	}
}

func TestTemporaryGuestLifecycleAndReactivationRoleRules(t *testing.T) {
	f := newFixture(t)
	_, product := f.catalogItem("Guest lifecycle", 100)
	created, err := f.bookings.CreateBatch(f.ctx, f.admin, f.membership, "guest-lifecycle-booking", bookings.BatchCreateInput{
		ProductID: product.ID, ProductVersion: product.Version, ExpectedPeriodID: f.openPeriodID(), Quantity: 1,
		TemporaryGuestDisplayNames: []string{"Lifecycle Guest"},
	})
	if err != nil || len(created) != 1 {
		t.Fatalf("create lifecycle guest booking=%#v err=%v", created, err)
	}
	guestID := created[0].TargetMembershipID
	if _, err := f.finance.CreatePayment(f.ctx, f.admin, f.membership, "guest-lifecycle-payment", finance.CreatePaymentInput{
		MembershipID: guestID, AmountMinor: 100, ReceivedAt: "2026-08-10T13:00:00Z", Method: "CASH", Reference: "Guest settlement",
	}); err != nil {
		t.Fatalf("settle lifecycle guest: %v", err)
	}
	if err := f.groups.ArchiveMember(f.ctx, f.admin, f.membership, guestID, false); err != nil {
		t.Fatalf("archive temporary guest: %v", err)
	}
	reactivatedGuest, err := f.groups.ReactivateMember(f.ctx, f.admin, f.membership, guestID, groups.ReactivateMemberInput{DisplayName: "Renamed Lifecycle Guest", RoleIDs: []string{}})
	if err != nil || reactivatedGuest.ID != guestID || !reactivatedGuest.IsTemporaryGuest || reactivatedGuest.DisplayName != "Renamed Lifecycle Guest" {
		t.Fatalf("reactivate temporary guest=%#v err=%v", reactivatedGuest, err)
	}
	if err := f.groups.ArchiveMember(f.ctx, f.admin, f.membership, guestID, false); err != nil {
		t.Fatalf("archive temporary guest before deletion: %v", err)
	}
	if err := f.groups.PermanentlyDeleteMember(f.ctx, f.admin, f.membership, guestID); err != nil {
		t.Fatalf("permanently delete temporary guest: %v", err)
	}
	var guestNameKey sql.NullString
	var deletedAt sql.NullString
	var guestActive bool
	if err := f.db.QueryRowContext(f.ctx, `SELECT m.temporary_guest_name_key,m.deleted_at,u.active FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.id=?`, guestID).
		Scan(&guestNameKey, &deletedAt, &guestActive); err != nil {
		t.Fatalf("load deleted temporary guest: %v", err)
	}
	if guestNameKey.Valid || !deletedAt.Valid || guestActive {
		t.Fatalf("deleted temporary guest key/deleted/active=%#v/%#v/%t", guestNameKey, deletedAt, guestActive)
	}

	_, regular, _ := f.inviteMember("reactivation-rules@example.test", "Reactivation Rules", nil)
	_, delegated, _ := f.inviteMember("reactivation-admin@example.test", "Reactivation Administrator", nil)
	delegated = f.assignPermissionRole(delegated, "Lifecycle administration", domain.PermissionMemberManagement)
	if err := f.groups.ArchiveMember(f.ctx, f.admin, f.membership, regular.ID, false); err != nil {
		t.Fatalf("archive role-rule member: %v", err)
	}
	defaultRoleID := authorization.TemplateRoleID(f.group.ID, domain.RoleTemplateMember)
	if _, err := f.groups.ReactivateMember(f.ctx, domain.Principal{UserID: delegated.UserID}, delegated, regular.ID, groups.ReactivateMemberInput{RoleIDs: []string{defaultRoleID}}); err != nil {
		t.Fatalf("delegated administrator default-role reactivation: %v", err)
	}
	if err := f.groups.ArchiveMember(f.ctx, f.admin, f.membership, regular.ID, false); err != nil {
		t.Fatalf("rearchive role-rule member: %v", err)
	}
	financeRoleID := authorization.TemplateRoleID(f.group.ID, domain.RoleTemplateFinance)
	if _, err := f.groups.ReactivateMember(f.ctx, domain.Principal{UserID: delegated.UserID}, delegated, regular.ID, groups.ReactivateMemberInput{RoleIDs: []string{defaultRoleID, financeRoleID}}); err != nil {
		t.Fatalf("delegated ordinary-role reactivation: %v", err)
	}
	if err := f.groups.ArchiveMember(f.ctx, f.admin, f.membership, regular.ID, false); err != nil {
		t.Fatalf("rearchive expanded-role member: %v", err)
	}
	adminRoleID := authorization.PresetRoleID(f.group.ID, domain.RolePresetGroupAdministrator)
	if _, err := f.groups.ReactivateMember(f.ctx, domain.Principal{UserID: delegated.UserID}, delegated, regular.ID, groups.ReactivateMemberInput{RoleIDs: []string{defaultRoleID, adminRoleID}}); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("delegated protected-role reactivation error=%v, want forbidden", err)
	}
	if err := f.groups.PermanentlyDeleteMember(f.ctx, f.admin, f.membership, regular.ID); err != nil {
		t.Fatalf("permanently delete zero-balance archived regular member: %v", err)
	}

	_, nonZero, _ := f.inviteMember("non-zero-delete@example.test", "Non-zero Delete", nil)
	if _, err := f.bookings.Create(f.ctx, f.admin, f.membership, "non-zero-delete-booking", bookings.CreateInput{
		ProductID: product.ID, ProductVersion: product.Version, ExpectedPeriodID: f.openPeriodID(), Quantity: 1,
		TargetMembershipID: nonZero.ID, Reason: "Non-zero deletion fixture",
	}); err != nil {
		t.Fatalf("book non-zero deletion fixture: %v", err)
	}
	if err := f.groups.ArchiveMember(f.ctx, f.admin, f.membership, nonZero.ID, false); err != nil {
		t.Fatalf("archive non-zero member: %v", err)
	}
	if err := f.groups.PermanentlyDeleteMember(f.ctx, f.admin, f.membership, nonZero.ID); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("non-zero permanent deletion error=%v, want conflict", err)
	}
}
