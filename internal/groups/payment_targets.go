package groups

import (
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/paymenttargets"
)

// normalizePaymentTarget validates and canonicalizes target for one group
// currency. A nil target remains nil. PayPal.Me inputs become handles; SEPA
// inputs become normalized account fields and require EUR. The function returns
// a validation error for unknown types, mismatched fields, or invalid recipient
// data and never performs a network lookup.
func normalizePaymentTarget(target *domain.PaymentTarget, currency string) (*domain.PaymentTarget, error) {
	return paymenttargets.NormalizeForField(target, currency, "paymentMethods")
}

// normalizePayPalMeHandle accepts a bare handle or a canonical PayPal.Me HTTPS
// URL and returns only its case-preserving ASCII-alphanumeric handle. It rejects
// redirect-capable URL features, amount suffixes, and non-PayPal hosts with a
// paymentMethods validation error.
func normalizePayPalMeHandle(value string) (string, error) {
	return paymenttargets.NormalizePayPalMeHandle(value)
}

// normalizeIBAN removes Unicode whitespace and uppercases the remaining IBAN
// characters. It returns a deterministic local representation and cannot fail.
func normalizeIBAN(value string) string {
	return paymenttargets.NormalizeIBAN(value)
}

// validIBAN checks the generic IBAN shape and ISO 13616 MOD-97 checksum. It
// returns false for malformed or checksum-invalid values and does not establish
// that an account exists or participates in SEPA.
func validIBAN(value string) bool {
	return paymenttargets.ValidIBAN(value)
}

// ibanRequiresBIC reports whether the normalized IBAN belongs to a country
// outside the European Economic Area. EPC payment instructions may omit BICs
// only for EEA IBANs. Malformed values return true defensively and are rejected
// separately by validIBAN.
func ibanRequiresBIC(value string) bool {
	return paymenttargets.IBANRequiresBIC(value)
}

// paymentTargetCount returns the number of methods with a configured external
// payment target. It is used only for redacted settings audit metadata and
// cannot fail.
func paymentTargetCount(methods []domain.PaymentMethod) int {
	count := 0
	for _, method := range methods {
		if method.PaymentTarget != nil {
			count++
		}
	}
	return count
}

// paymentTargetTypeCounts returns redacted per-type counts for configured
// payment targets. It never includes handles or bank-account fields and cannot
// fail.
func paymentTargetTypeCounts(methods []domain.PaymentMethod) map[string]int {
	counts := make(map[string]int)
	for _, method := range methods {
		if method.PaymentTarget != nil {
			counts[string(method.PaymentTarget.Type)]++
		}
	}
	return counts
}
