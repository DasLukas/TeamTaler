// Package notifications provides member-scoped in-app notifications.
package notifications

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

// Service implements notification queries and read-state transitions over a
// migrated TeamTaler database.
type Service struct {
	// DB is the shared application database connection pool.
	DB *sql.DB
	// EmailDeliveryAvailable allows new notification email jobs to be queued.
	EmailDeliveryAvailable bool
	// PushDeliveryAvailable allows new notification push jobs to be queued when
	// no dynamic resolver was configured.
	PushDeliveryAvailable bool
	// ResolveChannelAvailability resolves the effective system channel gates in
	// the caller's business transaction. A nil resolver uses the static fields.
	ResolveChannelAvailability ChannelAvailabilityResolver
}

// ChannelAvailability is the effective instance-wide external delivery state.
// PushKeyID identifies the VAPID public key accepted by active subscriptions.
type ChannelAvailability struct {
	EmailAvailable bool   `json:"emailAvailable"`
	PushAvailable  bool   `json:"pushAvailable"`
	PushKeyID      string `json:"-"`
}

// ChannelAvailabilityResolver calculates instance channel gates using tx so
// event policy and job creation can share one consistent transaction.
type ChannelAvailabilityResolver func(context.Context, *sql.Tx) (ChannelAvailability, error)

const (
	// DeliveryCodeRecipientUnavailable identifies an inactive or inaccessible recipient.
	DeliveryCodeRecipientUnavailable = "recipient_unavailable"
	// DeliveryCodeEventDisabled identifies a group-disabled notification event.
	DeliveryCodeEventDisabled = "event_disabled"
	// DeliveryCodePreferenceDisabled identifies a channel disabled by the recipient.
	DeliveryCodePreferenceDisabled = "preference_disabled"
	// DeliveryCodePlanningDisabled identifies a disabled group planning module.
	DeliveryCodePlanningDisabled = "planning_disabled"
)

// EventContext contains safe, structured presentation data for one notification.
// Fields are optional because each event type requires only a relevant subset.
type EventContext struct {
	ActorName           string `json:"actorName,omitempty"`
	ItemName            string `json:"itemName,omitempty"`
	Quantity            int    `json:"quantity,omitempty"`
	AmountMinor         int64  `json:"amountMinor,string"`
	Currency            string `json:"currency,omitempty"`
	PeriodLabel         string `json:"periodLabel,omitempty"`
	DueAt               string `json:"dueAt,omitempty"`
	ExportID            string `json:"exportId,omitempty"`
	ExportScope         string `json:"exportScope,omitempty"`
	PlanningEventID     string `json:"planningEventId,omitempty"`
	PlanningEventTitle  string `json:"planningEventTitle,omitempty"`
	PlanningSeriesID    string `json:"planningSeriesId,omitempty"`
	PlanningSeriesTitle string `json:"planningSeriesTitle,omitempty"`
	PlanningStartsAt    string `json:"planningStartsAt,omitempty"`
	PlanningStatus      string `json:"planningStatus,omitempty"`
}

// CreateInput describes one member-visible event created inside an existing
// business transaction.
type CreateInput struct {
	GroupID      string
	MembershipID string
	Type         EventType
	Title        string
	Body         string
	ResourceType string
	ResourceID   string
	Context      EventContext
	CreatedAt    string
}

// Notification is a member-visible in-app event with a stable Type and optional
// link to the originating domain resource.
type Notification struct {
	ID           string       `json:"id"`
	GroupID      string       `json:"groupId"`
	Type         string       `json:"type"`
	Title        string       `json:"title"`
	Body         string       `json:"body"`
	ResourceType *string      `json:"resourceType,omitempty"`
	ResourceID   *string      `json:"resourceId,omitempty"`
	Context      EventContext `json:"context"`
	ReadAt       *string      `json:"readAt,omitempty"`
	CreatedAt    string       `json:"createdAt"`
}

// Page is a stable newest-first notification slice and its opaque continuation
// cursor. An empty NextCursor means the page is final.
type Page struct {
	Items      []Notification
	NextCursor string
}

// ReadResult summarizes one batch acknowledgement using a single server time.
type ReadResult struct {
	UnreadCount int64  `json:"unreadCount"`
	ReadAt      string `json:"readAt"`
}

