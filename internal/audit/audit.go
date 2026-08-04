// Package audit writes and queries immutable security and business audit events.
package audit

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"

	"github.com/DasLukas/TeamTaler/internal/platform"
)

// Event is a durable, immutable record of a security-sensitive or financial
// state transition and its safe structured metadata.
type Event struct {
	ID                string         `json:"id"`
	GroupID           *string        `json:"groupId,omitempty"`
	ActorUserID       *string        `json:"actorUserId,omitempty"`
	ActorMembershipID *string        `json:"actorMembershipId,omitempty"`
	Action            string         `json:"action"`
	ResourceType      string         `json:"resourceType"`
	ResourceID        *string        `json:"resourceId,omitempty"`
	Metadata          map[string]any `json:"metadata"`
	OccurredAt        string         `json:"occurredAt"`
}

// Record serializes metadata and inserts an event using the caller-owned tx so
// the audit trail commits atomically with the transition. ctx bounds the write;
// identifiers may be empty only for intentionally global context. It returns
// randomness, JSON encoding, or SQL errors and never commits tx itself.
func Record(ctx context.Context, tx *sql.Tx, groupID, actorUserID, actorMembershipID, action, resourceType, resourceID string, metadata any) error {
	id, err := platform.NewID("aud")
	if err != nil {
		return err
	}
	encoded, err := json.Marshal(metadata)
	if err != nil {
		return fmt.Errorf("encode audit metadata: %w", err)
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO audit_events
		(id, group_id, actor_user_id, actor_membership_id, action, resource_type, resource_id, metadata_json, occurred_at)
		VALUES (?, nullif(?, ''), nullif(?, ''), nullif(?, ''), ?, ?, nullif(?, ''), ?, ?)`,
		id, groupID, actorUserID, actorMembershipID, action, resourceType, resourceID, string(encoded), platform.Timestamp(platform.Now()))
	if err != nil {
		return fmt.Errorf("record audit event: %w", err)
	}
	return nil
}

// List returns at most limit newest-first immutable events for groupID, using a
// safe default when limit is invalid. ctx bounds database access. It returns the
// events or query/scan errors; malformed legacy metadata is marked in-band.
func List(ctx context.Context, db *sql.DB, groupID string, limit int) ([]Event, error) {
	if limit < 1 || limit > 200 {
		limit = 100
	}
	rows, err := db.QueryContext(ctx, `SELECT id, group_id, actor_user_id, actor_membership_id,
		action, resource_type, resource_id, metadata_json, occurred_at
		FROM audit_events WHERE group_id = ? ORDER BY occurred_at DESC LIMIT ?`, groupID, limit)
	if err != nil {
		return nil, fmt.Errorf("list audit events: %w", err)
	}
	defer rows.Close()
	events := make([]Event, 0)
	for rows.Next() {
		var event Event
		var metadata string
		if err := rows.Scan(&event.ID, &event.GroupID, &event.ActorUserID, &event.ActorMembershipID,
			&event.Action, &event.ResourceType, &event.ResourceID, &metadata, &event.OccurredAt); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(metadata), &event.Metadata); err != nil {
			event.Metadata = map[string]any{"decodeError": true}
		}
		events = append(events, event)
	}
	return events, rows.Err()
}
