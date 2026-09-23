package externalaccounts

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/DasLukas/TeamTaler/internal/audit"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/idempotency"
	"github.com/DasLukas/TeamTaler/internal/paymentattachments"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

// CreateTransaction posts one idempotent manual movement and its balanced
// immutable ledger entries. The exact projected response is persisted in the
// same transaction so an idempotency replay cannot observe later state.
func (s Service) CreateTransaction(ctx context.Context, actor domain.Principal, membership domain.Membership, key string, input CreateTransactionInput) (TransactionView, error) {
	return s.CreateTransactionWithAttachment(ctx, actor, membership, key, input, nil)
}

// CreateTransactionWithAttachment posts one idempotent manual movement with
// an optional immutable attachment. The content hash participates in the
// idempotency fingerprint and the file reference commits with the ledger.
func (s Service) CreateTransactionWithAttachment(ctx context.Context, actor domain.Principal, membership domain.Membership, key string, input CreateTransactionInput, attachment *TransactionAttachmentUpload) (TransactionView, error) {
	if err := requireManualAccess(ctx, s.DB, membership, domain.PermissionManageExternalAccounts); err != nil {
		return TransactionView{}, err
	}
	normalized, err := normalizeTransactionInput(input)
	if err != nil {
		return TransactionView{}, err
	}
	if err := idempotency.ValidateKey(key); err != nil {
		return TransactionView{}, err
	}
	storedAttachment, attachmentCreated, releaseAttachment, err := s.storeTransactionAttachment(attachment)
	if err != nil {
		return TransactionView{}, err
	}
	if releaseAttachment != nil {
		defer releaseAttachment()
	}
	hash, err := idempotency.Hash(struct {
		Input          normalizedTransactionInput
		AttachmentHash string
	}{Input: normalized, AttachmentHash: transactionAttachmentHash(storedAttachment)})
	if err != nil {
		s.cleanupTransactionAttachment(storedAttachment, attachmentCreated)
		return TransactionView{}, err
	}
	var result TransactionView
	err = storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		if err := requireManualAccess(ctx, tx, membership, domain.PermissionManageExternalAccounts); err != nil {
			return err
		}
		if found, err := idempotency.Load(ctx, tx, membership.GroupID, actor.UserID, key, hash, &result); err != nil || found {
			return err
		}
		created, err := createManualTransactionTx(ctx, tx, membership, normalized, storedAttachment)
		if err != nil {
			return err
		}
		if err := audit.Record(ctx, tx, membership.GroupID, actor.UserID, membership.ID, "external_account_transaction.created", "external_account_transaction", created.ID, map[string]any{"kind": created.Kind, "amountMinor": created.AmountMinor, "primaryAccountId": created.PrimaryAccountID}); err != nil {
			return err
		}
		result, err = getTransactionView(ctx, tx, membership.GroupID, created.ID)
		if err != nil {
			return err
		}
		return idempotency.Store(ctx, tx, membership.GroupID, actor.UserID, key, hash, 201, result)
	})
	if err != nil {
		s.cleanupTransactionAttachment(storedAttachment, attachmentCreated)
	}
	return result, err
}

