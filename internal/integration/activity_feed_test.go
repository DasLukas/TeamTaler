package integration_test

import (
	"context"
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/DasLukas/TeamTaler/internal/activities"
	"github.com/DasLukas/TeamTaler/internal/bookings"
	"github.com/DasLukas/TeamTaler/internal/catalog"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/finance"
	"github.com/DasLukas/TeamTaler/internal/groups"
	"github.com/DasLukas/TeamTaler/internal/platform"
)

func TestUnifiedActivityFeedAppliesIndependentVisibilityGrants(t *testing.T) {
	f := newFixture(t)
	service := activities.Service{DB: f.db}
	alicePrincipal, alice, _ := f.inviteMember("alice@example.test", "Alice", nil)
	bobPrincipal, bob, _ := f.inviteMember("bob@example.test", "Bob", nil)
	alice = f.assignPermissionRole(alice, "Book for other feed members", domain.PermissionBookForOthers, domain.PermissionVoidOwnBooking)
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
	if _, err := f.bookings.Create(f.ctx, alicePrincipal, alice, "alice-for-bob-booking-feed", bookings.CreateInput{
		ProductID: product.ID, ProductVersion: product.Version, ExpectedPeriodID: periodID, TargetMembershipID: bob.ID, Quantity: 1, Reason: "Recorded for Bob",
	}); err != nil {
		t.Fatalf("create Alice booking for Bob: %v", err)
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
		activities.KindBooking: 2, activities.KindPayment: 1, activities.KindAdjustment: 1,
	})
	assertActivityKinds(t, f.ctx, service, bob, map[activities.Kind]int{
		activities.KindBooking: 2, activities.KindPayment: 1, activities.KindAdjustment: 1,
	})
	assertActivityKinds(t, f.ctx, service, bookingViewer, map[activities.Kind]int{
		activities.KindBooking: 3,
	})
	assertActivityKinds(t, f.ctx, service, financeViewer, map[activities.Kind]int{
		activities.KindPayment: 2, activities.KindAdjustment: 2,
	})
	assertActivityKinds(t, f.ctx, service, f.membership, map[activities.Kind]int{
		activities.KindBooking: 3, activities.KindPayment: 2, activities.KindAdjustment: 2,
	})
	alicePage, err := service.QueryEntries(f.ctx, alice, activities.Query{Limit: 20})
	if err != nil {
		t.Fatalf("query Alice action metadata: %v", err)
	}
	if activityBySource(t, alicePage.Items, alicePayment.ID).CanReverse || !activityBySource(t, alicePage.Items, aliceBooking.ID).CanReverse {
		t.Fatalf("Alice received unsafe reversal metadata: %#v", alicePage.Items)
	}
	bookingViewerPage, err := service.QueryEntries(f.ctx, bookingViewer, activities.Query{Limit: 20})
	if err != nil {
		t.Fatalf("query booking viewer action metadata: %v", err)
	}
	for _, entry := range bookingViewerPage.Items {
		if entry.CanReverse {
			t.Fatalf("read-only booking viewer can reverse %#v", entry)
		}
	}
	financeViewerPage, err := service.QueryEntries(f.ctx, financeViewer, activities.Query{Limit: 20})
	if err != nil {
		t.Fatalf("query finance viewer action metadata: %v", err)
	}
	if !activityBySource(t, financeViewerPage.Items, alicePayment.ID).CanReverse || activityBySource(t, financeViewerPage.Items, "alice-feed-adjustment").CanReverse {
		t.Fatalf("finance viewer received incorrect reversal metadata: %#v", financeViewerPage.Items)
	}
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
		len(aliceOptions.Members) != 2 ||
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
	if err != nil || len(page.Items) != 7 {
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

func TestUnifiedActivityFeedFiltersSortsAndBindsCursorsToEveryQueryDimension(t *testing.T) {
	f := newFixture(t)
	service := activities.Service{DB: f.db}
	alicePrincipal, alice, _ := f.inviteMember("activity-filter-alice@example.test", "Alice Filter", nil)
	bobPrincipal, bob, _ := f.inviteMember("activity-filter-bob@example.test", "Bob Filter", nil)
	alphaCategory, alphaProduct := f.catalogItem("Alpha", 500)
	betaCategory, betaProduct := f.catalogItem("Beta", 200)
	periodID := f.openPeriodID()
	reasonMode := domain.ReasonModeOptional
	if _, err := f.groups.UpdateSettings(f.ctx, f.admin, f.membership, groups.SettingsUpdate{OwnBookingReasonMode: &reasonMode}); err != nil {
		t.Fatalf("enable optional own booking reasons: %v", err)
	}

	originalNow := platform.Now
	t.Cleanup(func() { platform.Now = originalNow })
	setNow := func(value string) {
		parsed, err := time.Parse(time.RFC3339, value)
		if err != nil {
			t.Fatalf("parse controlled activity time %q: %v", value, err)
		}
		platform.Now = func() time.Time { return parsed }
	}

	setNow("2026-08-20T08:00:00Z")
	aliceBooking, err := f.bookings.Create(f.ctx, alicePrincipal, alice, "filter-alice-booking", bookings.CreateInput{
		ProductID: alphaProduct.ID, ProductVersion: alphaProduct.Version, ExpectedPeriodID: periodID, Quantity: 1, Reason: "First practice",
	})
	if err != nil {
		t.Fatalf("create Alice filter booking: %v", err)
	}
	setNow("2026-08-20T09:00:00Z")
	bobBooking, err := f.bookings.Create(f.ctx, bobPrincipal, bob, "filter-bob-booking", bookings.CreateInput{
		ProductID: betaProduct.ID, ProductVersion: betaProduct.Version, ExpectedPeriodID: periodID, Quantity: 1, Reason: "Team event",
	})
	if err != nil {
		t.Fatalf("create Bob filter booking: %v", err)
	}
	setNow("2026-08-20T10:00:00Z")
	alicePayment, err := f.finance.CreatePayment(f.ctx, f.admin, f.membership, "filter-alice-payment", finance.CreatePaymentInput{
		MembershipID: alice.ID, AmountMinor: 300, ReceivedAt: "2026-08-01T00:00:00Z", Method: "CASH", Reference: "Monthly dues",
	})
	if err != nil {
		t.Fatalf("create Alice filter payment: %v", err)
	}
	setNow("2026-08-20T11:00:00Z")
	bobPayment, err := f.finance.CreatePayment(f.ctx, f.admin, f.membership, "filter-bob-payment", finance.CreatePaymentInput{
		MembershipID: bob.ID, AmountMinor: 400, ReceivedAt: "2026-08-02T00:00:00Z", Method: "BANK_TRANSFER", Reference: "Travel reimbursement",
	})
	if err != nil {
		t.Fatalf("create Bob filter payment: %v", err)
	}
	for _, adjustment := range []struct {
		id, membershipID, description, occurredAt string
		amount                                    int64
	}{
		{id: "filter-alice-adjustment", membershipID: alice.ID, description: "Manual credit", occurredAt: "2026-08-20T12:00:00Z", amount: 75},
		{id: "filter-bob-adjustment", membershipID: bob.ID, description: "Manual debit", occurredAt: "2026-08-20T13:00:00Z", amount: -25},
	} {
		if _, err := f.db.ExecContext(f.ctx, `INSERT INTO ledger_entries(id,group_id,period_id,membership_id,account,amount_minor,description,created_at)
			VALUES(?,?,?,?,?,?,?,?)`, adjustment.id, f.group.ID, periodID, adjustment.membershipID, "MEMBER_RECEIVABLE", adjustment.amount, adjustment.description, adjustment.occurredAt); err != nil {
			t.Fatalf("create filter adjustment %s: %v", adjustment.id, err)
		}
	}
	setNow("2026-08-20T14:00:00Z")
	if _, err := f.bookings.Void(f.ctx, f.admin, f.membership, "filter-reverse-bob-booking", bobBooking.ID, "Incorrect target"); err != nil {
		t.Fatalf("reverse Bob filter booking: %v", err)
	}
	setNow("2026-08-20T15:00:00Z")
	if err := f.finance.ReversePayment(f.ctx, f.admin, f.membership, "filter-reverse-alice-payment", alicePayment.ID, "Duplicate payment"); err != nil {
		t.Fatalf("reverse Alice filter payment: %v", err)
	}

	queries := []struct {
		name  string
		query activities.Query
		want  []string
	}{
		{name: "multiple kinds", query: activities.Query{Kinds: []string{"BOOKING", "PAYMENT"}}, want: []string{aliceBooking.ID, bobBooking.ID, alicePayment.ID, bobPayment.ID}},
		{name: "target member", query: activities.Query{TargetMembershipID: alice.ID}, want: []string{aliceBooking.ID, alicePayment.ID, "filter-alice-adjustment"}},
		{name: "category", query: activities.Query{CategoryIDs: []string{alphaCategory.ID}}, want: []string{aliceBooking.ID}},
		{name: "product", query: activities.Query{ProductIDs: []string{betaProduct.ID}}, want: []string{bobBooking.ID}},
		{name: "reversed status", query: activities.Query{Status: "REVERSED"}, want: []string{bobBooking.ID, alicePayment.ID}},
		{name: "creation time", query: activities.Query{OccurredFrom: "2026-08-20T09:30:00Z", OccurredTo: "2026-08-20T12:30:00Z"}, want: []string{alicePayment.ID, bobPayment.ID, "filter-alice-adjustment"}},
		{name: "signed amount window", query: activities.Query{AmountMin: activityAmount(-300), AmountMax: activityAmount(75)}, want: []string{alicePayment.ID, "filter-alice-adjustment", "filter-bob-adjustment"}},
		{name: "positive receivable effects", query: activities.Query{AmountMin: activityAmount(1)}, want: []string{aliceBooking.ID, bobBooking.ID, "filter-alice-adjustment"}},
		{name: "negative receivable effects", query: activities.Query{AmountMax: activityAmount(-1)}, want: []string{alicePayment.ID, bobPayment.ID, "filter-bob-adjustment"}},
		{name: "booking detail search", query: activities.Query{Search: "First practice"}, want: []string{aliceBooking.ID}},
		{name: "payment reference search", query: activities.Query{Search: "Monthly dues"}, want: []string{alicePayment.ID}},
		{name: "adjustment search", query: activities.Query{Search: "Manual debit"}, want: []string{"filter-bob-adjustment"}},
	}
	for _, testCase := range queries {
		t.Run(testCase.name, func(t *testing.T) {
			page, err := service.QueryEntries(f.ctx, f.membership, testCase.query)
			if err != nil {
				t.Fatalf("query unified activities: %v", err)
			}
			assertActivitySources(t, page.Items, testCase.want)
		})
	}

	ascending, err := service.QueryEntries(f.ctx, f.membership, activities.Query{Sort: "amount", Direction: "asc"})
	if err != nil {
		t.Fatalf("sort signed activity amounts ascending: %v", err)
	}
	descending, err := service.QueryEntries(f.ctx, f.membership, activities.Query{Sort: "amount", Direction: "desc"})
	if err != nil {
		t.Fatalf("sort signed activity amounts descending: %v", err)
	}
	wantAscending := []int64{-400, -300, -25, 75, 200, 500}
	for index, want := range wantAscending {
		if ascending.Items[index].AmountMinor != want || descending.Items[len(descending.Items)-1-index].AmountMinor != want {
			t.Fatalf("signed amount order asc=%v desc=%v", activityAmounts(ascending.Items), activityAmounts(descending.Items))
		}
	}
	chronological, err := service.QueryEntries(f.ctx, f.membership, activities.Query{Sort: "occurredAt", Direction: "asc"})
	if err != nil {
		t.Fatalf("sort unified chronology: %v", err)
	}
	assertActivitySources(t, chronological.Items, []string{aliceBooking.ID, bobBooking.ID, alicePayment.ID, bobPayment.ID, "filter-alice-adjustment", "filter-bob-adjustment"})
	if chronological.Items[1].Status != "REVERSED" || chronological.Items[2].Status != "REVERSED" || chronological.Items[1].AmountMinor != 200 || chronological.Items[2].AmountMinor != -300 {
		t.Fatalf("reversed originals changed chronology or amount: %#v", chronological.Items)
	}
	for _, sortKey := range []string{"kind", "targetName", "actorName", "detailName", "categoryName", "occurredAt", "amount", "status"} {
		ascendingPage, err := service.QueryEntries(f.ctx, f.membership, activities.Query{Sort: sortKey, Direction: "asc"})
		if err != nil {
			t.Fatalf("sort %s ascending: %v", sortKey, err)
		}
		descendingPage, err := service.QueryEntries(f.ctx, f.membership, activities.Query{Sort: sortKey, Direction: "desc"})
		if err != nil {
			t.Fatalf("sort %s descending: %v", sortKey, err)
		}
		if len(ascendingPage.Items) != 6 || len(descendingPage.Items) != 6 {
			t.Fatalf("sort %s counts asc=%d desc=%d", sortKey, len(ascendingPage.Items), len(descendingPage.Items))
		}
		for index := range ascendingPage.Items {
			if ascendingPage.Items[index].ID != descendingPage.Items[len(descendingPage.Items)-1-index].ID {
				t.Fatalf("sort %s directions are not stable reverses: asc=%v desc=%v", sortKey, activitySourceIDs(ascendingPage.Items), activitySourceIDs(descendingPage.Items))
			}
		}
	}

	first, err := service.QueryEntries(f.ctx, f.membership, activities.Query{Limit: 1, Sort: "occurredAt", Direction: "asc"})
	if err != nil || len(first.Items) != 1 || first.NextCursor == "" {
		t.Fatalf("create activity cursor: page=%#v err=%v", first, err)
	}
	second, err := service.QueryEntries(f.ctx, f.membership, activities.Query{Limit: 1, Sort: "occurredAt", Direction: "asc", Cursor: first.NextCursor})
	if err != nil || len(second.Items) != 1 || second.Items[0].ID == first.Items[0].ID {
		t.Fatalf("continue matching activity cursor: page=%#v err=%v", second, err)
	}
	cursorMismatches := []struct {
		name   string
		mutate func(*activities.Query)
	}{
		{name: "search", mutate: func(query *activities.Query) { query.Search = "Alice" }},
		{name: "kind", mutate: func(query *activities.Query) { query.Kinds = []string{"BOOKING"} }},
		{name: "member", mutate: func(query *activities.Query) { query.TargetMembershipID = alice.ID }},
		{name: "category", mutate: func(query *activities.Query) { query.CategoryIDs = []string{alphaCategory.ID} }},
		{name: "product", mutate: func(query *activities.Query) { query.ProductIDs = []string{alphaProduct.ID} }},
		{name: "status", mutate: func(query *activities.Query) { query.Status = "POSTED" }},
		{name: "from", mutate: func(query *activities.Query) { query.OccurredFrom = "2026-08-20" }},
		{name: "to", mutate: func(query *activities.Query) { query.OccurredTo = "2026-08-20" }},
		{name: "minimum", mutate: func(query *activities.Query) { query.AmountMin = activityAmount(-400) }},
		{name: "maximum", mutate: func(query *activities.Query) { query.AmountMax = activityAmount(500) }},
		{name: "sort", mutate: func(query *activities.Query) { query.Sort = "amount" }},
		{name: "direction", mutate: func(query *activities.Query) { query.Direction = "desc" }},
	}
	for _, mismatch := range cursorMismatches {
		t.Run("cursor "+mismatch.name, func(t *testing.T) {
			query := activities.Query{Limit: 1, Sort: "occurredAt", Direction: "asc", Cursor: first.NextCursor}
			mismatch.mutate(&query)
			if _, err := service.QueryEntries(f.ctx, f.membership, query); !errors.Is(err, domain.ErrValidation) {
				t.Fatalf("mismatched %s cursor error=%v, want validation", mismatch.name, err)
			}
		})
	}
	invalidQueries := []struct {
		name  string
		query activities.Query
	}{
		{name: "kind", query: activities.Query{Kinds: []string{"UNKNOWN"}}},
		{name: "status", query: activities.Query{Status: "UNKNOWN"}},
		{name: "date syntax", query: activities.Query{OccurredFrom: "20.08.2026"}},
		{name: "date order", query: activities.Query{OccurredFrom: "2026-08-21", OccurredTo: "2026-08-20"}},
		{name: "amount order", query: activities.Query{AmountMin: activityAmount(1), AmountMax: activityAmount(-1)}},
		{name: "sort", query: activities.Query{Sort: "amount DESC; DROP TABLE payments;--"}},
		{name: "direction", query: activities.Query{Sort: "amount", Direction: "desc; DROP TABLE bookings;--"}},
	}
	for _, invalid := range invalidQueries {
		t.Run("invalid "+invalid.name, func(t *testing.T) {
			if _, err := service.QueryEntries(f.ctx, f.membership, invalid.query); !errors.Is(err, domain.ErrValidation) {
				t.Fatalf("invalid %s error=%v, want validation", invalid.name, err)
			}
		})
	}
	_ = betaCategory
}

func TestUnifiedActivityFeedReadsPaymentsCreatedBeforeMethodLabelSnapshots(t *testing.T) {
	f := newFixture(t)
	service := activities.Service{DB: f.db}
	if _, err := f.db.ExecContext(f.ctx, `INSERT INTO payments(
		id,group_id,membership_id,amount_minor,received_at,method,method_label,reference,note,created_by,created_at
	) VALUES('legacy-payment',?,?,?,?,?,NULL,'Imported payment','Before configurable methods',?,'2026-08-20T10:00:00Z')`,
		f.group.ID, f.membership.ID, 875, "2026-07-01T00:00:00Z", "CASH", f.membership.ID); err != nil {
		t.Fatalf("insert payment without historical method label: %v", err)
	}
	page, err := service.QueryEntries(f.ctx, f.membership, activities.Query{Kinds: []string{"PAYMENT"}})
	if err != nil || len(page.Items) != 1 {
		t.Fatalf("query legacy payment activity: items=%#v err=%v", page.Items, err)
	}
	entry := page.Items[0]
	if entry.SourceID != "legacy-payment" || entry.PaymentMethod != "CASH" || entry.DetailName != "" || entry.DetailNote != "Imported payment" || entry.AmountMinor != -875 || entry.OccurredAt != "2026-08-20T10:00:00Z" {
		t.Fatalf("legacy payment activity=%#v", entry)
	}
	searchPage, err := service.QueryEntries(f.ctx, f.membership, activities.Query{Search: "CASH"})
	if err != nil || len(searchPage.Items) != 1 || searchPage.Items[0].SourceID != "legacy-payment" {
		t.Fatalf("search legacy payment method: items=%#v err=%v", searchPage.Items, err)
	}
}

func TestUnifiedActivityFeedPaginatesTwoFullSourcesAcrossMultiplePagesWithoutLoss(t *testing.T) {
	f := newFixture(t)
	service := activities.Service{DB: f.db}
	memberPrincipal, member, _ := f.inviteMember("pagination@example.test", "Pagination Member", nil)
	_, product := f.catalogItem("Pagination", 100)
	periodID := f.openPeriodID()
	originalNow := platform.Now
	t.Cleanup(func() { platform.Now = originalNow })
	base := time.Date(2026, 8, 20, 8, 0, 0, 0, time.UTC)
	want := make(map[string]struct{}, 120)
	for index := 0; index < 60; index++ {
		bookingTime := base.Add(time.Duration(index*2) * time.Second)
		platform.Now = func() time.Time { return bookingTime }
		booking, err := f.bookings.Create(f.ctx, memberPrincipal, member, "pagination-booking-"+twoDigit(index), bookings.CreateInput{
			ProductID: product.ID, ProductVersion: product.Version, ExpectedPeriodID: periodID, Quantity: 1,
		})
		if err != nil {
			t.Fatalf("create booking %d: %v", index, err)
		}
		want["booking:"+booking.ID] = struct{}{}
		paymentTime := bookingTime.Add(time.Second)
		platform.Now = func() time.Time { return paymentTime }
		payment, err := f.finance.CreatePayment(f.ctx, f.admin, f.membership, "pagination-payment-"+twoDigit(index), finance.CreatePaymentInput{
			MembershipID: member.ID, AmountMinor: 100, ReceivedAt: paymentTime.Format(time.RFC3339), Method: "CASH",
		})
		if err != nil {
			t.Fatalf("create payment %d: %v", index, err)
		}
		want["payment:"+payment.ID] = struct{}{}
	}

	seen := make(map[string]struct{}, len(want))
	cursor := ""
	pages := 0
	bookingCount, paymentCount := 0, 0
	previousTime := ""
	for {
		page, err := service.QueryEntries(f.ctx, member, activities.Query{Limit: 40, Cursor: cursor})
		if err != nil {
			t.Fatalf("query unified page %d: %v", pages+1, err)
		}
		pages++
		if pages < 3 && len(page.Items) != 40 {
			t.Fatalf("page %d count=%d, want 40", pages, len(page.Items))
		}
		for _, entry := range page.Items {
			if _, exists := seen[entry.ID]; exists {
				t.Fatalf("duplicate activity %s on page %d", entry.ID, pages)
			}
			if _, expected := want[entry.ID]; !expected {
				t.Fatalf("unexpected activity %s on page %d", entry.ID, pages)
			}
			if previousTime != "" && entry.OccurredAt > previousTime {
				t.Fatalf("global chronology increased from %s to %s on page %d", previousTime, entry.OccurredAt, pages)
			}
			previousTime = entry.OccurredAt
			seen[entry.ID] = struct{}{}
			switch entry.Kind {
			case activities.KindBooking:
				bookingCount++
			case activities.KindPayment:
				paymentCount++
			}
		}
		if page.NextCursor == "" {
			break
		}
		cursor = page.NextCursor
	}
	if pages != 3 || len(seen) != 120 || bookingCount != 60 || paymentCount != 60 {
		t.Fatalf("pagination pages=%d unique=%d bookings=%d payments=%d", pages, len(seen), bookingCount, paymentCount)
	}
	for id := range want {
		if _, exists := seen[id]; !exists {
			t.Fatalf("missing activity %s", id)
		}
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

func activityAmount(value int64) *int64 {
	return &value
}

func activityAmounts(entries []activities.Entry) []int64 {
	result := make([]int64, 0, len(entries))
	for _, entry := range entries {
		result = append(result, entry.AmountMinor)
	}
	return result
}

func assertActivitySources(t *testing.T, entries []activities.Entry, want []string) {
	t.Helper()
	if len(entries) != len(want) {
		t.Fatalf("activity sources=%v, want %v", activitySourceIDs(entries), want)
	}
	got := make(map[string]int, len(entries))
	for _, entry := range entries {
		got[entry.SourceID]++
	}
	for _, sourceID := range want {
		if got[sourceID] != 1 {
			t.Fatalf("activity sources=%v, want %v", activitySourceIDs(entries), want)
		}
	}
}

func activitySourceIDs(entries []activities.Entry) []string {
	result := make([]string, 0, len(entries))
	for _, entry := range entries {
		result = append(result, entry.SourceID)
	}
	return result
}

func activityBySource(t *testing.T, entries []activities.Entry, sourceID string) activities.Entry {
	t.Helper()
	for _, entry := range entries {
		if entry.SourceID == sourceID {
			return entry
		}
	}
	t.Fatalf("activity source %s missing from %v", sourceID, activitySourceIDs(entries))
	return activities.Entry{}
}

func twoDigit(value int) string {
	return string(rune('0'+value/10)) + string(rune('0'+value%10))
}
