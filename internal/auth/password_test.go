package auth

import (
	"strings"
	"testing"
)

func TestPasswordHashRoundTrip(t *testing.T) {
	password := "long-and-unique-test-password"
	encoded, err := HashPassword(password)
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	if !strings.HasPrefix(encoded, "$argon2id$v=19$") {
		t.Fatalf("unexpected encoded password format: %q", encoded)
	}
	if !VerifyPassword(encoded, password) {
		t.Fatal("correct password did not verify")
	}
	if VerifyPassword(encoded, password+"-wrong") {
		t.Fatal("wrong password verified")
	}
	if VerifyPassword("malformed", password) {
		t.Fatal("malformed hash verified")
	}
}

func TestVerifyPasswordSupportsExistingEncoding(t *testing.T) {
	const password = "long-and-unique-test-password"
	const encoded = "$argon2id$v=19$m=65536,t=3,p=2$MDEyMzQ1Njc4OWFiY2RlZg$6UTqN+/Dfj2p9NJKYY8hPYP1es6mmNcBWTRdWDaFueM"

	if !VerifyPassword(encoded, password) {
		t.Fatal("existing encoded password did not verify")
	}
	if VerifyPassword(encoded, password+"-wrong") {
		t.Fatal("existing encoded password verified with the wrong password")
	}
}

func TestPasswordLengthLimits(t *testing.T) {
	if _, err := HashPassword("too-short"); err == nil {
		t.Fatal("short password was accepted")
	}
	if _, err := HashPassword(strings.Repeat("x", 1025)); err == nil {
		t.Fatal("oversized password was accepted")
	}
}

func TestVerifyPasswordRejectsInvalidArgon2Parameters(t *testing.T) {
	password := "long-and-unique-test-password"
	encoded, err := HashPassword(password)
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 {
		t.Fatalf("unexpected encoded password format: %q", encoded)
	}

	tests := map[string]string{
		"memory out of range":      "m=4294967296,t=3,p=2",
		"iterations out of range":  "m=65536,t=4294967296,p=2",
		"parallelism out of range": "m=65536,t=3,p=256",
		"duplicate memory":         "m=65536,t=3,p=2,m=65536",
		"duplicate iterations":     "m=65536,t=3,p=2,t=3",
		"duplicate parallelism":    "m=65536,t=3,p=2,p=2",
		"unknown setting":          "m=65536,t=3,p=2,x=1",
		"missing value separator":  "m=65536,t,p=2",
		"non-numeric value":        "m=65536,t=three,p=2",
		"missing setting":          "m=65536,t=3",
	}

	for name, parameters := range tests {
		t.Run(name, func(t *testing.T) {
			candidate := strings.Join([]string{parts[0], parts[1], parts[2], parameters, parts[4], parts[5]}, "$")
			if VerifyPassword(candidate, password) {
				t.Fatalf("invalid Argon2 parameters verified: %q", parameters)
			}
		})
	}
}
