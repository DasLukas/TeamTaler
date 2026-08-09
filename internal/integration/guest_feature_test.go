package integration_test

import (
	"database/sql"
	"errors"
	"sort"
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

func TestTemporaryGuestBatchCreationIsAtomicIdempotentAndTenantScoped(t *testing.T) {
	f := newFixture(t)
	_, product := f.catalogItem("Temporary guest items", 275)
	command := bookings.BatchCreateInput{
		ProductID:                  product.ID,
		ProductVersion:             product.Version,
		ExpectedPeriodID:           f.openPeriodID(),
		Quantity:                   2,
		TemporaryGuestDisplayNames: []string{" Walk-In Guest "},
	}
	created, err := f.bookings.CreateBatch(f.ctx, f.admin, f.membership, "temporary-guest-batch-1", command)
	if err != nil || len(created) != 1 || created[0].TargetDisplayName != "Walk-In Guest" || created[0].Reason != "" {
		t.Fatalf("create temporary guest booking: bookings=%#v err=%v", created, err)
	}
	replayed, err := f.bookings.CreateBatch(f.ctx, f.admin, f.membership, "temporary-guest-batch-1", command)
	if err != nil || len(replayed) != 1 || replayed[0].ID != created[0].ID {
		t.Fatalf("replay temporary guest booking: bookings=%#v err=%v", replayed, err)
	}

	var guestMembershipID string
	var email, password sql.NullString
	var roleCount, bookingCount int
	if err := f.db.QueryRowContext(f.ctx, `SELECT m.id,u.email,u.password_hash,
		(SELECT count(*) FROM membership_role_assignments assignment WHERE assignment.group_id=m.group_id AND assignment.membership_id=m.id),
		(SELECT count(*) FROM bookings booking WHERE booking.group_id=m.group_id AND booking.target_membership_id=m.id)
		FROM memberships m JOIN users u ON u.id=m.user_id
		WHERE m.group_id=? AND m.temporary_guest_name_key='walk-in guest'`, f.membership.GroupID).
		Scan(&guestMembershipID, &email, &password, &roleCount, &bookingCount); err != nil {
		t.Fatalf("load temporary guest: %v", err)
	}
	if email.Valid || password.Valid || roleCount != 0 || bookingCount != 1 {
		t.Fatalf("temporary guest credentials/roles/bookings=email:%#v password:%#v roles:%d bookings:%d", email, password, roleCount, bookingCount)
	}
	var balance int64
	if err := f.db.QueryRowContext(f.ctx, `SELECT coalesce(sum(amount_minor),0) FROM ledger_entries WHERE group_id=? AND membership_id=? AND account='MEMBER_RECEIVABLE'`, f.membership.GroupID, guestMembershipID).Scan(&balance); err != nil || balance != 550 {
		t.Fatalf("temporary guest balance=%d err=%v, want 550", balance, err)
	}

	conflicting := command
	conflicting.TemporaryGuestDisplayNames = []string{"Fresh Guest", "walk-in GUEST"}
	if _, err := f.bookings.CreateBatch(f.ctx, f.admin, f.membership, "temporary-guest-batch-2", conflicting); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("duplicate temporary guest name error=%v, want conflict", err)
	}
	var freshGuests int
	if err := f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM memberships WHERE group_id=? AND temporary_guest_name_key='fresh guest'`, f.membership.GroupID).Scan(&freshGuests); err != nil || freshGuests != 0 {
		t.Fatalf("rolled-back temporary guest count=%d err=%v, want zero", freshGuests, err)
	}

	secondGroup, err := f.groups.Create(f.ctx, f.admin, "Temporary Guest Tenant", "EUR")
	if err != nil {
		t.Fatalf("create second tenant: %v", err)
	}
	crossTenant := command
	crossTenant.TargetMembershipIDs = []string{secondGroup.Membership.ID}
	crossTenant.TemporaryGuestDisplayNames = []string{"Cross-Tenant Rollback Guest"}
	if _, err := f.bookings.CreateBatch(f.ctx, f.admin, f.membership, "temporary-guest-cross-tenant", crossTenant); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("cross-tenant target error=%v, want not found", err)
	}
	var crossTenantGuests int
	if err := f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM memberships WHERE group_id=? AND temporary_guest_name_key='cross-tenant rollback guest'`, f.membership.GroupID).Scan(&crossTenantGuests); err != nil || crossTenantGuests != 0 {
		t.Fatalf("cross-tenant rollback count=%d err=%v, want zero", crossTenantGuests, err)
	}

	renamed, err := f.groups.RenameTemporaryGuest(f.ctx, f.admin, f.membership, guestMembershipID, "Renamed Guest")
	if err != nil || renamed.ID != guestMembershipID || renamed.DisplayName != "Renamed Guest" || !renamed.IsTemporaryGuest {
		t.Fatalf("rename temporary guest: membership=%#v err=%v", renamed, err)
	}
}

