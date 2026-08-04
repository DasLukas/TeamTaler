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
	"github.com/DasLukas/TeamTaler/internal/media"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

var (
	// ErrMembershipEmailExists identifies an address already attached to a
	// membership in the target group.
	ErrMembershipEmailExists = errors.New("a membership already exists for this email address")
	// ErrInvitationEmailExists identifies an address with a current, unconsumed
	// invitation in the target group.
	ErrInvitationEmailExists = errors.New("an active invitation already exists for this email address")
)

// Service provides authorization-aware group operations over a migrated
// TeamTaler database.
type Service struct {
	// DB is the shared application database connection pool.
	DB *sql.DB
	// TokenSealer encrypts invitation tokens before durable email delivery.
	// It may be nil when outbound invitation email is disabled.
	TokenSealer TokenSealer
}

// Create creates a group, its initial period, and an administrator membership
// for actor. ctx bounds the transaction; name and currency are validated. It
// returns the new Group or validation, storage, and audit errors.
func (s Service) Create(ctx context.Context, actor domain.Principal, name, currency string) (domain.Group, error) {
	name = strings.TrimSpace(name)
	currency = strings.ToUpper(strings.TrimSpace(currency))
	if name == "" || len(name) > 120 || containsControlCharacter(name) {
		return domain.Group{}, domain.ValidationError{Field: "name", Message: "must contain 1 to 120 characters without control characters"}
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
	rows, err := s.DB.QueryContext(ctx, `SELECT g.id,g.name,g.currency,g.logo_key,m.id,m.status,u.email,u.display_name
		FROM memberships m JOIN groups g ON g.id=m.group_id JOIN users u ON u.id=m.user_id
		WHERE m.user_id=? AND m.status='ACTIVE' ORDER BY lower(g.name)`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]domain.Group, 0)
	for rows.Next() {
		var group domain.Group
		var logoKey sql.NullString
		group.Membership.UserID = userID
		if err := rows.Scan(&group.ID, &group.Name, &group.Currency, &logoKey, &group.Membership.ID, &group.Membership.Status, &group.Membership.Email, &group.Membership.DisplayName); err != nil {
			return nil, err
		}
		if logoKey.Valid {
			group.LogoURL = "/api/v1/groups/" + group.ID + "/images/" + logoKey.String
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

// SetLogo attaches imageKey to membership's group. Only administrators may
// update group branding. ctx bounds the audited transaction and actor supplies
// audit identity. It returns the authenticated image URL, the replaced key for
// later offline maintenance, or a validation, authorization, audit, or database
// error. Request paths must not delete replaced content hashes because another
// database row may still reference them.
func (s Service) SetLogo(ctx context.Context, actor domain.Principal, membership domain.Membership, imageKey string) (string, string, error) {
	if !HasRole(membership, domain.RoleAdmin) {
		return "", "", domain.ErrForbidden
	}
	if !media.ValidImageKey(imageKey) {
		return "", "", domain.ValidationError{Field: "image", Message: "has an invalid storage key"}
	}
	var replacedKey string
	err := storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		var previous sql.NullString
		if err := tx.QueryRowContext(ctx, `SELECT logo_key FROM groups WHERE id=?`, membership.GroupID).Scan(&previous); errors.Is(err, sql.ErrNoRows) {
			return domain.ErrNotFound
		} else if err != nil {
			return err
		}
		replacedKey = previous.String
		if _, err := tx.ExecContext(ctx, `UPDATE groups SET logo_key=?,updated_at=? WHERE id=?`, imageKey, platform.Timestamp(platform.Now()), membership.GroupID); err != nil {
			return err
		}
		return audit.Record(ctx, tx, membership.GroupID, actor.UserID, membership.ID, "group.logo.updated", "group", membership.GroupID, map[string]any{"imageKey": imageKey})
	})
	return "/api/v1/groups/" + membership.GroupID + "/images/" + imageKey, replacedKey, err
}

// RemoveLogo clears the custom logo from membership's group so clients return
// to the TeamTaler mark. Only administrators may remove group branding. ctx
// bounds the audited transaction; actor supplies audit identity. It returns the
// detached key for later offline maintenance or an authorization, not-found,
// audit, or database error.
func (s Service) RemoveLogo(ctx context.Context, actor domain.Principal, membership domain.Membership) (string, error) {
	if !HasRole(membership, domain.RoleAdmin) {
		return "", domain.ErrForbidden
	}
	var removedKey string
	err := storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		var previous sql.NullString
		if err := tx.QueryRowContext(ctx, `SELECT logo_key FROM groups WHERE id=?`, membership.GroupID).Scan(&previous); errors.Is(err, sql.ErrNoRows) {
			return domain.ErrNotFound
		} else if err != nil {
			return err
		}
		removedKey = previous.String
		if _, err := tx.ExecContext(ctx, `UPDATE groups SET logo_key=NULL,updated_at=? WHERE id=?`, platform.Timestamp(platform.Now()), membership.GroupID); err != nil {
			return err
		}
		return audit.Record(ctx, tx, membership.GroupID, actor.UserID, membership.ID, "group.logo.removed", "group", membership.GroupID, map[string]any{})
	})
	return removedKey, err
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
	ID                  string              `json:"id"`
	GroupID             string              `json:"groupId"`
	Email               string              `json:"email"`
	DisplayName         string              `json:"displayName,omitempty"`
	Roles               []domain.Role       `json:"roles"`
	ExpiresAt           string              `json:"expiresAt"`
	AcceptedAt          *string             `json:"acceptedAt,omitempty"`
	RevokedAt           *string             `json:"revokedAt,omitempty"`
	EmailDeliveryStatus EmailDeliveryStatus `json:"emailDeliveryStatus"`
	EmailSentAt         *string             `json:"emailSentAt,omitempty"`
	EmailFailureCode    string              `json:"emailFailureCode,omitempty"`
	Token               string              `json:"token,omitempty"`
}

