package groups

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/DasLukas/TeamTaler/internal/audit"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

const (
	minimumPublicJoinLifetime = time.Hour
	maximumPublicJoinLifetime = 365 * 24 * time.Hour
)

// PublicJoinLink describes the single member-manager-owned public onboarding
// link for a group. Token is intentionally excluded from JSON and is exposed
// only to the authenticated HTTP adapter for same-origin URL construction.
type PublicJoinLink struct {
	Enabled                    bool    `json:"enabled"`
	Expired                    bool    `json:"expired"`
	ExpiresAt                  *string `json:"expiresAt"`
	Version                    int64   `json:"version"`
	CreatedAt                  string  `json:"createdAt,omitempty"`
	UpdatedAt                  string  `json:"updatedAt,omitempty"`
	EmailVerificationAvailable bool    `json:"emailVerificationAvailable"`
	Token                      string  `json:"-"`
}

// GetPublicJoinLink returns the current group-scoped join-link state. A group
// without a persisted link receives a disabled version-zero resource. The
// caller must hold MEMBER_MANAGEMENT. The method returns authorization,
// decryption, and database errors.
func (s Service) GetPublicJoinLink(ctx context.Context, membership domain.Membership) (PublicJoinLink, error) {
	if err := requireCurrentPermission(ctx, s.DB, membership, domain.PermissionMemberManagement); err != nil {
		return PublicJoinLink{}, err
	}
	item, err := queryPublicJoinLink(ctx, s.DB, membership.GroupID)
	if errors.Is(err, sql.ErrNoRows) {
		return PublicJoinLink{Version: 0, EmailVerificationAvailable: s.publicJoinAvailable()}, nil
	}
	if err != nil {
		return PublicJoinLink{}, err
	}
	item.EmailVerificationAvailable = s.publicJoinAvailable()
	item.Expired = item.Enabled && publicJoinExpired(item.ExpiresAt, platform.Now())
	if item.Enabled && !item.Expired {
		if s.TokenOpener == nil {
			return PublicJoinLink{}, fmt.Errorf("open public join link: %w", domain.ErrServiceUnavailable)
		}
		item.Token, err = s.TokenOpener.Open(item.Token)
		if err != nil {
			return PublicJoinLink{}, fmt.Errorf("open public join link token: %w", err)
		}
	}
	return item, nil
}

