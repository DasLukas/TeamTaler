package groups

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/DasLukas/TeamTaler/internal/audit"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

// ReactivateMemberInput is the complete reactivation command for an archived
// membership. Credentialed members require roles; temporary guests remain
// roleless and may receive a replacement display name.
type ReactivateMemberInput struct {
	DisplayName string   `json:"displayName,omitempty"`
	RoleIDs     []string `json:"roleIds"`
}

// ReactivateMember restores one archived membership without changing its
// stable identifier or financial history.
//
// Parameters:
//   - ctx: Cancellation and deadline context.
//   - actor: Authenticated administrator recorded in the audit trail.
//   - actorMembership: Administrator membership and tenant scope.
//   - targetMembershipID: Archived membership to restore.
//   - input: Optional guest name and complete role selection.
//
// Returns:
//   - domain.Membership: Restored active membership.
//   - error: Validation, authorization, conflict, tenant, audit, or storage error.
func (s Service) ReactivateMember(ctx context.Context, actor domain.Principal, actorMembership domain.Membership, targetMembershipID string, input ReactivateMemberInput) (domain.Membership, error) {
	if err := requireCurrentPermission(ctx, s.DB, actorMembership, domain.PermissionGroupAdministration); err != nil {
		return domain.Membership{}, err
	}
	targetMembershipID = strings.TrimSpace(targetMembershipID)
	if targetMembershipID == "" {
		return domain.Membership{}, domain.ValidationError{Field: "membershipId", Message: "is required"}
	}
	input.RoleIDs = normalizeRoleIDs(input.RoleIDs)
	var result domain.Membership
	now := platform.Timestamp(platform.Now())
	err := storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		if err := requireCurrentPermission(ctx, tx, actorMembership, domain.PermissionGroupAdministration); err != nil {
			return err
		}
		var userID, targetGroupID, status, displayName string
		var email, passwordHash sql.NullString
		var deletedAt sql.NullString
		var userActive bool
		var roleAssignmentsVersion int64
		err := tx.QueryRowContext(ctx, `SELECT m.user_id,m.group_id,m.status,m.deleted_at,m.role_assignments_version,
			u.display_name,u.email,u.password_hash,u.active
			FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.id=?`, targetMembershipID).
			Scan(&userID, &targetGroupID, &status, &deletedAt, &roleAssignmentsVersion, &displayName, &email, &passwordHash, &userActive)
		if errors.Is(err, sql.ErrNoRows) {
			return domain.ErrNotFound
		}
		if err != nil {
			return err
		}
		if targetGroupID != actorMembership.GroupID {
			return domain.ErrForbidden
		}
		if status != "ARCHIVED" || deletedAt.Valid {
			return fmt.Errorf("%w: only archived memberships can be reactivated", domain.ErrConflict)
		}
		if !userActive {
			return fmt.Errorf("%w: inactive identities cannot be reactivated", domain.ErrConflict)
		}
		isTemporaryGuest := !email.Valid && !passwordHash.Valid
		if isTemporaryGuest {
			if len(input.RoleIDs) != 0 {
				return domain.ValidationError{Field: "roleIds", Message: "must be empty for temporary guests"}
			}
			requestedName := strings.TrimSpace(input.DisplayName)
			if requestedName == "" {
				requestedName = displayName
			}
			normalizedName, nameKey, err := NormalizeTemporaryGuestDisplayName(requestedName)
			if err != nil {
				var validation domain.ValidationError
				if errors.As(err, &validation) {
					validation.Field = "displayName"
					return validation
				}
				return err
			}
			var existingMembershipID string
			err = tx.QueryRowContext(ctx, `SELECT id FROM memberships
				WHERE group_id=? AND status='ACTIVE' AND temporary_guest_name_key=? AND id!=?`, targetGroupID, nameKey, targetMembershipID).
				Scan(&existingMembershipID)
			if err == nil {
				return TemporaryGuestNameConflictError{MembershipID: existingMembershipID}
			}
			if !errors.Is(err, sql.ErrNoRows) {
				return err
			}
			if _, err := tx.ExecContext(ctx, `UPDATE users SET display_name=?,updated_at=? WHERE id=?`, normalizedName, now, userID); err != nil {
				return err
			}
			update, err := tx.ExecContext(ctx, `UPDATE memberships SET status='ACTIVE',archived_at=NULL,temporary_guest_name_key=?
				WHERE id=? AND group_id=? AND status='ARCHIVED' AND deleted_at IS NULL`, nameKey, targetMembershipID, targetGroupID)
			if err != nil {
				return mapTemporaryGuestNameConstraintError(ctx, tx, targetGroupID, nameKey, targetMembershipID, err)
			}
			if changed, err := update.RowsAffected(); err != nil || changed != 1 {
				if err != nil {
					return err
				}
				return fmt.Errorf("%w: membership state changed", domain.ErrConflict)
			}
			displayName = normalizedName
		} else {
			if strings.TrimSpace(input.DisplayName) != "" {
				return domain.ValidationError{Field: "displayName", Message: "is supported only for temporary guests"}
			}
			if err := validateAssignedRoles(ctx, tx, targetGroupID, input.RoleIDs); err != nil {
				return err
			}
			var defaultRoleID string
			if err := tx.QueryRowContext(ctx, `SELECT default_role_id FROM group_settings
				WHERE group_id=? AND default_role_id IS NOT NULL`, targetGroupID).Scan(&defaultRoleID); errors.Is(err, sql.ErrNoRows) {
				return domain.ValidationError{Field: "roleIds", Message: "requires a configured default role"}
			} else if err != nil {
				return err
			}
			if len(input.RoleIDs) != 1 || input.RoleIDs[0] != defaultRoleID {
				adminRoleID, err := reservedAdministratorRoleID(ctx, tx, targetGroupID)
				if err != nil {
					return err
				}
				if err := requireAssignmentChangePermissions(ctx, tx, actorMembership, adminRoleID, nil, input.RoleIDs); err != nil {
					return err
				}
			}
			update, err := tx.ExecContext(ctx, `UPDATE memberships SET status='ACTIVE',archived_at=NULL
				WHERE id=? AND group_id=? AND status='ARCHIVED' AND deleted_at IS NULL`, targetMembershipID, targetGroupID)
			if err != nil {
				return err
			}
			if changed, err := update.RowsAffected(); err != nil || changed != 1 {
				if err != nil {
					return err
				}
				return fmt.Errorf("%w: membership state changed", domain.ErrConflict)
			}
			if err := replaceAssignmentRowsTx(ctx, tx, actor.UserID, targetGroupID, domain.RoleAssignmentMembership, targetMembershipID, nil, input.RoleIDs, now); err != nil {
				return err
			}
		}
		result = domain.Membership{
			ID: targetMembershipID, GroupID: targetGroupID, UserID: userID, DisplayName: displayName,
			Status: "ACTIVE", IsTemporaryGuest: isTemporaryGuest, RoleAssignmentsVersion: roleAssignmentsVersion,
		}
		if email.Valid {
			value := email.String
			result.Email = &value
		}
		return audit.Record(ctx, tx, targetGroupID, actor.UserID, actorMembership.ID, "membership.reactivated", "membership", targetMembershipID, map[string]any{
			"temporaryGuest": isTemporaryGuest,
			"roleIds":        input.RoleIDs,
		})
	})
	if err != nil {
		return domain.Membership{}, err
	}
	if err := s.hydrateMembershipAuthorization(ctx, &result); err != nil {
		return domain.Membership{}, err
	}
	return result, nil
}

