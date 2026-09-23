package groups

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"reflect"
	"strings"

	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/platform"
)

// resolvePaymentMethodAccountLinks translates the legacy paymentTarget contract
// into the single stored external-account relationship. It may create or update
// an account for legacy clients and increments the account collection version
// once when any link or account configuration changes.
func resolvePaymentMethodAccountLinks(ctx context.Context, tx *sql.Tx, groupID, actorMembershipID string, previous, next []domain.PaymentMethod, targetsSpecified, accountIDsSpecified []bool, currency string) ([]domain.PaymentMethod, error) {
	if accountIDsSpecified != nil && len(accountIDsSpecified) != len(next) {
		return nil, domain.ValidationError{Field: "paymentMethods", Message: "has inconsistent externalAccountId presence metadata"}
	}
	previousByID := make(map[string]domain.PaymentMethod, len(previous))
	for _, method := range previous {
		previousByID[method.ID] = method
	}
	nextIDs := make(map[string]struct{}, len(next))
	changed := len(previous) != len(next)
	for index := range next {
		method := &next[index]
		if index >= len(previous) || previous[index].ID != method.ID {
			changed = true
		}
		nextIDs[method.ID] = struct{}{}
		previousMethod := previousByID[method.ID]
		targetSpecified := targetsSpecified == nil || targetsSpecified[index]
		accountSpecified := method.ExternalAccountID != nil
		if accountIDsSpecified != nil {
			accountSpecified = accountIDsSpecified[index]
		}
		if !accountSpecified && !targetSpecified {
			method.ExternalAccountID = cloneOptionalString(previousMethod.ExternalAccountID)
			method.PaymentTarget = clonePaymentTarget(previousMethod.PaymentTarget)
			continue
		}
		if accountSpecified {
			if method.ExternalAccountID == nil || strings.TrimSpace(*method.ExternalAccountID) == "" {
				if targetSpecified && method.PaymentTarget != nil {
					return nil, domain.ValidationError{Field: "paymentMethods", Message: "cannot combine a cleared externalAccountId with a paymentTarget"}
				}
				method.ExternalAccountID = nil
				method.PaymentTarget = nil
			} else {
				accountID := strings.TrimSpace(*method.ExternalAccountID)
				accountTarget, err := paymentTargetForAccount(ctx, tx, groupID, accountID, true)
				if err != nil {
					return nil, err
				}
				if targetSpecified && !reflect.DeepEqual(method.PaymentTarget, accountTarget) {
					return nil, domain.ValidationError{Field: "paymentMethods", Message: "contains a paymentTarget that does not match externalAccountId"}
				}
				method.ExternalAccountID = &accountID
				method.PaymentTarget = accountTarget
			}
		} else if method.PaymentTarget == nil {
			method.ExternalAccountID = nil
		} else {
			accountID, err := resolveLegacyPaymentTarget(ctx, tx, groupID, actorMembershipID, *method, previousMethod, currency)
			if err != nil {
				return nil, err
			}
			method.ExternalAccountID = &accountID
		}
		if !optionalStringsEqual(previousMethod.ExternalAccountID, method.ExternalAccountID) ||
			!reflect.DeepEqual(previousMethod.PaymentTarget, method.PaymentTarget) {
			changed = true
		}
	}
	for _, previousMethod := range previous {
		if _, retained := nextIDs[previousMethod.ID]; !retained {
			changed = true
		}
	}
	if changed {
		if _, err := tx.ExecContext(ctx, `UPDATE group_settings SET external_accounts_version=external_accounts_version+1 WHERE group_id=?`, groupID); err != nil {
			return nil, err
		}
	}
	return next, nil
}

