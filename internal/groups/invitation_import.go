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
	"github.com/DasLukas/TeamTaler/internal/idempotency"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

const maxInvitationImportRows = 100

// TokenSealer encrypts an invitation token for temporary outbox persistence.
// Implementations must use authenticated encryption and be safe for concurrent
// use. Seal must never include plaintext in returned errors.
type TokenSealer interface {
	Seal(plaintext string) (string, error)
}

// TokenOpener authenticates and decrypts a token previously produced by a
// TokenSealer. Implementations must return generic errors that never contain
// ciphertext or plaintext.
type TokenOpener interface {
	Open(ciphertext string) (string, error)
}

// InvitationImportStatus describes the business outcome for one CSV row.
type InvitationImportStatus string

const (
	// InvitationImportCreated means an invitation and email job were committed.
	InvitationImportCreated InvitationImportStatus = "CREATED"
	// InvitationImportInvalid means row-level validation prevented creation.
	InvitationImportInvalid InvitationImportStatus = "INVALID"
	// InvitationImportSkippedMember means the address already belongs to the group.
	InvitationImportSkippedMember InvitationImportStatus = "SKIPPED_ALREADY_MEMBER"
	// InvitationImportSkippedInvitation means a current invitation already exists.
	InvitationImportSkippedInvitation InvitationImportStatus = "SKIPPED_ALREADY_INVITED"
)

// EmailDeliveryStatus describes durable invitation email delivery state.
type EmailDeliveryStatus string

const (
	// EmailDeliveryNotRequested identifies manually shared invitation links.
	EmailDeliveryNotRequested EmailDeliveryStatus = "NOT_REQUESTED"
	// EmailDeliveryPending identifies a queued delivery waiting for a worker.
	EmailDeliveryPending EmailDeliveryStatus = "PENDING"
	// EmailDeliverySending identifies a delivery protected by a worker lease.
	EmailDeliverySending EmailDeliveryStatus = "SENDING"
	// EmailDeliverySent identifies a message accepted by the configured SMTP relay.
	EmailDeliverySent EmailDeliveryStatus = "SENT"
	// EmailDeliveryFailed identifies a delivery that exhausted automatic retries.
	EmailDeliveryFailed EmailDeliveryStatus = "FAILED"
	// EmailDeliveryCancelled identifies a job invalidated before delivery.
	EmailDeliveryCancelled EmailDeliveryStatus = "CANCELLED"
)

// InvitationImportCandidate is one parsed CSV row supplied to the group service.
// ValidationCode may be set by a structural parser to preserve partial results.
type InvitationImportCandidate struct {
	Row            int      `json:"row"`
	Email          string   `json:"email,omitempty"`
	DisplayName    string   `json:"displayName,omitempty"`
	RoleNames      []string `json:"roleNames,omitempty"`
	ValidationCode string   `json:"validationCode,omitempty"`
}

// InvitationImportRow is the stable, secret-free outcome for one source row.
type InvitationImportRow struct {
	Row                 int                    `json:"row"`
	Email               string                 `json:"email,omitempty"`
	DisplayName         string                 `json:"displayName,omitempty"`
	InvitationID        string                 `json:"invitationId,omitempty"`
	InvitationStatus    InvitationImportStatus `json:"invitationStatus"`
	EmailDeliveryStatus EmailDeliveryStatus    `json:"emailDeliveryStatus,omitempty"`
	Code                string                 `json:"code,omitempty"`
}

// InvitationImportSummary aggregates one idempotent CSV import result.
type InvitationImportSummary struct {
	TotalRows int `json:"totalRows"`
	Created   int `json:"created"`
	Invalid   int `json:"invalid"`
	Skipped   int `json:"skipped"`
}

// InvitationImportResult is the complete secret-free response persisted for
// idempotent replay.
type InvitationImportResult struct {
	Summary InvitationImportSummary `json:"summary"`
	Rows    []InvitationImportRow   `json:"rows"`
}

// InvitationEmailRetryResult reports a failed job returned to the delivery
// queue. It contains no invitation token or SMTP error detail.
type InvitationEmailRetryResult struct {
	InvitationID        string              `json:"invitationId"`
	EmailDeliveryStatus EmailDeliveryStatus `json:"emailDeliveryStatus"`
}

