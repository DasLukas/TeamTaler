package webpush

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	push "github.com/marknefedov/go-webpush/v2"
)

// DeliveryError is a secret-free classification of a failed push attempt.
type DeliveryError struct {
	Code       string
	Temporary  bool
	Revoke     bool
	RetryAfter time.Time
}

// Error implements error without exposing push-service response bodies,
// subscription endpoints, or encryption keys.
func (e DeliveryError) Error() string {
	return "Web Push delivery failed: " + e.Code
}

// Sender performs RFC-compliant encrypted Web Push requests through a hardened
// injected HTTP client. Construct it with NewSender.
type Sender struct {
	client *push.Client
}

// NewSender builds a reusable sender. httpClient should normally be the result
// of NewHardenedHTTPClient; nil selects a newly hardened default client.
func NewSender(httpClient push.HTTPClient) *Sender {
	if httpClient == nil {
		httpClient = NewHardenedHTTPClient(nil)
	}
	return &Sender{client: push.NewClient(push.Config{HTTPClient: httpClient, MaxConcurrentSends: 4, VAPIDCacheSize: 64})}
}

// Send encrypts payload for subscription and submits it with VAPID. privateKey
// must be a validated raw base64url P-256 scalar, subject an HTTPS or mailto
// VAPID contact, and ttl a non-negative duration. It returns a classified error
// for retry/revocation decisions and never exposes remote response bodies.
func (s *Sender) Send(ctx context.Context, payload []byte, subscription *push.Subscription, subject, privateKey string, ttl time.Duration, urgency push.Urgency) error {
	if s == nil || s.client == nil {
		return fmt.Errorf("Web Push sender is unavailable")
	}
	keys, err := ParseVAPIDPrivateKey(privateKey)
	if err != nil {
		return err
	}
	ttlSeconds := int(ttl / time.Second)
	if ttlSeconds < 0 || ttlSeconds > 28*24*60*60 {
		return fmt.Errorf("Web Push TTL must be between zero and 28 days")
	}
	result, err := s.client.Send(ctx, payload, subscription, push.SendOptions{
		Subject: subject, TTL: ttlSeconds, Urgency: urgency, VAPIDKeys: keys,
	})
	if result != nil && result.Response != nil && result.Response.Body != nil {
		defer result.Response.Body.Close()
	}
	if err == nil {
		return nil
	}
	var serviceErr *push.PushServiceError
	if errors.As(err, &serviceErr) {
		code := fmt.Sprintf("http_%d", serviceErr.StatusCode)
		return DeliveryError{Code: code, Temporary: serviceErr.Temporary, Revoke: serviceErr.SubscriptionExpired, RetryAfter: serviceErr.RetryAfter}
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return DeliveryError{Code: "request_timeout", Temporary: true}
	}
	if result != nil && result.StatusCode >= http.StatusInternalServerError {
		return DeliveryError{Code: "push_service_unavailable", Temporary: true}
	}
	return DeliveryError{Code: "transport_error", Temporary: true}
}
