package auth

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/DasLukas/TeamTaler/internal/audit"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/media"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

const accountSecurityActionLifetime = time.Hour

// AccountCapabilities describes account-recovery operations currently
// available to clients. Both email-backed operations are unavailable unless
// delivery and at-rest token encryption are configured.
type AccountCapabilities struct {
	PasswordResetAvailable bool `json:"passwordResetAvailable"`
	EmailChangeAvailable   bool `json:"emailChangeAvailable"`
}

// AccountCapabilities reports the semantic account operations currently
// available. It has no side effects and cannot fail.
func (s Service) AccountCapabilities() AccountCapabilities {
	available := s.EmailDeliveryAvailable && s.TokenSealer != nil
	return AccountCapabilities{PasswordResetAvailable: available, EmailChangeAvailable: available}
}

// UpdateProfile changes the authenticated account's display name atomically
// and returns the refreshed principal. It returns validation, not-found, audit,
// or storage errors.
func (s Service) UpdateProfile(ctx context.Context, actor domain.Principal, displayName string) (domain.Principal, error) {
	displayName = strings.TrimSpace(displayName)
	if displayName == "" || utf8.RuneCountInString(displayName) > 120 || containsControlCharacter(displayName) {
		return domain.Principal{}, domain.ValidationError{Field: "displayName", Message: "must contain 1 to 120 characters without control characters"}
	}
	updated := actor
	err := storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		var email string
		var avatarKey sql.NullString
		if err := tx.QueryRowContext(ctx, `SELECT email,avatar_key FROM users
			WHERE id=? AND active=1 AND email IS NOT NULL AND password_hash IS NOT NULL`, actor.UserID).Scan(&email, &avatarKey); errors.Is(err, sql.ErrNoRows) {
			return domain.ErrNotFound
		} else if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE users SET display_name=?,updated_at=? WHERE id=?`, displayName, platform.Timestamp(platform.Now()), actor.UserID); err != nil {
			return err
		}
		if err := audit.Record(ctx, tx, "", actor.UserID, "", "account.profile.updated", "user", actor.UserID, map[string]any{}); err != nil {
			return err
		}
		updated.Email = email
		updated.DisplayName = displayName
		updated.AvatarURL = media.UserAvatarURL(actor.UserID, avatarKey.String)
		return nil
	})
	return updated, err
}

// ChangePassword verifies the current credential, stores the new credential,
// revokes every account session including the current one, and invalidates all
// outstanding account-security actions atomically.
func (s Service) ChangePassword(ctx context.Context, actor domain.Principal, currentPassword, newPassword string) error {
	if len(currentPassword) < 1 || len(currentPassword) > 1024 {
		return domain.ErrUnauthenticated
	}
	newHash, err := HashPassword(newPassword)
	if err != nil {
		return domain.ValidationError{Field: "newPassword", Message: err.Error()}
	}
	var currentHash string
	if err := s.DB.QueryRowContext(ctx, `SELECT password_hash FROM users
		WHERE id=? AND active=1 AND email IS NOT NULL AND password_hash IS NOT NULL`, actor.UserID).Scan(&currentHash); errors.Is(err, sql.ErrNoRows) {
		return domain.ErrUnauthenticated
	} else if err != nil {
		return err
	}
	if !VerifyPassword(currentHash, currentPassword) {
		return domain.ErrUnauthenticated
	}
	if VerifyPassword(currentHash, newPassword) {
		return domain.ValidationError{Field: "newPassword", Message: "must differ from the current password"}
	}
	now := platform.Now()
	return storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		result, err := tx.ExecContext(ctx, `UPDATE users SET password_hash=?,updated_at=?
			WHERE id=? AND active=1 AND password_hash=?`, newHash, platform.Timestamp(now), actor.UserID, currentHash)
		if err != nil {
			return err
		}
		if changed, _ := result.RowsAffected(); changed != 1 {
			return fmt.Errorf("%w: account credential changed concurrently", domain.ErrConflict)
		}
		return finishSensitiveAccountChange(ctx, tx, actor.UserID, "account.password.changed", "", now)
	})
}

// StartPasswordReset creates a one-time email action for an active account. It
// deliberately succeeds when no account matches, preventing account discovery.
// Email delivery must be available when the action starts.
func (s Service) StartPasswordReset(ctx context.Context, email string) error {
	if !s.AccountCapabilities().PasswordResetAvailable {
		return fmt.Errorf("password reset: %w", domain.ErrServiceUnavailable)
	}
	token, err := platform.NewSecret()
	if err != nil {
		return err
	}
	ciphertext, err := s.TokenSealer.Seal(token)
	if err != nil {
		return fmt.Errorf("seal account action token: %w", err)
	}
	normalized, err := platform.NormalizeEmail(email)
	if err != nil {
		// Invalid addresses use the same accepted result as unknown accounts.
		return nil
	}
	var userID, passwordHash string
	err = s.DB.QueryRowContext(ctx, `SELECT id,password_hash FROM users
		WHERE email=? AND active=1 AND email IS NOT NULL AND password_hash IS NOT NULL`, normalized).Scan(&userID, &passwordHash)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	err = s.persistAccountSecurityAction(ctx, userID, "PASSWORD_RESET", normalized, "", passwordHash, token, ciphertext)
	if errors.Is(err, domain.ErrNotFound) || errors.Is(err, domain.ErrConflict) {
		// Account state races preserve the endpoint's non-enumerating response.
		return nil
	}
	return err
}

// ConfirmPasswordReset consumes a one-time reset token, stores the new
// password, revokes every account session, and invalidates remaining actions.
// Confirmation remains available when email delivery is later disabled.
func (s Service) ConfirmPasswordReset(ctx context.Context, token, newPassword string) error {
	token = strings.TrimSpace(token)
	if token == "" || len(token) > 256 {
		return domain.ValidationError{Field: "token", Message: "is required"}
	}
	newHash, err := HashPassword(newPassword)
	if err != nil {
		return domain.ValidationError{Field: "newPassword", Message: err.Error()}
	}
	now := platform.Now()
	return storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		action, err := loadOpenAccountAction(ctx, tx, "PASSWORD_RESET", token)
		if err != nil {
			return err
		}
		if err := validateAccountAction(action, now); err != nil {
			return err
		}
		result, err := tx.ExecContext(ctx, `UPDATE users SET password_hash=?,updated_at=?
			WHERE id=? AND active=1 AND email=? AND password_hash IS NOT NULL`, newHash, platform.Timestamp(now), action.UserID, action.SourceEmail)
		if err != nil {
			return err
		}
		if changed, _ := result.RowsAffected(); changed != 1 {
			return domain.ErrNotFound
		}
		return finishSensitiveAccountChange(ctx, tx, action.UserID, "account.password.reset", action.ID, now)
	})
}

// StartEmailChange verifies the current password and creates a one-time action
// addressed to the requested mailbox. It returns validation, authentication,
// conflict, service-unavailable, encryption, or storage errors.
func (s Service) StartEmailChange(ctx context.Context, actor domain.Principal, newEmail, currentPassword string) error {
	if !s.AccountCapabilities().EmailChangeAvailable {
		return fmt.Errorf("email change: %w", domain.ErrServiceUnavailable)
	}
	target, err := platform.NormalizeEmail(newEmail)
	if err != nil {
		return domain.ValidationError{Field: "newEmail", Message: "must be a valid email address"}
	}
	if len(currentPassword) < 1 || len(currentPassword) > 1024 {
		return domain.ErrUnauthenticated
	}
	var source, passwordHash string
	if err := s.DB.QueryRowContext(ctx, `SELECT email,password_hash FROM users
		WHERE id=? AND active=1 AND email IS NOT NULL AND password_hash IS NOT NULL`, actor.UserID).Scan(&source, &passwordHash); errors.Is(err, sql.ErrNoRows) {
		return domain.ErrUnauthenticated
	} else if err != nil {
		return err
	}
	if !VerifyPassword(passwordHash, currentPassword) {
		return domain.ErrUnauthenticated
	}
	if strings.EqualFold(source, target) {
		return domain.ValidationError{Field: "newEmail", Message: "must differ from the current email address"}
	}
	var used int
	if err := s.DB.QueryRowContext(ctx, `SELECT count(*) FROM users WHERE email=? AND id<>?`, target, actor.UserID).Scan(&used); err != nil {
		return err
	}
	if used != 0 {
		return fmt.Errorf("%w: email address cannot be used", domain.ErrConflict)
	}
	return s.createAccountSecurityAction(ctx, actor.UserID, "EMAIL_CHANGE", source, target, passwordHash)
}

// ConfirmEmailChange consumes a one-time token, switches the account mailbox,
// revokes every account session, and invalidates remaining actions atomically.
// Confirmation does not depend on the current email-delivery configuration.
func (s Service) ConfirmEmailChange(ctx context.Context, token string) error {
	token = strings.TrimSpace(token)
	if token == "" || len(token) > 256 {
		return domain.ValidationError{Field: "token", Message: "is required"}
	}
	now := platform.Now()
	err := storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		action, err := loadOpenAccountAction(ctx, tx, "EMAIL_CHANGE", token)
		if err != nil {
			return err
		}
		if err := validateAccountAction(action, now); err != nil {
			return err
		}
		result, err := tx.ExecContext(ctx, `UPDATE users SET email=?,updated_at=?
			WHERE id=? AND active=1 AND email=? AND password_hash IS NOT NULL`, action.TargetEmail.String, platform.Timestamp(now), action.UserID, action.SourceEmail)
		if err != nil {
			if isUniqueConstraint(err) {
				return fmt.Errorf("%w: email address cannot be used", domain.ErrConflict)
			}
			return err
		}
		if changed, _ := result.RowsAffected(); changed != 1 {
			return domain.ErrNotFound
		}
		return finishSensitiveAccountChange(ctx, tx, action.UserID, "account.email.changed", action.ID, now)
	})
	return err
}

func (s Service) createAccountSecurityAction(ctx context.Context, userID, kind, sourceEmail, targetEmail, expectedPasswordHash string) error {
	token, err := platform.NewSecret()
	if err != nil {
		return err
	}
	ciphertext, err := s.TokenSealer.Seal(token)
	if err != nil {
		return fmt.Errorf("seal account action token: %w", err)
	}
	return s.persistAccountSecurityAction(ctx, userID, kind, sourceEmail, targetEmail, expectedPasswordHash, token, ciphertext)
}

func (s Service) persistAccountSecurityAction(ctx context.Context, userID, kind, sourceEmail, targetEmail, expectedPasswordHash, token, ciphertext string) error {
	actionID, err := platform.NewID("act")
	if err != nil {
		return err
	}
	now := platform.Now()
	return storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		var currentSource, currentPasswordHash string
		if err := tx.QueryRowContext(ctx, `SELECT email,password_hash FROM users
			WHERE id=? AND active=1 AND email IS NOT NULL AND password_hash IS NOT NULL`, userID).Scan(&currentSource, &currentPasswordHash); errors.Is(err, sql.ErrNoRows) {
			return domain.ErrNotFound
		} else if err != nil {
			return err
		}
		if !strings.EqualFold(currentSource, sourceEmail) {
			return fmt.Errorf("%w: account email changed concurrently", domain.ErrConflict)
		}
		if expectedPasswordHash != "" && currentPasswordHash != expectedPasswordHash {
			return fmt.Errorf("%w: account credential changed concurrently", domain.ErrConflict)
		}
		if kind == "EMAIL_CHANGE" {
			if err := invalidateExpiredEmailTarget(ctx, tx, targetEmail, now); err != nil {
				return err
			}
		}
		if err := invalidateAccountActions(ctx, tx, userID, kind, "", now); err != nil {
			return err
		}
		var target any
		if targetEmail != "" {
			target = targetEmail
		}
		timestamp := platform.Timestamp(now)
		_, err := tx.ExecContext(ctx, `INSERT INTO account_security_actions
			(id,user_id,kind,source_email,target_email,token_hash,expires_at,created_at)
			VALUES(?,?,?,?,?,?,?,?)`, actionID, userID, kind, sourceEmail, target, platform.HashSecret(token), platform.Timestamp(now.Add(accountSecurityActionLifetime)), timestamp)
		if err != nil {
			if isUniqueConstraint(err) {
				return fmt.Errorf("%w: account security action conflicts with an existing action", domain.ErrConflict)
			}
			return err
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO account_security_email_outbox
			(action_id,token_ciphertext,status,attempt_count,next_attempt_at,created_at,updated_at)
			VALUES(?,?,'PENDING',0,?,?,?)`, actionID, ciphertext, timestamp, timestamp, timestamp)
		return err
	})
}