// InvitationEmailResendResult reports a rotated invitation returned to the
// durable delivery queue. Token is intentionally excluded from JSON used for
// idempotency storage and is populated only for the first successful command so
// the HTTP layer can expose one manual fallback URL.
type InvitationEmailResendResult struct {
	InvitationID        string              `json:"invitationId"`
	EmailDeliveryStatus EmailDeliveryStatus `json:"emailDeliveryStatus"`
	ExpiresAt           string              `json:"expiresAt"`
	Token               string              `json:"-"`
}

// ImportInvitations atomically creates invitations with row-specific role
// names, a legacy shared role set, or the configured default role and encrypted
// email outbox jobs for valid candidates.
// Invalid, existing-member, and current-invitation rows are returned as partial
// outcomes. idempotencyKey protects the role selection and batch from duplicate
// jobs. It returns forbidden, unavailable, validation, idempotency, encryption,
// audit, or database errors. No plaintext token is returned or stored in the
// idempotency result.
func (s Service) ImportInvitations(ctx context.Context, actor domain.Principal, membership domain.Membership, idempotencyKey string, roleIDs []string, candidates []InvitationImportCandidate) (InvitationImportResult, error) {
	if err := requireCurrentPermission(ctx, s.DB, membership, domain.PermissionGroupAdministration); err != nil {
		return InvitationImportResult{}, err
	}
	if s.TokenSealer == nil {
		return InvitationImportResult{}, fmt.Errorf("%w: invitation email is not configured", domain.ErrServiceUnavailable)
	}
	if err := idempotency.ValidateKey(idempotencyKey); err != nil {
		return InvitationImportResult{}, err
	}
	if len(candidates) < 1 || len(candidates) > maxInvitationImportRows {
		return InvitationImportResult{}, domain.ValidationError{Field: "file", Message: fmt.Sprintf("must contain 1 to %d data rows", maxInvitationImportRows)}
	}
	roleIDs = normalizeRoleIDs(roleIDs)

	normalized := normalizeImportCandidates(candidates)
	requestHash, err := idempotency.Hash(map[string]any{"action": "invitation.import", "roleIds": roleIDs, "rows": normalized})
	if err != nil {
		return InvitationImportResult{}, fmt.Errorf("hash invitation import: %w", err)
	}
	result := InvitationImportResult{
		Summary: InvitationImportSummary{TotalRows: len(normalized)},
		Rows:    make([]InvitationImportRow, 0, len(normalized)),
	}
	err = storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		if err := requireCurrentPermission(ctx, tx, membership, domain.PermissionGroupAdministration); err != nil {
			return err
		}
		found, err := idempotency.Load(ctx, tx, membership.GroupID, actor.UserID, idempotencyKey, requestHash, &result)
		if err != nil || found {
			return err
		}

		if len(roleIDs) > 0 {
			if err := validateAssignedRoles(ctx, tx, membership.GroupID, roleIDs); err != nil {
				return err
			}
		}
		adminRoleID, err := reservedAdministratorRoleID(ctx, tx, membership.GroupID)
		if err != nil {
			return err
		}
		if len(roleIDs) > 0 {
			if err := requireAssignmentChangePermissions(ctx, tx, membership, adminRoleID, nil, roleIDs); err != nil {
				return err
			}
		}
		var defaultRoleID sql.NullString
		if err := tx.QueryRowContext(ctx, `SELECT default_role_id FROM group_settings WHERE group_id=?`, membership.GroupID).Scan(&defaultRoleID); err != nil {
			return err
		}
		now := platform.Now()
		for _, candidate := range normalized {
			row := InvitationImportRow{Row: candidate.Row, Email: candidate.Email, DisplayName: candidate.DisplayName}
			if candidate.ValidationCode != "" {
				row.InvitationStatus = InvitationImportInvalid
				row.Code = candidate.ValidationCode
				result.Summary.Invalid++
				result.Rows = append(result.Rows, row)
				continue
			}
			effectiveRoleIDs := roleIDs
			if len(candidate.RoleNames) > 0 {
				effectiveRoleIDs, err = resolveImportRoleNames(ctx, tx, membership.GroupID, candidate.RoleNames)
				if errors.Is(err, sql.ErrNoRows) {
					row.InvitationStatus = InvitationImportInvalid
					row.Code = "unknown_role"
					result.Summary.Invalid++
					result.Rows = append(result.Rows, row)
					continue
				}
				if err != nil {
					return err
				}
			} else if len(effectiveRoleIDs) == 0 && defaultRoleID.Valid {
				effectiveRoleIDs = []string{defaultRoleID.String}
			}
			if len(effectiveRoleIDs) == 0 {
				row.InvitationStatus = InvitationImportInvalid
				row.Code = "missing_default_role"
				result.Summary.Invalid++
				result.Rows = append(result.Rows, row)
				continue
			}
			if err := requireAssignmentChangePermissions(ctx, tx, membership, adminRoleID, nil, effectiveRoleIDs); err != nil {
				return err
			}

			invitation, createErr := createInvitationTx(ctx, tx, actor, membership, candidate.Email, candidate.DisplayName, nil, nil, nil, effectiveRoleIDs, now)
			switch {
			case errors.Is(createErr, ErrMembershipEmailExists):
				row.InvitationStatus = InvitationImportSkippedMember
				row.Code = "already_member"
				result.Summary.Skipped++
				result.Rows = append(result.Rows, row)
				continue
			case errors.Is(createErr, ErrInvitationEmailExists):
				row.InvitationStatus = InvitationImportSkippedInvitation
				row.Code = "already_invited"
				row.InvitationID, row.EmailDeliveryStatus, err = currentInvitationDeliveryTx(ctx, tx, membership.GroupID, candidate.Email, now)
				if err != nil {
					return err
				}
				result.Summary.Skipped++
				result.Rows = append(result.Rows, row)
				continue
			case createErr != nil:
				return createErr
			}

			if err := s.queueInvitationEmailTx(ctx, tx, actor, membership, invitation, now); err != nil {
				return err
			}
			row.InvitationID = invitation.ID
			row.InvitationStatus = InvitationImportCreated
			row.EmailDeliveryStatus = EmailDeliveryPending
			result.Summary.Created++
			result.Rows = append(result.Rows, row)
		}
		return idempotency.Store(ctx, tx, membership.GroupID, actor.UserID, idempotencyKey, requestHash, 200, result)
	})
	if err != nil {
		return InvitationImportResult{}, err
	}
	return result, nil
}

