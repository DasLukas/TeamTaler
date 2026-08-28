package statistics

import (
	"context"
	"fmt"

	"github.com/DasLukas/TeamTaler/internal/authorization"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/platform"
)

func (s Service) memberDashboard(ctx context.Context, membership domain.Membership, _ dashboardContext, rangeValue resolvedRange) (MemberDashboard, error) {
	dashboard := MemberDashboard{
		Meta:     rangeValue.meta,
		Activity: make([]MemberActivityPoint, len(rangeValue.buckets)),
		TopCategories: MemberCategoryBreakdown{
			Items: make([]MemberCategoryItem, 0),
		},
		TopProducts: MemberProductBreakdown{
			Items: make([]MemberProductItem, 0),
		},
	}
	for index, bucket := range rangeValue.buckets {
		dashboard.Activity[index].PeriodStart = bucket.periodStart.Format(timeFormatWithOffset)
	}

	if err := s.queryMemberSnapshot(ctx, membership.GroupID, rangeValue.meta.GeneratedAt, &dashboard.MemberSnapshot); err != nil {
		return MemberDashboard{}, err
	}
	breakdownParticipants, err := s.queryMemberSummary(ctx, membership.GroupID, rangeValue, &dashboard.Summary)
	if err != nil {
		return MemberDashboard{}, err
	}
	if err := s.queryMemberActivity(ctx, membership.GroupID, rangeValue, dashboard.Activity); err != nil {
		return MemberDashboard{}, err
	}

	canViewAll, err := authorization.NewPolicy(s.queryer()).Can(ctx, membership.GroupID, membership.ID, domain.PermissionViewAllBookingActivity, authorization.GroupResource(membership.GroupID))
	if err != nil {
		return MemberDashboard{}, err
	}
	suppressed := breakdownParticipants > 0 && breakdownParticipants < privacyParticipantThreshold && !canViewAll
	dashboard.Meta.PrivacyThresholdApplied = suppressed
	dashboard.TopCategories.Suppressed = suppressed
	dashboard.TopProducts.Suppressed = suppressed
	if suppressed {
		return dashboard, nil
	}
	if dashboard.TopCategories.Items, err = s.queryTopCategories(ctx, membership.GroupID, rangeValue); err != nil {
		return MemberDashboard{}, err
	}
	if dashboard.TopProducts.Items, err = s.queryTopProducts(ctx, membership.GroupID, rangeValue); err != nil {
		return MemberDashboard{}, err
	}
	return dashboard, nil
}

const timeFormatWithOffset = "2006-01-02T15:04:05Z07:00"

func (s Service) queryMemberSnapshot(ctx context.Context, groupID, asOf string, snapshot *MemberSnapshot) error {
	snapshot.AsOf = asOf
	return s.queryer().QueryRowContext(ctx, `SELECT
		coalesce(sum(CASE WHEN u.email IS NOT NULL AND u.password_hash IS NOT NULL THEN 1 ELSE 0 END),0),
		coalesce(sum(CASE WHEN u.email IS NULL AND u.password_hash IS NULL THEN 1 ELSE 0 END),0)
		FROM memberships m
		JOIN users u ON u.id=m.user_id
		WHERE m.group_id=? AND m.status='ACTIVE' AND m.deleted_at IS NULL AND u.active=1`, groupID).
		Scan(&snapshot.RegularMembers, &snapshot.TemporaryGuests)
}

func (s Service) queryMemberSummary(ctx context.Context, groupID string, rangeValue resolvedRange, summary *MemberSummary) (int64, error) {
	from, to := platform.Timestamp(rangeValue.from), platform.Timestamp(rangeValue.to)
	if err := s.queryer().QueryRowContext(ctx, `SELECT count(DISTINCT target_membership_id)
		FROM bookings
		WHERE group_id=? AND ((created_at>=? AND created_at<?) OR (voided_at>=? AND voided_at<?))`,
		groupID, from, to, from, to).Scan(&summary.ActiveParticipants); err != nil {
		return 0, err
	}
	var canceledBookings, breakdownParticipants int64
	err := s.queryer().QueryRowContext(ctx, `SELECT count(*),
		coalesce(sum(CASE WHEN voided_at IS NULL OR voided_at>=? THEN quantity ELSE 0 END),0),
		coalesce(sum(CASE WHEN voided_at IS NOT NULL AND voided_at<? THEN 1 ELSE 0 END),0),
		count(DISTINCT CASE WHEN voided_at IS NULL OR voided_at>=? THEN target_membership_id END)
		FROM bookings WHERE group_id=? AND created_at>=? AND created_at<?`,
		to, to, to, groupID, from, to).
		Scan(&summary.BookingCount, &summary.ValidBookedUnits, &canceledBookings, &breakdownParticipants)
	if err != nil {
		return 0, err
	}
	if summary.BookingCount > 0 {
		rate := float64(canceledBookings) / float64(summary.BookingCount)
		summary.CancellationRate = &rate
	}
	return breakdownParticipants, nil
}

