package integration_test

import (
	"errors"
	"fmt"
	"testing"

	"github.com/DasLukas/TeamTaler/internal/bookings"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/finance"
)

func TestBookingBulkCreatesCartesianCartAtomicallyAndReplays(t *testing.T) {
	f := newFixture(t)
	_, target, _ := f.inviteMember("bulk-target@example.test", "Bulk Target", nil)
	_, firstProduct := f.catalogItem("Bulk drinks", 125)
	_, secondProduct := f.catalogItem("Bulk snacks", 350)
	input := bookings.BulkCreateInput{
		ExpectedPeriodID: f.openPeriodID(),
		Items: []bookings.BulkCreateItem{
			{ProductID: firstProduct.ID, ProductVersion: firstProduct.Version, Quantity: 2},
			{ProductID: secondProduct.ID, ProductVersion: secondProduct.Version, Quantity: 1},
		},
		TargetMembershipIDs:        []string{f.membership.ID, target.ID},
		TemporaryGuestDisplayNames: []string{"Matchday Guest"},
		Reason:                     "Shared matchday cart",
	}

	created, err := f.bookings.CreateBulk(f.ctx, f.admin, f.membership, "bulk-cart-create-one", input)
	if err != nil {
		t.Fatalf("create bulk cart: %v", err)
	}
	if len(created) != 6 {
		t.Fatalf("created bookings = %d, want 6", len(created))
	}
	guestID := created[2].TargetMembershipID
	wantProducts := []string{firstProduct.ID, firstProduct.ID, firstProduct.ID, secondProduct.ID, secondProduct.ID, secondProduct.ID}
	wantTargets := []string{f.membership.ID, target.ID, guestID, f.membership.ID, target.ID, guestID}
	wantTotals := []int64{250, 250, 250, 350, 350, 350}
	for index, booking := range created {
		if booking.ProductID != wantProducts[index] || booking.TargetMembershipID != wantTargets[index] || booking.TotalMinor != wantTotals[index] || booking.Reason != input.Reason {
			t.Fatalf("created booking %d = %#v", index, booking)
		}
		var ledgerTotal int64
		if err := f.db.QueryRowContext(f.ctx, `SELECT sum(amount_minor) FROM ledger_entries WHERE booking_id=?`, booking.ID).Scan(&ledgerTotal); err != nil || ledgerTotal != 0 {
			t.Fatalf("booking %s ledger sum = %d err=%v, want zero", booking.ID, ledgerTotal, err)
		}
	}
	if guestID == "" || created[2].TargetDisplayName != "Matchday Guest" || created[5].TargetMembershipID != guestID {
		t.Fatalf("temporary guest was not reused across cart lines: %#v %#v", created[2], created[5])
	}
	var notificationCount int
	if err := f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM notifications WHERE resource_type='booking' AND resource_id IN (?,?,?,?,?,?)`,
		created[0].ID, created[1].ID, created[2].ID, created[3].ID, created[4].ID, created[5].ID).Scan(&notificationCount); err != nil || notificationCount != 4 {
		t.Fatalf("bulk notifications = %d err=%v, want 4", notificationCount, err)
	}

	replayed, err := f.bookings.CreateBulk(f.ctx, f.admin, f.membership, "bulk-cart-create-one", input)
	if err != nil || len(replayed) != len(created) {
		t.Fatalf("replay bulk cart: bookings=%#v err=%v", replayed, err)
	}
	for index := range created {
		if replayed[index].ID != created[index].ID {
			t.Fatalf("replayed booking %d ID = %s, want %s", index, replayed[index].ID, created[index].ID)
		}
	}
	changed := input
	changed.Items = append([]bookings.BulkCreateItem(nil), input.Items...)
	changed.Items[0].Quantity = 3
	if _, err := f.bookings.CreateBulk(f.ctx, f.admin, f.membership, "bulk-cart-create-one", changed); !errors.Is(err, domain.ErrIdempotencyReuse) {
		t.Fatalf("changed bulk replay error = %v, want idempotency reuse", err)
	}
}

func TestBookingBulkReplaySurvivesPermissionAndTargetLifecycleChanges(t *testing.T) {
	f := newFixture(t)
	delegatePrincipal, delegate, _ := f.inviteMember("bulk-delegate@example.test", "Bulk Delegate", nil)
	_, target, _ := f.inviteMember("bulk-replay-target@example.test", "Bulk Replay Target", nil)
	_, product := f.catalogItem("Bulk replay", 200)
	baseRoleIDs := append([]string(nil), delegate.RoleIDs...)
	delegate = f.assignPermissionRole(delegate, "Bulk booking delegates", domain.PermissionBookForOthers)
	input := bookings.BulkCreateInput{
		ExpectedPeriodID:    f.openPeriodID(),
		Items:               []bookings.BulkCreateItem{{ProductID: product.ID, ProductVersion: product.Version, Quantity: 1}},
		TargetMembershipIDs: []string{target.ID},
		Reason:              "Delegated purchase",
	}
	created, err := f.bookings.CreateBulk(f.ctx, delegatePrincipal, delegate, "bulk-replay-lifecycle", input)
	if err != nil || len(created) != 1 {
		t.Fatalf("create delegated bulk cart: bookings=%#v err=%v", created, err)
	}
	if _, err := f.groups.ReplaceMemberRoles(f.ctx, f.admin, f.membership, delegate.ID, baseRoleIDs, delegate.RoleAssignmentsVersion); err != nil {
		t.Fatalf("revoke bulk delegate permission: %v", err)
	}
	replayed, err := f.bookings.CreateBulk(f.ctx, delegatePrincipal, delegate, "bulk-replay-lifecycle", input)
	if err != nil || len(replayed) != 1 || replayed[0].ID != created[0].ID {
		t.Fatalf("replay after permission revocation: bookings=%#v err=%v", replayed, err)
	}
	if _, err := f.bookings.CreateBulk(f.ctx, delegatePrincipal, delegate, "bulk-new-after-revocation", input); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("new cart after permission revocation error = %v, want forbidden", err)
	}
	if _, err := f.finance.CreatePayment(f.ctx, f.admin, f.membership, "bulk-replay-target-settlement", finance.CreatePaymentInput{
		MembershipID: target.ID,
		AmountMinor:  200,
		ReceivedAt:   "2026-08-12T12:00:00Z",
		Method:       "CASH",
		Reference:    "Bulk replay lifecycle settlement",
	}); err != nil {
		t.Fatalf("settle replay target: %v", err)
	}
	if err := f.groups.ArchiveMember(f.ctx, f.admin, f.membership, target.ID, false); err != nil {
		t.Fatalf("archive replay target: %v", err)
	}
	replayed, err = f.bookings.CreateBulk(f.ctx, delegatePrincipal, delegate, "bulk-replay-lifecycle", input)
	if err != nil || len(replayed) != 1 || replayed[0].ID != created[0].ID || replayed[0].TargetMembershipStatus != created[0].TargetMembershipStatus {
		t.Fatalf("replay after target archive: bookings=%#v err=%v", replayed, err)
	}
	if _, err := f.bookings.CreateBulk(f.ctx, delegatePrincipal, delegate, "bulk-new-after-target-archive", input); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("new cart after target archive error = %v, want not found", err)
	}
}

func TestBookingBulkPreservesAuthorizationAndRollsBackInvalidCart(t *testing.T) {
	f := newFixture(t)
	memberPrincipal, member, _ := f.inviteMember("bulk-member@example.test", "Bulk Member", nil)
	_, product := f.catalogItem("Bulk validation", 200)
	periodID := f.openPeriodID()
	foreign := bookings.BulkCreateInput{
		ExpectedPeriodID:    periodID,
		Items:               []bookings.BulkCreateItem{{ProductID: product.ID, ProductVersion: product.Version, Quantity: 1}},
		TargetMembershipIDs: []string{f.membership.ID},
	}
	if _, err := f.bookings.CreateBulk(f.ctx, memberPrincipal, member, "bulk-cart-forbidden", foreign); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("unauthorized foreign bulk booking error = %v, want forbidden", err)
	}
	foreign.Reason = "Delegated purchase"
	if _, err := f.bookings.CreateBulk(f.ctx, f.admin, f.membership, "bulk-cart-without-reason", bookings.BulkCreateInput{
		ExpectedPeriodID:    periodID,
		Items:               foreign.Items,
		TargetMembershipIDs: []string{member.ID},
	}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("foreign bulk booking without reason error = %v, want validation", err)
	}
	stale := bookings.BulkCreateInput{
		ExpectedPeriodID:    periodID,
		Items:               []bookings.BulkCreateItem{{ProductID: product.ID, ProductVersion: product.Version + 1, Quantity: 1}},
		TargetMembershipIDs: []string{f.membership.ID},
	}
	if _, err := f.bookings.CreateBulk(f.ctx, f.admin, f.membership, "bulk-cart-stale-product", stale); !errors.Is(err, domain.ErrPrecondition) {
		t.Fatalf("stale product bulk error = %v, want precondition", err)
	}
	wrongPeriod := stale
	wrongPeriod.Items = []bookings.BulkCreateItem{{ProductID: product.ID, ProductVersion: product.Version, Quantity: 1}}
	wrongPeriod.ExpectedPeriodID = "per_wrong"
	if _, err := f.bookings.CreateBulk(f.ctx, f.admin, f.membership, "bulk-cart-stale-period", wrongPeriod); !errors.Is(err, domain.ErrPrecondition) {
		t.Fatalf("stale period bulk error = %v, want precondition", err)
	}

	var beforeBookings, beforeLedger, beforeMemberships int
	if err := f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM bookings WHERE group_id=?`, f.group.ID).Scan(&beforeBookings); err != nil {
		t.Fatalf("count bookings before invalid cart: %v", err)
	}
	if err := f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM ledger_entries WHERE group_id=?`, f.group.ID).Scan(&beforeLedger); err != nil {
		t.Fatalf("count ledger before invalid cart: %v", err)
	}
	if err := f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM memberships WHERE group_id=?`, f.group.ID).Scan(&beforeMemberships); err != nil {
		t.Fatalf("count memberships before invalid cart: %v", err)
	}
	invalid := bookings.BulkCreateInput{
		ExpectedPeriodID: periodID,
		Items: []bookings.BulkCreateItem{
			{ProductID: product.ID, ProductVersion: product.Version, Quantity: 1},
			{ProductID: "missing-product", ProductVersion: 1, Quantity: 1},
		},
		TemporaryGuestDisplayNames: []string{"Must Not Be Created"},
	}
	if _, err := f.bookings.CreateBulk(f.ctx, f.admin, f.membership, "bulk-cart-invalid-product", invalid); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("invalid product bulk error = %v, want not found", err)
	}
	var afterBookings, afterLedger, afterMemberships int
	if err := f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM bookings WHERE group_id=?`, f.group.ID).Scan(&afterBookings); err != nil {
		t.Fatalf("count bookings after invalid cart: %v", err)
	}
	if err := f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM ledger_entries WHERE group_id=?`, f.group.ID).Scan(&afterLedger); err != nil {
		t.Fatalf("count ledger after invalid cart: %v", err)
	}
	if err := f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM memberships WHERE group_id=?`, f.group.ID).Scan(&afterMemberships); err != nil {
		t.Fatalf("count memberships after invalid cart: %v", err)
	}
	if afterBookings != beforeBookings || afterLedger != beforeLedger || afterMemberships != beforeMemberships {
		t.Fatalf("invalid cart changed bookings/ledger/memberships from %d/%d/%d to %d/%d/%d", beforeBookings, beforeLedger, beforeMemberships, afterBookings, afterLedger, afterMemberships)
	}
}

func TestBookingBulkRejectsAmbiguousAndOversizedExpansion(t *testing.T) {
	f := newFixture(t)
	_, product := f.catalogItem("Bulk limits", 100)
	periodID := f.openPeriodID()
	emptyTargets := bookings.BulkCreateInput{
		ExpectedPeriodID: periodID,
		Items:            []bookings.BulkCreateItem{{ProductID: product.ID, ProductVersion: product.Version, Quantity: 1}},
	}
	if _, err := f.bookings.CreateBulk(f.ctx, f.admin, f.membership, "bulk-cart-empty-targets", emptyTargets); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("empty targets error = %v, want validation", err)
	}
	duplicate := bookings.BulkCreateInput{
		ExpectedPeriodID: periodID,
		Items: []bookings.BulkCreateItem{
			{ProductID: product.ID, ProductVersion: product.Version, Quantity: 1},
			{ProductID: product.ID, ProductVersion: product.Version, Quantity: 2},
		},
		TargetMembershipIDs: []string{f.membership.ID},
	}
	if _, err := f.bookings.CreateBulk(f.ctx, f.admin, f.membership, "bulk-cart-duplicate", duplicate); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("duplicate product error = %v, want validation", err)
	}

	tooManyItems := bookings.BulkCreateInput{ExpectedPeriodID: periodID, TargetMembershipIDs: []string{f.membership.ID}}
	for index := 0; index < 26; index++ {
		tooManyItems.Items = append(tooManyItems.Items, bookings.BulkCreateItem{ProductID: fmt.Sprintf("product-%d", index), ProductVersion: 1, Quantity: 1})
	}
	if _, err := f.bookings.CreateBulk(f.ctx, f.admin, f.membership, "bulk-cart-too-many-items", tooManyItems); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("too many cart items error = %v, want validation", err)
	}

	expanded := bookings.BulkCreateInput{ExpectedPeriodID: periodID}
	for index := 0; index < 6; index++ {
		expanded.Items = append(expanded.Items, bookings.BulkCreateItem{ProductID: fmt.Sprintf("expanded-product-%d", index), ProductVersion: 1, Quantity: 1})
	}
	for index := 0; index < 100; index++ {
		expanded.TargetMembershipIDs = append(expanded.TargetMembershipIDs, fmt.Sprintf("membership-%d", index))
	}
	if _, err := f.bookings.CreateBulk(f.ctx, f.admin, f.membership, "bulk-cart-expanded-limit", expanded); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("oversized expansion error = %v, want validation", err)
	}
}
