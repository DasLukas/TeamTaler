package statistics

import (
	"errors"
	"testing"

	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/groups"
)

func TestDashboardRequiresFeatureAndPermissionAndResolvesDefaultRange(t *testing.T) {
	fixture := newStatisticsFixture(t)
	service := fixture.service()

	if _, err := service.Dashboard(fixture.ctx, fixture.membership, Query{}); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("disabled statistics error=%v, want forbidden", err)
	}
	fixture.enableStatistics(t, false)
	if _, err := service.Dashboard(fixture.ctx, fixture.membership, Query{}); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("ungranted statistics error=%v, want forbidden", err)
	}
	fixture.grant(t, domain.PermissionViewStatistics)

	dashboard, err := service.Dashboard(fixture.ctx, fixture.membership, Query{})
	if err != nil {
		t.Fatalf("read default member statistics: %v", err)
	}
	if dashboard.Meta.Preset != PresetLast30Days || dashboard.Meta.CurrentPeriodAvailable {
		t.Fatalf("default member statistics meta=%#v, want LAST_30_DAYS without current period", dashboard.Meta)
	}
	if dashboard.Members.Summary.CancellationRate != nil || dashboard.Members.Activity == nil || dashboard.Members.TopCategories.Items == nil || dashboard.Members.TopProducts.Items == nil || dashboard.Finance.Series == nil || dashboard.Finance.Categories == nil {
		t.Fatalf("empty member statistics must use null cancellation and non-nil arrays: %#v", dashboard)
	}
	if _, err := service.Dashboard(fixture.ctx, fixture.membership, Query{Preset: PresetCurrentPeriod}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("unavailable current-period error=%v, want validation", err)
	}

	settlements := true
	if _, err := fixture.group.UpdateSettings(fixture.ctx, fixture.principal, fixture.membership, groups.SettingsUpdate{SettlementsEnabled: &settlements}); err != nil {
		t.Fatalf("enable settlements: %v", err)
	}
	dashboard, err = service.Dashboard(fixture.ctx, fixture.membership, Query{})
	if err != nil {
		t.Fatalf("read settlement-aware default member statistics: %v", err)
	}
	if dashboard.Meta.Preset != PresetCurrentPeriod || !dashboard.Meta.CurrentPeriodAvailable {
		t.Fatalf("settlement-aware default meta=%#v, want CURRENT_PERIOD", dashboard.Meta)
	}
	if _, err := fixture.db.ExecContext(fixture.ctx, `UPDATE periods SET status='CLOSED',closed_at='2026-09-01T00:00:00Z' WHERE id=?`, fixture.periodID); err != nil {
		t.Fatalf("remove open period for range fallback: %v", err)
	}
	dashboard, err = service.Dashboard(fixture.ctx, fixture.membership, Query{})
	if err != nil {
		t.Fatalf("read no-open-period default member statistics: %v", err)
	}
	if dashboard.Meta.Preset != PresetLast30Days || dashboard.Meta.CurrentPeriodAvailable {
		t.Fatalf("no-open-period fallback meta=%#v, want LAST_30_DAYS", dashboard.Meta)
	}
	if _, err := service.Dashboard(fixture.ctx, fixture.membership, Query{Preset: PresetCurrentPeriod}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("explicit unavailable current-period error=%v, want validation", err)
	}
}

func TestCustomRangeUsesInclusiveLocalDatesAcrossDST(t *testing.T) {
	fixture := newStatisticsFixture(t)
	fixture.enableStatistics(t, false)
	fixture.grant(t, domain.PermissionViewStatistics)
	dashboard, err := fixture.service().Dashboard(fixture.ctx, fixture.membership, Query{
		Preset: PresetCustom, From: "2026-03-29", To: "2026-03-29",
	})
	if err != nil {
		t.Fatalf("read DST custom range: %v", err)
	}
	if dashboard.Meta.FromInclusive != "2026-03-28T23:00:00Z" || dashboard.Meta.ToExclusive != "2026-03-29T22:00:00Z" || len(dashboard.Members.Activity) != 1 {
		t.Fatalf("DST custom range meta=%#v points=%d", dashboard.Meta, len(dashboard.Members.Activity))
	}

	current, err := fixture.service().Dashboard(fixture.ctx, fixture.membership, Query{
		Preset: PresetCustom, From: "2026-09-15", To: "2026-12-31",
	})
	if err != nil {
		t.Fatalf("read current custom range with future end: %v", err)
	}
	if current.Meta.ToExclusive != current.Meta.GeneratedAt {
		t.Fatalf("current custom range extends beyond generation: %#v", current.Meta)
	}

	_, err = fixture.service().Dashboard(fixture.ctx, fixture.membership, Query{
		Preset: PresetCustom, From: "2026-09-16", To: "2026-12-31",
	})
	var validation domain.ValidationError
	if !errors.As(err, &validation) || validation.Field != "from" {
		t.Fatalf("future custom range error=%v, want from validation", err)
	}
}

