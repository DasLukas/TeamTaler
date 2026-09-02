package system

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/DasLukas/TeamTaler/internal/audit"
	"github.com/DasLukas/TeamTaler/internal/authorization"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/media"
	"github.com/DasLukas/TeamTaler/internal/paymentattachments"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

const (
	// GroupStatusProvisioning identifies a group awaiting its first administrator.
	GroupStatusProvisioning = "PROVISIONING"
	// GroupStatusActive identifies a normally usable group.
	GroupStatusActive = "ACTIVE"
	// GroupStatusArchived identifies a reversible, inaccessible group.
	GroupStatusArchived = "ARCHIVED"
	// GroupStatusPurging identifies the private in-transaction deletion state.
	GroupStatusPurging        = "PURGING"
	referencedMediaRetryDelay = 5 * time.Minute
)

// InvitationEmailDeliveryStatus describes optional delivery for an immediate
// first-administrator invitation result.
type InvitationEmailDeliveryStatus string

const (
	// InvitationEmailDeliveryNotRequested means the returned link must be shared manually.
	InvitationEmailDeliveryNotRequested InvitationEmailDeliveryStatus = "NOT_REQUESTED"
	// InvitationEmailDeliveryPending means encrypted email delivery was queued.
	InvitationEmailDeliveryPending InvitationEmailDeliveryStatus = "PENDING"
)

// SecretSealer encrypts a provisioning invitation token before it enters the
// durable email outbox. Implementations must use authenticated encryption.
type SecretSealer interface {
	Seal(string) (string, error)
}

// ManagedGroup is the system-administration projection of one group and its
// deletion-impact counters. It never exposes business records.
type ManagedGroup struct {
	ID                   string  `json:"id"`
	Name                 string  `json:"name"`
	Currency             string  `json:"currency"`
	Status               string  `json:"status"`
	Version              int64   `json:"version"`
	ArchivedAt           *string `json:"archivedAt,omitempty"`
	ArchivedByUserID     *string `json:"archivedByUserId,omitempty"`
	AdministratorEmail   *string `json:"administratorEmail,omitempty"`
	CreatedAt            string  `json:"createdAt"`
	LogoURL              string  `json:"logoUrl,omitempty"`
	MemberCount          int64   `json:"memberCount"`
	InvitationCount      int64   `json:"invitationCount"`
	BookingCount         int64   `json:"bookingCount"`
	FinancialRecordCount int64   `json:"financialRecordCount"`
	AuditEventCount      int64   `json:"auditEventCount"`
	MediaCount           int64   `json:"mediaCount"`
	OpenBalanceMinor     int64   `json:"-"`
	// InvitationToken is populated only by an immediate provisioning create or
	// replacement result. It is never serialized as part of a managed group.
	InvitationToken string `json:"-"`
	// InvitationEmailDeliveryStatus reports whether the immediate invitation
	// was queued for optional email delivery.
	InvitationEmailDeliveryStatus InvitationEmailDeliveryStatus `json:"-"`
	// InvitationExpiresAt is populated only with an immediate provisioning
	// invitation result so every client can display its exact lifetime.
	InvitationExpiresAt string `json:"-"`
}

// DeletionImpact contains the exact operational summary returned before and
// after a permanent purge. OpenBalanceMinor uses the group's smallest currency
// unit and the ledger sign convention: positive amounts are owed to the group
// and negative amounts are member credit.
type DeletionImpact struct {
	GroupID              string `json:"groupId"`
	GroupName            string `json:"groupName"`
	Currency             string `json:"currency"`
	Version              int64  `json:"version"`
	MemberCount          int64  `json:"memberCount"`
	OpenBalanceMinor     int64  `json:"openBalanceMinor,string"`
	InvitationCount      int64  `json:"invitationCount"`
	BookingCount         int64  `json:"bookingCount"`
	FinancialRecordCount int64  `json:"financialRecordCount"`
	AuditEventCount      int64  `json:"auditEventCount"`
	MediaCount           int64  `json:"mediaCount"`
}

// AccountSummary is the non-sensitive account projection available when a
// system administrator chooses an initial group administrator.
type AccountSummary struct {
	ID          string `json:"id"`
	Email       string `json:"email"`
	DisplayName string `json:"displayName"`
	Active      bool   `json:"active"`
}

// CreateGroupInput describes an instance-managed group and its required first
// administrator identity. A matching active account activates immediately;
// otherwise a protected invitation leaves the group in PROVISIONING.
type CreateGroupInput struct {
	Name                      string `json:"name"`
	Currency                  string `json:"currency"`
	InitialAdministratorEmail string `json:"initialAdministratorEmail"`
}

// PurgeGroupInput carries the version and exact-name confirmation required for
// permanent deletion of an archived group.
type PurgeGroupInput struct {
	ExpectedVersion int64  `json:"-"`
	GroupName       string `json:"groupName"`
}

// PurgePostCommitWarning reports maintenance work that remains after the
// irreversible database purge committed successfully. Callers must treat the
// group deletion as successful; the durable checkpoint state is retried by the
// background maintenance worker.
type PurgePostCommitWarning struct {
	Cause error
}

// Error describes the deferred post-commit maintenance failure.
func (warning *PurgePostCommitWarning) Error() string {
	return fmt.Sprintf("group was purged; WAL checkpoint remains pending: %v", warning.Cause)
}

// Unwrap exposes the underlying checkpoint error for diagnostics.
func (warning *PurgePostCommitWarning) Unwrap() error { return warning.Cause }

