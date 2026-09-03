package statistics

import (
	"context"
	"fmt"
	"time"

	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/platform"
)

func (s Service) financeStatistics(ctx context.Context, membership domain.Membership, configuration dashboardContext, rangeValue resolvedRange) (FinanceStatistics, error) {
	dashboard := FinanceStatistics{
		Currency:   configuration.currency,
		Series:     make([]FinanceActivityPoint, len(rangeValue.buckets)),
		Categories: make([]FinanceCategoryItem, 0),
	}
	for index, bucket := range rangeValue.buckets {
		dashboard.Series[index].PeriodStart = bucket.periodStart.Format(timeFormatWithOffset)
	}
	if err := s.queryReceivableSnapshot(ctx, membership.GroupID, rangeValue, &dashboard.ReceivableSnapshot); err != nil {
		return FinanceStatistics{}, err
	}
	if err := s.queryFinancialFlows(ctx, membership.GroupID, rangeValue, &dashboard.Flows, dashboard.Series); err != nil {
		return FinanceStatistics{}, err
	}
	var err error
	if dashboard.Categories, err = s.queryFinanceCategories(ctx, membership.GroupID, rangeValue); err != nil {
		return FinanceStatistics{}, err
	}
	if configuration.settlementsEnabled {
		dashboard.Overdue = &OverdueSnapshot{AsOf: rangeValue.meta.GeneratedAt}
		if err := s.queryOverdueSnapshot(ctx, membership.GroupID, rangeValue, dashboard.Overdue); err != nil {
			return FinanceStatistics{}, err
		}
	}
	return dashboard, nil
}

func (s Service) queryReceivableSnapshot(ctx context.Context, groupID string, rangeValue resolvedRange, snapshot *ReceivableSnapshot) error {
	asOf := platform.Timestamp(rangeValue.to)
	snapshot.AsOf = asOf
	return s.queryer().QueryRowContext(ctx, `WITH account_balances AS (
		SELECT membership.id,membership.deleted_at,coalesce(sum(entry.amount_minor),0) AS balance_minor
		FROM memberships membership
		LEFT JOIN ledger_entries entry
		  ON entry.group_id=membership.group_id AND entry.membership_id=membership.id
		 AND entry.account='MEMBER_RECEIVABLE' AND entry.created_at<?
		WHERE membership.group_id=? AND membership.joined_at<?
		GROUP BY membership.id,membership.deleted_at
	), operational_balances AS (
		SELECT balance_minor FROM account_balances
		WHERE deleted_at IS NULL OR deleted_at>=? OR balance_minor<>0
	)
	SELECT
		coalesce(sum(CASE WHEN balance_minor>0 THEN balance_minor ELSE 0 END),0),
		coalesce(-sum(CASE WHEN balance_minor<0 THEN balance_minor ELSE 0 END),0),
		coalesce(sum(balance_minor),0),
		coalesce(sum(CASE WHEN balance_minor>0 THEN 1 ELSE 0 END),0),
		coalesce(sum(CASE WHEN balance_minor=0 THEN 1 ELSE 0 END),0),
		coalesce(sum(CASE WHEN balance_minor<0 THEN 1 ELSE 0 END),0)
	FROM operational_balances`, asOf, groupID, asOf, asOf).
		Scan(&snapshot.GrossReceivableMinor, &snapshot.MemberCreditMinor, &snapshot.NetReceivableMinor,
			&snapshot.OpenAccountCount, &snapshot.BalancedAccountCount, &snapshot.CreditAccountCount)
}

func (s Service) queryFinancialFlows(ctx context.Context, groupID string, rangeValue resolvedRange, flows *FinancialFlows, points []FinanceActivityPoint) error {
	from, to := platform.Timestamp(rangeValue.from), platform.Timestamp(rangeValue.to)
	if err := s.queryer().QueryRowContext(ctx, `SELECT coalesce(sum(amount_minor),0) FROM ledger_entries
		WHERE group_id=? AND account='MEMBER_RECEIVABLE' AND created_at<?`, groupID, from).
		Scan(&flows.OpeningNetReceivableMinor); err != nil {
		return err
	}

	values, args := bucketValues(rangeValue)
	query := `WITH buckets(bucket_index,from_utc,to_utc) AS (VALUES ` + values + `)
		SELECT bucket.bucket_index,
			coalesce(sum(CASE WHEN entry.booking_id IS NOT NULL THEN entry.amount_minor ELSE 0 END),0),
			coalesce(-sum(CASE WHEN entry.payment_id IS NOT NULL THEN entry.amount_minor ELSE 0 END),0),
			coalesce(sum(CASE WHEN entry.booking_id IS NULL AND entry.payment_id IS NULL THEN entry.amount_minor ELSE 0 END),0)
		FROM buckets bucket
		LEFT JOIN ledger_entries entry
		  ON entry.group_id=? AND entry.account='MEMBER_RECEIVABLE'
		 AND entry.created_at>=bucket.from_utc AND entry.created_at<bucket.to_utc
		WHERE bucket.from_utc>=? AND bucket.to_utc<=?
		GROUP BY bucket.bucket_index ORDER BY bucket.bucket_index`
	args = append(args, groupID, from, to)
	rows, err := s.queryer().QueryContext(ctx, query, args...)
	if err != nil {
		return fmt.Errorf("query finance activity series: %w", err)
	}
	defer rows.Close()
	closing := flows.OpeningNetReceivableMinor
	for rows.Next() {
		var index int
		var bookings, payments, adjustments int64
		if err := rows.Scan(&index, &bookings, &payments, &adjustments); err != nil {
			return err
		}
		if index < 0 || index >= len(points) {
			return fmt.Errorf("finance activity returned invalid bucket index %d", index)
		}
		closing += bookings - payments + adjustments
		points[index].NetBookingChargesMinor = bookings
		points[index].NetPaymentsMinor = payments
		points[index].NetAdjustmentsMinor = adjustments
		points[index].ClosingNetReceivableMinor = closing
		flows.NetBookingChargesMinor += bookings
		flows.NetPaymentsMinor += payments
		flows.NetAdjustmentsMinor += adjustments
	}
	if err := rows.Err(); err != nil {
		return err
	}
	flows.ClosingNetReceivableMinor = flows.OpeningNetReceivableMinor + flows.NetBookingChargesMinor - flows.NetPaymentsMinor + flows.NetAdjustmentsMinor
	return nil
}

