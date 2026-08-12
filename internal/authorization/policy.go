// Package authorization resolves dynamic group roles into effective permissions.
// It is the only package that should interpret role permission grants; callers
// must authorize by stable permission keys rather than role names or preset keys.
package authorization

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/DasLukas/TeamTaler/internal/domain"
)

var permissionDefinitions = []domain.PermissionDefinition{
	{
		Key:         domain.PermissionGroupAdministration,
		Description: "Manage group identity, behavior settings, audit access, and protected administrator assignments.",
	},
	{
		Key:                domain.PermissionMemberManagement,
		Description:        "Manage memberships, invitations, guests, join access, and role assignments.",
		ImpliedPermissions: []domain.PermissionKey{domain.PermissionViewMemberDirectory},
	},
	{
		Key:         domain.PermissionRoleManagement,
		Description: "Manage roles and permission grants.",
	},
	{
		Key:         domain.PermissionFinanceManagement,
		Description: "Manage payments, payment reversals, accounts, and accounting periods.",
	},
	{
		Key:         domain.PermissionCatalogManagement,
		Description: "Manage categories, products, sorting, and product images.",
	},
	{
		Key:         domain.PermissionViewMemberDirectory,
		Description: "View the active member directory without administrative account details.",
	},
	{
		Key:         domain.PermissionViewGroupStatistics,
		Description: "View the current consolidated group balance.",
	},
	{
		Key:         domain.PermissionViewAllBookingActivity,
		Description: "View identified booking activity for every member in the group activity feed.",
	},
	{
		Key:         domain.PermissionRecordOwnPayment,
		Description: "Record a payment for the current membership through the self-service endpoint.",
	},
	{
		Key:         domain.PermissionCreateOwnBooking,
		Description: "Create a booking that charges the current membership.",
	},
	{
		Key:         domain.PermissionVoidOwnBooking,
		Description: "Void bookings where the current membership is either actor or target.",
	},
	{
		Key:                domain.PermissionVoidAnyBooking,
		Description:        "Void every booking in the group.",
		ImpliedPermissions: []domain.PermissionKey{domain.PermissionVoidOwnBooking, domain.PermissionViewAllBookingActivity},
	},
	{
		Key:                domain.PermissionBookForOthers,
		Description:        "Create a reasoned booking that targets another credentialed active membership.",
		ImpliedPermissions: []domain.PermissionKey{domain.PermissionViewMemberDirectory},
	},
	{
		Key:         domain.PermissionBookForGuests,
		Description: "Create bookings for existing or newly created temporary guests.",
	},
}

var permissionOrder = func() map[domain.PermissionKey]int {
	order := make(map[domain.PermissionKey]int, len(permissionDefinitions))
	for index, definition := range permissionDefinitions {
		order[definition.Key] = index
	}
	return order
}()

// Queryer is the read-only database contract accepted by Policy. Both sql.DB and
// sql.Tx implement it, allowing a caller to re-check authorization in the same
// serialized write transaction as a protected mutation.
type Queryer interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

// ResourceContext identifies the tenant and optional resource addressed by an
// authorization decision. GroupID is always required. CategoryID and ProductID
// are forward-compatible context for future scoped grants.
type ResourceContext struct {
	GroupID    string
	CategoryID string
	ProductID  string
}

// GroupResource constructs a group-only resource context.
//
// Parameters:
//   - groupID: Stable identifier of the group being accessed.
//
// Returns:
//   - ResourceContext: A context that matches GROUP grants in the same group.
//
// This function cannot fail. Example: GroupResource(membership.GroupID).
func GroupResource(groupID string) ResourceContext {
	return ResourceContext{GroupID: strings.TrimSpace(groupID)}
}

// Policy resolves effective grants from the current database state without a
// cross-request permission cache. Construct a Policy around sql.Tx for critical
// writes so permission revocation and the mutation are serialized together.
type Policy struct {
	queryer Queryer
}

// NewPolicy constructs a permission policy backed by queryer.
//
// Parameters:
//   - queryer: A live sql.DB, sql.Tx, or compatible read-only query implementation.
//
// Returns:
//   - Policy: A stateless policy that reads assignments for every decision.
//
// NewPolicy cannot validate a nil interface up front; Can and EffectiveGrants
// return an error if no queryer was supplied. Example: policy := NewPolicy(tx).
func NewPolicy(queryer Queryer) Policy {
	return Policy{queryer: queryer}
}

