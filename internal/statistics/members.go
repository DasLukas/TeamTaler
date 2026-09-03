package statistics

import (
	"context"
	"fmt"
	"strings"

	"github.com/DasLukas/TeamTaler/internal/authorization"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/platform"
)

func (s Service) memberStatistics(ctx context.Context, membership domain.Membership, rangeValue resolvedRange) (MemberStatistics, bool, error) {
	dashboard := MemberStatistics{
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
		return MemberStatistics{}, false, err
	}
	breakdownParticipants, err := s.queryMemberSummary(ctx, membership.GroupID, rangeValue, &dashboard.Summary)
	if err != nil {
		return MemberStatistics{}, false, err
	}
	if err := s.queryMemberActivity(ctx, membership.GroupID, rangeValue, dashboard.Activity); err != nil {
		return MemberStatistics{}, false, err
	}

	canViewAll, err := authorization.NewPolicy(s.queryer()).Can(ctx, membership.GroupID, membership.ID, domain.PermissionViewAllBookingActivity, authorization.GroupResource(membership.GroupID))
	if err != nil {
		return MemberStatistics{}, false, err
	}
	suppressed := breakdownParticipants > 0 && breakdownParticipants < privacyParticipantThreshold && !canViewAll
	dashboard.TopCategories.Suppressed = suppressed
	dashboard.TopProducts.Suppressed = suppressed
	if suppressed {
		return dashboard, true, nil
	}
	privacyMask := make([]bool, len(rangeValue.buckets))
	privacyApplied := false
	if !canViewAll {
		privacyMask, err = s.queryBreakdownPrivacyMask(ctx, membership.GroupID, rangeValue)
		if err != nil {
			return MemberStatistics{}, false, err
		}
		for _, masked := range privacyMask {
			privacyApplied = privacyApplied || masked
		}
	}
	if dashboard.TopCategories.Items, err = s.queryTopCategories(ctx, membership.GroupID, rangeValue, privacyMask); err != nil {
		return MemberStatistics{}, false, err
	}
	if dashboard.TopProducts.Items, err = s.queryTopProducts(ctx, membership.GroupID, rangeValue, privacyMask); err != nil {
		return MemberStatistics{}, false, err
	}
	return dashboard, privacyApplied, nil
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

func (s Service) queryBreakdownPrivacyMask(ctx context.Context, groupID string, rangeValue resolvedRange) ([]bool, error) {
	values, args := bucketValues(rangeValue)
	query := `WITH buckets(bucket_index,from_utc,to_utc) AS (VALUES ` + values + `)
		SELECT bucket.bucket_index,count(DISTINCT booking.target_membership_id)
		FROM buckets bucket
		JOIN bookings booking ON booking.created_at>=bucket.from_utc AND booking.created_at<bucket.to_utc
		WHERE booking.group_id=? AND (booking.voided_at IS NULL OR booking.voided_at>=?)
		GROUP BY bucket.bucket_index`
	args = append(args, groupID, platform.Timestamp(rangeValue.to))
	rows, err := s.queryer().QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("query breakdown privacy mask: %w", err)
	}
	defer rows.Close()
	mask := make([]bool, len(rangeValue.buckets))
	for rows.Next() {
		var bucketIndex int
		var participants int64
		if err := rows.Scan(&bucketIndex, &participants); err != nil {
			return nil, err
		}
		if bucketIndex < 0 || bucketIndex >= len(mask) {
			return nil, fmt.Errorf("breakdown privacy mask returned invalid bucket index %d", bucketIndex)
		}
		mask[bucketIndex] = participants > 0 && participants < privacyParticipantThreshold
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return mask, nil
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

func (s Service) queryTopCategories(ctx context.Context, groupID string, rangeValue resolvedRange, privacyMask []bool) ([]MemberCategoryItem, error) {
	values, args, hasVisibleBuckets, err := breakdownBucketValues(rangeValue, privacyMask)
	if err != nil {
		return nil, err
	}
	if !hasVisibleBuckets {
		return make([]MemberCategoryItem, 0), nil
	}
	query := `WITH buckets(bucket_index,from_utc,to_utc,is_visible) AS (VALUES ` + values + `),
		contributions AS (
			SELECT booking.category_id,category.name AS category_name,category.icon,bucket.bucket_index,sum(booking.quantity) AS units
			FROM buckets bucket
			JOIN bookings booking ON booking.created_at>=bucket.from_utc AND booking.created_at<bucket.to_utc
			JOIN categories category ON category.group_id=booking.group_id AND category.id=booking.category_id
			WHERE bucket.is_visible=1 AND booking.group_id=? AND (booking.voided_at IS NULL OR booking.voided_at>=?)
			GROUP BY booking.category_id,category.name,category.icon,bucket.bucket_index
		), totals AS (
			SELECT category_id,category_name,icon,sum(units) AS total_units
			FROM contributions
			GROUP BY category_id,category_name,icon
		), ranked AS (
			SELECT category_id,category_name,icon,total_units,
				row_number() OVER (ORDER BY total_units DESC,lower(category_name),category_id) AS item_rank
			FROM totals
		), projected AS (
			SELECT
				CASE WHEN ranked.item_rank<=` + fmt.Sprint(topBreakdownLimit) + ` THEN ranked.category_id ELSE '' END AS category_id,
				CASE WHEN ranked.item_rank<=` + fmt.Sprint(topBreakdownLimit) + ` THEN ranked.category_name ELSE 'Other' END AS category_name,
				CASE WHEN ranked.item_rank<=` + fmt.Sprint(topBreakdownLimit) + ` THEN ranked.icon ELSE 'other' END AS icon,
				CASE WHEN ranked.item_rank<=` + fmt.Sprint(topBreakdownLimit) + ` THEN ranked.item_rank ELSE ` + fmt.Sprint(topBreakdownLimit+1) + ` END AS display_rank,
				contribution.bucket_index,sum(contribution.units) AS units
			FROM contributions contribution
			JOIN ranked ON ranked.category_id=contribution.category_id
			GROUP BY
				CASE WHEN ranked.item_rank<=` + fmt.Sprint(topBreakdownLimit) + ` THEN ranked.category_id ELSE '' END,
				CASE WHEN ranked.item_rank<=` + fmt.Sprint(topBreakdownLimit) + ` THEN ranked.category_name ELSE 'Other' END,
				CASE WHEN ranked.item_rank<=` + fmt.Sprint(topBreakdownLimit) + ` THEN ranked.icon ELSE 'other' END,
				CASE WHEN ranked.item_rank<=` + fmt.Sprint(topBreakdownLimit) + ` THEN ranked.item_rank ELSE ` + fmt.Sprint(topBreakdownLimit+1) + ` END,
				contribution.bucket_index
		)
		SELECT category_id,category_name,icon,bucket_index,units,
			sum(units) OVER (PARTITION BY display_rank) AS total_units
		FROM projected
		ORDER BY display_rank,bucket_index`
	args = append(args, groupID, platform.Timestamp(rangeValue.to))
	rows, err := s.queryer().QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]MemberCategoryItem, 0)
	positions := make(map[string]int)
	for rows.Next() {
		var categoryID, categoryName, icon string
		var bucketIndex int
		var units, total int64
		if err := rows.Scan(&categoryID, &categoryName, &icon, &bucketIndex, &units, &total); err != nil {
			return nil, err
		}
		position, exists := positions[categoryID]
		if !exists {
			position = len(positions)
			if position < topBreakdownLimit {
				items = append(items, MemberCategoryItem{
					CategoryID: categoryID, CategoryName: categoryName, Icon: icon,
					ValidBookedUnits: total, Series: memberBreakdownSeries(rangeValue, privacyMask),
				})
			} else {
				position = topBreakdownLimit
				if len(items) == topBreakdownLimit {
					items = append(items, MemberCategoryItem{
						CategoryName: "Other", Icon: "other", IsOther: true,
						Series: memberBreakdownSeries(rangeValue, privacyMask),
					})
				}
				items[position].ValidBookedUnits += total
			}
			positions[categoryID] = position
		}
		if err := addMemberBreakdownUnits(items[position].Series, bucketIndex, units); err != nil {
			return nil, fmt.Errorf("category statistics: %w", err)
		}
	}
	return items, rows.Err()
}

