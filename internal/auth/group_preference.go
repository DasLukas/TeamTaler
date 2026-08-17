package auth

import (
	"context"
	"database/sql"
	"errors"

	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/platform"
)

// GroupPreference stores one account's fixed default group and most recently
// selected group. A nil DefaultGroupID selects last-used-group behavior.
type GroupPreference struct {
	DefaultGroupID  *string
	LastUsedGroupID *string
}

// ReadGroupPreference loads the authenticated account's persisted group
// selection preference.
//
// Parameters:
//   - ctx: Bounds the database read.
//   - userID: Account whose preference is requested.
//
// Returns:
//   - GroupPreference: Fixed and last-used group identifiers, when present.
//   - error: ErrNotFound for an inactive or unknown account, otherwise a
//     database error.
//
// Example: ReadGroupPreference(ctx, principal.UserID).
func (s Service) ReadGroupPreference(ctx context.Context, userID string) (GroupPreference, error) {
	var defaultGroupID, lastUsedGroupID sql.NullString
	err := s.DB.QueryRowContext(ctx, `SELECT default_group_id,last_used_group_id FROM users WHERE id=? AND active=1`, userID).
		Scan(&defaultGroupID, &lastUsedGroupID)
	if errors.Is(err, sql.ErrNoRows) {
		return GroupPreference{}, domain.ErrNotFound
	}
	if err != nil {
		return GroupPreference{}, err
	}
	return GroupPreference{
		DefaultGroupID:  nullableGroupID(defaultGroupID),
		LastUsedGroupID: nullableGroupID(lastUsedGroupID),
	}, nil
}

// UpdateDefaultGroup replaces the account's login-group preference. A nil
// groupID selects the most recently used active group.
//
// Parameters:
//   - ctx: Bounds validation and persistence.
//   - actor: Authenticated account changing its own preference.
//   - groupID: Active group membership to open after login, or nil for last-used.
//
// Returns:
//   - error: Validation, not-found, or database errors.
//
// Example: UpdateDefaultGroup(ctx, principal, &groupID).
func (s Service) UpdateDefaultGroup(ctx context.Context, actor domain.Principal, groupID *string) error {
	var storedGroupID any
	if groupID != nil {
		if err := s.requireActiveGroupMembership(ctx, actor.UserID, *groupID); err != nil {
			return err
		}
		storedGroupID = *groupID
	}
	result, err := s.DB.ExecContext(ctx, `UPDATE users SET default_group_id=?,updated_at=? WHERE id=? AND active=1`, storedGroupID, platform.Timestamp(platform.Now()), actor.UserID)
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

// RecordLastUsedGroup persists an account's explicit active-group selection
// without changing its fixed default-group preference.
//
// Parameters:
//   - ctx: Bounds validation and persistence.
//   - actor: Authenticated account selecting a group.
//   - groupID: Active group membership that was selected.
//
// Returns:
//   - error: Validation, not-found, or database errors.
//
// Example: RecordLastUsedGroup(ctx, principal, groupID).
func (s Service) RecordLastUsedGroup(ctx context.Context, actor domain.Principal, groupID string) error {
	if err := s.requireActiveGroupMembership(ctx, actor.UserID, groupID); err != nil {
		return err
	}
	result, err := s.DB.ExecContext(ctx, `UPDATE users SET last_used_group_id=?,updated_at=? WHERE id=? AND active=1`, groupID, platform.Timestamp(platform.Now()), actor.UserID)
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

func (s Service) requireActiveGroupMembership(ctx context.Context, userID, groupID string) error {
	if groupID == "" {
		return domain.ValidationError{Field: "groupId", Message: "must identify an active group membership"}
	}
	var exists int
	if err := s.DB.QueryRowContext(ctx, `SELECT exists(
		SELECT 1 FROM memberships membership
		JOIN groups team ON team.id=membership.group_id AND team.status='ACTIVE'
		WHERE membership.user_id=? AND membership.group_id=? AND membership.status='ACTIVE' AND membership.deleted_at IS NULL
	)`, userID, groupID).Scan(&exists); err != nil {
		return err
	}
	if exists == 0 {
		return domain.ValidationError{Field: "groupId", Message: "must identify an active group membership"}
	}
	return nil
}

func nullableGroupID(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	groupID := value.String
	return &groupID
}
