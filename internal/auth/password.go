// Package auth implements local password and session authentication.
package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"golang.org/x/crypto/argon2"
)

const (
	argonMemory      = 64 * 1024
	argonIterations  = 3
	argonParallelism = 2
	argonSaltLength  = 16
	argonKeyLength   = 32
)

var dummyPasswordHash = func() string {
	encoded, err := HashPassword("dummy-password-that-is-never-valid")
	if err != nil {
		panic(err)
	}
	return encoded
}()

// HashPassword derives an Argon2id credential from password and a fresh random
// salt. It returns the encoded credential or an error when the password is
// outside the 12-to-1024-character contract or secure randomness is unavailable.
// Callers store only the returned encoding; use VerifyPassword for comparison.
func HashPassword(password string) (string, error) {
	if len(password) < 12 || len(password) > 1024 {
		return "", errors.New("password must contain between 12 and 1024 characters")
	}
	salt := make([]byte, argonSaltLength)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("create password salt: %w", err)
	}
	digest := argon2.IDKey([]byte(password), salt, argonIterations, argonMemory, argonParallelism, argonKeyLength)
	return fmt.Sprintf("$argon2id$v=19$m=%d,t=%d,p=%d$%s$%s", argonMemory, argonIterations, argonParallelism,
		base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(digest)), nil
}

// VerifyPassword compares password with an encoded Argon2id credential in
// constant time. It returns false for malformed encodings, unsupported or
// unexpectedly expensive parameters, invalid lengths, and credential mismatch;
// it never returns an error or upgrades a stored credential.
func VerifyPassword(encoded, password string) bool {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" || parts[2] != "v=19" {
		return false
	}
	var memory uint32
	var iterations uint32
	var parallelism uint8
	var hasMemory bool
	var hasIterations bool
	var hasParallelism bool
	for _, setting := range strings.Split(parts[3], ",") {
		pair := strings.SplitN(setting, "=", 2)
		if len(pair) != 2 {
			return false
		}
		switch pair[0] {
		case "m":
			if hasMemory {
				return false
			}
			value, err := strconv.ParseUint(pair[1], 10, 32)
			if err != nil {
				return false
			}
			memory = uint32(value)
			hasMemory = true
		case "t":
			if hasIterations {
				return false
			}
			value, err := strconv.ParseUint(pair[1], 10, 32)
			if err != nil {
				return false
			}
			iterations = uint32(value)
			hasIterations = true
		case "p":
			if hasParallelism {
				return false
			}
			value, err := strconv.ParseUint(pair[1], 10, 8)
			if err != nil {
				return false
			}
			parallelism = uint8(value)
			hasParallelism = true
		default:
			return false
		}
	}
	if !hasMemory || !hasIterations || !hasParallelism ||
		memory != argonMemory || iterations != argonIterations || parallelism != argonParallelism {
		return false
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil || len(salt) != argonSaltLength {
		return false
	}
	expected, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil || len(expected) != argonKeyLength {
		return false
	}
	actual := argon2.IDKey([]byte(password), salt, iterations, memory, parallelism, argonKeyLength)
	return subtle.ConstantTimeCompare(actual, expected) == 1
}