func invalidateExpiredEmailTarget(ctx context.Context, tx *sql.Tx, targetEmail string, now time.Time) error {
	nowText := platform.Timestamp(now)
	if _, err := tx.ExecContext(ctx, `UPDATE account_security_actions SET invalidated_at=?
		WHERE kind='EMAIL_CHANGE' AND target_email=? COLLATE NOCASE AND expires_at<=?
		AND consumed_at IS NULL AND invalidated_at IS NULL`, nowText, targetEmail, nowText); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `UPDATE account_security_email_outbox SET
		status='CANCELLED',token_ciphertext=NULL,next_attempt_at=NULL,lease_token=NULL,lease_until=NULL,
		last_error_code='account_action_expired',updated_at=?
		WHERE action_id IN (SELECT id FROM account_security_actions
			WHERE kind='EMAIL_CHANGE' AND target_email=? COLLATE NOCASE AND invalidated_at IS NOT NULL)
		AND status IN ('PENDING','SENDING','FAILED')`, nowText, targetEmail)
	return err
}

type accountSecurityAction struct {
	ID          string
	UserID      string
	SourceEmail string
	TargetEmail sql.NullString
	ExpiresAt   time.Time
}

func loadOpenAccountAction(ctx context.Context, tx *sql.Tx, kind, token string) (accountSecurityAction, error) {
	var action accountSecurityAction
	var expiry string
	err := tx.QueryRowContext(ctx, `SELECT id,user_id,source_email,target_email,expires_at
		FROM account_security_actions WHERE kind=? AND token_hash=?
		AND consumed_at IS NULL AND invalidated_at IS NULL`, kind, platform.HashSecret(token)).
		Scan(&action.ID, &action.UserID, &action.SourceEmail, &action.TargetEmail, &expiry)
	if errors.Is(err, sql.ErrNoRows) {
		return accountSecurityAction{}, domain.ErrNotFound
	}
	if err != nil {
		return accountSecurityAction{}, err
	}
	action.ExpiresAt, err = time.Parse(time.RFC3339Nano, expiry)
	if err != nil {
		return accountSecurityAction{}, fmt.Errorf("parse account action expiry: %w", err)
	}
	return action, nil
}

