package externalaccounts

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/DasLukas/TeamTaler/internal/domain"
)

// TransactionAttachment identifies one authorized immutable attachment.
// Path is internal trusted storage metadata and must never be serialized.
type TransactionAttachment struct {
	FileName  string
	MediaType string
	SizeBytes int64
	Path      string
}

// GetTransactionAttachment returns a manual transaction attachment after live
// feature and view-permission checks. Cross-group and missing records are
// intentionally indistinguishable.
func (s Service) GetTransactionAttachment(ctx context.Context, membership domain.Membership, transactionID string) (TransactionAttachment, error) {
	if err := requireManualAccess(ctx, s.DB, membership, domain.PermissionViewExternalAccounts); err != nil {
		return TransactionAttachment{}, err
	}
	transactionID = strings.TrimSpace(transactionID)
	if transactionID == "" {
		return TransactionAttachment{}, domain.ErrNotFound
	}
	var storageKey string
	var item TransactionAttachment
	err := s.DB.QueryRowContext(ctx, `SELECT attachment.storage_key,attachment.original_filename,attachment.media_type,attachment.size_bytes
		FROM external_account_transaction_attachments attachment
		JOIN external_account_transactions transaction_record ON transaction_record.group_id=attachment.group_id AND transaction_record.id=attachment.transaction_id
		WHERE attachment.group_id=? AND attachment.transaction_id=?`, membership.GroupID, transactionID).
		Scan(&storageKey, &item.FileName, &item.MediaType, &item.SizeBytes)
	if errors.Is(err, sql.ErrNoRows) {
		return TransactionAttachment{}, domain.ErrNotFound
	}
	if err != nil {
		return TransactionAttachment{}, err
	}
	item.Path, err = s.Attachments.Resolve(storageKey)
	if err != nil {
		return TransactionAttachment{}, fmt.Errorf("resolve external account transaction attachment: %w", err)
	}
	return item, nil
}

func transactionAttachmentURL(groupID, transactionID string) string {
	return "/api/v1/groups/" + groupID + "/external-account-transactions/" + transactionID + "/attachment"
}
