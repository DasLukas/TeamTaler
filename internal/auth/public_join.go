package auth

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/DasLukas/TeamTaler/internal/audit"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/media"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

const publicJoinVerificationLifetime = time.Hour

// PublicJoinPreview is the deliberately minimal metadata exposed for a valid
// public join-link token. It never contains group identifiers, role data, or
// account-existence information.
type PublicJoinPreview struct {
	GroupName string  `json:"groupName"`
	ExpiresAt *string `json:"expiresAt"`
}

// PublicJoinRegistration contains the untrusted profile and credentials for a
// new account plus the reusable public join-link token. The password is hashed
// before any write transaction starts.
type PublicJoinRegistration struct {
	JoinToken   string `json:"joinToken"`
	Email       string `json:"email"`
	DisplayName string `json:"displayName"`
	Password    string `json:"password"`
}

// PreviewPublicJoinLink validates a public join token and returns only safe
// display metadata. It returns validation, not-found, expired-link conflict, or
// database errors.
func (s Service) PreviewPublicJoinLink(ctx context.Context, token string) (PublicJoinPreview, error) {
	token = strings.TrimSpace(token)
	if token == "" {
		return PublicJoinPreview{}, domain.ValidationError{Field: "token", Message: "is required"}
	}
	var preview PublicJoinPreview
	var expiresAt sql.NullString
	err := s.DB.QueryRowContext(ctx, `SELECT g.name,l.expires_at FROM public_join_links l JOIN groups g ON g.id=l.group_id WHERE l.token_hash=? AND l.enabled=1 AND g.status='ACTIVE'`, platform.HashSecret(token)).Scan(&preview.GroupName, &expiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return PublicJoinPreview{}, domain.ErrNotFound
	}
	if err != nil {
		return PublicJoinPreview{}, err
	}
	if expiresAt.Valid {
		expires, err := time.Parse(time.RFC3339Nano, expiresAt.String)
		if err != nil {
			return PublicJoinPreview{}, fmt.Errorf("parse public join-link expiry: %w", err)
		}
		if !expires.After(platform.Now()) {
			return PublicJoinPreview{}, fmt.Errorf("%w: public join link has expired", domain.ErrConflict)
		}
		preview.ExpiresAt = &expiresAt.String
	}
	return preview, nil
}

