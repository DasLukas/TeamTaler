// Package bookings implements atomic catalog charges and audited reversals.
package bookings

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/DasLukas/TeamTaler/internal/audit"
	"github.com/DasLukas/TeamTaler/internal/authorization"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/groups"
	"github.com/DasLukas/TeamTaler/internal/idempotency"
	"github.com/DasLukas/TeamTaler/internal/ledger"
	"github.com/DasLukas/TeamTaler/internal/media"
	"github.com/DasLukas/TeamTaler/internal/notifications"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

// Service implements booking commands and queries. DB must be migrated and
// Groups supplies compatible group read-model dependencies.
type Service struct {
	// DB is the shared application database connection pool.
	DB *sql.DB
	// Groups resolves group read-model dependencies retained by the service API.
	Groups groups.Service
	// Notifications atomically records member-visible booking events.
	Notifications notifications.Service
}

const voidWithoutReasonWindow = 30 * time.Second

func canPermission(ctx context.Context, queryer authorization.Queryer, membership domain.Membership, permission domain.PermissionKey) (bool, error) {
	return authorization.NewPolicy(queryer).Can(ctx, membership.GroupID, membership.ID, permission, authorization.ResourceContext{GroupID: membership.GroupID})
}

func requirePermission(ctx context.Context, queryer authorization.Queryer, membership domain.Membership, permission domain.PermissionKey) error {
	allowed, err := canPermission(ctx, queryer, membership, permission)
	if err != nil {
		return err
	}
	if !allowed {
		return domain.ErrForbidden
	}
	return nil
}

// CreateInput is the idempotent booking command contract. ProductVersion and
// ExpectedPeriodID provide optimistic protection against stale client state.
type CreateInput struct {
	ProductID          string `json:"productId"`
	ProductVersion     int64  `json:"productVersion"`
	ExpectedPeriodID   string `json:"expectedPeriodId"`
	Quantity           int    `json:"quantity"`
	UnitPriceMinor     *int64 `json:"unitPriceMinor,omitempty"`
	TargetMembershipID string `json:"targetMembershipId,omitempty"`
	Reason             string `json:"reason,omitempty"`
}

// BatchCreateInput is the idempotent multi-target booking command contract.
// Every target receives an independent immutable booking with the same product,
// quantity, price, and reason. Target membership IDs must be unique.
type BatchCreateInput struct {
	ProductID                string   `json:"productId"`
	ProductVersion           int64    `json:"productVersion"`
	ExpectedPeriodID         string   `json:"expectedPeriodId"`
	Quantity                 int      `json:"quantity"`
	UnitPriceMinor           *int64   `json:"unitPriceMinor,omitempty"`
	TargetMembershipIDs      []string `json:"targetMembershipIds"`
	ManagedGuestDisplayNames []string `json:"managedGuestDisplayNames,omitempty"`
	Reason                   string   `json:"reason,omitempty"`
}

// BookingTarget is the privacy-minimized active-membership representation used
// by the booking form. It deliberately omits user IDs, email, roles, and grants.
type BookingTarget struct {
	MembershipID string `json:"membershipId"`
	DisplayName  string `json:"displayName"`
	AvatarURL    string `json:"avatarUrl,omitempty"`
	IsGuest      bool   `json:"isGuest"`
}

// BookingContext is the single read model required by the booking page. It
// combines the current period and own account state with authorized targets.
type BookingContext struct {
	OpenPeriod             domain.Period     `json:"openPeriod"`
	OwnBalanceMinor        int64             `json:"ownBalanceMinor,string"`
	CurrentMembership      domain.Membership `json:"currentMembership"`
	Targets                []BookingTarget   `json:"targets"`
	CanCreateManagedGuests bool              `json:"canCreateManagedGuests"`
}

type bookingDetails struct {
	categoryID        string
	productName       string
	categoryName      string
	periodID          string
	currency          string
	unitPriceMinor    int64
	totalMinor        int64
	ledgerDescription string
}