// CreateInvitation creates a seven-day, one-time invitation in membership's
// group. ctx bounds the transaction; actor is audited and email/roles are
// validated. It returns the invitation or forbidden, validation, randomness,
// audit, and database errors.
func (s Service) CreateInvitation(ctx context.Context, actor domain.Principal, membership domain.Membership, email, displayName string, roles []domain.Role) (Invitation, error) {
	if !HasRole(membership, domain.RoleAdmin) {
		return Invitation{}, domain.ErrForbidden
	}
	var err error
	email, err = platform.NormalizeEmail(email)
	if err != nil {
		return Invitation{}, domain.ValidationError{Field: "email", Message: "must be a valid email address"}
	}
	displayName = strings.TrimSpace(displayName)
	if len(displayName) > 120 || containsControlCharacter(displayName) {
		return Invitation{}, domain.ValidationError{Field: "displayName", Message: "must contain at most 120 characters without control characters"}
	}
	roles, err = validateRoles(roles)
	if err != nil {
		return Invitation{}, err
	}
	var item Invitation
	err = storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		item, err = createInvitationTx(ctx, tx, actor, membership, email, displayName, roles, platform.Now())
		return err
	})
	return item, err
}

func createInvitationTx(ctx context.Context, tx *sql.Tx, actor domain.Principal, membership domain.Membership, email, displayName string, roles []domain.Role, now time.Time) (Invitation, error) {
	if roles == nil {
		roles = []domain.Role{}
	}
	nowText := platform.Timestamp(now)
	var existing int
	if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM memberships m JOIN users u ON u.id=m.user_id
		WHERE m.group_id=? AND u.email=?`, membership.GroupID, email).Scan(&existing); err != nil {
		return Invitation{}, err
	}
	if existing > 0 {
		return Invitation{}, fmt.Errorf("%w: %w", domain.ErrConflict, ErrMembershipEmailExists)
	}
	if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM invitations
		WHERE group_id=? AND email=? AND accepted_at IS NULL AND revoked_at IS NULL
		AND julianday(expires_at)>julianday(?)`, membership.GroupID, email, nowText).Scan(&existing); err != nil {
		return Invitation{}, err
	}
	if existing > 0 {
		return Invitation{}, fmt.Errorf("%w: %w", domain.ErrConflict, ErrInvitationEmailExists)
	}

	id, err := platform.NewID("inv")
	if err != nil {
		return Invitation{}, err
	}
	token, err := platform.NewSecret()
	if err != nil {
		return Invitation{}, err
	}
	encoded, err := json.Marshal(roles)
	if err != nil {
		return Invitation{}, fmt.Errorf("encode invitation roles: %w", err)
	}
	item := Invitation{
		ID: id, GroupID: membership.GroupID, Email: email, DisplayName: displayName,
		Roles: roles, ExpiresAt: platform.Timestamp(now.Add(7 * 24 * time.Hour)),
		EmailDeliveryStatus: EmailDeliveryNotRequested, Token: token,
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO invitations(id,group_id,email,display_name,token_hash,roles_json,expires_at,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)`,
		item.ID, membership.GroupID, email, nullable(displayName), platform.HashSecret(token), string(encoded), item.ExpiresAt, actor.UserID, nowText); err != nil {
		return Invitation{}, err
	}
	if err := audit.Record(ctx, tx, membership.GroupID, actor.UserID, membership.ID, "invitation.created", "invitation", item.ID, map[string]any{"email": email, "roles": roles}); err != nil {
		return Invitation{}, err
	}
	return item, nil
}

// RevokeInvitation invalidates one unconsumed invitation in membership's group
// and records the administrative reason. ctx bounds the transaction. It returns
// forbidden, validation, not-found, audit, or database errors. Example:
// RevokeInvitation(ctx, actor, membership, invitationID, "email delivery failed").
func (s Service) RevokeInvitation(ctx context.Context, actor domain.Principal, membership domain.Membership, invitationID, reason string) error {
	if !HasRole(membership, domain.RoleAdmin) {
		return domain.ErrForbidden
	}
	reason = strings.TrimSpace(reason)
	if reason == "" || len(reason) > 240 {
		return domain.ValidationError{Field: "reason", Message: "must contain 1 to 240 characters"}
	}
	now := platform.Timestamp(platform.Now())
	return storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		result, err := tx.ExecContext(ctx, `UPDATE invitations SET revoked_at=?
			WHERE id=? AND group_id=? AND accepted_at IS NULL AND revoked_at IS NULL`, now, invitationID, membership.GroupID)
		if err != nil {
			return err
		}
		changed, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if changed == 0 {
			return domain.ErrNotFound
		}
		return audit.Record(ctx, tx, membership.GroupID, actor.UserID, membership.ID, "invitation.revoked", "invitation", invitationID, map[string]any{"reason": reason})
	})
}

// ListInvitations returns newest-first invitations for an administrator's group
// without bearer tokens. ctx bounds the query; it returns ErrForbidden or SQL
// errors when the result cannot be produced.
func (s Service) ListInvitations(ctx context.Context, membership domain.Membership) ([]Invitation, error) {
	if !HasRole(membership, domain.RoleAdmin) {
		return nil, domain.ErrForbidden
	}
	rows, err := s.DB.QueryContext(ctx, `SELECT i.id,i.group_id,i.email,coalesce(i.display_name,''),i.roles_json,
		i.expires_at,i.accepted_at,i.revoked_at,coalesce(o.status,'NOT_REQUESTED'),o.sent_at,coalesce(o.last_error_code,'')
		FROM invitations i LEFT JOIN invitation_email_outbox o ON o.invitation_id=i.id
		WHERE i.group_id=? ORDER BY i.created_at DESC`, membership.GroupID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]Invitation, 0)
	for rows.Next() {
		var item Invitation
		var encoded string
		if err := rows.Scan(&item.ID, &item.GroupID, &item.Email, &item.DisplayName, &encoded, &item.ExpiresAt, &item.AcceptedAt, &item.RevokedAt, &item.EmailDeliveryStatus, &item.EmailSentAt, &item.EmailFailureCode); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(encoded), &item.Roles); err != nil {
			return nil, fmt.Errorf("decode invitation roles: %w", err)
		}
		if item.Roles == nil {
			item.Roles = []domain.Role{}
		}
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