// Definitions returns the supported permission catalogue in stable display order.
//
// Returns:
//   - []domain.PermissionDefinition: A defensive copy safe for caller mutation.
//
// This function takes no parameters and cannot fail. Implied permissions are
// included for client explanation but are still calculated by the server.
func Definitions() []domain.PermissionDefinition {
	definitions := make([]domain.PermissionDefinition, len(permissionDefinitions))
	for index, definition := range permissionDefinitions {
		definitions[index] = definition
		definitions[index].ImpliedPermissions = append(make([]domain.PermissionKey, 0, len(definition.ImpliedPermissions)), definition.ImpliedPermissions...)
	}
	return definitions
}

// IsKnownPermission reports whether permission is supported by this binary.
//
// Parameters:
//   - permission: Stable permission key to inspect.
//
// Returns:
//   - bool: True only when permission is present in Definitions.
//
// This function cannot fail.
func IsKnownPermission(permission domain.PermissionKey) bool {
	_, known := permissionOrder[permission]
	return known
}

// ExpandPermissions returns the deterministic union of permissions and all
// calculated implications. Duplicate inputs are removed and transitive
// implications are expanded without persisting extra grants.
//
// Parameters:
//   - permissions: Direct permission keys collected from any number of roles.
//
// Returns:
//   - []domain.PermissionKey: Unique direct and implied keys in catalogue order.
//
// Unknown keys are retained after known keys so this pure helper never silently
// discards caller data; policy entry points reject unknown requested keys.
func ExpandPermissions(permissions []domain.PermissionKey) []domain.PermissionKey {
	effective := make(map[domain.PermissionKey]struct{}, len(permissions)+2)
	implications := make(map[domain.PermissionKey][]domain.PermissionKey, len(permissionDefinitions))
	for _, definition := range permissionDefinitions {
		implications[definition.Key] = definition.ImpliedPermissions
	}
	queue := append(make([]domain.PermissionKey, 0, len(permissions)), permissions...)
	for len(queue) > 0 {
		permission := queue[0]
		queue = queue[1:]
		if _, seen := effective[permission]; seen {
			continue
		}
		effective[permission] = struct{}{}
		queue = append(queue, implications[permission]...)
	}
	result := make([]domain.PermissionKey, 0, len(effective))
	for permission := range effective {
		result = append(result, permission)
	}
	sort.Slice(result, func(left, right int) bool {
		leftOrder, leftKnown := permissionOrder[result[left]]
		rightOrder, rightKnown := permissionOrder[result[right]]
		if leftKnown != rightKnown {
			return leftKnown
		}
		if leftKnown && leftOrder != rightOrder {
			return leftOrder < rightOrder
		}
		return result[left] < result[right]
	})
	return result
}

// ValidateGrant validates a role grant accepted by the v1 mutation contract.
//
// Parameters:
//   - grant: Permission and scope supplied by an API or service caller.
//
// Returns:
//   - error: nil for a known GROUP grant; domain.ErrValidation for unknown keys,
//     malformed group scopes, or reserved CATEGORY and PRODUCT scopes.
//
// Example: ValidateGrant(domain.PermissionGrant{Permission:
// domain.PermissionBookForOthers, Scope: domain.PermissionScope{Type:
// domain.PermissionScopeGroup}}).
func ValidateGrant(grant domain.PermissionGrant) error {
	if !IsKnownPermission(grant.Permission) {
		return domain.ValidationError{Field: "permission", Message: "contains an unsupported permission"}
	}
	switch grant.Scope.Type {
	case domain.PermissionScopeGroup:
		if strings.TrimSpace(grant.Scope.CategoryID) != "" || strings.TrimSpace(grant.Scope.ProductID) != "" {
			return domain.ValidationError{Field: "scope", Message: "group scope cannot identify a category or product"}
		}
		return nil
	case domain.PermissionScopeCategory, domain.PermissionScopeProduct:
		return domain.ValidationError{Field: "scope.type", Message: "category and product scopes are reserved for a future API version"}
	default:
		return domain.ValidationError{Field: "scope.type", Message: "contains an unsupported permission scope"}
	}
}

