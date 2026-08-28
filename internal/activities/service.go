// Package activities provides the permission-aware, server-paginated account
// activity read model used by the unified activities workspace.
package activities

import (
	"context"
	"database/sql"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/DasLukas/TeamTaler/internal/authorization"
	"github.com/DasLukas/TeamTaler/internal/bookings"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/media"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/tablequery"
)

// Kind identifies the immutable source transaction represented by an entry.
type Kind string

const (
	// KindBooking represents a charge created from the product catalog.
	KindBooking Kind = "BOOKING"
	// KindPayment represents money received for a member account.
	KindPayment Kind = "PAYMENT"
	// KindReversal represents the audited counter-effect of a reversed booking or payment.
	KindReversal Kind = "REVERSAL"
	// KindAdjustment represents a receivable correction without a booking or payment.
	KindAdjustment Kind = "ADJUSTMENT"
)

// Entry is one normalized, permission-scoped activity transaction. AmountMinor
// uses the member-receivable sign: positive values increase debt and negative
// values reduce debt or create credit.
type Entry struct {
	ID                     string                           `json:"id"`
	SourceID               string                           `json:"sourceId"`
	PeriodID               string                           `json:"periodId,omitempty"`
	Kind                   Kind                             `json:"kind"`
	TargetMembershipID     string                           `json:"targetMembershipId"`
	TargetDisplayName      string                           `json:"targetDisplayName"`
	TargetMembershipStatus string                           `json:"targetMembershipStatus"`
	TargetAvatarURL        string                           `json:"targetAvatarUrl,omitempty"`
	ActorMembershipID      string                           `json:"actorMembershipId,omitempty"`
	ActorDisplayName       string                           `json:"actorDisplayName,omitempty"`
	ActorMembershipStatus  string                           `json:"actorMembershipStatus,omitempty"`
	ActorAvatarURL         string                           `json:"actorAvatarUrl,omitempty"`
	DetailName             string                           `json:"detailName"`
	DetailNote             string                           `json:"detailNote,omitempty"`
	PaymentMethod          string                           `json:"paymentMethod,omitempty"`
	CategoryID             string                           `json:"categoryId,omitempty"`
	CategoryName           string                           `json:"categoryName,omitempty"`
	ProductID              string                           `json:"productId,omitempty"`
	Quantity               int                              `json:"quantity,omitempty"`
	AmountMinor            int64                            `json:"amountMinor,string"`
	Currency               string                           `json:"currency"`
	OccurredAt             string                           `json:"occurredAt"`
	Status                 string                           `json:"status"`
	Attachment             *domain.PaymentAttachmentSummary `json:"attachment,omitempty"`
	// RelatedActivityID links a reversed original to its reversal row and vice versa.
	RelatedActivityID string `json:"relatedActivityId,omitempty"`
	// ReversalSourceKind identifies whether a reversal cancels a booking or payment.
	ReversalSourceKind         Kind    `json:"reversalSourceKind,omitempty"`
	CanReverse                 bool    `json:"canReverse"`
	ReversalReasonRequired     bool    `json:"reversalReasonRequired"`
	ReversalWithoutReasonUntil *string `json:"reversalWithoutReasonUntil,omitempty"`
}

// Query describes the unified activity collection request. Date bounds accept
// ISO 8601 dates or RFC 3339 timestamps and amount bounds use signed minor units.
type Query struct {
	Search             string
	Kinds              []string
	TargetMembershipID string
	CategoryIDs        []string
	ProductIDs         []string
	Status             string
	OccurredFrom       string
	OccurredTo         string
	AmountMin          *int64
	AmountMax          *int64
	Sort               string
	Direction          string
	Cursor             string
	// AnchorID requests a centered, permission-scoped context window and pauses filters.
	AnchorID string
	Limit    int
}

// Page is one globally sorted, stable keyset-paginated activity slice.
type Page struct {
	Items      []Entry
	NextCursor string
}

// MemberFilterOption is a privacy-minimized target identity available in the
// caller's authorized activity scope.
type MemberFilterOption struct {
	MembershipID string `json:"membershipId"`
	DisplayName  string `json:"displayName"`
	AvatarURL    string `json:"avatarUrl,omitempty"`
}

// CategoryFilterOption identifies one booking category present in the
// authorized activity feed.
type CategoryFilterOption struct {
	CategoryID string              `json:"categoryId"`
	Name       string              `json:"name"`
	Icon       domain.CategoryIcon `json:"icon"`
}

