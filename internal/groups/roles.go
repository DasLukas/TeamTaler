package groups

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/DasLukas/TeamTaler/internal/audit"
	"github.com/DasLukas/TeamTaler/internal/authorization"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

// ManagedRole is the public role-management read model. Assignment counts are
// calculated from active memberships and open invitations and are never trusted
// as authorization input.
type ManagedRole struct {
	domain.RoleDefinition
	MemberCount            int64 `json:"memberCount"`
	PendingInvitationCount int64 `json:"pendingInvitationCount"`
}

// RoleCommand is the complete editable role state accepted by create and
// optimistic update operations.
type RoleCommand struct {
	Name        string                   `json:"name"`
	Description string                   `json:"description,omitempty"`
	Grants      []domain.PermissionGrant `json:"grants"`
}

// AssignmentSet is the aggregate API representation of every role assigned to
// one membership or pending invitation. Version protects whole-set replacement.
type AssignmentSet struct {
	SubjectType domain.RoleAssignmentTargetType `json:"subjectType"`
	SubjectID   string                          `json:"subjectId"`
	RoleIDs     []string                        `json:"roleIds"`
	Version     int64                           `json:"version"`
}

// RoleInUseError reports why a deletable role still cannot be removed.
type RoleInUseError struct {
	MemberCount            int64
	PendingInvitationCount int64
}

// Error returns a stable, safe conflict description with affected counts.
func (e RoleInUseError) Error() string {
	return fmt.Sprintf("role is assigned to %d active memberships and %d open invitations", e.MemberCount, e.PendingInvitationCount)
}

// Unwrap classifies RoleInUseError as a resource conflict.
func (e RoleInUseError) Unwrap() error { return domain.ErrConflict }

type roleQueryer interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func requireCurrentPermission(ctx context.Context, queryer authorization.Queryer, membership domain.Membership, permission domain.PermissionKey) error {
	return authorization.Require(ctx, queryer, membership.GroupID, membership.ID, permission, authorization.ResourceContext{GroupID: membership.GroupID})
}

func hasCurrentPermission(ctx context.Context, queryer authorization.Queryer, membership domain.Membership, permission domain.PermissionKey) (bool, error) {
	return authorization.NewPolicy(queryer).Can(ctx, membership.GroupID, membership.ID, permission, authorization.ResourceContext{GroupID: membership.GroupID})
}

func requireAnyCurrentPermission(ctx context.Context, queryer authorization.Queryer, membership domain.Membership, permissions ...domain.PermissionKey) error {
	for _, permission := range permissions {
		allowed, err := hasCurrentPermission(ctx, queryer, membership, permission)
		if err != nil {
			return err
		}
		if allowed {
			return nil
		}
	}
	return domain.ErrForbidden
}

func requireRoleReadAccess(ctx context.Context, queryer authorization.Queryer, membership domain.Membership) error {
	canManageRoles, err := hasCurrentPermission(ctx, queryer, membership, domain.PermissionRoleManagement)
	if err != nil {
		return err
	}
	canManageMembers, err := hasCurrentPermission(ctx, queryer, membership, domain.PermissionMemberManagement)
	if err != nil {
		return err
	}
	if !canManageRoles && !canManageMembers {
		return domain.ErrForbidden
	}
	return nil
}

// PermissionDefinitions returns the stable permission registry in display
// order. Returned implications are calculated policy metadata, not stored grants.
func PermissionDefinitions() []domain.PermissionDefinition {
	return authorization.Definitions()
}

