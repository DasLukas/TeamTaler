package externalaccounts

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/DasLukas/TeamTaler/internal/audit"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/idempotency"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

// ListAccounts returns every active and archived account after live feature
// and VIEW_EXTERNAL_ACCOUNTS checks.
func (s Service) ListAccounts(ctx context.Context, membership domain.Membership) (AccountCollection, error) {
	if err := requireManualAccess(ctx, s.DB, membership, domain.PermissionViewExternalAccounts); err != nil {
		return AccountCollection{}, err
	}
	return listAccounts(ctx, s.DB, membership.GroupID)
}

// CreateAccount idempotently inserts one active account and, when supplied,
// its opening balance in the same database transaction.
func (s Service) CreateAccount(ctx context.Context, actor domain.Principal, membership domain.Membership, key string, expectedVersion int64, input CreateAccountInput) (AccountCollection, error) {
	if err := requireManualAccess(ctx, s.DB, membership, domain.PermissionManageExternalAccounts); err != nil {
		return AccountCollection{}, err
	}
	currency, err := groupCurrency(ctx, s.DB, membership.GroupID)
	if err != nil {
		return AccountCollection{}, err
	}
	normalized, err := normalizeAccountInput(input.AccountInput, currency)
	if err != nil {
		return AccountCollection{}, err
	}
	if err := idempotency.ValidateKey(key); err != nil {
		return AccountCollection{}, err
	}
	var opening *normalizedTransactionInput
	if input.OpeningBalance != nil {
		candidate := normalizedTransactionInput{
			Kind: string(domain.ExternalAccountTransactionOpeningBalance), AmountMinor: input.OpeningBalance.AmountMinor,
			Reason: input.OpeningBalance.Reason, Reference: input.OpeningBalance.Reference, Note: input.OpeningBalance.Note,
		}
		candidate.BookedAt, err = normalizeBookedAt(input.OpeningBalance.OccurredAt)
		candidate.Reason = strings.TrimSpace(candidate.Reason)
		candidate.Reference = strings.TrimSpace(candidate.Reference)
		candidate.Note = strings.TrimSpace(candidate.Note)
		if err != nil {
			return AccountCollection{}, err
		}
		if candidate.AmountMinor == 0 || candidate.AmountMinor < -100_000_000_000_000 || candidate.AmountMinor > 100_000_000_000_000 {
			return AccountCollection{}, domain.ValidationError{Field: "openingBalance.amountMinor", Message: "must be non-zero and at most 100000000000000 minor units in magnitude"}
		}
		if err := validateRequiredText("openingBalance.reason", candidate.Reason, 120); err != nil {
			return AccountCollection{}, err
		}
		if len(candidate.Reference) > 120 {
			return AccountCollection{}, domain.ValidationError{Field: "openingBalance.reference", Message: "must contain at most 120 characters"}
		}
		if len(candidate.Note) > 2000 {
			return AccountCollection{}, domain.ValidationError{Field: "openingBalance.note", Message: "must contain at most 2000 characters"}
		}
		opening = &candidate
	}
	hash, err := idempotency.Hash(struct {
		Account AccountInput
		Opening *normalizedTransactionInput
	}{normalized, opening})
	if err != nil {
		return AccountCollection{}, err
	}
	var result AccountCollection
	err = storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		if err := requireManualAccess(ctx, tx, membership, domain.PermissionManageExternalAccounts); err != nil {
			return err
		}
		if found, err := idempotency.Load(ctx, tx, membership.GroupID, actor.UserID, key, hash, &result); err != nil || found {
			return err
		}
		if err := requireCollectionVersion(ctx, tx, membership.GroupID, expectedVersion); err != nil {
			return err
		}
		accountID, err := platform.NewID("exa")
		if err != nil {
			return err
		}
		var sortOrder int
		if err := tx.QueryRowContext(ctx, `SELECT coalesce(max(sort_order)+1,0) FROM external_accounts WHERE group_id=?`, membership.GroupID).Scan(&sortOrder); err != nil {
			return err
		}
		now := platform.Timestamp(platform.Now())
		_, err = tx.ExecContext(ctx, `INSERT INTO external_accounts(
			id,group_id,name,type,status,sort_order,paypal_me_handle,sepa_recipient_name,sepa_iban,sepa_bic,version,created_at,updated_at,created_by_membership_id,updated_by_membership_id
		) VALUES(?,?,?,?,?,?,?,?,?,?,1,?,?,?,?)`, accountID, membership.GroupID, normalized.Name, normalized.Type, statusActive, sortOrder,
			nullable(normalized.PayPalMeHandle), nullable(normalized.SEPARecipientName), nullable(normalized.SEPAIBAN), nullable(normalized.SEPABIC), now, now, membership.ID, membership.ID)
		if err != nil {
			return mapConstraintError(err, "name")
		}
		if opening != nil {
			opening.PrimaryAccountID = accountID
			if _, err := createManualTransactionTx(ctx, tx, membership, *opening, nil); err != nil {
				return err
			}
		}
		if err := bumpCollectionVersion(ctx, tx, membership.GroupID, expectedVersion); err != nil {
			return err
		}
		metadata := map[string]any{"type": normalized.Type, "openingBalance": opening != nil}
		if opening != nil {
			metadata["openingAmountMinor"] = opening.AmountMinor
		}
		if err := audit.Record(ctx, tx, membership.GroupID, actor.UserID, membership.ID, "external_account.created", "external_account", accountID, metadata); err != nil {
			return err
		}
		result, err = listAccounts(ctx, tx, membership.GroupID)
		if err != nil {
			return err
		}
		return idempotency.Store(ctx, tx, membership.GroupID, actor.UserID, key, hash, 201, result)
	})
	return result, err
}

