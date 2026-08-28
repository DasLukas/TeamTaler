package statistics

import (
	"errors"
	"testing"

	"github.com/DasLukas/TeamTaler/internal/domain"
)

func TestFinanceReconcilesNetFlowsAndHistoricalSnapshot(t *testing.T) {
	fixture := newStatisticsFixture(t)
	members := fixture.seedCatalogAndMembers(t)
	fixture.insertBooking(t, "booking-finance-reversed", members[0], "2026-08-10T10:00:00Z", "2026-08-12T10:00:00Z", 5)
	fixture.insertBooking(t, "booking-finance-posted", members[0], "2026-08-13T10:00:00Z", "", 3)

	if _, err := fixture.db.ExecContext(fixture.ctx, `INSERT INTO payments(
		id,group_id,membership_id,amount_minor,received_at,method,method_label,created_by,created_at,reversed_at,reversed_by,reversal_reason
	) VALUES('payment-finance',?,?,200,'2026-08-14T10:00:00Z','BANK_TRANSFER','Bank transfer',?,'2026-08-14T10:00:00Z','2026-08-15T10:00:00Z',?,'Correction')`,
		fixture.membership.GroupID, members[0], fixture.membership.ID, fixture.membership.ID); err != nil {
		t.Fatalf("insert finance payment: %v", err)
	}
	ledger := []struct {
		id, bookingID, paymentID, reversalOf, createdAt string
		amount                                          int64
	}{
		{id: "ledger-opening", createdAt: "2026-07-31T10:00:00Z", amount: 100},
		{id: "ledger-booking-original", bookingID: "booking-finance-reversed", createdAt: "2026-08-10T10:00:00Z", amount: 500},
		{id: "ledger-booking-reversal", bookingID: "booking-finance-reversed", reversalOf: "ledger-booking-original", createdAt: "2026-08-12T10:00:00Z", amount: -500},
		{id: "ledger-booking-posted", bookingID: "booking-finance-posted", createdAt: "2026-08-13T10:00:00Z", amount: 300},
		{id: "ledger-payment-original", paymentID: "payment-finance", createdAt: "2026-08-14T10:00:00Z", amount: -200},
		{id: "ledger-payment-reversal", paymentID: "payment-finance", reversalOf: "ledger-payment-original", createdAt: "2026-08-15T10:00:00Z", amount: 200},
		{id: "ledger-adjustment", createdAt: "2026-08-16T10:00:00Z", amount: 50},
		{id: "ledger-after-range", createdAt: "2026-09-05T10:00:00Z", amount: 999},
	}
	for _, entry := range ledger {
		categoryID := any(nil)
		if entry.bookingID != "" {
			categoryID = "category-statistics"
		}
		if _, err := fixture.db.ExecContext(fixture.ctx, `INSERT INTO ledger_entries(
			id,group_id,period_id,membership_id,category_id,booking_id,payment_id,reversal_of,account,amount_minor,description,created_at
		) VALUES(?,?,?,?,?,?,?,?, 'MEMBER_RECEIVABLE',?,?,?)`, entry.id, fixture.membership.GroupID, fixture.periodID, members[0], categoryID,
			nullableTest(entry.bookingID), nullableTest(entry.paymentID), nullableTest(entry.reversalOf), entry.amount, entry.id, entry.createdAt); err != nil {
			t.Fatalf("insert finance ledger %s: %v", entry.id, err)
		}
	}
	if _, err := fixture.db.ExecContext(fixture.ctx, `UPDATE memberships SET status='ARCHIVED',archived_at='2026-09-05T00:00:00Z',deleted_at='2026-09-05T00:00:00Z' WHERE id=?`, members[1]); err != nil {
		t.Fatalf("delete zero-balance account after selected range: %v", err)
	}

	fixture.enableStatistics(t, true)
	service := fixture.service()
	if _, err := service.Finance(fixture.ctx, fixture.membership, Query{}); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("ungranted finance statistics error=%v, want forbidden", err)
	}
	fixture.grant(t, domain.PermissionViewGroupStatistics)
	dashboard, err := service.Finance(fixture.ctx, fixture.membership, Query{
		Preset: PresetCustom, From: "2026-08-01", To: "2026-08-31",
	})
	if err != nil {
		t.Fatalf("read finance statistics: %v", err)
	}
	if dashboard.Flows.OpeningNetReceivableMinor != 100 || dashboard.Flows.NetBookingChargesMinor != 300 ||
		dashboard.Flows.NetPaymentsMinor != 0 || dashboard.Flows.NetAdjustmentsMinor != 50 || dashboard.Flows.ClosingNetReceivableMinor != 450 {
		t.Fatalf("finance flows=%#v, want reconciled 100+300-0+50=450", dashboard.Flows)
	}
	if dashboard.ReceivableSnapshot.NetReceivableMinor != 450 || dashboard.ReceivableSnapshot.GrossReceivableMinor != 450 || dashboard.ReceivableSnapshot.BalancedAccountCount != 3 || dashboard.ReceivableSnapshot.AsOf != dashboard.Meta.ToExclusive {
		t.Fatalf("historical receivable snapshot=%#v meta=%#v", dashboard.ReceivableSnapshot, dashboard.Meta)
	}
	if len(dashboard.Series) == 0 || dashboard.Series[len(dashboard.Series)-1].ClosingNetReceivableMinor != 450 {
		t.Fatalf("finance closing series=%#v", dashboard.Series)
	}
	if len(dashboard.Categories) != 1 || dashboard.Categories[0].CategoryName != "Current category" || dashboard.Categories[0].NetBookingChargesMinor != 300 {
		t.Fatalf("finance category aggregation=%#v", dashboard.Categories)
	}
}