func (s Service) queryMemberActivity(ctx context.Context, groupID string, rangeValue resolvedRange, points []MemberActivityPoint) error {
	values, args := bucketValues(rangeValue)
	from, to := platform.Timestamp(rangeValue.from), platform.Timestamp(rangeValue.to)
	query := `WITH buckets(bucket_index,from_utc,to_utc) AS (VALUES ` + values + `),
		events AS (
			SELECT created_at AS event_at,quantity AS posted_units,0 AS reversed_units
			FROM bookings WHERE group_id=? AND created_at>=? AND created_at<?
			UNION ALL
			SELECT voided_at AS event_at,0 AS posted_units,quantity AS reversed_units
			FROM bookings WHERE group_id=? AND voided_at>=? AND voided_at<?
		)
		SELECT bucket.bucket_index,coalesce(sum(event.posted_units),0),coalesce(sum(event.reversed_units),0)
		FROM buckets bucket
		LEFT JOIN events event ON event.event_at>=bucket.from_utc AND event.event_at<bucket.to_utc
		GROUP BY bucket.bucket_index ORDER BY bucket.bucket_index`
	args = append(args, groupID, from, to, groupID, from, to)
	rows, err := s.queryer().QueryContext(ctx, query, args...)
	if err != nil {
		return fmt.Errorf("query member activity series: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var index int
		var posted, reversed int64
		if err := rows.Scan(&index, &posted, &reversed); err != nil {
			return err
		}
		if index < 0 || index >= len(points) {
			return fmt.Errorf("member activity returned invalid bucket index %d", index)
		}
		points[index].PostedUnits = posted
		points[index].ReversedUnits = reversed
	}
	return rows.Err()
}

func (s Service) queryTopCategories(ctx context.Context, groupID string, rangeValue resolvedRange) ([]MemberCategoryItem, error) {
	rows, err := s.queryer().QueryContext(ctx, `SELECT booking.category_id,category.name,category.icon,sum(booking.quantity)
		FROM bookings booking
		JOIN categories category ON category.group_id=booking.group_id AND category.id=booking.category_id
		WHERE booking.group_id=? AND booking.created_at>=? AND booking.created_at<?
		  AND (booking.voided_at IS NULL OR booking.voided_at>=?)
		GROUP BY booking.category_id,category.name,category.icon
		ORDER BY sum(booking.quantity) DESC,lower(category.name),booking.category_id`,
		groupID, platform.Timestamp(rangeValue.from), platform.Timestamp(rangeValue.to), platform.Timestamp(rangeValue.to))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]MemberCategoryItem, 0)
	for rows.Next() {
		var item MemberCategoryItem
		if err := rows.Scan(&item.CategoryID, &item.CategoryName, &item.Icon, &item.ValidBookedUnits); err != nil {
			return nil, err
		}
		if len(items) < 6 {
			items = append(items, item)
		} else if len(items) == 6 {
			items = append(items, MemberCategoryItem{CategoryName: "Other", Icon: "other", ValidBookedUnits: item.ValidBookedUnits, IsOther: true})
		} else {
			items[6].ValidBookedUnits += item.ValidBookedUnits
		}
	}
	return items, rows.Err()
}

func (s Service) queryTopProducts(ctx context.Context, groupID string, rangeValue resolvedRange) ([]MemberProductItem, error) {
	rows, err := s.queryer().QueryContext(ctx, `SELECT booking.product_id,product.name,booking.category_id,category.name,sum(booking.quantity)
		FROM bookings booking
		JOIN products product ON product.group_id=booking.group_id AND product.id=booking.product_id
		JOIN categories category ON category.group_id=booking.group_id AND category.id=booking.category_id
		WHERE booking.group_id=? AND booking.created_at>=? AND booking.created_at<?
		  AND (booking.voided_at IS NULL OR booking.voided_at>=?)
		GROUP BY booking.product_id,product.name,booking.category_id,category.name
		ORDER BY sum(booking.quantity) DESC,lower(product.name),booking.product_id`,
		groupID, platform.Timestamp(rangeValue.from), platform.Timestamp(rangeValue.to), platform.Timestamp(rangeValue.to))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]MemberProductItem, 0)
	for rows.Next() {
		var item MemberProductItem
		if err := rows.Scan(&item.ProductID, &item.ProductName, &item.CategoryID, &item.CategoryName, &item.ValidBookedUnits); err != nil {
			return nil, err
		}
		if len(items) < 6 {
			items = append(items, item)
		} else if len(items) == 6 {
			items = append(items, MemberProductItem{ProductName: "Other", CategoryName: "Other", ValidBookedUnits: item.ValidBookedUnits, IsOther: true})
		} else {
			items[6].ValidBookedUnits += item.ValidBookedUnits
		}
	}
	return items, rows.Err()
}