// SearchAccounts returns at most limit active accounts matching email or
// display name. actorUserID must remain a live system administrator.
func (s Service) SearchAccounts(ctx context.Context, actorUserID, query string, limit int) ([]AccountSummary, error) {
	if err := s.RequireAdministrator(ctx, actorUserID); err != nil {
		return nil, err
	}
	query = strings.TrimSpace(query)
	if limit < 1 || limit > 100 {
		limit = 25
	}
	rows, err := s.db.QueryContext(ctx, `SELECT id,email,display_name,active FROM users
		WHERE email IS NOT NULL AND (?='' OR email LIKE '%'||?||'%' COLLATE NOCASE OR display_name LIKE '%'||?||'%' COLLATE NOCASE)
		ORDER BY active DESC,lower(email),id LIMIT ?`, query, query, query, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]AccountSummary, 0)
	for rows.Next() {
		var item AccountSummary
		if err := rows.Scan(&item.ID, &item.Email, &item.DisplayName, &item.Active); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

// ListGroups returns all groups with safe aggregate impact counters. It grants
// no access to the underlying group-scoped business data.
func (s Service) ListGroups(ctx context.Context, actorUserID string) ([]ManagedGroup, error) {
	if err := s.RequireAdministrator(ctx, actorUserID); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, managedGroupQuery+` ORDER BY lower(g.name),g.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]ManagedGroup, 0)
	for rows.Next() {
		item, err := scanManagedGroup(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

// GetDeletionImpact returns current purge counts for one group without exposing
// its contents. The group may be in any lifecycle status.
func (s Service) GetDeletionImpact(ctx context.Context, actorUserID, groupID string) (DeletionImpact, error) {
	if err := s.RequireAdministrator(ctx, actorUserID); err != nil {
		return DeletionImpact{}, err
	}
	row := s.db.QueryRowContext(ctx, managedGroupQuery+` WHERE g.id=?`, strings.TrimSpace(groupID))
	item, err := scanManagedGroup(row)
	if errors.Is(err, sql.ErrNoRows) {
		return DeletionImpact{}, domain.ErrNotFound
	}
	if err != nil {
		return DeletionImpact{}, err
	}
	return deletionImpact(item), nil
}

const managedGroupQuery = `SELECT g.id,g.name,g.currency,g.status,g.version,g.archived_at,g.archived_by,
	coalesce(
		(SELECT invitation.email FROM invitations invitation
		 JOIN invitation_role_assignments assignment ON assignment.group_id=invitation.group_id AND assignment.invitation_id=invitation.id
		 JOIN roles role ON role.group_id=assignment.group_id AND role.id=assignment.role_id AND role.preset_key='GROUP_ADMINISTRATOR'
		 WHERE invitation.group_id=g.id ORDER BY invitation.revoked_at IS NULL DESC,invitation.created_at DESC LIMIT 1),
		(SELECT user.email FROM memberships membership
		 JOIN users user ON user.id=membership.user_id
		 JOIN membership_role_assignments assignment ON assignment.group_id=membership.group_id AND assignment.membership_id=membership.id
		 JOIN roles role ON role.group_id=assignment.group_id AND role.id=assignment.role_id AND role.preset_key='GROUP_ADMINISTRATOR'
		 WHERE membership.group_id=g.id ORDER BY membership.status='ACTIVE' DESC,membership.joined_at,membership.id LIMIT 1)
	),g.created_at,
	CASE WHEN g.logo_key IS NOT NULL THEN '/api/v1/system/groups/'||g.id||'/logo' ELSE '' END,
	(SELECT count(*) FROM memberships m WHERE m.group_id=g.id),
	(SELECT count(*) FROM invitations i WHERE i.group_id=g.id),
	(SELECT count(*) FROM bookings b WHERE b.group_id=g.id),
	(SELECT count(*) FROM ledger_entries l WHERE l.group_id=g.id) +
	(SELECT count(*) FROM payments p WHERE p.group_id=g.id) +
	(SELECT count(*) FROM payment_attachments attachment WHERE attachment.group_id=g.id) +
	(SELECT count(*) FROM payment_allocations a WHERE a.group_id=g.id) +
	(SELECT count(*) FROM period_adjustment_allocations a WHERE a.group_id=g.id) +
	(SELECT count(*) FROM period_statements statement WHERE statement.group_id=g.id),
	(SELECT count(*) FROM audit_events a WHERE a.group_id=g.id),
	(SELECT count(DISTINCT image_key) FROM (
		SELECT logo_key AS image_key FROM groups WHERE id=g.id AND logo_key IS NOT NULL
		UNION ALL SELECT image_key FROM products WHERE group_id=g.id AND image_key IS NOT NULL
		UNION ALL SELECT storage_key FROM payment_attachments WHERE group_id=g.id
	)),
	(SELECT coalesce(sum(l.amount_minor),0) FROM ledger_entries l
		WHERE l.group_id=g.id AND l.account='MEMBER_RECEIVABLE')
	FROM groups g`

type rowScanner interface {
	Scan(...any) error
}

func scanManagedGroup(row rowScanner) (ManagedGroup, error) {
	var item ManagedGroup
	err := row.Scan(&item.ID, &item.Name, &item.Currency, &item.Status, &item.Version,
		&item.ArchivedAt, &item.ArchivedByUserID, &item.AdministratorEmail, &item.CreatedAt,
		&item.LogoURL, &item.MemberCount, &item.InvitationCount, &item.BookingCount, &item.FinancialRecordCount,
		&item.AuditEventCount, &item.MediaCount, &item.OpenBalanceMinor)
	return item, err
}

func deletionImpact(item ManagedGroup) DeletionImpact {
	return DeletionImpact{
		GroupID: item.ID, GroupName: item.Name, Currency: item.Currency, Version: item.Version,
		MemberCount: item.MemberCount, OpenBalanceMinor: item.OpenBalanceMinor, InvitationCount: item.InvitationCount,
		BookingCount: item.BookingCount, FinancialRecordCount: item.FinancialRecordCount,
		AuditEventCount: item.AuditEventCount, MediaCount: item.MediaCount,
	}
}

// CreateGroup creates an ACTIVE group for an existing account or a
// PROVISIONING group plus protected first-administrator invitation for a new
// address. The immediate provisioning result contains the one-time token for
// manual sharing; active SMTP additionally uses sealer for queued email delivery.
func (s Service) CreateGroup(ctx context.Context, actorUserID string, input CreateGroupInput, sealer SecretSealer) (ManagedGroup, error) {
	if err := s.RequireAdministrator(ctx, actorUserID); err != nil {
		return ManagedGroup{}, err
	}
	input.Name = strings.TrimSpace(input.Name)
	input.Currency = strings.ToUpper(strings.TrimSpace(input.Currency))
	email, err := platform.NormalizeEmail(input.InitialAdministratorEmail)
	if err != nil {
		return ManagedGroup{}, domain.ValidationError{Field: "initialAdministratorEmail", Message: "must be a valid email address"}
	}
	if err := validateInstanceName(input.Name); err != nil {
		return ManagedGroup{}, domain.ValidationError{Field: "name", Message: "must contain 1 to 120 characters without control characters"}
	}
	if err := validateCurrency(input.Currency); err != nil {
		return ManagedGroup{}, domain.ValidationError{Field: "currency", Message: "must be a three-letter currency code"}
	}
	var targetUserID string
	err = s.db.QueryRowContext(ctx, `SELECT id FROM users WHERE email=? COLLATE NOCASE AND active=1`, email).Scan(&targetUserID)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return ManagedGroup{}, err
	}
	provisioning := errors.Is(err, sql.ErrNoRows)
	var invitationToken, invitationCiphertext string
	emailDeliveryStatus := InvitationEmailDeliveryNotRequested
	queueInvitationEmail := false
	if provisioning {
		settings, settingsErr := s.GetSettings(ctx)
		if settingsErr != nil {
			return ManagedGroup{}, settingsErr
		}
		invitationToken, err = platform.NewSecret()
		if err != nil {
			return ManagedGroup{}, err
		}
		if settings.SMTP.Active && sealer != nil {
			invitationCiphertext, err = sealer.Seal(invitationToken)
			if err != nil {
				return ManagedGroup{}, fmt.Errorf("seal provisioning invitation: %w", err)
			}
			queueInvitationEmail = true
			emailDeliveryStatus = InvitationEmailDeliveryPending
		}
	}
	groupID, _ := platform.NewID("grp")
	periodID, _ := platform.NewID("per")
	nowValue := platform.Now()
	now := platform.Timestamp(nowValue)
	invitationExpiresAt := ""
	if provisioning {
		invitationExpiresAt = platform.Timestamp(nowValue.Add(7 * 24 * time.Hour))
	}
	status := GroupStatusActive
	if provisioning {
		status = GroupStatusProvisioning
	}
	err = storage.WithTx(ctx, s.db, func(tx *sql.Tx) error {
		if err := requireAdministratorTx(ctx, tx, actorUserID); err != nil {
			return err
		}
		var currentTargetUserID string
		lookupErr := tx.QueryRowContext(ctx, `SELECT id FROM users WHERE email=? COLLATE NOCASE AND active=1`, email).Scan(&currentTargetUserID)
		if lookupErr != nil && !errors.Is(lookupErr, sql.ErrNoRows) {
			return lookupErr
		}
		if provisioning && lookupErr == nil || !provisioning && (errors.Is(lookupErr, sql.ErrNoRows) || currentTargetUserID != targetUserID) {
			return fmt.Errorf("%w: initial administrator account changed; retry group creation", domain.ErrConflict)
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO groups(id,name,currency,status,created_at,updated_at) VALUES(?,?,?,?,?,?)`, groupID, input.Name, input.Currency, status, now, now); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO group_settings(group_id,members_can_view_all_bookings,default_role_id,updated_at) VALUES(?,0,?,?)`, groupID, authorization.GuestRoleID(groupID), now); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO periods(id,group_id,label,status,starts_at,created_at) VALUES(?,?,?,'OPEN',?,?)`, periodID, groupID, domain.DefaultOpenPeriodLabel, now, now); err != nil {
			return err
		}
		if provisioning {
			invitationID, _ := platform.NewID("inv")
			if _, err := tx.ExecContext(ctx, `INSERT INTO invitations(id,group_id,email,token_hash,expires_at,created_by,created_at,target_user_id) VALUES(?,?,?,?,?,?,?,NULL)`, invitationID, groupID, email, platform.HashSecret(invitationToken), invitationExpiresAt, actorUserID, now); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO invitation_role_assignments(group_id,invitation_id,role_id,version,assigned_at,assigned_by) VALUES(?,?,?,1,?,?)`, groupID, invitationID, authorization.PresetRoleID(groupID, domain.RolePresetGroupAdministrator), now, actorUserID); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `DELETE FROM invitation_role_assignments WHERE group_id=? AND invitation_id=? AND role_id!=?`, groupID, invitationID, authorization.PresetRoleID(groupID, domain.RolePresetGroupAdministrator)); err != nil {
				return err
			}
			if queueInvitationEmail {
				if _, err := tx.ExecContext(ctx, `INSERT INTO invitation_email_outbox(invitation_id,group_id,token_ciphertext,status,attempt_count,next_attempt_at,created_at,updated_at) VALUES(?,?,?,'PENDING',0,?,?,?)`, invitationID, groupID, invitationCiphertext, now, now, now); err != nil {
					return err
				}
			}
		} else {
			membershipID, _ := platform.NewID("mem")
			if _, err := tx.ExecContext(ctx, `INSERT INTO memberships(id,group_id,user_id,status,joined_at) VALUES(?,?,?,'ACTIVE',?)`, membershipID, groupID, targetUserID, now); err != nil {
				return err
			}
			administratorRoleID := authorization.PresetRoleID(groupID, domain.RolePresetGroupAdministrator)
			if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO membership_role_assignments(group_id,membership_id,role_id,version,assigned_at,assigned_by) VALUES(?,?,?,1,?,?)`, groupID, membershipID, administratorRoleID, now, actorUserID); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `DELETE FROM membership_role_assignments WHERE group_id=? AND membership_id=? AND role_id!=?`, groupID, membershipID, administratorRoleID); err != nil {
				return err
			}
		}
		if err := audit.Record(ctx, tx, groupID, actorUserID, "", "group.created.by_system_administrator", "group", groupID, map[string]any{"status": status, "initialAdministratorEmail": email}); err != nil {
			return err
		}
		return RecordAudit(ctx, tx, actorUserID, "system.group.created", "group", groupID, map[string]any{"name": input.Name, "status": status})
	})
	if err != nil {
		return ManagedGroup{}, fmt.Errorf("create system group: %w", err)
	}
	item, err := s.managedGroupByID(ctx, groupID)
	if err != nil {
		return ManagedGroup{}, err
	}
	item.InvitationToken = invitationToken
	item.InvitationEmailDeliveryStatus = emailDeliveryStatus
	item.InvitationExpiresAt = invitationExpiresAt
	return item, nil
}

