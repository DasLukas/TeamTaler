// Package webpush provides encrypted subscription storage and standards-based
// Web Push delivery without exposing browser endpoints or key material.
package webpush

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/elliptic"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math/big"

	push "github.com/marknefedov/go-webpush/v2"
)

const (
	vapidKeyDerivationContext        = "teamtaler-web-push-vapid-secret-v1"
	subscriptionKeyDerivationContext = "teamtaler-web-push-subscription-v1"
	envelopeVersion                  = byte(1)
	maxEnvelopePlaintextBytes        = 4 << 10
	maxEnvelopeAEADMetadataBytes     = 64
)

var (
	vapidEnvelopeAAD        = []byte("teamtaler-web-push-vapid-envelope-v1")
	subscriptionEnvelopeAAD = []byte("teamtaler-web-push-subscription-envelope-v1")
)

// Secrets owns purpose-separated authenticated encryption keys derived from
// TEAMTALER_PUSH_STORAGE_KEY. Construct it with NewSecrets and never log it.
type Secrets struct {
	vapidAEAD        cipher.AEAD
	subscriptionAEAD cipher.AEAD
}

// NewSecrets derives independent AES-256-GCM keys for persisted VAPID secrets
// and browser subscription envelopes. storageKey must contain exactly 32 bytes.
// It returns an error when key material or cipher initialization is invalid.
// Example: secrets, err := NewSecrets(configuration.PushStorageKey).
func NewSecrets(storageKey []byte) (*Secrets, error) {
	if len(storageKey) != 32 {
		return nil, fmt.Errorf("Web Push storage key must contain exactly 32 bytes")
	}
	vapidAEAD, err := deriveAEAD(storageKey, vapidKeyDerivationContext)
	if err != nil {
		return nil, err
	}
	subscriptionAEAD, err := deriveAEAD(storageKey, subscriptionKeyDerivationContext)
	if err != nil {
		return nil, err
	}
	return &Secrets{vapidAEAD: vapidAEAD, subscriptionAEAD: subscriptionAEAD}, nil
}

// SealVAPIDPrivateKey encrypts a validated base64url VAPID private key with a
// fresh nonce. It returns an opaque envelope and never includes plaintext in an
// error. Example: envelope, err := secrets.SealVAPIDPrivateKey(privateKey).
func (s *Secrets) SealVAPIDPrivateKey(privateKey string) (string, error) {
	if _, err := ParseVAPIDPrivateKey(privateKey); err != nil {
		return "", fmt.Errorf("invalid VAPID private key")
	}
	return sealEnvelope(s.vapidAEAD, []byte(privateKey), vapidEnvelopeAAD)
}

// OpenVAPIDPrivateKey authenticates and decrypts an envelope created by
// SealVAPIDPrivateKey. It returns a generic error for malformed or tampered
// input so secrets cannot leak through diagnostics.
func (s *Secrets) OpenVAPIDPrivateKey(envelope string) (string, error) {
	plaintext, err := openEnvelope(s.vapidAEAD, envelope, vapidEnvelopeAAD)
	if err != nil {
		return "", fmt.Errorf("VAPID private-key envelope is invalid")
	}
	privateKey := string(plaintext)
	if _, err := ParseVAPIDPrivateKey(privateKey); err != nil {
		return "", fmt.Errorf("VAPID private-key envelope is invalid")
	}
	return privateKey, nil
}

func (s *Secrets) sealSubscription(payload subscriptionEnvelope) (string, error) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return "", fmt.Errorf("encode Web Push subscription: %w", err)
	}
	return sealEnvelope(s.subscriptionAEAD, encoded, subscriptionEnvelopeAAD)
}

func (s *Secrets) openSubscription(envelope string) (subscriptionEnvelope, error) {
	plaintext, err := openEnvelope(s.subscriptionAEAD, envelope, subscriptionEnvelopeAAD)
	if err != nil {
		return subscriptionEnvelope{}, fmt.Errorf("Web Push subscription envelope is invalid")
	}
	var payload subscriptionEnvelope
	if err := json.Unmarshal(plaintext, &payload); err != nil {
		return subscriptionEnvelope{}, fmt.Errorf("Web Push subscription envelope is invalid")
	}
	if _, err := validatedSubscription(payload.Input); err != nil {
		return subscriptionEnvelope{}, fmt.Errorf("Web Push subscription envelope is invalid")
	}
	return payload, nil
}

