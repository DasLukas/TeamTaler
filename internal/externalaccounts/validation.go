package externalaccounts

import (
	"fmt"
	"strings"
	"time"

	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/paymenttargets"
)

func normalizeAccountInput(input AccountInput, currency string) (AccountInput, error) {
	input.Name = strings.TrimSpace(input.Name)
	input.Type = strings.ToUpper(strings.TrimSpace(input.Type))
	input.PayPalMeHandle = strings.TrimSpace(input.PayPalMeHandle)
	input.SEPARecipientName = strings.TrimSpace(input.SEPARecipientName)
	input.SEPAIBAN = paymenttargets.NormalizeIBAN(input.SEPAIBAN)
	input.SEPABIC = strings.ToUpper(strings.TrimSpace(input.SEPABIC))
	if err := validateRequiredText("name", input.Name, 120); err != nil {
		return AccountInput{}, err
	}
	switch input.Type {
	case accountTypeCash, accountTypeOther:
		if input.PayPalMeHandle != "" || input.SEPARecipientName != "" || input.SEPAIBAN != "" || input.SEPABIC != "" {
			return AccountInput{}, domain.ValidationError{Field: "type", Message: "does not accept provider details"}
		}
	case accountTypePayPal:
		handle, err := paymenttargets.NormalizePayPalMeHandle(input.PayPalMeHandle)
		if err != nil {
			return AccountInput{}, domain.ValidationError{Field: "paypalMeHandle", Message: "must contain a valid PayPal.Me handle"}
		}
		input.PayPalMeHandle = handle
		if input.SEPARecipientName != "" || input.SEPAIBAN != "" || input.SEPABIC != "" {
			return AccountInput{}, domain.ValidationError{Field: "type", Message: "contains fields for another provider"}
		}
	case accountTypeBank:
		if currency != "EUR" {
			return AccountInput{}, domain.ValidationError{Field: "type", Message: "BANK accounts require an EUR group"}
		}
		if err := validateRequiredText("sepaRecipientName", input.SEPARecipientName, 70); err != nil {
			return AccountInput{}, err
		}
		if !paymenttargets.ValidIBAN(input.SEPAIBAN) {
			return AccountInput{}, domain.ValidationError{Field: "sepaIban", Message: "must be a checksum-valid IBAN"}
		}
		if input.SEPABIC != "" && !paymenttargets.ValidBIC(input.SEPABIC) {
			return AccountInput{}, domain.ValidationError{Field: "sepaBic", Message: "must be a valid 8 or 11 character BIC"}
		}
		if input.SEPABIC == "" && paymenttargets.IBANRequiresBIC(input.SEPAIBAN) {
			return AccountInput{}, domain.ValidationError{Field: "sepaBic", Message: "is required for a non-EEA IBAN"}
		}
		if input.PayPalMeHandle != "" {
			return AccountInput{}, domain.ValidationError{Field: "type", Message: "contains fields for another provider"}
		}
	default:
		return AccountInput{}, domain.ValidationError{Field: "type", Message: "must be CASH, BANK, PAYPAL, or OTHER"}
	}
	return input, nil
}

func maskProviderDetails(account *domain.ExternalAccount) {
	if account.PayPalMeHandle != "" {
		account.PayPalMeHandle = "••••"
	}
	if account.SEPARecipientName != "" {
		account.SEPARecipientName = "••••"
	}
	if account.SEPAIBAN != "" {
		last := account.SEPAIBAN
		if len(last) > 4 {
			last = last[len(last)-4:]
		}
		account.SEPAIBAN = "••••" + last
	}
	if account.SEPABIC != "" {
		account.SEPABIC = "••••"
	}
}

