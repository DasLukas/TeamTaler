// Package periods closes accounting intervals and serves immutable statements.
package periods

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/DasLukas/TeamTaler/internal/audit"
	"github.com/DasLukas/TeamTaler/internal/authorization"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/idempotency"
	"github.com/DasLukas/TeamTaler/internal/ledger"
	"github.com/DasLukas/TeamTaler/internal/notifications"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

// Service implements flexible accounting period operations over a migrated
// TeamTaler database.
type Service struct {
	// DB is the shared application database connection pool.
	DB *sql.DB
	// Notifications atomically records generated settlement events.
	Notifications notifications.Service
}

func requireFinanceManagement(ctx context.Context, queryer authorization.Queryer, membership domain.Membership) error {
	allowed, err := authorization.NewPolicy(queryer).Can(ctx, membership.GroupID, membership.ID, domain.PermissionFinanceManagement, authorization.ResourceContext{GroupID: membership.GroupID})
	if err != nil {
		return err
	}
	if !allowed {
		return domain.ErrForbidden
	}
	return nil
}

// CloseInput provides the final period label, ISO calendar due date, and label
// for the successor period that is opened atomically.
type CloseInput struct {
	Label           string `json:"label"`
	DueAt           string `json:"dueAt"`
	NextPeriodLabel string `json:"nextPeriodLabel"`
}

// CloseResult returns the immutable closed period, atomically opened successor,
// and number of generated member statements.
type CloseResult struct {
	ClosedPeriod domain.Period `json:"closedPeriod"`
	OpenPeriod   domain.Period `json:"openPeriod"`
	Statements   int64         `json:"statementCount"`
}

