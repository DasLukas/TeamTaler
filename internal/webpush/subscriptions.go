package webpush

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"strings"

	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
	push "github.com/marknefedov/go-webpush/v2"
)

const (
	// MaxDevicesPerUser bounds active Web Push endpoints per account.
	MaxDevicesPerUser    = 10
	maxDeviceLabel       = 80
	maxAuthKeyTextLength = 128
	maxP256DHTextLength  = 256
)

// SubscriptionKeys contains the browser-provided application-server keys.
// Values are accepted only as base64/base64url and are never returned by APIs.
type SubscriptionKeys struct {
	P256DH string `json:"p256dh"`
	Auth   string `json:"auth"`
}

// SubscriptionInput is the browser PushSubscription registration payload.
// ExpirationTime is retained inside the encrypted envelope when supplied.
type SubscriptionInput struct {
	Endpoint       string           `json:"endpoint"`
	ExpirationTime *int64           `json:"expirationTime,omitempty"`
	Keys           SubscriptionKeys `json:"keys"`
}

type subscriptionEnvelope struct {
	Input SubscriptionInput `json:"subscription"`
}

// Device is the redacted representation returned to an authenticated account.
// It deliberately excludes the endpoint and both browser encryption keys.
type Device struct {
	ID          string `json:"id"`
	DeviceLabel string `json:"deviceLabel"`
	VAPIDKeyID  string `json:"keyId"`
	CreatedAt   string `json:"createdAt"`
	LastUsedAt  string `json:"lastUsedAt"`
	Current     bool   `json:"current"`
}

// StoredSubscription is a trusted decrypted subscription used by delivery
// workers. It must never be serialized to logs or API responses.
type StoredSubscription struct {
	ID           string
	UserID       string
	VAPIDKeyID   string
	Subscription *push.Subscription
}

// SubscriptionService manages encrypted, account-owned browser endpoints.
// Construct it with NewSubscriptionService; zero values are not usable.
type SubscriptionService struct {
	db       *sql.DB
	secrets  *Secrets
	resolver Resolver
}

// NewSubscriptionService constructs encrypted Web Push subscription storage.
// db and secrets are required; resolver may be nil to use net.DefaultResolver.
// It returns an error for incomplete dependencies.
func NewSubscriptionService(db *sql.DB, secrets *Secrets, resolver Resolver) (*SubscriptionService, error) {
	if db == nil {
		return nil, fmt.Errorf("Web Push subscription database is required")
	}
	if secrets == nil || secrets.subscriptionAEAD == nil {
		return nil, fmt.Errorf("Web Push subscription encryption is required")
	}
	return &SubscriptionService{db: db, secrets: secrets, resolver: resolver}, nil
}

