package system

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"

	"github.com/DasLukas/TeamTaler/internal/platform"
)

// RecordAudit serializes metadata and appends an immutable instance-wide event
// using caller-owned tx. Empty actor and resource identifiers are persisted as
// NULL. It returns ID-generation, JSON, or SQL errors and never commits tx.
// Example: err := RecordAudit(ctx, tx, actorID, "system.settings.updated",
// "system_settings", "singleton", metadata).
func RecordAudit(ctx context.Context, tx *sql.Tx, actorUserID, action, resourceType, resourceID string, metadata any) error {
	id, err := platform.NewID("sya")
	if err != nil {
		return err
	}
	encoded, err := json.Marshal(metadata)
	if err != nil {
		return fmt.Errorf("encode system audit metadata: %w", err)
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO system_audit_events(
		id,actor_user_id,action,resource_type,resource_id,metadata_json,occurred_at
	) VALUES(?,nullif(?,''),?,?,nullif(?,''),?,?)`,
		id, actorUserID, action, resourceType, resourceID, string(encoded), platform.Timestamp(platform.Now()))
	if err != nil {
		return fmt.Errorf("record system audit event: %w", err)
	}
	return nil
}

// ListAudit returns at most limit newest-first immutable instance events and
// resolves each user actor to the account's current display name. An invalid
// limit uses the safe default of 100. Malformed legacy metadata is represented
// by {"decodeError": true}; query and scan failures are returned.
// Example: events, err := service.ListAudit(ctx, 50).
func (s Service) ListAudit(ctx context.Context, limit int) ([]AuditEvent, error) {
	if limit < 1 || limit > 200 {
		limit = 100
	}
	rows, err := s.db.QueryContext(ctx, `SELECT event.id,event.actor_user_id,
		coalesce(actor.display_name,''),event.action,event.resource_type,
		event.resource_id,event.metadata_json,event.occurred_at
		FROM system_audit_events event
		LEFT JOIN users actor ON actor.id=event.actor_user_id
		ORDER BY event.occurred_at DESC,event.id DESC LIMIT ?`, limit)
	if err != nil {
		return nil, fmt.Errorf("list system audit events: %w", err)
	}
	defer rows.Close()
	events := make([]AuditEvent, 0)
	for rows.Next() {
		var event AuditEvent
		var metadata string
		if err := rows.Scan(&event.ID, &event.ActorUserID, &event.ActorDisplayName, &event.Action, &event.ResourceType,
			&event.ResourceID, &metadata, &event.OccurredAt); err != nil {
			return nil, fmt.Errorf("scan system audit event: %w", err)
		}
		if err := json.Unmarshal([]byte(metadata), &event.Metadata); err != nil {
			event.Metadata = map[string]any{"decodeError": true}
		}
		events = append(events, event)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate system audit events: %w", err)
	}
	return events, nil
}