// StartPublicJoinRegistration queues a one-time mailbox verification for a new
// account. The successful result is intentionally empty and identical when the
// email already belongs to an active account. ctx bounds validation, hashing,
// and the atomic registration/outbox write. It returns validation, unavailable,
// invalid-link, hashing, encryption, and database errors.
func (s Service) StartPublicJoinRegistration(ctx context.Context, input PublicJoinRegistration, expectedSystemSettingsRevision int64) error {
	if !s.EmailDeliveryAvailable || s.TokenSealer == nil {
		return fmt.Errorf("%w: public registration email delivery is unavailable", domain.ErrServiceUnavailable)
	}
	input.JoinToken = strings.TrimSpace(input.JoinToken)
	if input.JoinToken == "" {
		return domain.ValidationError{Field: "joinToken", Message: "is required"}
	}
	email, err := platform.NormalizeEmail(input.Email)
	if err != nil {
		return domain.ValidationError{Field: "email", Message: "must be a valid email address"}
	}
	displayName := strings.TrimSpace(input.DisplayName)
	if displayName == "" || len(displayName) > 120 || containsControlCharacter(displayName) {
		return domain.ValidationError{Field: "displayName", Message: "must contain 1 to 120 characters without control characters"}
	}
	link, err := loadPublicJoinLink(ctx, s.DB, input.JoinToken)
	if err != nil {
		return err
	}
	if err := validateLoadedPublicJoinLink(link, platform.Now()); err != nil {
		return err
	}
	passwordHash, err := HashPassword(input.Password)
	if err != nil {
		return domain.ValidationError{Field: "password", Message: err.Error()}
	}
	var existingUser int
	if err := s.DB.QueryRowContext(ctx, `SELECT count(*) FROM users WHERE email=? COLLATE NOCASE AND active=1`, email).Scan(&existingUser); err != nil {
		return err
	}
	if existingUser > 0 {
		return nil
	}
	verificationToken, err := platform.NewSecret()
	if err != nil {
		return err
	}
	tokenCiphertext, err := s.TokenSealer.Seal(verificationToken)
	if err != nil {
		return fmt.Errorf("seal public registration token: %w", err)
	}
	return storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		if err := requirePublicJoinPolicyRevisionTx(ctx, tx, expectedSystemSettingsRevision); err != nil {
			return err
		}
		current, err := loadPublicJoinLink(ctx, tx, input.JoinToken)
		if err != nil {
			return err
		}
		nowValue := platform.Now()
		if err := validateLoadedPublicJoinLink(current, nowValue); err != nil {
			return err
		}
		if current.GroupID != link.GroupID || current.Version != link.Version {
			return fmt.Errorf("%w: public join link changed", domain.ErrConflict)
		}
		if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM users WHERE email=? COLLATE NOCASE AND active=1`, email).Scan(&existingUser); err != nil {
			return err
		}
		if existingUser > 0 {
			return nil
		}
		now := platform.Timestamp(nowValue)
		if _, err := tx.ExecContext(ctx, `UPDATE public_join_registrations SET invalidated_at=? WHERE group_id=? AND email=? COLLATE NOCASE AND consumed_at IS NULL AND invalidated_at IS NULL`, now, current.GroupID, email); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE public_join_email_outbox SET status='CANCELLED',token_ciphertext=NULL,next_attempt_at=NULL,lease_token=NULL,lease_until=NULL,last_error_code='registration_replaced',updated_at=? WHERE group_id=? AND registration_id IN (SELECT id FROM public_join_registrations WHERE group_id=? AND email=? COLLATE NOCASE AND invalidated_at=?) AND status IN ('PENDING','SENDING','FAILED')`, now, current.GroupID, current.GroupID, email, now); err != nil {
			return err
		}
		registrationID, err := platform.NewID("joinreg")
		if err != nil {
			return err
		}
		expiresAt := nowValue.Add(publicJoinVerificationLifetime)
		if current.ExpiresAt != nil {
			linkExpires, parseErr := time.Parse(time.RFC3339Nano, *current.ExpiresAt)
			if parseErr != nil {
				return fmt.Errorf("parse public join-link expiry: %w", parseErr)
			}
			if linkExpires.Before(expiresAt) {
				expiresAt = linkExpires
			}
		}
		expires := platform.Timestamp(expiresAt)
		if _, err := tx.ExecContext(ctx, `INSERT INTO public_join_registrations(id,group_id,join_link_version,email,display_name,password_hash,verification_token_hash,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)`, registrationID, current.GroupID, current.Version, email, displayName, passwordHash, platform.HashSecret(verificationToken), expires, now); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO public_join_email_outbox(registration_id,group_id,token_ciphertext,status,attempt_count,next_attempt_at,created_at,updated_at) VALUES(?,? ,?,'PENDING',0,?,?,?)`, registrationID, current.GroupID, tokenCiphertext, now, now, now)
		return err
	})
}

// ResendPublicJoinVerification rotates the verification token for a matching
// pending registration and requeues delivery. Its successful response is
// deliberately identical when no registration exists, preventing account and
// registration enumeration. The public join link must remain valid.
func (s Service) ResendPublicJoinVerification(ctx context.Context, joinToken, emailValue string, expectedSystemSettingsRevision int64) error {
	if !s.EmailDeliveryAvailable || s.TokenSealer == nil {
		return fmt.Errorf("%w: public registration email delivery is unavailable", domain.ErrServiceUnavailable)
	}
	joinToken = strings.TrimSpace(joinToken)
	email, err := platform.NormalizeEmail(emailValue)
	if joinToken == "" || err != nil {
		return domain.ValidationError{Field: "registration", Message: "requires a valid join token and email address"}
	}
	verificationToken, err := platform.NewSecret()
	if err != nil {
		return err
	}
	ciphertext, err := s.TokenSealer.Seal(verificationToken)
	if err != nil {
		return fmt.Errorf("seal public registration token: %w", err)
	}
	return storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		if err := requirePublicJoinPolicyRevisionTx(ctx, tx, expectedSystemSettingsRevision); err != nil {
			return err
		}
		link, err := loadPublicJoinLink(ctx, tx, joinToken)
		if err != nil {
			return err
		}
		nowValue := platform.Now()
		if err := validateLoadedPublicJoinLink(link, nowValue); err != nil {
			return err
		}
		var registrationID string
		err = tx.QueryRowContext(ctx, `SELECT id FROM public_join_registrations WHERE group_id=? AND join_link_version=? AND email=? COLLATE NOCASE AND consumed_at IS NULL AND invalidated_at IS NULL AND expires_at>?`, link.GroupID, link.Version, email, platform.Timestamp(nowValue)).Scan(&registrationID)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		expiresAt := nowValue.Add(publicJoinVerificationLifetime)
		if link.ExpiresAt != nil {
			linkExpires, parseErr := time.Parse(time.RFC3339Nano, *link.ExpiresAt)
			if parseErr != nil {
				return parseErr
			}
			if linkExpires.Before(expiresAt) {
				expiresAt = linkExpires
			}
		}
		now := platform.Timestamp(nowValue)
		if _, err := tx.ExecContext(ctx, `UPDATE public_join_registrations SET verification_token_hash=?,expires_at=? WHERE id=?`, platform.HashSecret(verificationToken), platform.Timestamp(expiresAt), registrationID); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `UPDATE public_join_email_outbox SET token_ciphertext=?,status='PENDING',attempt_count=0,next_attempt_at=?,lease_token=NULL,lease_until=NULL,sent_at=NULL,last_error_code=NULL,updated_at=? WHERE registration_id=?`, ciphertext, now, now, registrationID)
		return err
	})
}

// ConfirmPublicJoinRegistration consumes a one-time mailbox-verification token,
// creates or reactivates the account membership with the group's current
// default role, and issues a session in one transaction. It returns the session
// and membership or validation, invalid-token, expired-link, conflict, role,
// audit, and database errors.
func (s Service) ConfirmPublicJoinRegistration(ctx context.Context, verificationToken string, expectedSystemSettingsRevision int64) (Session, domain.Membership, error) {
	verificationToken = strings.TrimSpace(verificationToken)
	if verificationToken == "" {
		return Session{}, domain.Membership{}, domain.ValidationError{Field: "token", Message: "is required"}
	}
	var session Session
	var membership domain.Membership
	err := storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		if err := requirePublicJoinPolicyRevisionTx(ctx, tx, expectedSystemSettingsRevision); err != nil {
			return err
		}
		var registrationID, groupID, email, displayName, passwordHash, expiresAt string
		var linkVersion int64
		err := tx.QueryRowContext(ctx, `SELECT id,group_id,join_link_version,email,display_name,password_hash,expires_at FROM public_join_registrations WHERE verification_token_hash=? AND consumed_at IS NULL AND invalidated_at IS NULL`, platform.HashSecret(verificationToken)).Scan(&registrationID, &groupID, &linkVersion, &email, &displayName, &passwordHash, &expiresAt)
		if errors.Is(err, sql.ErrNoRows) {
			return domain.ErrNotFound
		}
		if err != nil {
			return err
		}
		nowValue := platform.Now()
		registrationExpires, err := time.Parse(time.RFC3339Nano, expiresAt)
		if err != nil || !registrationExpires.After(nowValue) {
			return fmt.Errorf("%w: public registration has expired", domain.ErrConflict)
		}
		link, err := loadPublicJoinLinkByGroup(ctx, tx, groupID)
		if err != nil {
			return err
		}
		if link.Version != linkVersion {
			return fmt.Errorf("%w: public join link changed", domain.ErrConflict)
		}
		if err := validateLoadedPublicJoinLink(link, nowValue); err != nil {
			return err
		}
		var existing int
		if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM users WHERE email=? COLLATE NOCASE`, email).Scan(&existing); err != nil {
			return err
		}
		if existing > 0 {
			return fmt.Errorf("%w: account already exists; sign in to join", domain.ErrConflict)
		}
		userID, err := platform.NewID("usr")
		if err != nil {
			return err
		}
		now := platform.Timestamp(nowValue)
		if _, err := tx.ExecContext(ctx, `INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,?)`, userID, email, displayName, passwordHash, now, now); err != nil {
			return err
		}
		principal := domain.Principal{UserID: userID, Email: email, DisplayName: displayName}
		membership, err = joinCurrentDefaultRole(ctx, tx, principal, groupID, now)
		if err != nil {
			return err
		}
		result, err := tx.ExecContext(ctx, `UPDATE public_join_registrations SET consumed_at=? WHERE id=? AND consumed_at IS NULL AND invalidated_at IS NULL`, now, registrationID)
		if err != nil {
			return err
		}
		changed, _ := result.RowsAffected()
		if changed != 1 {
			return domain.ErrConflict
		}
		if _, err := tx.ExecContext(ctx, `UPDATE public_join_email_outbox SET status='CANCELLED',token_ciphertext=NULL,next_attempt_at=NULL,lease_token=NULL,lease_until=NULL,last_error_code='registration_consumed',updated_at=? WHERE registration_id=? AND status IN ('PENDING','SENDING','FAILED')`, now, registrationID); err != nil {
			return err
		}
		session, err = createSessionTx(ctx, tx, principal, s.SessionLifetime, nowValue)
		if err != nil {
			return err
		}
		return audit.Record(ctx, tx, groupID, userID, membership.ID, "public_join.completed", "public_join_link", groupID, map[string]any{"existingUser": false, "reactivated": false})
	})
	return session, membership, err
}

