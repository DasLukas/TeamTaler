// Package audit writes and queries immutable security and business audit events.
package audit

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/DasLukas/TeamTaler/internal/media"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/tablequery"
)

// Event is a durable, immutable record of a security-sensitive or financial
// state transition and its safe structured metadata.
type Event struct {
	ID                string         `json:"id"`
	GroupID           *string        `json:"groupId,omitempty"`
	ActorUserID       *string        `json:"actorUserId,omitempty"`
	ActorMembershipID *string        `json:"actorMembershipId,omitempty"`
	ActorDisplayName  string         `json:"actorDisplayName,omitempty"`
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
	page, err := Query(ctx, db, groupID, tablequery.AuditQuery{Limit: limit})
	return page.Items, err
}

// Page is one stable keyset-paginated group-audit slice. NextCursor is empty
// when no further matching event exists.
type Page struct {
	Items      []Event
	NextCursor string
}

// FilterOptions contains every action and resource type currently present in
// an authorized audit log, including persisted action-to-resource relationships
// and optional group-membership actors. Values are distinct and sorted.
type FilterOptions struct {
	Actions             []string            `json:"actions"`
	ResourceTypes       []string            `json:"resourceTypes"`
	ActionResourceTypes map[string][]string `json:"actionResourceTypes"`
	Actors              []ActorFilterOption `json:"actors,omitempty"`
}

// ActorFilterOption is a privacy-minimized group-membership actor identity
// present in an authorized audit scope.
type ActorFilterOption struct {
	MembershipID string `json:"membershipId"`
	DisplayName  string `json:"displayName"`
	AvatarURL    string `json:"avatarUrl,omitempty"`
}

// ScanFilterOptions consumes distinct action/resource-type pairs and builds a
// stable filter catalog. The caller transfers ownership of rows to this
// helper. It returns row scanning and iteration errors.
// Example: options, err := ScanFilterOptions(rows).
func ScanFilterOptions(rows *sql.Rows) (FilterOptions, error) {
	defer rows.Close()
	options := FilterOptions{
		Actions:             []string{},
		ResourceTypes:       []string{},
		ActionResourceTypes: map[string][]string{},
	}
	actions := map[string]struct{}{}
	resourceTypes := map[string]struct{}{}
	for rows.Next() {
		var action, resourceType string
		if err := rows.Scan(&action, &resourceType); err != nil {
			return FilterOptions{}, fmt.Errorf("scan audit filter relationship: %w", err)
		}
		actions[action] = struct{}{}
		resourceTypes[resourceType] = struct{}{}
		options.ActionResourceTypes[action] = append(options.ActionResourceTypes[action], resourceType)
	}
	if err := rows.Err(); err != nil {
		return FilterOptions{}, fmt.Errorf("iterate audit filter relationships: %w", err)
	}
	for action := range actions {
		options.Actions = append(options.Actions, action)
	}
	for resourceType := range resourceTypes {
		options.ResourceTypes = append(options.ResourceTypes, resourceType)
	}
	sortAuditFilterValues(options.Actions)
	sortAuditFilterValues(options.ResourceTypes)
	for action := range options.ActionResourceTypes {
		sortAuditFilterValues(options.ActionResourceTypes[action])
	}
	return options, nil
}

// sortAuditFilterValues sorts values case-insensitively with a stable tie-breaker.
func sortAuditFilterValues(values []string) {
	sort.Slice(values, func(left, right int) bool {
		leftFolded, rightFolded := strings.ToLower(values[left]), strings.ToLower(values[right])
		if leftFolded == rightFolded {
			return values[left] < values[right]
		}
		return leftFolded < rightFolded
	})
}

// ListFilterOptions returns the complete data-derived actor, action, and
// resource-type filter catalog for one group. Recording a new event makes its
// values available without a separate registry update.
func ListFilterOptions(ctx context.Context, db *sql.DB, groupID string) (FilterOptions, error) {
	rows, err := db.QueryContext(ctx, `SELECT DISTINCT action,resource_type
		FROM audit_events WHERE group_id=?`, groupID)
	if err != nil {
		return FilterOptions{}, fmt.Errorf("list audit filter options: %w", err)
	}
	options, err := ScanFilterOptions(rows)
	if err != nil {
		return FilterOptions{}, fmt.Errorf("list audit filter options: %w", err)
	}
	actorRows, err := db.QueryContext(ctx, `SELECT DISTINCT event.actor_membership_id,coalesce(actor.display_name,''),actor.id,coalesce(actor.avatar_key,'')
		FROM audit_events event
		JOIN users actor ON actor.id=event.actor_user_id
		WHERE event.group_id=? AND event.actor_membership_id IS NOT NULL
		ORDER BY lower(actor.display_name),event.actor_membership_id`, groupID)
	if err != nil {
		return FilterOptions{}, fmt.Errorf("list audit actor filter options: %w", err)
	}
	defer actorRows.Close()
	options.Actors = []ActorFilterOption{}
	for actorRows.Next() {
		var actor ActorFilterOption
		var userID, avatarKey string
		if err := actorRows.Scan(&actor.MembershipID, &actor.DisplayName, &userID, &avatarKey); err != nil {
			return FilterOptions{}, err
		}
		actor.AvatarURL = media.UserAvatarURL(userID, avatarKey)
		options.Actors = append(options.Actors, actor)
	}
	if err := actorRows.Err(); err != nil {
		return FilterOptions{}, err
	}
	return options, nil
}