// ProductFilterOption identifies one booking product present in the
// authorized activity feed. Historical product tombstones remain available
// even after they disappear from the active catalog.
type ProductFilterOption struct {
	ProductID  string `json:"productId"`
	CategoryID string `json:"categoryId"`
	Name       string `json:"name"`
	ImageURL   string `json:"imageUrl,omitempty"`
}

// FilterOptions contains every transaction kind, member, category, and product
// choice derived from the authorized feed.
type FilterOptions struct {
	Kinds      []Kind                 `json:"kinds"`
	Members    []MemberFilterOption   `json:"members"`
	Categories []CategoryFilterOption `json:"categories"`
	Products   []ProductFilterOption  `json:"products"`
}

func (s Service) listKindFilterOptions(ctx context.Context, membership domain.Membership, access permissions) ([]Kind, error) {
	query, args := visibleActivityCTE(membership, access)
	query += ` SELECT DISTINCT kind FROM activity`
	rows, err := s.DB.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list unified activity kind filter options: %w", err)
	}
	defer rows.Close()
	present := make(map[Kind]struct{})
	for rows.Next() {
		var kind Kind
		if err := rows.Scan(&kind); err != nil {
			return nil, err
		}
		switch kind {
		case KindBooking, KindPayment, KindReversal, KindAdjustment:
			present[kind] = struct{}{}
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	options := make([]Kind, 0, len(present))
	for _, kind := range []Kind{KindBooking, KindPayment, KindReversal, KindAdjustment} {
		if _, exists := present[kind]; exists {
			options = append(options, kind)
		}
	}
	return options, nil
}

// Service queries unified activities from the shared application database.
type Service struct {
	// DB is the migrated application database connection pool.
	DB *sql.DB
}

type permissions struct {
	viewAllBookings bool
	manageFinance   bool
	voidOwnBooking  bool
	voidAnyBooking  bool
}

var activitySorts = map[string]struct{}{
	"kind": {}, "targetName": {}, "actorName": {}, "detailName": {},
	"categoryName": {}, "occurredAt": {}, "amount": {}, "status": {},
}

const (
	maxFilterValues               = 200
	activityFeedProjectionVersion = 2
	activityOccurredExpression    = `strftime('%Y-%m-%dT%H:%M:%fZ',activity.occurred_at)`
)

func activitySortExpression(sortKey string) string {
	switch sortKey {
	case "kind":
		return "activity.kind"
	case "targetName":
		return "lower(activity.target_name)"
	case "actorName":
		return "lower(coalesce(nullif(activity.actor_name,''),char(1)))"
	case "detailName":
		return "lower(coalesce(nullif(activity.detail_name,''),char(1)))"
	case "categoryName":
		return "lower(coalesce(nullif(activity.category_name,''),char(1)))"
	case "amount":
		return "activity.amount_minor"
	case "status":
		return "activity.status"
	default:
		return activityOccurredExpression
	}
}

func normalizeFilterValues(field string, values []string, uppercase bool) ([]string, error) {
	unique := make(map[string]struct{}, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if uppercase {
			value = strings.ToUpper(value)
		}
		if value == "" {
			continue
		}
		if len(value) > 200 {
			return nil, domain.ValidationError{Field: field, Message: "values must contain at most 200 characters"}
		}
		unique[value] = struct{}{}
		if len(unique) > maxFilterValues {
			return nil, domain.ValidationError{Field: field, Message: "must contain at most 200 values"}
		}
	}
	result := make([]string, 0, len(unique))
	for value := range unique {
		result = append(result, value)
	}
	sort.Strings(result)
	return result, nil
}

func placeholders(count int) string {
	return strings.TrimSuffix(strings.Repeat("?,", count), ",")
}

func (s Service) permissions(ctx context.Context, membership domain.Membership) (permissions, error) {
	policy := authorization.NewPolicy(s.DB)
	resource := authorization.GroupResource(membership.GroupID)
	checks := []domain.PermissionKey{
		domain.PermissionViewAllBookingActivity,
		domain.PermissionFinanceManagement,
		domain.PermissionVoidOwnBooking,
		domain.PermissionVoidAnyBooking,
	}
	values := make([]bool, len(checks))
	for index, permission := range checks {
		allowed, err := policy.Can(ctx, membership.GroupID, membership.ID, permission, resource)
		if err != nil {
			return permissions{}, err
		}
		values[index] = allowed
	}
	return permissions{
		viewAllBookings: values[0],
		manageFinance:   values[1],
		voidOwnBooking:  values[2],
		voidAnyBooking:  values[3],
	}, nil
}

func visibleActivityCTE(membership domain.Membership, access permissions) (string, []any) {
	bookingScope := ""
	bookingArgs := []any{membership.GroupID}
	if !access.viewAllBookings {
		bookingScope = " AND (b.target_membership_id=? OR b.actor_membership_id=?)"
		bookingArgs = append(bookingArgs, membership.ID, membership.ID)
	}
	paymentScope := ""
	paymentArgs := []any{membership.GroupID}
	if !access.manageFinance {
		paymentScope = " AND p.membership_id=?"
		paymentArgs = append(paymentArgs, membership.ID)
	}
	adjustmentScope := ""
	adjustmentArgs := []any{membership.GroupID}
	if !access.manageFinance {
		adjustmentScope = " AND entry.membership_id=?"
		adjustmentArgs = append(adjustmentArgs, membership.ID)
	}

	query := `WITH activity AS (
		SELECT 'booking:' || b.id AS id,b.id AS source_id,b.period_id,'BOOKING' AS kind,
			target_member.id AS target_membership_id,target_user.display_name AS target_name,
			CASE WHEN target_member.deleted_at IS NOT NULL THEN 'DELETED' ELSE target_member.status END AS target_status,
			target_user.id AS target_user_id,coalesce(target_user.avatar_key,'') AS target_avatar_key,
			actor_member.id AS actor_membership_id,actor_user.display_name AS actor_name,
			CASE WHEN actor_member.deleted_at IS NOT NULL THEN 'DELETED' ELSE actor_member.status END AS actor_status,
			actor_user.id AS actor_user_id,coalesce(actor_user.avatar_key,'') AS actor_avatar_key,
			b.product_name AS detail_name,coalesce(b.reason,'') AS detail_note,NULL AS payment_method,b.category_id,b.category_name,b.product_id,b.quantity,
			b.total_minor AS amount_minor,g.currency,b.created_at AS occurred_at,
			CASE WHEN b.voided_at IS NULL THEN 'POSTED' ELSE 'REVERSED' END AS status,
			NULL AS attachment_name,NULL AS attachment_type,NULL AS attachment_size,
			CASE WHEN b.voided_at IS NOT NULL THEN 'reversal:booking:' || b.id END AS related_activity_id,NULL AS reversal_source_kind
		FROM bookings b JOIN groups g ON g.id=b.group_id
		JOIN memberships target_member ON target_member.group_id=b.group_id AND target_member.id=b.target_membership_id
		JOIN users target_user ON target_user.id=target_member.user_id
		JOIN memberships actor_member ON actor_member.group_id=b.group_id AND actor_member.id=b.actor_membership_id
		JOIN users actor_user ON actor_user.id=actor_member.user_id
		WHERE b.group_id=?` + bookingScope + `
		UNION ALL
		SELECT 'payment:' || p.id,p.id,NULL,'PAYMENT',
			target_member.id,target_user.display_name,
			CASE WHEN target_member.deleted_at IS NOT NULL THEN 'DELETED' ELSE target_member.status END,
			target_user.id,coalesce(target_user.avatar_key,''),
			actor_member.id,actor_user.display_name,
			CASE WHEN actor_member.deleted_at IS NOT NULL THEN 'DELETED' ELSE actor_member.status END,
			actor_user.id,coalesce(actor_user.avatar_key,''),
			coalesce(nullif(p.method_label,''),''),coalesce(nullif(p.reference,''),nullif(p.note,''),''),p.method,NULL,'',NULL,NULL,
			-p.amount_minor,g.currency,p.created_at,
			CASE WHEN p.reversed_at IS NULL THEN 'POSTED' ELSE 'REVERSED' END,
			attachment.original_filename,attachment.media_type,attachment.size_bytes,
			CASE WHEN p.reversed_at IS NOT NULL THEN 'reversal:payment:' || p.id END,NULL
		FROM payments p JOIN groups g ON g.id=p.group_id
		JOIN memberships target_member ON target_member.group_id=p.group_id AND target_member.id=p.membership_id
		JOIN users target_user ON target_user.id=target_member.user_id
		JOIN memberships actor_member ON actor_member.group_id=p.group_id AND actor_member.id=p.created_by
		JOIN users actor_user ON actor_user.id=actor_member.user_id
		LEFT JOIN payment_attachments attachment ON attachment.group_id=p.group_id AND attachment.payment_id=p.id
		WHERE p.group_id=?` + paymentScope + `
		UNION ALL
		SELECT 'reversal:booking:' || b.id,b.id,b.period_id,'REVERSAL',
			target_member.id,target_user.display_name,
			CASE WHEN target_member.deleted_at IS NOT NULL THEN 'DELETED' ELSE target_member.status END,
			target_user.id,coalesce(target_user.avatar_key,''),
			actor_member.id,actor_user.display_name,
			CASE WHEN actor_member.deleted_at IS NOT NULL THEN 'DELETED' ELSE actor_member.status END,
			actor_user.id,actor_user.avatar_key,
			b.product_name,coalesce(b.void_reason,''),NULL,b.category_id,b.category_name,b.product_id,b.quantity,
			-b.total_minor,g.currency,b.voided_at,'POSTED',NULL,NULL,NULL,'booking:' || b.id,'BOOKING'
		FROM bookings b JOIN groups g ON g.id=b.group_id
		JOIN memberships target_member ON target_member.group_id=b.group_id AND target_member.id=b.target_membership_id
		JOIN users target_user ON target_user.id=target_member.user_id
		LEFT JOIN memberships actor_member ON actor_member.group_id=b.group_id AND actor_member.id=b.voided_by
		LEFT JOIN users actor_user ON actor_user.id=actor_member.user_id
		WHERE b.group_id=? AND b.voided_at IS NOT NULL` + bookingScope + `
		UNION ALL
		SELECT 'reversal:payment:' || p.id,p.id,NULL,'REVERSAL',
			target_member.id,target_user.display_name,
			CASE WHEN target_member.deleted_at IS NOT NULL THEN 'DELETED' ELSE target_member.status END,
			target_user.id,coalesce(target_user.avatar_key,''),
			actor_member.id,actor_user.display_name,
			CASE WHEN actor_member.deleted_at IS NOT NULL THEN 'DELETED' ELSE actor_member.status END,
			actor_user.id,actor_user.avatar_key,
			coalesce(nullif(p.method_label,''),''),coalesce(p.reversal_reason,''),p.method,NULL,'',NULL,NULL,
			p.amount_minor,g.currency,p.reversed_at,'POSTED',NULL,NULL,NULL,'payment:' || p.id,'PAYMENT'
		FROM payments p JOIN groups g ON g.id=p.group_id
		JOIN memberships target_member ON target_member.group_id=p.group_id AND target_member.id=p.membership_id
		JOIN users target_user ON target_user.id=target_member.user_id
		LEFT JOIN memberships actor_member ON actor_member.group_id=p.group_id AND actor_member.id=p.reversed_by
		LEFT JOIN users actor_user ON actor_user.id=actor_member.user_id
		WHERE p.group_id=? AND p.reversed_at IS NOT NULL` + paymentScope + `
		UNION ALL
		SELECT 'adjustment:' || entry.id,entry.id,entry.period_id,'ADJUSTMENT',
			target_member.id,target_user.display_name,
			CASE WHEN target_member.deleted_at IS NOT NULL THEN 'DELETED' ELSE target_member.status END,
			target_user.id,coalesce(target_user.avatar_key,''),
			NULL,'','',NULL,'',entry.description,'',NULL,NULL,'',NULL,NULL,
			entry.amount_minor,g.currency,entry.created_at,'POSTED',NULL,NULL,NULL,NULL,NULL
		FROM ledger_entries entry JOIN groups g ON g.id=entry.group_id
		JOIN memberships target_member ON target_member.group_id=entry.group_id AND target_member.id=entry.membership_id
		JOIN users target_user ON target_user.id=target_member.user_id
		WHERE entry.group_id=? AND entry.account='MEMBER_RECEIVABLE'
			AND entry.booking_id IS NULL AND entry.payment_id IS NULL AND entry.reversal_of IS NULL` + adjustmentScope + `
	)`
	args := append(bookingArgs, paymentArgs...)
	args = append(args, bookingArgs...)
	args = append(args, paymentArgs...)
	args = append(args, adjustmentArgs...)
	return query, args
}

// QueryEntries returns one authorized, globally filtered and sorted activity
// page. Authorization is evaluated before user filters and included in the
// cursor fingerprint, so cursors cannot be replayed across permission scopes.
// An anchor query pauses filters and returns a centered, unfiltered context
// window in the requested sort order.
//
// Parameters:
//   - ctx: Request lifetime and cancellation context.
//   - membership: Authenticated membership and tenant scope.
//   - input: Search, filter, sort, and cursor options.
//
// Returns:
//   - Page: Visible normalized entries and an optional next cursor.
//   - error: Validation, policy, cursor, or database failure.
//
// Example: service.QueryEntries(ctx, membership, Query{Limit: 50}).
func (s Service) QueryEntries(ctx context.Context, membership domain.Membership, input Query) (Page, error) {
	access, err := s.permissions(ctx, membership)
	if err != nil {
		return Page{}, err
	}
	input.Search, err = tablequery.NormalizeSearch(input.Search)
	if err != nil {
		return Page{}, err
	}
	input.Sort, input.Direction, err = tablequery.NormalizeSort(input.Sort, input.Direction, "occurredAt", "desc", activitySorts)
	if err != nil {
		return Page{}, err
	}
	input.OccurredFrom, err = tablequery.NormalizeTimeBound("occurredFrom", input.OccurredFrom, false)
	if err != nil {
		return Page{}, err
	}
	input.OccurredTo, err = tablequery.NormalizeTimeBound("occurredTo", input.OccurredTo, true)
	if err != nil {
		return Page{}, err
	}
	if input.OccurredFrom != "" && input.OccurredTo != "" && input.OccurredFrom >= input.OccurredTo {
		return Page{}, domain.ValidationError{Field: "occurredTo", Message: "must be later than occurredFrom"}
	}
	if input.AmountMin != nil && input.AmountMax != nil && *input.AmountMin > *input.AmountMax {
		return Page{}, domain.ValidationError{Field: "amountMax", Message: "must be greater than or equal to amountMin"}
	}
	input.Kinds, err = normalizeFilterValues("kind", input.Kinds, true)
	if err != nil {
		return Page{}, err
	}
	for _, kind := range input.Kinds {
		if kind != string(KindBooking) && kind != string(KindPayment) && kind != string(KindReversal) && kind != string(KindAdjustment) {
			return Page{}, domain.ValidationError{Field: "kind", Message: "must contain BOOKING, PAYMENT, REVERSAL, or ADJUSTMENT"}
		}
	}
	input.CategoryIDs, err = normalizeFilterValues("categoryId", input.CategoryIDs, false)
	if err != nil {
		return Page{}, err
	}
	input.ProductIDs, err = normalizeFilterValues("productId", input.ProductIDs, false)
	if err != nil {
		return Page{}, err
	}
	input.Status = strings.ToUpper(strings.TrimSpace(input.Status))
	if input.Status != "" && input.Status != "POSTED" && input.Status != "REVERSED" {
		return Page{}, domain.ValidationError{Field: "status", Message: "must be POSTED or REVERSED"}
	}
	input.TargetMembershipID = strings.TrimSpace(input.TargetMembershipID)
	input.AnchorID = strings.TrimSpace(input.AnchorID)
	if len(input.AnchorID) > 500 {
		return Page{}, domain.ValidationError{Field: "anchorId", Message: "must contain at most 500 characters"}
	}
	if input.AnchorID != "" && input.Cursor != "" {
		return Page{}, domain.ValidationError{Field: "anchorId", Message: "cannot be combined with cursor"}
	}
	if input.Limit < 1 || input.Limit > 200 {
		input.Limit = 100
	}
	if input.AnchorID != "" {
		input.Search = ""
		input.Kinds = []string{}
		input.TargetMembershipID = ""
		input.CategoryIDs = []string{}
		input.ProductIDs = []string{}
		input.Status = ""
		input.OccurredFrom = ""
		input.OccurredTo = ""
		input.AmountMin = nil
		input.AmountMax = nil
	}

	fingerprint, err := tablequery.Fingerprint(struct {
		ProjectionVersion                                              int
		GroupID, ViewerMembershipID, Search, TargetMembershipID        string
		Kinds, CategoryIDs, ProductIDs                                 []string
		Status, OccurredFrom, OccurredTo, Sort, Direction              string
		AmountMin, AmountMax                                           *int64
		ViewAllBookings, ManageFinance, VoidOwnBooking, VoidAnyBooking bool
	}{
		activityFeedProjectionVersion,
		membership.GroupID, membership.ID, input.Search, input.TargetMembershipID,
		input.Kinds, input.CategoryIDs, input.ProductIDs,
		input.Status, input.OccurredFrom, input.OccurredTo, input.Sort, input.Direction,
		input.AmountMin, input.AmountMax,
		access.viewAllBookings, access.manageFinance, access.voidOwnBooking, access.voidAnyBooking,
	})
	if err != nil {
		return Page{}, err
	}
	cursorKey, cursorID, err := tablequery.DecodeCursor(input.Cursor, fingerprint, input.Sort, input.Direction)
	if err != nil {
		return Page{}, err
	}

	query, args := visibleActivityCTE(membership, access)
	sortExpression := activitySortExpression(input.Sort)
	orderKeyword, comparison := tablequery.SQLOrderFragments(input.Direction)
	anchorQuery := input.AnchorID != ""
	if anchorQuery {
		query += `, ranked_activity AS (
			SELECT activity.*,CAST(` + sortExpression + ` AS TEXT) AS sort_key,
				row_number() OVER (ORDER BY ` + sortExpression + ` ` + orderKeyword + `,activity.id ` + orderKeyword + `) AS row_position,
				count(*) OVER () AS total_rows
			FROM activity
		), anchor_activity AS (
			SELECT row_position,total_rows FROM ranked_activity WHERE id=?
		), window_bounds AS (
			SELECT max(1,min(row_position-?,max(total_rows-?+1,1))) AS start_position FROM anchor_activity
		)
		SELECT ranked_activity.* FROM ranked_activity,window_bounds
		WHERE ranked_activity.row_position>=window_bounds.start_position
		ORDER BY ranked_activity.row_position LIMIT ?`
		args = append(args, input.AnchorID, input.Limit/2, input.Limit, input.Limit+1)
	} else {
		query += ` SELECT activity.*,CAST(` + sortExpression + ` AS TEXT) FROM activity WHERE 1=1`
		if len(input.Kinds) > 0 {
			query += ` AND activity.kind IN (` + placeholders(len(input.Kinds)) + `)`
			for _, kind := range input.Kinds {
				args = append(args, kind)
			}
		}
		if input.TargetMembershipID != "" {
			query += ` AND activity.target_membership_id=?`
			args = append(args, input.TargetMembershipID)
		}
		if len(input.CategoryIDs) > 0 {
			query += ` AND activity.category_id IN (` + placeholders(len(input.CategoryIDs)) + `)`
			for _, categoryID := range input.CategoryIDs {
				args = append(args, categoryID)
			}
		}
		if len(input.ProductIDs) > 0 {
			query += ` AND activity.product_id IN (` + placeholders(len(input.ProductIDs)) + `)`
			for _, productID := range input.ProductIDs {
				args = append(args, productID)
			}
		}
		if input.Status != "" {
			query += ` AND activity.status=?`
			args = append(args, input.Status)
		}
		if input.OccurredFrom != "" {
			query += ` AND ` + activityOccurredExpression + `>=?`
			args = append(args, input.OccurredFrom)
		}
		if input.OccurredTo != "" {
			query += ` AND ` + activityOccurredExpression + `<?`
			args = append(args, input.OccurredTo)
		}
		if input.AmountMin != nil {
			query += ` AND activity.amount_minor>=?`
			args = append(args, *input.AmountMin)
		}
		if input.AmountMax != nil {
			query += ` AND activity.amount_minor<=?`
			args = append(args, *input.AmountMax)
		}
		if input.Search != "" {
			pattern := tablequery.LikePattern(input.Search)
			query += ` AND (activity.target_name LIKE ? ESCAPE '\' COLLATE NOCASE
			OR activity.actor_name LIKE ? ESCAPE '\' COLLATE NOCASE
			OR activity.detail_name LIKE ? ESCAPE '\' COLLATE NOCASE
			OR activity.detail_note LIKE ? ESCAPE '\' COLLATE NOCASE
			OR activity.payment_method LIKE ? ESCAPE '\' COLLATE NOCASE
			OR activity.category_name LIKE ? ESCAPE '\' COLLATE NOCASE
			OR CAST(activity.amount_minor AS TEXT) LIKE ? ESCAPE '\'
			OR activity.kind LIKE ? ESCAPE '\' COLLATE NOCASE
			OR activity.status LIKE ? ESCAPE '\' COLLATE NOCASE)`
			args = append(args, pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern)
		}
		if cursorID != "" {
			var boundKey any = cursorKey
			if input.Sort == "amount" {
				boundKey, err = strconv.ParseInt(cursorKey, 10, 64)
				if err != nil {
					return Page{}, domain.ValidationError{Field: "cursor", Message: "is invalid or does not match the current query"}
				}
			}
			query += ` AND (` + sortExpression + ` ` + comparison + ` ? OR (` + sortExpression + ` = ? AND activity.id ` + comparison + ` ?))`
			args = append(args, boundKey, boundKey, cursorID)
		}
		query += ` ORDER BY ` + sortExpression + ` ` + orderKeyword + `,activity.id ` + orderKeyword + ` LIMIT ?`
		args = append(args, input.Limit+1)
	}

	rows, err := s.DB.QueryContext(ctx, query, args...)
	if err != nil {
		return Page{}, fmt.Errorf("query unified activities: %w", err)
	}
	defer rows.Close()
	items := make([]Entry, 0, input.Limit+1)
	sortKeys := make([]string, 0, input.Limit+1)
	requestNow := platform.Now()
	for rows.Next() {
		var item Entry
		var periodID, actorMembershipID, actorName, actorStatus, actorUserID, actorAvatarKey sql.NullString
		var paymentMethod, categoryID, categoryName, productID sql.NullString
		var quantity sql.NullInt64
		var attachmentName, attachmentType sql.NullString
		var attachmentSize sql.NullInt64
		var relatedActivityID, reversalSourceKind sql.NullString
		var targetUserID, targetAvatarKey, sortKey string
		destinations := []any{
			&item.ID, &item.SourceID, &periodID, &item.Kind,
			&item.TargetMembershipID, &item.TargetDisplayName, &item.TargetMembershipStatus, &targetUserID, &targetAvatarKey,
			&actorMembershipID, &actorName, &actorStatus, &actorUserID, &actorAvatarKey,
			&item.DetailName, &item.DetailNote, &paymentMethod, &categoryID, &categoryName, &productID, &quantity,
			&item.AmountMinor, &item.Currency, &item.OccurredAt, &item.Status,
			&attachmentName, &attachmentType, &attachmentSize, &relatedActivityID, &reversalSourceKind, &sortKey,
		}
		if anchorQuery {
			var rowPosition, totalRows int
			destinations = append(destinations, &rowPosition, &totalRows)
		}
		if err := rows.Scan(destinations...); err != nil {
			return Page{}, err
		}
		item.PeriodID = periodID.String
		item.TargetAvatarURL = media.UserAvatarURL(targetUserID, targetAvatarKey)
		item.ActorMembershipID = actorMembershipID.String
		item.ActorDisplayName = actorName.String
		item.ActorMembershipStatus = actorStatus.String
		if actorUserID.Valid {
			item.ActorAvatarURL = media.UserAvatarURL(actorUserID.String, actorAvatarKey.String)
		}
		item.CategoryID = categoryID.String
		item.PaymentMethod = paymentMethod.String
		item.CategoryName = categoryName.String
		item.ProductID = productID.String
		item.Quantity = int(quantity.Int64)
		item.RelatedActivityID = relatedActivityID.String
		item.ReversalSourceKind = Kind(reversalSourceKind.String)
		if attachmentName.Valid && attachmentType.Valid && attachmentSize.Valid && item.Kind == KindPayment {
			item.Attachment = &domain.PaymentAttachmentSummary{
				FileName: attachmentName.String, MediaType: attachmentType.String, SizeBytes: attachmentSize.Int64,
				URL: "/api/v1/groups/" + membership.GroupID + "/payments/" + item.SourceID + "/attachment",
			}
		}
		if item.Kind == KindBooking {
			booking := domain.Booking{
				ID: item.SourceID, ActorMembershipID: item.ActorMembershipID,
				TargetMembershipID: item.TargetMembershipID, CreatedAt: item.OccurredAt,
			}
			if item.Status == "REVERSED" {
				value := item.OccurredAt
				booking.VoidedAt = &value
			}
			bookings.ApplyVoidMetadata(&booking, membership, access.voidOwnBooking, access.voidAnyBooking, requestNow)
			item.CanReverse = booking.CanVoid
			item.ReversalReasonRequired = booking.VoidReasonRequired
			item.ReversalWithoutReasonUntil = booking.VoidWithoutReasonUntil
		} else if item.Kind == KindPayment {
			item.CanReverse = access.manageFinance && item.Status == "POSTED"
			item.ReversalReasonRequired = item.CanReverse
		}
		items = append(items, item)
		sortKeys = append(sortKeys, sortKey)
	}
	if err := rows.Err(); err != nil {
		return Page{}, err
	}
	if anchorQuery && len(items) == 0 {
		return Page{}, domain.ErrNotFound
	}
	page := Page{Items: items}
	if len(items) > input.Limit {
		page.Items = items[:input.Limit]
		last := page.Items[len(page.Items)-1]
		page.NextCursor, err = tablequery.EncodeCursor(fingerprint, input.Sort, input.Direction, sortKeys[input.Limit-1], last.ID)
		if err != nil {
			return Page{}, err
		}
	}
	return page, nil
}

func (s Service) listMemberFilterOptions(ctx context.Context, membership domain.Membership, access permissions) ([]MemberFilterOption, error) {
	query, args := visibleActivityCTE(membership, access)
	query += ` SELECT DISTINCT target_membership_id,target_name,target_user_id,target_avatar_key
		FROM activity ORDER BY lower(target_name),target_membership_id`
	rows, err := s.DB.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list unified activity member filter options: %w", err)
	}
	defer rows.Close()
	options := make([]MemberFilterOption, 0)
	for rows.Next() {
		var item MemberFilterOption
		var userID, avatarKey string
		if err := rows.Scan(&item.MembershipID, &item.DisplayName, &userID, &avatarKey); err != nil {
			return nil, err
		}
		item.AvatarURL = media.UserAvatarURL(userID, avatarKey)
		options = append(options, item)
	}
	return options, rows.Err()
}

