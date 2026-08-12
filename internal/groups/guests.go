package groups

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode"

	"github.com/DasLukas/TeamTaler/internal/audit"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

const temporaryGuestDisplayNameLimit = 120

// TemporaryGuestNameConflictError identifies the active temporary guest that
// owns a requested case-insensitive display name.
type TemporaryGuestNameConflictError struct {
	MembershipID string
}

// Error returns a safe conflict message that lets clients offer explicit reuse.
func (e TemporaryGuestNameConflictError) Error() string {
	return fmt.Sprintf("temporary guest display name is already used by membership %s", e.MembershipID)
}

// Unwrap classifies the name collision as a resource conflict.
func (e TemporaryGuestNameConflictError) Unwrap() error { return domain.ErrConflict }

// NormalizeTemporaryGuestDisplayName validates one guest-facing name and
// returns its trimmed display form and stable case-insensitive uniqueness key.
//
// Parameters:
//   - displayName: User-provided temporary guest name.
//
// Returns:
//   - string: Trimmed display name.
//   - string: Lower-cased uniqueness key.
//   - error: Validation error for empty, long, or control-character input.
//
// Example: NormalizeTemporaryGuestDisplayName(" Alex ") returns "Alex", "alex".
func NormalizeTemporaryGuestDisplayName(displayName string) (string, string, error) {
	displayName = strings.TrimSpace(displayName)
	if displayName == "" || containsUnicodeControl(displayName) {
		return "", "", domain.ValidationError{Field: "temporaryGuestDisplayNames", Message: "must contain 1 to 120 characters without control characters"}
	}
	displayName = strings.Join(strings.Fields(displayName), " ")
	if len([]rune(displayName)) > temporaryGuestDisplayNameLimit {
		return "", "", domain.ValidationError{Field: "temporaryGuestDisplayNames", Message: "must contain 1 to 120 characters without control characters"}
	}
	return displayName, strings.ToLower(displayName), nil
}

func containsUnicodeControl(value string) bool {
	for _, character := range value {
		if unicode.IsControl(character) {
			return true
		}
	}
	return false
}

