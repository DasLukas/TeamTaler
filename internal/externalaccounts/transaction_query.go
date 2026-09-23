package externalaccounts

import (
	"context"
	"database/sql"
	"slices"
	"strconv"
	"strings"

	"github.com/DasLukas/TeamTaler/internal/authorization"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/media"
	"github.com/DasLukas/TeamTaler/internal/tablequery"
)

// QueryTransactions returns one filtered history page after live feature and
// VIEW_EXTERNAL_ACCOUNTS checks.
func (s Service) QueryTransactions(ctx context.Context, membership domain.Membership, input TransactionQuery) (TransactionPage, error) {
	if err := requireManualAccess(ctx, s.DB, membership, domain.PermissionViewExternalAccounts); err != nil {
		return TransactionPage{}, err
	}
	return queryTransactions(ctx, s.DB, membership.GroupID, input)
}

func queryTransactions(ctx context.Context, q authorization.Queryer, groupID string, input TransactionQuery) (TransactionPage, error) {
	input.Search = strings.TrimSpace(input.Search)
	if len(input.Search) > 200 {
		return TransactionPage{}, domain.ValidationError{Field: "q", Message: "must contain at most 200 characters"}
	}
	allowedSorts := map[string]struct{}{"occurredAt": {}, "amount": {}, "kind": {}, "actorName": {}, "status": {}}
	var err error
	input.Sort, input.Direction, err = tablequery.NormalizeSort(input.Sort, input.Direction, "occurredAt", "desc", allowedSorts)
	if err != nil {
		return TransactionPage{}, err
	}
	if input.Limit < 1 || input.Limit > 200 {
		input.Limit = 100
	}
	input.OccurredFrom, err = tablequery.NormalizeTimeBound("occurredFrom", input.OccurredFrom, false)
	if err != nil {
		return TransactionPage{}, err
	}
	input.OccurredTo, err = tablequery.NormalizeTimeBound("occurredTo", input.OccurredTo, true)
	if err != nil {
		return TransactionPage{}, err
	}
	input.AccountIDs, err = tablequery.NormalizeStringSet("accountId", input.AccountIDs)
	if err != nil {
		return TransactionPage{}, err
	}
	for _, kind := range input.Kinds {
		if !validStoredKind(kind) {
			return TransactionPage{}, domain.ValidationError{Field: "kind", Message: "contains an unsupported value"}
		}
	}
	slices.Sort(input.Kinds)
	input.Source = strings.ToUpper(strings.TrimSpace(input.Source))
	if input.Source != "" && input.Source != "MANUAL" && input.Source != "PAYMENT" {
		return TransactionPage{}, domain.ValidationError{Field: "source", Message: "must be MANUAL or PAYMENT"}
	}
	input.Status = strings.ToUpper(strings.TrimSpace(input.Status))
	if input.Status != "" && input.Status != "POSTED" && input.Status != "REVERSED" {
		return TransactionPage{}, domain.ValidationError{Field: "status", Message: "must be POSTED or REVERSED"}
	}
	fingerprint, err := tablequery.Fingerprint(struct {
		GroupID string
		Query   TransactionQuery
	}{groupID, TransactionQuery{TransactionID: input.TransactionID, Search: input.Search, AccountIDs: input.AccountIDs, Kinds: input.Kinds, Source: input.Source, Status: input.Status, OccurredFrom: input.OccurredFrom, OccurredTo: input.OccurredTo, AmountMin: input.AmountMin, AmountMax: input.AmountMax, Sort: input.Sort, Direction: input.Direction}})
	if err != nil {
		return TransactionPage{}, err
	}
	cursorKey, cursorID, err := tablequery.DecodeCursor(input.Cursor, fingerprint, input.Sort, input.Direction)
	if err != nil {
		return TransactionPage{}, err
	}
	sortExpr := transactionSortExpression(input.Sort)
	query := `SELECT t.id,t.group_id,t.kind,t.primary_account_id,t.counterparty_account_id,t.payment_id,t.amount_minor,g.currency,t.booked_at,coalesce(t.reason,''),t.reference,t.note,t.reversal_of,t.correction_of,t.created_by_membership_id,t.created_at,
		EXISTS(SELECT 1 FROM external_account_transactions reversal WHERE reversal.group_id=t.group_id AND reversal.reversal_of=t.id),
		(t.kind='PAYMENT' OR EXISTS(SELECT 1 FROM external_account_transactions original WHERE original.group_id=t.group_id AND original.id=t.reversal_of AND original.kind='PAYMENT')),
		coalesce((SELECT reversal.id FROM external_account_transactions reversal WHERE reversal.group_id=t.group_id AND reversal.reversal_of=t.id ORDER BY reversal.created_at,reversal.id LIMIT 1),''),
		coalesce((SELECT replacement.id FROM external_account_transactions replacement WHERE replacement.group_id=t.group_id AND replacement.correction_of=t.id ORDER BY replacement.created_at,replacement.id LIMIT 1),''),
		primary_account.name,primary_account.type,counterparty_account.name,counterparty_account.type,actor_user.display_name,actor_user.id,coalesce(actor_user.avatar_key,''),
		attachment.original_filename,attachment.media_type,attachment.size_bytes,CAST(` + sortExpr + ` AS TEXT)
		FROM external_account_transactions t
		JOIN groups g ON g.id=t.group_id
		JOIN external_accounts primary_account ON primary_account.group_id=t.group_id AND primary_account.id=t.primary_account_id
		LEFT JOIN external_accounts counterparty_account ON counterparty_account.group_id=t.group_id AND counterparty_account.id=t.counterparty_account_id
		JOIN memberships actor_membership ON actor_membership.group_id=t.group_id AND actor_membership.id=t.created_by_membership_id
		JOIN users actor_user ON actor_user.id=actor_membership.user_id
		LEFT JOIN external_account_transaction_attachments attachment ON attachment.group_id=t.group_id AND attachment.transaction_id=t.id
		WHERE t.group_id=?`
	args := []any{groupID}
	if input.TransactionID != "" {
		query += ` AND t.id=?`
		args = append(args, input.TransactionID)
	}
	if input.Search != "" {
		pattern := "%" + strings.ReplaceAll(strings.ReplaceAll(strings.ReplaceAll(input.Search, "\\", "\\\\"), "%", "\\%"), "_", "\\_") + "%"
		query += ` AND (t.reason LIKE ? ESCAPE '\' COLLATE NOCASE OR coalesce(t.reference,'') LIKE ? ESCAPE '\' COLLATE NOCASE OR coalesce(t.note,'') LIKE ? ESCAPE '\' COLLATE NOCASE OR primary_account.name LIKE ? ESCAPE '\' COLLATE NOCASE OR coalesce(counterparty_account.name,'') LIKE ? ESCAPE '\' COLLATE NOCASE)`
		args = append(args, pattern, pattern, pattern, pattern, pattern)
	}
	if len(input.AccountIDs) > 0 {
		placeholders := strings.TrimSuffix(strings.Repeat("?,", len(input.AccountIDs)), ",")
		query += ` AND (t.primary_account_id IN (` + placeholders + `) OR t.counterparty_account_id IN (` + placeholders + `))`
		for _, accountID := range input.AccountIDs {
			args = append(args, accountID)
		}
		for _, accountID := range input.AccountIDs {
			args = append(args, accountID)
		}
	}
	query, args = tablequery.AppendExactStringSet(query, args, "t.kind", input.Kinds)
	if input.Source == "PAYMENT" {
		query += ` AND (t.kind='PAYMENT' OR EXISTS(SELECT 1 FROM external_account_transactions original WHERE original.group_id=t.group_id AND original.id=t.reversal_of AND original.kind='PAYMENT'))`
	}
	if input.Source == "MANUAL" {
		query += ` AND NOT (t.kind='PAYMENT' OR EXISTS(SELECT 1 FROM external_account_transactions original WHERE original.group_id=t.group_id AND original.id=t.reversal_of AND original.kind='PAYMENT'))`
	}
	if input.Status == "REVERSED" {
		query += ` AND EXISTS(SELECT 1 FROM external_account_transactions reversal WHERE reversal.group_id=t.group_id AND reversal.reversal_of=t.id)`
	}
	if input.Status == "POSTED" {
		query += ` AND NOT EXISTS(SELECT 1 FROM external_account_transactions reversal WHERE reversal.group_id=t.group_id AND reversal.reversal_of=t.id)`
	}
	if input.OccurredFrom != "" {
		query += ` AND t.booked_at>=?`
		args = append(args, input.OccurredFrom)
	}
	if input.OccurredTo != "" {
		query += ` AND t.booked_at<?`
		args = append(args, input.OccurredTo)
	}
	if input.AmountMin != nil {
		query += ` AND t.amount_minor>=?`
		args = append(args, *input.AmountMin)
	}
	if input.AmountMax != nil {
		query += ` AND t.amount_minor<=?`
		args = append(args, *input.AmountMax)
	}
	operator := "<"
	order := "DESC"
	if input.Direction == "asc" {
		operator, order = ">", "ASC"
	}
	if cursorID != "" {
		var bound any = cursorKey
		if input.Sort == "amount" || input.Sort == "status" {
			value, parseErr := strconv.ParseInt(cursorKey, 10, 64)
			if parseErr != nil || input.Sort == "status" && value != 0 && value != 1 {
				return TransactionPage{}, domain.ValidationError{Field: "cursor", Message: "is invalid or does not match the current query"}
			}
			bound = value
		}
		query += ` AND (` + sortExpr + ` ` + operator + ` ? OR (` + sortExpr + ` = ? AND t.id ` + operator + ` ?))`
		args = append(args, bound, bound, cursorID)
	}
	query += ` ORDER BY ` + sortExpr + ` ` + order + `,t.id ` + order + ` LIMIT ?`
	args = append(args, input.Limit+1)
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return TransactionPage{}, err
	}
	defer rows.Close()
	items := make([]TransactionView, 0, input.Limit+1)
	keys := make([]string, 0, input.Limit+1)
	for rows.Next() {
		var item TransactionView
		var counterparty, payment, reference, note, reversal, correction, counterpartyName, counterpartyType sql.NullString
		var attachmentFileName, attachmentMediaType sql.NullString
		var attachmentSize sql.NullInt64
		var reversed, paymentSource int
		var primaryName, actorUserID, actorAvatarKey string
		var primaryType domain.ExternalAccountType
		var key string
		if err := rows.Scan(&item.ID, &item.GroupID, &item.Kind, &item.PrimaryAccountID, &counterparty, &payment, &item.AmountMinor, &item.Currency, &item.BookedAt, &item.Reason, &reference, &note, &reversal, &correction, &item.CreatedByMembershipID, &item.CreatedAt, &reversed, &paymentSource, &item.ReversedByID, &item.ReplacementID, &primaryName, &primaryType, &counterpartyName, &counterpartyType, &item.Actor.DisplayName, &actorUserID, &actorAvatarKey, &attachmentFileName, &attachmentMediaType, &attachmentSize, &key); err != nil {
			return TransactionPage{}, err
		}
		item.CounterpartyAccountID = counterparty.String
		item.PaymentID = payment.String
		item.Reference = reference.String
		item.Note = note.String
		item.ReversalOf = reversal.String
		item.CorrectionOf = correction.String
		item.OccurredAt = item.BookedAt
		item.ReversalOfID = item.ReversalOf
		item.ReplacementForID = item.CorrectionOf
		item.Actor.ID = item.CreatedByMembershipID
		item.Actor.AvatarURL = media.UserAvatarURL(actorUserID, actorAvatarKey)
		if attachmentFileName.Valid && attachmentMediaType.Valid && attachmentSize.Valid {
			item.Attachment = &domain.PaymentAttachmentSummary{
				FileName: attachmentFileName.String, MediaType: attachmentMediaType.String, SizeBytes: attachmentSize.Int64,
				URL: transactionAttachmentURL(item.GroupID, item.ID),
			}
		}
		item.Source = "MANUAL"
		if paymentSource == 1 {
			item.Source = "PAYMENT"
		}
		item.Status = "POSTED"
		if reversed == 1 {
			item.Status = "REVERSED"
		}
		item.CanReverse = paymentSource == 0 && item.Kind != domain.ExternalAccountTransactionReversal && reversed == 0
		primary := &AccountReference{ID: item.PrimaryAccountID, Name: primaryName, Type: primaryType}
		var counterpartyReference *AccountReference
		if counterparty.Valid {
			counterpartyReference = &AccountReference{ID: counterparty.String, Name: counterpartyName.String, Type: domain.ExternalAccountType(counterpartyType.String)}
		}
		if item.AmountMinor < 0 {
			item.SourceAccount, item.DestinationAccount = primary, counterpartyReference
		} else if counterpartyReference != nil {
			item.SourceAccount, item.DestinationAccount = counterpartyReference, primary
		} else {
			item.DestinationAccount = primary
		}
		item.Impacts = []TransactionImpact{{Account: *primary, AmountMinor: item.AmountMinor}}
		if counterpartyReference != nil {
			item.Impacts = append(item.Impacts, TransactionImpact{Account: *counterpartyReference, AmountMinor: -item.AmountMinor})
		}
		items = append(items, item)
		keys = append(keys, key)
	}
	if err := rows.Err(); err != nil {
		return TransactionPage{}, err
	}
	page := TransactionPage{Items: items}
	if len(items) > input.Limit {
		last := input.Limit - 1
		page.Items = items[:input.Limit]
		page.NextCursor, err = tablequery.EncodeCursor(fingerprint, input.Sort, input.Direction, keys[last], items[last].ID)
	}
	return page, err
}

// GetTransaction returns one fully projected transaction after live feature
// and view-permission checks.
func (s Service) GetTransaction(ctx context.Context, membership domain.Membership, transactionID string) (TransactionView, error) {
	if err := requireManualAccess(ctx, s.DB, membership, domain.PermissionViewExternalAccounts); err != nil {
		return TransactionView{}, err
	}
	return getTransactionView(ctx, s.DB, membership.GroupID, transactionID)
}

func getTransactionView(ctx context.Context, q authorization.Queryer, groupID, transactionID string) (TransactionView, error) {
	page, err := queryTransactions(ctx, q, groupID, TransactionQuery{TransactionID: transactionID, Limit: 1})
	if err != nil {
		return TransactionView{}, err
	}
	if len(page.Items) != 1 {
		return TransactionView{}, domain.ErrNotFound
	}
	return page.Items[0], nil
}
