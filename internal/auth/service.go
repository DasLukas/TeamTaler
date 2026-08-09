package auth

import (
	"context"
	"crypto/subtle"
	"database/sql"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
	"unicode"

	"github.com/DasLukas/TeamTaler/internal/audit"
	"github.com/DasLukas/TeamTaler/internal/authorization"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/media"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

// Service manages local accounts and opaque server-side sessions. DB must point
// to a migrated TeamTaler database; SessionLifetime controls newly issued
// sessions and should be positive in production.
type Service struct {
	DB              *sql.DB
	SessionLifetime time.Duration
	// TokenSealer encrypts public-join verification tokens before they enter the
	// durable email outbox. It is nil when email delivery is unavailable.
	TokenSealer SecretSealer
	// EmailDeliveryAvailable gates public registration, which requires proof of
	// mailbox ownership before a membership is created.
	EmailDeliveryAvailable bool
}

// SecretSealer protects a short-lived token with authenticated encryption.
// Implementations must never include plaintext or ciphertext in returned errors.
type SecretSealer interface {
	Seal(plaintext string) (string, error)
}

// Session is the one-time result returned after successful authentication. Its
// bearer and CSRF tokens must be transported securely and are never persisted
// in plaintext by Service.
type Session struct {
	Token     string
	CSRFToken string
	ExpiresAt time.Time
	Principal domain.Principal
}

// InvitationAcceptance is the public one-time onboarding command containing
// the bearer invitation token and the account profile or existing credentials.
type InvitationAcceptance struct {
	Token       string `json:"token"`
	DisplayName string `json:"displayName"`
	Password    string `json:"password"`
}

// InvitationPreview is the deliberately minimal public metadata returned for a
// valid invitation token. It omits the invited email address and all permission
// defaults.
type InvitationPreview struct {
	DisplayName     string `json:"displayName"`
	ExistingAccount bool   `json:"existingAccount"`
}

// PreviewInvitation validates token and returns only the suggested display
// name and whether a matching active account exists. The invitation's suggested
// name takes precedence over the account profile. It returns validation,
// not-found, expired-invitation conflict, or database errors.
func (s Service) PreviewInvitation(ctx context.Context, token string) (InvitationPreview, error) {
	token = strings.TrimSpace(token)
	if token == "" {
		return InvitationPreview{}, domain.ValidationError{Field: "token", Message: "is required"}
	}
	var preview InvitationPreview
	var invitationDisplayName, accountDisplayName sql.NullString
	var expiresAt string
	var userID sql.NullString
	err := s.DB.QueryRowContext(ctx, `SELECT i.display_name,u.display_name,i.expires_at,u.id
		FROM invitations i LEFT JOIN users u ON u.email=i.email COLLATE NOCASE AND u.active=1
		WHERE i.token_hash=? AND i.accepted_at IS NULL AND i.revoked_at IS NULL`, platform.HashSecret(token)).
		Scan(&invitationDisplayName, &accountDisplayName, &expiresAt, &userID)
	if errors.Is(err, sql.ErrNoRows) {
		return InvitationPreview{}, domain.ErrNotFound
	}
	if err != nil {
		return InvitationPreview{}, err
	}
	expires, err := time.Parse(time.RFC3339Nano, expiresAt)
	if err != nil {
		return InvitationPreview{}, fmt.Errorf("parse invitation expiry: %w", err)
	}
	if !expires.After(platform.Now()) {
		return InvitationPreview{}, fmt.Errorf("%w: invitation has expired", domain.ErrConflict)
	}
	preview.ExistingAccount = userID.Valid
	preview.DisplayName = strings.TrimSpace(invitationDisplayName.String)
	if preview.DisplayName == "" {
		preview.DisplayName = accountDisplayName.String
	}
	return preview, nil
}

// Bootstrap creates the first account, group, administrator membership, and open
// period atomically. ctx bounds database work; the remaining parameters supply
// the initial identity, group, and ISO currency. It returns validation, hashing,
// storage, or conflict errors and refuses to run after any account exists.
func (s Service) Bootstrap(ctx context.Context, email, displayName, password, groupName, currency string) error {
	email = strings.ToLower(strings.TrimSpace(email))
	displayName = strings.TrimSpace(displayName)
	groupName = strings.TrimSpace(groupName)
	currency = strings.ToUpper(strings.TrimSpace(currency))
	if !strings.Contains(email, "@") || len(email) > 254 {
		return domain.ValidationError{Field: "email", Message: "must be a valid email address"}
	}
	if displayName == "" || len(displayName) > 120 {
		return domain.ValidationError{Field: "displayName", Message: "must contain 1 to 120 characters"}
	}
	if groupName == "" || len(groupName) > 120 {
		return domain.ValidationError{Field: "group", Message: "must contain 1 to 120 characters"}
	}
	if !platform.IsCurrencyCode(currency) {
		return domain.ValidationError{Field: "currency", Message: "must be a three-letter ISO 4217 code"}
	}
	passwordHash, err := HashPassword(password)
	if err != nil {
		return domain.ValidationError{Field: "password", Message: err.Error()}
	}
	userID, _ := platform.NewID("usr")
	groupID, _ := platform.NewID("grp")
	membershipID, _ := platform.NewID("mem")
	periodID, _ := platform.NewID("per")
	now := platform.Timestamp(platform.Now())
	return storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		var count int
		if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM users`).Scan(&count); err != nil {
			return err
		}
		if count != 0 {
			return fmt.Errorf("%w: TeamTaler has already been bootstrapped", domain.ErrConflict)
		}
		statements := []struct {
			query string
			args  []any
		}{
			{`INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,?)`, []any{userID, email, displayName, passwordHash, now, now}},
			{`INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES(?,?,?,?,?)`, []any{groupID, groupName, currency, now, now}},
			{`INSERT INTO group_settings(group_id,members_can_view_all_bookings,default_role_id,updated_at) VALUES(?,0,?,?)`, []any{groupID, authorization.PresetRoleID(groupID, domain.RolePresetMember), now}},
			{`INSERT INTO memberships(id,group_id,user_id,status,joined_at) VALUES(?,?,?,'ACTIVE',?)`, []any{membershipID, groupID, userID, now}},
			{`INSERT INTO periods(id,group_id,label,status,starts_at,created_at) VALUES(?,?,?,'OPEN',?,?)`, []any{periodID, groupID, domain.DefaultOpenPeriodLabel, now, now}},
		}
		for _, statement := range statements {
			if _, err := tx.ExecContext(ctx, statement.query, statement.args...); err != nil {
				return err
			}
		}
		if err := authorization.SeedGroupRoles(ctx, tx, groupID, userID, membershipID, platform.Now()); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO membership_roles(group_id,membership_id,role,granted_at,granted_by) VALUES(?,?,'ADMIN',?,?)`, groupID, membershipID, now, userID); err != nil {
			return err
		}
		return audit.Record(ctx, tx, groupID, userID, membershipID, "system.bootstrapped", "group", groupID, map[string]any{"email": email})
	})
}