func (s Service) listCatalogFilterOptions(ctx context.Context, membership domain.Membership, access permissions) ([]CategoryFilterOption, []ProductFilterOption, error) {
	query, args := visibleActivityCTE(membership, access)
	query += ` SELECT DISTINCT activity.category_id,
		coalesce(category.name,activity.category_name) AS category_name,
		coalesce(category.icon,'other') AS category_icon,
		activity.product_id,coalesce(product.name,activity.detail_name) AS product_name,
		coalesce(product.image_key,'') AS product_image_key
		FROM activity
		LEFT JOIN categories category ON category.group_id=? AND category.id=activity.category_id
		LEFT JOIN products product ON product.group_id=? AND product.id=activity.product_id
		WHERE activity.kind='BOOKING' AND activity.category_id IS NOT NULL AND activity.product_id IS NOT NULL
		ORDER BY lower(category_name),activity.category_id,lower(product_name),activity.product_id`
	args = append(args, membership.GroupID, membership.GroupID)
	rows, err := s.DB.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, nil, fmt.Errorf("list unified activity catalog filter options: %w", err)
	}
	defer rows.Close()
	categories := make([]CategoryFilterOption, 0)
	products := make([]ProductFilterOption, 0)
	seenCategories := make(map[string]struct{})
	for rows.Next() {
		var category CategoryFilterOption
		var product ProductFilterOption
		var imageKey string
		if err := rows.Scan(&category.CategoryID, &category.Name, &category.Icon, &product.ProductID, &product.Name, &imageKey); err != nil {
			return nil, nil, err
		}
		product.CategoryID = category.CategoryID
		if imageKey != "" {
			product.ImageURL = "/api/v1/groups/" + membership.GroupID + "/images/" + imageKey
		}
		if _, exists := seenCategories[category.CategoryID]; !exists {
			seenCategories[category.CategoryID] = struct{}{}
			categories = append(categories, category)
		}
		products = append(products, product)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	return categories, products, nil
}

// ListFilterOptions returns every kind, target, category, and product reachable
// through the same authorization boundary as QueryEntries.
//
// Parameters:
//   - ctx: Request lifetime and cancellation context.
//   - membership: Authenticated membership and tenant scope.
//
// Returns:
//   - FilterOptions: Deduplicated, display-name-sorted feed choices.
//   - error: Policy or database failure.
//
// Example: service.ListFilterOptions(ctx, membership).
func (s Service) ListFilterOptions(ctx context.Context, membership domain.Membership) (FilterOptions, error) {
	access, err := s.permissions(ctx, membership)
	if err != nil {
		return FilterOptions{}, err
	}
	kinds, err := s.listKindFilterOptions(ctx, membership, access)
	if err != nil {
		return FilterOptions{}, err
	}
	members, err := s.listMemberFilterOptions(ctx, membership, access)
	if err != nil {
		return FilterOptions{}, err
	}
	categories, products, err := s.listCatalogFilterOptions(ctx, membership, access)
	if err != nil {
		return FilterOptions{}, err
	}
	return FilterOptions{Kinds: kinds, Members: members, Categories: categories, Products: products}, nil
}