type bookingQueryer interface {
	authorization.Queryer
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// Context returns the privacy-minimized read model needed to render a booking
// form. Members without BOOK_FOR_OTHERS receive only themselves as a target;
// managed-guest creation additionally requires the group feature to be enabled.
//
// Parameters:
//   - ctx: Cancellation and deadline context.
//   - membership: Authenticated active membership and tenant scope.
//
// Returns:
//   - BookingContext: Open period, own balance, current membership, and targets.
//   - error: Policy or storage error.
func (s Service) Context(ctx context.Context, membership domain.Membership) (BookingContext, error) {
	canBookForOthers, err := canPermission(ctx, s.DB, membership, domain.PermissionBookForOthers)
	if err != nil {
		return BookingContext{}, err
	}
	canBookForSelf, err := canPermission(ctx, s.DB, membership, domain.PermissionCreateOwnBooking)
	if err != nil {
		return BookingContext{}, err
	}
	if !canBookForOthers && !canBookForSelf {
		return BookingContext{}, domain.ErrForbidden
	}
	var result BookingContext
	result.CurrentMembership = membership
	if err := s.DB.QueryRowContext(ctx, `SELECT id,group_id,label,status,starts_at,closed_at,due_at
		FROM periods WHERE group_id=? AND status='OPEN'`, membership.GroupID).
		Scan(&result.OpenPeriod.ID, &result.OpenPeriod.GroupID, &result.OpenPeriod.Label, &result.OpenPeriod.Status,
			&result.OpenPeriod.StartsAt, &result.OpenPeriod.ClosedAt, &result.OpenPeriod.DueAt); err != nil {
		return BookingContext{}, err
	}
	if err := s.DB.QueryRowContext(ctx, `SELECT coalesce(sum(amount_minor),0) FROM ledger_entries
		WHERE group_id=? AND membership_id=? AND account='MEMBER_RECEIVABLE'`, membership.GroupID, membership.ID).
		Scan(&result.OwnBalanceMinor); err != nil {
		return BookingContext{}, err
	}
	if err := s.DB.QueryRowContext(ctx, `SELECT guests_enabled AND ? FROM group_settings WHERE group_id=?`, canBookForOthers, membership.GroupID).
		Scan(&result.CanCreateManagedGuests); err != nil {
		return BookingContext{}, err
	}

	query := `SELECT m.id,m.user_id,u.display_name,coalesce(u.avatar_key,''),
		(u.email IS NULL OR (settings.guest_role_id IS NOT NULL AND EXISTS(
			SELECT 1 FROM membership_role_assignments assignment
			WHERE assignment.group_id=m.group_id AND assignment.membership_id=m.id AND assignment.role_id=settings.guest_role_id
		))) AS is_guest
		FROM memberships m JOIN users u ON u.id=m.user_id
		JOIN group_settings settings ON settings.group_id=m.group_id
		WHERE m.group_id=? AND m.status='ACTIVE'`
	args := []any{membership.GroupID}
	if !canBookForOthers {
		query += ` AND m.id=?`
		args = append(args, membership.ID)
	} else if !canBookForSelf {
		query += ` AND m.id!=?`
		args = append(args, membership.ID)
	}
	query += ` ORDER BY is_guest,lower(u.display_name),m.id`
	rows, err := s.DB.QueryContext(ctx, query, args...)
	if err != nil {
		return BookingContext{}, err
	}
	defer rows.Close()
	result.Targets = make([]BookingTarget, 0)
	for rows.Next() {
		var target BookingTarget
		var userID, avatarKey string
		if err := rows.Scan(&target.MembershipID, &userID, &target.DisplayName, &avatarKey, &target.IsGuest); err != nil {
			return BookingContext{}, err
		}
		target.AvatarURL = media.UserAvatarURL(userID, avatarKey)
		result.Targets = append(result.Targets, target)
	}
	if err := rows.Err(); err != nil {
		return BookingContext{}, err
	}
	return result, nil
}

// Create validates input, authorization, and idempotencyKey, snapshots the
// current product, creates balanced ledger entries, updates allocations, and
// notifies a foreign target atomically. ctx bounds all work; actor and membership
// scope audit and tenant access. It returns the created or replayed Booking, or
// validation, forbidden, not-found, precondition, conflict, audit, and SQL errors.
func (s Service) Create(ctx context.Context, actor domain.Principal, membership domain.Membership, idempotencyKey string, input CreateInput) (domain.Booking, error) {
	if len(idempotencyKey) < 8 || len(idempotencyKey) > 200 {
		return domain.Booking{}, domain.ValidationError{Field: "Idempotency-Key", Message: "must contain 8 to 200 characters"}
	}
	input.ProductID = strings.TrimSpace(input.ProductID)
	input.ExpectedPeriodID = strings.TrimSpace(input.ExpectedPeriodID)
	input.TargetMembershipID = strings.TrimSpace(input.TargetMembershipID)
	input.Reason = strings.TrimSpace(input.Reason)
	if len(input.Reason) > 500 {
		return domain.Booking{}, domain.ValidationError{Field: "reason", Message: "must contain at most 500 characters"}
	}
	if input.ProductID == "" || input.ProductVersion < 1 || input.ExpectedPeriodID == "" || input.Quantity < 1 || input.Quantity > 99 {
		return domain.Booking{}, domain.ValidationError{Field: "booking", Message: "productId, productVersion, expectedPeriodId, and quantity are required"}
	}
	if input.TargetMembershipID == "" {
		input.TargetMembershipID = membership.ID
	}
	if input.TargetMembershipID != membership.ID {
		if err := requirePermission(ctx, s.DB, membership, domain.PermissionBookForOthers); err != nil {
			return domain.Booking{}, err
		}
	} else if err := requirePermission(ctx, s.DB, membership, domain.PermissionCreateOwnBooking); err != nil {
		return domain.Booking{}, err
	}
	encodedRequest, _ := json.Marshal(input)
	digest := sha256.Sum256(encodedRequest)
	requestHash := hex.EncodeToString(digest[:])
	var booking domain.Booking
	err := storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		var storedHash, storedResponse string
		err := tx.QueryRowContext(ctx, `SELECT request_hash,response_json FROM idempotency_results WHERE group_id=? AND actor_user_id=? AND idempotency_key=?`,
			membership.GroupID, actor.UserID, idempotencyKey).Scan(&storedHash, &storedResponse)
		if err == nil {
			if storedHash != requestHash {
				return domain.ErrIdempotencyReuse
			}
			if err := json.Unmarshal([]byte(storedResponse), &booking); err != nil {
				return err
			}
			return refreshBookingState(ctx, tx, &booking, membership)
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}

		if err := authorizeBookingTargets(ctx, tx, membership, []string{input.TargetMembershipID}, input.Reason); err != nil {
			return err
		}
		if err := ensureActiveBookingTargets(ctx, tx, membership.GroupID, []string{input.TargetMembershipID}); err != nil {
			return err
		}
		details, err := loadBookingDetails(ctx, tx, membership.GroupID, input.ProductID, input.ProductVersion, input.ExpectedPeriodID, input.Quantity, input.UnitPriceMinor)
		if err != nil {
			return err
		}
		nowTime := platform.Now()
		booking, err = s.createBookingForTargetTx(ctx, tx, actor, membership, input.ProductID, input.Quantity, input.TargetMembershipID, input.Reason, details, nowTime)
		if err != nil {
			return err
		}
		encodedResponse, _ := json.Marshal(booking)
		_, err = tx.ExecContext(ctx, `INSERT INTO idempotency_results(group_id,actor_user_id,idempotency_key,request_hash,status_code,response_json,created_at) VALUES(?,?,?,?,201,?,?)`,
			membership.GroupID, actor.UserID, idempotencyKey, requestHash, string(encodedResponse), platform.Timestamp(nowTime))
		return err
	})
	return booking, err
}