// ListRoles returns every role owned by membership's group with assignment
// counts. ROLE_MANAGEMENT or MEMBER_MANAGEMENT is required so role definitions
// and member assignments can share one tenant-bound role catalogue.
func (s Service) ListRoles(ctx context.Context, membership domain.Membership) ([]ManagedRole, error) {
	if err := requireRoleReadAccess(ctx, s.DB, membership); err != nil {
		return nil, err
	}
	rows, err := s.DB.QueryContext(ctx, `SELECT r.id,r.group_id,coalesce(r.preset_key,''),r.name,coalesce(r.description,''),r.name_locked,r.deletable,r.version,r.created_at,r.updated_at,
		(SELECT count(*) FROM membership_role_assignments ma JOIN memberships m ON m.id=ma.membership_id AND m.group_id=ma.group_id WHERE ma.group_id=r.group_id AND ma.role_id=r.id AND m.status='ACTIVE'),
		(SELECT count(*) FROM invitation_role_assignments ia JOIN invitations i ON i.id=ia.invitation_id AND i.group_id=ia.group_id WHERE ia.group_id=r.group_id AND ia.role_id=r.id AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND julianday(i.expires_at)>julianday('now'))
		FROM roles r WHERE r.group_id=? ORDER BY CASE WHEN r.preset_key='GROUP_ADMINISTRATOR' THEN 0 ELSE 1 END,lower(r.name),r.id`, membership.GroupID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]ManagedRole, 0)
	for rows.Next() {
		var item ManagedRole
		if err := rows.Scan(&item.ID, &item.GroupID, &item.PresetKey, &item.Name, &item.Description, &item.NameLocked, &item.Deletable, &item.Version, &item.CreatedAt, &item.UpdatedAt, &item.MemberCount, &item.PendingInvitationCount); err != nil {
			rows.Close()
			return nil, err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	for index := range items {
		items[index].Grants, err = roleGrants(ctx, s.DB, membership.GroupID, items[index].ID)
		if err != nil {
			return nil, err
		}
	}
	return items, nil
}

// GetRole returns one role in membership's group. ROLE_MANAGEMENT is required;
// unknown and cross-group identifiers are indistinguishable.
func (s Service) GetRole(ctx context.Context, membership domain.Membership, roleID string) (ManagedRole, error) {
	if err := requireCurrentPermission(ctx, s.DB, membership, domain.PermissionRoleManagement); err != nil {
		return ManagedRole{}, err
	}
	return loadManagedRole(ctx, s.DB, membership.GroupID, strings.TrimSpace(roleID))
}

// CreateRole creates one custom, group-scoped allow role. GROUP_ADMINISTRATION
// is additionally required when the role grants that protected permission.
func (s Service) CreateRole(ctx context.Context, actor domain.Principal, membership domain.Membership, command RoleCommand) (ManagedRole, error) {
	command, err := normalizeRoleCommand(command)
	if err != nil {
		return ManagedRole{}, err
	}
	if err := requireCurrentPermission(ctx, s.DB, membership, domain.PermissionRoleManagement); err != nil {
		return ManagedRole{}, err
	}
	if hasGrant(command.Grants, domain.PermissionGroupAdministration) {
		if err := requireCurrentPermission(ctx, s.DB, membership, domain.PermissionGroupAdministration); err != nil {
			return ManagedRole{}, err
		}
	}
	roleID, err := platform.NewID("rol")
	if err != nil {
		return ManagedRole{}, err
	}
	now := platform.Timestamp(platform.Now())
	var item ManagedRole
	err = storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		if err := requireCurrentPermission(ctx, tx, membership, domain.PermissionRoleManagement); err != nil {
			return err
		}
		if hasGrant(command.Grants, domain.PermissionGroupAdministration) {
			if err := requireCurrentPermission(ctx, tx, membership, domain.PermissionGroupAdministration); err != nil {
				return err
			}
		}
		if err := validateUniqueRoleName(ctx, tx, membership.GroupID, "", command.Name); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO roles(id,group_id,name,description,name_locked,deletable,version,created_at,updated_at,created_by,updated_by) VALUES(?,?,?,?,0,1,1,?,?,?,?)`, roleID, membership.GroupID, command.Name, command.Description, now, now, actor.UserID, actor.UserID); err != nil {
			return mapRoleConstraintError(err)
		}
		if err := replaceRoleGrantsTx(ctx, tx, actor.UserID, membership.GroupID, roleID, command.Grants, now); err != nil {
			return err
		}
		if err := audit.Record(ctx, tx, membership.GroupID, actor.UserID, membership.ID, "role.created", "role", roleID, command); err != nil {
			return err
		}
		item, err = loadManagedRole(ctx, tx, membership.GroupID, roleID)
		if err != nil {
			return err
		}
		return nil
	})
	return item, err
}

// UpdateRole atomically replaces editable role metadata and grants when
// expectedVersion matches. Protected administrator changes require both role
// and group administration rights.
func (s Service) UpdateRole(ctx context.Context, actor domain.Principal, membership domain.Membership, roleID string, expectedVersion int64, command RoleCommand) (ManagedRole, error) {
	roleID = strings.TrimSpace(roleID)
	if expectedVersion < 1 {
		return ManagedRole{}, domain.ValidationError{Field: "If-Match", Message: "must contain a current role version"}
	}
	command, err := normalizeRoleCommand(command)
	if err != nil {
		return ManagedRole{}, err
	}
	if err := requireCurrentPermission(ctx, s.DB, membership, domain.PermissionRoleManagement); err != nil {
		return ManagedRole{}, err
	}
	var updated ManagedRole
	now := platform.Timestamp(platform.Now())
	err = storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		if err := requireCurrentPermission(ctx, tx, membership, domain.PermissionRoleManagement); err != nil {
			return err
		}
		current, err := loadManagedRole(ctx, tx, membership.GroupID, roleID)
		if err != nil {
			return err
		}
		if current.Version != expectedVersion {
			return domain.ErrPrecondition
		}
		protectedRole := current.PresetKey == domain.RolePresetGroupAdministrator
		adminGrantChanged := hasGrant(current.Grants, domain.PermissionGroupAdministration) != hasGrant(command.Grants, domain.PermissionGroupAdministration)
		if protectedRole || adminGrantChanged {
			if err := requireCurrentPermission(ctx, tx, membership, domain.PermissionGroupAdministration); err != nil {
				return err
			}
		}
		if current.NameLocked && command.Name != current.Name {
			return domain.ValidationError{Field: "name", Message: "is locked for the reserved administrator role"}
		}
		if protectedRole && (!hasGrant(command.Grants, domain.PermissionGroupAdministration) || !hasGrant(command.Grants, domain.PermissionMemberManagement) || !hasGrant(command.Grants, domain.PermissionRoleManagement)) {
			return domain.ValidationError{Field: "grants", Message: "must retain GROUP_ADMINISTRATION, MEMBER_MANAGEMENT, and ROLE_MANAGEMENT for the reserved administrator role"}
		}
		if hasGrant(command.Grants, domain.PermissionGroupAdministration) || hasGrant(command.Grants, domain.PermissionMemberManagement) {
			var isDefault bool
			if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM group_settings WHERE group_id=? AND default_role_id=?)`,
				membership.GroupID, roleID).Scan(&isDefault); err != nil {
				return err
			}
			if isDefault {
				return domain.ValidationError{Field: "grants", Message: "the default role must not grant GROUP_ADMINISTRATION or MEMBER_MANAGEMENT"}
			}
		}
		if err := validateUniqueRoleName(ctx, tx, membership.GroupID, roleID, command.Name); err != nil {
			return err
		}
		result, err := tx.ExecContext(ctx, `UPDATE roles SET name=?,description=?,version=version+1,updated_at=?,updated_by=? WHERE id=? AND group_id=? AND version=?`, command.Name, command.Description, now, actor.UserID, roleID, membership.GroupID, expectedVersion)
		if err != nil {
			return mapRoleConstraintError(err)
		}
		if changed, _ := result.RowsAffected(); changed != 1 {
			return domain.ErrPrecondition
		}
		if err := replaceRoleGrantsTx(ctx, tx, actor.UserID, membership.GroupID, roleID, command.Grants, now); err != nil {
			return err
		}
		if err := audit.Record(ctx, tx, membership.GroupID, actor.UserID, membership.ID, "role.updated", "role", roleID, map[string]any{"previousVersion": expectedVersion, "role": command}); err != nil {
			return err
		}
		updated, err = loadManagedRole(ctx, tx, membership.GroupID, roleID)
		return err
	})
	return updated, err
}