// ReverseTransaction appends an idempotent exact inverse of one unreversed
// manual transaction. Payment-derived transactions remain in payment workflow.
func (s Service) ReverseTransaction(ctx context.Context, actor domain.Principal, membership domain.Membership, key, transactionID string, input ReverseInput) (TransactionView, error) {
	if err := requireManualAccess(ctx, s.DB, membership, domain.PermissionManageExternalAccounts); err != nil {
		return TransactionView{}, err
	}
	input.Reason = strings.TrimSpace(input.Reason)
	bookedAt := platform.Timestamp(platform.Now())
	if err := validateRequiredText("reason", input.Reason, 240); err != nil {
		return TransactionView{}, err
	}
	if err := idempotency.ValidateKey(key); err != nil {
		return TransactionView{}, err
	}
	payload := struct{ TransactionID, Reason string }{transactionID, input.Reason}
	hash, err := idempotency.Hash(payload)
	if err != nil {
		return TransactionView{}, err
	}
	var result TransactionView
	err = storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		if err := requireManualAccess(ctx, tx, membership, domain.PermissionManageExternalAccounts); err != nil {
			return err
		}
		if found, err := idempotency.Load(ctx, tx, membership.GroupID, actor.UserID, key, hash, &result); err != nil || found {
			return err
		}
		reversal, err := reverseTransactionTx(ctx, tx, membership, transactionID, bookedAt, input.Reason)
		if err != nil {
			return err
		}
		if err := audit.Record(ctx, tx, membership.GroupID, actor.UserID, membership.ID, "external_account_transaction.reversed", "external_account_transaction", transactionID, map[string]any{"reversalId": reversal.ID, "amountMinor": reversal.AmountMinor}); err != nil {
			return err
		}
		if err := restoreDeletedAccountsAfterReversalTx(ctx, tx, membership.GroupID, actor.UserID, membership.ID, reversal.PrimaryAccountID, reversal.CounterpartyAccountID); err != nil {
			return err
		}
		result, err = getTransactionView(ctx, tx, membership.GroupID, reversal.ID)
		if err != nil {
			return err
		}
		return idempotency.Store(ctx, tx, membership.GroupID, actor.UserID, key, hash, 201, result)
	})
	return result, err
}

// PostPaymentTx creates the external transaction and asset ledger leg for a
// linked payment method. It returns false without writing when the method is
// intentionally unlinked. The caller owns tx and posts the receivable leg.
func PostPaymentTx(ctx context.Context, tx *sql.Tx, groupID, actorMembershipID, paymentID, methodID string, amountMinor int64, bookedAt, reason, reference, note, periodID, createdAt string) (bool, error) {
	var accountID string
	err := tx.QueryRowContext(ctx, `SELECT coalesce(external_account_id,'') FROM group_payment_methods WHERE group_id=? AND id=?`, groupID, methodID).Scan(&accountID)
	if errors.Is(err, sql.ErrNoRows) {
		return false, domain.ValidationError{Field: "method", Message: "is not configured for the group"}
	}
	if err != nil {
		return false, err
	}
	if accountID == "" {
		return false, nil
	}
	var active int
	if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM external_accounts WHERE group_id=? AND id=? AND status='ACTIVE' AND deleted_at IS NULL`, groupID, accountID).Scan(&active); err != nil {
		return false, err
	}
	if active != 1 {
		return false, fmt.Errorf("%w: linked external account is not active", domain.ErrConflict)
	}
	transactionID, err := platform.NewID("ext")
	if err != nil {
		return false, err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO external_account_transactions(id,group_id,kind,primary_account_id,payment_id,amount_minor,booked_at,reason,reference,note,created_by_membership_id,created_at) VALUES(?,?,'PAYMENT',?,?,?,?,?,?,?,?,?)`, transactionID, groupID, accountID, paymentID, amountMinor, bookedAt, reason, nullable(reference), nullable(note), actorMembershipID, createdAt)
	if err != nil {
		return false, err
	}
	if err := insertExternalLedger(ctx, tx, groupID, periodID, accountID, transactionID, paymentID, "", amountMinor, reason, createdAt); err != nil {
		return false, err
	}
	return true, nil
}