// EffectiveGrants resolves the union of every role assigned to one active
// membership and adds calculated permission implications at the same scope.
//
// Parameters:
//   - ctx: Bounds the database query.
//   - groupID: Tenant boundary expected for the membership and every role.
//   - membershipID: Active membership whose current assignments are resolved.
//
// Returns:
//   - []domain.PermissionGrant: Unique effective grants in deterministic order.
//   - error: Database failures or validation failures for empty identifiers.
//
// A missing, archived, or cross-group membership safely resolves to an empty
// grant slice. No permission result is cached between calls.
func (p Policy) EffectiveGrants(ctx context.Context, groupID, membershipID string) ([]domain.PermissionGrant, error) {
	groupID = strings.TrimSpace(groupID)
	membershipID = strings.TrimSpace(membershipID)
	if groupID == "" {
		return nil, domain.ValidationError{Field: "groupId", Message: "is required"}
	}
	if membershipID == "" {
		return nil, domain.ValidationError{Field: "membershipId", Message: "is required"}
	}
	if p.queryer == nil {
		return nil, errors.New("authorization policy requires a database queryer")
	}

	rows, err := p.queryer.QueryContext(ctx, `
		SELECT g.permission_key,g.scope_type,coalesce(g.category_id,''),coalesce(g.product_id,'')
		FROM memberships m
		JOIN membership_role_assignments a
		  ON a.group_id=m.group_id AND a.membership_id=m.id
		JOIN role_permission_grants g
		  ON g.group_id=a.group_id AND g.role_id=a.role_id
		WHERE m.group_id=? AND m.id=? AND m.status='ACTIVE'
		ORDER BY g.permission_key,g.scope_type,g.category_id,g.product_id`, groupID, membershipID)
	if err != nil {
		return nil, fmt.Errorf("query effective permission grants: %w", err)
	}
	defer rows.Close()

	directByScope := make(map[scopeIdentity][]domain.PermissionKey)
	for rows.Next() {
		var permission domain.PermissionKey
		var scope domain.PermissionScope
		if err := rows.Scan(&permission, &scope.Type, &scope.CategoryID, &scope.ProductID); err != nil {
			return nil, fmt.Errorf("scan effective permission grant: %w", err)
		}
		identity := scopeIdentity{scopeType: scope.Type, categoryID: scope.CategoryID, productID: scope.ProductID}
		directByScope[identity] = append(directByScope[identity], permission)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate effective permission grants: %w", err)
	}

	unique := make(map[grantIdentity]domain.PermissionGrant)
	for identity, directPermissions := range directByScope {
		for _, permission := range ExpandPermissions(directPermissions) {
			grant := domain.PermissionGrant{
				Permission: permission,
				Scope: domain.PermissionScope{
					Type:       identity.scopeType,
					CategoryID: identity.categoryID,
					ProductID:  identity.productID,
				},
			}
			unique[grantIdentity{permission: permission, scopeIdentity: identity}] = grant
		}
	}

	grants := make([]domain.PermissionGrant, 0, len(unique))
	for _, grant := range unique {
		grants = append(grants, grant)
	}
	sort.Slice(grants, func(left, right int) bool {
		leftOrder, leftKnown := permissionOrder[grants[left].Permission]
		rightOrder, rightKnown := permissionOrder[grants[right].Permission]
		if leftKnown != rightKnown {
			return leftKnown
		}
		if leftOrder != rightOrder {
			return leftOrder < rightOrder
		}
		if grants[left].Scope.Type != grants[right].Scope.Type {
			return grants[left].Scope.Type < grants[right].Scope.Type
		}
		if grants[left].Scope.CategoryID != grants[right].Scope.CategoryID {
			return grants[left].Scope.CategoryID < grants[right].Scope.CategoryID
		}
		return grants[left].Scope.ProductID < grants[right].Scope.ProductID
	})
	return grants, nil
}