// queueInvitationEmailTx encrypts an invitation token and persists its pending
// delivery job inside the caller-owned transaction. The method requires a
// configured TokenSealer and records a secret-free audit event. It returns
// configuration, encryption, audit, or database errors.
func (s Service) queueInvitationEmailTx(ctx context.Context, tx *sql.Tx, actor domain.Principal, membership domain.Membership, invitation Invitation, now time.Time) error {
	if s.TokenSealer == nil {
		return fmt.Errorf("%w: invitation email is not configured", domain.ErrServiceUnavailable)
	}
	encryptedToken, err := s.TokenSealer.Seal(invitation.Token)
	if err != nil {
		return fmt.Errorf("encrypt invitation token: %w", err)
	}
	nowText := platform.Timestamp(now)
	if _, err := tx.ExecContext(ctx, `INSERT INTO invitation_email_outbox(
		invitation_id,group_id,token_ciphertext,status,attempt_count,next_attempt_at,created_at,updated_at
	) VALUES(?,?,?,'PENDING',0,?,?,?)`, invitation.ID, membership.GroupID, encryptedToken, nowText, nowText, nowText); err != nil {
		return err
	}
	return audit.Record(ctx, tx, membership.GroupID, actor.UserID, membership.ID, "invitation.email.queued", "invitation", invitation.ID, map[string]any{"email": invitation.Email})
}