// DeleteRole deletes an unused deletable role when expectedVersion matches.
// RoleInUseError includes active-member and open-invitation impact counts.
func (s Service) DeleteRole(ctx context.Context, actor domain.Principal, membership domain.Membership, roleID string, expectedVersion int64) error {
	roleID = strings.TrimSpace(roleID)
	if expectedVersion < 1 {
		return domain.ValidationError{Field: "If-Match", Message: "must contain a current role version"}
	}
	if err := requireCurrentPermission(ctx, s.DB, membership, domain.PermissionRoleManagement); err != nil {
		return err
	}
	return storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		if err := requireCurrentPermission(ctx, tx, membership, domain.PermissionRoleManagement); err != nil {
			return err
		}
		current, err := loadManagedRole(ctx, tx, membership.GroupID, roleID)
		if err != nil {
			return err
		}
		if current.Version != expectedVersion {
			return domain.ErrPrecondition
		}
		if current.PresetKey == domain.RolePresetGroupAdministrator || !current.Deletable {
			return fmt.Errorf("%w: reserved roles cannot be deleted", domain.ErrConflict)
		}
		if hasGrant(current.Grants, domain.PermissionGroupAdministration) {
			if err := requireCurrentPermission(ctx, tx, membership, domain.PermissionGroupAdministration); err != nil {
				return err
			}
		}
		if current.MemberCount > 0 || current.PendingInvitationCount > 0 {
			return RoleInUseError{MemberCount: current.MemberCount, PendingInvitationCount: current.PendingInvitationCount}
		}
		var isDefault bool
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM group_settings WHERE group_id=? AND default_role_id=?)`, membership.GroupID, roleID).Scan(&isDefault); err != nil {
			return err
		}
		if isDefault {
			return fmt.Errorf("%w: default role cannot be deleted", domain.ErrConflict)
		}
		result, err := tx.ExecContext(ctx, `DELETE FROM roles WHERE id=? AND group_id=? AND version=? AND (preset_key IS NULL OR preset_key!='GROUP_ADMINISTRATOR') AND deletable=1`, roleID, membership.GroupID, expectedVersion)
		if err != nil {
			return err
		}
		if changed, _ := result.RowsAffected(); changed != 1 {
			return domain.ErrPrecondition
		}
		return audit.Record(ctx, tx, membership.GroupID, actor.UserID, membership.ID, "role.deleted", "role", roleID, map[string]any{"name": current.Name, "version": current.Version})
	})
}

// ListRoleAssignments returns aggregate role sets for active memberships and
// open invitations in membership's group. MEMBER_MANAGEMENT is required.
func (s Service) ListRoleAssignments(ctx context.Context, membership domain.Membership) ([]AssignmentSet, error) {
	if err := requireCurrentPermission(ctx, s.DB, membership, domain.PermissionMemberManagement); err != nil {
		return nil, err
	}
	result := make([]AssignmentSet, 0)
	memberRows, err := s.DB.QueryContext(ctx, `SELECT id,role_assignments_version FROM memberships WHERE group_id=? AND status='ACTIVE' ORDER BY id`, membership.GroupID)
	if err != nil {
		return nil, err
	}
	defer memberRows.Close()
	for memberRows.Next() {
		var item AssignmentSet
		item.SubjectType = domain.RoleAssignmentMembership
		if err := memberRows.Scan(&item.SubjectID, &item.Version); err != nil {
			memberRows.Close()
			return nil, err
		}
		result = append(result, item)
	}
	if err := memberRows.Err(); err != nil {
		memberRows.Close()
		return nil, err
	}
	if err := memberRows.Close(); err != nil {
		return nil, err
	}
	invitationRows, err := s.DB.QueryContext(ctx, `SELECT id,role_assignments_version FROM invitations WHERE group_id=? AND accepted_at IS NULL AND revoked_at IS NULL AND julianday(expires_at)>julianday('now') ORDER BY id`, membership.GroupID)
	if err != nil {
		return nil, err
	}
	defer invitationRows.Close()
	for invitationRows.Next() {
		var item AssignmentSet
		item.SubjectType = domain.RoleAssignmentInvitation
		if err := invitationRows.Scan(&item.SubjectID, &item.Version); err != nil {
			invitationRows.Close()
			return nil, err
		}
		result = append(result, item)
	}
	if err := invitationRows.Err(); err != nil {
		invitationRows.Close()
		return nil, err
	}
	if err := invitationRows.Close(); err != nil {
		return nil, err
	}
	for index := range result {
		result[index].RoleIDs, err = assignedRoleIDs(ctx, s.DB, membership.GroupID, result[index].SubjectType, result[index].SubjectID)
		if err != nil {
			return nil, err
		}
	}
	return result, nil
}

// ReplaceMemberRoles atomically replaces one active membership's non-empty role
// set. Removal of the final reserved administrator assignment is rejected
// inside the same write transaction.
func (s Service) ReplaceMemberRoles(ctx context.Context, actor domain.Principal, membership domain.Membership, targetMembershipID string, roleIDs []string, expectedVersion int64) (AssignmentSet, error) {
	return s.replaceAssignedRoles(ctx, actor, membership, domain.RoleAssignmentMembership, targetMembershipID, roleIDs, expectedVersion)
}

// ReplaceInvitationRoles atomically replaces one open invitation's non-empty
// role set. Assignment versioning protects concurrent edits.
func (s Service) ReplaceInvitationRoles(ctx context.Context, actor domain.Principal, membership domain.Membership, invitationID string, roleIDs []string, expectedVersion int64) (AssignmentSet, error) {
	return s.replaceAssignedRoles(ctx, actor, membership, domain.RoleAssignmentInvitation, invitationID, roleIDs, expectedVersion)
}

func (s Service) replaceAssignedRoles(ctx context.Context, actor domain.Principal, membership domain.Membership, targetType domain.RoleAssignmentTargetType, targetID string, roleIDs []string, expectedVersion int64) (AssignmentSet, error) {
	targetID = strings.TrimSpace(targetID)
	if targetID == "" || expectedVersion < 1 {
		return AssignmentSet{}, domain.ValidationError{Field: "roleAssignment", Message: "target and a current version are required"}
	}
	roleIDs = normalizeRoleIDs(roleIDs)
	if len(roleIDs) == 0 {
		return AssignmentSet{}, domain.ValidationError{Field: "roleIds", Message: "must contain at least one role"}
	}
	if err := requireCurrentPermission(ctx, s.DB, membership, domain.PermissionMemberManagement); err != nil {
		return AssignmentSet{}, err
	}
	var result AssignmentSet
	err := storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		if err := requireCurrentPermission(ctx, tx, membership, domain.PermissionMemberManagement); err != nil {
			return err
		}
		var currentVersion int64
		switch targetType {
		case domain.RoleAssignmentMembership:
			var credentialless bool
			err := tx.QueryRowContext(ctx, `SELECT m.role_assignments_version,(u.email IS NULL AND u.password_hash IS NULL)
				FROM memberships m JOIN users u ON u.id=m.user_id
				WHERE m.id=? AND m.group_id=? AND m.status='ACTIVE'`, targetID, membership.GroupID).Scan(&currentVersion, &credentialless)
			if errors.Is(err, sql.ErrNoRows) {
				return domain.ErrNotFound
			}
			if err != nil {
				return err
			}
			if credentialless {
				return fmt.Errorf("%w: temporary guests do not accept direct role assignments", domain.ErrConflict)
			}
		case domain.RoleAssignmentInvitation:
			var isClaimInvitation bool
			err := tx.QueryRowContext(ctx, `SELECT role_assignments_version,target_membership_id IS NOT NULL FROM invitations WHERE id=? AND group_id=? AND accepted_at IS NULL AND revoked_at IS NULL AND julianday(expires_at)>julianday('now')`, targetID, membership.GroupID).Scan(&currentVersion, &isClaimInvitation)
			if errors.Is(err, sql.ErrNoRows) {
				return domain.ErrNotFound
			}
			if err != nil {
				return err
			}
			if isClaimInvitation {
				return fmt.Errorf("%w: claim invitation roles are fixed when the invitation is created", domain.ErrConflict)
			}
		default:
			return domain.ValidationError{Field: "subjectType", Message: "must be MEMBERSHIP or INVITATION"}
		}
		if currentVersion != expectedVersion {
			return domain.ErrPrecondition
		}
		adminRoleID, err := reservedAdministratorRoleID(ctx, tx, membership.GroupID)
		if err != nil {
			return err
		}
		currentRoleIDs, err := assignedRoleIDs(ctx, tx, membership.GroupID, targetType, targetID)
		if err != nil {
			return err
		}
		if err := requireAssignmentChangePermissions(ctx, tx, membership, adminRoleID, currentRoleIDs, roleIDs); err != nil {
			return err
		}
		if targetType == domain.RoleAssignmentMembership && containsString(currentRoleIDs, adminRoleID) && !containsString(roleIDs, adminRoleID) {
			var activeAdmins int64
			if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM membership_role_assignments ma JOIN memberships m ON m.id=ma.membership_id AND m.group_id=ma.group_id WHERE ma.group_id=? AND ma.role_id=? AND m.status='ACTIVE'`, membership.GroupID, adminRoleID).Scan(&activeAdmins); err != nil {
				return err
			}
			if activeAdmins <= 1 {
				return fmt.Errorf("%w: the final reserved group administrator cannot be removed", domain.ErrConflict)
			}
		}
		if err := validateAssignedRoles(ctx, tx, membership.GroupID, roleIDs); err != nil {
			return err
		}
		now := platform.Timestamp(platform.Now())
		if err := replaceAssignmentRowsTx(ctx, tx, actor.UserID, membership.GroupID, targetType, targetID, currentRoleIDs, roleIDs, now); err != nil {
			return err
		}
		var finalVersion int64
		if targetType == domain.RoleAssignmentMembership {
			err = tx.QueryRowContext(ctx, `SELECT role_assignments_version FROM memberships WHERE id=? AND group_id=?`, targetID, membership.GroupID).Scan(&finalVersion)
		} else {
			err = tx.QueryRowContext(ctx, `SELECT role_assignments_version FROM invitations WHERE id=? AND group_id=?`, targetID, membership.GroupID).Scan(&finalVersion)
		}
		if err != nil {
			return err
		}
		result = AssignmentSet{SubjectType: targetType, SubjectID: targetID, RoleIDs: roleIDs, Version: finalVersion}
		return audit.Record(ctx, tx, membership.GroupID, actor.UserID, membership.ID, "role.assignments.updated", strings.ToLower(string(targetType)), targetID, result)
	})
	return result, err
}

