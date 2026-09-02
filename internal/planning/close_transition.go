package planning

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/DasLukas/TeamTaler/internal/audit"
	"github.com/DasLukas/TeamTaler/internal/notifications"
	"github.com/DasLukas/TeamTaler/internal/platform"
)

type closeEventOptions struct {
	Now               time.Time
	GroupID           string
	ExpectedVersion   *int64
	RequireDue        bool
	ActorUserID       string
	ActorMembershipID string
	AuditAction       string
}

// closePublishedEventTx applies the complete close invariant for both manual
// commands and automatic deadline processing.
func closePublishedEventTx(ctx context.Context, tx *sql.Tx, eventID string, options closeEventOptions) (bool, error) {
	query := `SELECT event.group_id,event.event_type,event.capacity,event.confirmation_revision,event.version
		FROM planning_events event
		JOIN group_planning_settings settings ON settings.group_id=event.group_id AND settings.enabled=1
		JOIN groups group_row ON group_row.id=event.group_id AND group_row.status='ACTIVE'
		WHERE event.id=? AND event.status='PUBLISHED'`
	args := []any{eventID}
	if options.GroupID != "" {
		query += ` AND event.group_id=?`
		args = append(args, options.GroupID)
	}
	if options.ExpectedVersion != nil {
		query += ` AND event.version=?`
		args = append(args, *options.ExpectedVersion)
	}
	if options.RequireDue {
		query += ` AND event.event_type!='APPOINTMENT' AND event.response_deadline_us IS NOT NULL AND event.response_deadline_us<=?`
		args = append(args, options.Now.UTC().UnixMicro())
	}

	var groupID, eventType string
	var capacity sql.NullInt64
	var confirmationRevision, eventRevision int64
	err := tx.QueryRowContext(ctx, query, args...).Scan(&groupID, &eventType, &capacity, &confirmationRevision, &eventRevision)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}

	now := platform.Timestamp(options.Now)
	withdrawn := int64(0)
	invalidWaiters := int64(0)
	promotedIDs := []string{}
	if eventType == EventAppointmentRegistration {
		result, err := tx.ExecContext(ctx, `UPDATE planning_participations
			SET status='WITHDRAWN',waitlist_position=NULL,version=version+1,updated_at=?
			WHERE event_id=? AND status='REGISTERED' AND confirmed_revision<?`, now, eventID, confirmationRevision)
		if err != nil {
			return false, err
		}
		withdrawn, _ = result.RowsAffected()
		result, err = tx.ExecContext(ctx, `UPDATE planning_participations AS participation
			SET status='WITHDRAWN',waitlist_position=NULL,version=version+1,updated_at=?
			WHERE participation.group_id=? AND participation.event_id=? AND participation.status='WAITLISTED'
			  AND NOT EXISTS(SELECT 1 FROM memberships membership
				JOIN users recipient ON recipient.id=membership.user_id
				WHERE membership.group_id=participation.group_id AND membership.id=participation.membership_id
				  AND membership.status='ACTIVE' AND membership.deleted_at IS NULL AND recipient.active=1
				  AND recipient.email IS NOT NULL AND recipient.password_hash IS NOT NULL)`, now, groupID, eventID)
		if err != nil {
			return false, err
		}
		invalidWaiters, _ = result.RowsAffected()
		if capacity.Valid {
			var registered int64
			if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM planning_participations WHERE event_id=? AND status='REGISTERED'`, eventID).Scan(&registered); err != nil {
				return false, err
			}
			available := capacity.Int64 - registered
			if available > 0 {
				rows, err := tx.QueryContext(ctx, `SELECT membership_id FROM planning_participations
					WHERE event_id=? AND status='WAITLISTED'
					ORDER BY waitlist_position,membership_id LIMIT ?`, eventID, available)
				if err != nil {
					return false, err
				}
				for rows.Next() {
					var membershipID string
					if err := rows.Scan(&membershipID); err != nil {
						rows.Close()
						return false, err
					}
					promotedIDs = append(promotedIDs, membershipID)
				}
				if err := rows.Close(); err != nil {
					return false, err
				}
				for _, membershipID := range promotedIDs {
					if _, err := tx.ExecContext(ctx, `UPDATE planning_participations
						SET status='REGISTERED',waitlist_position=NULL,confirmed_revision=?,version=version+1,updated_at=?
						WHERE event_id=? AND membership_id=? AND status='WAITLISTED'`, confirmationRevision, now, eventID, membershipID); err != nil {
						return false, err
					}
				}
			}
		}
	}

	result, err := tx.ExecContext(ctx, `UPDATE planning_events SET status='CLOSED',closed_at=?,version=version+1,updated_at=?
		WHERE id=? AND group_id=? AND status='PUBLISHED' AND version=?`, now, now, eventID, groupID, eventRevision)
	if err != nil {
		return false, err
	}
	changed, _ := result.RowsAffected()
	if changed != 1 {
		return false, nil
	}
	finalRevision := eventRevision + 1
	for _, membershipID := range promotedIDs {
		if err := insertLifecycleTask(ctx, tx, groupID, eventID, membershipID, notifications.TypePlanningWaitlistPromoted, now, finalRevision); err != nil {
			return false, err
		}
	}
	if err := audit.Record(ctx, tx, groupID, options.ActorUserID, options.ActorMembershipID, options.AuditAction, "planning_event", eventID, map[string]any{
		"withdrawnRegistrations": withdrawn, "withdrawnInvalidWaitlistEntries": invalidWaiters, "promotedWaitlistEntries": len(promotedIDs),
	}); err != nil {
		return false, err
	}
	return true, nil
}
