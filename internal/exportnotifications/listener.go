// Package exportnotifications connects durable data-export completions to the
// member-scoped in-app notification store without adding external delivery.
package exportnotifications

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/DasLukas/TeamTaler/internal/exporting"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

// Listener creates mandatory in-app-only notifications for completed raw-data
// export jobs. Deterministic notification IDs make callback retries idempotent;
// this integration never queues email or Web Push delivery.
type Listener struct {
	DB *sql.DB
}

// ExportCompleted records a READY or FAILED result for the requesting active
// membership. A membership that is no longer active receives no notification,
// while the callback still succeeds so revoked jobs do not retry forever.
//
// Example: listener.ExportCompleted(ctx, exporting.Completion{JobID: "exp_1",
// GroupID: "grp_1", MembershipID: "mem_1", Status: exporting.StatusReady}).
func (listener Listener) ExportCompleted(ctx context.Context, completion exporting.Completion) error {
	if listener.DB == nil {
		return errors.New("export completion listener requires a database")
	}
	if completion.JobID == "" || completion.GroupID == "" || completion.MembershipID == "" || completion.UserID == "" {
		return errors.New("export completion listener requires job, group, membership, and user identifiers")
	}
	eventType, title, body := "", "", ""
	switch completion.Status {
	case exporting.StatusReady:
		eventType, title, body = "DATA_EXPORT_READY", "Datenexport ist bereit", "Dein angeforderter Datenexport kann jetzt heruntergeladen werden."
	case exporting.StatusFailed:
		eventType, title, body = "DATA_EXPORT_FAILED", "Datenexport fehlgeschlagen", "Dein angeforderter Datenexport konnte nicht erstellt werden."
	default:
		return nil
	}
	digest := sha256.Sum256([]byte("export-completion:v1\n" + completion.JobID + "\n" + eventType))
	notificationID := "ntf_exp_" + hex.EncodeToString(digest[:16])
	contextJSON, err := json.Marshal(struct {
		AmountMinor string `json:"amountMinor"`
		ExportID    string `json:"exportId"`
		ExportScope string `json:"exportScope"`
	}{AmountMinor: "0", ExportID: completion.JobID, ExportScope: string(completion.Scope)})
	if err != nil {
		return fmt.Errorf("encode export notification context: %w", err)
	}
	createdAt := platform.Timestamp(platform.Now())
	return storage.WithTx(ctx, listener.DB, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO notifications(
			id,group_id,membership_id,type,title,body,resource_type,resource_id,context_json,created_at
		)
		SELECT ?,?,?,?,?,?,'EXPORT_JOB',?,?,?
		WHERE EXISTS (
			SELECT 1 FROM memberships membership
			JOIN groups group_record ON group_record.id=membership.group_id
			JOIN users user ON user.id=membership.user_id
			WHERE membership.id=? AND membership.group_id=? AND membership.user_id=?
			  AND membership.status='ACTIVE' AND membership.deleted_at IS NULL
			  AND group_record.status='ACTIVE' AND user.active=1
		)`, notificationID, completion.GroupID, completion.MembershipID, eventType, title, body,
			completion.JobID, string(contextJSON), createdAt,
			completion.MembershipID, completion.GroupID, completion.UserID)
		if err != nil {
			return fmt.Errorf("create export completion notification: %w", err)
		}
		return nil
	})
}