func TestBookingPermissionsFilterCredentialClassesIndependently(t *testing.T) {
	f := newFixture(t)
	_, product := f.catalogItem("Permission matrix", 100)
	guestBooking, err := f.bookings.CreateBatch(f.ctx, f.admin, f.membership, "permission-matrix-guest", bookings.BatchCreateInput{
		ProductID: product.ID, ProductVersion: product.Version, ExpectedPeriodID: f.openPeriodID(), Quantity: 1,
		TemporaryGuestDisplayNames: []string{"Permission Guest"},
	})
	if err != nil {
		t.Fatalf("seed temporary guest: %v", err)
	}
	regularPrincipal, regularMembership, _ := f.inviteMember("regular-target@example.test", "Regular Target", nil)
	_ = regularPrincipal

	tests := []struct {
		name         string
		permissions  []domain.PermissionKey
		wantSelf     bool
		wantRegular  bool
		wantGuest    bool
		canBookGuest bool
	}{
		{name: "own only", permissions: []domain.PermissionKey{domain.PermissionCreateOwnBooking}, wantSelf: true},
		{name: "others only", permissions: []domain.PermissionKey{domain.PermissionBookForOthers}, wantRegular: true},
		{name: "guests only", permissions: []domain.PermissionKey{domain.PermissionBookForGuests}, wantGuest: true, canBookGuest: true},
		{name: "all booking targets", permissions: []domain.PermissionKey{domain.PermissionCreateOwnBooking, domain.PermissionBookForOthers, domain.PermissionBookForGuests}, wantSelf: true, wantRegular: true, wantGuest: true, canBookGuest: true},
	}
	for index, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			principal, membership, _ := f.inviteMember("matrix-"+string(rune('a'+index))+"@example.test", "Matrix Actor "+string(rune('A'+index)), nil)
			membership = replaceWithExactPermissionRole(t, f, membership, "Matrix "+test.name, test.permissions...)
			context, err := f.bookings.Context(f.ctx, membership)
			if err != nil {
				t.Fatalf("load booking context: %v", err)
			}
			foundSelf, foundRegular, foundGuest := false, false, false
			for _, target := range context.Targets {
				switch target.MembershipID {
				case membership.ID:
					foundSelf = true
				case regularMembership.ID:
					foundRegular = true
				case guestBooking[0].TargetMembershipID:
					foundGuest = target.IsTemporaryGuest
				}
			}
			if foundSelf != test.wantSelf || foundRegular != test.wantRegular || foundGuest != test.wantGuest || context.CanBookForGuests != test.canBookGuest {
				t.Fatalf("context targets=%#v canBookForGuests=%v", context.Targets, context.CanBookForGuests)
			}

			guestCommand := bookings.BatchCreateInput{ProductID: product.ID, ProductVersion: product.Version, ExpectedPeriodID: f.openPeriodID(), Quantity: 1, TargetMembershipIDs: []string{guestBooking[0].TargetMembershipID}}
			_, guestErr := f.bookings.CreateBatch(f.ctx, principal, membership, "matrix-existing-guest-"+string(rune('a'+index)), guestCommand)
			if test.wantGuest && guestErr != nil {
				t.Fatalf("book existing temporary guest: %v", guestErr)
			}
			if !test.wantGuest && !errors.Is(guestErr, domain.ErrForbidden) {
				t.Fatalf("existing temporary guest error=%v, want forbidden", guestErr)
			}

			_, singleGuestErr := f.bookings.Create(f.ctx, principal, membership, "matrix-single-guest-"+string(rune('a'+index)), bookings.CreateInput{
				ProductID: product.ID, ProductVersion: product.Version, ExpectedPeriodID: f.openPeriodID(), Quantity: 1,
				TargetMembershipID: guestBooking[0].TargetMembershipID,
			})
			if test.wantGuest && singleGuestErr != nil {
				t.Fatalf("single booking for temporary guest: %v", singleGuestErr)
			}
			if !test.wantGuest && !errors.Is(singleGuestErr, domain.ErrForbidden) {
				t.Fatalf("single temporary guest error=%v, want forbidden", singleGuestErr)
			}
		})
	}
}

