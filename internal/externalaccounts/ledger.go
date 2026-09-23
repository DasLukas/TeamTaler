package externalaccounts

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"math/big"
	"strings"

	"github.com/DasLukas/TeamTaler/internal/authorization"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/platform"
)

func requireActiveAccounts(ctx context.Context, tx *sql.Tx, groupID, primary string, counterparty *string) error {
	ids := []string{primary}
	if counterparty != nil {
		ids = append(ids, *counterparty)
	}
	for _, id := range ids {
		var status string
		if err := tx.QueryRowContext(ctx, `SELECT status FROM external_accounts WHERE group_id=? AND id=? AND deleted_at IS NULL`, groupID, id).Scan(&status); errors.Is(err, sql.ErrNoRows) {
			return domain.ErrNotFound
		} else if err != nil {
			return err
		}
		if status != statusActive {
			return fmt.Errorf("%w: archived accounts cannot receive new transactions", domain.ErrConflict)
		}
	}
	return nil
}
func insertExternalLedger(ctx context.Context, tx *sql.Tx, groupID, periodID, accountID, transactionID, paymentID, reversalOf string, amount int64, description, createdAt string) error {
	if err := ensureExternalAccountBalanceDelta(ctx, tx, groupID, accountID, amount); err != nil {
		return err
	}
	id, err := platform.NewID("led")
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO ledger_entries(id,group_id,period_id,payment_id,reversal_of,external_account_id,external_transaction_id,account,amount_minor,description,created_at) VALUES(?,?,?,nullif(?,''),nullif(?,''),?,?, 'EXTERNAL_ACCOUNT',?,?,?)`, id, groupID, periodID, paymentID, reversalOf, accountID, transactionID, amount, description, createdAt)
	return err
}

func ensureExternalAccountBalanceDelta(ctx context.Context, tx *sql.Tx, groupID, accountID string, delta int64) error {
	rows, err := tx.QueryContext(ctx, `SELECT amount_minor FROM ledger_entries WHERE group_id=? AND external_account_id=?`, groupID, accountID)
	if err != nil {
		return err
	}
	defer rows.Close()
	total := new(big.Int)
	value := new(big.Int)
	for rows.Next() {
		var amount int64
		if err := rows.Scan(&amount); err != nil {
			return err
		}
		total.Add(total, value.SetInt64(amount))
	}
	if err := rows.Err(); err != nil {
		return err
	}
	total.Add(total, value.SetInt64(delta))
	if !total.IsInt64() {
		return fmt.Errorf("%w: account balance exceeds the supported minor-unit range", domain.ErrConflict)
	}
	return nil
}

func externalAccountBalances(ctx context.Context, q authorization.Queryer, groupID string) (map[string]int64, error) {
	rows, err := q.QueryContext(ctx, `SELECT external_account_id,amount_minor FROM ledger_entries WHERE group_id=? AND external_account_id IS NOT NULL`, groupID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	totals := map[string]*big.Int{}
	value := new(big.Int)
	for rows.Next() {
		var accountID string
		var amount int64
		if err := rows.Scan(&accountID, &amount); err != nil {
			return nil, err
		}
		total := totals[accountID]
		if total == nil {
			total = new(big.Int)
			totals[accountID] = total
		}
		total.Add(total, value.SetInt64(amount))
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	balances := make(map[string]int64, len(totals))
	for accountID, total := range totals {
		if !total.IsInt64() {
			return nil, fmt.Errorf("%w: account %s balance exceeds the supported minor-unit range", domain.ErrConflict, accountID)
		}
		balances[accountID] = total.Int64()
	}
	return balances, nil
}
func insertOffsetLedger(ctx context.Context, tx *sql.Tx, groupID, periodID, transactionID string, amount int64, description, createdAt string) error {
	return insertOffsetLedgerReversal(ctx, tx, groupID, periodID, transactionID, "", amount, description, createdAt)
}
func insertOffsetLedgerReversal(ctx context.Context, tx *sql.Tx, groupID, periodID, transactionID, reversalOf string, amount int64, description, createdAt string) error {
	id, err := platform.NewID("led")
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO ledger_entries(id,group_id,period_id,reversal_of,external_transaction_id,account,amount_minor,description,created_at) VALUES(?,?,?,nullif(?,''),?,'EXTERNAL_OFFSET',?,?,?)`, id, groupID, periodID, reversalOf, transactionID, amount, description, createdAt)
	return err
}
func nullable(value string) any {
	if value == "" {
		return nil
	}
	return value
}
func stringPointerOrNil(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	result := value.String
	return &result
}
func mapConstraintError(err error, field string) error {
	if strings.Contains(strings.ToLower(err.Error()), "unique") || strings.Contains(strings.ToLower(err.Error()), "constraint") {
		return domain.ValidationError{Field: field, Message: "conflicts with existing group data"}
	}
	return err
}

func groupCurrency(ctx context.Context, queryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, groupID string) (string, error) {
	var currency string
	err := queryer.QueryRowContext(ctx, `SELECT currency FROM groups WHERE id=?`, groupID).Scan(&currency)
	if errors.Is(err, sql.ErrNoRows) {
		return "", domain.ErrNotFound
	}
	return currency, err
}