// Query returns one filtered and sorted group-audit page. groupID is always
// applied as the first predicate so search, filters, and cursors cannot widen
// the authorized tenant scope.
func Query(ctx context.Context, db *sql.DB, groupID string, input tablequery.AuditQuery) (Page, error) {
	input, fingerprint, err := tablequery.NormalizeAudit(input, "group:"+groupID, true)
	if err != nil {
		return Page{}, err
	}
	cursorKey, cursorID, err := tablequery.DecodeCursor(input.Cursor, fingerprint, input.Sort, input.Direction)
	if err != nil {
		return Page{}, err
	}
	sortExpression := tablequery.AuditSortExpression(input.Sort)
	orderKeyword, comparison := tablequery.SQLOrderFragments(input.Direction)
	query := `SELECT event.id,event.group_id,event.actor_user_id,event.actor_membership_id,
		coalesce(actor.display_name,''),event.action,event.resource_type,event.resource_id,
		event.metadata_json,event.occurred_at,CAST(` + sortExpression + ` AS TEXT)
		FROM audit_events event
		LEFT JOIN users actor ON actor.id=event.actor_user_id
		WHERE event.group_id=?`
	args := []any{groupID}
	if input.ActorUserID != "" {
		query += ` AND event.actor_user_id=?`
		args = append(args, input.ActorUserID)
	}
	if input.ActorMembershipID != "" {
		query += ` AND event.actor_membership_id=?`
		args = append(args, input.ActorMembershipID)
	}
	query, args = tablequery.AppendExactStringSet(query, args, "event.action", input.Actions)
	query, args = tablequery.AppendExactStringSet(query, args, "event.resource_type", input.ResourceTypes)
	if input.OccurredFrom != "" {
		query += ` AND ` + tablequery.AuditOccurredSQLExpression + `>=?`
		args = append(args, input.OccurredFrom)
	}
	if input.OccurredTo != "" {
		query += ` AND ` + tablequery.AuditOccurredSQLExpression + `<?`
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
		query += ` AND (` + sortExpression + ` ` + comparison + ` ? OR (` + sortExpression + ` = ? AND event.id ` + comparison + ` ?))`
		args = append(args, cursorKey, cursorKey, cursorID)
	}
	query += ` ORDER BY ` + sortExpression + ` ` + orderKeyword + `,event.id ` + orderKeyword + ` LIMIT ?`
	args = append(args, input.Limit+1)
	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return Page{}, fmt.Errorf("list audit events: %w", err)
	}
	defer rows.Close()
	events := make([]Event, 0)
	sortKeys := make([]string, 0)
	for rows.Next() {
		var event Event
		var metadata, sortKey string
		if err := rows.Scan(&event.ID, &event.GroupID, &event.ActorUserID, &event.ActorMembershipID,
			&event.ActorDisplayName, &event.Action, &event.ResourceType, &event.ResourceID, &metadata, &event.OccurredAt, &sortKey); err != nil {
			return Page{}, err
		}
		if err := json.Unmarshal([]byte(metadata), &event.Metadata); err != nil {
			event.Metadata = map[string]any{"decodeError": true}
		}
		events = append(events, event)
		sortKeys = append(sortKeys, sortKey)
	}
	if err := rows.Err(); err != nil {
		return Page{}, err
	}
	page := Page{Items: events}
	if len(events) > input.Limit {
		page.Items = events[:input.Limit]
		last := page.Items[len(page.Items)-1]
		page.NextCursor, err = tablequery.EncodeCursor(fingerprint, input.Sort, input.Direction, sortKeys[input.Limit-1], last.ID)
		if err != nil {
			return Page{}, err
		}
	}
	return page, nil
}