// Login validates email and password and creates a fresh opaque session. ctx
// bounds database work. It returns the one-time Session, ErrUnauthenticated for
// every credential mismatch, or a storage/randomness error; its failure shape
// deliberately does not reveal whether the email exists.
func (s Service) Login(ctx context.Context, email, password string) (Session, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	if len(email) < 3 || len(email) > 254 || !strings.Contains(email, "@") || len(password) < 1 || len(password) > 1024 {
		VerifyPassword(dummyPasswordHash, "fixed-invalid-input")
		return Session{}, domain.ErrUnauthenticated
	}
	var principal domain.Principal
	var passwordHash string
	var avatarKey sql.NullString
	err := s.DB.QueryRowContext(ctx, `SELECT id,email,display_name,password_hash,avatar_key FROM users
		WHERE email=? AND active=1 AND email IS NOT NULL AND password_hash IS NOT NULL`, email).
		Scan(&principal.UserID, &principal.Email, &principal.DisplayName, &passwordHash, &avatarKey)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return Session{}, err
	}
	if errors.Is(err, sql.ErrNoRows) || !VerifyPassword(passwordHash, password) {
		// Perform comparable work when the account does not exist.
		if errors.Is(err, sql.ErrNoRows) {
			VerifyPassword(dummyPasswordHash, password)
		}
		return Session{}, domain.ErrUnauthenticated
	}
	principal.AvatarURL = media.UserAvatarURL(principal.UserID, avatarKey.String)
	return s.createSession(ctx, principal)
}

