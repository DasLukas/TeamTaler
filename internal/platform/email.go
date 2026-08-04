package platform

import (
	"fmt"
	"net/mail"
	"strings"
)

// NormalizeEmail validates a plain mailbox address and returns its canonical
// lower-case representation. Display-name address forms and control characters
// are rejected. It returns a validation-oriented error without echoing the
// submitted address. Example: NormalizeEmail(" Member@Example.test ") returns
// "member@example.test".
func NormalizeEmail(value string) (string, error) {
	normalized := strings.ToLower(strings.TrimSpace(value))
	if normalized == "" || len(normalized) > 254 || strings.ContainsAny(normalized, "\r\n\x00") {
		return "", fmt.Errorf("must be a valid email address")
	}
	for _, character := range normalized {
		if character > 127 {
			return "", fmt.Errorf("must be a valid email address")
		}
	}
	parsed, err := mail.ParseAddress(normalized)
	if err != nil || !strings.EqualFold(parsed.Address, normalized) || strings.Count(normalized, "@") != 1 {
		return "", fmt.Errorf("must be a valid email address")
	}
	return normalized, nil
}