// Destination identifies the active group that owns an opaque notification.
// It deliberately contains no notification content or membership identifier.
type Destination struct {
	GroupID string `json:"groupId"`
}

// CreateTx inserts the canonical in-app notification and independently queues
// eligible email and Web Push jobs in the same transaction. Group policy,
// member preferences, effective system gates, recipient state, and current
// subscriptions are evaluated before each external-channel job is inserted.
// The caller owns tx and therefore controls commit or rollback.
func (s Service) CreateTx(ctx context.Context, tx *sql.Tx, input CreateInput) (Notification, error) {
	if tx == nil {
		return Notification{}, errors.New("create notification: transaction is required")
	}
	input.GroupID = strings.TrimSpace(input.GroupID)
	input.MembershipID = strings.TrimSpace(input.MembershipID)
	input.Type = EventType(strings.TrimSpace(string(input.Type)))
	input.Title = strings.TrimSpace(input.Title)
	input.Body = strings.TrimSpace(input.Body)
	input.ResourceType = strings.TrimSpace(input.ResourceType)
	input.ResourceID = strings.TrimSpace(input.ResourceID)
	if input.GroupID == "" || input.MembershipID == "" || input.Type == "" || input.Title == "" || input.Body == "" || input.CreatedAt == "" {
		return Notification{}, errors.New("create notification: group, membership, type, copy, and timestamp are required")
	}
	definition, supported := Definition(input.Type)
	if !supported {
		return Notification{}, domain.ValidationError{Field: "type", Message: "contains an unsupported notification event"}
	}
	createdAt, err := time.Parse(time.RFC3339Nano, input.CreatedAt)
	if err != nil {
		return Notification{}, domain.ValidationError{Field: "createdAt", Message: "must be an RFC 3339 timestamp"}
	}
	var groupEnabled bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(
		SELECT 1 FROM group_notification_events WHERE group_id=? AND event_type=?
	)`, input.GroupID, input.Type).Scan(&groupEnabled); err != nil {
		return Notification{}, err
	}
	if !groupEnabled {
		return Notification{}, nil
	}
	if IsPlanningEvent(input.Type) {
		var planningEnabled bool
		if err := tx.QueryRowContext(ctx, `SELECT enabled FROM group_planning_settings WHERE group_id=?`, input.GroupID).Scan(&planningEnabled); err != nil {
			return Notification{}, err
		}
		if !planningEnabled {
			return Notification{}, nil
		}
	}
	contextJSON, err := json.Marshal(input.Context)
	if err != nil {
		return Notification{}, fmt.Errorf("encode notification context: %w", err)
	}
	notificationID, err := platform.NewID("ntf")
	if err != nil {
		return Notification{}, fmt.Errorf("create notification identifier: %w", err)
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO notifications(
		id,group_id,membership_id,type,title,body,resource_type,resource_id,context_json,created_at
	) VALUES(?,?,?,?,?,?,nullif(?,''),nullif(?,''),?,?)`, notificationID, input.GroupID, input.MembershipID, input.Type, input.Title, input.Body, input.ResourceType, input.ResourceID, string(contextJSON), input.CreatedAt)
	if err != nil {
		return Notification{}, err
	}
	availability := ChannelAvailability{EmailAvailable: s.EmailDeliveryAvailable, PushAvailable: s.PushDeliveryAvailable}
	if s.ResolveChannelAvailability != nil {
		availability, err = s.ResolveChannelAvailability(ctx, tx)
		if err != nil {
			return Notification{}, fmt.Errorf("resolve notification channel availability: %w", err)
		}
	}
	if availability.EmailAvailable {
		_, err = tx.ExecContext(ctx, `INSERT INTO notification_delivery_jobs(
			id,notification_id,group_id,channel,target_membership_id,status,attempt_count,next_attempt_at,created_at,updated_at
		)
		SELECT ?,?,?,? ,?,'PENDING',0,?,?,?
		WHERE EXISTS (
			SELECT 1 FROM membership_notification_channels preference
			JOIN memberships membership ON membership.group_id=preference.group_id AND membership.id=preference.membership_id
			JOIN users user ON user.id=membership.user_id
			WHERE preference.group_id=? AND preference.membership_id=? AND preference.event_type=? AND preference.channel='EMAIL'
			  AND membership.status='ACTIVE' AND membership.deleted_at IS NULL AND user.active=1 AND user.email IS NOT NULL
		)`, notificationID+"_email", notificationID, input.GroupID, ChannelEmail, input.MembershipID,
			input.CreatedAt, input.CreatedAt, input.CreatedAt, input.GroupID, input.MembershipID, input.Type)
		if err != nil {
			return Notification{}, err
		}
	}
	if availability.PushAvailable && strings.TrimSpace(availability.PushKeyID) != "" {
		expiresAt := platform.Timestamp(createdAt.UTC().Add(time.Duration(definition.PushTTLSeconds) * time.Second))
		_, err = tx.ExecContext(ctx, `INSERT INTO notification_delivery_jobs(
			id,notification_id,group_id,channel,push_subscription_id,status,attempt_count,next_attempt_at,expires_at,created_at,updated_at
		)
		SELECT ? || '_push_' || subscription.id,?,?,?,subscription.id,'PENDING',0,?,?,?,?
		FROM membership_notification_channels preference
		JOIN memberships membership ON membership.group_id=preference.group_id AND membership.id=preference.membership_id
		JOIN users user ON user.id=membership.user_id
		JOIN web_push_subscriptions subscription ON subscription.user_id=user.id
		WHERE preference.group_id=? AND preference.membership_id=? AND preference.event_type=? AND preference.channel='PUSH'
		  AND membership.status='ACTIVE' AND membership.deleted_at IS NULL AND user.active=1
		  AND subscription.revoked_at IS NULL AND subscription.vapid_key_id=?`,
			notificationID, notificationID, input.GroupID, ChannelPush, input.CreatedAt, expiresAt, input.CreatedAt, input.CreatedAt,
			input.GroupID, input.MembershipID, input.Type, availability.PushKeyID)
		if err != nil {
			return Notification{}, err
		}
	}
	item := Notification{ID: notificationID, GroupID: input.GroupID, Type: string(input.Type), Title: input.Title, Body: input.Body, Context: input.Context, CreatedAt: input.CreatedAt}
	if input.ResourceType != "" {
		item.ResourceType = &input.ResourceType
	}
	if input.ResourceID != "" {
		item.ResourceID = &input.ResourceID
	}
	return item, nil
}