// AcceptInvitation validates input, creates or verifies its account, joins the
// invited group, consumes the token, and creates a session in one transaction.
// ctx bounds all work. It returns the Session and Membership, or validation,
// authentication, not-found, conflict, hashing, and storage errors. Existing
// accounts must provide their current password.
func (s Service) AcceptInvitation(ctx context.Context, input InvitationAcceptance) (Session, domain.Membership, error) {
	input.Token = strings.TrimSpace(input.Token)
	input.DisplayName = strings.TrimSpace(input.DisplayName)
	if input.Token == "" {
		return Session{}, domain.Membership{}, domain.ValidationError{Field: "token", Message: "is required"}
	}
	if len(input.DisplayName) > 120 || containsControlCharacter(input.DisplayName) {
		return Session{}, domain.Membership{}, domain.ValidationError{Field: "displayName", Message: "must contain at most 120 characters without control characters"}
	}
	if len(input.Password) < 12 || len(input.Password) > 1024 {
		return Session{}, domain.Membership{}, domain.ValidationError{Field: "password", Message: "must contain between 12 and 1024 characters"}
	}
	var session Session
	var membership domain.Membership
	err := storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		var invitationID, groupID, email, expiresAt, invitationCreatedBy string
		var targetMembershipID sql.NullString
		err := tx.QueryRowContext(ctx, `SELECT id,group_id,email,expires_at,created_by,target_membership_id FROM invitations
			WHERE token_hash=? AND accepted_at IS NULL AND revoked_at IS NULL`, platform.HashSecret(input.Token)).
			Scan(&invitationID, &groupID, &email, &expiresAt, &invitationCreatedBy, &targetMembershipID)
		if errors.Is(err, sql.ErrNoRows) {
			return domain.ErrNotFound
		}
		if err != nil {
			return err
		}
		expires, err := time.Parse(time.RFC3339Nano, expiresAt)
		if err != nil || !expires.After(platform.Now()) {
			return fmt.Errorf("%w: invitation has expired", domain.ErrConflict)
		}
		assignmentRows, err := tx.QueryContext(ctx, `SELECT role_id FROM invitation_role_assignments WHERE group_id=? AND invitation_id=? ORDER BY role_id`, groupID, invitationID)
		if err != nil {
			return err
		}
		invitationRoleIDs := make([]string, 0)
		for assignmentRows.Next() {
			var roleID string
			if err := assignmentRows.Scan(&roleID); err != nil {
				assignmentRows.Close()
				return err
			}
			invitationRoleIDs = append(invitationRoleIDs, roleID)
		}
		if err := assignmentRows.Close(); err != nil {
			return err
		}
		now := platform.Timestamp(platform.Now())
		var principal domain.Principal
		var membershipID string
		var existingUser, reactivated bool
		if targetMembershipID.Valid {
			membershipID = targetMembershipID.String
			principal, existingUser, err = acceptClaimInvitationIdentityTx(ctx, tx, input, groupID, membershipID, email, invitationCreatedBy, now, invitationRoleIDs)
			if err != nil {
				return err
			}
		} else {
			principal, existingUser, err = resolveInvitationIdentityTx(ctx, tx, input, email, now)
			if err != nil {
				return err
			}
			membershipID, reactivated, err = joinInvitationMembershipTx(ctx, tx, groupID, principal.UserID, now)
			if err != nil {
				return err
			}
			if err := assignInvitationRolesTx(ctx, tx, groupID, membershipID, invitationCreatedBy, now, invitationRoleIDs); err != nil {
				return err
			}
		}
		accepted, err := tx.ExecContext(ctx, `UPDATE invitations SET accepted_at=? WHERE id=? AND accepted_at IS NULL`, now, invitationID)
		if err != nil {
			return err
		}
		changed, _ := accepted.RowsAffected()
		if changed != 1 {
			return domain.ErrConflict
		}
		if _, err := tx.ExecContext(ctx, `UPDATE invitation_email_outbox SET status='CANCELLED',token_ciphertext=NULL,next_attempt_at=NULL,
			lease_token=NULL,lease_until=NULL,last_error_code='invitation_accepted',updated_at=?
			WHERE invitation_id=? AND status IN ('PENDING','SENDING','FAILED')`, now, invitationID); err != nil {
			return err
		}
		token, err := platform.NewSecret()
		if err != nil {
			return err
		}
		csrf, err := platform.NewSecret()
		if err != nil {
			return err
		}
		sessionExpires := platform.Now().Add(s.SessionLifetime)
		if _, err := tx.ExecContext(ctx, `INSERT INTO sessions(id_hash,user_id,csrf_hash,expires_at,last_seen_at,created_at) VALUES(?,?,?,?,?,?)`,
			platform.HashSecret(token), principal.UserID, platform.HashSecret(csrf), platform.Timestamp(sessionExpires), now, now); err != nil {
			return err
		}
		principal.SessionHash = platform.HashSecret(token)
		principal.CSRFToken = csrf
		session = Session{Token: token, CSRFToken: csrf, ExpiresAt: sessionExpires, Principal: principal}
		membership = domain.Membership{
			ID: membershipID, GroupID: groupID, UserID: principal.UserID,
			Email: stringPointer(principal.Email), DisplayName: principal.DisplayName,
			AvatarURL: principal.AvatarURL, Status: "ACTIVE", IsTemporaryGuest: false,
			CategoryGrants: map[string][]domain.CategoryPermission{},
		}
		return audit.Record(ctx, tx, groupID, principal.UserID, membershipID, "invitation.accepted", "invitation", invitationID, map[string]any{
			"existingUser": existingUser,
			"reactivated":  reactivated,
			"claimed":      targetMembershipID.Valid,
		})
	})
	if err == nil {
		err = s.hydrateMembershipAuthorization(ctx, &membership)
	}
	return session, membership, err
}