// PutPublicJoinLink creates or replaces the desired enabled state and expiry of
// a group's single public join link. A nil expiry means unlimited availability.
// Existing resources require their exact positive expectedVersion; version zero
// creates the first resource. Enabling a disabled or expired resource issues a
// fresh token, while changing a current expiry preserves the token. The method
// returns the persisted link or validation, precondition, authorization,
// encryption, audit, and database errors.
func (s Service) PutPublicJoinLink(ctx context.Context, actor domain.Principal, membership domain.Membership, enabled bool, expiresAt *string, expectedVersion int64) (PublicJoinLink, error) {
	if expectedVersion < 0 {
		return PublicJoinLink{}, fmt.Errorf("%w: link version must not be negative", domain.ErrPrecondition)
	}
	var normalizedExpiry *string
	var err error
	if enabled {
		normalizedExpiry, err = validatePublicJoinExpiry(expiresAt, platform.Now())
		if err != nil {
			return PublicJoinLink{}, err
		}
	}
	if enabled && !s.publicJoinAvailable() {
		return PublicJoinLink{}, fmt.Errorf("%w: verified public registration requires configured email delivery", domain.ErrServiceUnavailable)
	}
	if err := requireCurrentPermission(ctx, s.DB, membership, domain.PermissionMemberManagement); err != nil {
		return PublicJoinLink{}, err
	}
	var item PublicJoinLink
	err = storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		if err := requireCurrentPermission(ctx, tx, membership, domain.PermissionMemberManagement); err != nil {
			return err
		}
		if enabled {
			if err := ensurePublicJoinDefaultRole(ctx, tx, membership.GroupID); err != nil {
				return err
			}
		}
		current, queryErr := queryPublicJoinLink(ctx, tx, membership.GroupID)
		exists := queryErr == nil
		if queryErr != nil && !errors.Is(queryErr, sql.ErrNoRows) {
			return queryErr
		}
		if (!exists && expectedVersion != 0) || (exists && current.Version != expectedVersion) {
			return domain.ErrPrecondition
		}
		nowValue := platform.Now()
		now := platform.Timestamp(nowValue)
		if !exists {
			item = PublicJoinLink{Enabled: enabled, ExpiresAt: normalizedExpiry, Version: 1, CreatedAt: now, UpdatedAt: now}
			var tokenHash, tokenCiphertext any
			if enabled {
				token, hash, ciphertext, tokenErr := s.newPublicJoinToken()
				if tokenErr != nil {
					return tokenErr
				}
				item.Token = token
				tokenHash, tokenCiphertext = hash, ciphertext
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO public_join_links(group_id,token_hash,token_ciphertext,enabled,expires_at,version,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?,?,?)`, membership.GroupID, tokenHash, tokenCiphertext, enabled, nullableText(normalizedExpiry), actor.UserID, actor.UserID, now, now); err != nil {
				return err
			}
		} else {
			rotate := enabled && (!current.Enabled || publicJoinExpired(current.ExpiresAt, nowValue))
			item = current
			item.Enabled = enabled
			item.ExpiresAt = normalizedExpiry
			item.Token = ""
			item.Version++
			item.UpdatedAt = now
			var tokenHash, tokenCiphertext any
			if enabled && !rotate {
				var ciphertext string
				if err := tx.QueryRowContext(ctx, `SELECT token_hash,token_ciphertext FROM public_join_links WHERE group_id=?`, membership.GroupID).Scan(&tokenHash, &ciphertext); err != nil {
					return err
				}
				tokenCiphertext = ciphertext
				if s.TokenOpener == nil {
					return fmt.Errorf("open public join link: %w", domain.ErrServiceUnavailable)
				}
				item.Token, err = s.TokenOpener.Open(ciphertext)
				if err != nil {
					return fmt.Errorf("open public join link token: %w", err)
				}
			} else if enabled {
				token, hash, ciphertext, tokenErr := s.newPublicJoinToken()
				if tokenErr != nil {
					return tokenErr
				}
				item.Token, tokenHash, tokenCiphertext = token, hash, ciphertext
			}
			if !enabled || rotate {
				if err := invalidatePublicJoinRegistrations(ctx, tx, membership.GroupID, now); err != nil {
					return err
				}
			}
			result, err := tx.ExecContext(ctx, `UPDATE public_join_links SET token_hash=?,token_ciphertext=?,enabled=?,expires_at=?,version=version+1,updated_by=?,updated_at=? WHERE group_id=? AND version=?`, tokenHash, tokenCiphertext, enabled, nullableText(normalizedExpiry), actor.UserID, now, membership.GroupID, current.Version)
			if err != nil {
				return err
			}
			changed, _ := result.RowsAffected()
			if changed != 1 {
				return domain.ErrPrecondition
			}
		}
		event := "public_join_link.updated"
		if !exists {
			event = "public_join_link.created"
		} else if !enabled {
			event = "public_join_link.disabled"
		}
		return audit.Record(ctx, tx, membership.GroupID, actor.UserID, membership.ID, event, "public_join_link", membership.GroupID, map[string]any{"enabled": enabled, "expiresAt": normalizedExpiry, "version": item.Version})
	})
	item.EmailVerificationAvailable = s.publicJoinAvailable()
	item.Expired = item.Enabled && publicJoinExpired(item.ExpiresAt, platform.Now())
	return item, err
}

// RotatePublicJoinLink replaces the token for a current enabled, unexpired link
// without changing its expiry. All pending registrations from the previous
// version are invalidated atomically. expectedVersion must match exactly. The
// method returns the rotated resource or precondition, state, authorization,
// encryption, audit, and database errors.
func (s Service) RotatePublicJoinLink(ctx context.Context, actor domain.Principal, membership domain.Membership, expectedVersion int64) (PublicJoinLink, error) {
	if expectedVersion < 1 {
		return PublicJoinLink{}, fmt.Errorf("%w: a current link version is required", domain.ErrPrecondition)
	}
	if !s.publicJoinAvailable() {
		return PublicJoinLink{}, fmt.Errorf("%w: verified public registration requires configured email delivery", domain.ErrServiceUnavailable)
	}
	if err := requireCurrentPermission(ctx, s.DB, membership, domain.PermissionMemberManagement); err != nil {
		return PublicJoinLink{}, err
	}
	var item PublicJoinLink
	err := storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		if err := requireCurrentPermission(ctx, tx, membership, domain.PermissionMemberManagement); err != nil {
			return err
		}
		if err := ensurePublicJoinDefaultRole(ctx, tx, membership.GroupID); err != nil {
			return err
		}
		current, err := queryPublicJoinLink(ctx, tx, membership.GroupID)
		if errors.Is(err, sql.ErrNoRows) {
			return domain.ErrNotFound
		}
		if err != nil {
			return err
		}
		if current.Version != expectedVersion {
			return domain.ErrPrecondition
		}
		if !current.Enabled || publicJoinExpired(current.ExpiresAt, platform.Now()) {
			return fmt.Errorf("%w: public join link is disabled or expired", domain.ErrConflict)
		}
		token, tokenHash, tokenCiphertext, err := s.newPublicJoinToken()
		if err != nil {
			return err
		}
		now := platform.Timestamp(platform.Now())
		if err := invalidatePublicJoinRegistrations(ctx, tx, membership.GroupID, now); err != nil {
			return err
		}
		result, err := tx.ExecContext(ctx, `UPDATE public_join_links SET token_hash=?,token_ciphertext=?,version=version+1,updated_by=?,updated_at=? WHERE group_id=? AND version=?`, tokenHash, tokenCiphertext, actor.UserID, now, membership.GroupID, current.Version)
		if err != nil {
			return err
		}
		changed, _ := result.RowsAffected()
		if changed != 1 {
			return domain.ErrPrecondition
		}
		item = current
		item.Token = token
		item.Version++
		item.UpdatedAt = now
		return audit.Record(ctx, tx, membership.GroupID, actor.UserID, membership.ID, "public_join_link.rotated", "public_join_link", membership.GroupID, map[string]any{"version": item.Version})
	})
	item.EmailVerificationAvailable = s.publicJoinAvailable()
	item.Expired = item.Enabled && publicJoinExpired(item.ExpiresAt, platform.Now())
	return item, err
}

func (s Service) publicJoinAvailable() bool {
	return s.EmailDeliveryAvailable && s.TokenSealer != nil && s.TokenOpener != nil
}

func (s Service) newPublicJoinToken() (string, string, string, error) {
	if s.TokenSealer == nil {
		return "", "", "", fmt.Errorf("seal public join link: %w", domain.ErrServiceUnavailable)
	}
	token, err := platform.NewSecret()
	if err != nil {
		return "", "", "", err
	}
	ciphertext, err := s.TokenSealer.Seal(token)
	if err != nil {
		return "", "", "", fmt.Errorf("seal public join link token: %w", err)
	}
	return token, platform.HashSecret(token), ciphertext, nil
}

func validatePublicJoinExpiry(value *string, now time.Time) (*string, error) {
	if value == nil {
		return nil, nil
	}
	trimmed := strings.TrimSpace(*value)
	expires, err := time.Parse(time.RFC3339Nano, trimmed)
	if err != nil {
		return nil, domain.ValidationError{Field: "expiresAt", Message: "must be an RFC 3339 date-time or null"}
	}
	expires = expires.UTC()
	// Allow one minute for client/server clock skew and request transit while the
	// UI still presents an exact one-hour minimum.
	if expires.Before(now.Add(minimumPublicJoinLifetime-time.Minute)) || expires.After(now.Add(maximumPublicJoinLifetime)) {
		return nil, domain.ValidationError{Field: "expiresAt", Message: "must be between one hour and 365 days in the future"}
	}
	normalized := platform.Timestamp(expires)
	return &normalized, nil
}

func ensurePublicJoinDefaultRole(ctx context.Context, queryer settingsQueryer, groupID string) error {
	var roleID sql.NullString
	if err := queryer.QueryRowContext(ctx, `SELECT default_role_id FROM group_settings WHERE group_id=?`, groupID).Scan(&roleID); errors.Is(err, sql.ErrNoRows) {
		return domain.ErrNotFound
	} else if err != nil {
		return err
	}
	if !roleID.Valid || strings.TrimSpace(roleID.String) == "" {
		return domain.ValidationError{Field: "defaultRoleId", Message: "must be configured before enabling a public join link"}
	}
	return validateDefaultRole(ctx, queryer, groupID, roleID.String)
}

func queryPublicJoinLink(ctx context.Context, queryer settingsQueryer, groupID string) (PublicJoinLink, error) {
	var item PublicJoinLink
	var expiresAt sql.NullString
	var tokenCiphertext sql.NullString
	err := queryer.QueryRowContext(ctx, `SELECT enabled,expires_at,version,created_at,updated_at,token_ciphertext FROM public_join_links WHERE group_id=?`, groupID).
		Scan(&item.Enabled, &expiresAt, &item.Version, &item.CreatedAt, &item.UpdatedAt, &tokenCiphertext)
	if expiresAt.Valid {
		item.ExpiresAt = &expiresAt.String
	}
	if tokenCiphertext.Valid {
		item.Token = tokenCiphertext.String
	}
	return item, err
}

func publicJoinExpired(expiresAt *string, now time.Time) bool {
	if expiresAt == nil {
		return false
	}
	parsed, err := time.Parse(time.RFC3339Nano, *expiresAt)
	return err != nil || !parsed.After(now)
}

func invalidatePublicJoinRegistrations(ctx context.Context, tx *sql.Tx, groupID, now string) error {
	if _, err := tx.ExecContext(ctx, `UPDATE public_join_registrations SET invalidated_at=? WHERE group_id=? AND consumed_at IS NULL AND invalidated_at IS NULL`, now, groupID); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `UPDATE public_join_email_outbox SET status='CANCELLED',token_ciphertext=NULL,next_attempt_at=NULL,lease_token=NULL,lease_until=NULL,last_error_code='join_link_invalidated',updated_at=? WHERE group_id=? AND status IN ('PENDING','SENDING','FAILED')`, now, groupID)
	return err
}