// UpdateAccount replaces editable account fields under the collection ETag.
// Type changes are rejected after the first ledger movement.
func (s Service) UpdateAccount(ctx context.Context, actor domain.Principal, membership domain.Membership, accountID string, input AccountInput, expectedVersion int64) (AccountCollection, error) {
	if err := s.AuthorizeManagement(ctx, membership); err != nil {
		return AccountCollection{}, err
	}
	currency, err := groupCurrency(ctx, s.DB, membership.GroupID)
	if err != nil {
		return AccountCollection{}, err
	}
	var result AccountCollection
	err = storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		if err := requireManualAccess(ctx, tx, membership, domain.PermissionManageExternalAccounts); err != nil {
			return err
		}
		if err := requireCollectionVersion(ctx, tx, membership.GroupID, expectedVersion); err != nil {
			return err
		}
		var previous AccountInput
		if err := tx.QueryRowContext(ctx, `SELECT type,coalesce(paypal_me_handle,''),coalesce(sepa_recipient_name,''),coalesce(sepa_iban,''),coalesce(sepa_bic,'') FROM external_accounts WHERE id=? AND group_id=? AND deleted_at IS NULL`, accountID, membership.GroupID).Scan(&previous.Type, &previous.PayPalMeHandle, &previous.SEPARecipientName, &previous.SEPAIBAN, &previous.SEPABIC); errors.Is(err, sql.ErrNoRows) {
			return domain.ErrNotFound
		} else if err != nil {
			return err
		}
		input = preserveMaskedProviderDetails(input, previous)
		normalized, err := normalizeAccountInput(input, currency)
		if err != nil {
			return err
		}
		if previous.Type != normalized.Type {
			var movements int
			if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM ledger_entries WHERE group_id=? AND external_account_id=?`, membership.GroupID, accountID).Scan(&movements); err != nil {
				return err
			}
			if movements != 0 {
				return fmt.Errorf("%w: account type cannot change after its first movement", domain.ErrConflict)
			}
		}
		now := platform.Timestamp(platform.Now())
		changed, err := tx.ExecContext(ctx, `UPDATE external_accounts SET name=?,type=?,paypal_me_handle=?,sepa_recipient_name=?,sepa_iban=?,sepa_bic=?,version=version+1,updated_at=?,updated_by_membership_id=? WHERE id=? AND group_id=? AND deleted_at IS NULL`,
			normalized.Name, normalized.Type, nullable(normalized.PayPalMeHandle), nullable(normalized.SEPARecipientName), nullable(normalized.SEPAIBAN), nullable(normalized.SEPABIC), now, membership.ID, accountID, membership.GroupID)
		if err != nil {
			return mapConstraintError(err, "name")
		}
		if count, _ := changed.RowsAffected(); count != 1 {
			return domain.ErrNotFound
		}
		if err := bumpCollectionVersion(ctx, tx, membership.GroupID, expectedVersion); err != nil {
			return err
		}
		if err := audit.Record(ctx, tx, membership.GroupID, actor.UserID, membership.ID, "external_account.updated", "external_account", accountID, map[string]any{"previousType": previous.Type, "currentType": normalized.Type}); err != nil {
			return err
		}
		result, err = listAccounts(ctx, tx, membership.GroupID)
		return err
	})
	return result, err
}

// SetAccountArchived archives or reactivates an account under the collection
// ETag. Archiving atomically detaches every current payment-method link while
// retaining immutable ledger references for historical payments and reversals.
func (s Service) SetAccountArchived(ctx context.Context, actor domain.Principal, membership domain.Membership, accountID string, archived bool, expectedVersion int64) (AccountCollection, error) {
	target := statusActive
	action := "external_account.reactivated"
	if archived {
		target = statusArchived
		action = "external_account.archived"
	}
	var result AccountCollection
	err := storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		if err := requireManualAccess(ctx, tx, membership, domain.PermissionManageExternalAccounts); err != nil {
			return err
		}
		if err := requireCollectionVersion(ctx, tx, membership.GroupID, expectedVersion); err != nil {
			return err
		}
		detachedPaymentMethodCount := int64(0)
		if archived {
			detached, err := tx.ExecContext(ctx, `UPDATE group_payment_methods SET external_account_id=NULL WHERE group_id=? AND external_account_id=?`, membership.GroupID, accountID)
			if err != nil {
				return err
			}
			detachedPaymentMethodCount, err = detached.RowsAffected()
			if err != nil {
				return err
			}
		}
		now := platform.Timestamp(platform.Now())
		changed, err := tx.ExecContext(ctx, `UPDATE external_accounts SET status=?,version=version+1,updated_at=?,updated_by_membership_id=? WHERE id=? AND group_id=? AND deleted_at IS NULL AND status<>?`, target, now, membership.ID, accountID, membership.GroupID, target)
		if err != nil {
			return err
		}
		if count, _ := changed.RowsAffected(); count != 1 {
			var exists int
			_ = tx.QueryRowContext(ctx, `SELECT count(*) FROM external_accounts WHERE id=? AND group_id=? AND deleted_at IS NULL`, accountID, membership.GroupID).Scan(&exists)
			if exists == 0 {
				return domain.ErrNotFound
			}
			return domain.ErrConflict
		}
		if err := bumpCollectionVersion(ctx, tx, membership.GroupID, expectedVersion); err != nil {
			return err
		}
		metadata := map[string]any{}
		if archived {
			metadata["detachedPaymentMethodCount"] = detachedPaymentMethodCount
		}
		if err := audit.Record(ctx, tx, membership.GroupID, actor.UserID, membership.ID, action, "external_account", accountID, metadata); err != nil {
			return err
		}
		result, err = listAccounts(ctx, tx, membership.GroupID)
		return err
	})
	return result, err
}

// DeleteAccount physically removes an unused account or hides a balanced,
// archived account as a historical identity. Immutable financial history
// keeps referencing historical identities and therefore remains readable.
func (s Service) DeleteAccount(ctx context.Context, actor domain.Principal, membership domain.Membership, accountID string, expectedVersion int64) (AccountCollection, error) {
	var result AccountCollection
	err := storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		if err := requireManualAccess(ctx, tx, membership, domain.PermissionManageExternalAccounts); err != nil {
			return err
		}
		if err := requireCollectionVersion(ctx, tx, membership.GroupID, expectedVersion); err != nil {
			return err
		}
		var status domain.ExternalAccountStatus
		var links, transactions, ledgerRows int
		var balanceMinor int64
		err := tx.QueryRowContext(ctx, `SELECT
			a.status,
			(SELECT count(*) FROM group_payment_methods WHERE group_id=? AND external_account_id=?),
			(SELECT count(*) FROM external_account_transactions WHERE group_id=? AND (primary_account_id=? OR counterparty_account_id=?)),
			(SELECT count(*) FROM ledger_entries WHERE group_id=? AND external_account_id=?),
			(SELECT coalesce(sum(amount_minor),0) FROM ledger_entries WHERE group_id=? AND external_account_id=? AND account='EXTERNAL_ACCOUNT')
			FROM external_accounts a WHERE a.id=? AND a.group_id=? AND a.deleted_at IS NULL`, membership.GroupID, accountID, membership.GroupID, accountID, accountID, membership.GroupID, accountID, membership.GroupID, accountID, accountID, membership.GroupID).Scan(&status, &links, &transactions, &ledgerRows, &balanceMinor)
		if errors.Is(err, sql.ErrNoRows) {
			return domain.ErrNotFound
		}
		if err != nil {
			return err
		}
		if status != domain.ExternalAccountArchived {
			return fmt.Errorf("%w: accounts must be archived before deletion", domain.ErrConflict)
		}
		if links != 0 {
			return fmt.Errorf("%w: linked accounts must be archived before deletion", domain.ErrConflict)
		}
		used := transactions+ledgerRows != 0
		deletionMode := "physical"
		if used {
			if balanceMinor != 0 {
				return fmt.Errorf("%w: account balance must be zero before deletion", domain.ErrConflict)
			}
			deletionMode = "historical"
			now := platform.Timestamp(platform.Now())
			changed, err := tx.ExecContext(ctx, `UPDATE external_accounts SET deleted_at=?,version=version+1,updated_at=?,updated_by_membership_id=? WHERE id=? AND group_id=? AND deleted_at IS NULL`, now, now, membership.ID, accountID, membership.GroupID)
			if err != nil {
				return err
			}
			if count, _ := changed.RowsAffected(); count != 1 {
				return domain.ErrNotFound
			}
		} else {
			changed, err := tx.ExecContext(ctx, `DELETE FROM external_accounts WHERE id=? AND group_id=? AND deleted_at IS NULL`, accountID, membership.GroupID)
			if err != nil {
				return err
			}
			if count, _ := changed.RowsAffected(); count != 1 {
				return domain.ErrNotFound
			}
		}
		if err := bumpCollectionVersion(ctx, tx, membership.GroupID, expectedVersion); err != nil {
			return err
		}
		if err := audit.Record(ctx, tx, membership.GroupID, actor.UserID, membership.ID, "external_account.deleted", "external_account", accountID, map[string]any{"mode": deletionMode}); err != nil {
			return err
		}
		result, err = listAccounts(ctx, tx, membership.GroupID)
		return err
	})
	return result, err
}

// ReorderAccounts replaces the complete account order under one collection
// ETag. Every existing active and archived account must occur exactly once.
func (s Service) ReorderAccounts(ctx context.Context, actor domain.Principal, membership domain.Membership, accountIDs []string, expectedVersion int64) (AccountCollection, error) {
	var result AccountCollection
	err := storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		if err := requireManualAccess(ctx, tx, membership, domain.PermissionManageExternalAccounts); err != nil {
			return err
		}
		if err := requireCollectionVersion(ctx, tx, membership.GroupID, expectedVersion); err != nil {
			return err
		}
		rows, err := tx.QueryContext(ctx, `SELECT id FROM external_accounts WHERE group_id=? AND deleted_at IS NULL ORDER BY sort_order,id`, membership.GroupID)
		if err != nil {
			return err
		}
		var existing []string
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return err
			}
			existing = append(existing, id)
		}
		if err := rows.Close(); err != nil {
			return err
		}
		if len(existing) != len(accountIDs) {
			return domain.ValidationError{Field: "accountIds", Message: "must contain every account exactly once"}
		}
		seen := map[string]bool{}
		for _, id := range accountIDs {
			if seen[id] || !slices.Contains(existing, id) {
				return domain.ValidationError{Field: "accountIds", Message: "must contain every account exactly once"}
			}
			seen[id] = true
		}
		now := platform.Timestamp(platform.Now())
		var maximum, visibleBase int
		if err := tx.QueryRowContext(ctx, `SELECT coalesce(max(sort_order),0),coalesce(max(CASE WHEN deleted_at IS NOT NULL THEN sort_order END),-1)+1 FROM external_accounts WHERE group_id=?`, membership.GroupID).Scan(&maximum, &visibleBase); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE external_accounts SET sort_order=sort_order+? WHERE group_id=? AND deleted_at IS NULL`, maximum+len(accountIDs)+1, membership.GroupID); err != nil {
			return err
		}
		for order, id := range accountIDs {
			if _, err := tx.ExecContext(ctx, `UPDATE external_accounts SET sort_order=?,version=version+1,updated_at=?,updated_by_membership_id=? WHERE id=? AND group_id=? AND deleted_at IS NULL`, visibleBase+order, now, membership.ID, id, membership.GroupID); err != nil {
				return err
			}
		}
		if err := bumpCollectionVersion(ctx, tx, membership.GroupID, expectedVersion); err != nil {
			return err
		}
		if err := audit.Record(ctx, tx, membership.GroupID, actor.UserID, membership.ID, "external_accounts.reordered", "group", membership.GroupID, map[string]any{"accountCount": len(accountIDs)}); err != nil {
			return err
		}
		result, err = listAccounts(ctx, tx, membership.GroupID)
		return err
	})
	return result, err
}

