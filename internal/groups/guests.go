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

const managedGuestDisplayNameLimit = 120

// GuestSettingsUpdate is the atomic command used to enable or disable managed
// guests and optionally configure their exclusive login role. GuestRoleID and
// CreateGuestRole are mutually exclusive. ReplacementDefaultRoleID is required
// when disabling a feature whose guest role is the group's current default.
type GuestSettingsUpdate struct {
	GuestsEnabled            bool
	GuestRoleID              *string
	CreateGuestRole          bool
	ReplacementDefaultRoleID *string
}

// ManagedGuestNameConflictError identifies the active managed guest that owns
// a requested case-insensitive display name.
type ManagedGuestNameConflictError struct {
	MembershipID string
}

// Error returns a safe conflict message that lets clients offer explicit reuse.
func (e ManagedGuestNameConflictError) Error() string {
	return fmt.Sprintf("managed guest display name is already used by membership %s", e.MembershipID)
}

// Unwrap classifies the name collision as a resource conflict.
func (e ManagedGuestNameConflictError) Unwrap() error { return domain.ErrConflict }

// NormalizeManagedGuestDisplayName validates one guest-facing name and returns
// its trimmed display form and stable case-insensitive uniqueness key.
//
// Parameters:
//   - displayName: User-provided guest name.
//
// Returns:
//   - string: Trimmed display name.
//   - string: Lower-cased uniqueness key.
//   - error: Validation error for empty, long, or control-character input.
//
// Example: NormalizeManagedGuestDisplayName(" Alex ") returns "Alex", "alex".
func NormalizeManagedGuestDisplayName(displayName string) (string, string, error) {
	displayName = strings.TrimSpace(displayName)
	if displayName == "" || containsUnicodeControl(displayName) {
		return "", "", domain.ValidationError{Field: "managedGuestDisplayNames", Message: "must contain 1 to 120 characters without control characters"}
	}
	displayName = strings.Join(strings.Fields(displayName), " ")
	if len([]rune(displayName)) > managedGuestDisplayNameLimit {
		return "", "", domain.ValidationError{Field: "managedGuestDisplayNames", Message: "must contain 1 to 120 characters without control characters"}
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

// UpdateGuestSettings atomically changes managed-guest creation and optional
// login-role configuration. GROUP_ADMINISTRATION is required and rechecked in
// the transaction. Creating a role always creates an exact CREATE_OWN_BOOKING
// role; selecting an existing role requires that same exact grant set.
//
// Parameters:
//   - ctx: Cancellation and deadline context.
//   - actor: Authenticated audit actor.
//   - membership: Actor's active group membership.
//   - update: Complete guest-feature command.
//
// Returns:
//   - domain.GroupSettings: Persisted settings after the atomic update.
//   - error: Authorization, validation, conflict, audit, or storage error.
func (s Service) UpdateGuestSettings(ctx context.Context, actor domain.Principal, membership domain.Membership, update GuestSettingsUpdate) (domain.GroupSettings, error) {
	if update.GuestRoleID != nil {
		trimmed := strings.TrimSpace(*update.GuestRoleID)
		if trimmed == "" {
			return domain.GroupSettings{}, domain.ValidationError{Field: "guestRoleId", Message: "must be a non-empty role id"}
		}
		update.GuestRoleID = &trimmed
	}
	if update.ReplacementDefaultRoleID != nil {
		trimmed := strings.TrimSpace(*update.ReplacementDefaultRoleID)
		if trimmed == "" {
			return domain.GroupSettings{}, domain.ValidationError{Field: "replacementDefaultRoleId", Message: "must be a non-empty role id"}
		}
		update.ReplacementDefaultRoleID = &trimmed
	}
	if update.CreateGuestRole && update.GuestRoleID != nil {
		return domain.GroupSettings{}, domain.ValidationError{Field: "guestRoleId", Message: "cannot be combined with createGuestRole"}
	}
	if !update.GuestsEnabled && (update.CreateGuestRole || update.GuestRoleID != nil) {
		return domain.GroupSettings{}, domain.ValidationError{Field: "guestsEnabled", Message: "guest roles can only be configured while enabling guests"}
	}
	if err := requireCurrentPermission(ctx, s.DB, membership, domain.PermissionGroupAdministration); err != nil {
		return domain.GroupSettings{}, err
	}

	var persisted domain.GroupSettings
	err := storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		if err := requireCurrentPermission(ctx, tx, membership, domain.PermissionGroupAdministration); err != nil {
			return err
		}
		var previous domain.GroupSettings
		if err := querySettings(ctx, tx, membership.GroupID, &previous); errors.Is(err, sql.ErrNoRows) {
			return domain.ErrNotFound
		} else if err != nil {
			return err
		}

		next := previous
		next.GuestsEnabled = update.GuestsEnabled
		if update.CreateGuestRole {
			roleID, err := createMinimalGuestRoleTx(ctx, tx, actor, membership)
			if err != nil {
				return err
			}
			next.GuestRoleID = &roleID
		} else if update.GuestRoleID != nil {
			// A configured guest role remains editable after its initial security
			// review. Revalidate only when designating a different role for the
			// first time; otherwise legitimate post-setup grants would prevent a
			// later feature reactivation.
			if previous.GuestRoleID == nil || *previous.GuestRoleID != *update.GuestRoleID {
				if err := validateInitialGuestRole(ctx, tx, membership.GroupID, *update.GuestRoleID); err != nil {
					return err
				}
			}
			next.GuestRoleID = update.GuestRoleID
		}
		if previous.GuestRoleID != nil && next.GuestRoleID != nil && *previous.GuestRoleID != *next.GuestRoleID {
			var assignments int64
			if err := tx.QueryRowContext(ctx, `SELECT
				(SELECT count(*) FROM membership_role_assignments WHERE group_id=? AND role_id=?) +
				(SELECT count(*) FROM invitation_role_assignments assignment
				 JOIN invitations invitation
				   ON invitation.group_id=assignment.group_id AND invitation.id=assignment.invitation_id
				 WHERE assignment.group_id=? AND assignment.role_id=?
				   AND invitation.accepted_at IS NULL AND invitation.revoked_at IS NULL
				   AND julianday(invitation.expires_at)>julianday('now'))`,
				membership.GroupID, *previous.GuestRoleID, membership.GroupID, *previous.GuestRoleID).Scan(&assignments); err != nil {
				return err
			}
			if assignments > 0 {
				return fmt.Errorf("%w: configured guest role has assignments and cannot be replaced automatically", domain.ErrConflict)
			}
		}

		if next.GuestsEnabled && next.GuestRoleID != nil {
			if err := validateDefaultRole(ctx, tx, membership.GroupID, *next.GuestRoleID); err != nil {
				return err
			}
			next.DefaultRoleID = next.GuestRoleID
		}
		if !next.GuestsEnabled && previous.GuestRoleID != nil && previous.DefaultRoleID != nil && *previous.GuestRoleID == *previous.DefaultRoleID {
			if update.ReplacementDefaultRoleID == nil {
				return domain.ValidationError{Field: "replacementDefaultRoleId", Message: "is required because the guest role is the current default role"}
			}
			if *update.ReplacementDefaultRoleID == *previous.GuestRoleID {
				return domain.ValidationError{Field: "replacementDefaultRoleId", Message: "must differ from the guest role"}
			}
			if err := validateDefaultRole(ctx, tx, membership.GroupID, *update.ReplacementDefaultRoleID); err != nil {
				return err
			}
			next.DefaultRoleID = update.ReplacementDefaultRoleID
		} else if update.ReplacementDefaultRoleID != nil {
			return domain.ValidationError{Field: "replacementDefaultRoleId", Message: "is only accepted when disabling a guest role that is the current default"}
		}
		if previous.GuestsEnabled == next.GuestsEnabled &&
			nullableStringsEqual(previous.GuestRoleID, next.GuestRoleID) &&
			nullableStringsEqual(previous.DefaultRoleID, next.DefaultRoleID) {
			persisted = previous
			return nil
		}

		now := platform.Timestamp(platform.Now())
		if _, err := tx.ExecContext(ctx, `UPDATE group_settings SET guests_enabled=?,guest_role_id=?,default_role_id=?,updated_at=? WHERE group_id=?`,
			next.GuestsEnabled, nullableText(next.GuestRoleID), nullableText(next.DefaultRoleID), now, membership.GroupID); err != nil {
			return err
		}
		if err := audit.Record(ctx, tx, membership.GroupID, actor.UserID, membership.ID, "group.guest_settings.updated", "group", membership.GroupID, map[string]any{
			"previous": previous,
			"current":  next,
		}); err != nil {
			return err
		}
		return querySettings(ctx, tx, membership.GroupID, &persisted)
	})
	return persisted, err
}