func resolveLegacyPaymentTarget(ctx context.Context, tx *sql.Tx, groupID, actorMembershipID string, method, previous domain.PaymentMethod, currency string) (string, error) {
	normalized, err := normalizePaymentTarget(method.PaymentTarget, currency)
	if err != nil {
		return "", err
	}
	if normalized == nil {
		return "", domain.ValidationError{Field: "paymentMethods", Message: "contains an empty legacy paymentTarget"}
	}
	accountType, handle, recipient, iban, bic := accountValuesForPaymentTarget(*normalized)
	var matchingID, matchingStatus string
	err = tx.QueryRowContext(ctx, `SELECT id,status FROM external_accounts WHERE group_id=? AND deleted_at IS NULL AND (
		(?='PAYPAL' AND type='PAYPAL' AND lower(paypal_me_handle)=lower(?)) OR
		(?='BANK' AND type='BANK' AND sepa_iban=? AND sepa_recipient_name=? AND coalesce(sepa_bic,'')=?)) LIMIT 1`,
		groupID, accountType, handle, accountType, iban, recipient, bic).Scan(&matchingID, &matchingStatus)
	if err == nil {
		if matchingStatus != string(domain.ExternalAccountActive) {
			return "", fmt.Errorf("%w: matching external account must be reactivated before linking", domain.ErrConflict)
		}
		return matchingID, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	if previous.ExternalAccountID != nil {
		currentID := *previous.ExternalAccountID
		var currentType string
		var linkCount, ledgerCount int
		err = tx.QueryRowContext(ctx, `SELECT account.type,
			(SELECT count(*) FROM group_payment_methods linked WHERE linked.group_id=account.group_id AND linked.external_account_id=account.id),
			(SELECT count(*) FROM ledger_entries entry WHERE entry.group_id=account.group_id AND entry.external_account_id=account.id)
			FROM external_accounts account WHERE account.group_id=? AND account.id=? AND account.status='ACTIVE' AND account.deleted_at IS NULL`, groupID, currentID).
			Scan(&currentType, &linkCount, &ledgerCount)
		if err == nil && linkCount == 1 && ledgerCount == 0 {
			now := platform.Timestamp(platform.Now())
			if _, err := tx.ExecContext(ctx, `UPDATE external_accounts SET type=?,paypal_me_handle=nullif(?,''),sepa_recipient_name=nullif(?,''),sepa_iban=nullif(?,''),sepa_bic=nullif(?,''),version=version+1,updated_at=?,updated_by_membership_id=? WHERE group_id=? AND id=?`,
				accountType, handle, recipient, iban, bic, now, actorMembershipID, groupID, currentID); err != nil {
				return "", err
			}
			return currentID, nil
		}
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return "", err
		}
	}
	name, err := availableExternalAccountName(ctx, tx, groupID, method.Label)
	if err != nil {
		return "", err
	}
	var sortOrder int
	if err := tx.QueryRowContext(ctx, `SELECT coalesce(max(sort_order),-1)+1 FROM external_accounts WHERE group_id=?`, groupID).Scan(&sortOrder); err != nil {
		return "", err
	}
	accountID, err := platform.NewID("ext")
	if err != nil {
		return "", err
	}
	now := platform.Timestamp(platform.Now())
	if _, err := tx.ExecContext(ctx, `INSERT INTO external_accounts(id,group_id,name,type,status,sort_order,paypal_me_handle,sepa_recipient_name,sepa_iban,sepa_bic,version,created_at,updated_at,created_by_membership_id,updated_by_membership_id)
		VALUES(?,?,?,?,'ACTIVE',?,nullif(?,''),nullif(?,''),nullif(?,''),nullif(?,''),1,?,?,?,?)`,
		accountID, groupID, name, accountType, sortOrder, handle, recipient, iban, bic, now, now, actorMembershipID, actorMembershipID); err != nil {
		return "", err
	}
	return accountID, nil
}

func paymentTargetForAccount(ctx context.Context, tx *sql.Tx, groupID, accountID string, requireActive bool) (*domain.PaymentTarget, error) {
	query := `SELECT type,paypal_me_handle,sepa_recipient_name,sepa_iban,sepa_bic,status FROM external_accounts WHERE group_id=? AND id=? AND deleted_at IS NULL`
	var accountType, status string
	var handle, recipient, iban, bic sql.NullString
	if err := tx.QueryRowContext(ctx, query, groupID, accountID).Scan(&accountType, &handle, &recipient, &iban, &bic, &status); errors.Is(err, sql.ErrNoRows) {
		return nil, domain.ErrNotFound
	} else if err != nil {
		return nil, err
	}
	if requireActive && status != string(domain.ExternalAccountActive) {
		return nil, fmt.Errorf("%w: payment methods can link only active external accounts", domain.ErrConflict)
	}
	switch domain.ExternalAccountType(accountType) {
	case domain.ExternalAccountPayPal:
		return &domain.PaymentTarget{Type: domain.PaymentTargetPayPalMe, PayPalMeHandle: handle.String}, nil
	case domain.ExternalAccountBank:
		return &domain.PaymentTarget{Type: domain.PaymentTargetSEPATransfer, RecipientName: recipient.String, IBAN: iban.String, BIC: bic.String}, nil
	case domain.ExternalAccountCash, domain.ExternalAccountOther:
		return nil, nil
	default:
		return nil, fmt.Errorf("external account %s has unsupported type %q", accountID, accountType)
	}
}

func accountValuesForPaymentTarget(target domain.PaymentTarget) (accountType, handle, recipient, iban, bic string) {
	if target.Type == domain.PaymentTargetPayPalMe {
		return string(domain.ExternalAccountPayPal), target.PayPalMeHandle, "", "", ""
	}
	return string(domain.ExternalAccountBank), "", target.RecipientName, target.IBAN, target.BIC
}

func availableExternalAccountName(ctx context.Context, tx *sql.Tx, groupID, base string) (string, error) {
	for suffix := 1; suffix <= 1000; suffix++ {
		baseRunes := []rune(strings.TrimSpace(base))
		suffixText := ""
		if suffix > 1 {
			suffixText = fmt.Sprintf(" (%d)", suffix)
		}
		maximumBaseRunes := 120 - len([]rune(suffixText))
		if len(baseRunes) > maximumBaseRunes {
			baseRunes = baseRunes[:maximumBaseRunes]
		}
		candidate := string(baseRunes) + suffixText
		var exists bool
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM external_accounts WHERE group_id=? AND name=? COLLATE NOCASE)`, groupID, candidate).Scan(&exists); err != nil {
			return "", err
		}
		if !exists {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("%w: no unique external account name is available", domain.ErrConflict)
}

func cloneOptionalString(value *string) *string {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func clonePaymentTarget(value *domain.PaymentTarget) *domain.PaymentTarget {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func optionalStringsEqual(left, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}