func listAccounts(ctx context.Context, q interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, groupID string) (AccountCollection, error) {
	var result AccountCollection
	if err := q.QueryRowContext(ctx, `SELECT external_accounts_version FROM group_settings WHERE group_id=?`, groupID).Scan(&result.Version); errors.Is(err, sql.ErrNoRows) {
		return AccountCollection{}, domain.ErrNotFound
	} else if err != nil {
		return AccountCollection{}, err
	}
	rows, err := q.QueryContext(ctx, `SELECT a.id,a.group_id,a.name,a.type,a.status,a.sort_order,coalesce(a.paypal_me_handle,''),coalesce(a.sepa_recipient_name,''),coalesce(a.sepa_iban,''),coalesce(a.sepa_bic,''),g.currency,a.version,a.created_at,a.updated_at,
		(EXISTS(SELECT 1 FROM external_account_transactions transaction_row WHERE transaction_row.group_id=a.group_id AND (transaction_row.primary_account_id=a.id OR transaction_row.counterparty_account_id=a.id))
		 OR EXISTS(SELECT 1 FROM ledger_entries entry WHERE entry.group_id=a.group_id AND entry.external_account_id=a.id))
		FROM external_accounts a JOIN groups g ON g.id=a.group_id WHERE a.group_id=? AND a.deleted_at IS NULL ORDER BY a.status='ARCHIVED',a.sort_order,a.id`, groupID)
	if err != nil {
		return AccountCollection{}, err
	}
	result.Items = []domain.ExternalAccount{}
	for rows.Next() {
		var item domain.ExternalAccount
		if err := rows.Scan(&item.ID, &item.GroupID, &item.Name, &item.Type, &item.Status, &item.SortOrder, &item.PayPalMeHandle, &item.SEPARecipientName, &item.SEPAIBAN, &item.SEPABIC, &item.Currency, &item.Version, &item.CreatedAt, &item.UpdatedAt, &item.HasTransactions); err != nil {
			return AccountCollection{}, err
		}
		maskProviderDetails(&item)
		result.Items = append(result.Items, item)
	}
	if err := rows.Err(); err != nil {
		return AccountCollection{}, err
	}
	if err := rows.Close(); err != nil {
		return AccountCollection{}, err
	}
	balances, err := externalAccountBalances(ctx, q, groupID)
	if err != nil {
		return AccountCollection{}, err
	}
	for index := range result.Items {
		result.Items[index].BalanceMinor = balances[result.Items[index].ID]
	}
	linkRows, err := q.QueryContext(ctx, `SELECT external_account_id,id FROM group_payment_methods WHERE group_id=? AND external_account_id IS NOT NULL ORDER BY sort_order,id`, groupID)
	if err != nil {
		return AccountCollection{}, err
	}
	defer linkRows.Close()
	links := map[string][]string{}
	for linkRows.Next() {
		var accountID, methodID string
		if err := linkRows.Scan(&accountID, &methodID); err != nil {
			return AccountCollection{}, err
		}
		links[accountID] = append(links[accountID], methodID)
	}
	if err := linkRows.Err(); err != nil {
		return AccountCollection{}, err
	}
	for index := range result.Items {
		result.Items[index].LinkedPaymentMethodIDs = links[result.Items[index].ID]
		if result.Items[index].LinkedPaymentMethodIDs == nil {
			result.Items[index].LinkedPaymentMethodIDs = []string{}
		}
		linked := len(result.Items[index].LinkedPaymentMethodIDs) != 0
		result.Items[index].CanChangeType = !result.Items[index].HasTransactions
		result.Items[index].CanDelete = result.Items[index].Status == domain.ExternalAccountArchived && !linked && (!result.Items[index].HasTransactions || result.Items[index].BalanceMinor == 0)
		result.Items[index].CanArchive = result.Items[index].Status == domain.ExternalAccountActive
		result.Items[index].CanReactivate = result.Items[index].Status == domain.ExternalAccountArchived
	}
	return result, nil
}
