package platform

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"io"
)

var invitationTokenContext = []byte("teamtaler-invitation-token-v1")

// SecretBox encrypts short-lived invitation secrets with AES-256-GCM. A box is
// safe for concurrent use and keeps its key only in process memory.
type SecretBox struct {
	aead cipher.AEAD
}

// NewSecretBox constructs an authenticated secret box from exactly 32 key
// bytes. It returns an error for every other key size. Example:
// box, err := NewSecretBox(decodedEnvironmentKey).
func NewSecretBox(key []byte) (SecretBox, error) {
	if len(key) != 32 {
		return SecretBox{}, fmt.Errorf("secret box key must contain exactly 32 bytes")
	}
	block, err := aes.NewCipher(append([]byte(nil), key...))
	if err != nil {
		return SecretBox{}, fmt.Errorf("create AES cipher: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return SecretBox{}, fmt.Errorf("create GCM cipher: %w", err)
	}
	return SecretBox{aead: aead}, nil
}

// Seal encrypts plaintext with a fresh random nonce and returns a URL-safe
// base64 envelope. It returns an error when the random source fails or the box
// was not initialized. Example: encrypted, err := box.Seal(invitationToken).
func (b SecretBox) Seal(plaintext string) (string, error) {
	if b.aead == nil {
		return "", fmt.Errorf("secret box is not initialized")
	}
	nonce := make([]byte, b.aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", fmt.Errorf("generate secret-box nonce: %w", err)
	}
	envelope := b.aead.Seal(nonce, nonce, []byte(plaintext), invitationTokenContext)
	return base64.RawURLEncoding.EncodeToString(envelope), nil
}

// Open authenticates and decrypts an envelope created by Seal. It returns a
// generic error for malformed, tampered, or wrong-key input and never includes
// ciphertext or plaintext in the error. Example: token, err := box.Open(value).
func (b SecretBox) Open(envelope string) (string, error) {
	if b.aead == nil {
		return "", fmt.Errorf("secret box is not initialized")
	}
	decoded, err := base64.RawURLEncoding.DecodeString(envelope)
	if err != nil || len(decoded) < b.aead.NonceSize()+b.aead.Overhead() {
		return "", fmt.Errorf("secret envelope is invalid")
	}
	nonce := decoded[:b.aead.NonceSize()]
	plaintext, err := b.aead.Open(nil, nonce, decoded[b.aead.NonceSize():], invitationTokenContext)
	if err != nil {
		return "", fmt.Errorf("secret envelope is invalid")
	}
	return string(plaintext), nil
}
