// Package notifications provides member-scoped in-app notifications.
package notifications

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/platform"
)

// Service implements notification queries and read-state transitions over a
// migrated TeamTaler database.
type Service struct {
	// DB is the shared application database connection pool.
	DB *sql.DB
}

// Notification is a member-visible in-app event with a stable Type and optional
// link to the originating domain resource.
type Notification struct {
	ID           string  `json:"id"`
	GroupID      string  `json:"groupId"`
	Type         string  `json:"type"`
	Title        string  `json:"title"`
	Body         string  `json:"body"`
	ResourceType *string `json:"resourceType,omitempty"`
	ResourceID   *string `json:"resourceId,omitempty"`
	ReadAt       *string `json:"readAt,omitempty"`
	CreatedAt    string  `json:"createdAt"`
}

// List returns at most limit notifications newest first for membership only.
// ctx bounds the query; an empty slice is valid and SQL errors propagate.
func (s Service) List(ctx context.Context, membership domain.Membership, limit int) ([]Notification, error) {
	if limit < 1 || limit > 200 {
		limit = 100
	}
	rows, err := s.DB.QueryContext(ctx, `SELECT id,group_id,type,title,body,resource_type,resource_id,read_at,created_at
		FROM notifications WHERE group_id=? AND membership_id=? ORDER BY created_at DESC LIMIT ?`, membership.GroupID, membership.ID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]Notification, 0)
	for rows.Next() {
		var item Notification
		if err := rows.Scan(&item.ID, &item.GroupID, &item.Type, &item.Title, &item.Body, &item.ResourceType, &item.ResourceID, &item.ReadAt, &item.CreatedAt); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
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
	err = s.DB.QueryRowContext(ctx, `SELECT id,group_id,type,title,body,resource_type,resource_id,read_at,created_at FROM notifications WHERE id=?`, notificationID).
		Scan(&item.ID, &item.GroupID, &item.Type, &item.Title, &item.Body, &item.ResourceType, &item.ResourceID, &item.ReadAt, &item.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Notification{}, domain.ErrNotFound
	}
	if err != nil {
		return Notification{}, fmt.Errorf("read updated notification: %w", err)
	}
	return item, nil
}