// CreateTemporaryGuestTx inserts a credential-less identity and an active,
// role-less membership in the caller-owned booking transaction.
//
// Parameters:
//   - ctx: Cancellation and deadline context.
//   - tx: Transaction that also contains the booking and ledger mutations.
//   - actor: Authenticated audit actor.
//   - actorMembership: Actor membership and tenant scope.
//   - displayName: Guest-facing display name.
//   - now: Shared business timestamp for the complete booking batch.
//
// Returns:
//   - domain.Membership: Newly created temporary guest.
//   - error: Authorization, validation, conflict, audit, or storage error.
func CreateTemporaryGuestTx(ctx context.Context, tx *sql.Tx, actor domain.Principal, actorMembership domain.Membership, displayName string, now time.Time) (domain.Membership, error) {
	if err := requireCurrentPermission(ctx, tx, actorMembership, domain.PermissionBookForGuests); err != nil {
		return domain.Membership{}, err
	}
	displayName, nameKey, err := NormalizeTemporaryGuestDisplayName(displayName)
	if err != nil {
		return domain.Membership{}, err
	}
	var existingMembershipID string
	err = tx.QueryRowContext(ctx, `SELECT id FROM memberships WHERE group_id=? AND status='ACTIVE' AND temporary_guest_name_key=?`, actorMembership.GroupID, nameKey).Scan(&existingMembershipID)
	if err == nil {
		return domain.Membership{}, TemporaryGuestNameConflictError{MembershipID: existingMembershipID}
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return domain.Membership{}, err
	}
	userID, err := platform.NewID("usr")
	if err != nil {
		return domain.Membership{}, err
	}
	membershipID, err := platform.NewID("mem")
	if err != nil {
		return domain.Membership{}, err
	}
	nowText := platform.Timestamp(now)
	if _, err := tx.ExecContext(ctx, `INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES(?,NULL,?,NULL,?,?)`, userID, displayName, nowText, nowText); err != nil {
		return domain.Membership{}, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO memberships(id,group_id,user_id,status,joined_at,temporary_guest_name_key) VALUES(?,?,?,'ACTIVE',?,?)`, membershipID, actorMembership.GroupID, userID, nowText, nameKey); err != nil {
		return domain.Membership{}, mapTemporaryGuestNameConstraintError(ctx, tx, actorMembership.GroupID, nameKey, membershipID, err)
	}
	if err := audit.Record(ctx, tx, actorMembership.GroupID, actor.UserID, actorMembership.ID, "temporary_guest.created", "membership", membershipID, map[string]any{"displayName": displayName}); err != nil {
		return domain.Membership{}, err
	}
	return domain.Membership{
		ID:                     membershipID,
		GroupID:                actorMembership.GroupID,
		UserID:                 userID,
		DisplayName:            displayName,
		Status:                 "ACTIVE",
		IsTemporaryGuest:       true,
		Roles:                  []domain.Role{},
		GroupPermissions:       []domain.GroupPermission{},
		CategoryGrants:         map[string][]domain.CategoryPermission{},
		RoleIDs:                []string{},
		EffectiveGrants:        []domain.PermissionGrant{},
		RoleAssignmentsVersion: 1,
	}, nil
}

// RenameTemporaryGuest changes an active credential-less guest's display name
// without changing its membership, ledger, or audit history.
//
// Parameters:
//   - ctx: Cancellation and deadline context.
//   - actor: Authenticated administrator recorded in the audit event.
//   - actorMembership: Administrator membership and tenant scope.
//   - targetMembershipID: Active temporary-guest membership to rename.
//   - displayName: Replacement name before whitespace normalization.
//
// Returns:
//   - domain.Membership: Updated temporary-guest representation.
//   - error: Authorization, validation, tenant, conflict, audit, or storage error.
func (s Service) RenameTemporaryGuest(ctx context.Context, actor domain.Principal, actorMembership domain.Membership, targetMembershipID, displayName string) (domain.Membership, error) {
	displayName, nameKey, err := NormalizeTemporaryGuestDisplayName(displayName)
	if err != nil {
		var validation domain.ValidationError
		if errors.As(err, &validation) {
			validation.Field = "displayName"
			return domain.Membership{}, validation
		}
		return domain.Membership{}, err
	}
	if err := requireCurrentPermission(ctx, s.DB, actorMembership, domain.PermissionMemberManagement); err != nil {
		return domain.Membership{}, err
	}
	targetMembershipID = strings.TrimSpace(targetMembershipID)
	var result domain.Membership
	err = storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		if err := requireCurrentPermission(ctx, tx, actorMembership, domain.PermissionMemberManagement); err != nil {
			return err
		}
		var userID, previousName string
		var roleAssignmentsVersion int64
		var email, passwordHash sql.NullString
		err := tx.QueryRowContext(ctx, `SELECT m.user_id,u.display_name,u.email,u.password_hash,m.role_assignments_version
			FROM memberships m JOIN users u ON u.id=m.user_id
			WHERE m.id=? AND m.group_id=? AND m.status='ACTIVE'`, targetMembershipID, actorMembership.GroupID).
			Scan(&userID, &previousName, &email, &passwordHash, &roleAssignmentsVersion)
		if errors.Is(err, sql.ErrNoRows) {
			return domain.ErrNotFound
		}
		if err != nil {
			return err
		}
		if email.Valid || passwordHash.Valid {
			return fmt.Errorf("%w: only temporary guests can be renamed through this endpoint", domain.ErrConflict)
		}
		var existingMembershipID string
		err = tx.QueryRowContext(ctx, `SELECT id FROM memberships WHERE group_id=? AND status='ACTIVE' AND temporary_guest_name_key=? AND id!=?`, actorMembership.GroupID, nameKey, targetMembershipID).Scan(&existingMembershipID)
		if err == nil {
			return TemporaryGuestNameConflictError{MembershipID: existingMembershipID}
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		now := platform.Timestamp(platform.Now())
		if _, err := tx.ExecContext(ctx, `UPDATE users SET display_name=?,updated_at=? WHERE id=?`, displayName, now, userID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE memberships SET temporary_guest_name_key=? WHERE id=? AND group_id=?`, nameKey, targetMembershipID, actorMembership.GroupID); err != nil {
			return mapTemporaryGuestNameConstraintError(ctx, tx, actorMembership.GroupID, nameKey, targetMembershipID, err)
		}
		if err := audit.Record(ctx, tx, actorMembership.GroupID, actor.UserID, actorMembership.ID, "temporary_guest.renamed", "membership", targetMembershipID, map[string]any{"previousDisplayName": previousName, "displayName": displayName}); err != nil {
			return err
		}
		result = domain.Membership{
			ID: targetMembershipID, GroupID: actorMembership.GroupID, UserID: userID,
			DisplayName: displayName, Status: "ACTIVE", IsTemporaryGuest: true,
			Roles: []domain.Role{}, GroupPermissions: []domain.GroupPermission{},
			CategoryGrants: map[string][]domain.CategoryPermission{}, RoleIDs: []string{},
			EffectiveGrants: []domain.PermissionGrant{}, RoleAssignmentsVersion: roleAssignmentsVersion,
		}
		return nil
	})
	return result, err
}

type temporaryGuestNameQueryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func mapTemporaryGuestNameConstraintError(ctx context.Context, queryer temporaryGuestNameQueryer, groupID, nameKey, excludedMembershipID string, cause error) error {
	lower := strings.ToLower(cause.Error())
	if !strings.Contains(lower, "temporary_guest") && !strings.Contains(lower, "unique") {
		return cause
	}
	var existingMembershipID string
	if err := queryer.QueryRowContext(ctx, `SELECT id FROM memberships
		WHERE group_id=? AND status='ACTIVE' AND temporary_guest_name_key=? AND id!=?`, groupID, nameKey, excludedMembershipID).
		Scan(&existingMembershipID); err == nil {
		return TemporaryGuestNameConflictError{MembershipID: existingMembershipID}
	}
	return cause
}

// CreateTemporaryGuestClaimInvitation creates an invitation that adds login
// credentials and the selected regular roles to one existing temporary guest.
//
// Parameters:
//   - ctx: Cancellation and deadline context.
//   - actor: Authenticated administrator creating the invitation.
//   - actorMembership: Administrator membership and tenant scope.
//   - targetMembershipID: Active temporary-guest membership to claim.
//   - email: Login address for the claimed account.
//   - roleIDs: Complete role set to apply exactly when the invitation is accepted.
//
// Returns:
//   - Invitation: Persisted single-use invitation with its transient token.
//   - error: Authorization, validation, conflict, email, audit, or storage error.
func (s Service) CreateTemporaryGuestClaimInvitation(ctx context.Context, actor domain.Principal, actorMembership domain.Membership, targetMembershipID, email string, roleIDs []string) (Invitation, error) {
	if err := requireCurrentPermission(ctx, s.DB, actorMembership, domain.PermissionMemberManagement); err != nil {
		return Invitation{}, err
	}
	normalizedEmail, err := platform.NormalizeEmail(email)
	if err != nil {
		return Invitation{}, domain.ValidationError{Field: "email", Message: "must be a valid email address"}
	}
	targetMembershipID = strings.TrimSpace(targetMembershipID)
	if targetMembershipID == "" {
		return Invitation{}, domain.ValidationError{Field: "membershipId", Message: "is required"}
	}
	roleIDs = normalizeRoleIDs(roleIDs)
	if len(roleIDs) == 0 {
		return Invitation{}, domain.ValidationError{Field: "roleIds", Message: "must contain at least one role"}
	}
	var invitation Invitation
	now := platform.Now()
	err = storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		if err := requireCurrentPermission(ctx, tx, actorMembership, domain.PermissionMemberManagement); err != nil {
			return err
		}
		var displayName string
		var emailValue, passwordHash sql.NullString
		if err := tx.QueryRowContext(ctx, `SELECT u.display_name,u.email,u.password_hash
			FROM memberships m JOIN users u ON u.id=m.user_id
			WHERE m.id=? AND m.group_id=? AND m.status='ACTIVE'`, targetMembershipID, actorMembership.GroupID).
			Scan(&displayName, &emailValue, &passwordHash); errors.Is(err, sql.ErrNoRows) {
			return domain.ErrNotFound
		} else if err != nil {
			return err
		}
		if emailValue.Valid || passwordHash.Valid {
			return fmt.Errorf("%w: membership already has login credentials", domain.ErrConflict)
		}
		var openClaimExists bool
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM invitations
			WHERE group_id=? AND target_membership_id=? AND accepted_at IS NULL AND revoked_at IS NULL
			AND julianday(expires_at)>julianday(?))`, actorMembership.GroupID, targetMembershipID, platform.Timestamp(now)).Scan(&openClaimExists); err != nil {
			return err
		}
		if openClaimExists {
			return fmt.Errorf("%w: an active claim invitation already exists for this temporary guest", domain.ErrConflict)
		}
		invitation, err = createInvitationTx(ctx, tx, actor, actorMembership, normalizedEmail, displayName, nil, nil, nil, roleIDs, now, invitationAssignmentTemporaryGuestClaim)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE invitations SET target_membership_id=? WHERE id=? AND group_id=?`, targetMembershipID, invitation.ID, actorMembership.GroupID); err != nil {
			return err
		}
		invitation.TargetMembershipID = &targetMembershipID
		if s.TokenSealer != nil {
			if err := s.queueInvitationEmailTx(ctx, tx, actor, actorMembership, invitation, now); err != nil {
				return err
			}
			invitation.EmailDeliveryStatus = EmailDeliveryPending
		}
		return audit.Record(ctx, tx, actorMembership.GroupID, actor.UserID, actorMembership.ID, "temporary_guest.claim_invited", "membership", targetMembershipID, map[string]any{"invitationId": invitation.ID, "email": normalizedEmail, "roleIds": roleIDs})
	})
	return invitation, err
}
