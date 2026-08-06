// Package notifications provides member-scoped in-app notifications.
package notifications

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

const (
	// TypeBookingAssigned identifies a booking created for another membership.
	TypeBookingAssigned = "BOOKING_ASSIGNED"
	// TypeBookingReversed identifies an externally reversed booking.
	TypeBookingReversed = "BOOKING_REVERSED"
	// TypePaymentRecorded identifies an externally recorded payment.
	TypePaymentRecorded = "PAYMENT_RECORDED"
	// TypePaymentReversed identifies an externally reversed payment.
	TypePaymentReversed = "PAYMENT_REVERSED"
	// TypeSettlementCreated identifies a newly generated period statement.
	TypeSettlementCreated = "SETTLEMENT_CREATED"
)

// Service implements notification queries and read-state transitions over a
// migrated TeamTaler database.
type Service struct {
	// DB is the shared application database connection pool.
	DB *sql.DB
	// EmailDeliveryAvailable allows new notification email jobs to be queued.
	EmailDeliveryAvailable bool
}

// EventContext contains safe, structured presentation data for one notification.
// Fields are optional because each event type requires only a relevant subset.
type EventContext struct {
	ActorName   string `json:"actorName,omitempty"`
	ItemName    string `json:"itemName,omitempty"`
	Quantity    int    `json:"quantity,omitempty"`
	AmountMinor int64  `json:"amountMinor,string"`
	Currency    string `json:"currency,omitempty"`
	PeriodLabel string `json:"periodLabel,omitempty"`
	DueAt       string `json:"dueAt,omitempty"`
}

// CreateInput describes one member-visible event created inside an existing
// business transaction.
type CreateInput struct {
	GroupID      string
	MembershipID string
	Type         string
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

// CreateTx inserts an in-app notification and, when both the group preference
// and runtime SMTP capability are enabled, its email job in the same transaction.
// The caller owns tx and therefore controls commit or rollback.
func (s Service) CreateTx(ctx context.Context, tx *sql.Tx, input CreateInput) (Notification, error) {
	if tx == nil {
		return Notification{}, errors.New("create notification: transaction is required")
	}
	input.GroupID = strings.TrimSpace(input.GroupID)
	input.MembershipID = strings.TrimSpace(input.MembershipID)
	input.Type = strings.TrimSpace(input.Type)
	input.Title = strings.TrimSpace(input.Title)
	input.Body = strings.TrimSpace(input.Body)
	input.ResourceType = strings.TrimSpace(input.ResourceType)
	input.ResourceID = strings.TrimSpace(input.ResourceID)
	if input.GroupID == "" || input.MembershipID == "" || input.Type == "" || input.Title == "" || input.Body == "" || input.CreatedAt == "" {
		return Notification{}, errors.New("create notification: group, membership, type, copy, and timestamp are required")
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
	if s.EmailDeliveryAvailable {
		var enabled bool
		if err := tx.QueryRowContext(ctx, `SELECT notification_emails_enabled FROM group_settings WHERE group_id=?`, input.GroupID).Scan(&enabled); err != nil {
			return Notification{}, err
		}
		if enabled {
			_, err = tx.ExecContext(ctx, `INSERT INTO notification_email_outbox(
				notification_id,group_id,status,attempt_count,next_attempt_at,created_at,updated_at
			) VALUES(?,?,'PENDING',0,?,?,?)`, notificationID, input.GroupID, input.CreatedAt, input.CreatedAt, input.CreatedAt)
			if err != nil {
				return Notification{}, err
			}
		}
	}
	item := Notification{ID: notificationID, GroupID: input.GroupID, Type: input.Type, Title: input.Title, Body: input.Body, Context: input.Context, CreatedAt: input.CreatedAt}
	if input.ResourceType != "" {
		item.ResourceType = &input.ResourceType
	}
	if input.ResourceID != "" {
		item.ResourceID = &input.ResourceID
	}
	return item, nil
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