// CheckDeliveryPolicy re-evaluates mutable group and member gates for one
// already queued external delivery. An empty code permits delivery; a non-empty
// safe code requires the dispatcher to terminate the job without external I/O.
func CheckDeliveryPolicy(ctx context.Context, db *sql.DB, jobID string, channel Channel) (string, error) {
	if db == nil || strings.TrimSpace(jobID) == "" {
		return "", errors.New("check notification delivery policy: database and job identifier are required")
	}
	if channel != ChannelEmail && channel != ChannelPush {
		return "", domain.ValidationError{Field: "channel", Message: "must be EMAIL or PUSH"}
	}
	var eventType EventType
	var recipientActive, groupActive, eventEnabled, preferenceEnabled bool
	err := db.QueryRowContext(ctx, `SELECT notification.type,
		membership.status='ACTIVE' AND membership.deleted_at IS NULL AND recipient.active=1
			AND (?!='EMAIL' OR recipient.email IS NOT NULL),
		group_row.status='ACTIVE',
		EXISTS(SELECT 1 FROM group_notification_events event WHERE event.group_id=job.group_id AND event.event_type=notification.type),
		EXISTS(SELECT 1 FROM membership_notification_channels preference
			WHERE preference.group_id=job.group_id AND preference.membership_id=notification.membership_id
			  AND preference.event_type=notification.type AND preference.channel=?)
		FROM notification_delivery_jobs job
		JOIN notifications notification ON notification.id=job.notification_id AND notification.group_id=job.group_id
		JOIN memberships membership ON membership.id=notification.membership_id AND membership.group_id=job.group_id
		JOIN users recipient ON recipient.id=membership.user_id
		JOIN groups group_row ON group_row.id=job.group_id
		WHERE job.id=? AND job.channel=?`, channel, channel, jobID, channel).
		Scan(&eventType, &recipientActive, &groupActive, &eventEnabled, &preferenceEnabled)
	if errors.Is(err, sql.ErrNoRows) {
		return DeliveryCodeRecipientUnavailable, nil
	}
	if err != nil {
		return "", err
	}
	if !recipientActive || !groupActive {
		return DeliveryCodeRecipientUnavailable, nil
	}
	if !eventEnabled {
		return DeliveryCodeEventDisabled, nil
	}
	if !preferenceEnabled {
		return DeliveryCodePreferenceDisabled, nil
	}
	if IsPlanningEvent(eventType) {
		var enabled bool
		if err := db.QueryRowContext(ctx, `SELECT enabled FROM group_planning_settings settings
			JOIN notification_delivery_jobs job ON job.group_id=settings.group_id
			WHERE job.id=?`, jobID).Scan(&enabled); errors.Is(err, sql.ErrNoRows) {
			return DeliveryCodePlanningDisabled, nil
		} else if err != nil {
			return "", err
		}
		if !enabled {
			return DeliveryCodePlanningDisabled, nil
		}
	}
	return "", nil
}

