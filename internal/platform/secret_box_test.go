package platform

import (
	"strings"
	"testing"
)

func TestSecretBoxRoundTripAndTamperDetection(t *testing.T) {
	t.Parallel()

	box, err := NewSecretBox([]byte("0123456789abcdef0123456789abcdef"))
	if err != nil {
		t.Fatalf("NewSecretBox: %v", err)
	}
	encrypted, err := box.Seal("one-time-invitation-token")
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}
	if strings.Contains(encrypted, "one-time-invitation-token") {
		t.Fatal("ciphertext contains plaintext")
	}
	decrypted, err := box.Open(encrypted)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if decrypted != "one-time-invitation-token" {
		t.Fatalf("Open = %q", decrypted)
	}

	replacement := byte('A')
	if encrypted[0] == replacement {
		replacement = 'B'
	}
	tampered := string(replacement) + encrypted[1:]
	if _, err := box.Open(tampered); err == nil {
		t.Fatal("tampered ciphertext unexpectedly opened")
	}
}

func TestSecretBoxRejectsInvalidKeyAndEnvelope(t *testing.T) {
	t.Parallel()

	if _, err := NewSecretBox([]byte("short")); err == nil {
		t.Fatal("short key unexpectedly accepted")
	}
	box, err := NewSecretBox(make([]byte, 32))
	if err != nil {
		t.Fatalf("NewSecretBox: %v", err)
	}
	if _, err := box.Open("not-base64!"); err == nil {
		t.Fatal("malformed envelope unexpectedly opened")
	}
}
