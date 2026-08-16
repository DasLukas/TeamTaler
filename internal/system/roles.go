package system

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

// HasRole checks one instance role against current database state and active
// account state. It returns false for an unknown/inactive account or absent
// assignment, and returns database errors separately.
func (s Service) HasRole(ctx context.Context, userID string, role Role) (bool, error) {
	if strings.TrimSpace(userID) == "" || role != RoleSystemAdministrator {
		return false, nil
	}
	var present int
	err := s.db.QueryRowContext(ctx, `SELECT EXISTS(
		SELECT 1 FROM system_role_assignments assignment
		JOIN users user ON user.id=assignment.user_id
		WHERE assignment.user_id=? AND assignment.role=? AND user.active=1
	)`, userID, role).Scan(&present)
	if err != nil {
		return false, fmt.Errorf("check system role: %w", err)
	}
	return present == 1, nil
}

// IsAdministrator reports whether userID currently has the active global
// SYSTEM_ADMINISTRATOR role. It returns database errors separately.
func (s Service) IsAdministrator(ctx context.Context, userID string) (bool, error) {
	return s.HasRole(ctx, userID, RoleSystemAdministrator)
}

// Require rejects callers whose current active account lacks role. It returns
// domain.ErrForbidden for unsupported or absent roles and database errors for
// failed live authorization checks.
func (s Service) Require(ctx context.Context, userID string, role Role) error {
	authorized, err := s.HasRole(ctx, userID, role)
	if err != nil {
		return err
	}
	if !authorized {
		return domain.ErrForbidden
	}
	return nil
}

// RequireAdministrator performs a live SYSTEM_ADMINISTRATOR authorization
// check. It returns domain.ErrForbidden when the active account is not assigned.
func (s Service) RequireAdministrator(ctx context.Context, userID string) error {
	return s.Require(ctx, userID, RoleSystemAdministrator)
}

// RolesForUser returns the current active account's instance roles in stable
// order. Unknown and inactive accounts produce an empty slice; database errors
// are returned. No group role is ever included.
func (s Service) RolesForUser(ctx context.Context, userID string) ([]Role, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT assignment.role
		FROM system_role_assignments assignment
		JOIN users user ON user.id=assignment.user_id AND user.active=1
		WHERE assignment.user_id=? ORDER BY assignment.role`, userID)
	if err != nil {
		return nil, fmt.Errorf("list user system roles: %w", err)
	}
	defer rows.Close()
	roles := make([]Role, 0)
	for rows.Next() {
		var role Role
		if err := rows.Scan(&role); err != nil {
			return nil, fmt.Errorf("scan user system role: %w", err)
		}
		roles = append(roles, role)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate user system roles: %w", err)
	}
	return roles, nil
}

// ListAdministrators returns all global administrator assignments, including
// assignments attached to inactive accounts, ordered by account identity. It
// returns query or scan errors.
func (s Service) ListAdministrators(ctx context.Context) ([]RoleAssignment, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT user.id,user.email,user.display_name,user.active,
		assignment.role,assignment.granted_at,assignment.granted_by_user_id
		FROM system_role_assignments assignment
		JOIN users user ON user.id=assignment.user_id
		WHERE assignment.role=?
		ORDER BY user.email COLLATE NOCASE,user.id`, RoleSystemAdministrator)
	if err != nil {
		return nil, fmt.Errorf("list system administrators: %w", err)
	}
	defer rows.Close()
	assignments := make([]RoleAssignment, 0)
	for rows.Next() {
		var assignment RoleAssignment
		if err := rows.Scan(&assignment.UserID, &assignment.Email, &assignment.DisplayName,
			&assignment.Active, &assignment.Role, &assignment.GrantedAt, &assignment.GrantedByUserID); err != nil {
			return nil, fmt.Errorf("scan system administrator: %w", err)
		}
		assignments = append(assignments, assignment)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate system administrators: %w", err)
	}
	return assignments, nil
}