// List returns every active redacted device owned by userID in most-recently
// used order. It returns storage errors and never decrypts endpoint material.
func (s *SubscriptionService) List(ctx context.Context, userID string) ([]Device, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id,device_label,vapid_key_id,created_at,last_used_at
		FROM web_push_subscriptions WHERE user_id=? AND revoked_at IS NULL
		ORDER BY last_used_at DESC,id`, userID)
	if err != nil {
		return nil, fmt.Errorf("list Web Push devices: %w", err)
	}
	defer rows.Close()
	devices := make([]Device, 0)
	for rows.Next() {
		var device Device
		if err := rows.Scan(&device.ID, &device.DeviceLabel, &device.VAPIDKeyID, &device.CreatedAt, &device.LastUsedAt); err != nil {
			return nil, fmt.Errorf("scan Web Push device: %w", err)
		}
		devices = append(devices, device)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate Web Push devices: %w", err)
	}
	return devices, nil
}

// Register validates and encrypts a browser subscription, then atomically
// creates, refreshes, or reassigns that endpoint to userID. Reassignment handles
// shared browser profiles without revealing the previous owner. At most ten
// active devices may belong to one user. It returns a redacted Device.
func (s *SubscriptionService) Register(ctx context.Context, userID, vapidKeyID, deviceLabel string, input SubscriptionInput) (Device, error) {
	deviceLabel = strings.TrimSpace(deviceLabel)
	if deviceLabel == "" || len(deviceLabel) > maxDeviceLabel || containsControl(deviceLabel) {
		return Device{}, domain.ValidationError{Field: "deviceLabel", Message: "must contain 1 to 80 characters without control characters"}
	}
	if len(vapidKeyID) < 16 || len(vapidKeyID) > 64 {
		return Device{}, domain.ValidationError{Field: "keyId", Message: "must identify the current VAPID key"}
	}
	parsed, err := ValidateEndpoint(ctx, input.Endpoint, s.resolver)
	if err != nil {
		return Device{}, domain.ValidationError{Field: "endpoint", Message: err.Error()}
	}
	input.Endpoint = parsed.String()
	if _, err := validatedSubscription(input); err != nil {
		return Device{}, err
	}
	encrypted, err := s.secrets.sealSubscription(subscriptionEnvelope{Input: input})
	if err != nil {
		return Device{}, err
	}
	digest := sha256.Sum256([]byte(input.Endpoint))
	endpointHash := hex.EncodeToString(digest[:])
	now := platform.Timestamp(platform.Now())
	var result Device
	err = storage.WithTx(ctx, s.db, func(tx *sql.Tx) error {
		var existingID, existingUserID, existingCreatedAt string
		existingErr := tx.QueryRowContext(ctx, `SELECT id,user_id,created_at FROM web_push_subscriptions WHERE endpoint_hash=?`, endpointHash).
			Scan(&existingID, &existingUserID, &existingCreatedAt)
		if existingErr != nil && !errors.Is(existingErr, sql.ErrNoRows) {
			return fmt.Errorf("find Web Push subscription: %w", existingErr)
		}
		var activeCount int
		if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM web_push_subscriptions
			WHERE user_id=? AND revoked_at IS NULL AND id!=?`, userID, existingID).Scan(&activeCount); err != nil {
			return fmt.Errorf("count Web Push devices: %w", err)
		}
		if activeCount >= MaxDevicesPerUser {
			return fmt.Errorf("%w: at most %d active Web Push devices are allowed", domain.ErrConflict, MaxDevicesPerUser)
		}
		if existingErr == nil && existingUserID != userID {
			newID, idErr := platform.NewID("wps")
			if idErr != nil {
				return idErr
			}
			tombstoneDigest := sha256.Sum256([]byte("reassigned:" + existingID + ":" + newID))
			if _, err := tx.ExecContext(ctx, `UPDATE notification_delivery_jobs
				SET status='EXPIRED',next_attempt_at=NULL,lease_token=NULL,lease_until=NULL,
					delivered_at=NULL,last_error_code='subscription_reassigned',updated_at=?
				WHERE push_subscription_id=? AND status IN ('PENDING','SENDING')`, now, existingID); err != nil {
				return fmt.Errorf("expire reassigned Web Push jobs: %w", err)
			}
			if _, err := tx.ExecContext(ctx, `UPDATE web_push_subscriptions SET endpoint_hash=?,revoked_at=?,updated_at=? WHERE id=?`,
				hex.EncodeToString(tombstoneDigest[:]), now, now, existingID); err != nil {
				return fmt.Errorf("revoke reassigned Web Push subscription: %w", err)
			}
			existingID = newID
			existingCreatedAt = now
			_, err = tx.ExecContext(ctx, `INSERT INTO web_push_subscriptions(
				id,user_id,endpoint_hash,encrypted_subscription,vapid_key_id,device_label,
				created_at,updated_at,last_used_at,revoked_at
			) VALUES(?,?,?,?,?,?,?,?,?,NULL)`, existingID, userID, endpointHash, encrypted,
				vapidKeyID, deviceLabel, now, now, now)
			if err != nil {
				return fmt.Errorf("reassign Web Push subscription: %w", err)
			}
		} else if errors.Is(existingErr, sql.ErrNoRows) {
			existingID, err = platform.NewID("wps")
			if err != nil {
				return err
			}
			existingCreatedAt = now
			_, err = tx.ExecContext(ctx, `INSERT INTO web_push_subscriptions(
				id,user_id,endpoint_hash,encrypted_subscription,vapid_key_id,device_label,
				created_at,updated_at,last_used_at,revoked_at
			) VALUES(?,?,?,?,?,?,?,?,?,NULL)`, existingID, userID, endpointHash, encrypted,
				vapidKeyID, deviceLabel, now, now, now)
			if err != nil {
				return fmt.Errorf("create Web Push subscription: %w", err)
			}
		} else {
			_, err = tx.ExecContext(ctx, `UPDATE web_push_subscriptions SET user_id=?,encrypted_subscription=?,
				vapid_key_id=?,device_label=?,updated_at=?,last_used_at=?,revoked_at=NULL WHERE id=?`,
				userID, encrypted, vapidKeyID, deviceLabel, now, now, existingID)
			if err != nil {
				return fmt.Errorf("refresh Web Push subscription: %w", err)
			}
		}
		result = Device{ID: existingID, DeviceLabel: deviceLabel, VAPIDKeyID: vapidKeyID, CreatedAt: existingCreatedAt, LastUsedAt: now}
		return nil
	})
	return result, err
}