// List returns newest-first periods for groupID. ctx bounds the query; an empty
// slice is valid and SQL errors propagate.
func (s Service) List(ctx context.Context, groupID string) ([]domain.Period, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT id,group_id,label,status,starts_at,closed_at,due_at FROM periods WHERE group_id=? ORDER BY starts_at DESC`, groupID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]domain.Period, 0)
	for rows.Next() {
		var item domain.Period
		if err := rows.Scan(&item.ID, &item.GroupID, &item.Label, &item.Status, &item.StartsAt, &item.ClosedAt, &item.DueAt); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

// Close idempotently and permanently closes periodID, rebuilds allocations,
// snapshots statements and notifications, and opens a successor. ctx bounds the
// audited transaction; actor and membership scope authorization and tenant, and
// input supplies labels and due date. It returns the created or replayed result,
// or validation, forbidden, not-found, conflict, idempotency, audit, and SQL errors.
func (s Service) Close(ctx context.Context, actor domain.Principal, membership domain.Membership, idempotencyKey, periodID string, input CloseInput) (CloseResult, error) {
	if err := requireFinanceManagement(ctx, s.DB, membership); err != nil {
		return CloseResult{}, err
	}
	if err := idempotency.ValidateKey(idempotencyKey); err != nil {
		return CloseResult{}, err
	}
	input.Label = strings.TrimSpace(input.Label)
	input.NextPeriodLabel = strings.TrimSpace(input.NextPeriodLabel)
	if input.Label == "" || len(input.Label) > 120 {
		return CloseResult{}, domain.ValidationError{Field: "label", Message: "must contain 1 to 120 characters"}
	}
	if input.NextPeriodLabel == "" {
		input.NextPeriodLabel = domain.DefaultOpenPeriodLabel
	}
	if len(input.NextPeriodLabel) > 120 {
		return CloseResult{}, domain.ValidationError{Field: "nextPeriodLabel", Message: "must contain at most 120 characters"}
	}
	due, err := time.Parse("2006-01-02", input.DueAt)
	if err != nil {
		return CloseResult{}, domain.ValidationError{Field: "dueAt", Message: "must be a date in YYYY-MM-DD format"}
	}
	if due.Before(platform.Now().AddDate(0, 0, -1)) {
		return CloseResult{}, domain.ValidationError{Field: "dueAt", Message: "must not be in the past"}
	}
	requestHash, err := idempotency.Hash(map[string]any{"action": "period.close", "periodId": periodID, "input": input})
	if err != nil {
		return CloseResult{}, err
	}
	var result CloseResult
	err = storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		if err := requireFinanceManagement(ctx, tx, membership); err != nil {
			return err
		}
		found, err := idempotency.Load(ctx, tx, membership.GroupID, actor.UserID, idempotencyKey, requestHash, &result)
		if err != nil || found {
			return err
		}
		var settlementsEnabled bool
		if err := tx.QueryRowContext(ctx, `SELECT settlements_enabled FROM group_settings WHERE group_id=?`, membership.GroupID).Scan(&settlementsEnabled); errors.Is(err, sql.ErrNoRows) {
			return domain.ErrNotFound
		} else if err != nil {
			return err
		}
		if !settlementsEnabled {
			return domain.ErrConflict
		}
		var startsAt string
		err = tx.QueryRowContext(ctx, `SELECT starts_at FROM periods WHERE id=? AND group_id=? AND status='OPEN'`, periodID, membership.GroupID).Scan(&startsAt)
		if errors.Is(err, sql.ErrNoRows) {
			var exists int
			_ = tx.QueryRowContext(ctx, `SELECT count(*) FROM periods WHERE id=? AND group_id=?`, periodID, membership.GroupID).Scan(&exists)
			if exists == 0 {
				return domain.ErrNotFound
			}
			return domain.ErrConflict
		}
		if err != nil {
			return err
		}
		now := platform.Timestamp(platform.Now())
		dueAt := due.UTC().Format("2006-01-02")
		if _, err := tx.ExecContext(ctx, `UPDATE periods SET label=?,status='CLOSED',closed_at=?,due_at=?,closed_by=? WHERE id=? AND status='OPEN'`, input.Label, now, dueAt, membership.ID, periodID); err != nil {
			return err
		}
		memberRows, err := tx.QueryContext(ctx, `SELECT id FROM memberships WHERE group_id=?`, membership.GroupID)
		if err != nil {
			return err
		}
		var memberIDs []string
		for memberRows.Next() {
			var memberID string
			if err := memberRows.Scan(&memberID); err != nil {
				memberRows.Close()
				return err
			}
			memberIDs = append(memberIDs, memberID)
		}
		if err := memberRows.Close(); err != nil {
			return err
		}
		for _, memberID := range memberIDs {
			if err := ledger.RebuildPaymentAllocations(ctx, tx, membership.GroupID, memberID); err != nil {
				return err
			}
		}
		statementCount, err := s.snapshotStatements(ctx, tx, membership.GroupID, periodID, input.Label, now)
		if err != nil {
			return err
		}
		nextID, _ := platform.NewID("per")
		if _, err := tx.ExecContext(ctx, `INSERT INTO periods(id,group_id,label,status,starts_at,created_at) VALUES(?,?,?,'OPEN',?,?)`, nextID, membership.GroupID, input.NextPeriodLabel, now, now); err != nil {
			return err
		}
		result = CloseResult{
			ClosedPeriod: domain.Period{ID: periodID, GroupID: membership.GroupID, Label: input.Label, Status: "CLOSED", StartsAt: startsAt, ClosedAt: &now, DueAt: &dueAt},
			OpenPeriod:   domain.Period{ID: nextID, GroupID: membership.GroupID, Label: input.NextPeriodLabel, Status: "OPEN", StartsAt: now},
			Statements:   statementCount,
		}
		if err := audit.Record(ctx, tx, membership.GroupID, actor.UserID, membership.ID, "period.closed", "period", periodID, map[string]any{"dueAt": dueAt, "nextPeriodId": nextID, "statementCount": statementCount}); err != nil {
			return err
		}
		return idempotency.Store(ctx, tx, membership.GroupID, actor.UserID, idempotencyKey, requestHash, 200, result)
	})
	return result, err
}

func (s Service) snapshotStatements(ctx context.Context, tx *sql.Tx, groupID, periodID, periodLabel, now string) (int64, error) {
	var currency, dueAt string
	if err := tx.QueryRowContext(ctx, `SELECT g.currency,p.due_at FROM periods p JOIN groups g ON g.id=p.group_id WHERE p.id=? AND p.group_id=?`, periodID, groupID).Scan(&currency, &dueAt); err != nil {
		return 0, err
	}
	rows, err := tx.QueryContext(ctx, `SELECT m.id,u.display_name,u.email,
		coalesce((SELECT sum(le.amount_minor) FROM ledger_entries le WHERE le.group_id=m.group_id AND le.period_id=? AND le.membership_id=m.id AND le.account='MEMBER_RECEIVABLE' AND le.payment_id IS NULL),0),
		coalesce((SELECT sum(pa.amount_minor) FROM payment_allocations pa JOIN payments py ON py.id=pa.payment_id WHERE pa.period_id=? AND py.membership_id=m.id AND py.reversed_at IS NULL),0),
		coalesce((SELECT sum(aa.amount_minor) FROM period_adjustment_allocations aa WHERE aa.target_period_id=? AND aa.membership_id=m.id),0),
		coalesce((SELECT sum(aa.amount_minor) FROM period_adjustment_allocations aa WHERE aa.source_period_id=? AND aa.membership_id=m.id),0)
		FROM memberships m
		JOIN users u ON u.id=m.user_id
		WHERE m.group_id=?
		  AND (
		      u.email IS NOT NULL
		      OR EXISTS (
		          SELECT 1
		          FROM ledger_entries activity_ledger
		          WHERE activity_ledger.group_id=m.group_id
		            AND activity_ledger.period_id=?
		            AND activity_ledger.membership_id=m.id
		      )
		      OR EXISTS (
		          SELECT 1
		          FROM payment_allocations activity_allocation
		          JOIN payments activity_payment ON activity_payment.id=activity_allocation.payment_id
		          WHERE activity_allocation.period_id=?
		            AND activity_payment.group_id=m.group_id
		            AND activity_payment.membership_id=m.id
		      )
		      OR EXISTS (
		          SELECT 1
		          FROM period_adjustment_allocations activity_adjustment
		          WHERE activity_adjustment.target_period_id=?
		            AND activity_adjustment.membership_id=m.id
		      )
		      OR EXISTS (
		          SELECT 1
		          FROM period_adjustment_allocations activity_adjustment
		          WHERE activity_adjustment.source_period_id=?
		            AND activity_adjustment.membership_id=m.id
		      )
		  )`, periodID, periodID, periodID, periodID, groupID, periodID, periodID, periodID, periodID)
	if err != nil {
		return 0, err
	}
	type row struct {
		membershipID, displayName        string
		email                            sql.NullString
		charges, paid, applied, provided int64
	}
	var snapshots []row
	for rows.Next() {
		var item row
		if err := rows.Scan(&item.membershipID, &item.displayName, &item.email, &item.charges, &item.paid, &item.applied, &item.provided); err != nil {
			rows.Close()
			return 0, err
		}
		snapshots = append(snapshots, item)
	}
	if err := rows.Close(); err != nil {
		return 0, err
	}
	for _, item := range snapshots {
		id, _ := platform.NewID("stm")
		due := item.charges + item.provided - item.paid - item.applied
		status := statementStatus(item.charges+item.provided, item.paid+item.applied)
		if _, err := tx.ExecContext(ctx, `INSERT INTO period_statements(id,group_id,period_id,membership_id,display_name,email,charges_minor,payments_allocated_minor,adjustments_applied_minor,adjustments_provided_minor,amount_due_minor,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			id, groupID, periodID, item.membershipID, item.displayName, item.email, item.charges, item.paid, item.applied, item.provided, due, status, now); err != nil {
			return 0, err
		}
		body := "Your statement is ready. No payment is currently due."
		if due > 0 {
			body = fmt.Sprintf("Your statement is ready. Amount due: %d minor units (%s), due %s.", due, currency, dueAt)
		} else if due < 0 {
			body = fmt.Sprintf("Your statement is ready and shows a credit of %d minor units (%s).", -due, currency)
		}
		if _, err := s.Notifications.CreateTx(ctx, tx, notifications.CreateInput{
			GroupID: groupID, MembershipID: item.membershipID,
			Type: notifications.TypeSettlementCreated, Title: "Settlement ready", Body: body,
			ResourceType: "statement", ResourceID: id, CreatedAt: now,
			Context: notifications.EventContext{AmountMinor: due, Currency: currency, PeriodLabel: periodLabel, DueAt: dueAt},
		}); err != nil {
			return 0, err
		}
	}
	return int64(len(snapshots)), nil
}