func currentInvitationDeliveryTx(ctx context.Context, tx *sql.Tx, groupID, email string, now time.Time) (string, EmailDeliveryStatus, error) {
	var invitationID string
	var status EmailDeliveryStatus
	err := tx.QueryRowContext(ctx, `SELECT i.id,coalesce(o.status,'NOT_REQUESTED')
		FROM invitations i LEFT JOIN invitation_email_outbox o ON o.invitation_id=i.id
		WHERE i.group_id=? AND i.email=? AND i.accepted_at IS NULL AND i.revoked_at IS NULL
		AND julianday(i.expires_at)>julianday(?)
		ORDER BY julianday(i.created_at) DESC LIMIT 1`, groupID, email, platform.Timestamp(now)).Scan(&invitationID, &status)
	if err != nil {
		return "", "", fmt.Errorf("load existing invitation delivery: %w", err)
	}
	return invitationID, status, nil
}

// RetryInvitationEmail atomically returns one terminally failed, unconsumed,
// unexpired invitation email to the outbox. idempotencyKey prevents duplicate
// administrative retry commands. It returns forbidden, validation, not-found,
// conflict, idempotency, audit, or database errors. The encrypted token remains
// unchanged and no network I/O occurs inside the transaction.
func (s Service) RetryInvitationEmail(ctx context.Context, actor domain.Principal, membership domain.Membership, idempotencyKey, invitationID string) (InvitationEmailRetryResult, error) {
	if err := requireCurrentPermission(ctx, s.DB, membership, domain.PermissionGroupAdministration); err != nil {
		return InvitationEmailRetryResult{}, err
	}
	if s.TokenSealer == nil {
		return InvitationEmailRetryResult{}, fmt.Errorf("%w: invitation email is not configured", domain.ErrServiceUnavailable)
	}
	if err := idempotency.ValidateKey(idempotencyKey); err != nil {
		return InvitationEmailRetryResult{}, err
	}
	invitationID = strings.TrimSpace(invitationID)
	if invitationID == "" {
		return InvitationEmailRetryResult{}, domain.ValidationError{Field: "invitationId", Message: "is required"}
	}
	requestHash, err := idempotency.Hash(map[string]any{"action": "invitation.email.retry", "invitationId": invitationID})
	if err != nil {
		return InvitationEmailRetryResult{}, fmt.Errorf("hash invitation email retry: %w", err)
	}
	result := InvitationEmailRetryResult{InvitationID: invitationID, EmailDeliveryStatus: EmailDeliveryPending}
	err = storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		if err := requireCurrentPermission(ctx, tx, membership, domain.PermissionGroupAdministration); err != nil {
			return err
		}
		found, err := idempotency.Load(ctx, tx, membership.GroupID, actor.UserID, idempotencyKey, requestHash, &result)
		if err != nil || found {
			return err
		}
		var status string
		var acceptedAt, revokedAt, ciphertext sql.NullString
		var expiresAt string
		err = tx.QueryRowContext(ctx, `SELECT o.status,i.accepted_at,i.revoked_at,i.expires_at,o.token_ciphertext
			FROM invitation_email_outbox o JOIN invitations i ON i.id=o.invitation_id
			WHERE o.invitation_id=? AND o.group_id=?`, invitationID, membership.GroupID).
			Scan(&status, &acceptedAt, &revokedAt, &expiresAt, &ciphertext)
		if errors.Is(err, sql.ErrNoRows) {
			return domain.ErrNotFound
		}
		if err != nil {
			return err
		}
		nowValue := platform.Now()
		expiry, parseErr := time.Parse(time.RFC3339Nano, expiresAt)
		if parseErr != nil {
			return fmt.Errorf("parse invitation expiry: %w", parseErr)
		}
		if status != string(EmailDeliveryFailed) || acceptedAt.Valid || revokedAt.Valid || !expiry.After(nowValue) || !ciphertext.Valid || ciphertext.String == "" {
			return fmt.Errorf("%w: invitation email is not retryable", domain.ErrConflict)
		}
		now := platform.Timestamp(nowValue)
		updated, err := tx.ExecContext(ctx, `UPDATE invitation_email_outbox SET
			status='PENDING',attempt_count=0,next_attempt_at=?,lease_token=NULL,lease_until=NULL,last_error_code=NULL,updated_at=?
			WHERE invitation_id=? AND group_id=? AND status='FAILED'`, now, now, invitationID, membership.GroupID)
		if err != nil {
			return err
		}
		changed, err := updated.RowsAffected()
		if err != nil {
			return err
		}
		if changed != 1 {
			return fmt.Errorf("%w: invitation email state changed", domain.ErrConflict)
		}
		if err := audit.Record(ctx, tx, membership.GroupID, actor.UserID, membership.ID, "invitation.email.retried", "invitation", invitationID, map[string]any{}); err != nil {
			return err
		}
		return idempotency.Store(ctx, tx, membership.GroupID, actor.UserID, idempotencyKey, requestHash, 200, result)
	})
	if err != nil {
		return InvitationEmailRetryResult{}, err
	}
	return result, nil
}

