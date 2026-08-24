package integration_test

import (
	"context"
	"slices"
	"testing"

	"github.com/DasLukas/TeamTaler/internal/activities"
	"github.com/DasLukas/TeamTaler/internal/bookings"
	"github.com/DasLukas/TeamTaler/internal/catalog"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/finance"
)

func TestUnifiedActivityFeedAppliesIndependentVisibilityGrants(t *testing.T) {
	f := newFixture(t)
	service := activities.Service{DB: f.db}
	alicePrincipal, alice, _ := f.inviteMember("alice@example.test", "Alice", nil)
	bobPrincipal, bob, _ := f.inviteMember("bob@example.test", "Bob", nil)
	_, bookingViewer, _ := f.inviteMember("booking-viewer@example.test", "Booking Viewer", nil)
	bookingViewer = f.assignPermissionRole(bookingViewer, "View all bookings", domain.PermissionViewAllBookingActivity)
	_, financeViewer, _ := f.inviteMember("finance-viewer@example.test", "Finance Viewer", nil)
	financeViewer = f.assignPermissionRole(financeViewer, "View all finance activity", domain.PermissionFinanceManagement)
	category, product := f.catalogItem("Feed entries", 500)
	periodID := f.openPeriodID()

	aliceBooking, err := f.bookings.Create(f.ctx, alicePrincipal, alice, "alice-booking-feed", bookings.CreateInput{
		ProductID: product.ID, ProductVersion: product.Version, ExpectedPeriodID: periodID, Quantity: 1,
	})
	if err != nil {
		t.Fatalf("create Alice booking: %v", err)
	}
	if _, err := f.bookings.Create(f.ctx, bobPrincipal, bob, "bob-booking-feed", bookings.CreateInput{
		ProductID: product.ID, ProductVersion: product.Version, ExpectedPeriodID: periodID, Quantity: 1,
	}); err != nil {
		t.Fatalf("create Bob booking: %v", err)
	}
	alicePayment, err := f.finance.CreatePayment(f.ctx, f.admin, f.membership, "alice-payment-feed", finance.CreatePaymentInput{
		MembershipID: alice.ID, AmountMinor: 300, ReceivedAt: "2026-08-20T10:00:00Z", Method: "CASH", Reference: "Alice payment",
	})
	if err != nil {
		t.Fatalf("create Alice payment: %v", err)
	}
	if _, err := f.finance.CreatePayment(f.ctx, f.admin, f.membership, "bob-payment-feed", finance.CreatePaymentInput{
		MembershipID: bob.ID, AmountMinor: 400, ReceivedAt: "2026-08-20T11:00:00Z", Method: "CASH", Reference: "Bob payment",
	}); err != nil {
		t.Fatalf("create Bob payment: %v", err)
	}
	for _, adjustment := range []struct {
		id           string
		membershipID string
		amount       int64
	}{
		{id: "alice-feed-adjustment", membershipID: alice.ID, amount: 75},
		{id: "bob-feed-adjustment", membershipID: bob.ID, amount: -25},
	} {
		if _, err := f.db.ExecContext(f.ctx, `INSERT INTO ledger_entries(id,group_id,period_id,membership_id,account,amount_minor,description,created_at)
			VALUES(?,?,?,?,?,?,?,?)`, adjustment.id, f.group.ID, periodID, adjustment.membershipID, "MEMBER_RECEIVABLE", adjustment.amount, "Manual correction", "2026-08-20T12:00:00Z"); err != nil {
			t.Fatalf("create %s: %v", adjustment.id, err)
		}
	}
	archivedProduct, err := f.catalog.UpdateProduct(f.ctx, f.admin, f.membership, product.ID, catalog.UpdateProductInput{
		Name: product.Name, PriceMinor: product.PriceMinor, PricingMode: product.PricingMode,
		Active: false, SortOrder: product.SortOrder, Version: product.Version,
	})
	if err != nil {
		t.Fatalf("archive feed product: %v", err)
	}
	if err := f.catalog.DeleteProduct(f.ctx, f.admin, f.membership, product.ID, archivedProduct.Version); err != nil {
		t.Fatalf("delete feed product: %v", err)
	}

	assertActivityKinds(t, f.ctx, service, alice, map[activities.Kind]int{
		activities.KindBooking: 1, activities.KindPayment: 1, activities.KindAdjustment: 1,
	})
	assertActivityKinds(t, f.ctx, service, bookingViewer, map[activities.Kind]int{
		activities.KindBooking: 2,
	})
	assertActivityKinds(t, f.ctx, service, financeViewer, map[activities.Kind]int{
		activities.KindPayment: 2, activities.KindAdjustment: 2,
	})
	assertActivityKinds(t, f.ctx, service, f.membership, map[activities.Kind]int{
		activities.KindBooking: 2, activities.KindPayment: 2, activities.KindAdjustment: 2,
	})
	var alicePaymentCreatedAt string
	if err := f.db.QueryRowContext(f.ctx, `SELECT created_at FROM payments WHERE id=?`, alicePayment.ID).Scan(&alicePaymentCreatedAt); err != nil {
		t.Fatalf("read Alice payment creation time: %v", err)
	}
	adminPage, err := service.QueryEntries(f.ctx, f.membership, activities.Query{Limit: 20})
	if err != nil {
		t.Fatalf("query administrator activity feed: %v", err)
	}
	var alicePaymentEntry *activities.Entry
	for index := range adminPage.Items {
		if adminPage.Items[index].SourceID == alicePayment.ID {
			alicePaymentEntry = &adminPage.Items[index]
			break
		}
	}
	if alicePaymentEntry == nil || alicePaymentEntry.PaymentMethod != "CASH" || alicePaymentEntry.DetailName != "Cash" ||
		alicePaymentEntry.OccurredAt != alicePaymentCreatedAt || alicePaymentEntry.OccurredAt == alicePayment.ReceivedAt {
		t.Fatalf("Alice payment activity=%#v, createdAt=%q receivedAt=%q", alicePaymentEntry, alicePaymentCreatedAt, alicePayment.ReceivedAt)
	}

	aliceOptions, err := service.ListFilterOptions(f.ctx, alice)
	if err != nil || !slices.Equal(aliceOptions.Kinds, []activities.Kind{activities.KindBooking, activities.KindPayment, activities.KindAdjustment}) ||
		len(aliceOptions.Members) != 1 || aliceOptions.Members[0].MembershipID != alice.ID ||
		len(aliceOptions.Categories) != 1 || aliceOptions.Categories[0].CategoryID != category.ID ||
		len(aliceOptions.Products) != 1 || aliceOptions.Products[0].ProductID != product.ID {
		t.Fatalf("Alice filter options=%#v err=%v", aliceOptions, err)
	}
	bookingOptions, err := service.ListFilterOptions(f.ctx, bookingViewer)
	if err != nil || !slices.Equal(bookingOptions.Kinds, []activities.Kind{activities.KindBooking}) ||
		len(bookingOptions.Members) != 2 || len(bookingOptions.Categories) != 1 || len(bookingOptions.Products) != 1 {
		t.Fatalf("booking viewer filter options=%#v err=%v", bookingOptions, err)
	}
	financeOptions, err := service.ListFilterOptions(f.ctx, financeViewer)
	if err != nil || !slices.Equal(financeOptions.Kinds, []activities.Kind{activities.KindPayment, activities.KindAdjustment}) ||
		len(financeOptions.Members) != 2 || len(financeOptions.Categories) != 0 || len(financeOptions.Products) != 0 {
		t.Fatalf("finance viewer filter options=%#v err=%v", financeOptions, err)
	}

	if _, err := f.bookings.Void(f.ctx, f.admin, f.membership, "reverse-feed-booking", aliceBooking.ID, "Incorrect booking"); err != nil {
		t.Fatalf("reverse booking: %v", err)
	}
	if err := f.finance.ReversePayment(f.ctx, f.admin, f.membership, "reverse-feed-payment", alicePayment.ID, "Duplicate payment"); err != nil {
		t.Fatalf("reverse payment: %v", err)
	}
	page, err := service.QueryEntries(f.ctx, f.membership, activities.Query{Limit: 20})
	if err != nil || len(page.Items) != 6 {
		t.Fatalf("activities after reversals=%#v err=%v", page.Items, err)
	}
	reversed := 0
	for _, entry := range page.Items {
		if entry.Status == "REVERSED" {
			reversed++
		}
		if entry.Kind == activities.KindAdjustment && entry.SourceID != "alice-feed-adjustment" && entry.SourceID != "bob-feed-adjustment" {
			t.Fatalf("reversal ledger entry leaked into feed: %#v", entry)
		}
	}
	if reversed != 2 {
		t.Fatalf("reversed originals=%d, want 2", reversed)
	}
}