// Can reports whether an active membership currently has permission for resource.
//
// Parameters:
//   - ctx: Bounds database reads.
//   - groupID: Tenant boundary of the authenticated membership.
//   - membershipID: Membership subject of the decision.
//   - permission: Stable permission key requested by the operation.
//   - resource: Group and optional resource identifiers being accessed.
//
// Returns:
//   - bool: True when at least one effective grant covers resource.
//   - error: Validation or database errors. A normal denial returns false, nil.
//
// GROUP grants cover group, category, and product resources in the same tenant.
// Reserved scoped grants match only their exact category or product identifier.
func (p Policy) Can(ctx context.Context, groupID, membershipID string, permission domain.PermissionKey, resource ResourceContext) (bool, error) {
	groupID = strings.TrimSpace(groupID)
	if !IsKnownPermission(permission) {
		return false, domain.ValidationError{Field: "permission", Message: "contains an unsupported permission"}
	}
	resource.GroupID = strings.TrimSpace(resource.GroupID)
	if resource.GroupID == "" {
		return false, domain.ValidationError{Field: "resource.groupId", Message: "is required"}
	}
	if resource.GroupID != groupID {
		return false, nil
	}

	grants, err := p.EffectiveGrants(ctx, groupID, membershipID)
	if err != nil {
		return false, err
	}
	for _, grant := range grants {
		if grant.Permission != permission {
			continue
		}
		switch grant.Scope.Type {
		case domain.PermissionScopeGroup:
			return true, nil
		case domain.PermissionScopeCategory:
			if grant.Scope.CategoryID != "" && grant.Scope.CategoryID == resource.CategoryID {
				return true, nil
			}
		case domain.PermissionScopeProduct:
			if grant.Scope.ProductID != "" && grant.Scope.ProductID == resource.ProductID {
				return true, nil
			}
		}
	}
	return false, nil
}

// Require enforces one permission using queryer's current database snapshot.
//
// Parameters:
//   - ctx: Bounds database reads.
//   - queryer: sql.DB or the same sql.Tx used by the protected mutation.
//   - groupID: Tenant boundary of membershipID.
//   - membershipID: Active membership subject of the decision.
//   - permission: Stable permission required by the operation.
//   - resource: Group and optional resource addressed by the operation.
//
// Returns:
//   - error: nil when allowed, domain.ErrForbidden for a normal denial, or the
//     underlying validation/database error when the decision cannot be made.
//
// Example: Require(ctx, tx, groupID, membershipID,
// domain.PermissionRoleManagement, GroupResource(groupID)).
func Require(ctx context.Context, queryer Queryer, groupID, membershipID string, permission domain.PermissionKey, resource ResourceContext) error {
	allowed, err := NewPolicy(queryer).Can(ctx, groupID, membershipID, permission, resource)
	if err != nil {
		return err
	}
	if !allowed {
		return domain.ErrForbidden
	}
	return nil
}

// PresetRoleID returns the deterministic stable identifier used for a seeded role.
//
// Parameters:
//   - groupID: Group that owns the role.
//   - preset: One of the four supported preset keys.
//
// Returns:
//   - string: Identifier in role:<PRESET>:<GROUP> form.
//
// This function cannot fail. Callers must validate non-empty identifiers before
// persistence. Example: PresetRoleID(groupID, domain.RolePresetMember).
func PresetRoleID(groupID string, preset domain.RolePresetKey) string {
	return "role:" + string(preset) + ":" + strings.TrimSpace(groupID)
}

