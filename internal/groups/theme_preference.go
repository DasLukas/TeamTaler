package groups

import (
	"context"
	"database/sql"

	"github.com/DasLukas/TeamTaler/internal/domain"
)

// UpdateThemePreference persists an authenticated member's optional theme
// override for one active group. A nil override follows the group's current
// and future default theme.
//
// Parameters:
//   - ctx: Bounds validation and persistence.
//   - actor: Authenticated account changing its own preference.
//   - membership: Actor's active membership resolved from the request group.
//   - themeOverride: Supported theme identifier, or nil for group default.
//
// Returns:
//   - error: Validation, forbidden, not-found, or database errors.
//
// Example: UpdateThemePreference(ctx, principal, membership, nil).
func (s Service) UpdateThemePreference(ctx context.Context, actor domain.Principal, membership domain.Membership, themeOverride *domain.ThemeID) error {
	if themeOverride != nil && !themeOverride.Valid() {
		return domain.ValidationError{Field: "themeOverride", Message: "must be TEAMTALER, NRW, TIEF_IM_WESTEN, FIRE, or null"}
	}
	if membership.UserID != actor.UserID || membership.Status != domain.MembershipStatusActive {
		return domain.ErrForbidden
	}
	var storedTheme any
	if themeOverride != nil {
		storedTheme = *themeOverride
	}
	result, err := s.DB.ExecContext(ctx, `UPDATE memberships SET theme_override=?
		WHERE id=? AND group_id=? AND user_id=? AND status='ACTIVE' AND deleted_at IS NULL
		AND EXISTS(SELECT 1 FROM groups WHERE id=? AND status='ACTIVE')`,
		storedTheme, membership.ID, membership.GroupID, actor.UserID, membership.GroupID)
	if err != nil {
		return err
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if changed != 1 {
		var exists int
		if err := s.DB.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM memberships WHERE id=? AND group_id=?)`, membership.ID, membership.GroupID).Scan(&exists); err != nil {
			return err
		}
		if exists == 0 {
			return domain.ErrNotFound
		}
		return domain.ErrForbidden
	}
	return nil
}

func nullableThemeID(value sql.NullString) *domain.ThemeID {
	if !value.Valid {
		return nil
	}
	theme := domain.ThemeID(value.String)
	return &theme
}