// ResendProvisioningInvitation replaces the current first-administrator token
// with a fresh seven-day invitation for a PROVISIONING group and returns that
// token once for manual sharing. Active SMTP additionally queues encrypted
// email delivery. The old token and pending job are invalidated atomically.
func (s Service) ResendProvisioningInvitation(ctx context.Context, actorUserID, groupID string, expectedVersion int64, sealer SecretSealer) (ManagedGroup, error) {
	if err := s.RequireAdministrator(ctx, actorUserID); err != nil {
		return ManagedGroup{}, err
	}
	if expectedVersion < 1 {
		return ManagedGroup{}, domain.ErrPrecondition
	}
	settings, err := s.GetSettings(ctx)
	if err != nil {
		return ManagedGroup{}, err
	}
	token, err := platform.NewSecret()
	if err != nil {
		return ManagedGroup{}, err
	}
	var ciphertext string
	emailDeliveryStatus := InvitationEmailDeliveryNotRequested
	queueInvitationEmail := false
	if settings.SMTP.Active && sealer != nil {
		ciphertext, err = sealer.Seal(token)
		if err != nil {
			return ManagedGroup{}, fmt.Errorf("seal provisioning invitation: %w", err)
		}
		queueInvitationEmail = true
		emailDeliveryStatus = InvitationEmailDeliveryPending
	}
	nowValue := platform.Now()
	now := platform.Timestamp(nowValue)
	invitationExpiresAt := platform.Timestamp(nowValue.Add(7 * 24 * time.Hour))
	err = storage.WithTx(ctx, s.db, func(tx *sql.Tx) error {
		if err := requireAdministratorTx(ctx, tx, actorUserID); err != nil {
			return err
		}
		var name, email string
		var version int64
		if err := tx.QueryRowContext(ctx, `SELECT g.name,g.version,i.email FROM groups g
			JOIN invitations i ON i.group_id=g.id
			WHERE g.id=? AND g.status='PROVISIONING'
			ORDER BY i.created_at DESC,i.id DESC LIMIT 1`, groupID).Scan(&name, &version, &email); errors.Is(err, sql.ErrNoRows) {
			return domain.ErrNotFound
		} else if err != nil {
			return err
		}
		if version != expectedVersion {
			return domain.ErrPrecondition
		}
		if _, err := tx.ExecContext(ctx, `UPDATE invitations SET revoked_at=? WHERE group_id=? AND accepted_at IS NULL AND revoked_at IS NULL`, now, groupID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE invitation_email_outbox SET status='CANCELLED',token_ciphertext=NULL,next_attempt_at=NULL,lease_token=NULL,lease_until=NULL,last_error_code='invitation_replaced',updated_at=? WHERE group_id=? AND status IN ('PENDING','SENDING','FAILED')`, now, groupID); err != nil {
			return err
		}
		var targetUserID sql.NullString
		if err := tx.QueryRowContext(ctx, `SELECT id FROM users
			WHERE email=? COLLATE NOCASE AND active=1 AND email IS NOT NULL AND password_hash IS NOT NULL`, email).Scan(&targetUserID); err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		invitationID, _ := platform.NewID("inv")
		if _, err := tx.ExecContext(ctx, `INSERT INTO invitations(id,group_id,email,token_hash,expires_at,created_by,created_at,target_user_id) VALUES(?,?,?,?,?,?,?,?)`, invitationID, groupID, email, platform.HashSecret(token), invitationExpiresAt, actorUserID, now, targetUserID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO invitation_role_assignments(group_id,invitation_id,role_id,version,assigned_at,assigned_by) VALUES(?,?,?,1,?,?)`, groupID, invitationID, authorization.PresetRoleID(groupID, domain.RolePresetGroupAdministrator), now, actorUserID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM invitation_role_assignments WHERE group_id=? AND invitation_id=? AND role_id!=?`, groupID, invitationID, authorization.PresetRoleID(groupID, domain.RolePresetGroupAdministrator)); err != nil {
			return err
		}
		if queueInvitationEmail {
			if _, err := tx.ExecContext(ctx, `INSERT INTO invitation_email_outbox(invitation_id,group_id,token_ciphertext,status,attempt_count,next_attempt_at,created_at,updated_at) VALUES(?,?,?,'PENDING',0,?,?,?)`, invitationID, groupID, ciphertext, now, now, now); err != nil {
				return err
			}
		}
		updated, err := tx.ExecContext(ctx, `UPDATE groups SET version=version+1,updated_at=? WHERE id=? AND status='PROVISIONING' AND version=?`, now, groupID, version)
		if err != nil {
			return err
		}
		if changed, _ := updated.RowsAffected(); changed != 1 {
			return domain.ErrPrecondition
		}
		if err := audit.Record(ctx, tx, groupID, actorUserID, "", "group.provisioning_invitation.replaced", "invitation", invitationID, map[string]any{}); err != nil {
			return err
		}
		return RecordAudit(ctx, tx, actorUserID, "system.group.provisioning_invitation_replaced", "group", groupID, map[string]any{"name": name})
	})
	if err != nil {
		return ManagedGroup{}, err
	}
	item, err := s.managedGroupByID(ctx, groupID)
	if err != nil {
		return ManagedGroup{}, err
	}
	item.InvitationToken = token
	item.InvitationEmailDeliveryStatus = emailDeliveryStatus
	item.InvitationExpiresAt = invitationExpiresAt
	return item, nil
}

// ArchiveGroup makes an ACTIVE or PROVISIONING group inaccessible and
// invalidates every external onboarding path and pending email job. expected
// version is mandatory and checked transactionally.
func (s Service) ArchiveGroup(ctx context.Context, actorUserID, groupID string, expectedVersion int64) (ManagedGroup, error) {
	if err := s.RequireAdministrator(ctx, actorUserID); err != nil {
		return ManagedGroup{}, err
	}
	if expectedVersion < 1 {
		return ManagedGroup{}, domain.ErrPrecondition
	}
	now := platform.Timestamp(platform.Now())
	err := storage.WithTx(ctx, s.db, func(tx *sql.Tx) error {
		if err := requireAdministratorTx(ctx, tx, actorUserID); err != nil {
			return err
		}
		var name, status string
		var version int64
		if err := tx.QueryRowContext(ctx, `SELECT name,status,version FROM groups WHERE id=?`, groupID).Scan(&name, &status, &version); errors.Is(err, sql.ErrNoRows) {
			return domain.ErrNotFound
		} else if err != nil {
			return err
		}
		if version != expectedVersion {
			return domain.ErrPrecondition
		}
		if status != GroupStatusActive && status != GroupStatusProvisioning {
			return fmt.Errorf("%w: only active or provisioning groups can be archived", domain.ErrConflict)
		}
		if _, err := tx.ExecContext(ctx, `UPDATE groups SET status='ARCHIVED',archived_from_status=?,archived_at=?,archived_by=?,version=version+1,updated_at=? WHERE id=? AND version=?`, status, now, actorUserID, now, groupID, version); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE users SET default_group_id=NULL WHERE default_group_id=?`, groupID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE users SET last_used_group_id=NULL WHERE last_used_group_id=?`, groupID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE public_join_links SET enabled=0,version=version+1,updated_by=?,updated_at=? WHERE group_id=?`, actorUserID, now, groupID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE public_join_registrations SET invalidated_at=? WHERE group_id=? AND consumed_at IS NULL AND invalidated_at IS NULL`, now, groupID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE public_join_email_outbox SET status='CANCELLED',token_ciphertext=NULL,next_attempt_at=NULL,lease_token=NULL,lease_until=NULL,last_error_code='group_archived',updated_at=? WHERE group_id=? AND status IN ('PENDING','SENDING','FAILED')`, now, groupID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE invitations SET revoked_at=? WHERE group_id=? AND accepted_at IS NULL AND revoked_at IS NULL`, now, groupID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE invitation_email_outbox SET status='CANCELLED',token_ciphertext=NULL,next_attempt_at=NULL,lease_token=NULL,lease_until=NULL,last_error_code='group_archived',updated_at=? WHERE group_id=? AND status IN ('PENDING','SENDING','FAILED')`, now, groupID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE notification_delivery_jobs SET status='FAILED',next_attempt_at=NULL,lease_token=NULL,lease_until=NULL,last_error_code='group_archived',updated_at=? WHERE group_id=? AND status IN ('PENDING','SENDING')`, now, groupID); err != nil {
			return err
		}
		if err := audit.Record(ctx, tx, groupID, actorUserID, "", "group.archived.by_system_administrator", "group", groupID, map[string]any{"previousStatus": status}); err != nil {
			return err
		}
		return RecordAudit(ctx, tx, actorUserID, "system.group.archived", "group", groupID, map[string]any{"name": name, "previousStatus": status})
	})
	if err != nil {
		return ManagedGroup{}, err
	}
	return s.managedGroupByID(ctx, groupID)
}

// RestoreGroup returns an archived group to its pre-archive lifecycle status.
// Invalidated links, invitations, and email jobs deliberately stay disabled.
func (s Service) RestoreGroup(ctx context.Context, actorUserID, groupID string, expectedVersion int64) (ManagedGroup, error) {
	if err := s.RequireAdministrator(ctx, actorUserID); err != nil {
		return ManagedGroup{}, err
	}
	if expectedVersion < 1 {
		return ManagedGroup{}, domain.ErrPrecondition
	}
	err := storage.WithTx(ctx, s.db, func(tx *sql.Tx) error {
		if err := requireAdministratorTx(ctx, tx, actorUserID); err != nil {
			return err
		}
		var name, status, restoreStatus string
		var version int64
		if err := tx.QueryRowContext(ctx, `SELECT name,status,version,coalesce(archived_from_status,'') FROM groups WHERE id=?`, groupID).Scan(&name, &status, &version, &restoreStatus); errors.Is(err, sql.ErrNoRows) {
			return domain.ErrNotFound
		} else if err != nil {
			return err
		}
		if version != expectedVersion {
			return domain.ErrPrecondition
		}
		if status != GroupStatusArchived || (restoreStatus != GroupStatusActive && restoreStatus != GroupStatusProvisioning) {
			return fmt.Errorf("%w: only archived groups can be restored", domain.ErrConflict)
		}
		if _, err := tx.ExecContext(ctx, `UPDATE groups SET status=?,archived_from_status=NULL,archived_at=NULL,archived_by=NULL,version=version+1,updated_at=? WHERE id=? AND version=?`, restoreStatus, platform.Timestamp(platform.Now()), groupID, version); err != nil {
			return err
		}
		return RecordAudit(ctx, tx, actorUserID, "system.group.restored", "group", groupID, map[string]any{"name": name, "status": restoreStatus})
	})
	if err != nil {
		return ManagedGroup{}, err
	}
	return s.managedGroupByID(ctx, groupID)
}

// PurgeGroup permanently removes one archived group's managed database content,
// schedules unreferenced media cleanup, writes the minimal global receipt, and
// checkpoints the WAL. It requires a current version and exact group name.
func (s Service) PurgeGroup(ctx context.Context, actorUserID, groupID string, input PurgeGroupInput) (DeletionImpact, error) {
	return s.purgeGroup(ctx, actorUserID, groupID, input)
}

// PurgeGroupLocally permanently removes an archived group for a trusted local
// operator. It enforces the live system role, version, and exact name.
// Callers must identify the real operator account for immutable audit records.
func (s Service) PurgeGroupLocally(ctx context.Context, actorUserID, groupID string, input PurgeGroupInput) (DeletionImpact, error) {
	return s.purgeGroup(ctx, actorUserID, groupID, input)
}

func (s Service) purgeGroup(ctx context.Context, actorUserID, groupID string, input PurgeGroupInput) (DeletionImpact, error) {
	if err := s.RequireAdministrator(ctx, actorUserID); err != nil {
		return DeletionImpact{}, err
	}
	if input.ExpectedVersion < 1 {
		return DeletionImpact{}, domain.ErrPrecondition
	}
	connection, err := s.db.Conn(ctx)
	if err != nil {
		return DeletionImpact{}, err
	}
	defer connection.Close()
	if _, err := connection.ExecContext(ctx, `PRAGMA secure_delete=ON`); err != nil {
		return DeletionImpact{}, fmt.Errorf("enable secure deletion: %w", err)
	}
	tx, err := connection.BeginTx(ctx, nil)
	if err != nil {
		return DeletionImpact{}, err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `PRAGMA defer_foreign_keys=ON`); err != nil {
		return DeletionImpact{}, err
	}
	if err := requireAdministratorTx(ctx, tx, actorUserID); err != nil {
		return DeletionImpact{}, err
	}
	var item ManagedGroup
	item, err = scanManagedGroup(tx.QueryRowContext(ctx, managedGroupQuery+` WHERE g.id=?`, groupID))
	if errors.Is(err, sql.ErrNoRows) {
		return DeletionImpact{}, domain.ErrNotFound
	}
	if err != nil {
		return DeletionImpact{}, err
	}
	if item.Status != GroupStatusArchived {
		return DeletionImpact{}, fmt.Errorf("%w: only archived groups can be purged", domain.ErrConflict)
	}
	if item.Version != input.ExpectedVersion {
		return DeletionImpact{}, domain.ErrPrecondition
	}
	if input.GroupName != item.Name {
		return DeletionImpact{}, domain.ValidationError{Field: "groupName", Message: "must exactly match the current group name"}
	}
	now := platform.Timestamp(platform.Now())
	if _, err := tx.ExecContext(ctx, `UPDATE groups SET status='PURGING',version=version+1,updated_at=? WHERE id=? AND status='ARCHIVED' AND version=?`, now, groupID, item.Version); err != nil {
		return DeletionImpact{}, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO system_group_purge_context(group_id,actor_user_id,started_at) VALUES(?,?,?)`, groupID, actorUserID, now); err != nil {
		return DeletionImpact{}, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO system_media_delete_jobs(image_key,next_attempt_at,created_at,updated_at)
		SELECT image_key,?,?,? FROM (
			SELECT logo_key AS image_key FROM groups WHERE id=? AND logo_key IS NOT NULL
			UNION SELECT image_key FROM products WHERE group_id=? AND image_key IS NOT NULL
		) WHERE image_key IS NOT NULL
		ON CONFLICT(image_key) DO UPDATE SET status='PENDING',next_attempt_at=excluded.next_attempt_at,updated_at=excluded.updated_at`, now, now, now, groupID, groupID); err != nil {
		return DeletionImpact{}, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO system_attachment_delete_jobs(storage_key,next_attempt_at,created_at,updated_at)
		SELECT DISTINCT storage_key,?,?,? FROM payment_attachments WHERE group_id=?
		ON CONFLICT(storage_key) DO UPDATE SET status='PENDING',next_attempt_at=excluded.next_attempt_at,updated_at=excluded.updated_at`, now, now, now, groupID); err != nil {
		return DeletionImpact{}, err
	}
	deleteOrder := []string{
		"planning_notification_runs", "planning_notification_tasks", "planning_series_notification_tasks", "planning_participations", "planning_event_audience",
		"planning_event_target_roles", "planning_event_target_memberships", "planning_events",
		"planning_series_recipients", "planning_series_target_roles", "planning_series_target_memberships",
		"planning_series_cancelled_ranges", "planning_series_revisions", "planning_series", "group_planning_settings",
		"notification_reminder_runs", "notification_delivery_jobs", "invitation_email_outbox", "public_join_email_outbox",
		"notifications", "invitation_role_assignments", "invitations",
		"public_join_registrations", "public_join_links", "ledger_entries", "period_statements",
		"payment_allocations", "period_adjustment_allocations", "bookings", "payment_attachments", "payments",
		"audit_events", "idempotency_results", "category_permissions", "membership_permissions",
		"membership_notification_channels", "membership_role_assignments", "membership_roles", "group_reason_suggestions",
		"group_payment_methods", "group_notification_events", "group_notification_settings", "group_settings", "role_permission_grants", "roles",
		"products", "categories", "periods", "memberships",
	}
	for _, table := range deleteOrder {
		if _, err := tx.ExecContext(ctx, `DELETE FROM `+table+` WHERE group_id=?`, groupID); err != nil {
			return DeletionImpact{}, fmt.Errorf("purge %s: %w", table, err)
		}
	}
	// The permanent-deletion contract retains exactly one global receipt for the
	// group. Lifecycle events are useful before purge but would otherwise keep a
	// second identifying history after the group-owned audit trail is removed.
	if _, err := tx.ExecContext(ctx, `DELETE FROM system_audit_events WHERE resource_id=?`, groupID); err != nil {
		return DeletionImpact{}, fmt.Errorf("purge prior system audit events: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM groups WHERE id=?`, groupID); err != nil {
		return DeletionImpact{}, fmt.Errorf("purge group row: %w", err)
	}
	impact := deletionImpact(item)
	if err := RecordAudit(ctx, tx, actorUserID, "system.group.purged", "group_purge_receipt", groupID, map[string]any{
		"groupId": groupID, "groupName": item.Name, "purgedAt": now,
		"memberCount": impact.MemberCount, "openBalanceMinor": impact.OpenBalanceMinor, "currency": impact.Currency,
		"invitationCount": impact.InvitationCount,
		"bookingCount":    impact.BookingCount, "financialRecordCount": impact.FinancialRecordCount,
		"auditEventCount": impact.AuditEventCount, "mediaCount": impact.MediaCount,
	}); err != nil {
		return DeletionImpact{}, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE system_wal_checkpoint_state
		SET pending=1,last_error_code=NULL,updated_at=? WHERE singleton=1`, now); err != nil {
		return DeletionImpact{}, fmt.Errorf("schedule WAL checkpoint: %w", err)
	}
	rows, err := tx.QueryContext(ctx, `PRAGMA foreign_key_check`)
	if err != nil {
		return DeletionImpact{}, err
	}
	violated := rows.Next()
	if closeErr := rows.Close(); closeErr != nil {
		return DeletionImpact{}, closeErr
	}
	if violated {
		return DeletionImpact{}, errors.New("purge would violate foreign-key integrity")
	}
	if err := tx.Commit(); err != nil {
		return DeletionImpact{}, err
	}
	if checkpointErr := s.runPendingWALCheckpointOnConnection(ctx, connection); checkpointErr != nil {
		return impact, &PurgePostCommitWarning{Cause: checkpointErr}
	}
	return impact, nil
}

// RunPendingWALCheckpoint retries a durable post-purge WAL truncation. It is
// safe to call repeatedly; a no-op is returned when no purge checkpoint is
// pending. A busy SQLite checkpoint remains pending for a later attempt.
func (s Service) RunPendingWALCheckpoint(ctx context.Context) error {
	connection, err := s.db.Conn(ctx)
	if err != nil {
		return err
	}
	defer connection.Close()
	return s.runPendingWALCheckpointOnConnection(ctx, connection)
}

func (s Service) runPendingWALCheckpointOnConnection(ctx context.Context, connection *sql.Conn) error {
	var pending int
	if err := connection.QueryRowContext(ctx, `SELECT pending FROM system_wal_checkpoint_state WHERE singleton=1`).Scan(&pending); err != nil {
		return fmt.Errorf("load pending WAL checkpoint: %w", err)
	}
	if pending != 1 {
		return nil
	}
	var busy, logFrames, checkpointedFrames int
	if err := connection.QueryRowContext(ctx, `PRAGMA wal_checkpoint(TRUNCATE)`).Scan(&busy, &logFrames, &checkpointedFrames); err != nil {
		_, _ = connection.ExecContext(ctx, `UPDATE system_wal_checkpoint_state SET last_error_code='checkpoint_error',updated_at=? WHERE singleton=1`, platform.Timestamp(platform.Now()))
		return fmt.Errorf("truncate SQLite WAL: %w", err)
	}
	if busy != 0 {
		_, _ = connection.ExecContext(ctx, `UPDATE system_wal_checkpoint_state SET last_error_code='busy',updated_at=? WHERE singleton=1`, platform.Timestamp(platform.Now()))
		return fmt.Errorf("truncate SQLite WAL: database is busy (%d of %d frames checkpointed)", checkpointedFrames, logFrames)
	}
	if _, err := connection.ExecContext(ctx, `UPDATE system_wal_checkpoint_state SET pending=0,last_error_code=NULL,updated_at=? WHERE singleton=1`, platform.Timestamp(platform.Now())); err != nil {
		return fmt.Errorf("complete WAL checkpoint state: %w", err)
	}
	return nil
}

// RunMediaGarbageCollection processes at most limit durable image-delete jobs.
// Files are removed only when no group logo, product, or account avatar still
// references the content hash. Failures remain pending for retry.
func (s Service) RunMediaGarbageCollection(ctx context.Context, dataDirectory string, limit int) (int, error) {
	if limit < 1 || limit > 1000 {
		limit = 100
	}
	rows, err := s.db.QueryContext(ctx, `SELECT image_key FROM system_media_delete_jobs WHERE status='PENDING' AND next_attempt_at<=? ORDER BY next_attempt_at,image_key LIMIT ?`, platform.Timestamp(platform.Now()), limit)
	if err != nil {
		return 0, err
	}
	keys := make([]string, 0)
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			rows.Close()
			return 0, err
		}
		keys = append(keys, key)
	}
	if err := rows.Close(); err != nil {
		return 0, err
	}
	completed := 0
	for _, key := range keys {
		releaseImages := media.LockManagedImages()
		var references int64
		if err := s.db.QueryRowContext(ctx, `SELECT
			(SELECT count(*) FROM groups WHERE logo_key=?) +
			(SELECT count(*) FROM products WHERE image_key=?) +
			(SELECT count(*) FROM users WHERE avatar_key=?)`, key, key, key).Scan(&references); err != nil {
			releaseImages()
			return completed, err
		}
		if references > 0 {
			releaseImages()
			now := platform.Now()
			if _, err := s.db.ExecContext(ctx, `UPDATE system_media_delete_jobs SET status='PENDING',next_attempt_at=?,last_error_code='still_referenced',updated_at=? WHERE image_key=?`, platform.Timestamp(now.Add(referencedMediaRetryDelay)), platform.Timestamp(now), key); err != nil {
				return completed, err
			}
			continue
		}
		path, err := media.ResolveImage(dataDirectory, key)
		if err == nil {
			err = os.Remove(path)
		}
		releaseImages()
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			now := platform.Now()
			if _, updateErr := s.db.ExecContext(ctx, `UPDATE system_media_delete_jobs SET attempt_count=attempt_count+1,next_attempt_at=?,last_error_code='io_error',updated_at=? WHERE image_key=?`, platform.Timestamp(now.Add(5*time.Minute)), platform.Timestamp(now), key); updateErr != nil {
				return completed, errors.Join(err, updateErr)
			}
			continue
		}
		if _, err := s.db.ExecContext(ctx, `UPDATE system_media_delete_jobs SET status='DONE',last_error_code=NULL,updated_at=? WHERE image_key=?`, platform.Timestamp(platform.Now()), key); err != nil {
			return completed, err
		}
		completed++
	}
	attachmentCompleted, err := s.RunAttachmentGarbageCollection(ctx, dataDirectory, limit-completed)
	return completed + attachmentCompleted, err
}

// RunAttachmentGarbageCollection removes receipt files only after their last
// database reference disappears. Durable failures remain pending for retry.
func (s Service) RunAttachmentGarbageCollection(ctx context.Context, dataDirectory string, limit int) (int, error) {
	if limit < 1 {
		return 0, nil
	}
	if limit > 1000 {
		limit = 1000
	}
	rows, err := s.db.QueryContext(ctx, `SELECT storage_key FROM system_attachment_delete_jobs
		WHERE status='PENDING' AND next_attempt_at<=? ORDER BY next_attempt_at,storage_key LIMIT ?`, platform.Timestamp(platform.Now()), limit)
	if err != nil {
		return 0, err
	}
	keys := make([]string, 0)
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			rows.Close()
			return 0, err
		}
		keys = append(keys, key)
	}
	if err := rows.Close(); err != nil {
		return 0, err
	}
	store := paymentattachments.Store{DataDirectory: dataDirectory}
	completed := 0
	for _, key := range keys {
		release := paymentattachments.LockStore()
		var references int64
		if err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM payment_attachments WHERE storage_key=?`, key).Scan(&references); err != nil {
			release()
			return completed, err
		}
		if references > 0 {
			release()
			now := platform.Now()
			if _, err := s.db.ExecContext(ctx, `UPDATE system_attachment_delete_jobs SET next_attempt_at=?,last_error_code='still_referenced',updated_at=? WHERE storage_key=?`, platform.Timestamp(now.Add(referencedMediaRetryDelay)), platform.Timestamp(now), key); err != nil {
				return completed, err
			}
			continue
		}
		err := store.Remove(key)
		release()
		if err != nil {
			now := platform.Now()
			if _, updateErr := s.db.ExecContext(ctx, `UPDATE system_attachment_delete_jobs SET attempt_count=attempt_count+1,next_attempt_at=?,last_error_code='io_error',updated_at=? WHERE storage_key=?`, platform.Timestamp(now.Add(5*time.Minute)), platform.Timestamp(now), key); updateErr != nil {
				return completed, errors.Join(err, updateErr)
			}
			continue
		}
		if _, err := s.db.ExecContext(ctx, `UPDATE system_attachment_delete_jobs SET status='DONE',last_error_code=NULL,updated_at=? WHERE storage_key=?`, platform.Timestamp(platform.Now()), key); err != nil {
			return completed, err
		}
		completed++
	}
	if completed >= limit {
		return completed, nil
	}
	orphans, err := s.sweepUnreferencedAttachments(ctx, dataDirectory, limit-completed)
	return completed + orphans, err
}

func (s Service) sweepUnreferencedAttachments(ctx context.Context, dataDirectory string, limit int) (int, error) {
	directory := filepath.Join(dataDirectory, "attachments")
	entries, err := os.ReadDir(directory)
	if errors.Is(err, os.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	store := paymentattachments.Store{DataDirectory: dataDirectory}
	removed := 0
	for _, entry := range entries {
		if removed >= limit {
			break
		}
		if entry.IsDir() {
			continue
		}
		key := entry.Name()
		if _, err := store.Resolve(key); err != nil {
			continue
		}
		release := paymentattachments.LockStore()
		var references int64
		err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM payment_attachments WHERE storage_key=?`, key).Scan(&references)
		if err == nil && references == 0 {
			err = store.Remove(key)
		}
		release()
		if err != nil {
			return removed, err
		}
		if references == 0 {
			removed++
		}
	}
	return removed, nil
}

func (s Service) managedGroupByID(ctx context.Context, groupID string) (ManagedGroup, error) {
	item, err := scanManagedGroup(s.db.QueryRowContext(ctx, managedGroupQuery+` WHERE g.id=?`, groupID))
	if errors.Is(err, sql.ErrNoRows) {
		return ManagedGroup{}, domain.ErrNotFound
	}
	return item, err
}