// CreateBatch validates one multi-target command and creates one immutable
// booking per selected active membership in a single transaction. The shared
// idempotency key replays the complete result and rejects payload changes.
// ctx bounds all database work; actor and membership scope tenant access,
// authorization, notifications, and audit events. It returns the created or
// replayed bookings in request order, or validation, forbidden, not-found,
// precondition, idempotency, audit, notification, ledger, and SQL errors.
func (s Service) CreateBatch(ctx context.Context, actor domain.Principal, membership domain.Membership, idempotencyKey string, input BatchCreateInput) ([]domain.Booking, error) {
	if len(idempotencyKey) < 8 || len(idempotencyKey) > 200 {
		return nil, domain.ValidationError{Field: "Idempotency-Key", Message: "must contain 8 to 200 characters"}
	}
	input.ProductID = strings.TrimSpace(input.ProductID)
	input.ExpectedPeriodID = strings.TrimSpace(input.ExpectedPeriodID)
	input.Reason = strings.TrimSpace(input.Reason)
	if len(input.Reason) > 500 {
		return nil, domain.ValidationError{Field: "reason", Message: "must contain at most 500 characters"}
	}
	if input.ProductID == "" || input.ProductVersion < 1 || input.ExpectedPeriodID == "" || input.Quantity < 1 || input.Quantity > 99 {
		return nil, domain.ValidationError{Field: "booking", Message: "productId, productVersion, expectedPeriodId, and quantity are required"}
	}
	targets, err := normalizeBookingTargets(input.TargetMembershipIDs)
	if err != nil {
		return nil, err
	}
	input.TargetMembershipIDs = targets
	guestNames, err := normalizeManagedGuestNames(input.ManagedGuestDisplayNames)
	if err != nil {
		return nil, err
	}
	input.ManagedGuestDisplayNames = guestNames
	if len(targets)+len(guestNames) < 1 || len(targets)+len(guestNames) > 100 {
		return nil, domain.ValidationError{Field: "bookingTargets", Message: "existing memberships and managed guests must contain between 1 and 100 targets combined"}
	}
	if err := authorizeBookingTargets(ctx, s.DB, membership, targets, input.Reason); err != nil {
		return nil, err
	}
	if len(guestNames) > 0 {
		if err := requirePermission(ctx, s.DB, membership, domain.PermissionBookForOthers); err != nil {
			return nil, err
		}
		if input.Reason == "" {
			return nil, domain.ValidationError{Field: "reason", Message: "is required when assigning a booking to a managed guest"}
		}
	}
	encodedRequest, _ := json.Marshal(input)
	digest := sha256.Sum256(encodedRequest)
	requestHash := hex.EncodeToString(digest[:])
	bookings := make([]domain.Booking, 0, len(targets)+len(guestNames))
	err = storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		var storedHash, storedResponse string
		err := tx.QueryRowContext(ctx, `SELECT request_hash,response_json FROM idempotency_results WHERE group_id=? AND actor_user_id=? AND idempotency_key=?`,
			membership.GroupID, actor.UserID, idempotencyKey).Scan(&storedHash, &storedResponse)
		if err == nil {
			if storedHash != requestHash {
				return domain.ErrIdempotencyReuse
			}
			if err := json.Unmarshal([]byte(storedResponse), &bookings); err != nil {
				return err
			}
			for index := range bookings {
				if err := refreshBookingState(ctx, tx, &bookings[index], membership); err != nil {
					return err
				}
			}
			return nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if err := authorizeBookingTargets(ctx, tx, membership, targets, input.Reason); err != nil {
			return err
		}
		if len(guestNames) > 0 {
			if err := requirePermission(ctx, tx, membership, domain.PermissionBookForOthers); err != nil {
				return err
			}
			if input.Reason == "" {
				return domain.ValidationError{Field: "reason", Message: "is required when assigning a booking to a managed guest"}
			}
		}
		if len(targets) > 0 {
			if err := ensureActiveBookingTargets(ctx, tx, membership.GroupID, targets); err != nil {
				return err
			}
		}
		details, err := loadBookingDetails(ctx, tx, membership.GroupID, input.ProductID, input.ProductVersion, input.ExpectedPeriodID, input.Quantity, input.UnitPriceMinor)
		if err != nil {
			return err
		}
		nowTime := platform.Now()
		allTargets := append(make([]string, 0, len(targets)+len(guestNames)), targets...)
		for _, guestName := range guestNames {
			guest, err := groups.CreateManagedGuestTx(ctx, tx, actor, membership, guestName, nowTime)
			if err != nil {
				return err
			}
			allTargets = append(allTargets, guest.ID)
		}
		for _, targetID := range allTargets {
			booking, err := s.createBookingForTargetTx(ctx, tx, actor, membership, input.ProductID, input.Quantity, targetID, input.Reason, details, nowTime)
			if err != nil {
				return err
			}
			bookings = append(bookings, booking)
		}
		encodedResponse, _ := json.Marshal(bookings)
		_, err = tx.ExecContext(ctx, `INSERT INTO idempotency_results(group_id,actor_user_id,idempotency_key,request_hash,status_code,response_json,created_at) VALUES(?,?,?,?,201,?,?)`,
			membership.GroupID, actor.UserID, idempotencyKey, requestHash, string(encodedResponse), platform.Timestamp(nowTime))
		return err
	})
	return bookings, err
}

