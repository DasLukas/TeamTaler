package groups

import (
	"net/url"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/DasLukas/TeamTaler/internal/domain"
)

var (
	payPalMeHandlePattern = regexp.MustCompile(`^[A-Za-z0-9]{1,20}$`)
	ibanPattern           = regexp.MustCompile(`^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$`)
	bicPattern            = regexp.MustCompile(`^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$`)
	eeaIBANCountries      = map[string]struct{}{
		"AT": {}, "BE": {}, "BG": {}, "HR": {}, "CY": {}, "CZ": {}, "DK": {}, "EE": {}, "FI": {}, "FR": {},
		"DE": {}, "GR": {}, "HU": {}, "IS": {}, "IE": {}, "IT": {}, "LV": {}, "LI": {}, "LT": {}, "LU": {},
		"MT": {}, "NL": {}, "NO": {}, "PL": {}, "PT": {}, "RO": {}, "SK": {}, "SI": {}, "ES": {}, "SE": {},
	}
)

// normalizePaymentTarget validates and canonicalizes target for one group
// currency. A nil target remains nil. PayPal.Me inputs become handles; SEPA
// inputs become normalized account fields and require EUR. The function returns
// a validation error for unknown types, mismatched fields, or invalid recipient
// data and never performs a network lookup.
func normalizePaymentTarget(target *domain.PaymentTarget, currency string) (*domain.PaymentTarget, error) {
	if target == nil {
		return nil, nil
	}
	normalized := *target
	if utf8.RuneCountInString(normalized.PayPalMeHandle) > 120 || utf8.RuneCountInString(normalized.RecipientName) > 70 ||
		utf8.RuneCountInString(normalized.IBAN) > 42 || utf8.RuneCountInString(normalized.BIC) > 14 {
		return nil, domain.ValidationError{Field: "paymentMethods", Message: "contains an overlong paymentTarget field"}
	}
	for _, value := range []string{normalized.PayPalMeHandle, normalized.RecipientName, normalized.IBAN, normalized.BIC} {
		if containsControlCharacter(value) {
			return nil, domain.ValidationError{Field: "paymentMethods", Message: "contains control characters in a paymentTarget"}
		}
	}
	switch normalized.Type {
	case domain.PaymentTargetPayPalMe:
		if strings.TrimSpace(normalized.RecipientName) != "" || strings.TrimSpace(normalized.IBAN) != "" || strings.TrimSpace(normalized.BIC) != "" {
			return nil, domain.ValidationError{Field: "paymentMethods", Message: "contains SEPA fields on a PayPal.Me target"}
		}
		handle, err := normalizePayPalMeHandle(normalized.PayPalMeHandle)
		if err != nil {
			return nil, err
		}
		normalized.PayPalMeHandle = handle
		normalized.RecipientName, normalized.IBAN, normalized.BIC = "", "", ""
	case domain.PaymentTargetSEPATransfer:
		if currency != "EUR" {
			return nil, domain.ValidationError{Field: "paymentMethods", Message: "contains a SEPA target but the group currency is not EUR"}
		}
		if strings.TrimSpace(normalized.PayPalMeHandle) != "" {
			return nil, domain.ValidationError{Field: "paymentMethods", Message: "contains a PayPal.Me handle on a SEPA target"}
		}
		recipientName := strings.TrimSpace(normalized.RecipientName)
		if utf8.RuneCountInString(recipientName) < 1 || utf8.RuneCountInString(recipientName) > 70 || containsControlCharacter(recipientName) {
			return nil, domain.ValidationError{Field: "paymentMethods", Message: "contains a SEPA recipient name outside 1 to 70 characters"}
		}
		iban := normalizeIBAN(normalized.IBAN)
		if !validIBAN(iban) {
			return nil, domain.ValidationError{Field: "paymentMethods", Message: "contains an invalid IBAN"}
		}
		bic := strings.ToUpper(strings.TrimSpace(normalized.BIC))
		if bic != "" && !bicPattern.MatchString(bic) {
			return nil, domain.ValidationError{Field: "paymentMethods", Message: "contains an invalid BIC"}
		}
		if bic == "" && ibanRequiresBIC(iban) {
			return nil, domain.ValidationError{Field: "paymentMethods", Message: "contains a non-EEA IBAN without the required BIC"}
		}
		normalized.PayPalMeHandle = ""
		normalized.RecipientName = recipientName
		normalized.IBAN = iban
		normalized.BIC = bic
	default:
		return nil, domain.ValidationError{Field: "paymentMethods", Message: "contains a paymentTarget with an unsupported type"}
	}
	return &normalized, nil
}

