// Package ledger contains shared accounting invariants and allocation routines.
package ledger

import (
	"context"
	"database/sql"
	"fmt"
)

// RebuildPaymentAllocations reapplies non-reversed payments to the oldest claims.
// ctx and tx define the caller-owned atomic unit; groupID and membershipID scope
// all reads and writes. Negative correction claims offset positive claims before
// payment FIFO. It returns SQL errors without committing partial allocations.
func RebuildPaymentAllocations(ctx context.Context, tx *sql.Tx, groupID, membershipID string) error {
	if _, err := tx.ExecContext(ctx, `DELETE FROM payment_allocations WHERE group_id=? AND payment_id IN (SELECT id FROM payments WHERE group_id=? AND membership_id=?)`, groupID, groupID, membershipID); err != nil {
		return fmt.Errorf("clear payment allocations: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM period_adjustment_allocations WHERE group_id=? AND membership_id=?`, groupID, membershipID); err != nil {
		return fmt.Errorf("clear correction allocations: %w", err)
	}
	type claim struct {
		periodID  string
		remaining int64
	}
	claimRows, err := tx.QueryContext(ctx, `SELECT p.id,coalesce(sum(le.amount_minor),0)
		FROM periods p LEFT JOIN ledger_entries le ON le.group_id=p.group_id AND le.period_id=p.id
			AND le.membership_id=? AND le.account='MEMBER_RECEIVABLE' AND le.payment_id IS NULL
		WHERE p.group_id=? GROUP BY p.id,p.starts_at ORDER BY p.starts_at,p.id`, membershipID, groupID)
	if err != nil {
		return fmt.Errorf("read period claims: %w", err)
	}
	claims := make([]claim, 0)
	adjustments := make([]claim, 0)
	for claimRows.Next() {
		var item claim
		if err := claimRows.Scan(&item.periodID, &item.remaining); err != nil {
			claimRows.Close()
			return err
		}
		if item.remaining > 0 {
			claims = append(claims, item)
		} else if item.remaining < 0 {
			item.remaining = -item.remaining
			adjustments = append(adjustments, item)
		}
	}
	if err := claimRows.Close(); err != nil {
		return err
	}
	claimIndex := 0
	for _, adjustment := range adjustments {
		for adjustment.remaining > 0 && claimIndex < len(claims) {
			if claims[claimIndex].remaining <= 0 {
				claimIndex++
				continue
			}
			applied := adjustment.remaining
			if applied > claims[claimIndex].remaining {
				applied = claims[claimIndex].remaining
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO period_adjustment_allocations(group_id,membership_id,source_period_id,target_period_id,amount_minor) VALUES(?,?,?,?,?)`,
				groupID, membershipID, adjustment.periodID, claims[claimIndex].periodID, applied); err != nil {
				return fmt.Errorf("store correction allocation: %w", err)
			}
			claims[claimIndex].remaining -= applied
			adjustment.remaining -= applied
		}
	}
	paymentRows, err := tx.QueryContext(ctx, `SELECT id,amount_minor FROM payments WHERE group_id=? AND membership_id=? AND reversed_at IS NULL ORDER BY received_at,id`, groupID, membershipID)
	if err != nil {
		return fmt.Errorf("read allocatable payments: %w", err)
	}
	type availablePayment struct {
		id        string
		remaining int64
	}
	payments := make([]availablePayment, 0)
	for paymentRows.Next() {
		var item availablePayment
		if err := paymentRows.Scan(&item.id, &item.remaining); err != nil {
			paymentRows.Close()
			return err
		}
		payments = append(payments, item)
	}
	if err := paymentRows.Close(); err != nil {
		return err
	}
	claimIndex = 0
	for _, payment := range payments {
		for payment.remaining > 0 && claimIndex < len(claims) {
			if claims[claimIndex].remaining <= 0 {
				claimIndex++
				continue
			}
			amount := payment.remaining
			if amount > claims[claimIndex].remaining {
				amount = claims[claimIndex].remaining
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO payment_allocations(group_id,payment_id,period_id,amount_minor) VALUES(?,?,?,?)`,
				groupID, payment.id, claims[claimIndex].periodID, amount); err != nil {
				return fmt.Errorf("store payment allocation: %w", err)
			}
			payment.remaining -= amount
			claims[claimIndex].remaining -= amount
		}
	}
	return nil
}
