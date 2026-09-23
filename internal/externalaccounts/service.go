// Package externalaccounts manages group-owned representations of external
// cash, bank, PayPal, and other accounts and their append-only movements.
package externalaccounts

import (
	"context"
	"database/sql"

	"github.com/DasLukas/TeamTaler/internal/authorization"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/paymentattachments"
)

// ErrDisabled indicates that manual external-account access is disabled for
// the group. Automatic postings from already-linked payment methods do not use
// this error because they deliberately continue across feature toggles.
var ErrDisabled = domain.ErrExternalAccountsDisabled

const (
	accountTypeCash   = "CASH"
	accountTypeBank   = "BANK"
	accountTypePayPal = "PAYPAL"
	accountTypeOther  = "OTHER"
	statusActive      = "ACTIVE"
	statusArchived    = "ARCHIVED"
)

// Account is the canonical domain representation of one external account.
type Account = domain.ExternalAccount

// AccountCollection is a consistent external-account configuration snapshot.
// Version is the collection precondition used by every configuration mutation.
type AccountCollection struct {
	Items   []domain.ExternalAccount `json:"items"`
	Version int64                    `json:"version"`
}

// AccountInput contains the editable fields for an external account.
type AccountInput struct {
	Name              string `json:"name"`
	Type              string `json:"type"`
	PayPalMeHandle    string `json:"paypalMeHandle,omitempty"`
	SEPARecipientName string `json:"sepaRecipientName,omitempty"`
	SEPAIBAN          string `json:"sepaIban,omitempty"`
	SEPABIC           string `json:"sepaBic,omitempty"`
}

// OpeningBalanceInput describes the optional, atomic first movement created
// with a new account. AmountMinor is signed and must be non-zero.
type OpeningBalanceInput struct {
	AmountMinor int64  `json:"amountMinor"`
	OccurredAt  string `json:"occurredAt"`
	Reason      string `json:"reason"`
	Reference   string `json:"reference,omitempty"`
	Note        string `json:"note,omitempty"`
}

// CreateAccountInput combines account configuration with an optional opening
// balance that commits or rolls back with the account.
type CreateAccountInput struct {
	AccountInput
	OpeningBalance *OpeningBalanceInput `json:"openingBalance,omitempty"`
}

// PaymentMethodLink maps one configured payment method to at most one account.
type PaymentMethodLink struct {
	PaymentMethodID   string  `json:"paymentMethodId"`
	ExternalAccountID *string `json:"externalAccountId"`
}

// ReplaceLinksInput is the complete, atomic payment-method mapping.
type ReplaceLinksInput struct {
	Links []PaymentMethodLink `json:"links"`
}

// PaymentMethodLinkCollection is the versioned, complete mapping returned by
// link reads and replacements.
type PaymentMethodLinkCollection struct {
	Links   []PaymentMethodLink `json:"links"`
	Version int64               `json:"version"`
}

// Transaction is the canonical domain representation of one immutable
// external-account movement header.
type Transaction = domain.ExternalAccountTransaction

// TransactionAttachmentUpload is one untrusted attachment stream supplied
// with a manual external-account transaction command.
type TransactionAttachmentUpload = paymentattachments.Upload

// CreateTransactionInput describes a manual movement. TRANSFER requires a
// negative source delta and a distinct active counterparty account.
type CreateTransactionInput struct {
	Kind                 string `json:"kind"`
	SourceAccountID      string `json:"sourceAccountId,omitempty"`
	DestinationAccountID string `json:"destinationAccountId,omitempty"`
	AmountMinor          int64  `json:"amountMinor"`
	OccurredAt           string `json:"occurredAt"`
	Reason               string `json:"reason"`
	Reference            string `json:"reference,omitempty"`
	Note                 string `json:"note,omitempty"`
}

// ReverseInput supplies the effective date and required explanation for a
// manual reversal.
type ReverseInput struct {
	Reason string `json:"reason"`
}

type normalizedTransactionInput struct {
	Kind                  string
	PrimaryAccountID      string
	CounterpartyAccountID *string
	AmountMinor           int64
	BookedAt              string
	Reason                string
	Reference             string
	Note                  string
}

// AccountReference is the privacy-minimized account identity embedded in a
// transaction history row.
type AccountReference struct {
	ID   string                     `json:"id"`
	Name string                     `json:"name"`
	Type domain.ExternalAccountType `json:"type"`
}

// TransactionActor is the membership identity that recorded a transaction.
type TransactionActor struct {
	ID          string `json:"id"`
	DisplayName string `json:"displayName"`
	AvatarURL   string `json:"avatarUrl,omitempty"`
}

// TransactionImpact identifies one signed external-account balance change.
type TransactionImpact struct {
	Account     AccountReference `json:"account"`
	AmountMinor int64            `json:"amountMinor,string"`
}

// TransactionView is the permission-scoped history representation consumed by
// the interactive table and table exports.
type TransactionView struct {
	domain.ExternalAccountTransaction
	Attachment         *domain.PaymentAttachmentSummary `json:"attachment,omitempty"`
	Source             string                           `json:"source"`
	OccurredAt         string                           `json:"occurredAt"`
	SourceAccount      *AccountReference                `json:"sourceAccount,omitempty"`
	DestinationAccount *AccountReference                `json:"destinationAccount,omitempty"`
	Actor              TransactionActor                 `json:"actor"`
	Impacts            []TransactionImpact              `json:"impacts"`
	Status             string                           `json:"status"`
	ReversalOfID       string                           `json:"reversalOfId,omitempty"`
	ReplacementForID   string                           `json:"replacementForId,omitempty"`
	ReversedByID       string                           `json:"reversedById,omitempty"`
	ReplacementID      string                           `json:"replacementId,omitempty"`
	CanReverse         bool                             `json:"canReverse"`
}

// TransactionQuery controls a bounded external-account history query.
type TransactionQuery struct {
	TransactionID string
	Search        string
	AccountIDs    []string
	Kinds         []string
	Source        string
	Status        string
	OccurredFrom  string
	OccurredTo    string
	AmountMin     *int64
	AmountMax     *int64
	Sort          string
	Direction     string
	Cursor        string
	Limit         int
}

// TransactionPage is one stable keyset-paginated history slice.
type TransactionPage struct {
	Items      []TransactionView
	NextCursor string
}

// Service manages external account configuration and manual movements.
type Service struct {
	DB          *sql.DB
	Attachments paymentattachments.Store
}

type dataQueryer interface {
	authorization.Queryer
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

// AuthorizeManagement verifies the live feature flag and management grant
// before a transport parses mutation-specific preconditions or payloads. Each
// write method rechecks these invariants in its transaction so concurrent
// permission or feature changes cannot bypass authorization.
//
// Parameters:
//   - ctx: request context used for authorization and settings queries.
//   - membership: authenticated group membership to authorize.
//
// Returns nil when external accounts are enabled and the membership has
// MANAGE_EXTERNAL_ACCOUNTS. Otherwise it returns the canonical authorization,
// not-found, or disabled-feature error.
func (s Service) AuthorizeManagement(ctx context.Context, membership domain.Membership) error {
	return requireManualAccess(ctx, s.DB, membership, domain.PermissionManageExternalAccounts)
}
