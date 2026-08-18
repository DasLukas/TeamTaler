package system

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/tablequery"
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
	page, err := s.QueryAudit(ctx, tablequery.AuditQuery{Limit: limit})
	return page.Items, err
}

// AuditPage is one stable keyset-paginated global audit slice. NextCursor is
// empty when no further matching event exists.
type AuditPage struct {
	Items      []AuditEvent
	NextCursor string
}

// QueryAudit returns one filtered and sorted global system-audit page. Callers
// must enforce system-administrator authorization before invoking this query.
func (s Service) QueryAudit(ctx context.Context, input tablequery.AuditQuery) (AuditPage, error) {
	input, fingerprint, err := tablequery.NormalizeAudit(input, "system", false)
	if err != nil {
		return AuditPage{}, err
	}
	cursorKey, cursorID, err := tablequery.DecodeCursor(input.Cursor, fingerprint, input.Sort, input.Direction)
	if err != nil {
		return AuditPage{}, err
	}
	occurredExpression := `strftime('%Y-%m-%dT%H:%M:%fZ',event.occurred_at)`
	sortExpressions := map[string]string{
		"occurredAt": occurredExpression, "actorName": "lower(coalesce(actor.display_name,''))",
		"action": "lower(event.action)", "resourceType": "lower(event.resource_type)",
	}
	sortExpression := sortExpressions[input.Sort]
	query := `SELECT event.id,event.actor_user_id,
		coalesce(actor.display_name,''),event.action,event.resource_type,
		event.resource_id,event.metadata_json,event.occurred_at,CAST(` + sortExpression + ` AS TEXT)
		FROM system_audit_events event
		LEFT JOIN users actor ON actor.id=event.actor_user_id
		WHERE 1=1`
	args := make([]any, 0)
	if input.ActorUserID != "" {
		query += ` AND event.actor_user_id=?`
		args = append(args, input.ActorUserID)
	}
	if input.Action != "" {
		query += ` AND event.action=?`
		args = append(args, input.Action)
	}
	if input.ResourceType != "" {
		query += ` AND event.resource_type=?`
		args = append(args, input.ResourceType)
	}
	if input.OccurredFrom != "" {
		query += ` AND ` + occurredExpression + `>=?`
		args = append(args, input.OccurredFrom)
	}
	if input.OccurredTo != "" {
		query += ` AND ` + occurredExpression + `<?`
		args = append(args, input.OccurredTo)
	}
	if input.Search != "" {
		pattern := tablequery.LikePattern(input.Search)
		query += ` AND (coalesce(actor.display_name,'') LIKE ? ESCAPE '\' COLLATE NOCASE
			OR event.action LIKE ? ESCAPE '\' COLLATE NOCASE
			OR event.resource_type LIKE ? ESCAPE '\' COLLATE NOCASE
			OR coalesce(event.resource_id,'') LIKE ? ESCAPE '\' COLLATE NOCASE
			OR event.metadata_json LIKE ? ESCAPE '\' COLLATE NOCASE)`
		args = append(args, pattern, pattern, pattern, pattern, pattern)
	}
	if cursorID != "" {
		comparison := ">"
		if input.Direction == "desc" {
			comparison = "<"
		}
		query += ` AND (` + sortExpression + ` ` + comparison + ` ? OR (` + sortExpression + ` = ? AND event.id ` + comparison + ` ?))`
		args = append(args, cursorKey, cursorKey, cursorID)
	}
	query += ` ORDER BY ` + sortExpression + ` ` + strings.ToUpper(input.Direction) + `,event.id ` + strings.ToUpper(input.Direction) + ` LIMIT ?`
	args = append(args, input.Limit+1)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return AuditPage{}, fmt.Errorf("list system audit events: %w", err)
	}
	defer rows.Close()
	events := make([]AuditEvent, 0)
	sortKeys := make([]string, 0)
	for rows.Next() {
		var event AuditEvent
		var metadata, sortKey string
		if err := rows.Scan(&event.ID, &event.ActorUserID, &event.ActorDisplayName, &event.Action, &event.ResourceType,
			&event.ResourceID, &metadata, &event.OccurredAt, &sortKey); err != nil {
			return AuditPage{}, fmt.Errorf("scan system audit event: %w", err)
		}
		if err := json.Unmarshal([]byte(metadata), &event.Metadata); err != nil {
			event.Metadata = map[string]any{"decodeError": true}
		}
		events = append(events, event)
		sortKeys = append(sortKeys, sortKey)
	}
	if err := rows.Err(); err != nil {
		return AuditPage{}, fmt.Errorf("iterate system audit events: %w", err)
	}
	page := AuditPage{Items: events}
	if len(events) > input.Limit {
		page.Items = events[:input.Limit]
		last := page.Items[len(page.Items)-1]
		page.NextCursor, err = tablequery.EncodeCursor(fingerprint, input.Sort, input.Direction, sortKeys[input.Limit-1], last.ID)
		if err != nil {
			return AuditPage{}, err
		}
	}
	return page, nil
}