// PermanentlyDeleteMember removes one archived membership from operational
// group views while retaining its stable financial and audit references.
// Credentialed identities are detached through a credentialless tombstone.
//
// Parameters:
//   - ctx: Cancellation and deadline context.
//   - actor: Authenticated administrator recorded in the audit trail.
//   - actorMembership: Administrator membership and tenant scope.
//   - targetMembershipID: Archived membership to permanently remove.
//
// Returns:
//   - error: Validation, authorization, non-zero-balance conflict, tenant,
//     audit, or storage error.
func (s Service) PermanentlyDeleteMember(ctx context.Context, actor domain.Principal, actorMembership domain.Membership, targetMembershipID string) error {
	if err := requireCurrentPermission(ctx, s.DB, actorMembership, domain.PermissionGroupAdministration); err != nil {
		return err
	}
	targetMembershipID = strings.TrimSpace(targetMembershipID)
	if targetMembershipID == "" {
		return domain.ValidationError{Field: "membershipId", Message: "is required"}
	}
	now := platform.Timestamp(platform.Now())
	return storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		if err := requireCurrentPermission(ctx, tx, actorMembership, domain.PermissionGroupAdministration); err != nil {
			return err
		}
		var userID, targetGroupID, status, displayName string
		var email, passwordHash sql.NullString
		var deletedAt sql.NullString
		err := tx.QueryRowContext(ctx, `SELECT m.user_id,m.group_id,m.status,m.deleted_at,u.display_name,u.email,u.password_hash
			FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.id=?`, targetMembershipID).
			Scan(&userID, &targetGroupID, &status, &deletedAt, &displayName, &email, &passwordHash)
		if errors.Is(err, sql.ErrNoRows) {
			return domain.ErrNotFound
		}
		if err != nil {
			return err
		}
		if targetGroupID != actorMembership.GroupID {
			return domain.ErrForbidden
		}
		if status != "ARCHIVED" || deletedAt.Valid {
			return fmt.Errorf("%w: only archived memberships can be permanently deleted", domain.ErrConflict)
		}
		var balanceMinor int64
		if err := tx.QueryRowContext(ctx, `SELECT coalesce(sum(amount_minor),0) FROM ledger_entries
			WHERE group_id=? AND membership_id=? AND account='MEMBER_RECEIVABLE'`, targetGroupID, targetMembershipID).Scan(&balanceMinor); err != nil {
			return err
		}
		if balanceMinor != 0 {
			return fmt.Errorf("%w: membership balance must be zero before permanent deletion", domain.ErrConflict)
		}
		if err := revokeMemberClaimInvitationsTx(ctx, tx, targetGroupID, targetMembershipID, now, "membership_deleted"); err != nil {
			return err
		}
		if err := clearMemberLegacyAuthorizationTx(ctx, tx, targetMembershipID); err != nil {
			return err
		}
		isTemporaryGuest := !email.Valid && !passwordHash.Valid
		if isTemporaryGuest {
			if _, err := tx.ExecContext(ctx, `UPDATE users SET active=0,avatar_key=NULL,updated_at=? WHERE id=?`, now, userID); err != nil {
				return err
			}
		} else {
			tombstoneUserID, err := platform.NewID("usr")
			if err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO users(id,email,display_name,password_hash,active,avatar_key,created_at,updated_at)
				VALUES(?,NULL,?,NULL,0,NULL,?,?)`, tombstoneUserID, displayName, now, now); err != nil {
				return err
			}
			userID = tombstoneUserID
		}
		update, err := tx.ExecContext(ctx, `UPDATE memberships SET user_id=?,temporary_guest_name_key=NULL,deleted_at=?
			WHERE id=? AND group_id=? AND status='ARCHIVED' AND deleted_at IS NULL`, userID, now, targetMembershipID, targetGroupID)
		if err != nil {
			return err
		}
		if changed, err := update.RowsAffected(); err != nil || changed != 1 {
			if err != nil {
				return err
			}
			return fmt.Errorf("%w: membership state changed", domain.ErrConflict)
		}
		return audit.Record(ctx, tx, targetGroupID, actor.UserID, actorMembership.ID, "membership.deleted", "membership", targetMembershipID, map[string]any{
			"temporaryGuest": isTemporaryGuest,
		})
	})
}

func revokeMemberClaimInvitationsTx(ctx context.Context, tx *sql.Tx, groupID, membershipID, now, errorCode string) error {
	if _, err := tx.ExecContext(ctx, `UPDATE invitations
		SET revoked_at=?,token_hash='revoked:' || id || ':' || ?
		WHERE group_id=? AND target_membership_id=? AND accepted_at IS NULL AND revoked_at IS NULL`,
		now, now, groupID, membershipID); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `UPDATE invitation_email_outbox SET
		status='CANCELLED',token_ciphertext=NULL,next_attempt_at=NULL,lease_token=NULL,lease_until=NULL,
		last_error_code=?,updated_at=?
		WHERE group_id=? AND invitation_id IN (SELECT id FROM invitations WHERE group_id=? AND target_membership_id=?)
		AND status IN ('PENDING','SENDING','FAILED')`, errorCode, now, groupID, groupID, membershipID)
	return err
}

func clearMemberLegacyAuthorizationTx(ctx context.Context, tx *sql.Tx, membershipID string) error {
	for _, statement := range []string{
		`DELETE FROM membership_roles WHERE membership_id=?`,
		`DELETE FROM membership_permissions WHERE membership_id=?`,
		`DELETE FROM category_permissions WHERE membership_id=?`,
	} {
		if _, err := tx.ExecContext(ctx, statement, membershipID); err != nil {
			return err
		}
	}
	return nil
}