func normalizeRoleCommand(command RoleCommand) (RoleCommand, error) {
	command.Name = strings.TrimSpace(command.Name)
	command.Description = strings.TrimSpace(command.Description)
	if command.Name == "" || len(command.Name) > 120 || containsControlCharacter(command.Name) {
		return RoleCommand{}, domain.ValidationError{Field: "name", Message: "must contain 1 to 120 characters without control characters"}
	}
	if len(command.Description) > 500 || containsControlCharacter(command.Description) {
		return RoleCommand{}, domain.ValidationError{Field: "description", Message: "must contain at most 500 characters without control characters"}
	}
	seen := make(map[domain.PermissionKey]struct{}, len(command.Grants))
	grants := make([]domain.PermissionGrant, 0, len(command.Grants))
	for _, grant := range command.Grants {
		if grant.Scope.Type != domain.PermissionScopeGroup || grant.Scope.CategoryID != "" || grant.Scope.ProductID != "" {
			return RoleCommand{}, domain.ValidationError{Field: "grants", Message: "CATEGORY and PRODUCT scopes are not enabled in this API version"}
		}
		if err := authorization.ValidateGrant(grant); err != nil {
			return RoleCommand{}, err
		}
		if _, duplicate := seen[grant.Permission]; duplicate {
			continue
		}
		seen[grant.Permission] = struct{}{}
		grants = append(grants, grant)
	}
	sort.Slice(grants, func(i, j int) bool { return grants[i].Permission < grants[j].Permission })
	command.Grants = grants
	return command, nil
}

