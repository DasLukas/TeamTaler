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
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/groups"
	"github.com/DasLukas/TeamTaler/internal/idempotency"
	"github.com/DasLukas/TeamTaler/internal/ledger"
	"github.com/DasLukas/TeamTaler/internal/notifications"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

// Service implements booking commands and queries. DB must be migrated and
// Groups supplies category-scoped authorization checks for read models.
type Service struct {
	// DB is the shared application database connection pool.
	DB *sql.DB
	// Groups resolves effective group and category permissions.
	Groups groups.Service
	// Notifications atomically records member-visible booking events.
	Notifications notifications.Service
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
			return json.Unmarshal([]byte(storedResponse), &booking)
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}

		var categoryID, productName, categoryName string
		var catalogPrice *int64
		var pricingMode domain.ProductPricingMode
		var productVersion int64
		var periodID, currency string
		err = tx.QueryRowContext(ctx, `SELECT p.category_id,p.name,p.price_minor,p.pricing_mode,p.version,c.name,per.id,g.currency
			FROM products p JOIN categories c ON c.id=p.category_id AND c.group_id=p.group_id
			JOIN groups g ON g.id=p.group_id JOIN periods per ON per.group_id=p.group_id AND per.status='OPEN'
			WHERE p.id=? AND p.group_id=? AND p.active=1 AND c.active=1`, input.ProductID, membership.GroupID).
			Scan(&categoryID, &productName, &catalogPrice, &pricingMode, &productVersion, &categoryName, &periodID, &currency)
		if errors.Is(err, sql.ErrNoRows) {
			return domain.ErrNotFound
		}
		if err != nil {
			return err
		}
		if productVersion != input.ProductVersion || periodID != input.ExpectedPeriodID {
			return domain.ErrPrecondition
		}
		var unitPrice int64
		switch pricingMode {
		case domain.ProductPricingFixed:
			if input.UnitPriceMinor != nil {
				return domain.ValidationError{Field: "unitPriceMinor", Message: "must be omitted for fixed-price products"}
			}
			if catalogPrice == nil {
				return fmt.Errorf("fixed-price product %s has no catalog price", input.ProductID)
			}
			unitPrice = *catalogPrice
		case domain.ProductPricingUserDefined:
			if input.UnitPriceMinor == nil || *input.UnitPriceMinor <= 0 || *input.UnitPriceMinor > domain.MaxProductPriceMinor {
				return domain.ValidationError{Field: "unitPriceMinor", Message: "must be a positive, reasonable integer for user-defined-price products"}
			}
			unitPrice = *input.UnitPriceMinor
		default:
			return fmt.Errorf("product %s has unsupported pricing mode %q", input.ProductID, pricingMode)
		}
		if input.TargetMembershipID != membership.ID {
			allowed, err := hasCategoryPermissionTx(ctx, tx, membership, categoryID, domain.PermissionAssignToOthers)
			if err != nil {
				return err
			}
			if !allowed {
				return domain.ErrForbidden
			}
			if input.Reason == "" {
				return domain.ValidationError{Field: "reason", Message: "is required when assigning a booking to another member"}
			}
		}
		var targetExists int
		if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM memberships WHERE id=? AND group_id=? AND status='ACTIVE'`, input.TargetMembershipID, membership.GroupID).Scan(&targetExists); err != nil {
			return err
		}
		if targetExists == 0 {
			return domain.ErrNotFound
		}
		if unitPrice > math.MaxInt64/int64(input.Quantity) {
			return domain.ValidationError{Field: "quantity", Message: "amount exceeds the supported range"}
		}
		total := unitPrice * int64(input.Quantity)
		bookingID, _ := platform.NewID("bok")
		now := platform.Timestamp(platform.Now())
		ledgerDescription := fmt.Sprintf("%d x %s (%s)", input.Quantity, productName, categoryName)
		_, err = tx.ExecContext(ctx, `INSERT INTO bookings(id,group_id,period_id,category_id,product_id,actor_membership_id,target_membership_id,quantity,unit_price_minor,total_minor,product_name,category_name,reason,created_at)
			VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, bookingID, membership.GroupID, periodID, categoryID, input.ProductID, membership.ID, input.TargetMembershipID,
			input.Quantity, unitPrice, total, productName, categoryName, nullable(input.Reason), now)
		if err != nil {
			return err
		}
		if err := insertLedger(ctx, tx, membership.GroupID, periodID, input.TargetMembershipID, categoryID, bookingID, "", "", "MEMBER_RECEIVABLE", total, ledgerDescription, now); err != nil {
			return err
		}
		if err := insertLedger(ctx, tx, membership.GroupID, periodID, "", categoryID, bookingID, "", "", "CATEGORY_REVENUE", -total, ledgerDescription, now); err != nil {
			return err
		}
		if err := ledger.RebuildPaymentAllocations(ctx, tx, membership.GroupID, input.TargetMembershipID); err != nil {
			return err
		}
		if input.TargetMembershipID != membership.ID {
			body := fmt.Sprintf("%s assigned %s to you.", membership.DisplayName, productName)
			if _, err := s.Notifications.CreateTx(ctx, tx, notifications.CreateInput{
				GroupID: membership.GroupID, MembershipID: input.TargetMembershipID,
				Type: notifications.TypeBookingAssigned, Title: "New booking", Body: body,
				ResourceType: "booking", ResourceID: bookingID, CreatedAt: now,
				Context: notifications.EventContext{ActorName: membership.DisplayName, ItemName: productName, Quantity: input.Quantity, AmountMinor: total, Currency: currency},
			}); err != nil {
				return err
			}
		}
		booking = domain.Booking{ID: bookingID, GroupID: membership.GroupID, PeriodID: periodID, CategoryID: categoryID, ProductID: input.ProductID,
			ActorMembershipID: membership.ID, TargetMembershipID: input.TargetMembershipID, Quantity: input.Quantity, UnitPriceMinor: unitPrice,
			TotalMinor: total, Currency: currency, ProductName: productName, CategoryName: categoryName, Reason: input.Reason,
			CreatedAt: now, CanVoid: input.TargetMembershipID == membership.ID}
		if err := audit.Record(ctx, tx, membership.GroupID, actor.UserID, membership.ID, "booking.created", "booking", bookingID, map[string]any{"targetMembershipId": input.TargetMembershipID, "unitPriceMinor": unitPrice, "totalMinor": total}); err != nil {
			return err
		}
		encodedResponse, _ := json.Marshal(booking)
		_, err = tx.ExecContext(ctx, `INSERT INTO idempotency_results(group_id,actor_user_id,idempotency_key,request_hash,status_code,response_json,created_at) VALUES(?,?,?,?,201,?,?)`,
			membership.GroupID, actor.UserID, idempotencyKey, requestHash, string(encodedResponse), now)
		return err
	})
	return booking, err
}