// resolveInvitationIdentityTx verifies an existing credentialed account or
// creates a new one for a standard invitation. The caller owns tx and has
// already validated the invitation token and password shape.
func resolveInvitationIdentityTx(ctx context.Context, tx *sql.Tx, input InvitationAcceptance, email, now string) (domain.Principal, bool, error) {
	var principal domain.Principal
	var passwordHash string
	var avatarKey sql.NullString
	err := tx.QueryRowContext(ctx, `SELECT id,email,display_name,password_hash,avatar_key
		FROM users
		WHERE email=? AND active=1 AND email IS NOT NULL AND password_hash IS NOT NULL`, email).
		Scan(&principal.UserID, &principal.Email, &principal.DisplayName, &passwordHash, &avatarKey)
	if errors.Is(err, sql.ErrNoRows) {
		if input.DisplayName == "" {
			return domain.Principal{}, false, domain.ValidationError{Field: "displayName", Message: "must contain 1 to 120 characters"}
		}
		passwordHash, err = HashPassword(input.Password)
		if err != nil {
			return domain.Principal{}, false, domain.ValidationError{Field: "password", Message: err.Error()}
		}
		principal.UserID, _ = platform.NewID("usr")
		principal.Email = email
		principal.DisplayName = input.DisplayName
		if _, err := tx.ExecContext(ctx, `INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,?)`,
			principal.UserID, email, input.DisplayName, passwordHash, now, now); err != nil {
			return domain.Principal{}, false, err
		}
		return principal, false, nil
	}
	if err != nil {
		return domain.Principal{}, false, err
	}
	if !VerifyPassword(passwordHash, input.Password) {
		return domain.Principal{}, true, domain.ErrUnauthenticated
	}
	principal.AvatarURL = media.UserAvatarURL(principal.UserID, avatarKey.String)
	return principal, true, nil
}