func deriveAEAD(storageKey []byte, context string) (cipher.AEAD, error) {
	derived, err := hkdf.Key(sha256.New, append([]byte(nil), storageKey...), nil, context, 32)
	if err != nil {
		return nil, fmt.Errorf("derive Web Push encryption key: %w", err)
	}
	block, err := aes.NewCipher(derived)
	if err != nil {
		return nil, fmt.Errorf("create Web Push encryption cipher: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("create Web Push encryption envelope: %w", err)
	}
	return aead, nil
}

func sealEnvelope(aead cipher.AEAD, plaintext, aad []byte) (string, error) {
	if aead == nil {
		return "", fmt.Errorf("Web Push encryption is unavailable")
	}
	nonceSize, overhead := aead.NonceSize(), aead.Overhead()
	if len(plaintext) > maxEnvelopePlaintextBytes || nonceSize < 1 || nonceSize > maxEnvelopeAEADMetadataBytes || overhead < 1 || overhead > maxEnvelopeAEADMetadataBytes {
		return "", fmt.Errorf("Web Push encryption input is invalid")
	}
	nonce := make([]byte, nonceSize)
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", fmt.Errorf("generate Web Push envelope nonce: %w", err)
	}
	envelope := make([]byte, 1, 1+nonceSize+len(plaintext)+overhead)
	envelope[0] = envelopeVersion
	envelope = append(envelope, nonce...)
	envelope = aead.Seal(envelope, nonce, plaintext, aad)
	return base64.RawURLEncoding.EncodeToString(envelope), nil
}

func openEnvelope(aead cipher.AEAD, envelope string, aad []byte) ([]byte, error) {
	if aead == nil {
		return nil, fmt.Errorf("Web Push encryption is unavailable")
	}
	decoded, err := base64.RawURLEncoding.DecodeString(envelope)
	if err != nil || len(decoded) < 1+aead.NonceSize()+aead.Overhead() || decoded[0] != envelopeVersion {
		return nil, fmt.Errorf("invalid Web Push envelope")
	}
	nonce := decoded[1 : 1+aead.NonceSize()]
	plaintext, err := aead.Open(nil, nonce, decoded[1+aead.NonceSize():], aad)
	if err != nil {
		return nil, fmt.Errorf("invalid Web Push envelope")
	}
	return plaintext, nil
}

// GenerateVAPIDKey creates a P-256 VAPID key pair. The private key is returned
// only to trusted configuration code; PublicKey and KeyID are safe to expose.
// It returns an error if the operating system random source fails.
func GenerateVAPIDKey() (privateKey, publicKey, keyID string, err error) {
	keys, err := push.GenerateVAPIDKeys()
	if err != nil {
		return "", "", "", fmt.Errorf("generate VAPID key: %w", err)
	}
	encoded, err := json.Marshal(keys)
	if err != nil {
		return "", "", "", fmt.Errorf("encode VAPID key: %w", err)
	}
	var payload struct {
		PrivateKey string `json:"privateKey"`
		PublicKey  string `json:"publicKey"`
	}
	if err := json.Unmarshal(encoded, &payload); err != nil {
		return "", "", "", fmt.Errorf("decode generated VAPID key: %w", err)
	}
	return payload.PrivateKey, payload.PublicKey, PublicKeyID(payload.PublicKey), nil
}

// ParseVAPIDPrivateKey validates and parses one raw, unpadded base64url P-256
// scalar. It returns the library keypair or a secret-free validation error.
func ParseVAPIDPrivateKey(privateKey string) (*push.VAPIDKeys, error) {
	decoded, err := base64.RawURLEncoding.Strict().DecodeString(privateKey)
	if err != nil || len(decoded) != 32 {
		return nil, fmt.Errorf("VAPID private key must be unpadded base64url encoding exactly 32 bytes")
	}
	scalar := new(big.Int).SetBytes(decoded)
	if scalar.Sign() <= 0 || scalar.Cmp(elliptic.P256().Params().N) >= 0 {
		return nil, fmt.Errorf("VAPID private key scalar is outside the P-256 range")
	}
	payload, err := json.Marshal(map[string]string{"privateKey": privateKey})
	if err != nil {
		return nil, fmt.Errorf("encode VAPID private key: %w", err)
	}
	var keys push.VAPIDKeys
	if err := json.Unmarshal(payload, &keys); err != nil {
		return nil, fmt.Errorf("parse VAPID private key")
	}
	return &keys, nil
}

// PublicKeyID returns a stable SHA-256 fingerprint for a base64url VAPID public
// key. It has no error path and exposes no private material.
func PublicKeyID(publicKey string) string {
	digest := sha256.Sum256([]byte(publicKey))
	return hex.EncodeToString(digest[:])
}