func statementStatus(charges, paid int64) string {
	due := charges - paid
	if due < 0 {
		return "CREDIT"
	}
	if due == 0 {
		return "PAID"
	}
	if paid > 0 {
		return "PARTIAL"
	}
	return "OPEN"
}

// Statements returns immutable close snapshots visible to membership, optionally
// restricted to periodID, and enriches them with later payment/correction
// allocations so settlement status remains useful. ctx bounds database access;
// the method returns the result or SQL errors.
func (s Service) Statements(ctx context.Context, membership domain.Membership, periodID string) ([]domain.Statement, error) {
	viewAll, err := authorization.NewPolicy(s.DB).Can(ctx, membership.GroupID, membership.ID, domain.PermissionFinanceManagement, authorization.ResourceContext{GroupID: membership.GroupID})
	if err != nil {
		return nil, err
	}
	query := `SELECT ps.id,ps.period_id,ps.membership_id,ps.display_name,ps.email,ps.charges_minor,
		coalesce((SELECT sum(pa.amount_minor) FROM payment_allocations pa JOIN payments py ON py.id=pa.payment_id WHERE pa.period_id=ps.period_id AND py.membership_id=ps.membership_id AND py.reversed_at IS NULL),0),
		coalesce((SELECT sum(aa.amount_minor) FROM period_adjustment_allocations aa WHERE aa.target_period_id=ps.period_id AND aa.membership_id=ps.membership_id),0),
		coalesce((SELECT sum(aa.amount_minor) FROM period_adjustment_allocations aa WHERE aa.source_period_id=ps.period_id AND aa.membership_id=ps.membership_id),0),g.currency
		FROM period_statements ps JOIN groups g ON g.id=ps.group_id WHERE ps.group_id=?`
	args := []any{membership.GroupID}
	if periodID != "" {
		query += ` AND ps.period_id=?`
		args = append(args, periodID)
	}
	if !viewAll {
		query += ` AND ps.membership_id=?`
		args = append(args, membership.ID)
	}
	query += ` ORDER BY ps.created_at DESC,lower(ps.display_name)`
	rows, err := s.DB.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]domain.Statement, 0)
	for rows.Next() {
		var item domain.Statement
		var email sql.NullString
		if err := rows.Scan(&item.ID, &item.PeriodID, &item.MembershipID, &item.DisplayName, &email, &item.ChargesMinor, &item.PaymentsAllocatedMinor, &item.AdjustmentsAppliedMinor, &item.AdjustmentsProvidedMinor, &item.Currency); err != nil {
			return nil, err
		}
		if email.Valid {
			emailValue := email.String
			item.Email = &emailValue
		}
		item.AmountDueMinor = item.ChargesMinor + item.AdjustmentsProvidedMinor - item.PaymentsAllocatedMinor - item.AdjustmentsAppliedMinor
		item.Status = statementStatus(item.ChargesMinor+item.AdjustmentsProvidedMinor, item.PaymentsAllocatedMinor+item.AdjustmentsAppliedMinor)
		result = append(result, item)
	}
	return result, rows.Err()
}

// EnsurePeriodInGroup verifies that periodID belongs to groupID. ctx bounds the
// lookup; it returns ErrNotFound for absent or cross-tenant identifiers and wraps
// database failures.
func (s Service) EnsurePeriodInGroup(ctx context.Context, groupID, periodID string) error {
	var count int
	if err := s.DB.QueryRowContext(ctx, `SELECT count(*) FROM periods WHERE id=? AND group_id=?`, periodID, groupID).Scan(&count); err != nil {
		return fmt.Errorf("validate period: %w", err)
	}
	if count == 0 {
		return domain.ErrNotFound
	}
	return nil
}