// ResendInvitationEmail rotates the bearer token and seven-day expiry for one
// unconsumed invitation and queues exactly one fresh outbox job. idempotencyKey
// deduplicates administrative commands; invitationID selects an invitation in
// membership's group. PENDING and SENDING jobs are rejected to prevent duplicate
// delivery. The plaintext Token is returned once and never persisted in the
// idempotency response. The method returns authorization, validation, not-found,
// conflict, configuration, encryption, randomness, audit, or database errors.
func (s Service) ResendInvitationEmail(ctx context.Context, actor domain.Principal, membership domain.Membership, idempotencyKey, invitationID string) (InvitationEmailResendResult, error) {
	if err := requireCurrentPermission(ctx, s.DB, membership, domain.PermissionGroupAdministration); err != nil {
		return InvitationEmailResendResult{}, err
	}
	if s.TokenSealer == nil {
		return InvitationEmailResendResult{}, fmt.Errorf("%w: invitation email is not configured", domain.ErrServiceUnavailable)
	}
	if err := idempotency.ValidateKey(idempotencyKey); err != nil {
		return InvitationEmailResendResult{}, err
	}
	invitationID = strings.TrimSpace(invitationID)
	if invitationID == "" {
		return InvitationEmailResendResult{}, domain.ValidationError{Field: "invitationId", Message: "is required"}
	}
	requestHash, err := idempotency.Hash(map[string]any{"action": "invitation.email.resend", "invitationId": invitationID})
	if err != nil {
		return InvitationEmailResendResult{}, fmt.Errorf("hash invitation email resend: %w", err)
	}
	result := InvitationEmailResendResult{InvitationID: invitationID, EmailDeliveryStatus: EmailDeliveryPending}
	err = storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		if err := requireCurrentPermission(ctx, tx, membership, domain.PermissionGroupAdministration); err != nil {
			return err
		}
		found, err := idempotency.Load(ctx, tx, membership.GroupID, actor.UserID, idempotencyKey, requestHash, &result)
		if err != nil || found {
			return err
		}
		var status string
		var emailAddress string
		var acceptedAt, revokedAt sql.NullString
		err = tx.QueryRowContext(ctx, `SELECT coalesce(o.status,'NOT_REQUESTED'),i.accepted_at,i.revoked_at,i.email
			FROM invitations i LEFT JOIN invitation_email_outbox o ON o.invitation_id=i.id
			WHERE i.id=? AND i.group_id=?`, invitationID, membership.GroupID).
			Scan(&status, &acceptedAt, &revokedAt, &emailAddress)
		if errors.Is(err, sql.ErrNoRows) {
			return domain.ErrNotFound
		}
		if err != nil {
			return err
		}
		if acceptedAt.Valid || revokedAt.Valid {
			return fmt.Errorf("%w: invitation is no longer active", domain.ErrConflict)
		}
		if status == string(EmailDeliveryPending) || status == string(EmailDeliverySending) {
			return fmt.Errorf("%w: invitation email delivery is already in progress", domain.ErrConflict)
		}
		var competingInvitations int
		if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM invitations
			WHERE group_id=? AND email=? COLLATE NOCASE AND id<>? AND accepted_at IS NULL AND revoked_at IS NULL
			AND julianday(expires_at)>julianday(?)`, membership.GroupID, emailAddress, invitationID, platform.Timestamp(platform.Now())).Scan(&competingInvitations); err != nil {
			return err
		}
		if competingInvitations > 0 {
			return fmt.Errorf("%w: %w", domain.ErrConflict, ErrInvitationEmailExists)
		}

		token, err := platform.NewSecret()
		if err != nil {
			return err
		}
		encryptedToken, err := s.TokenSealer.Seal(token)
		if err != nil {
			return fmt.Errorf("encrypt invitation token: %w", err)
		}
		nowValue := platform.Now()
		now := platform.Timestamp(nowValue)
		expiresAt := platform.Timestamp(nowValue.Add(7 * 24 * time.Hour))
		updated, err := tx.ExecContext(ctx, `UPDATE invitations SET token_hash=?,expires_at=?
			WHERE id=? AND group_id=? AND accepted_at IS NULL AND revoked_at IS NULL`, platform.HashSecret(token), expiresAt, invitationID, membership.GroupID)
		if err != nil {
			if strings.Contains(err.Error(), activeInvitationEmailConstraint) {
				return fmt.Errorf("%w: %w", domain.ErrConflict, ErrInvitationEmailExists)
			}
			return err
		}
		changed, err := updated.RowsAffected()
		if err != nil {
			return err
		}
		if changed != 1 {
			return fmt.Errorf("%w: invitation state changed", domain.ErrConflict)
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO invitation_email_outbox(
			invitation_id,group_id,token_ciphertext,status,attempt_count,next_attempt_at,created_at,updated_at
		) VALUES(?,?,?,'PENDING',0,?,?,?)
		ON CONFLICT(invitation_id) DO UPDATE SET
			token_ciphertext=excluded.token_ciphertext,status='PENDING',attempt_count=0,next_attempt_at=excluded.next_attempt_at,
			lease_token=NULL,lease_until=NULL,sent_at=NULL,last_error_code=NULL,updated_at=excluded.updated_at`,
			invitationID, membership.GroupID, encryptedToken, now, now, now); err != nil {
			return err
		}
		result.ExpiresAt = expiresAt
		result.Token = token
		if err := audit.Record(ctx, tx, membership.GroupID, actor.UserID, membership.ID, "invitation.email.resent", "invitation", invitationID, map[string]any{"expiresAt": expiresAt}); err != nil {
			return err
		}
		return idempotency.Store(ctx, tx, membership.GroupID, actor.UserID, idempotencyKey, requestHash, 200, result)
	})
	if err != nil {
		return InvitationEmailResendResult{}, err
	}
	return result, nil
}