func normalizeBookingTargets(targets []string) ([]string, error) {
	if len(targets) > 100 {
		return nil, domain.ValidationError{Field: "targetMembershipIds", Message: "must contain at most 100 memberships"}
	}
	normalized := make([]string, 0, len(targets))
	seen := make(map[string]struct{}, len(targets))
	for _, target := range targets {
		target = strings.TrimSpace(target)
		if target == "" {
			return nil, domain.ValidationError{Field: "targetMembershipIds", Message: "must not contain empty membership IDs"}
		}
		if _, duplicate := seen[target]; duplicate {
			return nil, domain.ValidationError{Field: "targetMembershipIds", Message: "must not contain duplicate membership IDs"}
		}
		seen[target] = struct{}{}
		normalized = append(normalized, target)
	}
	return normalized, nil
}

func normalizeManagedGuestNames(names []string) ([]string, error) {
	normalized := make([]string, 0, len(names))
	seen := make(map[string]struct{}, len(names))
	for _, input := range names {
		displayName, nameKey, err := groups.NormalizeManagedGuestDisplayName(input)
		if err != nil {
			return nil, err
		}
		if _, duplicate := seen[nameKey]; duplicate {
			return nil, domain.ValidationError{Field: "managedGuestDisplayNames", Message: "must not contain duplicate names ignoring letter case"}
		}
		seen[nameKey] = struct{}{}
		normalized = append(normalized, displayName)
	}
	return normalized, nil
}

func authorizeBookingTargets(ctx context.Context, queryer authorization.Queryer, membership domain.Membership, targets []string, reason string) error {
	needsOwnPermission := false
	needsForeignPermission := false
	for _, target := range targets {
		if target == membership.ID {
			needsOwnPermission = true
		} else {
			needsForeignPermission = true
		}
	}
	if needsOwnPermission {
		if err := requirePermission(ctx, queryer, membership, domain.PermissionCreateOwnBooking); err != nil {
			return err
		}
	}
	if needsForeignPermission {
		if err := requirePermission(ctx, queryer, membership, domain.PermissionBookForOthers); err != nil {
			return err
		}
		if reason == "" {
			return domain.ValidationError{Field: "reason", Message: "is required when assigning a booking to another member"}
		}
	}
	return nil
}

func ensureActiveBookingTargets(ctx context.Context, queryer bookingQueryer, groupID string, targets []string) error {
	placeholders := make([]string, len(targets))
	arguments := make([]any, 0, len(targets)+1)
	arguments = append(arguments, groupID)
	for index, target := range targets {
		placeholders[index] = "?"
		arguments = append(arguments, target)
	}
	var count int
	query := `SELECT count(*) FROM memberships WHERE group_id=? AND status='ACTIVE' AND id IN (` + strings.Join(placeholders, ",") + `)`
	if err := queryer.QueryRowContext(ctx, query, arguments...).Scan(&count); err != nil {
		return err
	}
	if count != len(targets) {
		return domain.ErrNotFound
	}
	return nil
}