// AcceptPublicJoinLink adds an already authenticated account to the group
// represented by token using the current default role. Existing active
// memberships are returned unchanged; archived memberships are atomically
// replaced with the current default-role assignment.
func (s Service) AcceptPublicJoinLink(ctx context.Context, principal domain.Principal, token string, expectedSystemSettingsRevision int64) (domain.Membership, error) {
	token = strings.TrimSpace(token)
	if token == "" {
		return domain.Membership{}, domain.ValidationError{Field: "token", Message: "is required"}
	}
	var membership domain.Membership
	err := storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		if err := requirePublicJoinPolicyRevisionTx(ctx, tx, expectedSystemSettingsRevision); err != nil {
			return err
		}
		link, err := loadPublicJoinLink(ctx, tx, token)
		if err != nil {
			return err
		}
		if err := validateLoadedPublicJoinLink(link, platform.Now()); err != nil {
			return err
		}
		var membershipID, status string
		err = tx.QueryRowContext(ctx, `SELECT id,status FROM memberships WHERE group_id=? AND user_id=? AND deleted_at IS NULL`, link.GroupID, principal.UserID).Scan(&membershipID, &status)
		if err == nil && status == "ACTIVE" {
			return hydrateJoinedMembership(ctx, tx, principal, membershipID, link.GroupID, &membership)
		}
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		now := platform.Timestamp(platform.Now())
		reactivated := err == nil
		if reactivated {
			if _, err := tx.ExecContext(ctx, `DELETE FROM membership_role_assignments WHERE group_id=? AND membership_id=?`, link.GroupID, membershipID); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `DELETE FROM membership_roles WHERE group_id=? AND membership_id=?`, link.GroupID, membershipID); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `UPDATE memberships SET status='ACTIVE',archived_at=NULL WHERE group_id=? AND id=? AND status='ARCHIVED' AND deleted_at IS NULL`, link.GroupID, membershipID); err != nil {
				return err
			}
		} else {
			membershipID, err = platform.NewID("mem")
			if err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO memberships(id,group_id,user_id,status,joined_at) VALUES(?,?,?,'ACTIVE',?)`, membershipID, link.GroupID, principal.UserID, now); err != nil {
				return err
			}
		}
		if err := assignCurrentDefaultRole(ctx, tx, principal.UserID, link.GroupID, membershipID, now); err != nil {
			return err
		}
		if err := hydrateJoinedMembership(ctx, tx, principal, membershipID, link.GroupID, &membership); err != nil {
			return err
		}
		return audit.Record(ctx, tx, link.GroupID, principal.UserID, membershipID, "public_join.completed", "public_join_link", link.GroupID, map[string]any{"existingUser": true, "reactivated": reactivated})
	})
	return membership, err
}

type loadedPublicJoinLink struct {
	GroupID   string
	Version   int64
	ExpiresAt *string
}

type publicJoinQueryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func requirePublicJoinPolicyRevisionTx(ctx context.Context, tx *sql.Tx, expectedRevision int64) error {
	if expectedRevision < 1 {
		return nil
	}
	var currentRevision int64
	if err := tx.QueryRowContext(ctx, `SELECT revision FROM system_settings_state WHERE singleton=1`).Scan(&currentRevision); err != nil {
		return fmt.Errorf("revalidate public-join policy revision: %w", err)
	}
	if currentRevision != expectedRevision {
		return fmt.Errorf("%w: instance access policy changed; retry the request", domain.ErrConflict)
	}
	return nil
}

func loadPublicJoinLink(ctx context.Context, queryer publicJoinQueryer, token string) (loadedPublicJoinLink, error) {
	var link loadedPublicJoinLink
	var expiresAt sql.NullString
	err := queryer.QueryRowContext(ctx, `SELECT l.group_id,l.version,l.expires_at FROM public_join_links l JOIN groups g ON g.id=l.group_id WHERE l.token_hash=? AND l.enabled=1 AND g.status='ACTIVE'`, platform.HashSecret(strings.TrimSpace(token))).Scan(&link.GroupID, &link.Version, &expiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return loadedPublicJoinLink{}, domain.ErrNotFound
	}
	if err != nil {
		return loadedPublicJoinLink{}, err
	}
	if expiresAt.Valid {
		link.ExpiresAt = &expiresAt.String
	}
	return link, nil
}

func loadPublicJoinLinkByGroup(ctx context.Context, queryer publicJoinQueryer, groupID string) (loadedPublicJoinLink, error) {
	var link loadedPublicJoinLink
	var expiresAt sql.NullString
	var enabled bool
	err := queryer.QueryRowContext(ctx, `SELECT l.group_id,l.version,l.expires_at,l.enabled FROM public_join_links l JOIN groups g ON g.id=l.group_id WHERE l.group_id=? AND g.status='ACTIVE'`, groupID).Scan(&link.GroupID, &link.Version, &expiresAt, &enabled)
	if errors.Is(err, sql.ErrNoRows) || err == nil && !enabled {
		return loadedPublicJoinLink{}, domain.ErrNotFound
	}
	if err != nil {
		return loadedPublicJoinLink{}, err
	}
	if expiresAt.Valid {
		link.ExpiresAt = &expiresAt.String
	}
	return link, nil
}

func validateLoadedPublicJoinLink(link loadedPublicJoinLink, now time.Time) error {
	if link.ExpiresAt == nil {
		return nil
	}
	expires, err := time.Parse(time.RFC3339Nano, *link.ExpiresAt)
	if err != nil {
		return fmt.Errorf("parse public join-link expiry: %w", err)
	}
	if !expires.After(now) {
		return fmt.Errorf("%w: public join link has expired", domain.ErrConflict)
	}
	return nil
}

func joinCurrentDefaultRole(ctx context.Context, tx *sql.Tx, principal domain.Principal, groupID, now string) (domain.Membership, error) {
	membershipID, err := platform.NewID("mem")
	if err != nil {
		return domain.Membership{}, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO memberships(id,group_id,user_id,status,joined_at) VALUES(?,?,?,'ACTIVE',?)`, membershipID, groupID, principal.UserID, now); err != nil {
		return domain.Membership{}, err
	}
	if err := assignCurrentDefaultRole(ctx, tx, principal.UserID, groupID, membershipID, now); err != nil {
		return domain.Membership{}, err
	}
	var membership domain.Membership
	if err := hydrateJoinedMembership(ctx, tx, principal, membershipID, groupID, &membership); err != nil {
		return domain.Membership{}, err
	}
	return membership, nil
}