// List returns at most limit notifications newest first for membership only.
// ctx bounds the query; an empty slice is valid and SQL errors propagate.
func (s Service) List(ctx context.Context, membership domain.Membership, limit int) ([]Notification, error) {
	page, err := s.ListPage(ctx, membership, limit, "")
	return page.Items, err
}

// ListPage returns a stable newest-first page for membership. cursor is the ID
// returned by the preceding page and is resolved only inside the same tenant and
// membership. Invalid or inaccessible cursors return ErrNotFound.
func (s Service) ListPage(ctx context.Context, membership domain.Membership, limit int, cursor string) (Page, error) {
	if limit < 1 || limit > 200 {
		limit = 100
	}
	args := []any{membership.GroupID, membership.ID}
	query := `SELECT id,group_id,type,title,body,resource_type,resource_id,context_json,read_at,created_at
		FROM notifications WHERE group_id=? AND membership_id=?`
	cursor = strings.TrimSpace(cursor)
	if cursor != "" {
		var createdAt string
		if err := s.DB.QueryRowContext(ctx, `SELECT created_at FROM notifications WHERE id=? AND group_id=? AND membership_id=?`, cursor, membership.GroupID, membership.ID).Scan(&createdAt); errors.Is(err, sql.ErrNoRows) {
			return Page{}, domain.ErrNotFound
		} else if err != nil {
			return Page{}, err
		}
		query += ` AND (created_at < ? OR (created_at = ? AND id < ?))`
		args = append(args, createdAt, createdAt, cursor)
	}
	query += ` ORDER BY created_at DESC,id DESC LIMIT ?`
	args = append(args, limit+1)
	rows, err := s.DB.QueryContext(ctx, query, args...)
	if err != nil {
		return Page{}, err
	}
	defer rows.Close()
	result := make([]Notification, 0)
	for rows.Next() {
		var item Notification
		var contextJSON string
		if err := rows.Scan(&item.ID, &item.GroupID, &item.Type, &item.Title, &item.Body, &item.ResourceType, &item.ResourceID, &contextJSON, &item.ReadAt, &item.CreatedAt); err != nil {
			return Page{}, err
		}
		if err := json.Unmarshal([]byte(contextJSON), &item.Context); err != nil {
			return Page{}, fmt.Errorf("decode notification context: %w", err)
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return Page{}, err
	}
	page := Page{Items: result}
	if len(result) > limit {
		page.Items = result[:limit]
		page.NextCursor = page.Items[len(page.Items)-1].ID
	}
	return page, nil
}

// DestinationForUser resolves an opaque notification ID to its active group
// only when it belongs to a current active membership of userID. Unknown IDs,
// cross-account IDs, archived memberships, inactive users, and archived groups
// all return ErrNotFound so callers cannot distinguish inaccessible records.
func (s Service) DestinationForUser(ctx context.Context, userID, notificationID string) (Destination, error) {
	userID = strings.TrimSpace(userID)
	notificationID = strings.TrimSpace(notificationID)
	if userID == "" || notificationID == "" {
		return Destination{}, domain.ErrNotFound
	}
	var destination Destination
	err := s.DB.QueryRowContext(ctx, `SELECT notification.group_id
		FROM notifications notification
		JOIN memberships membership
		  ON membership.id=notification.membership_id AND membership.group_id=notification.group_id
		JOIN users recipient ON recipient.id=membership.user_id
		JOIN groups group_row ON group_row.id=notification.group_id
		WHERE notification.id=? AND membership.user_id=?
		  AND membership.status='ACTIVE' AND membership.deleted_at IS NULL
		  AND recipient.active=1 AND group_row.status='ACTIVE'`, notificationID, userID).
		Scan(&destination.GroupID)
	if errors.Is(err, sql.ErrNoRows) {
		return Destination{}, domain.ErrNotFound
	}
	return destination, err
}

// UnreadCount returns the exact unread notification count for membership.
func (s Service) UnreadCount(ctx context.Context, membership domain.Membership) (int64, error) {
	var count int64
	err := s.DB.QueryRowContext(ctx, `SELECT count(*) FROM notifications WHERE group_id=? AND membership_id=? AND read_at IS NULL`, membership.GroupID, membership.ID).Scan(&count)
	return count, err
}

// MarkReadMany idempotently acknowledges up to 100 visible notification IDs in
// membership's ownership scope and returns the remaining exact unread count.
// Unknown or inaccessible IDs are ignored to avoid disclosing their existence.
func (s Service) MarkReadMany(ctx context.Context, membership domain.Membership, notificationIDs []string) (ReadResult, error) {
	if len(notificationIDs) < 1 || len(notificationIDs) > 100 {
		return ReadResult{}, domain.ValidationError{Field: "notificationIds", Message: "must contain 1 to 100 identifiers"}
	}
	seen := make(map[string]struct{}, len(notificationIDs))
	placeholders := make([]string, 0, len(notificationIDs))
	args := make([]any, 0, len(notificationIDs)+3)
	readAt := platform.Timestamp(platform.Now())
	args = append(args, readAt, membership.GroupID, membership.ID)
	for _, rawID := range notificationIDs {
		id := strings.TrimSpace(rawID)
		if id == "" {
			return ReadResult{}, domain.ValidationError{Field: "notificationIds", Message: "must contain non-empty identifiers"}
		}
		if _, duplicate := seen[id]; duplicate {
			return ReadResult{}, domain.ValidationError{Field: "notificationIds", Message: "must contain unique identifiers"}
		}
		seen[id] = struct{}{}
		placeholders = append(placeholders, "?")
		args = append(args, id)
	}
	result := ReadResult{ReadAt: readAt}
	err := storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		query := `UPDATE notifications SET read_at=? WHERE group_id=? AND membership_id=? AND read_at IS NULL AND id IN (` + strings.Join(placeholders, ",") + `)`
		if _, err := tx.ExecContext(ctx, query, args...); err != nil {
			return err
		}
		return tx.QueryRowContext(ctx, `SELECT count(*) FROM notifications WHERE group_id=? AND membership_id=? AND read_at IS NULL`, membership.GroupID, membership.ID).Scan(&result.UnreadCount)
	})
	return result, err
}