func TestMembersUsesEventTimeAndSuppressesSmallBreakdowns(t *testing.T) {
	fixture := newStatisticsFixture(t)
	members := fixture.seedCatalogAndMembers(t)
	fixture.insertBooking(t, "booking-statistics-one", members[0], "2026-08-10T10:00:00Z", "2026-08-12T10:00:00Z", 2)
	fixture.insertBooking(t, "booking-statistics-two", members[1], "2026-08-11T10:00:00Z", "", 3)
	fixture.insertBooking(t, "booking-statistics-three", members[2], "2026-08-11T11:00:00Z", "", 1)
	fixture.insertBooking(t, "booking-statistics-four", members[0], "2026-08-11T12:00:00Z", "", 1)
	fixture.enableStatistics(t, false)
	fixture.grant(t, domain.PermissionViewStatistics)
	service := fixture.service()

	dashboard, err := service.Dashboard(fixture.ctx, fixture.membership, Query{
		Preset: PresetCustom, From: "2026-08-10", To: "2026-08-12",
	})
	if err != nil {
		t.Fatalf("read custom member statistics: %v", err)
	}
	if dashboard.Meta.ToExclusive != "2026-08-12T22:00:00Z" || dashboard.Meta.Bucket != BucketDay {
		t.Fatalf("custom local range meta=%#v", dashboard.Meta)
	}
	if dashboard.Members.Summary.ActiveParticipants != 3 || dashboard.Members.Summary.BookingCount != 4 || dashboard.Members.Summary.ValidBookedUnits != 5 {
		t.Fatalf("member summary=%#v, want 3 participants/4 bookings/5 valid units", dashboard.Members.Summary)
	}
	if dashboard.Members.Summary.CancellationRate == nil || *dashboard.Members.Summary.CancellationRate != 0.25 {
		t.Fatalf("cancellation rate=%v, want one quarter", dashboard.Members.Summary.CancellationRate)
	}
	var posted, reversed int64
	for _, point := range dashboard.Members.Activity {
		posted += point.PostedUnits
		reversed += point.ReversedUnits
	}
	if posted != 7 || reversed != 2 {
		t.Fatalf("event-time units=%d/%d, want 7/2", posted, reversed)
	}
	if dashboard.Meta.PrivacyThresholdApplied || dashboard.Members.TopCategories.Suppressed || len(dashboard.Members.TopCategories.Items) != 1 || dashboard.Members.TopCategories.Items[0].CategoryName != "Current category" {
		t.Fatalf("unsuppressed stable category breakdown=%#v meta=%#v", dashboard.Members.TopCategories, dashboard.Meta)
	}

	suppressed, err := service.Dashboard(fixture.ctx, fixture.membership, Query{
		Preset: PresetCustom, From: "2026-08-10", To: "2026-08-10",
	})
	if err != nil {
		t.Fatalf("read small-cohort statistics: %v", err)
	}
	if !suppressed.Meta.PrivacyThresholdApplied || !suppressed.Members.TopCategories.Suppressed || !suppressed.Members.TopProducts.Suppressed || len(suppressed.Members.TopCategories.Items) != 0 {
		t.Fatalf("small cohort was not suppressed: %#v", suppressed)
	}

	fixture.grant(t, domain.PermissionViewAllBookingActivity)
	bypassed, err := service.Dashboard(fixture.ctx, fixture.membership, Query{
		Preset: PresetCustom, From: "2026-08-10", To: "2026-08-10",
	})
	if err != nil {
		t.Fatalf("read identified-view bypass statistics: %v", err)
	}
	if bypassed.Meta.PrivacyThresholdApplied || bypassed.Members.TopCategories.Suppressed || len(bypassed.Members.TopCategories.Items) != 1 {
		t.Fatalf("VIEW_ALL_BOOKING_ACTIVITY did not bypass suppression: %#v", bypassed)
	}
}

func TestMembersPrivacyUsesValidRankingContributorsNotCancellationOnlyParticipants(t *testing.T) {
	fixture := newStatisticsFixture(t)
	members := fixture.seedCatalogAndMembers(t)
	fixture.insertBooking(t, "booking-valid-contributor", members[0], "2026-08-12T09:00:00Z", "", 1)
	fixture.insertBooking(t, "booking-cancellation-only-one", members[1], "2026-08-01T09:00:00Z", "2026-08-12T10:00:00Z", 1)
	fixture.insertBooking(t, "booking-cancellation-only-two", members[2], "2026-08-01T10:00:00Z", "2026-08-12T11:00:00Z", 1)
	fixture.enableStatistics(t, false)
	fixture.grant(t, domain.PermissionViewStatistics)

	dashboard, err := fixture.service().Dashboard(fixture.ctx, fixture.membership, Query{
		Preset: PresetCustom, From: "2026-08-12", To: "2026-08-12",
	})
	if err != nil {
		t.Fatalf("read cancellation-only privacy statistics: %v", err)
	}
	if dashboard.Members.Summary.ActiveParticipants != 3 || !dashboard.Meta.PrivacyThresholdApplied || !dashboard.Members.TopCategories.Suppressed || len(dashboard.Members.TopCategories.Items) != 0 {
		t.Fatalf("ranking contributor privacy was not applied: %#v", dashboard)
	}
}