func createMinimalGuestRoleTx(ctx context.Context, tx *sql.Tx, actor domain.Principal, membership domain.Membership) (string, error) {
	if err := validateUniqueRoleName(ctx, tx, membership.GroupID, "", "Guest"); err != nil {
		var validation domain.ValidationError
		if errors.As(err, &validation) {
			return "", fmt.Errorf("%w: an existing Guest role must be reviewed and reduced to CREATE_OWN_BOOKING before selection", domain.ErrConflict)
		}
		return "", err
	}
	roleID, err := platform.NewID("rol")
	if err != nil {
		return "", err
	}
	now := platform.Timestamp(platform.Now())
	if _, err := tx.ExecContext(ctx, `INSERT INTO roles(id,group_id,name,description,name_locked,deletable,version,created_at,updated_at,created_by,updated_by)
		VALUES(?,?,?,'Restricted role for guests with account access.',0,1,1,?,?,?,?)`, roleID, membership.GroupID, "Guest", now, now, actor.UserID, actor.UserID); err != nil {
		return "", mapRoleConstraintError(err)
	}
	grant := domain.PermissionGrant{Permission: domain.PermissionCreateOwnBooking, Scope: domain.PermissionScope{Type: domain.PermissionScopeGroup}}
	if err := replaceRoleGrantsTx(ctx, tx, actor.UserID, membership.GroupID, roleID, []domain.PermissionGrant{grant}, now); err != nil {
		return "", err
	}
	if err := audit.Record(ctx, tx, membership.GroupID, actor.UserID, membership.ID, "role.created", "role", roleID, RoleCommand{Name: "Guest", Description: "Restricted role for guests with account access.", Grants: []domain.PermissionGrant{grant}}); err != nil {
		return "", err
	}
	return roleID, nil
}