func (s Service) queryTopProducts(ctx context.Context, groupID string, rangeValue resolvedRange, privacyMask []bool) ([]MemberProductItem, error) {
	values, args, hasVisibleBuckets, err := breakdownBucketValues(rangeValue, privacyMask)
	if err != nil {
		return nil, err
	}
	if !hasVisibleBuckets {
		return make([]MemberProductItem, 0), nil
	}
	query := `WITH buckets(bucket_index,from_utc,to_utc,is_visible) AS (VALUES ` + values + `),
		contributions AS (
			SELECT booking.product_id,product.name AS product_name,booking.category_id,category.name AS category_name,
				bucket.bucket_index,sum(booking.quantity) AS units
			FROM buckets bucket
			JOIN bookings booking ON booking.created_at>=bucket.from_utc AND booking.created_at<bucket.to_utc
			JOIN products product ON product.group_id=booking.group_id AND product.id=booking.product_id
			JOIN categories category ON category.group_id=booking.group_id AND category.id=booking.category_id
			WHERE bucket.is_visible=1 AND booking.group_id=? AND (booking.voided_at IS NULL OR booking.voided_at>=?)
			GROUP BY booking.product_id,product.name,booking.category_id,category.name,bucket.bucket_index
		), totals AS (
			SELECT product_id,product_name,category_id,category_name,sum(units) AS total_units
			FROM contributions
			GROUP BY product_id,product_name,category_id,category_name
		), ranked AS (
			SELECT product_id,product_name,category_id,category_name,total_units,
				row_number() OVER (ORDER BY total_units DESC,lower(product_name),product_id) AS item_rank
			FROM totals
		), projected AS (
			SELECT
				CASE WHEN ranked.item_rank<=` + fmt.Sprint(topBreakdownLimit) + ` THEN ranked.product_id ELSE '' END AS product_id,
				CASE WHEN ranked.item_rank<=` + fmt.Sprint(topBreakdownLimit) + ` THEN ranked.product_name ELSE 'Other' END AS product_name,
				CASE WHEN ranked.item_rank<=` + fmt.Sprint(topBreakdownLimit) + ` THEN ranked.category_id ELSE '' END AS category_id,
				CASE WHEN ranked.item_rank<=` + fmt.Sprint(topBreakdownLimit) + ` THEN ranked.category_name ELSE 'Other' END AS category_name,
				CASE WHEN ranked.item_rank<=` + fmt.Sprint(topBreakdownLimit) + ` THEN ranked.item_rank ELSE ` + fmt.Sprint(topBreakdownLimit+1) + ` END AS display_rank,
				contribution.bucket_index,sum(contribution.units) AS units
			FROM contributions contribution
			JOIN ranked ON ranked.product_id=contribution.product_id
			GROUP BY
				CASE WHEN ranked.item_rank<=` + fmt.Sprint(topBreakdownLimit) + ` THEN ranked.product_id ELSE '' END,
				CASE WHEN ranked.item_rank<=` + fmt.Sprint(topBreakdownLimit) + ` THEN ranked.product_name ELSE 'Other' END,
				CASE WHEN ranked.item_rank<=` + fmt.Sprint(topBreakdownLimit) + ` THEN ranked.category_id ELSE '' END,
				CASE WHEN ranked.item_rank<=` + fmt.Sprint(topBreakdownLimit) + ` THEN ranked.category_name ELSE 'Other' END,
				CASE WHEN ranked.item_rank<=` + fmt.Sprint(topBreakdownLimit) + ` THEN ranked.item_rank ELSE ` + fmt.Sprint(topBreakdownLimit+1) + ` END,
				contribution.bucket_index
		)
		SELECT product_id,product_name,category_id,category_name,bucket_index,units,
			sum(units) OVER (PARTITION BY display_rank) AS total_units
		FROM projected
		ORDER BY display_rank,bucket_index`
	args = append(args, groupID, platform.Timestamp(rangeValue.to))
	rows, err := s.queryer().QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]MemberProductItem, 0)
	positions := make(map[string]int)
	for rows.Next() {
		var productID, productName, categoryID, categoryName string
		var bucketIndex int
		var units, total int64
		if err := rows.Scan(&productID, &productName, &categoryID, &categoryName, &bucketIndex, &units, &total); err != nil {
			return nil, err
		}
		position, exists := positions[productID]
		if !exists {
			position = len(positions)
			if position < topBreakdownLimit {
				items = append(items, MemberProductItem{
					ProductID: productID, ProductName: productName, CategoryID: categoryID, CategoryName: categoryName,
					ValidBookedUnits: total, Series: memberBreakdownSeries(rangeValue, privacyMask),
				})
			} else {
				position = topBreakdownLimit
				if len(items) == topBreakdownLimit {
					items = append(items, MemberProductItem{
						ProductName: "Other", CategoryName: "Other", IsOther: true,
						Series: memberBreakdownSeries(rangeValue, privacyMask),
					})
				}
				items[position].ValidBookedUnits += total
			}
			positions[productID] = position
		}
		if err := addMemberBreakdownUnits(items[position].Series, bucketIndex, units); err != nil {
			return nil, fmt.Errorf("product statistics: %w", err)
		}
	}
	return items, rows.Err()
}

