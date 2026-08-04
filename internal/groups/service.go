// Package groups implements group membership, roles, invitations, and isolation checks.
package groups

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/DasLukas/TeamTaler/internal/audit"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

// Service provides authorization-aware group operations over a migrated
// TeamTaler database.
type Service struct {
	// DB is the shared application database connection pool.
	DB *sql.DB
}

// Create creates a group, its initial period, and an administrator membership
// for actor. ctx bounds the transaction; name and currency are validated. It
// returns the new Group or validation, storage, and audit errors.
func (s Service) Create(ctx context.Context, actor domain.Principal, name, currency string) (domain.Group, error) {
	name = strings.TrimSpace(name)
	currency = strings.ToUpper(strings.TrimSpace(currency))
	if name == "" || len(name) > 120 {
		return domain.Group{}, domain.ValidationError{Field: "name", Message: "must contain 1 to 120 characters"}
	}
	if !platform.IsCurrencyCode(currency) {
		return domain.Group{}, domain.ValidationError{Field: "currency", Message: "must be a three-letter ISO 4217 code"}
	}
	groupID, _ := platform.NewID("grp")
	membershipID, _ := platform.NewID("mem")
	periodID, _ := platform.NewID("per")
	now := platform.Timestamp(platform.Now())
	err := storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES(?,?,?,?,?)`, groupID, name, currency, now, now); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO memberships(id,group_id,user_id,status,joined_at) VALUES(?,?,?,'ACTIVE',?)`, membershipID, groupID, actor.UserID, now); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO membership_roles(group_id,membership_id,role,granted_at,granted_by) VALUES(?,?,'ADMIN',?,?)`, groupID, membershipID, now, actor.UserID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO periods(id,group_id,label,status,starts_at,created_at) VALUES(?,?,?,'OPEN',?,?)`, periodID, groupID, "Current period", now, now); err != nil {
			return err
		}
		return audit.Record(ctx, tx, groupID, actor.UserID, membershipID, "group.created", "group", groupID, map[string]any{"name": name, "currency": currency})
	})
	if err != nil {
		return domain.Group{}, fmt.Errorf("create group: %w", err)
	}
	return domain.Group{ID: groupID, Name: name, Currency: currency, Membership: domain.Membership{
		ID: membershipID, GroupID: groupID, UserID: actor.UserID, Email: actor.Email, DisplayName: actor.DisplayName, Status: "ACTIVE", Roles: []domain.Role{domain.RoleAdmin}, CategoryGrants: map[string][]domain.CategoryPermission{},
	}}, nil
}

// List returns all active groups and effective permissions for userID. ctx
// bounds the query; an empty result is valid, while database errors are returned.
func (s Service) List(ctx context.Context, userID string) ([]domain.Group, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT g.id,g.name,g.currency,m.id,m.status,u.email,u.display_name
		FROM memberships m JOIN groups g ON g.id=m.group_id JOIN users u ON u.id=m.user_id
		WHERE m.user_id=? AND m.status='ACTIVE' ORDER BY lower(g.name)`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]domain.Group, 0)
	for rows.Next() {
		var group domain.Group
		group.Membership.UserID = userID
		if err := rows.Scan(&group.ID, &group.Name, &group.Currency, &group.Membership.ID, &group.Membership.Status, &group.Membership.Email, &group.Membership.DisplayName); err != nil {
			return nil, err
		}
		group.Membership.GroupID = group.ID
		group.Membership.Roles, err = s.roles(ctx, group.Membership.ID)
		if err != nil {
			return nil, err
		}
		group.Membership.CategoryGrants, err = s.categoryGrants(ctx, group.Membership.ID)
		if err != nil {
			return nil, err
		}
		result = append(result, group)
	}
	return result, rows.Err()
}

// MembershipForUser verifies that userID actively belongs to groupID and returns
// the membership with effective roles and category grants. ctx bounds the
// queries; non-members receive ErrForbidden and storage failures are returned.
func (s Service) MembershipForUser(ctx context.Context, groupID, userID string) (domain.Membership, error) {
	var membership domain.Membership
	err := s.DB.QueryRowContext(ctx, `SELECT m.id,m.group_id,m.user_id,u.email,u.display_name,m.status
		FROM memberships m JOIN users u ON u.id=m.user_id
		WHERE m.group_id=? AND m.user_id=? AND m.status='ACTIVE'`, groupID, userID).
		Scan(&membership.ID, &membership.GroupID, &membership.UserID, &membership.Email, &membership.DisplayName, &membership.Status)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.Membership{}, domain.ErrForbidden
	}
	if err != nil {
		return domain.Membership{}, err
	}
	membership.Roles, err = s.roles(ctx, membership.ID)
	if err == nil {
		membership.CategoryGrants, err = s.categoryGrants(ctx, membership.ID)
	}
	return membership, err
}

func (s Service) roles(ctx context.Context, membershipID string) ([]domain.Role, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT role FROM membership_roles WHERE membership_id=? ORDER BY role`, membershipID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	roles := make([]domain.Role, 0)
	for rows.Next() {
		var role domain.Role
		if err := rows.Scan(&role); err != nil {
			return nil, err
		}
		roles = append(roles, role)
	}
	return roles, rows.Err()
}