func assignCurrentDefaultRole(ctx context.Context, tx *sql.Tx, actorUserID, groupID, membershipID, now string) error {
	var roleID string
	if err := tx.QueryRowContext(ctx, `SELECT default_role_id FROM group_settings WHERE group_id=? AND default_role_id IS NOT NULL`, groupID).Scan(&roleID); errors.Is(err, sql.ErrNoRows) {
		return domain.ValidationError{Field: "defaultRoleId", Message: "group has no default role"}
	} else if err != nil {
		return err
	}
	var grantsAdministration int
	if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM roles r LEFT JOIN role_permission_grants g ON g.group_id=r.group_id AND g.role_id=r.id AND g.permission_key IN ('GROUP_ADMINISTRATION','MEMBER_MANAGEMENT') AND g.scope_type='GROUP' WHERE r.group_id=? AND r.id=? AND g.role_id IS NOT NULL`, groupID, roleID).Scan(&grantsAdministration); err != nil {
		return err
	}
	if grantsAdministration > 0 {
		return domain.ValidationError{Field: "defaultRoleId", Message: "default role cannot grant administration permissions"}
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO membership_role_assignments(group_id,membership_id,role_id,version,assigned_at,assigned_by) VALUES(?,?,?,1,?,?)`, groupID, membershipID, roleID, now, actorUserID); err != nil {
		return err
	}
	legacyRoles, err := legacyRolesForAssignedRoleTx(ctx, tx, groupID, roleID)
	if err != nil {
		return err
	}
	for _, legacyRole := range legacyRoles {
		if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO membership_roles(group_id,membership_id,role,granted_at,granted_by) VALUES(?,?,?,?,?)`, groupID, membershipID, legacyRole, now, actorUserID); err != nil {
			return err
		}
	}
	return nil
}

func hydrateJoinedMembership(ctx context.Context, queryer publicJoinQueryer, principal domain.Principal, membershipID, groupID string, membership *domain.Membership) error {
	membership.ID = membershipID
	membership.GroupID = groupID
	membership.UserID = principal.UserID
	membership.Email = stringPointer(principal.Email)
	membership.DisplayName = principal.DisplayName
	membership.AvatarURL = media.UserAvatarURL(principal.UserID, "")
	membership.Status = "ACTIVE"
	membership.IsTemporaryGuest = false
	return nil
}

func createSessionTx(ctx context.Context, tx *sql.Tx, principal domain.Principal, lifetime time.Duration, now time.Time) (Session, error) {
	token, err := platform.NewSecret()
	if err != nil {
		return Session{}, err
	}
	csrf, err := platform.NewSecret()
	if err != nil {
		return Session{}, err
	}
	expires := now.Add(lifetime)
	if _, err := tx.ExecContext(ctx, `INSERT INTO sessions(id_hash,user_id,csrf_hash,expires_at,last_seen_at,created_at) VALUES(?,?,?,?,?,?)`, platform.HashSecret(token), principal.UserID, platform.HashSecret(csrf), platform.Timestamp(expires), platform.Timestamp(now), platform.Timestamp(now)); err != nil {
		return Session{}, err
	}
	principal.SessionHash = platform.HashSecret(token)
	principal.CSRFToken = csrf
	return Session{Token: token, CSRFToken: csrf, ExpiresAt: expires, Principal: principal}, nil
}