func loadBookingDetails(ctx context.Context, queryer bookingQueryer, groupID, productID string, productVersion int64, expectedPeriodID string, quantity int, requestedUnitPrice *int64) (bookingDetails, error) {
	var details bookingDetails
	var catalogPrice *int64
	var pricingMode domain.ProductPricingMode
	var currentProductVersion int64
	err := queryer.QueryRowContext(ctx, `SELECT p.category_id,p.name,p.price_minor,p.pricing_mode,p.version,c.name,per.id,g.currency
		FROM products p JOIN categories c ON c.id=p.category_id AND c.group_id=p.group_id
		JOIN groups g ON g.id=p.group_id JOIN periods per ON per.group_id=p.group_id AND per.status='OPEN'
		WHERE p.id=? AND p.group_id=? AND p.active=1 AND p.deleted_at IS NULL AND c.active=1`, productID, groupID).
		Scan(&details.categoryID, &details.productName, &catalogPrice, &pricingMode, &currentProductVersion, &details.categoryName, &details.periodID, &details.currency)
	if errors.Is(err, sql.ErrNoRows) {
		return bookingDetails{}, domain.ErrNotFound
	}
	if err != nil {
		return bookingDetails{}, err
	}
	if currentProductVersion != productVersion || details.periodID != expectedPeriodID {
		return bookingDetails{}, domain.ErrPrecondition
	}
	switch pricingMode {
	case domain.ProductPricingFixed:
		if requestedUnitPrice != nil {
			return bookingDetails{}, domain.ValidationError{Field: "unitPriceMinor", Message: "must be omitted for fixed-price products"}
		}
		if catalogPrice == nil {
			return bookingDetails{}, fmt.Errorf("fixed-price product %s has no catalog price", productID)
		}
		details.unitPriceMinor = *catalogPrice
	case domain.ProductPricingUserDefined:
		if requestedUnitPrice == nil || *requestedUnitPrice <= 0 || *requestedUnitPrice > domain.MaxProductPriceMinor {
			return bookingDetails{}, domain.ValidationError{Field: "unitPriceMinor", Message: "must be a positive, reasonable integer for user-defined-price products"}
		}
		details.unitPriceMinor = *requestedUnitPrice
	default:
		return bookingDetails{}, fmt.Errorf("product %s has unsupported pricing mode %q", productID, pricingMode)
	}
	if details.unitPriceMinor > math.MaxInt64/int64(quantity) {
		return bookingDetails{}, domain.ValidationError{Field: "quantity", Message: "amount exceeds the supported range"}
	}
	details.totalMinor = details.unitPriceMinor * int64(quantity)
	details.ledgerDescription = fmt.Sprintf("%d x %s (%s)", quantity, details.productName, details.categoryName)
	return details, nil
}