func validateInitialGuestRole(ctx context.Context, queryer roleQueryer, groupID, roleID string) error {
	grants, err := roleGrants(ctx, queryer, groupID, roleID)
	if errors.Is(err, domain.ErrNotFound) {
		return domain.ValidationError{Field: "guestRoleId", Message: "contains an unknown role"}
	}
	if err != nil {
		return err
	}
	var exists bool
	if err := queryer.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM roles WHERE group_id=? AND id=?)`, groupID, roleID).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return domain.ValidationError{Field: "guestRoleId", Message: "contains an unknown role"}
	}
	if len(grants) != 1 || grants[0].Permission != domain.PermissionCreateOwnBooking || grants[0].Scope.Type != domain.PermissionScopeGroup {
		return domain.ValidationError{Field: "guestRoleId", Message: "must grant exactly CREATE_OWN_BOOKING before it can be configured"}
	}
	var nonExclusiveMemberAssignments, nonExclusiveInvitationAssignments bool
	if err := queryer.QueryRowContext(ctx, `SELECT
		EXISTS(
			SELECT 1 FROM membership_role_assignments guest_assignment
			JOIN membership_role_assignments other_assignment
			  ON other_assignment.group_id=guest_assignment.group_id
			 AND other_assignment.membership_id=guest_assignment.membership_id
			 AND other_assignment.role_id!=guest_assignment.role_id
			WHERE guest_assignment.group_id=? AND guest_assignment.role_id=?
		),
		EXISTS(
			SELECT 1 FROM invitation_role_assignments guest_assignment
			JOIN invitation_role_assignments other_assignment
			  ON other_assignment.group_id=guest_assignment.group_id
			 AND other_assignment.invitation_id=guest_assignment.invitation_id
			 AND other_assignment.role_id!=guest_assignment.role_id
			JOIN invitations invitation
			  ON invitation.group_id=guest_assignment.group_id
			 AND invitation.id=guest_assignment.invitation_id
			WHERE guest_assignment.group_id=? AND guest_assignment.role_id=?
			  AND invitation.accepted_at IS NULL AND invitation.revoked_at IS NULL
			  AND julianday(invitation.expires_at)>julianday('now')
		)`, groupID, roleID, groupID, roleID).Scan(&nonExclusiveMemberAssignments, &nonExclusiveInvitationAssignments); err != nil {
		return err
	}
	if nonExclusiveMemberAssignments || nonExclusiveInvitationAssignments {
		return fmt.Errorf("%w: guest role must be exclusive for every active membership and open invitation assignment", domain.ErrConflict)
	}
	return nil
}

// CreateManagedGuestTx inserts a credential-less identity and active role-less
// membership in the caller-owned transaction. The caller must already have
// checked BOOK_FOR_OTHERS; this function rechecks feature state and tenant scope.
//
// Parameters:
//   - ctx: Cancellation and deadline context.
//   - tx: Caller-owned transaction that also contains the booking.
//   - actor: Authenticated audit actor.
//   - actorMembership: Actor membership and tenant scope.
//   - displayName: Validated or raw guest display name.
//   - now: Shared business timestamp for the complete booking batch.
//
// Returns:
//   - domain.Membership: Newly created managed guest.
//   - error: Feature, name-conflict, validation, audit, or storage error.
func CreateManagedGuestTx(ctx context.Context, tx *sql.Tx, actor domain.Principal, actorMembership domain.Membership, displayName string, now time.Time) (domain.Membership, error) {
	displayName, nameKey, err := NormalizeManagedGuestDisplayName(displayName)
	if err != nil {
		return domain.Membership{}, err
	}
	var guestsEnabled bool
	if err := tx.QueryRowContext(ctx, `SELECT guests_enabled FROM group_settings WHERE group_id=?`, actorMembership.GroupID).Scan(&guestsEnabled); errors.Is(err, sql.ErrNoRows) {
		return domain.Membership{}, domain.ErrNotFound
	} else if err != nil {
		return domain.Membership{}, err
	}
	if !guestsEnabled {
		return domain.Membership{}, fmt.Errorf("%w: managed guest creation is disabled", domain.ErrConflict)
	}
	var existingMembershipID string
	err = tx.QueryRowContext(ctx, `SELECT id FROM memberships WHERE group_id=? AND status='ACTIVE' AND managed_guest_name_key=?`, actorMembership.GroupID, nameKey).Scan(&existingMembershipID)
	if err == nil {
		return domain.Membership{}, ManagedGuestNameConflictError{MembershipID: existingMembershipID}
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
	if _, err := tx.ExecContext(ctx, `INSERT INTO memberships(id,group_id,user_id,status,joined_at,managed_guest_name_key) VALUES(?,?,?,'ACTIVE',?,?)`, membershipID, actorMembership.GroupID, userID, nowText, nameKey); err != nil {
		return domain.Membership{}, mapManagedGuestNameConstraintError(ctx, tx, actorMembership.GroupID, nameKey, membershipID, err)
	}
	if err := audit.Record(ctx, tx, actorMembership.GroupID, actor.UserID, actorMembership.ID, "managed_guest.created", "membership", membershipID, map[string]any{"displayName": displayName}); err != nil {
		return domain.Membership{}, err
	}
	return domain.Membership{
		ID:               membershipID,
		GroupID:          actorMembership.GroupID,
		UserID:           userID,
		DisplayName:      displayName,
		Status:           "ACTIVE",
		IsGuest:          true,
		Roles:            []domain.Role{},
		GroupPermissions: []domain.GroupPermission{},
		CategoryGrants:   map[string][]domain.CategoryPermission{},
		RoleIDs:          []string{},
		EffectiveGrants:  []domain.PermissionGrant{},
	}, nil
}

// RenameManagedGuest changes an active credential-less guest's display name
// and uniqueness key without changing its membership, ledger, or audit history.
func (s Service) RenameManagedGuest(ctx context.Context, actor domain.Principal, actorMembership domain.Membership, targetMembershipID, displayName string) (domain.Membership, error) {
	displayName, nameKey, err := NormalizeManagedGuestDisplayName(displayName)
	if err != nil {
		var validation domain.ValidationError
		if errors.As(err, &validation) {
			validation.Field = "displayName"
			return domain.Membership{}, validation
		}
		return domain.Membership{}, err
	}
	if err := requireCurrentPermission(ctx, s.DB, actorMembership, domain.PermissionGroupAdministration); err != nil {
		return domain.Membership{}, err
	}
	targetMembershipID = strings.TrimSpace(targetMembershipID)
	var result domain.Membership
	err = storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		if err := requireCurrentPermission(ctx, tx, actorMembership, domain.PermissionGroupAdministration); err != nil {
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
			return fmt.Errorf("%w: only credential-less managed guests can be renamed through this endpoint", domain.ErrConflict)
		}
		var existingMembershipID string
		err = tx.QueryRowContext(ctx, `SELECT id FROM memberships WHERE group_id=? AND status='ACTIVE' AND managed_guest_name_key=? AND id!=?`, actorMembership.GroupID, nameKey, targetMembershipID).Scan(&existingMembershipID)
		if err == nil {
			return ManagedGuestNameConflictError{MembershipID: existingMembershipID}
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		now := platform.Timestamp(platform.Now())
		if _, err := tx.ExecContext(ctx, `UPDATE users SET display_name=?,updated_at=? WHERE id=?`, displayName, now, userID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE memberships SET managed_guest_name_key=? WHERE id=? AND group_id=?`, nameKey, targetMembershipID, actorMembership.GroupID); err != nil {
			return mapManagedGuestNameConstraintError(ctx, tx, actorMembership.GroupID, nameKey, targetMembershipID, err)
		}
		if err := audit.Record(ctx, tx, actorMembership.GroupID, actor.UserID, actorMembership.ID, "managed_guest.renamed", "membership", targetMembershipID, map[string]any{"previousDisplayName": previousName, "displayName": displayName}); err != nil {
			return err
		}
		result = domain.Membership{ID: targetMembershipID, GroupID: actorMembership.GroupID, UserID: userID, DisplayName: displayName, Status: "ACTIVE", IsGuest: true, Roles: []domain.Role{}, GroupPermissions: []domain.GroupPermission{}, CategoryGrants: map[string][]domain.CategoryPermission{}, RoleIDs: []string{}, EffectiveGrants: []domain.PermissionGrant{}, RoleAssignmentsVersion: roleAssignmentsVersion}
		return nil
	})
	return result, err
}

type managedGuestNameQueryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func mapManagedGuestNameConstraintError(ctx context.Context, queryer managedGuestNameQueryer, groupID, nameKey, excludedMembershipID string, cause error) error {
	lower := strings.ToLower(cause.Error())
	if !strings.Contains(lower, "managed_guest") && !strings.Contains(lower, "unique") {
		return cause
	}
	var existingMembershipID string
	if err := queryer.QueryRowContext(ctx, `SELECT id FROM memberships
		WHERE group_id=? AND status='ACTIVE' AND managed_guest_name_key=? AND id!=?`, groupID, nameKey, excludedMembershipID).
		Scan(&existingMembershipID); err == nil {
		return ManagedGuestNameConflictError{MembershipID: existingMembershipID}
	}
	return cause
}

// CreateClaimInvitation creates an invitation that promotes an existing active
// managed guest in place. Acceptance preserves the target membership ID and
// assigns the configured guest role exclusively.
func (s Service) CreateClaimInvitation(ctx context.Context, actor domain.Principal, actorMembership domain.Membership, targetMembershipID, email string) (Invitation, error) {
	if err := requireCurrentPermission(ctx, s.DB, actorMembership, domain.PermissionGroupAdministration); err != nil {
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
	var invitation Invitation
	now := platform.Now()
	err = storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		if err := requireCurrentPermission(ctx, tx, actorMembership, domain.PermissionGroupAdministration); err != nil {
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
		var guestRoleID sql.NullString
		if err := tx.QueryRowContext(ctx, `SELECT guest_role_id FROM group_settings WHERE group_id=?`, actorMembership.GroupID).Scan(&guestRoleID); err != nil {
			return err
		}
		if !guestRoleID.Valid {
			return domain.ValidationError{Field: "guestRoleId", Message: "must be configured before a managed guest can claim an account"}
		}
		var openClaimExists bool
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM invitations
			WHERE group_id=? AND target_membership_id=? AND accepted_at IS NULL AND revoked_at IS NULL
			AND julianday(expires_at)>julianday(?))`, actorMembership.GroupID, targetMembershipID, platform.Timestamp(now)).Scan(&openClaimExists); err != nil {
			return err
		}
		if openClaimExists {
			return fmt.Errorf("%w: an active claim invitation already exists for this managed guest", domain.ErrConflict)
		}
		invitation, err = createInvitationTx(ctx, tx, actor, actorMembership, normalizedEmail, displayName, nil, nil, nil, []string{guestRoleID.String}, now, invitationAssignmentManagedGuestClaim)
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
		return audit.Record(ctx, tx, actorMembership.GroupID, actor.UserID, actorMembership.ID, "managed_guest.claim_invited", "membership", targetMembershipID, map[string]any{"invitationId": invitation.ID, "email": normalizedEmail})
	})
	return invitation, err
}
