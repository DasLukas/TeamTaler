package system

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"io"
)

const smtpPasswordDerivationContext = "teamtaler-smtp-password-key-v1"

var smtpPasswordEnvelopeContext = []byte("teamtaler-smtp-password-envelope-v1")

type smtpPasswordCipher struct {
	aead cipher.AEAD
}

// NewSMTPPasswordCipher derives a purpose-specific AES-256-GCM key from the
// 32-byte TEAMTALER_EMAIL_TOKEN_KEY and returns an authenticated SMTP-password
// cipher. The derivation prevents invitation-token and SMTP-password envelopes
// from sharing an encryption key. It returns an error for every other key size.
// Example: cipher, err := NewSMTPPasswordCipher(config.EmailTokenKey).
func NewSMTPPasswordCipher(emailTokenKey []byte) (PasswordCipher, error) {
	if len(emailTokenKey) != 32 {
		return nil, fmt.Errorf("SMTP password key material must contain exactly 32 bytes")
	}
	derived, err := hkdf.Key(sha256.New, append([]byte(nil), emailTokenKey...), nil, smtpPasswordDerivationContext, 32)
	if err != nil {
		return nil, fmt.Errorf("derive SMTP password key: %w", err)
	}
	block, err := aes.NewCipher(derived)
	if err != nil {
		return nil, fmt.Errorf("create SMTP password cipher: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("create SMTP password envelope: %w", err)
	}
	return smtpPasswordCipher{aead: aead}, nil
}

// Seal encrypts one SMTP password with a fresh random nonce. It returns a
// URL-safe opaque envelope or a generic initialization/randomness error; the
// plaintext is never included in errors.
func (c smtpPasswordCipher) Seal(plaintext string) (string, error) {
	if c.aead == nil {
		return "", fmt.Errorf("SMTP password cipher is not initialized")
	}
	nonce := make([]byte, c.aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", fmt.Errorf("generate SMTP password nonce: %w", err)
	}
	envelope := c.aead.Seal(nonce, nonce, []byte(plaintext), smtpPasswordEnvelopeContext)
	return base64.RawURLEncoding.EncodeToString(envelope), nil
}

// Open authenticates and decrypts an envelope created by Seal. It returns a
// generic error for malformed, tampered, or wrong-purpose ciphertext.
func (c smtpPasswordCipher) Open(envelope string) (string, error) {
	if c.aead == nil {
		return "", fmt.Errorf("SMTP password cipher is not initialized")
	}
	decoded, err := base64.RawURLEncoding.DecodeString(envelope)
	if err != nil || len(decoded) < c.aead.NonceSize()+c.aead.Overhead() {
		return "", fmt.Errorf("SMTP password envelope is invalid")
	}
	nonce := decoded[:c.aead.NonceSize()]
	plaintext, err := c.aead.Open(nil, nonce, decoded[c.aead.NonceSize():], smtpPasswordEnvelopeContext)
	if err != nil {
		return "", fmt.Errorf("SMTP password envelope is invalid")
	}
	return string(plaintext), nil
}