func roleGrants(ctx context.Context, queryer roleQueryer, groupID, roleID string) ([]domain.PermissionGrant, error) {
	rows, err := queryer.QueryContext(ctx, `SELECT permission_key,scope_type,coalesce(category_id,''),coalesce(product_id,'') FROM role_permission_grants WHERE group_id=? AND role_id=? ORDER BY permission_key,scope_type,category_id,product_id`, groupID, roleID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	grants := make([]domain.PermissionGrant, 0)
	for rows.Next() {
		var grant domain.PermissionGrant
		if err := rows.Scan(&grant.Permission, &grant.Scope.Type, &grant.Scope.CategoryID, &grant.Scope.ProductID); err != nil {
			return nil, err
		}
		grants = append(grants, grant)
	}
	return grants, rows.Err()
}

func loadManagedRole(ctx context.Context, queryer roleQueryer, groupID, roleID string) (ManagedRole, error) {
	var item ManagedRole
	err := queryer.QueryRowContext(ctx, `SELECT r.id,r.group_id,coalesce(r.preset_key,''),r.name,coalesce(r.description,''),r.name_locked,r.deletable,r.version,r.created_at,r.updated_at,
		(SELECT count(*) FROM membership_role_assignments ma JOIN memberships m ON m.id=ma.membership_id AND m.group_id=ma.group_id WHERE ma.group_id=r.group_id AND ma.role_id=r.id AND m.status='ACTIVE'),
		(SELECT count(*) FROM invitation_role_assignments ia JOIN invitations i ON i.id=ia.invitation_id AND i.group_id=ia.group_id WHERE ia.group_id=r.group_id AND ia.role_id=r.id AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND julianday(i.expires_at)>julianday('now'))
		FROM roles r WHERE r.id=? AND r.group_id=?`, roleID, groupID).
		Scan(&item.ID, &item.GroupID, &item.PresetKey, &item.Name, &item.Description, &item.NameLocked, &item.Deletable, &item.Version, &item.CreatedAt, &item.UpdatedAt, &item.MemberCount, &item.PendingInvitationCount)
	if errors.Is(err, sql.ErrNoRows) {
		return ManagedRole{}, domain.ErrNotFound
	}
	if err != nil {
		return ManagedRole{}, err
	}
	item.Grants, err = roleGrants(ctx, queryer, groupID, roleID)
	return item, err
}

func replaceRoleGrantsTx(ctx context.Context, tx *sql.Tx, actorUserID, groupID, roleID string, grants []domain.PermissionGrant, now string) error {
	existing, err := roleGrants(ctx, tx, groupID, roleID)
	if err != nil {
		return err
	}
	desired := make(map[string]domain.PermissionGrant, len(grants))
	for _, grant := range grants {
		desired[grantKey(grant)] = grant
	}
	existingByKey := make(map[string]domain.PermissionGrant, len(existing))
	for _, grant := range existing {
		existingByKey[grantKey(grant)] = grant
		if _, keep := desired[grantKey(grant)]; keep {
			continue
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM role_permission_grants WHERE group_id=? AND role_id=? AND permission_key=? AND scope_type=? AND ifnull(category_id,'')=? AND ifnull(product_id,'')=?`, groupID, roleID, grant.Permission, grant.Scope.Type, grant.Scope.CategoryID, grant.Scope.ProductID); err != nil {
			return err
		}
	}
	for key, grant := range desired {
		if _, exists := existingByKey[key]; exists {
			continue
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO role_permission_grants(group_id,role_id,permission_key,scope_type,category_id,product_id,version,created_at,updated_at,created_by,updated_by) VALUES(?,?,?,?,nullif(?,''),nullif(?,''),1,?,?,?,?)`, groupID, roleID, grant.Permission, grant.Scope.Type, grant.Scope.CategoryID, grant.Scope.ProductID, now, now, actorUserID, actorUserID); err != nil {
			return err
		}
	}
	return nil
}

func replaceAssignmentRowsTx(ctx context.Context, tx *sql.Tx, actorUserID, groupID string, targetType domain.RoleAssignmentTargetType, targetID string, previous, next []string, now string) error {
	for _, roleID := range next {
		if containsString(previous, roleID) {
			continue
		}
		query := `INSERT INTO membership_role_assignments(group_id,membership_id,role_id,version,assigned_at,assigned_by) VALUES(?,?,?,1,?,?)`
		if targetType == domain.RoleAssignmentInvitation {
			query = `INSERT INTO invitation_role_assignments(group_id,invitation_id,role_id,version,assigned_at,assigned_by) VALUES(?,?,?,1,?,?)`
		}
		if _, err := tx.ExecContext(ctx, query, groupID, targetID, roleID, now, actorUserID); err != nil {
			return err
		}
	}
	for _, roleID := range previous {
		if containsString(next, roleID) {
			continue
		}
		query := `DELETE FROM membership_role_assignments WHERE group_id=? AND membership_id=? AND role_id=?`
		if targetType == domain.RoleAssignmentInvitation {
			query = `DELETE FROM invitation_role_assignments WHERE group_id=? AND invitation_id=? AND role_id=?`
		}
		if _, err := tx.ExecContext(ctx, query, groupID, targetID, roleID); err != nil {
			return err
		}
	}
	return nil
}

func validateUniqueRoleName(ctx context.Context, queryer roleQueryer, groupID, exceptRoleID, name string) error {
	rows, err := queryer.QueryContext(ctx, `SELECT id,name FROM roles WHERE group_id=?`, groupID)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var roleID, existing string
		if err := rows.Scan(&roleID, &existing); err != nil {
			return err
		}
		if roleID != exceptRoleID && strings.EqualFold(strings.TrimSpace(existing), name) {
			return domain.ValidationError{Field: "name", Message: "must be unique within the group, ignoring letter case"}
		}
	}
	return rows.Err()
}

