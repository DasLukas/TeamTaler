package auth

import (
	"context"
	"database/sql"
	"errors"

	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/platform"
)

// ReadColorMode loads the persisted appearance mode for an active account.
//
// Parameters:
//   - ctx: Bounds the database read.
//   - userID: Account whose appearance mode is requested.
//
// Returns:
//   - domain.ColorMode: The persisted SYSTEM, LIGHT, or DARK mode.
//   - error: ErrNotFound for an inactive or unknown account, otherwise a
//     database error.
//
// Example: ReadColorMode(ctx, principal.UserID).
func (s Service) ReadColorMode(ctx context.Context, userID string) (domain.ColorMode, error) {
	var mode domain.ColorMode
	err := s.DB.QueryRowContext(ctx, `SELECT color_mode FROM users WHERE id=? AND active=1`, userID).Scan(&mode)
	if errors.Is(err, sql.ErrNoRows) {
		return "", domain.ErrNotFound
	}
	return mode, err
}

// UpdateColorMode validates and persists one active account's color-mode
// preference.
//
// Parameters:
//   - ctx: Bounds validation and persistence.
//   - actor: Authenticated account changing its own preference.
//   - mode: SYSTEM, LIGHT, or DARK.
//
// Returns:
//   - error: Validation, not-found, or database errors.
//
// Example: UpdateColorMode(ctx, principal, domain.ColorModeDark).
func (s Service) UpdateColorMode(ctx context.Context, actor domain.Principal, mode domain.ColorMode) error {
	if !mode.Valid() {
		return domain.ValidationError{Field: "colorMode", Message: "must be SYSTEM, LIGHT, or DARK"}
	}
	result, err := s.DB.ExecContext(ctx, `UPDATE users SET color_mode=?,updated_at=? WHERE id=? AND active=1`, mode, platform.Timestamp(platform.Now()), actor.UserID)
	if err != nil {
		return err
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if changed != 1 {
		return domain.ErrNotFound
	}
	return nil
}
