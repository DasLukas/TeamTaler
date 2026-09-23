package externalaccounts

import (
	"context"
	"database/sql"
	"errors"
	"strings"

	"github.com/DasLukas/TeamTaler/internal/audit"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

// ListPaymentMethodLinks returns the complete mapping and its collection ETag.
func (s Service) ListPaymentMethodLinks(ctx context.Context, membership domain.Membership) (PaymentMethodLinkCollection, error) {
	if err := requireManualAccess(ctx, s.DB, membership, domain.PermissionViewExternalAccounts); err != nil {
		return PaymentMethodLinkCollection{}, err
	}
	return listPaymentMethodLinks(ctx, s.DB, membership.GroupID)
}

// ReplacePaymentMethodLinks atomically replaces every configured method link.
func (s Service) ReplacePaymentMethodLinks(ctx context.Context, actor domain.Principal, membership domain.Membership, input ReplaceLinksInput, expectedVersion int64) (PaymentMethodLinkCollection, error) {
	var result PaymentMethodLinkCollection
	err := storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		if err := requireManualAccess(ctx, tx, membership, domain.PermissionManageExternalAccounts); err != nil {
			return err
		}
		if err := requireCollectionVersion(ctx, tx, membership.GroupID, expectedVersion); err != nil {
			return err
		}
		current, err := listPaymentMethodLinks(ctx, tx, membership.GroupID)
		if err != nil {
			return err
		}
		if len(input.Links) != len(current.Links) {
			return domain.ValidationError{Field: "links", Message: "must contain every payment method exactly once"}
		}
		existing := make(map[string]struct{}, len(current.Links))
		for _, link := range current.Links {
			existing[link.PaymentMethodID] = struct{}{}
		}
		seen := make(map[string]struct{}, len(input.Links))
		linkedCount := 0
		for _, link := range input.Links {
			if _, ok := existing[link.PaymentMethodID]; !ok {
				return domain.ValidationError{Field: "links", Message: "must contain every payment method exactly once"}
			}
			if _, duplicate := seen[link.PaymentMethodID]; duplicate {
				return domain.ValidationError{Field: "links", Message: "must contain every payment method exactly once"}
			}
			seen[link.PaymentMethodID] = struct{}{}
			var accountID any
			if link.ExternalAccountID != nil {
				normalizedAccountID := strings.TrimSpace(*link.ExternalAccountID)
				if normalizedAccountID == "" {
					return domain.ValidationError{Field: "links.externalAccountId", Message: "must be a non-empty account ID or null"}
				}
				var status string
				if err := tx.QueryRowContext(ctx, `SELECT status FROM external_accounts WHERE id=? AND group_id=? AND deleted_at IS NULL`, normalizedAccountID, membership.GroupID).Scan(&status); errors.Is(err, sql.ErrNoRows) {
					return domain.ErrNotFound
				} else if err != nil {
					return err
				}
				if status != statusActive {
					return domain.ErrConflict
				}
				accountID = normalizedAccountID
				linkedCount++
			}
			if _, err := tx.ExecContext(ctx, `UPDATE group_payment_methods SET external_account_id=? WHERE id=? AND group_id=?`, accountID, link.PaymentMethodID, membership.GroupID); err != nil {
				return err
			}
		}
		if err := bumpCollectionVersion(ctx, tx, membership.GroupID, expectedVersion); err != nil {
			return err
		}
		if err := audit.Record(ctx, tx, membership.GroupID, actor.UserID, membership.ID, "external_account_links.replaced", "group", membership.GroupID, map[string]any{"paymentMethodCount": len(input.Links), "linkedMethodCount": linkedCount}); err != nil {
			return err
		}
		result, err = listPaymentMethodLinks(ctx, tx, membership.GroupID)
		return err
	})
	return result, err
}

func listPaymentMethodLinks(ctx context.Context, q interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, groupID string) (PaymentMethodLinkCollection, error) {
	var result PaymentMethodLinkCollection
	if err := q.QueryRowContext(ctx, `SELECT external_accounts_version FROM group_settings WHERE group_id=?`, groupID).Scan(&result.Version); errors.Is(err, sql.ErrNoRows) {
		return PaymentMethodLinkCollection{}, domain.ErrNotFound
	} else if err != nil {
		return PaymentMethodLinkCollection{}, err
	}
	rows, err := q.QueryContext(ctx, `SELECT id,external_account_id FROM group_payment_methods WHERE group_id=? ORDER BY sort_order,id`, groupID)
	if err != nil {
		return PaymentMethodLinkCollection{}, err
	}
	defer rows.Close()
	result.Links = []PaymentMethodLink{}
	for rows.Next() {
		var item PaymentMethodLink
		var accountID sql.NullString
		if err := rows.Scan(&item.PaymentMethodID, &accountID); err != nil {
			return PaymentMethodLinkCollection{}, err
		}
		item.ExternalAccountID = stringPointerOrNil(accountID)
		result.Links = append(result.Links, item)
	}
	return result, rows.Err()
}