func (s Service) queryFinanceCategories(ctx context.Context, groupID string, rangeValue resolvedRange) ([]FinanceCategoryItem, error) {
	rows, err := s.queryer().QueryContext(ctx, `SELECT entry.category_id,category.name,category.icon,sum(entry.amount_minor)
		FROM ledger_entries entry
		JOIN categories category ON category.group_id=entry.group_id AND category.id=entry.category_id
		WHERE entry.group_id=? AND entry.account='MEMBER_RECEIVABLE' AND entry.booking_id IS NOT NULL
		  AND entry.created_at>=? AND entry.created_at<?
		GROUP BY entry.category_id,category.name,category.icon
		ORDER BY abs(sum(entry.amount_minor)) DESC,lower(category.name),entry.category_id`,
		groupID, platform.Timestamp(rangeValue.from), platform.Timestamp(rangeValue.to))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]FinanceCategoryItem, 0)
	for rows.Next() {
		var item FinanceCategoryItem
		if err := rows.Scan(&item.CategoryID, &item.CategoryName, &item.Icon, &item.NetBookingChargesMinor); err != nil {
			return nil, err
		}
		if len(items) < 6 {
			items = append(items, item)
		} else if len(items) == 6 {
			items = append(items, FinanceCategoryItem{CategoryName: "Other", Icon: "other", NetBookingChargesMinor: item.NetBookingChargesMinor, IsOther: true})
		} else {
			items[6].NetBookingChargesMinor += item.NetBookingChargesMinor
		}
	}
	return items, rows.Err()
}

func (s Service) queryOverdueSnapshot(ctx context.Context, groupID string, rangeValue resolvedRange, snapshot *OverdueSnapshot) error {
	generatedAt, err := time.Parse(time.RFC3339Nano, rangeValue.meta.GeneratedAt)
	if err != nil {
		return fmt.Errorf("parse statistics generation timestamp: %w", err)
	}
	today := generatedAt.In(rangeValue.location).Format("2006-01-02")
	return s.queryer().QueryRowContext(ctx, `WITH statement_balances AS (
		SELECT statement.period_id,statement.membership_id,
			statement.charges_minor
			+ coalesce((SELECT sum(adjustment.amount_minor) FROM period_adjustment_allocations adjustment
				WHERE adjustment.group_id=statement.group_id AND adjustment.source_period_id=statement.period_id AND adjustment.membership_id=statement.membership_id),0)
			- coalesce((SELECT sum(allocation.amount_minor) FROM payment_allocations allocation
				JOIN payments payment ON payment.group_id=allocation.group_id AND payment.id=allocation.payment_id
				WHERE allocation.group_id=statement.group_id AND allocation.period_id=statement.period_id
				  AND payment.membership_id=statement.membership_id AND payment.reversed_at IS NULL),0)
			- coalesce((SELECT sum(adjustment.amount_minor) FROM period_adjustment_allocations adjustment
				WHERE adjustment.group_id=statement.group_id AND adjustment.target_period_id=statement.period_id AND adjustment.membership_id=statement.membership_id),0)
			AS outstanding_minor
		FROM period_statements statement
		JOIN periods period ON period.group_id=statement.group_id AND period.id=statement.period_id
		WHERE statement.group_id=? AND period.due_at IS NOT NULL AND period.due_at<?
	), overdue_balances AS (
		SELECT period_id,membership_id,outstanding_minor FROM statement_balances WHERE outstanding_minor>0
	)
	SELECT coalesce(sum(outstanding_minor),0),count(DISTINCT membership_id),count(DISTINCT period_id)
	FROM overdue_balances`, groupID, today).
		Scan(&snapshot.AmountMinor, &snapshot.AccountCount, &snapshot.PeriodCount)
}