// MarkRead sets or clears notificationID's read timestamp within membership's
// tenant and ownership scope. ctx bounds database work. It returns the updated
// Notification, ErrNotFound for inaccessible IDs, or a database error.
func (s Service) MarkRead(ctx context.Context, membership domain.Membership, notificationID string, read bool) (Notification, error) {
	var readAt any
	if read {
		readAt = platform.Timestamp(platform.Now())
	}
	result, err := s.DB.ExecContext(ctx, `UPDATE notifications SET read_at=? WHERE id=? AND group_id=? AND membership_id=?`, readAt, notificationID, membership.GroupID, membership.ID)
	if err != nil {
		return Notification{}, err
	}
	changed, _ := result.RowsAffected()
	if changed == 0 {
		return Notification{}, domain.ErrNotFound
	}
	var item Notification
	var contextJSON string
	err = s.DB.QueryRowContext(ctx, `SELECT id,group_id,type,title,body,resource_type,resource_id,context_json,read_at,created_at FROM notifications WHERE id=?`, notificationID).
		Scan(&item.ID, &item.GroupID, &item.Type, &item.Title, &item.Body, &item.ResourceType, &item.ResourceID, &contextJSON, &item.ReadAt, &item.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Notification{}, domain.ErrNotFound
	}
	if err != nil {
		return Notification{}, fmt.Errorf("read updated notification: %w", err)
	}
	if err := json.Unmarshal([]byte(contextJSON), &item.Context); err != nil {
		return Notification{}, fmt.Errorf("decode updated notification context: %w", err)
	}
	return item, nil
}