// joinInvitationMembershipTx creates or reactivates the standard invitation
// membership while retaining its stable identifier on reactivation.
func joinInvitationMembershipTx(ctx context.Context, tx *sql.Tx, groupID, userID, now string) (string, bool, error) {
	var membershipID, membershipStatus string
	err := tx.QueryRowContext(ctx, `SELECT id,status FROM memberships WHERE group_id=? AND user_id=?`, groupID, userID).
		Scan(&membershipID, &membershipStatus)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return "", false, err
	}
	if err == nil && membershipStatus == "ACTIVE" {
		return "", false, fmt.Errorf("%w: user is already a group member", domain.ErrConflict)
	}
	if err == nil {
		if _, err := tx.ExecContext(ctx, `UPDATE memberships SET status='ACTIVE',archived_at=NULL WHERE id=? AND group_id=? AND status='ARCHIVED'`, membershipID, groupID); err != nil {
			return "", false, err
		}
		for _, statement := range []string{
			`DELETE FROM membership_roles WHERE membership_id=?`,
			`DELETE FROM membership_permissions WHERE membership_id=?`,
			`DELETE FROM category_permissions WHERE membership_id=?`,
		} {
			if _, err := tx.ExecContext(ctx, statement, membershipID); err != nil {
				return "", false, err
			}
		}
		return membershipID, true, nil
	}
	membershipID, _ = platform.NewID("mem")
	if _, err := tx.ExecContext(ctx, `INSERT INTO memberships(id,group_id,user_id,status,joined_at) VALUES(?,?,?,'ACTIVE',?)`, membershipID, groupID, userID, now); err != nil {
		return "", false, err
	}
	return membershipID, false, nil
}

// assignInvitationRolesTx copies one standard invitation's explicit role set
// to its active membership and maintains the deprecated preset-role mirror.
func assignInvitationRolesTx(ctx context.Context, tx *sql.Tx, groupID, membershipID, assignedBy, now string, roleIDs []string) error {
	if len(roleIDs) == 0 {
		return domain.ValidationError{Field: "roleIds", Message: "invitation must contain at least one role"}
	}
	seenRoleIDs := make(map[string]struct{}, len(roleIDs))
	for _, roleID := range roleIDs {
		if _, duplicate := seenRoleIDs[roleID]; duplicate {
			continue
		}
		seenRoleIDs[roleID] = struct{}{}
		if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO membership_role_assignments(group_id,membership_id,role_id,version,assigned_at,assigned_by) VALUES(?,?,?,1,?,?)`, groupID, membershipID, roleID, now, assignedBy); err != nil {
			return err
		}
		var preset sql.NullString
		if err := tx.QueryRowContext(ctx, `SELECT preset_key FROM roles WHERE id=? AND group_id=?`, roleID, groupID).Scan(&preset); err != nil {
			return err
		}
		legacyRole := domain.Role("")
		switch domain.RolePresetKey(preset.String) {
		case domain.RolePresetGroupAdministrator:
			legacyRole = domain.RoleAdmin
		case domain.RolePresetFinanceManager:
			legacyRole = domain.RoleFinanceManager
		case domain.RolePresetCatalogManager:
			legacyRole = domain.RoleCatalogManager
		}
		if legacyRole != "" {
			if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO membership_roles(group_id,membership_id,role,granted_at,granted_by) VALUES(?,?,?,?,?)`, groupID, membershipID, legacyRole, now, assignedBy); err != nil {
				return err
			}
		}
	}
	return nil
}

