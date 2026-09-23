// Package paymenttargets validates and normalizes locally configured external
// payment instructions without contacting a financial provider.
package paymenttargets

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

// Normalize validates and canonicalizes one payment target for a group
// currency. A nil target remains nil. It performs no provider or network lookup.
func Normalize(target *domain.PaymentTarget, currency string) (*domain.PaymentTarget, error) {
	return NormalizeForField(target, currency, "paymentTarget")
}

// NormalizeForField validates and canonicalizes one payment target while using
// field in returned validation errors. A nil target remains nil.
func NormalizeForField(target *domain.PaymentTarget, currency, field string) (*domain.PaymentTarget, error) {
	if target == nil {
		return nil, nil
	}
	normalized := *target
	if utf8.RuneCountInString(normalized.PayPalMeHandle) > 120 || utf8.RuneCountInString(normalized.RecipientName) > 70 ||
		utf8.RuneCountInString(normalized.IBAN) > 42 || utf8.RuneCountInString(normalized.BIC) > 14 {
		return nil, domain.ValidationError{Field: field, Message: "contains an overlong payment target field"}
	}
	for _, value := range []string{normalized.PayPalMeHandle, normalized.RecipientName, normalized.IBAN, normalized.BIC} {
		if containsControlCharacter(value) {
			return nil, domain.ValidationError{Field: field, Message: "contains control characters in a payment target"}
		}
	}
	switch normalized.Type {
	case domain.PaymentTargetPayPalMe:
		if strings.TrimSpace(normalized.RecipientName) != "" || strings.TrimSpace(normalized.IBAN) != "" || strings.TrimSpace(normalized.BIC) != "" {
			return nil, domain.ValidationError{Field: field, Message: "contains SEPA fields on a PayPal.Me target"}
		}
		handle, err := NormalizePayPalMeHandle(normalized.PayPalMeHandle)
		if err != nil {
			return nil, validationForField(err, field)
		}
		normalized.PayPalMeHandle = handle
		normalized.RecipientName, normalized.IBAN, normalized.BIC = "", "", ""
	case domain.PaymentTargetSEPATransfer:
		if currency != "EUR" {
			return nil, domain.ValidationError{Field: field, Message: "contains a SEPA target but the group currency is not EUR"}
		}
		if strings.TrimSpace(normalized.PayPalMeHandle) != "" {
			return nil, domain.ValidationError{Field: field, Message: "contains a PayPal.Me handle on a SEPA target"}
		}
		recipientName := strings.TrimSpace(normalized.RecipientName)
		if utf8.RuneCountInString(recipientName) < 1 || utf8.RuneCountInString(recipientName) > 70 || containsControlCharacter(recipientName) {
			return nil, domain.ValidationError{Field: field, Message: "contains a SEPA recipient name outside 1 to 70 characters"}
		}
		iban := NormalizeIBAN(normalized.IBAN)
		if !ValidIBAN(iban) {
			return nil, domain.ValidationError{Field: field, Message: "contains an invalid IBAN"}
		}
		bic := strings.ToUpper(strings.TrimSpace(normalized.BIC))
		if bic != "" && !ValidBIC(bic) {
			return nil, domain.ValidationError{Field: field, Message: "contains an invalid BIC"}
		}
		if bic == "" && IBANRequiresBIC(iban) {
			return nil, domain.ValidationError{Field: field, Message: "contains a non-EEA IBAN without the required BIC"}
		}
		normalized.PayPalMeHandle = ""
		normalized.RecipientName = recipientName
		normalized.IBAN = iban
		normalized.BIC = bic
	default:
		return nil, domain.ValidationError{Field: field, Message: "contains a payment target with an unsupported type"}
	}
	return &normalized, nil
}

// NormalizePayPalMeHandle accepts a bare handle or canonical PayPal.Me HTTPS
// URL and returns its case-preserving ASCII-alphanumeric handle.
func NormalizePayPalMeHandle(value string) (string, error) {
	handle := strings.TrimSpace(value)
	lower := strings.ToLower(handle)
	if strings.Contains(handle, "://") || strings.HasPrefix(lower, "paypal.me/") || strings.HasPrefix(lower, "www.paypal.me/") {
		urlValue := handle
		if !strings.Contains(urlValue, "://") {
			urlValue = "https://" + urlValue
		}
		parsed, err := url.Parse(urlValue)
		if err != nil || parsed.Scheme != "https" || parsed.User != nil || parsed.Port() != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
			return "", domain.ValidationError{Field: "paymentTarget", Message: "contains an invalid PayPal.Me link"}
		}
		host := strings.ToLower(parsed.Hostname())
		if host != "paypal.me" && host != "www.paypal.me" {
			return "", domain.ValidationError{Field: "paymentTarget", Message: "contains a PayPal.Me link with an unsupported host"}
		}
		path := strings.TrimSuffix(strings.TrimPrefix(parsed.EscapedPath(), "/"), "/")
		if path == "" || strings.Contains(path, "/") || strings.Contains(path, "%") {
			return "", domain.ValidationError{Field: "paymentTarget", Message: "contains a PayPal.Me link without exactly one handle"}
		}
		handle = path
	}
	if !payPalMeHandlePattern.MatchString(handle) {
		return "", domain.ValidationError{Field: "paymentTarget", Message: "contains a PayPal.Me handle outside 1 to 20 ASCII letters or digits"}
	}
	return handle, nil
}

// NormalizeIBAN removes Unicode whitespace and uppercases the remaining IBAN
// characters. It returns a deterministic local representation and cannot fail.
func NormalizeIBAN(value string) string {
	return strings.ToUpper(strings.Map(func(character rune) rune {
		if unicode.IsSpace(character) {
			return -1
		}
		return character
	}, value))
}

// ValidIBAN checks the generic IBAN shape and ISO 13616 MOD-97 checksum. It
// does not establish that the account exists or participates in SEPA.
func ValidIBAN(value string) bool {
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
			digits := int(character-'A') + 10
			remainder = (remainder*100 + digits) % 97
		default:
			return false
		}
	}
	return remainder == 1
}

// ValidBIC reports whether value is a normalized ISO 9362 BIC of length eight
// or eleven. It does not establish that the institution exists.
func ValidBIC(value string) bool {
	return bicPattern.MatchString(value)
}

// IBANRequiresBIC reports whether a normalized IBAN belongs to a country
// outside the European Economic Area. Malformed values return true defensively.
func IBANRequiresBIC(value string) bool {
	if len(value) < 2 {
		return true
	}
	_, isEEA := eeaIBANCountries[value[:2]]
	return !isEEA
}

func validationForField(err error, field string) error {
	if validation, ok := err.(domain.ValidationError); ok {
		validation.Field = field
		return validation
	}
	return err
}

func containsControlCharacter(value string) bool {
	for _, character := range value {
		if unicode.IsControl(character) {
			return true
		}
	}
	return false
}