// Rename changes a redacted device label only when the active subscription is
// owned by userID. It returns ErrNotFound for missing, revoked, or foreign rows.
func (s *SubscriptionService) Rename(ctx context.Context, userID, subscriptionID, deviceLabel string) (Device, error) {
	deviceLabel = strings.TrimSpace(deviceLabel)
	if deviceLabel == "" || len(deviceLabel) > maxDeviceLabel || containsControl(deviceLabel) {
		return Device{}, domain.ValidationError{Field: "deviceLabel", Message: "must contain 1 to 80 characters without control characters"}
	}
	now := platform.Timestamp(platform.Now())
	result, err := s.db.ExecContext(ctx, `UPDATE web_push_subscriptions SET device_label=?,updated_at=?
		WHERE id=? AND user_id=? AND revoked_at IS NULL`, deviceLabel, now, subscriptionID, userID)
	if err != nil {
		return Device{}, fmt.Errorf("rename Web Push device: %w", err)
	}
	if affected, err := result.RowsAffected(); err != nil || affected != 1 {
		if err != nil {
			return Device{}, fmt.Errorf("count renamed Web Push device: %w", err)
		}
		return Device{}, domain.ErrNotFound
	}
	var device Device
	if err := s.db.QueryRowContext(ctx, `SELECT id,device_label,vapid_key_id,created_at,last_used_at
		FROM web_push_subscriptions WHERE id=? AND user_id=? AND revoked_at IS NULL`, subscriptionID, userID).
		Scan(&device.ID, &device.DeviceLabel, &device.VAPIDKeyID, &device.CreatedAt, &device.LastUsedAt); err != nil {
		return Device{}, fmt.Errorf("read renamed Web Push device: %w", err)
	}
	return device, nil
}

// Revoke marks one owned active browser subscription unusable. It returns
// ErrNotFound for missing, already revoked, or foreign rows.
func (s *SubscriptionService) Revoke(ctx context.Context, userID, subscriptionID string) error {
	now := platform.Timestamp(platform.Now())
	result, err := s.db.ExecContext(ctx, `UPDATE web_push_subscriptions SET revoked_at=?,updated_at=?
		WHERE id=? AND user_id=? AND revoked_at IS NULL`, now, now, subscriptionID, userID)
	if err != nil {
		return fmt.Errorf("revoke Web Push device: %w", err)
	}
	if affected, err := result.RowsAffected(); err != nil || affected != 1 {
		if err != nil {
			return fmt.Errorf("count revoked Web Push device: %w", err)
		}
		return domain.ErrNotFound
	}
	return nil
}

// LoadActive decrypts one active subscription for trusted delivery code. A
// VAPID key mismatch is returned as ErrNotFound so rotated subscriptions are
// never sent with the wrong application-server key.
func (s *SubscriptionService) LoadActive(ctx context.Context, subscriptionID, vapidKeyID string) (StoredSubscription, error) {
	var stored StoredSubscription
	var encrypted string
	err := s.db.QueryRowContext(ctx, `SELECT id,user_id,vapid_key_id,encrypted_subscription
		FROM web_push_subscriptions WHERE id=? AND vapid_key_id=? AND revoked_at IS NULL`, subscriptionID, vapidKeyID).
		Scan(&stored.ID, &stored.UserID, &stored.VAPIDKeyID, &encrypted)
	if errors.Is(err, sql.ErrNoRows) {
		return StoredSubscription{}, domain.ErrNotFound
	}
	if err != nil {
		return StoredSubscription{}, fmt.Errorf("load Web Push subscription: %w", err)
	}
	payload, err := s.secrets.openSubscription(encrypted)
	if err != nil {
		return StoredSubscription{}, err
	}
	stored.Subscription, err = validatedSubscription(payload.Input)
	if err != nil {
		return StoredSubscription{}, fmt.Errorf("Web Push subscription envelope is invalid")
	}
	return stored, nil
}