func TestFinanceOverdueIsCurrentAndLongRangesUseYearBuckets(t *testing.T) {
	fixture := newStatisticsFixture(t)
	fixture.enableStatistics(t, true)
	fixture.grant(t, domain.PermissionViewGroupStatistics)
	if _, err := fixture.db.ExecContext(fixture.ctx, `INSERT INTO periods(id,group_id,label,status,starts_at,closed_at,due_at,created_at)
		VALUES('period-overdue',?,'Overdue','CLOSED','2026-08-01T00:00:00Z','2026-08-02T00:00:00Z','2026-09-01','2026-08-01T00:00:00Z')`, fixture.membership.GroupID); err != nil {
		t.Fatalf("insert overdue period: %v", err)
	}
	if _, err := fixture.db.ExecContext(fixture.ctx, `INSERT INTO period_statements(
		id,group_id,period_id,membership_id,display_name,email,charges_minor,payments_allocated_minor,
		adjustments_applied_minor,adjustments_provided_minor,amount_due_minor,status,created_at
	) VALUES('statement-overdue',?,'period-overdue',?,'Statistics Admin','statistics-admin@example.test',1000,0,0,0,1000,'OPEN','2026-08-02T00:00:00Z')`,
		fixture.membership.GroupID, fixture.membership.ID); err != nil {
		t.Fatalf("insert overdue statement: %v", err)
	}

	dashboard, err := fixture.service().Finance(fixture.ctx, fixture.membership, Query{
		Preset: PresetCustom, From: "2015-01-01", To: "2026-08-31",
	})
	if err != nil {
		t.Fatalf("read long-range finance statistics: %v", err)
	}
	if dashboard.Meta.Bucket != BucketYear || len(dashboard.Series) > maxSeriesBuckets {
		t.Fatalf("long-range buckets=%s/%d, want YEAR and at most %d", dashboard.Meta.Bucket, len(dashboard.Series), maxSeriesBuckets)
	}
	if dashboard.Overdue == nil || dashboard.Overdue.AmountMinor != 1000 || dashboard.Overdue.AccountCount != 1 || dashboard.Overdue.PeriodCount != 1 || dashboard.Overdue.AsOf != dashboard.Meta.GeneratedAt {
		t.Fatalf("current overdue snapshot=%#v meta=%#v", dashboard.Overdue, dashboard.Meta)
	}
}

func nullableTest(value string) any {
	if value == "" {
		return nil
	}
	return value
}
