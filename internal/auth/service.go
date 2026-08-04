package auth

import (
	"context"
	"crypto/subtle"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/DasLukas/TeamTaler/internal/audit"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

// Service manages local accounts and opaque server-side sessions. DB must point
// to a migrated TeamTaler database; SessionLifetime controls newly issued
// sessions and should be positive in production.
type Service struct {
	DB              *sql.DB
	SessionLifetime time.Duration
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
			{`INSERT INTO memberships(id,group_id,user_id,status,joined_at) VALUES(?,?,?,'ACTIVE',?)`, []any{membershipID, groupID, userID, now}},
			{`INSERT INTO membership_roles(group_id,membership_id,role,granted_at,granted_by) VALUES(?,?,'ADMIN',?,?)`, []any{groupID, membershipID, now, userID}},
			{`INSERT INTO periods(id,group_id,label,status,starts_at,created_at) VALUES(?,?,?,'OPEN',?,?)`, []any{periodID, groupID, "Current period", now, now}},
		}
		for _, statement := range statements {
			if _, err := tx.ExecContext(ctx, statement.query, statement.args...); err != nil {
				return err
			}
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
	err := s.DB.QueryRowContext(ctx, `SELECT id,email,display_name,password_hash FROM users WHERE email=? AND active=1`, email).
		Scan(&principal.UserID, &principal.Email, &principal.DisplayName, &passwordHash)
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
	if input.DisplayName == "" || len(input.DisplayName) > 120 {
		return Session{}, domain.Membership{}, domain.ValidationError{Field: "displayName", Message: "must contain 1 to 120 characters"}
	}
	if len(input.Password) < 12 || len(input.Password) > 1024 {
		return Session{}, domain.Membership{}, domain.ValidationError{Field: "password", Message: "must contain between 12 and 1024 characters"}
	}
	var session Session
	var membership domain.Membership
	err := storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		var invitationID, groupID, email, encodedRoles, expiresAt, invitationCreatedBy string
		err := tx.QueryRowContext(ctx, `SELECT id,group_id,email,roles_json,expires_at,created_by FROM invitations
			WHERE token_hash=? AND accepted_at IS NULL AND revoked_at IS NULL`, platform.HashSecret(input.Token)).
			Scan(&invitationID, &groupID, &email, &encodedRoles, &expiresAt, &invitationCreatedBy)
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
		var principal domain.Principal
		var passwordHash string
		existingUser := true
		err = tx.QueryRowContext(ctx, `SELECT id,email,display_name,password_hash FROM users WHERE email=? AND active=1`, email).
			Scan(&principal.UserID, &principal.Email, &principal.DisplayName, &passwordHash)
		if errors.Is(err, sql.ErrNoRows) {
			existingUser = false
			passwordHash, err = HashPassword(input.Password)
			if err != nil {
				return domain.ValidationError{Field: "password", Message: err.Error()}
			}
			principal.UserID, _ = platform.NewID("usr")
			principal.Email = email
			principal.DisplayName = input.DisplayName
			now := platform.Timestamp(platform.Now())
			if _, err := tx.ExecContext(ctx, `INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,?)`,
				principal.UserID, email, input.DisplayName, passwordHash, now, now); err != nil {
				return err
			}
		} else if err != nil {
			return err
		} else if !VerifyPassword(passwordHash, input.Password) {
			return domain.ErrUnauthenticated
		}
		var existing int
		if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM memberships WHERE group_id=? AND user_id=?`, groupID, principal.UserID).Scan(&existing); err != nil {
			return err
		}
		if existing != 0 {
			return fmt.Errorf("%w: user is already a group member", domain.ErrConflict)
		}
		var roles []domain.Role
		if err := json.Unmarshal([]byte(encodedRoles), &roles); err != nil {
			return fmt.Errorf("decode invitation roles: %w", err)
		}
		seen := map[domain.Role]bool{}
		for _, role := range roles {
			switch role {
			case domain.RoleAdmin, domain.RoleFinanceManager, domain.RoleCatalogManager:
				seen[role] = true
			default:
				return errors.New("invitation contains an unsupported role")
			}
		}
		roles = roles[:0]
		for _, role := range []domain.Role{domain.RoleAdmin, domain.RoleCatalogManager, domain.RoleFinanceManager} {
			if seen[role] {
				roles = append(roles, role)
			}
		}
		membershipID, _ := platform.NewID("mem")
		now := platform.Timestamp(platform.Now())
		if _, err := tx.ExecContext(ctx, `INSERT INTO memberships(id,group_id,user_id,status,joined_at) VALUES(?,?,?,'ACTIVE',?)`, membershipID, groupID, principal.UserID, now); err != nil {
			return err
		}
		for _, role := range roles {
			if _, err := tx.ExecContext(ctx, `INSERT INTO membership_roles(group_id,membership_id,role,granted_at,granted_by) VALUES(?,?,?,?,?)`, groupID, membershipID, role, now, invitationCreatedBy); err != nil {
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
		membership = domain.Membership{ID: membershipID, GroupID: groupID, UserID: principal.UserID, Email: principal.Email, DisplayName: principal.DisplayName, Status: "ACTIVE", Roles: roles, CategoryGrants: map[string][]domain.CategoryPermission{}}
		return audit.Record(ctx, tx, groupID, principal.UserID, membershipID, "invitation.accepted", "invitation", invitationID, map[string]any{"existingUser": existingUser})
	})
	return session, membership, err
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
	principal.SessionHash = platform.HashSecret(token)
	err := s.DB.QueryRowContext(ctx, `SELECT u.id,u.email,u.display_name,s.csrf_hash,s.expires_at,s.last_seen_at
		FROM sessions s JOIN users u ON u.id=s.user_id
		WHERE s.id_hash=? AND u.active=1`, principal.SessionHash).
		Scan(&principal.UserID, &principal.Email, &principal.DisplayName, &csrfHash, &expiresAt, &lastSeenAt)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.Principal{}, domain.ErrUnauthenticated
	}
	if err != nil {
		return domain.Principal{}, err
	}
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