// ListActiveForUser decrypts current-key subscriptions for an authenticated
// test delivery. It returns an empty slice when the account has no matching
// device and never returns revoked or stale-key entries.
func (s *SubscriptionService) ListActiveForUser(ctx context.Context, userID, vapidKeyID string) ([]StoredSubscription, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id,user_id,vapid_key_id,encrypted_subscription
		FROM web_push_subscriptions WHERE user_id=? AND vapid_key_id=? AND revoked_at IS NULL
		ORDER BY last_used_at DESC,id`, userID, vapidKeyID)
	if err != nil {
		return nil, fmt.Errorf("list active Web Push subscriptions: %w", err)
	}
	defer rows.Close()
	items := make([]StoredSubscription, 0)
	for rows.Next() {
		var item StoredSubscription
		var encrypted string
		if err := rows.Scan(&item.ID, &item.UserID, &item.VAPIDKeyID, &encrypted); err != nil {
			return nil, fmt.Errorf("scan active Web Push subscription: %w", err)
		}
		payload, err := s.secrets.openSubscription(encrypted)
		if err != nil {
			return nil, err
		}
		item.Subscription, err = validatedSubscription(payload.Input)
		if err != nil {
			return nil, fmt.Errorf("Web Push subscription envelope is invalid")
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate active Web Push subscriptions: %w", err)
	}
	return items, nil
}

// MarkUsed updates delivery activity without returning endpoint material.
func (s *SubscriptionService) MarkUsed(ctx context.Context, subscriptionID string) error {
	now := platform.Timestamp(platform.Now())
	_, err := s.db.ExecContext(ctx, `UPDATE web_push_subscriptions SET last_used_at=?,updated_at=?
		WHERE id=? AND revoked_at IS NULL`, now, now, subscriptionID)
	if err != nil {
		return fmt.Errorf("mark Web Push subscription used: %w", err)
	}
	return nil
}

// RevokeExpired revokes a subscription after a push service returns HTTP 404
// or 410. It is idempotent and intentionally does not require an account ID.
func (s *SubscriptionService) RevokeExpired(ctx context.Context, subscriptionID string) error {
	now := platform.Timestamp(platform.Now())
	_, err := s.db.ExecContext(ctx, `UPDATE web_push_subscriptions SET revoked_at=?,updated_at=?
		WHERE id=? AND revoked_at IS NULL`, now, now, subscriptionID)
	if err != nil {
		return fmt.Errorf("revoke expired Web Push subscription: %w", err)
	}
	return nil
}

func validatedSubscription(input SubscriptionInput) (*push.Subscription, error) {
	parsed, err := url.ParseRequestURI(input.Endpoint)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.Fragment != "" {
		return nil, domain.ValidationError{Field: "endpoint", Message: "must be an absolute HTTPS URL without credentials or a fragment"}
	}
	if input.Keys.Auth == "" || len(input.Keys.Auth) > maxAuthKeyTextLength ||
		input.Keys.P256DH == "" || len(input.Keys.P256DH) > maxP256DHTextLength {
		return nil, domain.ValidationError{Field: "keys", Message: "must contain bounded Web Push auth and P-256 keys"}
	}
	keys, err := push.DecodeSubscriptionKeys(input.Keys.Auth, input.Keys.P256DH)
	if err != nil {
		return nil, domain.ValidationError{Field: "keys", Message: "must contain valid Web Push auth and P-256 keys"}
	}
	return &push.Subscription{Endpoint: input.Endpoint, Keys: keys}, nil
}

func containsControl(value string) bool {
	for _, character := range value {
		if character < 32 || character == 127 {
			return true
		}
	}
	return false
}