func mapRoleConstraintError(err error) error {
	if strings.Contains(strings.ToLower(err.Error()), "unique") {
		return domain.ValidationError{Field: "name", Message: "must be unique within the group, ignoring letter case"}
	}
	return err
}

func hasGrant(grants []domain.PermissionGrant, permission domain.PermissionKey) bool {
	for _, grant := range grants {
		if grant.Permission == permission && grant.Scope.Type == domain.PermissionScopeGroup {
			return true
		}
	}
	return false
}

func normalizeRoleIDs(roleIDs []string) []string {
	seen := make(map[string]struct{}, len(roleIDs))
	result := make([]string, 0, len(roleIDs))
	for _, roleID := range roleIDs {
		roleID = strings.TrimSpace(roleID)
		if roleID == "" {
			continue
		}
		if _, duplicate := seen[roleID]; duplicate {
			continue
		}
		seen[roleID] = struct{}{}
		result = append(result, roleID)
	}
	sort.Strings(result)
	return result
}

func assignedRoleIDs(ctx context.Context, queryer roleQueryer, groupID string, targetType domain.RoleAssignmentTargetType, targetID string) ([]string, error) {
	query := `SELECT role_id FROM membership_role_assignments WHERE group_id=? AND membership_id=? ORDER BY role_id`
	if targetType == domain.RoleAssignmentInvitation {
		query = `SELECT role_id FROM invitation_role_assignments WHERE group_id=? AND invitation_id=? ORDER BY role_id`
	}
	rows, err := queryer.QueryContext(ctx, query, groupID, targetID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]string, 0)
	for rows.Next() {
		var roleID string
		if err := rows.Scan(&roleID); err != nil {
			return nil, err
		}
		result = append(result, roleID)
	}
	return result, rows.Err()
}