// acceptClaimInvitationIdentityTx upgrades one temporary identity in place or
// rebinds its stable membership to an existing credentialed account. Financial
// rows remain attached to membershipID and are never merged with another group
// membership.
func acceptClaimInvitationIdentityTx(ctx context.Context, tx *sql.Tx, input InvitationAcceptance, groupID, membershipID, email, assignedBy, now string, roleIDs []string) (domain.Principal, bool, error) {
	var temporaryUserID, temporaryDisplayName string
	var temporaryAvatarKey sql.NullString
	if err := tx.QueryRowContext(ctx, `SELECT user.id,user.display_name,user.avatar_key
		FROM memberships membership
		JOIN users user ON user.id=membership.user_id
		WHERE membership.id=? AND membership.group_id=? AND membership.status='ACTIVE'
		  AND user.email IS NULL AND user.password_hash IS NULL`, membershipID, groupID).
		Scan(&temporaryUserID, &temporaryDisplayName, &temporaryAvatarKey); errors.Is(err, sql.ErrNoRows) {
		return domain.Principal{}, false, fmt.Errorf("%w: invitation claim target is no longer available", domain.ErrConflict)
	} else if err != nil {
		return domain.Principal{}, false, err
	}

	if _, err := tx.ExecContext(ctx, `UPDATE memberships
		SET temporary_guest_name_key=NULL
		WHERE id=? AND group_id=? AND user_id=?`, membershipID, groupID, temporaryUserID); err != nil {
		return domain.Principal{}, false, err
	}
	for _, statement := range []string{
		`DELETE FROM membership_roles WHERE membership_id=?`,
		`DELETE FROM membership_permissions WHERE membership_id=?`,
		`DELETE FROM category_permissions WHERE membership_id=?`,
		`DELETE FROM membership_role_assignments WHERE group_id=? AND membership_id=?`,
	} {
		arguments := []any{membershipID}
		if strings.Contains(statement, "group_id") {
			arguments = []any{groupID, membershipID}
		}
		if _, err := tx.ExecContext(ctx, statement, arguments...); err != nil {
			return domain.Principal{}, false, err
		}
	}
	if err := assignInvitationRolesTx(ctx, tx, groupID, membershipID, assignedBy, now, roleIDs); err != nil {
		return domain.Principal{}, false, err
	}

	var principal domain.Principal
	var passwordHash string
	var avatarKey sql.NullString
	err := tx.QueryRowContext(ctx, `SELECT id,email,display_name,password_hash,avatar_key
		FROM users
		WHERE email=? AND active=1 AND email IS NOT NULL AND password_hash IS NOT NULL`, email).
		Scan(&principal.UserID, &principal.Email, &principal.DisplayName, &passwordHash, &avatarKey)
	if err == nil {
		if !VerifyPassword(passwordHash, input.Password) {
			return domain.Principal{}, true, domain.ErrUnauthenticated
		}
		var existingMemberships int
		if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM memberships WHERE group_id=? AND user_id=?`, groupID, principal.UserID).Scan(&existingMemberships); err != nil {
			return domain.Principal{}, true, err
		}
		if existingMemberships != 0 {
			return domain.Principal{}, true, fmt.Errorf("%w: account already has a membership in this group", domain.ErrConflict)
		}
		if _, err := tx.ExecContext(ctx, `UPDATE memberships SET user_id=?,temporary_guest_name_key=NULL WHERE id=? AND group_id=? AND user_id=?`, principal.UserID, membershipID, groupID, temporaryUserID); err != nil {
			return domain.Principal{}, true, err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM users WHERE id=? AND NOT EXISTS (SELECT 1 FROM memberships WHERE user_id=?)`, temporaryUserID, temporaryUserID); err != nil {
			return domain.Principal{}, true, err
		}
		principal.AvatarURL = media.UserAvatarURL(principal.UserID, avatarKey.String)
		return principal, true, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return domain.Principal{}, false, err
	}

	displayName := input.DisplayName
	if displayName == "" {
		displayName = temporaryDisplayName
	}
	passwordHash, err = HashPassword(input.Password)
	if err != nil {
		return domain.Principal{}, false, domain.ValidationError{Field: "password", Message: err.Error()}
	}
	result, err := tx.ExecContext(ctx, `UPDATE users
		SET email=?,display_name=?,password_hash=?,updated_at=?
		WHERE id=? AND email IS NULL AND password_hash IS NULL`, email, displayName, passwordHash, now, temporaryUserID)
	if err != nil {
		return domain.Principal{}, false, err
	}
	changed, _ := result.RowsAffected()
	if changed != 1 {
		return domain.Principal{}, false, fmt.Errorf("%w: invitation claim target changed concurrently", domain.ErrConflict)
	}
	principal = domain.Principal{
		UserID: temporaryUserID, Email: email, DisplayName: displayName,
		AvatarURL: media.UserAvatarURL(temporaryUserID, temporaryAvatarKey.String),
	}
	return principal, false, nil
}

func stringPointer(value string) *string {
	return &value
}

func containsControlCharacter(value string) bool {
	for _, character := range value {
		if unicode.IsControl(character) {
			return true
		}
	}
	return false
}