func TestMixedBatchRequiresReasonOnlyForCredentialedForeignTargets(t *testing.T) {
	f := newFixture(t)
	_, product := f.catalogItem("Mixed permission batch", 150)
	_, regularMembership, _ := f.inviteMember("mixed-target@example.test", "Mixed Target", nil)
	existingGuest, err := f.bookings.CreateBatch(f.ctx, f.admin, f.membership, "mixed-existing-guest", bookings.BatchCreateInput{
		ProductID: product.ID, ProductVersion: product.Version, ExpectedPeriodID: f.openPeriodID(), Quantity: 1,
		TemporaryGuestDisplayNames: []string{"Existing Mixed Guest"},
	})
	if err != nil {
		t.Fatalf("create existing temporary guest: %v", err)
	}
	command := bookings.BatchCreateInput{
		ProductID: product.ID, ProductVersion: product.Version, ExpectedPeriodID: f.openPeriodID(), Quantity: 1,
		TargetMembershipIDs:        []string{f.membership.ID, regularMembership.ID, existingGuest[0].TargetMembershipID},
		TemporaryGuestDisplayNames: []string{"New Mixed Guest"},
	}
	if _, err := f.bookings.CreateBatch(f.ctx, f.admin, f.membership, "mixed-without-reason", command); !errors.As(err, new(domain.ValidationError)) {
		t.Fatalf("mixed batch without reason error=%v, want validation", err)
	}
	var rolledBack int
	if err := f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM memberships WHERE group_id=? AND temporary_guest_name_key='new mixed guest'`, f.membership.GroupID).Scan(&rolledBack); err != nil || rolledBack != 0 {
		t.Fatalf("mixed batch rollback count=%d err=%v", rolledBack, err)
	}
	command.Reason = "Shared order"
	created, err := f.bookings.CreateBatch(f.ctx, f.admin, f.membership, "mixed-with-reason", command)
	if err != nil || len(created) != 4 {
		t.Fatalf("mixed batch=%#v err=%v, want four bookings", created, err)
	}
}

func TestTemporaryGuestClaimPreservesHistoryAndAppliesSelectedRoles(t *testing.T) {
	f := newFixture(t)
	_, product := f.catalogItem("Claim history", 125)
	created, err := f.bookings.CreateBatch(f.ctx, f.admin, f.membership, "temporary-claim-booking", bookings.BatchCreateInput{
		ProductID: product.ID, ProductVersion: product.Version, ExpectedPeriodID: f.openPeriodID(), Quantity: 1,
		TemporaryGuestDisplayNames: []string{"Claimable Guest"},
	})
	if err != nil {
		t.Fatalf("create claimable temporary guest: %v", err)
	}
	guestMembershipID := created[0].TargetMembershipID
	var originalUserID string
	if err := f.db.QueryRowContext(f.ctx, `SELECT user_id FROM memberships WHERE id=?`, guestMembershipID).Scan(&originalUserID); err != nil {
		t.Fatalf("load original temporary identity: %v", err)
	}
	memberRoleID := authorization.PresetRoleID(f.membership.GroupID, domain.RolePresetMember)
	financeRoleID := authorization.PresetRoleID(f.membership.GroupID, domain.RolePresetFinanceManager)
	invitation, err := f.groups.CreateTemporaryGuestClaimInvitation(f.ctx, f.admin, f.membership, guestMembershipID, "claimed@example.test", []string{memberRoleID, financeRoleID})
	if err != nil || invitation.Token == "" {
		t.Fatalf("create claim invitation: invitation=%#v err=%v", invitation, err)
	}
	session, claimed, err := f.auth.AcceptInvitation(f.ctx, auth.InvitationAcceptance{Token: invitation.Token, Password: testPassword})
	if err != nil {
		t.Fatalf("accept claim invitation: %v", err)
	}
	if claimed.ID != guestMembershipID || claimed.UserID != originalUserID || session.Principal.UserID != originalUserID || claimed.IsTemporaryGuest {
		t.Fatalf("claim changed stable identity or retained guest state: session=%#v membership=%#v", session, claimed)
	}
	sort.Strings(claimed.RoleIDs)
	wantRoles := []string{financeRoleID, memberRoleID}
	sort.Strings(wantRoles)
	if len(claimed.RoleIDs) != len(wantRoles) || claimed.RoleIDs[0] != wantRoles[0] || claimed.RoleIDs[1] != wantRoles[1] {
		t.Fatalf("claimed roles=%v, want exactly %v", claimed.RoleIDs, wantRoles)
	}
	var nameKey sql.NullString
	if err := f.db.QueryRowContext(f.ctx, `SELECT temporary_guest_name_key FROM memberships WHERE id=?`, claimed.ID).Scan(&nameKey); err != nil || nameKey.Valid {
		t.Fatalf("claimed temporary guest name key=%#v err=%v, want NULL", nameKey, err)
	}
	account, err := f.finance.Account(f.ctx, claimed, claimed.ID)
	if err != nil || account.BalanceMinor != 125 {
		t.Fatalf("claimed account=%#v err=%v", account, err)
	}
}

func TestClaimWithoutRoleManagementAllowsOnlyCurrentDefaultRole(t *testing.T) {
	f := newFixture(t)
	_, product := f.catalogItem("Delegated claim", 100)
	created, err := f.bookings.CreateBatch(f.ctx, f.admin, f.membership, "delegated-claim-guest", bookings.BatchCreateInput{
		ProductID: product.ID, ProductVersion: product.Version, ExpectedPeriodID: f.openPeriodID(), Quantity: 1,
		TemporaryGuestDisplayNames: []string{"Delegated Claim Guest"},
	})
	if err != nil {
		t.Fatalf("create delegated claim guest: %v", err)
	}
	principal, administrator, _ := f.inviteMember("delegated-claim-admin@example.test", "Delegated Claim Admin", nil)
	administrator = f.assignPermissionRole(administrator, "Delegated claim administration", domain.PermissionGroupAdministration)
	memberRoleID := authorization.PresetRoleID(f.membership.GroupID, domain.RolePresetMember)
	financeRoleID := authorization.PresetRoleID(f.membership.GroupID, domain.RolePresetFinanceManager)
	if _, err := f.groups.CreateTemporaryGuestClaimInvitation(f.ctx, principal, administrator, created[0].TargetMembershipID, "rejected@example.test", []string{memberRoleID, financeRoleID}); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("delegated expanded claim roles error=%v, want forbidden", err)
	}
	claim, err := f.groups.CreateTemporaryGuestClaimInvitation(f.ctx, principal, administrator, created[0].TargetMembershipID, "delegated@example.test", []string{memberRoleID})
	if err != nil || len(claim.RoleIDs) != 1 || claim.RoleIDs[0] != memberRoleID {
		t.Fatalf("delegated default-role claim=%#v err=%v", claim, err)
	}
}

func TestTemporaryGuestPaymentReversalPeriodCloseAndArchivePreserveHistory(t *testing.T) {
	f := newFixture(t)
	if _, err := f.db.ExecContext(f.ctx, `UPDATE group_settings SET notification_emails_enabled=1 WHERE group_id=?`, f.membership.GroupID); err != nil {
		t.Fatalf("enable notification emails: %v", err)
	}
	notifier := notifications.Service{DB: f.db, EmailDeliveryAvailable: true}
	f.bookings.Notifications = notifier
	f.finance.Notifications = notifier
	f.periods.Notifications = notifier

	_, product := f.catalogItem("Temporary guest lifecycle", 200)
	periodID := f.openPeriodID()
	created, err := f.bookings.CreateBatch(f.ctx, f.admin, f.membership, "temporary-guest-finance", bookings.BatchCreateInput{
		ProductID: product.ID, ProductVersion: product.Version, ExpectedPeriodID: periodID, Quantity: 1,
		TargetMembershipIDs: []string{f.membership.ID}, TemporaryGuestDisplayNames: []string{"Financial Guest"},
	})
	if err != nil || len(created) != 2 {
		t.Fatalf("mixed temporary guest batch=%#v err=%v", created, err)
	}
	guestMembershipID := created[1].TargetMembershipID
	assertBalance := func(want int64) {
		t.Helper()
		account, err := f.finance.Account(f.ctx, f.membership, guestMembershipID)
		if err != nil || account.BalanceMinor != want {
			t.Fatalf("temporary guest balance=%d err=%v, want %d", account.BalanceMinor, err, want)
		}
	}
	assertBalance(200)
	payment, err := f.finance.CreatePayment(f.ctx, f.admin, f.membership, "temporary-guest-payment", finance.CreatePaymentInput{MembershipID: guestMembershipID, AmountMinor: 75, Method: "CASH", Reference: "Guest payment"})
	if err != nil {
		t.Fatalf("create temporary guest payment: %v", err)
	}
	assertBalance(125)
	if err := f.finance.ReversePayment(f.ctx, f.admin, f.membership, "temporary-guest-payment-reversal", payment.ID, "Payment correction"); err != nil {
		t.Fatalf("reverse temporary guest payment: %v", err)
	}
	if _, err := f.bookings.Void(f.ctx, f.admin, f.membership, "temporary-guest-booking-reversal", created[1].ID, "Booking correction"); err != nil {
		t.Fatalf("reverse temporary guest booking: %v", err)
	}
	assertBalance(0)

	closed, err := f.periods.Close(f.ctx, f.admin, f.membership, "temporary-guest-period-close", periodID, periods.CloseInput{Label: "Temporary guest lifecycle", DueAt: "2099-01-01", NextPeriodLabel: "Next period"})
	if err != nil || closed.Statements != 2 {
		t.Fatalf("close temporary guest period=%#v err=%v", closed, err)
	}
	statements, err := f.periods.Statements(f.ctx, f.membership, periodID)
	if err != nil {
		t.Fatalf("list statements: %v", err)
	}
	var guestStatement *domain.Statement
	for index := range statements {
		if statements[index].MembershipID == guestMembershipID {
			guestStatement = &statements[index]
			break
		}
	}
	if guestStatement == nil || guestStatement.Email != nil || guestStatement.AmountDueMinor != 0 {
		t.Fatalf("temporary guest statement=%#v", guestStatement)
	}
	var notificationCount, outboxCount int
	if err := f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM notifications WHERE membership_id=?`, guestMembershipID).Scan(&notificationCount); err != nil {
		t.Fatalf("count temporary guest notifications: %v", err)
	}
	if err := f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM notification_email_outbox WHERE group_id=? AND notification_id IN (SELECT id FROM notifications WHERE membership_id=?)`, f.membership.GroupID, guestMembershipID).Scan(&outboxCount); err != nil {
		t.Fatalf("count temporary guest email jobs: %v", err)
	}
	if notificationCount == 0 || outboxCount != 0 {
		t.Fatalf("temporary guest notifications/outbox=%d/%d, want internal notifications and no email", notificationCount, outboxCount)
	}
	if err := f.groups.ArchiveMember(f.ctx, f.admin, f.membership, guestMembershipID, false); err != nil {
		t.Fatalf("archive temporary guest: %v", err)
	}
	var preservedBookings, preservedLedger, preservedStatements int
	if err := f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM bookings WHERE target_membership_id=?`, guestMembershipID).Scan(&preservedBookings); err != nil {
		t.Fatalf("count preserved bookings: %v", err)
	}
	if err := f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM ledger_entries WHERE membership_id=?`, guestMembershipID).Scan(&preservedLedger); err != nil {
		t.Fatalf("count preserved ledger: %v", err)
	}
	if err := f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM period_statements WHERE membership_id=?`, guestMembershipID).Scan(&preservedStatements); err != nil {
		t.Fatalf("count preserved statements: %v", err)
	}
	if preservedBookings != 1 || preservedLedger == 0 || preservedStatements != 1 {
		t.Fatalf("preserved bookings/ledger/statements=%d/%d/%d", preservedBookings, preservedLedger, preservedStatements)
	}
}

func replaceWithExactPermissionRole(t *testing.T, f *fixture, membership domain.Membership, name string, permissions ...domain.PermissionKey) domain.Membership {
	t.Helper()
	grants := make([]domain.PermissionGrant, 0, len(permissions))
	for _, permission := range permissions {
		grants = append(grants, domain.PermissionGrant{Permission: permission, Scope: domain.PermissionScope{Type: domain.PermissionScopeGroup}})
	}
	role, err := f.groups.CreateRole(f.ctx, f.admin, f.membership, groups.RoleCommand{Name: name, Grants: grants})
	if err != nil {
		t.Fatalf("create exact permission role: %v", err)
	}
	if _, err := f.groups.ReplaceMemberRoles(f.ctx, f.admin, f.membership, membership.ID, []string{role.ID}, membership.RoleAssignmentsVersion); err != nil {
		t.Fatalf("replace exact permission role: %v", err)
	}
	updated, err := f.groups.MembershipForUser(f.ctx, membership.GroupID, membership.UserID)
	if err != nil {
		t.Fatalf("reload exact permission role: %v", err)
	}
	return updated
}