func reservedAdministratorRoleID(ctx context.Context, queryer roleQueryer, groupID string) (string, error) {
	var roleID string
	if err := queryer.QueryRowContext(ctx, `SELECT id FROM roles WHERE group_id=? AND preset_key='GROUP_ADMINISTRATOR'`, groupID).Scan(&roleID); err != nil {
		return "", err
	}
	return roleID, nil
}

func validateAssignedRoles(ctx context.Context, queryer roleQueryer, groupID string, roleIDs []string) error {
	if len(roleIDs) == 0 {
		return domain.ValidationError{Field: "roleIds", Message: "must contain at least one role"}
	}
	for _, roleID := range roleIDs {
		var roleGroupID string
		err := queryer.QueryRowContext(ctx, `SELECT group_id FROM roles WHERE id=?`, roleID).Scan(&roleGroupID)
		if errors.Is(err, sql.ErrNoRows) {
			return domain.ValidationError{Field: "roleIds", Message: "contains an unknown role"}
		}
		if err != nil {
			return err
		}
		if roleGroupID != groupID {
			return domain.ErrForbidden
		}
	}
	return nil
}

func assignmentTouchesAdministration(ctx context.Context, queryer roleQueryer, groupID string, previous, next []string) (bool, error) {
	changed := make(map[string]struct{})
	for _, roleID := range previous {
		if !containsString(next, roleID) {
			changed[roleID] = struct{}{}
		}
	}
	for _, roleID := range next {
		if !containsString(previous, roleID) {
			changed[roleID] = struct{}{}
		}
	}
	for roleID := range changed {
		var count int
		err := queryer.QueryRowContext(ctx, `SELECT count(*) FROM role_permission_grants WHERE group_id=? AND role_id=? AND permission_key='GROUP_ADMINISTRATION' AND scope_type='GROUP'`, groupID, roleID).Scan(&count)
		if err != nil {
			return false, err
		}
		if count > 0 {
			return true, nil
		}
	}
	return false, nil
}

func requireAssignmentChangePermissions(ctx context.Context, queryer roleQueryer, membership domain.Membership, reservedAdminRoleID string, previous, next []string) error {
	if err := requireCurrentPermission(ctx, queryer, membership, domain.PermissionMemberManagement); err != nil {
		return err
	}
	reservedAdminChanged := containsString(previous, reservedAdminRoleID) != containsString(next, reservedAdminRoleID)
	protectedChange, err := assignmentTouchesAdministration(ctx, queryer, membership.GroupID, previous, next)
	if err != nil {
		return err
	}
	if reservedAdminChanged || protectedChange {
		if err := requireCurrentPermission(ctx, queryer, membership, domain.PermissionGroupAdministration); err != nil {
			return err
		}
	}
	return nil
}

func containsString(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}
