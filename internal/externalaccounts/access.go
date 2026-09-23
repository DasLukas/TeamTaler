package externalaccounts

import (
	"context"
	"database/sql"
	"errors"

	"github.com/DasLukas/TeamTaler/internal/authorization"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/platform"
)

func requireManualAccess(ctx context.Context, q dataQueryer, m domain.Membership, p domain.PermissionKey) error {
	if err := authorization.Require(ctx, q, m.GroupID, m.ID, p, authorization.GroupResource(m.GroupID)); err != nil {
		return err
	}
	var enabled int
	if err := q.QueryRowContext(ctx, `SELECT external_accounts_enabled FROM group_settings WHERE group_id=?`, m.GroupID).Scan(&enabled); errors.Is(err, sql.ErrNoRows) {
		return domain.ErrNotFound
	} else if err != nil {
		return err
	}
	if enabled != 1 {
		return ErrDisabled
	}
	return nil
}

func requireCollectionVersion(ctx context.Context, tx *sql.Tx, groupID string, expected int64) error {
	var current int64
	if err := tx.QueryRowContext(ctx, `SELECT external_accounts_version FROM group_settings WHERE group_id=?`, groupID).Scan(&current); err != nil {
		return err
	}
	if current != expected {
		return domain.ErrPrecondition
	}
	return nil
}

func bumpCollectionVersion(ctx context.Context, tx *sql.Tx, groupID string, expected int64) error {
	result, err := tx.ExecContext(ctx, `UPDATE group_settings SET external_accounts_version=external_accounts_version+1,updated_at=? WHERE group_id=? AND external_accounts_version=?`, platform.Timestamp(platform.Now()), groupID, expected)
	if err != nil {
		return err
	}
	if count, _ := result.RowsAffected(); count != 1 {
		return domain.ErrPrecondition
	}
	return nil
}