// List returns at most limit visible bookings newest first, optionally filtered
// by periodID. ctx bounds database access and membership scopes the tenant;
// regular members receive bookings they made, bookings affecting their account,
// and bookings in categories for which they may void entries. It returns the
// slice or SQL errors.
func (s Service) List(ctx context.Context, membership domain.Membership, periodID string, limit int) ([]domain.Booking, error) {
	return s.list(ctx, membership, periodID, limit, false)
}

// ListActivity returns the activity workspace's visible booking history. When
// administrators enable group-wide visibility, regular members receive every
// historical group booking; finance-manager visibility remains unconditional.
// ctx bounds settings and booking queries. It returns visible bookings or
// settings and SQL errors.
func (s Service) ListActivity(ctx context.Context, membership domain.Membership, periodID string, limit int) ([]domain.Booking, error) {
	viewAll := groups.HasRole(membership, domain.RoleFinanceManager)
	if !viewAll {
		var err error
		viewAll, err = s.Groups.MembersCanViewAllBookings(ctx, membership.GroupID)
		if err != nil {
			return nil, err
		}
	}
	return s.list(ctx, membership, periodID, limit, viewAll)
}

func (s Service) list(ctx context.Context, membership domain.Membership, periodID string, limit int, viewAll bool) ([]domain.Booking, error) {
	if limit < 1 || limit > 200 {
		limit = 100
	}
	viewAll = viewAll || groups.HasRole(membership, domain.RoleFinanceManager)
	query := `SELECT b.id,b.group_id,b.period_id,b.category_id,b.product_id,b.actor_membership_id,b.target_membership_id,b.quantity,
		b.unit_price_minor,b.total_minor,g.currency,b.product_name,b.category_name,coalesce(b.reason,''),b.created_at,b.voided_at,coalesce(b.void_reason,'')
		FROM bookings b JOIN groups g ON g.id=b.group_id WHERE b.group_id=?`
	args := []any{membership.GroupID}
	if periodID != "" {
		query += ` AND b.period_id=?`
		args = append(args, periodID)
	}
	if !viewAll {
		query += ` AND (b.target_membership_id=? OR b.actor_membership_id=? OR EXISTS (
			SELECT 1 FROM category_permissions cp
			WHERE cp.group_id=b.group_id AND cp.membership_id=? AND cp.category_id=b.category_id AND cp.permission='VOID_BOOKINGS'
		))`
		args = append(args, membership.ID, membership.ID, membership.ID)
	}
	query += ` ORDER BY b.created_at DESC LIMIT ?`
	args = append(args, limit)
	rows, err := s.DB.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]domain.Booking, 0)
	for rows.Next() {
		var item domain.Booking
		if err := rows.Scan(&item.ID, &item.GroupID, &item.PeriodID, &item.CategoryID, &item.ProductID, &item.ActorMembershipID, &item.TargetMembershipID,
			&item.Quantity, &item.UnitPriceMinor, &item.TotalMinor, &item.Currency, &item.ProductName, &item.CategoryName, &item.Reason,
			&item.CreatedAt, &item.VoidedAt, &item.VoidReason); err != nil {
			return nil, err
		}
		item.CanVoid = item.VoidedAt == nil && canSelfUndo(item, membership)
		if !item.CanVoid {
			item.CanVoid, _ = s.Groups.HasCategoryPermission(ctx, membership, item.CategoryID, domain.PermissionVoidBookings)
		}
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
		if err != nil || found {
			return err
		}
		var voided sql.NullString
		err = tx.QueryRowContext(ctx, `SELECT b.id,b.group_id,b.period_id,b.category_id,b.product_id,b.actor_membership_id,b.target_membership_id,b.quantity,
			b.unit_price_minor,b.total_minor,g.currency,b.product_name,b.category_name,coalesce(b.reason,''),b.created_at,b.voided_at
			FROM bookings b JOIN groups g ON g.id=b.group_id WHERE b.id=? AND b.group_id=?`, bookingID, membership.GroupID).
			Scan(&booking.ID, &booking.GroupID, &booking.PeriodID, &booking.CategoryID, &booking.ProductID, &booking.ActorMembershipID, &booking.TargetMembershipID,
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
		allowed := canSelfUndo(booking, membership)
		if !allowed {
			allowed, err = hasCategoryPermissionTx(ctx, tx, membership, booking.CategoryID, domain.PermissionVoidBookings)
			if err != nil {
				return err
			}
		}
		if !allowed {
			return domain.ErrForbidden
		}
		if !canSelfUndo(booking, membership) && reason == "" {
			return domain.ValidationError{Field: "reason", Message: "is required for an administrative reversal"}
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
		if err := audit.Record(ctx, tx, membership.GroupID, actor.UserID, membership.ID, "booking.voided", "booking", bookingID, map[string]any{"reason": reason, "originalPeriodId": booking.PeriodID, "reversalPeriodId": currentPeriod}); err != nil {
			return err
		}
		return idempotency.Store(ctx, tx, membership.GroupID, actor.UserID, idempotencyKey, requestHash, 200, booking)
	})
	return booking, err
}

func canSelfUndo(booking domain.Booking, membership domain.Membership) bool {
	if booking.ActorMembershipID != membership.ID || booking.TargetMembershipID != membership.ID {
		return false
	}
	created, err := time.Parse(time.RFC3339Nano, booking.CreatedAt)
	return err == nil && platform.Now().Sub(created) >= 0 && platform.Now().Sub(created) <= 30*time.Second
}

func hasCategoryPermissionTx(ctx context.Context, tx *sql.Tx, membership domain.Membership, categoryID string, permission domain.CategoryPermission) (bool, error) {
	if groups.HasRole(membership, domain.RoleAdmin) {
		return true, nil
	}
	var count int
	err := tx.QueryRowContext(ctx, `SELECT count(*) FROM category_permissions WHERE group_id=? AND membership_id=? AND category_id=? AND permission=?`,
		membership.GroupID, membership.ID, categoryID, permission).Scan(&count)
	return count > 0, err
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