const topBreakdownLimit = 6

// breakdownBucketValues creates one bounded CTE row per resolved bucket and
// carries the shared privacy decision into the category and product queries.
func breakdownBucketValues(rangeValue resolvedRange, privacyMask []bool) (string, []any, bool, error) {
	if len(privacyMask) != len(rangeValue.buckets) {
		return "", nil, false, fmt.Errorf("breakdown privacy mask has %d buckets, want %d", len(privacyMask), len(rangeValue.buckets))
	}
	rows := make([]string, len(rangeValue.buckets))
	args := make([]any, 0, len(rangeValue.buckets)*4)
	hasVisibleBuckets := false
	for index, bucket := range rangeValue.buckets {
		visible := !privacyMask[index]
		rows[index] = "(?,?,?,?)"
		args = append(args, index, platform.Timestamp(bucket.from), platform.Timestamp(bucket.to), visible)
		hasVisibleBuckets = hasVisibleBuckets || visible
	}
	return strings.Join(rows, ","), args, hasVisibleBuckets, nil
}

func memberBreakdownSeries(rangeValue resolvedRange, privacyMask []bool) []MemberBreakdownPoint {
	points := make([]MemberBreakdownPoint, len(rangeValue.buckets))
	for index, bucket := range rangeValue.buckets {
		points[index].PeriodStart = bucket.periodStart.Format(timeFormatWithOffset)
		points[index].PrivacySuppressed = privacyMask[index]
		points[index].IsPartial = !bucket.from.Equal(bucket.periodStart.UTC()) || !bucket.to.Equal(nextBucket(bucket.periodStart, rangeValue.meta.Bucket).UTC())
		if !privacyMask[index] {
			points[index].ValidBookedUnits = new(int64)
		}
	}
	return points
}

func addMemberBreakdownUnits(points []MemberBreakdownPoint, bucketIndex int, units int64) error {
	if bucketIndex < 0 || bucketIndex >= len(points) {
		return fmt.Errorf("returned invalid bucket index %d", bucketIndex)
	}
	if points[bucketIndex].PrivacySuppressed {
		return nil
	}
	if points[bucketIndex].ValidBookedUnits == nil {
		return fmt.Errorf("visible bucket %d has no value", bucketIndex)
	}
	*points[bucketIndex].ValidBookedUnits += units
	return nil
}