// GrantAdministrator assigns SYSTEM_ADMINISTRATOR to one active stable user ID
// and records an immutable system event. grantedByUserID may be empty for a
// trusted local operator. It returns not-found, conflict, or storage errors.
func (s Service) GrantAdministrator(ctx context.Context, targetUserID, grantedByUserID string) (RoleAssignment, error) {
	var assignment RoleAssignment
	err := storage.WithTx(ctx, s.db, func(tx *sql.Tx) error {
		var err error
		assignment, err = GrantAdministratorInTx(ctx, tx, targetUserID, grantedByUserID)
		return err
	})
	return assignment, err
}

// GrantAdministratorByEmail resolves one active account by case-insensitive
// email and grants SYSTEM_ADMINISTRATOR. grantedByUserID may be empty for local
// CLI use. It returns not-found, conflict, validation, or storage errors.
func (s Service) GrantAdministratorByEmail(ctx context.Context, email, grantedByUserID string) (RoleAssignment, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	if email == "" || !strings.Contains(email, "@") || len(email) > 254 {
		return RoleAssignment{}, domain.ValidationError{Field: "email", Message: "must be a valid email address"}
	}
	var assignment RoleAssignment
	err := storage.WithTx(ctx, s.db, func(tx *sql.Tx) error {
		var targetUserID string
		err := tx.QueryRowContext(ctx, `SELECT id FROM users WHERE email=? COLLATE NOCASE AND active=1`, email).Scan(&targetUserID)
		if errors.Is(err, sql.ErrNoRows) {
			return domain.ErrNotFound
		}
		if err != nil {
			return fmt.Errorf("resolve system administrator account: %w", err)
		}
		assignment, err = GrantAdministratorInTx(ctx, tx, targetUserID, grantedByUserID)
		return err
	})
	return assignment, err
}