func TestUnifiedActivityFeedPaginatesFiftyBookingsAndOnePaymentWithoutLoss(t *testing.T) {
	f := newFixture(t)
	service := activities.Service{DB: f.db}
	memberPrincipal, member, _ := f.inviteMember("pagination@example.test", "Pagination Member", nil)
	_, product := f.catalogItem("Pagination", 100)
	periodID := f.openPeriodID()
	for index := 0; index < 50; index++ {
		if _, err := f.bookings.Create(f.ctx, memberPrincipal, member, "pagination-booking-"+twoDigit(index), bookings.CreateInput{
			ProductID: product.ID, ProductVersion: product.Version, ExpectedPeriodID: periodID, Quantity: 1,
		}); err != nil {
			t.Fatalf("create booking %d: %v", index, err)
		}
	}
	if _, err := f.finance.CreatePayment(f.ctx, f.admin, f.membership, "pagination-payment", finance.CreatePaymentInput{
		MembershipID: member.ID, AmountMinor: 250, ReceivedAt: "2026-08-20T10:00:00Z", Method: "CASH",
	}); err != nil {
		t.Fatalf("create payment: %v", err)
	}

	first, err := service.QueryEntries(f.ctx, member, activities.Query{Limit: 50})
	if err != nil || len(first.Items) != 50 || first.NextCursor == "" {
		t.Fatalf("first page count=%d cursor=%q err=%v", len(first.Items), first.NextCursor, err)
	}
	second, err := service.QueryEntries(f.ctx, member, activities.Query{Limit: 50, Cursor: first.NextCursor})
	if err != nil || len(second.Items) != 1 || second.NextCursor != "" {
		t.Fatalf("second page count=%d cursor=%q err=%v", len(second.Items), second.NextCursor, err)
	}
	seen := make(map[string]struct{}, 51)
	for _, entry := range append(first.Items, second.Items...) {
		if _, exists := seen[entry.ID]; exists {
			t.Fatalf("duplicate activity %s", entry.ID)
		}
		seen[entry.ID] = struct{}{}
	}
	if len(seen) != 51 {
		t.Fatalf("unique activities=%d, want 51", len(seen))
	}
	if _, err := service.QueryEntries(f.ctx, member, activities.Query{Limit: 50, Cursor: first.NextCursor, Kinds: []string{"PAYMENT"}}); err == nil {
		t.Fatal("cursor with a different filter fingerprint should fail")
	}
}

func assertActivityKinds(t *testing.T, ctx context.Context, service activities.Service, membership domain.Membership, want map[activities.Kind]int) {
	t.Helper()
	page, err := service.QueryEntries(ctx, membership, activities.Query{Limit: 50})
	if err != nil {
		t.Fatalf("query activities for %s: %v", membership.DisplayName, err)
	}
	got := make(map[activities.Kind]int)
	for _, entry := range page.Items {
		got[entry.Kind]++
	}
	if len(page.Items) != totalActivityKinds(want) {
		t.Fatalf("activities for %s=%#v, want counts %#v", membership.DisplayName, got, want)
	}
	for kind, count := range want {
		if got[kind] != count {
			t.Fatalf("activities for %s=%#v, want counts %#v", membership.DisplayName, got, want)
		}
	}
}

func totalActivityKinds(counts map[activities.Kind]int) int {
	total := 0
	for _, count := range counts {
		total += count
	}
	return total
}

func twoDigit(value int) string {
	return string(rune('0'+value/10)) + string(rune('0'+value%10))
}