func (s Service) categoryGrants(ctx context.Context, membershipID string) (map[string][]domain.CategoryPermission, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT category_id,permission FROM category_permissions WHERE membership_id=? ORDER BY category_id,permission`, membershipID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	grants := make(map[string][]domain.CategoryPermission)
	for rows.Next() {
		var categoryID string
		var permission domain.CategoryPermission
		if err := rows.Scan(&categoryID, &permission); err != nil {
			return nil, err
		}
		grants[categoryID] = append(grants[categoryID], permission)
	}
	return grants, rows.Err()
}

// HasRole reports whether membership has role. It takes no database dependency,
// cannot fail, and treats ADMIN as implying every group-level role.
func HasRole(membership domain.Membership, role domain.Role) bool {
	for _, assigned := range membership.Roles {
		if assigned == domain.RoleAdmin || assigned == role {
			return true
		}
	}
	return false
}

// HasCategoryPermission reports whether membership has permission for categoryID.
// ADMIN returns true without I/O; otherwise ctx bounds a scoped database lookup.
// It returns the authorization decision and any database error.
func (s Service) HasCategoryPermission(ctx context.Context, membership domain.Membership, categoryID string, permission domain.CategoryPermission) (bool, error) {
	if HasRole(membership, domain.RoleAdmin) {
		return true, nil
	}
	var count int
	err := s.DB.QueryRowContext(ctx, `SELECT count(*) FROM category_permissions WHERE group_id=? AND membership_id=? AND category_id=? AND permission=?`,
		membership.GroupID, membership.ID, categoryID, permission).Scan(&count)
	return count > 0, err
}

// ListMembers returns all members and effective permissions for groupID. ctx
// bounds the query. Non-finance callers may use this identity-only result for
// permitted assignment because it contains no balance data; SQL errors propagate.
func (s Service) ListMembers(ctx context.Context, groupID string) ([]domain.Membership, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT m.id,m.group_id,m.user_id,u.email,u.display_name,m.status
		FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.group_id=? ORDER BY m.status,lower(u.display_name)`, groupID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]domain.Membership, 0)
	for rows.Next() {
		var item domain.Membership
		if err := rows.Scan(&item.ID, &item.GroupID, &item.UserID, &item.Email, &item.DisplayName, &item.Status); err != nil {
			return nil, err
		}
		item.Roles, err = s.roles(ctx, item.ID)
		if err != nil {
			return nil, err
		}
		item.CategoryGrants, err = s.categoryGrants(ctx, item.ID)
		if err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

// PermissionUpdate is the complete replacement set of group roles and
// category-scoped grants for one member.
type PermissionUpdate struct {
	Roles          []domain.Role                          `json:"roles"`
	CategoryGrants map[string][]domain.CategoryPermission `json:"categoryGrants"`
}

// UpdatePermissions atomically replaces targetID's explicit permissions. actor
// and actorMembership identify the administrator and tenant, while update is
// validated and deduplicated. It returns forbidden, validation, not-found,
// last-administrator conflict, cross-tenant, audit, or storage errors.
func (s Service) UpdatePermissions(ctx context.Context, actor domain.Principal, actorMembership domain.Membership, targetID string, update PermissionUpdate) error {
	if !HasRole(actorMembership, domain.RoleAdmin) {
		return domain.ErrForbidden
	}
	roles, err := validateRoles(update.Roles)
	if err != nil {
		return err
	}
	grants, err := validateGrants(update.CategoryGrants)
	if err != nil {
		return err
	}
	now := platform.Timestamp(platform.Now())
	return storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		var targetGroup string
		if err := tx.QueryRowContext(ctx, `SELECT group_id FROM memberships WHERE id=? AND status='ACTIVE'`, targetID).Scan(&targetGroup); errors.Is(err, sql.ErrNoRows) {
			return domain.ErrNotFound
		} else if err != nil {
			return err
		}
		if targetGroup != actorMembership.GroupID {
			return domain.ErrForbidden
		}
		var hadAdmin int
		if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM membership_roles WHERE membership_id=? AND role='ADMIN'`, targetID).Scan(&hadAdmin); err != nil {
			return err
		}
		willAdmin := containsRole(roles, domain.RoleAdmin)
		if hadAdmin > 0 && !willAdmin {
			var admins int
			if err := tx.QueryRowContext(ctx, `SELECT count(DISTINCT mr.membership_id) FROM membership_roles mr JOIN memberships m ON m.id=mr.membership_id WHERE mr.group_id=? AND mr.role='ADMIN' AND m.status='ACTIVE'`, targetGroup).Scan(&admins); err != nil {
				return err
			}
			if admins <= 1 {
				return fmt.Errorf("%w: the last active administrator cannot be removed", domain.ErrConflict)
			}
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM membership_roles WHERE membership_id=?`, targetID); err != nil {
			return err
		}
		for _, role := range roles {
			if _, err := tx.ExecContext(ctx, `INSERT INTO membership_roles(group_id,membership_id,role,granted_at,granted_by) VALUES(?,?,?,?,?)`, targetGroup, targetID, role, now, actor.UserID); err != nil {
				return err
			}
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM category_permissions WHERE membership_id=?`, targetID); err != nil {
			return err
		}
		for categoryID, permissions := range grants {
			var categoryGroup string
			if err := tx.QueryRowContext(ctx, `SELECT group_id FROM categories WHERE id=?`, categoryID).Scan(&categoryGroup); errors.Is(err, sql.ErrNoRows) {
				return domain.ValidationError{Field: "categoryGrants", Message: "contains an unknown category"}
			} else if err != nil {
				return err
			}
			if categoryGroup != targetGroup {
				return domain.ErrForbidden
			}
			for _, permission := range permissions {
				if _, err := tx.ExecContext(ctx, `INSERT INTO category_permissions(group_id,membership_id,category_id,permission,granted_at,granted_by) VALUES(?,?,?,?,?,?)`, targetGroup, targetID, categoryID, permission, now, actor.UserID); err != nil {
					return err
				}
			}
		}
		return audit.Record(ctx, tx, targetGroup, actor.UserID, actorMembership.ID, "membership.permissions.updated", "membership", targetID, update)
	})
}

func validateRoles(input []domain.Role) ([]domain.Role, error) {
	seen := map[domain.Role]bool{}
	for _, role := range input {
		switch role {
		case domain.RoleAdmin, domain.RoleFinanceManager, domain.RoleCatalogManager:
			seen[role] = true
		default:
			return nil, domain.ValidationError{Field: "roles", Message: "contains an unsupported role"}
		}
	}
	result := make([]domain.Role, 0, len(seen))
	for role := range seen {
		result = append(result, role)
	}
	sort.Slice(result, func(i, j int) bool { return result[i] < result[j] })
	return result, nil
}

func validateGrants(input map[string][]domain.CategoryPermission) (map[string][]domain.CategoryPermission, error) {
	result := make(map[string][]domain.CategoryPermission, len(input))
	for category, permissions := range input {
		seen := map[domain.CategoryPermission]bool{}
		for _, permission := range permissions {
			switch permission {
			case domain.PermissionAssignToOthers, domain.PermissionVoidBookings:
				seen[permission] = true
			default:
				return nil, domain.ValidationError{Field: "categoryGrants", Message: "contains an unsupported permission"}
			}
		}
		for permission := range seen {
			result[category] = append(result[category], permission)
		}
	}
	return result, nil
}

func containsRole(roles []domain.Role, expected domain.Role) bool {
	for _, role := range roles {
		if role == expected {
			return true
		}
	}
	return false
}

// Invitation includes safe onboarding metadata and, only in the immediate
// CreateInvitation result, the one-time plaintext Token.
type Invitation struct {
	ID          string        `json:"id"`
	GroupID     string        `json:"groupId"`
	Email       string        `json:"email"`
	DisplayName string        `json:"displayName,omitempty"`
	Roles       []domain.Role `json:"roles"`
	ExpiresAt   string        `json:"expiresAt"`
	AcceptedAt  *string       `json:"acceptedAt,omitempty"`
	RevokedAt   *string       `json:"revokedAt,omitempty"`
	Token       string        `json:"token,omitempty"`
}

// CreateInvitation creates a seven-day, one-time invitation in membership's
// group. ctx bounds the transaction; actor is audited and email/roles are
// validated. It returns the invitation or forbidden, validation, randomness,
// audit, and database errors.
func (s Service) CreateInvitation(ctx context.Context, actor domain.Principal, membership domain.Membership, email, displayName string, roles []domain.Role) (Invitation, error) {
	if !HasRole(membership, domain.RoleAdmin) {
		return Invitation{}, domain.ErrForbidden
	}
	email = strings.ToLower(strings.TrimSpace(email))
	if !strings.Contains(email, "@") || len(email) > 254 {
		return Invitation{}, domain.ValidationError{Field: "email", Message: "must be a valid email address"}
	}
	roles, err := validateRoles(roles)
	if err != nil {
		return Invitation{}, err
	}
	id, _ := platform.NewID("inv")
	token, err := platform.NewSecret()
	if err != nil {
		return Invitation{}, err
	}
	expires := platform.Now().Add(7 * 24 * time.Hour)
	encoded, _ := json.Marshal(roles)
	item := Invitation{ID: id, GroupID: membership.GroupID, Email: email, DisplayName: strings.TrimSpace(displayName), Roles: roles, ExpiresAt: platform.Timestamp(expires), Token: token}
	err = storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `INSERT INTO invitations(id,group_id,email,display_name,token_hash,roles_json,expires_at,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)`,
			id, membership.GroupID, email, nullable(item.DisplayName), platform.HashSecret(token), string(encoded), item.ExpiresAt, actor.UserID, platform.Timestamp(platform.Now()))
		if err != nil {
			return err
		}
		return audit.Record(ctx, tx, membership.GroupID, actor.UserID, membership.ID, "invitation.created", "invitation", id, map[string]any{"email": email, "roles": roles})
	})
	return item, err
}

// ListInvitations returns newest-first invitations for an administrator's group
// without bearer tokens. ctx bounds the query; it returns ErrForbidden or SQL
// errors when the result cannot be produced.
func (s Service) ListInvitations(ctx context.Context, membership domain.Membership) ([]Invitation, error) {
	if !HasRole(membership, domain.RoleAdmin) {
		return nil, domain.ErrForbidden
	}
	rows, err := s.DB.QueryContext(ctx, `SELECT id,group_id,email,coalesce(display_name,''),roles_json,expires_at,accepted_at,revoked_at FROM invitations WHERE group_id=? ORDER BY created_at DESC`, membership.GroupID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]Invitation, 0)
	for rows.Next() {
		var item Invitation
		var encoded string
		if err := rows.Scan(&item.ID, &item.GroupID, &item.Email, &item.DisplayName, &encoded, &item.ExpiresAt, &item.AcceptedAt, &item.RevokedAt); err != nil {
			return nil, err
		}
		_ = json.Unmarshal([]byte(encoded), &item.Roles)
		result = append(result, item)
	}
	return result, rows.Err()
}

func nullable(value string) any {
	if value == "" {
		return nil
	}
	return value
}
