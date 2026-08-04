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

func TestPasswordLengthLimits(t *testing.T) {
	if _, err := HashPassword("too-short"); err == nil {
		t.Fatal("short password was accepted")
	}
	if _, err := HashPassword(strings.Repeat("x", 1025)); err == nil {
		t.Fatal("oversized password was accepted")
	}
}