func validateAccountAction(action accountSecurityAction, now time.Time) error {
	if !action.ExpiresAt.After(now) {
		return fmt.Errorf("%w: account action has expired", domain.ErrConflict)
	}
	if action.TargetEmail.Valid {
		if _, err := platform.NormalizeEmail(action.TargetEmail.String); err != nil {
			return domain.ErrNotFound
		}
	}
	return nil
}

func finishSensitiveAccountChange(ctx context.Context, tx *sql.Tx, userID, auditAction, consumedActionID string, now time.Time) error {
	if consumedActionID != "" {
		result, err := tx.ExecContext(ctx, `UPDATE account_security_actions SET consumed_at=?
			WHERE id=? AND consumed_at IS NULL AND invalidated_at IS NULL`, platform.Timestamp(now), consumedActionID)
		if err != nil {
			return err
		}
		if changed, _ := result.RowsAffected(); changed != 1 {
			return domain.ErrNotFound
		}
		if _, err := tx.ExecContext(ctx, `UPDATE account_security_email_outbox SET
			status='CANCELLED',token_ciphertext=NULL,next_attempt_at=NULL,lease_token=NULL,lease_until=NULL,
			last_error_code='account_action_consumed',updated_at=?
			WHERE action_id=? AND status IN ('PENDING','SENDING','FAILED')`, platform.Timestamp(now), consumedActionID); err != nil {
			return err
		}
	}
	if err := invalidateAccountActions(ctx, tx, userID, "", consumedActionID, now); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM sessions WHERE user_id=?`, userID); err != nil {
		return err
	}
	return audit.Record(ctx, tx, "", userID, "", auditAction, "user", userID, map[string]any{})
}

func invalidateAccountActions(ctx context.Context, tx *sql.Tx, userID, kind, excludedID string, now time.Time) error {
	args := []any{platform.Timestamp(now), userID}
	filter := "user_id=? AND consumed_at IS NULL AND invalidated_at IS NULL"
	if kind != "" {
		filter += " AND kind=?"
		args = append(args, kind)
	}
	if excludedID != "" {
		filter += " AND id<>?"
		args = append(args, excludedID)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE account_security_actions SET invalidated_at=? WHERE `+filter, args...); err != nil {
		return err
	}
	outboxArgs := []any{platform.Timestamp(now), userID}
	outboxFilter := "action_id IN (SELECT id FROM account_security_actions WHERE user_id=? AND invalidated_at IS NOT NULL)"
	if excludedID != "" {
		outboxFilter += " AND action_id<>?"
		outboxArgs = append(outboxArgs, excludedID)
	}
	_, err := tx.ExecContext(ctx, `UPDATE account_security_email_outbox SET
		status='CANCELLED',token_ciphertext=NULL,next_attempt_at=NULL,lease_token=NULL,lease_until=NULL,
		last_error_code='account_action_invalidated',updated_at=?
		WHERE `+outboxFilter+` AND status IN ('PENDING','SENDING','FAILED')`, outboxArgs...)
	return err
}

func isUniqueConstraint(err error) bool {
	return err != nil && strings.Contains(strings.ToLower(err.Error()), "unique constraint failed")
}