func (s Service) hydrateMembershipAuthorization(ctx context.Context, membership *domain.Membership) error {
	if err := s.DB.QueryRowContext(ctx, `SELECT membership.role_assignments_version,
		(user.email IS NULL AND user.password_hash IS NULL)
		FROM memberships membership
		JOIN users user ON user.id=membership.user_id
		WHERE membership.id=? AND membership.group_id=? AND membership.status='ACTIVE'`, membership.ID, membership.GroupID).
		Scan(&membership.RoleAssignmentsVersion, &membership.IsTemporaryGuest); err != nil {
		return err
	}
	rows, err := s.DB.QueryContext(ctx, `SELECT r.id,coalesce(r.preset_key,'') FROM membership_role_assignments a JOIN roles r ON r.id=a.role_id AND r.group_id=a.group_id WHERE a.group_id=? AND a.membership_id=? ORDER BY r.id`, membership.GroupID, membership.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	legacyRoles := make(map[domain.Role]struct{})
	membership.RoleIDs = membership.RoleIDs[:0]
	for rows.Next() {
		var roleID string
		var preset domain.RolePresetKey
		if err := rows.Scan(&roleID, &preset); err != nil {
			return err
		}
		membership.RoleIDs = append(membership.RoleIDs, roleID)
		switch preset {
		case domain.RolePresetGroupAdministrator:
			legacyRoles[domain.RoleAdmin] = struct{}{}
		case domain.RolePresetFinanceManager:
			legacyRoles[domain.RoleFinanceManager] = struct{}{}
		case domain.RolePresetCatalogManager:
			legacyRoles[domain.RoleCatalogManager] = struct{}{}
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	sort.Strings(membership.RoleIDs)
	membership.Roles = membership.Roles[:0]
	for _, role := range []domain.Role{domain.RoleAdmin, domain.RoleCatalogManager, domain.RoleFinanceManager} {
		if _, ok := legacyRoles[role]; ok {
			membership.Roles = append(membership.Roles, role)
		}
	}
	membership.EffectiveGrants, err = authorization.NewPolicy(s.DB).EffectiveGrants(ctx, membership.GroupID, membership.ID)
	if err != nil {
		return err
	}
	membership.GroupPermissions = membership.GroupPermissions[:0]
	for _, grant := range membership.EffectiveGrants {
		if grant.Permission == domain.PermissionRecordOwnPayment && grant.Scope.Type == domain.PermissionScopeGroup {
			membership.GroupPermissions = append(membership.GroupPermissions, domain.PermissionSelfRecordPayment)
			break
		}
	}
	membership.CategoryGrants = map[string][]domain.CategoryPermission{}
	return nil
}

func (s Service) createSession(ctx context.Context, principal domain.Principal) (Session, error) {
	token, err := platform.NewSecret()
	if err != nil {
		return Session{}, err
	}
	csrf, err := platform.NewSecret()
	if err != nil {
		return Session{}, err
	}
	now := platform.Now()
	expires := now.Add(s.SessionLifetime)
	_, err = s.DB.ExecContext(ctx, `INSERT INTO sessions(id_hash,user_id,csrf_hash,expires_at,last_seen_at,created_at) VALUES(?,?,?,?,?,?)`,
		platform.HashSecret(token), principal.UserID, platform.HashSecret(csrf), platform.Timestamp(expires), platform.Timestamp(now), platform.Timestamp(now))
	if err != nil {
		return Session{}, fmt.Errorf("create session: %w", err)
	}
	principal.SessionHash = platform.HashSecret(token)
	principal.CSRFToken = csrf
	return Session{Token: token, CSRFToken: csrf, ExpiresAt: expires, Principal: principal}, nil
}

// Authenticate resolves a session token and validates an optional CSRF cookie.
// The context bounds database access; token is the opaque session secret and
// csrfToken may be empty for callers that do not need mutation authorization.
// It returns the authenticated principal or ErrUnauthenticated for an absent,
// expired, or unknown token. Session activity writes are throttled to once per
// 15 minutes so read-heavy browsing does not continually write to SQLite.
func (s Service) Authenticate(ctx context.Context, token, csrfToken string) (domain.Principal, error) {
	if token == "" {
		return domain.Principal{}, domain.ErrUnauthenticated
	}
	var principal domain.Principal
	var csrfHash, expiresAt, lastSeenAt string
	var avatarKey sql.NullString
	principal.SessionHash = platform.HashSecret(token)
	err := s.DB.QueryRowContext(ctx, `SELECT u.id,u.email,u.display_name,u.avatar_key,s.csrf_hash,s.expires_at,s.last_seen_at
		FROM sessions s JOIN users u ON u.id=s.user_id
		WHERE s.id_hash=? AND u.active=1 AND u.email IS NOT NULL AND u.password_hash IS NOT NULL`, principal.SessionHash).
		Scan(&principal.UserID, &principal.Email, &principal.DisplayName, &avatarKey, &csrfHash, &expiresAt, &lastSeenAt)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.Principal{}, domain.ErrUnauthenticated
	}
	if err != nil {
		return domain.Principal{}, err
	}
	principal.AvatarURL = media.UserAvatarURL(principal.UserID, avatarKey.String)
	now := platform.Now()
	expires, err := time.Parse(time.RFC3339Nano, expiresAt)
	if err != nil || !expires.After(now) {
		_, _ = s.DB.ExecContext(ctx, `DELETE FROM sessions WHERE id_hash=?`, principal.SessionHash)
		return domain.Principal{}, domain.ErrUnauthenticated
	}
	if csrfToken != "" && subtle.ConstantTimeCompare([]byte(platform.HashSecret(csrfToken)), []byte(csrfHash)) == 1 {
		principal.CSRFToken = csrfToken
	}
	lastSeen, lastSeenErr := time.Parse(time.RFC3339Nano, lastSeenAt)
	if lastSeenErr != nil || now.After(lastSeen.Add(15*time.Minute)) {
		_, _ = s.DB.ExecContext(ctx, `UPDATE sessions SET last_seen_at=? WHERE id_hash=?`, platform.Timestamp(now), principal.SessionHash)
	}
	return principal, nil
}

// SetAvatar attaches an already normalized image to the authenticated account.
// The context bounds the atomic user update, actor selects the account, and
// imageKey must be a valid content-addressed PNG key. It returns the protected
// image URL, the detached previous key, or validation and storage errors.
func (s Service) SetAvatar(ctx context.Context, actor domain.Principal, imageKey string) (string, string, error) {
	if !media.ValidImageKey(imageKey) {
		return "", "", domain.ValidationError{Field: "image", Message: "has an invalid storage key"}
	}
	var replacedKey string
	err := storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		var previous sql.NullString
		if err := tx.QueryRowContext(ctx, `SELECT avatar_key FROM users WHERE id=? AND active=1`, actor.UserID).Scan(&previous); errors.Is(err, sql.ErrNoRows) {
			return domain.ErrNotFound
		} else if err != nil {
			return err
		}
		replacedKey = previous.String
		_, err := tx.ExecContext(ctx, `UPDATE users SET avatar_key=?,updated_at=? WHERE id=?`, imageKey, platform.Timestamp(platform.Now()), actor.UserID)
		return err
	})
	return media.UserAvatarURL(actor.UserID, imageKey), replacedKey, err
}