func (s Service) createBookingForTargetTx(ctx context.Context, tx *sql.Tx, actor domain.Principal, membership domain.Membership, productID string, quantity int, targetID, reason string, details bookingDetails, nowTime time.Time) (domain.Booking, error) {
	bookingID, err := platform.NewID("bok")
	if err != nil {
		return domain.Booking{}, err
	}
	now := platform.Timestamp(nowTime)
	_, err = tx.ExecContext(ctx, `INSERT INTO bookings(id,group_id,period_id,category_id,product_id,actor_membership_id,target_membership_id,quantity,unit_price_minor,total_minor,product_name,category_name,reason,created_at)
		VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, bookingID, membership.GroupID, details.periodID, details.categoryID, productID, membership.ID, targetID,
		quantity, details.unitPriceMinor, details.totalMinor, details.productName, details.categoryName, nullable(reason), now)
	if err != nil {
		return domain.Booking{}, err
	}
	if err := insertLedger(ctx, tx, membership.GroupID, details.periodID, targetID, details.categoryID, bookingID, "", "", "MEMBER_RECEIVABLE", details.totalMinor, details.ledgerDescription, now); err != nil {
		return domain.Booking{}, err
	}
	if err := insertLedger(ctx, tx, membership.GroupID, details.periodID, "", details.categoryID, bookingID, "", "", "CATEGORY_REVENUE", -details.totalMinor, details.ledgerDescription, now); err != nil {
		return domain.Booking{}, err
	}
	if err := ledger.RebuildPaymentAllocations(ctx, tx, membership.GroupID, targetID); err != nil {
		return domain.Booking{}, err
	}
	if targetID != membership.ID {
		body := fmt.Sprintf("%s assigned %s to you.", membership.DisplayName, details.productName)
		if _, err := s.Notifications.CreateTx(ctx, tx, notifications.CreateInput{
			GroupID: membership.GroupID, MembershipID: targetID,
			Type: notifications.TypeBookingAssigned, Title: "New booking", Body: body,
			ResourceType: "booking", ResourceID: bookingID, CreatedAt: now,
			Context: notifications.EventContext{ActorName: membership.DisplayName, ItemName: details.productName, Quantity: quantity, AmountMinor: details.totalMinor, Currency: details.currency},
		}); err != nil {
			return domain.Booking{}, err
		}
	}
	var targetDisplayName string
	if err := tx.QueryRowContext(ctx, `SELECT u.display_name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.id=? AND m.group_id=?`, targetID, membership.GroupID).Scan(&targetDisplayName); err != nil {
		return domain.Booking{}, err
	}
	booking := domain.Booking{ID: bookingID, GroupID: membership.GroupID, PeriodID: details.periodID, CategoryID: details.categoryID, ProductID: productID,
		ActorMembershipID: membership.ID, ActorDisplayName: membership.DisplayName, TargetMembershipID: targetID, TargetDisplayName: targetDisplayName, Quantity: quantity, UnitPriceMinor: details.unitPriceMinor,
		TotalMinor: details.totalMinor, Currency: details.currency, ProductName: details.productName, CategoryName: details.categoryName, Reason: reason,
		CreatedAt: now}
	if err := applyCurrentVoidMetadata(ctx, tx, &booking, membership, nowTime); err != nil {
		return domain.Booking{}, err
	}
	if err := audit.Record(ctx, tx, membership.GroupID, actor.UserID, membership.ID, "booking.created", "booking", bookingID, map[string]any{"targetMembershipId": targetID, "unitPriceMinor": details.unitPriceMinor, "totalMinor": details.totalMinor}); err != nil {
		return domain.Booking{}, err
	}
	return booking, nil
}

func refreshBookingState(ctx context.Context, tx *sql.Tx, booking *domain.Booking, membership domain.Membership) error {
	var voidedAt sql.NullString
	if err := tx.QueryRowContext(ctx, `SELECT b.voided_at,coalesce(b.void_reason,''),actor_user.display_name,target_user.display_name
		FROM bookings b
		JOIN memberships actor_member ON actor_member.id=b.actor_membership_id AND actor_member.group_id=b.group_id
		JOIN users actor_user ON actor_user.id=actor_member.user_id
		JOIN memberships target_member ON target_member.id=b.target_membership_id AND target_member.group_id=b.group_id
		JOIN users target_user ON target_user.id=target_member.user_id
		WHERE b.id=? AND b.group_id=?`, booking.ID, membership.GroupID).
		Scan(&voidedAt, &booking.VoidReason, &booking.ActorDisplayName, &booking.TargetDisplayName); err != nil {
		return err
	}
	booking.VoidedAt = nil
	if voidedAt.Valid {
		booking.VoidedAt = &voidedAt.String
	}
	return applyCurrentVoidMetadata(ctx, tx, booking, membership, platform.Now())
}

// List returns at most limit visible bookings newest first, optionally filtered
// by periodID. ctx bounds database access and membership scopes the tenant;
// regular members receive bookings they made or bookings affecting their
// account. It returns the slice or SQL errors.
func (s Service) List(ctx context.Context, membership domain.Membership, periodID string, limit int) ([]domain.Booking, error) {
	return s.list(ctx, membership, periodID, limit, false)
}

// ListActivity returns the activity workspace's visible booking history.
// VIEW_ALL_BOOKING_ACTIVITY exposes every historical group booking in this
// feed. FINANCE_MANAGEMENT alone does not widen this feed or dashboard recents.
// ctx bounds permission and booking queries. It returns visible bookings or
// policy and SQL errors.
func (s Service) ListActivity(ctx context.Context, membership domain.Membership, periodID string, limit int) ([]domain.Booking, error) {
	viewAll, err := canPermission(ctx, s.DB, membership, domain.PermissionViewAllBookingActivity)
	if err != nil {
		return nil, err
	}
	return s.list(ctx, membership, periodID, limit, viewAll)
}

func (s Service) list(ctx context.Context, membership domain.Membership, periodID string, limit int, viewAll bool) ([]domain.Booking, error) {
	if limit < 1 || limit > 200 {
		limit = 100
	}
	query := `SELECT b.id,b.group_id,b.period_id,b.category_id,b.product_id,b.actor_membership_id,actor_user.display_name,b.target_membership_id,target_user.display_name,b.quantity,
		b.unit_price_minor,b.total_minor,g.currency,b.product_name,b.category_name,coalesce(b.reason,''),b.created_at,b.voided_at,coalesce(b.void_reason,'')
		FROM bookings b JOIN groups g ON g.id=b.group_id
		JOIN memberships actor_member ON actor_member.id=b.actor_membership_id AND actor_member.group_id=b.group_id
		JOIN users actor_user ON actor_user.id=actor_member.user_id
		JOIN memberships target_member ON target_member.id=b.target_membership_id AND target_member.group_id=b.group_id
		JOIN users target_user ON target_user.id=target_member.user_id
		WHERE b.group_id=?`
	args := []any{membership.GroupID}
	if periodID != "" {
		query += ` AND b.period_id=?`
		args = append(args, periodID)
	}
	if !viewAll {
		query += ` AND (b.target_membership_id=? OR b.actor_membership_id=?)`
		args = append(args, membership.ID, membership.ID)
	}
	query += ` ORDER BY b.created_at DESC LIMIT ?`
	args = append(args, limit)
	rows, err := s.DB.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	canVoidOwn, err := canPermission(ctx, s.DB, membership, domain.PermissionVoidOwnBooking)
	if err != nil {
		return nil, err
	}
	canVoidAny, err := canPermission(ctx, s.DB, membership, domain.PermissionVoidAnyBooking)
	if err != nil {
		return nil, err
	}
	items := make([]domain.Booking, 0)
	for rows.Next() {
		var item domain.Booking
		if err := rows.Scan(&item.ID, &item.GroupID, &item.PeriodID, &item.CategoryID, &item.ProductID, &item.ActorMembershipID, &item.ActorDisplayName, &item.TargetMembershipID, &item.TargetDisplayName,
			&item.Quantity, &item.UnitPriceMinor, &item.TotalMinor, &item.Currency, &item.ProductName, &item.CategoryName, &item.Reason,
			&item.CreatedAt, &item.VoidedAt, &item.VoidReason); err != nil {
			return nil, err
		}
		applyVoidMetadata(&item, membership, canVoidOwn, canVoidAny, platform.Now())
		items = append(items, item)
	}
	return items, rows.Err()
}

// Void idempotently reverses bookingID into the currently open period. ctx
// bounds the audited transaction; actor and membership scope authorization,
// idempotencyKey protects retries, and administrative reversals require reason.
// It returns the updated Booking or validation, forbidden, not-found, conflict,
// idempotency, audit, and database errors. Original history remains immutable.
func (s Service) Void(ctx context.Context, actor domain.Principal, membership domain.Membership, idempotencyKey, bookingID, reason string) (domain.Booking, error) {
	if err := idempotency.ValidateKey(idempotencyKey); err != nil {
		return domain.Booking{}, err
	}
	reason = strings.TrimSpace(reason)
	if len(reason) > 500 {
		return domain.Booking{}, domain.ValidationError{Field: "reason", Message: "must contain at most 500 characters"}
	}
	requestHash, err := idempotency.Hash(map[string]any{"action": "booking.void", "bookingId": bookingID, "reason": reason})
	if err != nil {
		return domain.Booking{}, err
	}
	var booking domain.Booking
	err = storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		found, err := idempotency.Load(ctx, tx, membership.GroupID, actor.UserID, idempotencyKey, requestHash, &booking)
		if err != nil {
			return err
		}
		if found {
			return refreshBookingState(ctx, tx, &booking, membership)
		}
		var voided sql.NullString
		err = tx.QueryRowContext(ctx, `SELECT b.id,b.group_id,b.period_id,b.category_id,b.product_id,b.actor_membership_id,actor_user.display_name,b.target_membership_id,target_user.display_name,b.quantity,
			b.unit_price_minor,b.total_minor,g.currency,b.product_name,b.category_name,coalesce(b.reason,''),b.created_at,b.voided_at
			FROM bookings b JOIN groups g ON g.id=b.group_id
			JOIN memberships actor_member ON actor_member.id=b.actor_membership_id AND actor_member.group_id=b.group_id
			JOIN users actor_user ON actor_user.id=actor_member.user_id
			JOIN memberships target_member ON target_member.id=b.target_membership_id AND target_member.group_id=b.group_id
			JOIN users target_user ON target_user.id=target_member.user_id
			WHERE b.id=? AND b.group_id=?`, bookingID, membership.GroupID).
			Scan(&booking.ID, &booking.GroupID, &booking.PeriodID, &booking.CategoryID, &booking.ProductID, &booking.ActorMembershipID, &booking.ActorDisplayName, &booking.TargetMembershipID, &booking.TargetDisplayName,
				&booking.Quantity, &booking.UnitPriceMinor, &booking.TotalMinor, &booking.Currency, &booking.ProductName, &booking.CategoryName,
				&booking.Reason, &booking.CreatedAt, &voided)
		if errors.Is(err, sql.ErrNoRows) {
			return domain.ErrNotFound
		}
		if err != nil {
			return err
		}
		if voided.Valid {
			return fmt.Errorf("%w: booking is already voided", domain.ErrConflict)
		}
		involvedBooking := booking.ActorMembershipID == membership.ID || booking.TargetMembershipID == membership.ID
		requiredPermission := domain.PermissionVoidAnyBooking
		if involvedBooking {
			requiredPermission = domain.PermissionVoidOwnBooking
		}
		if err := requirePermission(ctx, tx, membership, requiredPermission); err != nil {
			return err
		}
		createdAt, err := time.Parse(time.RFC3339Nano, booking.CreatedAt)
		if err != nil {
			return fmt.Errorf("parse booking creation timestamp: %w", err)
		}
		reasonRequired := booking.ActorMembershipID != membership.ID || !platform.Now().Before(createdAt.Add(voidWithoutReasonWindow))
		if reasonRequired && reason == "" {
			return domain.ValidationError{Field: "reason", Message: "is required for this reversal"}
		}
		var currentPeriod string
		if err := tx.QueryRowContext(ctx, `SELECT id FROM periods WHERE group_id=? AND status='OPEN'`, membership.GroupID).Scan(&currentPeriod); err != nil {
			return err
		}
		now := platform.Timestamp(platform.Now())
		result, err := tx.ExecContext(ctx, `UPDATE bookings SET voided_at=?,voided_by=?,void_reason=?,version=version+1 WHERE id=? AND voided_at IS NULL`, now, membership.ID, nullable(reason), bookingID)
		if err != nil {
			return err
		}
		changed, _ := result.RowsAffected()
		if changed != 1 {
			return domain.ErrConflict
		}
		originals, err := tx.QueryContext(ctx, `SELECT id,membership_id,category_id,account,amount_minor,description FROM ledger_entries WHERE booking_id=? AND reversal_of IS NULL`, bookingID)
		if err != nil {
			return err
		}
		type original struct {
			id, membershipID, categoryID, account, description string
			amount                                             int64
		}
		var entries []original
		for originals.Next() {
			var item original
			var member, category sql.NullString
			if err := originals.Scan(&item.id, &member, &category, &item.account, &item.amount, &item.description); err != nil {
				originals.Close()
				return err
			}
			item.membershipID, item.categoryID = member.String, category.String
			entries = append(entries, item)
		}
		if err := originals.Close(); err != nil {
			return err
		}
		for _, entry := range entries {
			if err := insertLedger(ctx, tx, membership.GroupID, currentPeriod, entry.membershipID, entry.categoryID, bookingID, "", entry.id, entry.account, -entry.amount, "Reversal: "+entry.description, now); err != nil {
				return err
			}
		}
		if err := ledger.RebuildPaymentAllocations(ctx, tx, membership.GroupID, booking.TargetMembershipID); err != nil {
			return err
		}
		if membership.ID != booking.TargetMembershipID {
			body := fmt.Sprintf("%s reversed %s on your account.", membership.DisplayName, booking.ProductName)
			if _, err := s.Notifications.CreateTx(ctx, tx, notifications.CreateInput{
				GroupID: membership.GroupID, MembershipID: booking.TargetMembershipID,
				Type: notifications.TypeBookingReversed, Title: "Booking reversed", Body: body,
				ResourceType: "booking", ResourceID: booking.ID, CreatedAt: now,
				Context: notifications.EventContext{ActorName: membership.DisplayName, ItemName: booking.ProductName, Quantity: booking.Quantity, AmountMinor: booking.TotalMinor, Currency: booking.Currency},
			}); err != nil {
				return err
			}
		}
		booking.VoidedAt = &now
		booking.VoidReason = reason
		booking.CanVoid = false
		booking.VoidReasonRequired = false
		booking.VoidWithoutReasonUntil = nil
		if err := audit.Record(ctx, tx, membership.GroupID, actor.UserID, membership.ID, "booking.voided", "booking", bookingID, map[string]any{"reason": reason, "originalPeriodId": booking.PeriodID, "reversalPeriodId": currentPeriod}); err != nil {
			return err
		}
		return idempotency.Store(ctx, tx, membership.GroupID, actor.UserID, idempotencyKey, requestHash, 200, booking)
	})
	return booking, err
}

func applyVoidMetadata(booking *domain.Booking, membership domain.Membership, canVoidOwn, canVoidAny bool, now time.Time) {
	booking.CanVoid = false
	booking.VoidReasonRequired = false
	booking.VoidWithoutReasonUntil = nil
	if booking.VoidedAt != nil {
		return
	}
	involvedBooking := booking.ActorMembershipID == membership.ID || booking.TargetMembershipID == membership.ID
	booking.CanVoid = (involvedBooking && canVoidOwn) || (!involvedBooking && canVoidAny)
	if !booking.CanVoid {
		return
	}
	createdAt, err := time.Parse(time.RFC3339Nano, booking.CreatedAt)
	if err != nil {
		booking.VoidReasonRequired = true
		return
	}
	deadline := createdAt.Add(voidWithoutReasonWindow)
	createdByMember := booking.ActorMembershipID == membership.ID
	booking.VoidReasonRequired = !createdByMember || !now.Before(deadline)
	if createdByMember && now.Before(deadline) {
		value := platform.Timestamp(deadline)
		booking.VoidWithoutReasonUntil = &value
	}
}

func applyCurrentVoidMetadata(ctx context.Context, queryer authorization.Queryer, booking *domain.Booking, membership domain.Membership, now time.Time) error {
	canVoidOwn, err := canPermission(ctx, queryer, membership, domain.PermissionVoidOwnBooking)
	if err != nil {
		return err
	}
	canVoidAny, err := canPermission(ctx, queryer, membership, domain.PermissionVoidAnyBooking)
	if err != nil {
		return err
	}
	applyVoidMetadata(booking, membership, canVoidOwn, canVoidAny, now)
	return nil
}

func insertLedger(ctx context.Context, tx *sql.Tx, groupID, periodID, membershipID, categoryID, bookingID, paymentID, reversalOf, account string, amount int64, description, createdAt string) error {
	id, err := platform.NewID("led")
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO ledger_entries(id,group_id,period_id,membership_id,category_id,booking_id,payment_id,reversal_of,account,amount_minor,description,created_at)
		VALUES(?,?,nullif(?,''),nullif(?,''),nullif(?,''),nullif(?,''),nullif(?,''),nullif(?,''),?,?,?,?)`,
		id, groupID, periodID, membershipID, categoryID, bookingID, paymentID, reversalOf, account, amount, description, createdAt)
	return err
}

func nullable(value string) any {
	if value == "" {
		return nil
	}
	return value
}