func preserveMaskedProviderDetails(input, previous AccountInput) AccountInput {
	if input.Type != previous.Type {
		return input
	}
	if input.PayPalMeHandle == "••••" {
		input.PayPalMeHandle = previous.PayPalMeHandle
	}
	if input.SEPARecipientName == "••••" {
		input.SEPARecipientName = previous.SEPARecipientName
	}
	maskedIBAN := previous.SEPAIBAN
	if len(maskedIBAN) > 4 {
		maskedIBAN = maskedIBAN[len(maskedIBAN)-4:]
	}
	if input.SEPAIBAN == "••••"+maskedIBAN {
		input.SEPAIBAN = previous.SEPAIBAN
	}
	if input.SEPABIC == "••••" {
		input.SEPABIC = previous.SEPABIC
	}
	return input
}
func normalizeTransactionInput(input CreateTransactionInput) (normalizedTransactionInput, error) {
	input.Kind = strings.ToUpper(strings.TrimSpace(input.Kind))
	input.SourceAccountID = strings.TrimSpace(input.SourceAccountID)
	input.DestinationAccountID = strings.TrimSpace(input.DestinationAccountID)
	input.Reason = strings.TrimSpace(input.Reason)
	input.Reference = strings.TrimSpace(input.Reference)
	input.Note = strings.TrimSpace(input.Note)
	bookedAt, err := normalizeBookedAt(input.OccurredAt)
	if err != nil {
		return normalizedTransactionInput{}, err
	}
	if input.AmountMinor <= 0 || input.AmountMinor > 100_000_000_000_000 {
		return normalizedTransactionInput{}, domain.ValidationError{Field: "amountMinor", Message: "must be a positive bounded minor-unit amount"}
	}
	if err := validateRequiredText("reason", input.Reason, 120); err != nil {
		return normalizedTransactionInput{}, err
	}
	if len(input.Reference) > 120 {
		return normalizedTransactionInput{}, domain.ValidationError{Field: "reference", Message: "must contain at most 120 characters"}
	}
	if len(input.Note) > 2000 {
		return normalizedTransactionInput{}, domain.ValidationError{Field: "note", Message: "must contain at most 2000 characters"}
	}
	normalized := normalizedTransactionInput{Kind: input.Kind, BookedAt: bookedAt, Reason: input.Reason, Reference: input.Reference, Note: input.Note}
	switch input.Kind {
	case "INCOME":
		if input.SourceAccountID != "" || input.DestinationAccountID == "" {
			return normalizedTransactionInput{}, domain.ValidationError{Field: "destinationAccountId", Message: "income requires only a destination account"}
		}
		normalized.PrimaryAccountID, normalized.AmountMinor = input.DestinationAccountID, input.AmountMinor
	case "EXPENSE":
		if input.SourceAccountID == "" || input.DestinationAccountID != "" {
			return normalizedTransactionInput{}, domain.ValidationError{Field: "sourceAccountId", Message: "expense requires only a source account"}
		}
		normalized.PrimaryAccountID, normalized.AmountMinor = input.SourceAccountID, -input.AmountMinor
	case "TRANSFER":
		if input.SourceAccountID == "" || input.DestinationAccountID == "" || input.SourceAccountID == input.DestinationAccountID {
			return normalizedTransactionInput{}, domain.ValidationError{Field: "destinationAccountId", Message: "transfer requires distinct source and destination accounts"}
		}
		normalized.PrimaryAccountID, normalized.AmountMinor = input.SourceAccountID, -input.AmountMinor
		destination := input.DestinationAccountID
		normalized.CounterpartyAccountID = &destination
	default:
		return normalizedTransactionInput{}, domain.ValidationError{Field: "kind", Message: "must be INCOME, EXPENSE, or TRANSFER"}
	}
	return normalized, nil
}
func normalizeBookedAt(value string) (string, error) {
	value = strings.TrimSpace(value)
	if parsed, err := time.Parse("2006-01-02", value); err == nil {
		return parsed.UTC().Format(time.RFC3339), nil
	}
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return "", domain.ValidationError{Field: "occurredAt", Message: "must be an RFC 3339 timestamp or YYYY-MM-DD date"}
	}
	return parsed.UTC().Format(time.RFC3339Nano), nil
}
func validateRequiredText(field, value string, max int) error {
	if value == "" || len(value) > max || strings.IndexFunc(value, func(r rune) bool { return r < 32 || r == 127 }) >= 0 {
		return domain.ValidationError{Field: field, Message: fmt.Sprintf("must contain 1 to %d plain-text characters", max)}
	}
	return nil
}
func validStoredKind(kind string) bool {
	switch kind {
	case "PAYMENT", "OPENING_BALANCE", "INCOME", "EXPENSE", "TRANSFER", "ADJUSTMENT", "REVERSAL":
		return true
	}
	return false
}
func transactionSortExpression(sort string) string {
	switch sort {
	case "amount":
		return "t.amount_minor"
	case "kind":
		return "lower(t.kind)"
	case "actorName":
		return "lower(actor_user.display_name)"
	case "status":
		return "EXISTS(SELECT 1 FROM external_account_transactions reversal WHERE reversal.group_id=t.group_id AND reversal.reversal_of=t.id)"
	default:
		return "strftime('%Y-%m-%dT%H:%M:%fZ',t.booked_at)"
	}
}