func normalizeImportCandidates(candidates []InvitationImportCandidate) []InvitationImportCandidate {
	result := make([]InvitationImportCandidate, len(candidates))
	for index, candidate := range candidates {
		candidate.Email = strings.TrimSpace(candidate.Email)
		candidate.DisplayName = strings.TrimSpace(candidate.DisplayName)
		for roleIndex := range candidate.RoleNames {
			candidate.RoleNames[roleIndex] = strings.TrimSpace(candidate.RoleNames[roleIndex])
		}
		if candidate.ValidationCode == "" {
			email, err := platform.NormalizeEmail(candidate.Email)
			switch {
			case err != nil:
				candidate.Email = ""
				candidate.ValidationCode = "invalid_email"
			case len(candidate.DisplayName) > 120:
				candidate.Email = email
				candidate.ValidationCode = "display_name_too_long"
			case containsControlCharacter(candidate.DisplayName):
				candidate.Email = email
				candidate.ValidationCode = "invalid_display_name"
			default:
				candidate.Email = email
			}
		}
		result[index] = candidate
	}
	return result
}

func resolveImportRoleNames(ctx context.Context, queryer settingsQueryer, groupID string, roleNames []string) ([]string, error) {
	roleIDs := make([]string, 0, len(roleNames))
	seen := make(map[string]struct{}, len(roleNames))
	for _, roleName := range roleNames {
		var roleID string
		if err := queryer.QueryRowContext(ctx, `SELECT id FROM roles WHERE group_id=? AND name=? COLLATE NOCASE`, groupID, roleName).Scan(&roleID); err != nil {
			return nil, err
		}
		if _, exists := seen[roleID]; exists {
			continue
		}
		seen[roleID] = struct{}{}
		roleIDs = append(roleIDs, roleID)
	}
	return roleIDs, nil
}

func containsControlCharacter(value string) bool {
	for _, character := range value {
		if unicode.IsControl(character) {
			return true
		}
	}
	return false
}
