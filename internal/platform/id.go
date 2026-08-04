// Package platform provides small infrastructure primitives shared by domain modules.
package platform

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"strings"
	"time"
)

// NewID creates an opaque random identifier using prefix for diagnostics.
// It returns the identifier or an error when the operating system random source
// fails. Example: NewID("grp") creates a value beginning with "grp_".
func NewID(prefix string) (string, error) {
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		return "", fmt.Errorf("generate identifier: %w", err)
	}
	return strings.TrimSpace(prefix) + "_" + hex.EncodeToString(random), nil
}

// NewSecret takes no parameters and returns a URL-safe 256-bit secret.
// It returns an error only when the operating system random source fails.
func NewSecret() (string, error) {
	random := make([]byte, 32)
	if _, err := rand.Read(random); err != nil {
		return "", fmt.Errorf("generate secret: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(random), nil
}

// HashSecret hashes secret with SHA-256 and returns its lowercase hexadecimal
// digest. It cannot fail and is intended for server-side bearer-token storage.
func HashSecret(secret string) string {
	digest := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(digest[:])
}

// Timestamp converts value to UTC and returns RFC 3339 text with nanoseconds.
// It cannot fail and provides the canonical SQLite timestamp representation.
func Timestamp(value time.Time) string {
	return value.UTC().Format(time.RFC3339Nano)
}

// IsCurrencyCode reports whether value is exactly three uppercase ASCII letters,
// matching TeamTaler's ISO 4217 input contract. It cannot fail and performs no
// external registry lookup.
func IsCurrencyCode(value string) bool {
	if len(value) != 3 {
		return false
	}
	for _, character := range value {
		if character < 'A' || character > 'Z' {
			return false
		}
	}
	return true
}

// Now returns the current UTC time. Tests may replace it temporarily; production
// code must treat it as read-only. It takes no parameters and cannot fail.
var Now = func() time.Time { return time.Now().UTC() }
