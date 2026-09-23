package statistics

import (
	"context"
	"fmt"

	"github.com/DasLukas/TeamTaler/internal/platform"
)

// externalAccountStatistics returns exact ledger balances for accounts visible
// to an authorized statistics viewer. The caller enforces both feature gates.
// It accepts the tenant, canonical currency, and resolved statistics range,
// and returns an optional section or a database error. Balances derive only
// from immutable external-account ledger legs, never member receivables.
func (s Service) externalAccountStatistics(ctx context.Context, groupID, currency string, rangeValue resolvedRange) (*ExternalAccountsStatistics, error) {
	result := &ExternalAccountsStatistics{Currency: currency, Accounts: make([]ExternalAccountStatistics, 0)}
	from, to := platform.Timestamp(rangeValue.from), platform.Timestamp(rangeValue.to)
	rows, err := s.queryer().QueryContext(ctx, `SELECT account.id,account.name,account.type,account.status,
		coalesce((SELECT sum(entry.amount_minor) FROM ledger_entries entry
			WHERE entry.group_id=account.group_id AND entry.external_account_id=account.id
			AND entry.account='EXTERNAL_ACCOUNT' AND entry.created_at<?),0)
		FROM external_accounts account WHERE account.group_id=? AND account.deleted_at IS NULL AND account.created_at<?
		ORDER BY CASE account.status WHEN 'ACTIVE' THEN 0 ELSE 1 END,account.sort_order,account.id`, from, groupID, to)
	if err != nil {
		return nil, fmt.Errorf("query external statistics accounts: %w", err)
	}
	accountIndexes := make(map[string]int)
	for rows.Next() {
		var account ExternalAccountStatistics
		if err := rows.Scan(&account.ID, &account.Name, &account.Type, &account.Status, &account.OpeningBalanceMinor); err != nil {
			rows.Close()
			return nil, err
		}
		account.ClosingBalanceMinor = account.OpeningBalanceMinor
		account.Series = make([]ExternalAccountPoint, len(rangeValue.buckets))
		for index, bucket := range rangeValue.buckets {
			account.Series[index].PeriodStart = bucket.periodStart.Format(timeFormatWithOffset)
		}
		accountIndexes[account.ID] = len(result.Accounts)
		result.Accounts = append(result.Accounts, account)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	if len(result.Accounts) == 0 {
		return result, nil
	}

	values, args := bucketValues(rangeValue)
	query := `WITH buckets(bucket_index,from_utc,to_utc) AS (VALUES ` + values + `)
		SELECT entry.external_account_id,bucket.bucket_index,sum(entry.amount_minor)
		FROM buckets bucket JOIN ledger_entries entry
			ON entry.group_id=? AND entry.account='EXTERNAL_ACCOUNT'
			AND entry.created_at>=bucket.from_utc AND entry.created_at<bucket.to_utc
		WHERE bucket.from_utc>=? AND bucket.to_utc<=?
		GROUP BY entry.external_account_id,bucket.bucket_index`
	args = append(args, groupID, from, to)
	rows, err = s.queryer().QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("query external statistics balances: %w", err)
	}
	for rows.Next() {
		var accountID string
		var bucketIndex int
		var amount int64
		if err := rows.Scan(&accountID, &bucketIndex, &amount); err != nil {
			rows.Close()
			return nil, err
		}
		if accountIndex, found := accountIndexes[accountID]; found {
			if bucketIndex < 0 || bucketIndex >= len(rangeValue.buckets) {
				rows.Close()
				return nil, fmt.Errorf("external statistics returned invalid bucket index %d", bucketIndex)
			}
			result.Accounts[accountIndex].Series[bucketIndex].ClosingBalanceMinor = amount
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	for accountIndex := range result.Accounts {
		account := &result.Accounts[accountIndex]
		closing := account.OpeningBalanceMinor
		for bucketIndex := range account.Series {
			closing += account.Series[bucketIndex].ClosingBalanceMinor
			account.Series[bucketIndex].ClosingBalanceMinor = closing
		}
		account.ClosingBalanceMinor = closing
	}
	return result, nil
}