// SeedGroupRoles idempotently ensures the four preset roles, their initial grants,
// and the creator's member and group-administrator assignments inside tx.
//
// Parameters:
//   - ctx: Bounds all seed statements.
//   - tx: Existing transaction that already contains the group and membership.
//   - groupID: Group receiving the presets.
//   - actorUserID: User recorded in role and assignment audit fields; may be empty.
//   - adminMembershipID: Active creator membership receiving protected admin access.
//   - now: Timestamp used consistently for seeded rows.
//
// Returns:
//   - error: Validation failures or a wrapped database error. The caller owns rollback.
//
// The migration's group trigger normally creates the roles before this helper is
// called; INSERT OR IGNORE keeps the helper safe and explicit for bootstrap flows.
func SeedGroupRoles(ctx context.Context, tx *sql.Tx, groupID, actorUserID, adminMembershipID string, now time.Time) error {
	groupID = strings.TrimSpace(groupID)
	actorUserID = strings.TrimSpace(actorUserID)
	adminMembershipID = strings.TrimSpace(adminMembershipID)
	if tx == nil {
		return errors.New("seed group roles requires a transaction")
	}
	if groupID == "" {
		return domain.ValidationError{Field: "groupId", Message: "is required"}
	}
	if adminMembershipID == "" {
		return domain.ValidationError{Field: "adminMembershipId", Message: "is required"}
	}
	timestamp := now.UTC().Format(time.RFC3339Nano)
	actor := nullableString(actorUserID)

	roleSeeds := []struct {
		preset      domain.RolePresetKey
		name        string
		description string
		nameLocked  int
		deletable   int
	}{
		{domain.RolePresetGroupAdministrator, "Group administrator", "Required administrator role with full group access.", 1, 0},
		{domain.RolePresetMember, "Member", "Editable starter role for regular group members.", 0, 1},
		{domain.RolePresetFinanceManager, "Finance manager", "Seeded role for financial management.", 0, 1},
		{domain.RolePresetCatalogManager, "Catalog manager", "Seeded role for catalog management.", 0, 1},
	}
	for _, seed := range roleSeeds {
		if _, err := tx.ExecContext(ctx, `
			INSERT OR IGNORE INTO roles(
				id,group_id,preset_key,name,description,name_locked,deletable,
				version,created_at,updated_at,created_by,updated_by
			) VALUES(?,?,?,?,?,?,?,1,?,?,?,?)`,
			PresetRoleID(groupID, seed.preset), groupID, seed.preset, seed.name,
			seed.description, seed.nameLocked, seed.deletable, timestamp, timestamp, actor, actor); err != nil {
			return fmt.Errorf("seed %s role: %w", seed.preset, err)
		}
	}

	grantsByPreset := map[domain.RolePresetKey][]domain.PermissionKey{
		domain.RolePresetGroupAdministrator: directPermissionKeys(),
		domain.RolePresetMember: {
			domain.PermissionViewMemberDirectory,
			domain.PermissionViewGroupStatistics,
			domain.PermissionCreateOwnBooking,
			domain.PermissionVoidOwnBooking,
		},
		domain.RolePresetFinanceManager: {
			domain.PermissionFinanceManagement,
			domain.PermissionViewMemberDirectory,
			domain.PermissionViewGroupStatistics,
			domain.PermissionViewAllBookingActivity,
			domain.PermissionRecordOwnPayment,
		},
		domain.RolePresetCatalogManager: {
			domain.PermissionCatalogManagement,
			domain.PermissionViewMemberDirectory,
			domain.PermissionViewGroupStatistics,
		},
	}
	for _, seed := range roleSeeds {
		for _, permission := range grantsByPreset[seed.preset] {
			if _, err := tx.ExecContext(ctx, `
				INSERT OR IGNORE INTO role_permission_grants(
					group_id,role_id,permission_key,scope_type,version,
					created_at,updated_at,created_by,updated_by
				) VALUES(?,?,?,'GROUP',1,?,?,?,?)`,
				groupID, PresetRoleID(groupID, seed.preset), permission,
				timestamp, timestamp, actor, actor); err != nil {
				return fmt.Errorf("seed %s grant %s: %w", seed.preset, permission, err)
			}
		}
	}

	for _, preset := range []domain.RolePresetKey{domain.RolePresetGroupAdministrator} {
		if _, err := tx.ExecContext(ctx, `
			INSERT OR IGNORE INTO membership_role_assignments(
				group_id,membership_id,role_id,version,assigned_at,assigned_by
			) VALUES(?,?,?,1,?,?)`,
			groupID, adminMembershipID, PresetRoleID(groupID, preset), timestamp, actor); err != nil {
			return fmt.Errorf("assign creator %s role: %w", preset, err)
		}
	}
	return nil
}

type scopeIdentity struct {
	scopeType  domain.PermissionScopeType
	categoryID string
	productID  string
}

type grantIdentity struct {
	permission domain.PermissionKey
	scopeIdentity
}

func directPermissionKeys() []domain.PermissionKey {
	keys := make([]domain.PermissionKey, 0, len(permissionDefinitions))
	for _, definition := range permissionDefinitions {
		keys = append(keys, definition.Key)
	}
	return keys
}

func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}