// GrantAdministratorInTx assigns SYSTEM_ADMINISTRATOR inside caller-owned tx.
// It is intended for atomic bootstrap and trusted local workflows. The target
// must be an active account; grantedByUserID may be empty. The function records
// a system audit event and never commits tx.
func GrantAdministratorInTx(ctx context.Context, tx *sql.Tx, targetUserID, grantedByUserID string) (RoleAssignment, error) {
	if tx == nil {
		return RoleAssignment{}, fmt.Errorf("system role transaction is required")
	}
	targetUserID = strings.TrimSpace(targetUserID)
	grantedByUserID = strings.TrimSpace(grantedByUserID)
	if targetUserID == "" {
		return RoleAssignment{}, domain.ValidationError{Field: "userId", Message: "is required"}
	}
	var assignment RoleAssignment
	assignment.UserID = targetUserID
	assignment.Role = RoleSystemAdministrator
	err := tx.QueryRowContext(ctx, `SELECT email,display_name,active FROM users WHERE id=?`, targetUserID).
		Scan(&assignment.Email, &assignment.DisplayName, &assignment.Active)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && !assignment.Active) {
		return RoleAssignment{}, domain.ErrNotFound
	}
	if err != nil {
		return RoleAssignment{}, fmt.Errorf("load system administrator account: %w", err)
	}
	assignment.GrantedAt = platform.Timestamp(platform.Now())
	if grantedByUserID != "" {
		assignment.GrantedByUserID = &grantedByUserID
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO system_role_assignments(
		user_id,role,granted_at,granted_by_user_id
	) VALUES(?,?,?,nullif(?,''))`, targetUserID, RoleSystemAdministrator, assignment.GrantedAt, grantedByUserID)
	if err != nil {
		if isUniqueConstraint(err) {
			return RoleAssignment{}, fmt.Errorf("%w: account is already a system administrator", domain.ErrConflict)
		}
		return RoleAssignment{}, fmt.Errorf("grant system administrator: %w", err)
	}
	if err := RecordAudit(ctx, tx, grantedByUserID, "system_administrator.granted", "user", targetUserID, map[string]any{
		"role": RoleSystemAdministrator,
	}); err != nil {
		return RoleAssignment{}, err
	}
	return assignment, nil
}

// RevokeAdministrator removes SYSTEM_ADMINISTRATOR from targetUserID and
// records an immutable system event. revokedByUserID may be empty for a trusted
// local operator. Removing the final administrator attached to an active
// account is rejected with domain.ErrConflict.
func (s Service) RevokeAdministrator(ctx context.Context, targetUserID, revokedByUserID string) error {
	targetUserID = strings.TrimSpace(targetUserID)
	revokedByUserID = strings.TrimSpace(revokedByUserID)
	if targetUserID == "" {
		return domain.ValidationError{Field: "userId", Message: "is required"}
	}
	return storage.WithTx(ctx, s.db, func(tx *sql.Tx) error {
		return revokeAdministratorInTx(ctx, tx, targetUserID, revokedByUserID)
	})
}

// RevokeAdministratorByEmail resolves one assigned account by case-insensitive
// email and revokes SYSTEM_ADMINISTRATOR. Inactive accounts are intentionally
// resolvable so stale assignments can be removed. revokedByUserID may be empty
// for local CLI use. It returns validation, not-found, conflict, or storage
// errors.
func (s Service) RevokeAdministratorByEmail(ctx context.Context, email, revokedByUserID string) error {
	email = strings.ToLower(strings.TrimSpace(email))
	if email == "" || !strings.Contains(email, "@") || len(email) > 254 {
		return domain.ValidationError{Field: "email", Message: "must be a valid email address"}
	}
	return storage.WithTx(ctx, s.db, func(tx *sql.Tx) error {
		var targetUserID string
		err := tx.QueryRowContext(ctx, `SELECT user.id FROM users user
			JOIN system_role_assignments assignment ON assignment.user_id=user.id AND assignment.role=?
			WHERE user.email=? COLLATE NOCASE`, RoleSystemAdministrator, email).Scan(&targetUserID)
		if errors.Is(err, sql.ErrNoRows) {
			return domain.ErrNotFound
		}
		if err != nil {
			return fmt.Errorf("resolve system administrator assignment: %w", err)
		}
		return revokeAdministratorInTx(ctx, tx, targetUserID, revokedByUserID)
	})
}

func revokeAdministratorInTx(ctx context.Context, tx *sql.Tx, targetUserID, revokedByUserID string) error {
	var targetActive bool
	err := tx.QueryRowContext(ctx, `SELECT user.active FROM system_role_assignments assignment
		JOIN users user ON user.id=assignment.user_id
		WHERE assignment.user_id=? AND assignment.role=?`, targetUserID, RoleSystemAdministrator).Scan(&targetActive)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("load system administrator assignment: %w", err)
	}
	if targetActive {
		var activeAdministrators int
		if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM system_role_assignments assignment
			JOIN users user ON user.id=assignment.user_id AND user.active=1
			WHERE assignment.role=?`, RoleSystemAdministrator).Scan(&activeAdministrators); err != nil {
			return fmt.Errorf("count active system administrators: %w", err)
		}
		if activeAdministrators <= 1 {
			return fmt.Errorf("%w: the final active system administrator cannot be revoked", domain.ErrConflict)
		}
	}
	result, err := tx.ExecContext(ctx, `DELETE FROM system_role_assignments WHERE user_id=? AND role=?`, targetUserID, RoleSystemAdministrator)
	if err != nil {
		return fmt.Errorf("revoke system administrator: %w", err)
	}
	if affected, err := result.RowsAffected(); err != nil || affected != 1 {
		if err != nil {
			return fmt.Errorf("count revoked system administrator: %w", err)
		}
		return domain.ErrNotFound
	}
	return RecordAudit(ctx, tx, revokedByUserID, "system_administrator.revoked", "user", targetUserID, map[string]any{
		"role": RoleSystemAdministrator,
	})
}

func requireAdministratorTx(ctx context.Context, tx *sql.Tx, userID string) error {
	var present int
	err := tx.QueryRowContext(ctx, `SELECT EXISTS(
		SELECT 1 FROM system_role_assignments assignment
		JOIN users user ON user.id=assignment.user_id
		WHERE assignment.user_id=? AND assignment.role=? AND user.active=1
	)`, userID, RoleSystemAdministrator).Scan(&present)
	if err != nil {
		return fmt.Errorf("revalidate system administrator: %w", err)
	}
	if present != 1 {
		return domain.ErrForbidden
	}
	return nil
}

func isUniqueConstraint(err error) bool {
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "unique constraint") || strings.Contains(message, "constraint failed") && strings.Contains(message, "primary key")
}