// normalizePayPalMeHandle accepts a bare handle or a canonical PayPal.Me HTTPS
// URL and returns only its case-preserving ASCII-alphanumeric handle. It rejects
// redirect-capable URL features, amount suffixes, and non-PayPal hosts with a
// paymentMethods validation error.
func normalizePayPalMeHandle(value string) (string, error) {
	handle := strings.TrimSpace(value)
	lower := strings.ToLower(handle)
	if strings.Contains(handle, "://") || strings.HasPrefix(lower, "paypal.me/") || strings.HasPrefix(lower, "www.paypal.me/") {
		urlValue := handle
		if !strings.Contains(urlValue, "://") {
			urlValue = "https://" + urlValue
		}
		parsed, err := url.Parse(urlValue)
		if err != nil || parsed.Scheme != "https" || parsed.User != nil || parsed.Port() != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
			return "", domain.ValidationError{Field: "paymentMethods", Message: "contains an invalid PayPal.Me link"}
		}
		host := strings.ToLower(parsed.Hostname())
		if host != "paypal.me" && host != "www.paypal.me" {
			return "", domain.ValidationError{Field: "paymentMethods", Message: "contains a PayPal.Me link with an unsupported host"}
		}
		path := strings.TrimPrefix(parsed.EscapedPath(), "/")
		path = strings.TrimSuffix(path, "/")
		if path == "" || strings.Contains(path, "/") || strings.Contains(path, "%") {
			return "", domain.ValidationError{Field: "paymentMethods", Message: "contains a PayPal.Me link without exactly one handle"}
		}
		handle = path
	}
	if !payPalMeHandlePattern.MatchString(handle) {
		return "", domain.ValidationError{Field: "paymentMethods", Message: "contains a PayPal.Me handle outside 1 to 20 ASCII letters or digits"}
	}
	return handle, nil
}

// normalizeIBAN removes Unicode whitespace and uppercases the remaining IBAN
// characters. It returns a deterministic local representation and cannot fail.
func normalizeIBAN(value string) string {
	return strings.ToUpper(strings.Map(func(character rune) rune {
		if unicode.IsSpace(character) {
			return -1
		}
		return character
	}, value))
}

// validIBAN checks the generic IBAN shape and ISO 13616 MOD-97 checksum. It
// returns false for malformed or checksum-invalid values and does not establish
// that an account exists or participates in SEPA.
func validIBAN(value string) bool {
	if len(value) < 15 || len(value) > 34 || !ibanPattern.MatchString(value) {
		return false
	}
	rearranged := value[4:] + value[:4]
	remainder := 0
	for _, character := range rearranged {
		switch {
		case character >= '0' && character <= '9':
			remainder = (remainder*10 + int(character-'0')) % 97
		case character >= 'A' && character <= 'Z':
			value := int(character-'A') + 10
			remainder = (remainder*100 + value) % 97
		default:
			return false
		}
	}
	return remainder == 1
}

// ibanRequiresBIC reports whether the normalized IBAN belongs to a country
// outside the European Economic Area. EPC payment instructions may omit BICs
// only for EEA IBANs. Malformed values return true defensively and are rejected
// separately by validIBAN.
func ibanRequiresBIC(value string) bool {
	if len(value) < 2 {
		return true
	}
	_, isEEA := eeaIBANCountries[value[:2]]
	return !isEEA
}

// paymentTargetStorageValues flattens a normalized public payment target into
// the database discriminator and nullable target columns. A nil target becomes
// the storage-only NONE discriminator. The function cannot fail because callers
// validate targets before persistence.
func paymentTargetStorageValues(target *domain.PaymentTarget) (targetType, payPalMeHandle, recipientName, iban, bic string) {
	if target == nil {
		return "NONE", "", "", "", ""
	}
	switch target.Type {
	case domain.PaymentTargetPayPalMe:
		return string(target.Type), target.PayPalMeHandle, "", "", ""
	case domain.PaymentTargetSEPATransfer:
		return string(target.Type), "", target.RecipientName, target.IBAN, target.BIC
	default:
		return string(target.Type), target.PayPalMeHandle, target.RecipientName, target.IBAN, target.BIC
	}
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