// ReversePaymentTx appends the external reversal header and asset leg for a
// linked payment. It returns false for legacy or intentionally unlinked
// payments, allowing the finance service to retain GROUP_CASH behavior.
func ReversePaymentTx(ctx context.Context, tx *sql.Tx, groupID, actorUserID, actorMembershipID, paymentID, periodID, bookedAt, reason, createdAt string) (bool, error) {
	var originalID, accountID, originalLedgerID string
	var amount int64
	err := tx.QueryRowContext(ctx, `SELECT t.id,t.primary_account_id,t.amount_minor,l.id FROM external_account_transactions t JOIN ledger_entries l ON l.group_id=t.group_id AND l.external_transaction_id=t.id AND l.external_account_id=t.primary_account_id WHERE t.group_id=? AND t.payment_id=? AND t.kind='PAYMENT'`, groupID, paymentID).Scan(&originalID, &accountID, &amount, &originalLedgerID)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	transactionID, err := platform.NewID("ext")
	if err != nil {
		return false, err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO external_account_transactions(id,group_id,kind,primary_account_id,payment_id,amount_minor,booked_at,reason,reversal_of,created_by_membership_id,created_at) VALUES(?,?,'REVERSAL',?,?,?,?,?,?,?,?)`, transactionID, groupID, accountID, paymentID, -amount, bookedAt, reason, originalID, actorMembershipID, createdAt)
	if err != nil {
		return false, mapConstraintError(err, "transaction")
	}
	if err := insertExternalLedger(ctx, tx, groupID, periodID, accountID, transactionID, paymentID, originalLedgerID, -amount, reason, createdAt); err != nil {
		return false, err
	}
	if err := restoreDeletedAccountsAfterReversalTx(ctx, tx, groupID, actorUserID, actorMembershipID, accountID); err != nil {
		return false, err
	}
	return true, nil
}

// restoreDeletedAccountsAfterReversalTx restores historical account identities
// only when a reversal makes their exact ledger-derived balance non-zero. It
// keeps the account archived, advances the collection version once, and records
// one actor-attributed audit event per restored identity in the caller's tx.
func restoreDeletedAccountsAfterReversalTx(ctx context.Context, tx *sql.Tx, groupID, actorUserID, actorMembershipID string, accountIDs ...string) error {
	seen := make(map[string]struct{}, len(accountIDs))
	restored := 0
	now := platform.Timestamp(platform.Now())
	for _, accountID := range accountIDs {
		if accountID == "" {
			continue
		}
		if _, duplicate := seen[accountID]; duplicate {
			continue
		}
		seen[accountID] = struct{}{}
		var deletedAt sql.NullString
		var balanceMinor int64
		err := tx.QueryRowContext(ctx, `SELECT account.deleted_at,
			coalesce((SELECT sum(entry.amount_minor) FROM ledger_entries entry WHERE entry.group_id=account.group_id AND entry.external_account_id=account.id AND entry.account='EXTERNAL_ACCOUNT'),0)
			FROM external_accounts account WHERE account.group_id=? AND account.id=?`, groupID, accountID).Scan(&deletedAt, &balanceMinor)
		if err != nil {
			return err
		}
		if !deletedAt.Valid || balanceMinor == 0 {
			continue
		}
		changed, err := tx.ExecContext(ctx, `UPDATE external_accounts SET deleted_at=NULL,status='ARCHIVED',version=version+1,updated_at=?,updated_by_membership_id=? WHERE group_id=? AND id=? AND deleted_at IS NOT NULL`, now, actorMembershipID, groupID, accountID)
		if err != nil {
			return err
		}
		if count, _ := changed.RowsAffected(); count != 1 {
			return domain.ErrConflict
		}
		if err := audit.Record(ctx, tx, groupID, actorUserID, actorMembershipID, "external_account.restored_after_reversal", "external_account", accountID, map[string]any{"balanceMinor": balanceMinor}); err != nil {
			return err
		}
		restored++
	}
	if restored == 0 {
		return nil
	}
	_, err := tx.ExecContext(ctx, `UPDATE group_settings SET external_accounts_version=external_accounts_version+1,updated_at=? WHERE group_id=?`, now, groupID)
	return err
}

func createManualTransactionTx(ctx context.Context, tx *sql.Tx, membership domain.Membership, input normalizedTransactionInput, attachment *paymentattachments.Stored) (Transaction, error) {
	if err := requireActiveAccounts(ctx, tx, membership.GroupID, input.PrimaryAccountID, input.CounterpartyAccountID); err != nil {
		return Transaction{}, err
	}
	transactionID, err := platform.NewID("ext")
	if err != nil {
		return Transaction{}, err
	}
	now := platform.Timestamp(platform.Now())
	_, err = tx.ExecContext(ctx, `INSERT INTO external_account_transactions(id,group_id,kind,primary_account_id,counterparty_account_id,amount_minor,booked_at,reason,reference,note,created_by_membership_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, transactionID, membership.GroupID, input.Kind, input.PrimaryAccountID, input.CounterpartyAccountID, input.AmountMinor, input.BookedAt, input.Reason, nullable(input.Reference), nullable(input.Note), membership.ID, now)
	if err != nil {
		return Transaction{}, err
	}
	if attachment != nil {
		if _, err := tx.ExecContext(ctx, `INSERT INTO external_account_transaction_attachments(transaction_id,group_id,storage_key,original_filename,media_type,size_bytes,sha256,created_by_membership_id,created_at)
			VALUES(?,?,?,?,?,?,?,?,?)`, transactionID, membership.GroupID, attachment.StorageKey, attachment.FileName, attachment.MediaType, attachment.SizeBytes, attachment.SHA256, membership.ID, now); err != nil {
			return Transaction{}, err
		}
	}
	var periodID, currency string
	if err := tx.QueryRowContext(ctx, `SELECT p.id,g.currency FROM groups g JOIN periods p ON p.group_id=g.id AND p.status='OPEN' WHERE g.id=?`, membership.GroupID).Scan(&periodID, &currency); err != nil {
		return Transaction{}, err
	}
	if err := insertExternalLedger(ctx, tx, membership.GroupID, periodID, input.PrimaryAccountID, transactionID, "", "", input.AmountMinor, input.Reason, now); err != nil {
		return Transaction{}, err
	}
	if input.Kind == "TRANSFER" {
		if err := insertExternalLedger(ctx, tx, membership.GroupID, periodID, *input.CounterpartyAccountID, transactionID, "", "", -input.AmountMinor, input.Reason, now); err != nil {
			return Transaction{}, err
		}
	} else {
		if err := insertOffsetLedger(ctx, tx, membership.GroupID, periodID, transactionID, -input.AmountMinor, input.Reason, now); err != nil {
			return Transaction{}, err
		}
	}
	counterparty := ""
	if input.CounterpartyAccountID != nil {
		counterparty = *input.CounterpartyAccountID
	}
	return Transaction{ID: transactionID, GroupID: membership.GroupID, Kind: domain.ExternalAccountTransactionKind(input.Kind), PrimaryAccountID: input.PrimaryAccountID, CounterpartyAccountID: counterparty, AmountMinor: input.AmountMinor, Currency: currency, BookedAt: input.BookedAt, Reason: input.Reason, Reference: input.Reference, Note: input.Note, CreatedByMembershipID: membership.ID, CreatedAt: now}, nil
}

func (s Service) storeTransactionAttachment(upload *TransactionAttachmentUpload) (*paymentattachments.Stored, bool, func(), error) {
	if upload == nil {
		return nil, false, nil, nil
	}
	if upload.Reader == nil {
		return nil, false, nil, domain.ValidationError{Field: "attachment", Message: "is required"}
	}
	stored, created, release, err := s.Attachments.Save(upload.Reader, upload.FileName, upload.MaxBytes)
	if err != nil {
		return nil, false, nil, err
	}
	return &stored, created, release, nil
}

func transactionAttachmentHash(stored *paymentattachments.Stored) string {
	if stored == nil {
		return ""
	}
	return stored.SHA256
}

func (s Service) cleanupTransactionAttachment(stored *paymentattachments.Stored, created bool) {
	if !created || stored == nil {
		return
	}
	var references int64
	err := s.DB.QueryRowContext(context.Background(), `SELECT
		(SELECT count(*) FROM payment_attachments WHERE storage_key=?) +
		(SELECT count(*) FROM external_account_transaction_attachments WHERE storage_key=?)`, stored.StorageKey, stored.StorageKey).Scan(&references)
	if err == nil && references == 0 {
		_ = s.Attachments.Remove(stored.StorageKey)
	}
}

func reverseTransactionTx(ctx context.Context, tx *sql.Tx, membership domain.Membership, transactionID, bookedAt, reason string) (Transaction, error) {
	var original Transaction
	var counterparty, payment sql.NullString
	err := tx.QueryRowContext(ctx, `SELECT id,kind,primary_account_id,counterparty_account_id,payment_id,amount_minor FROM external_account_transactions WHERE id=? AND group_id=?`, transactionID, membership.GroupID).Scan(&original.ID, &original.Kind, &original.PrimaryAccountID, &counterparty, &payment, &original.AmountMinor)
	if errors.Is(err, sql.ErrNoRows) {
		return Transaction{}, domain.ErrNotFound
	}
	if err != nil {
		return Transaction{}, err
	}
	if original.Kind == "PAYMENT" || original.Kind == "REVERSAL" {
		return Transaction{}, fmt.Errorf("%w: payment-derived or reversal transactions cannot be manually reversed", domain.ErrConflict)
	}
	original.CounterpartyAccountID = counterparty.String
	original.PaymentID = payment.String
	var already int
	if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM external_account_transactions WHERE group_id=? AND reversal_of=?`, membership.GroupID, transactionID).Scan(&already); err != nil {
		return Transaction{}, err
	}
	if already != 0 {
		return Transaction{}, fmt.Errorf("%w: transaction is already reversed", domain.ErrConflict)
	}
	var reversalPeriodID, currency string
	if err := tx.QueryRowContext(ctx, `SELECT p.id,g.currency FROM groups g JOIN periods p ON p.group_id=g.id AND p.status='OPEN' WHERE g.id=?`, membership.GroupID).Scan(&reversalPeriodID, &currency); err != nil {
		return Transaction{}, err
	}
	reversalID, err := platform.NewID("ext")
	if err != nil {
		return Transaction{}, err
	}
	now := platform.Timestamp(platform.Now())
	_, err = tx.ExecContext(ctx, `INSERT INTO external_account_transactions(id,group_id,kind,primary_account_id,counterparty_account_id,payment_id,amount_minor,booked_at,reason,reversal_of,created_by_membership_id,created_at) VALUES(?,?,'REVERSAL',?,?,?,?,?,?,?,?,?)`, reversalID, membership.GroupID, original.PrimaryAccountID, nullable(original.CounterpartyAccountID), nullable(original.PaymentID), -original.AmountMinor, bookedAt, reason, transactionID, membership.ID, now)
	if err != nil {
		return Transaction{}, mapConstraintError(err, "transaction")
	}
	rows, err := tx.QueryContext(ctx, `SELECT id,external_account_id,amount_minor,description FROM ledger_entries WHERE group_id=? AND external_transaction_id=? AND reversal_of IS NULL`, membership.GroupID, transactionID)
	if err != nil {
		return Transaction{}, err
	}
	type leg struct {
		id, account, description string
		amount                   int64
	}
	var legs []leg
	for rows.Next() {
		var item leg
		var account sql.NullString
		if err := rows.Scan(&item.id, &account, &item.amount, &item.description); err != nil {
			rows.Close()
			return Transaction{}, err
		}
		item.account = account.String
		legs = append(legs, item)
	}
	if err := rows.Close(); err != nil {
		return Transaction{}, err
	}
	for _, item := range legs {
		if item.account != "" {
			err = insertExternalLedger(ctx, tx, membership.GroupID, reversalPeriodID, item.account, reversalID, "", item.id, -item.amount, "Reversal: "+item.description, now)
		} else {
			err = insertOffsetLedgerReversal(ctx, tx, membership.GroupID, reversalPeriodID, reversalID, item.id, -item.amount, "Reversal: "+item.description, now)
		}
		if err != nil {
			return Transaction{}, err
		}
	}
	return Transaction{ID: reversalID, GroupID: membership.GroupID, Kind: domain.ExternalAccountTransactionReversal, PrimaryAccountID: original.PrimaryAccountID, CounterpartyAccountID: original.CounterpartyAccountID, PaymentID: original.PaymentID, AmountMinor: -original.AmountMinor, Currency: currency, BookedAt: bookedAt, Reason: reason, ReversalOf: transactionID, CreatedByMembershipID: membership.ID, CreatedAt: now}, nil
}