// RemoveAvatar clears the authenticated account's profile image. The context
// bounds the atomic update and actor selects the account. It returns the
// detached content key or not-found and storage errors.
func (s Service) RemoveAvatar(ctx context.Context, actor domain.Principal) (string, error) {
	var removedKey string
	err := storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		var previous sql.NullString
		if err := tx.QueryRowContext(ctx, `SELECT avatar_key FROM users WHERE id=? AND active=1`, actor.UserID).Scan(&previous); errors.Is(err, sql.ErrNoRows) {
			return domain.ErrNotFound
		} else if err != nil {
			return err
		}
		removedKey = previous.String
		_, err := tx.ExecContext(ctx, `UPDATE users SET avatar_key=NULL,updated_at=? WHERE id=?`, platform.Timestamp(platform.Now()), actor.UserID)
		return err
	})
	return removedKey, err
}

// Logout revokes sessionHash immediately within ctx. An empty hash is a
// successful no-op; otherwise it returns only database errors.
func (s Service) Logout(ctx context.Context, sessionHash string) error {
	if sessionHash == "" {
		return nil
	}
	_, err := s.DB.ExecContext(ctx, `DELETE FROM sessions WHERE id_hash=?`, sessionHash)
	return err
}

// CleanupExpired deletes every expired session as of platform.Now. ctx bounds
// the write and the method returns any database error.
func (s Service) CleanupExpired(ctx context.Context) error {
	_, err := s.DB.ExecContext(ctx, `DELETE FROM sessions WHERE expires_at <= ?`, platform.Timestamp(platform.Now()))
	return err
}
