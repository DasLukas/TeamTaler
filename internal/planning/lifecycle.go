package planning

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/DasLukas/TeamTaler/internal/audit"
	"github.com/DasLukas/TeamTaler/internal/notifications"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

const (
	defaultLifecyclePollInterval = time.Minute
	defaultLifecycleBatchSize    = 200
)

// LifecycleWorker advances planning events at their persisted deadlines and
// end times. For all-day events, ends_at is the independently resolved UTC
// boundary of end_date_exclusive. Serialized transactions and state predicates
// make every advance safe across process restarts and concurrent workers.
type LifecycleWorker struct {
	db           *sql.DB
	logger       *slog.Logger
	now          func() time.Time
	pollInterval time.Duration
	batchSize    int
}

// NewLifecycleWorker constructs an automatic planning lifecycle worker.
//
// Parameters:
//   - db: Migrated TeamTaler database.
//   - logger: Optional structured logger; nil selects slog.Default.
//
// Returns:
//   - *LifecycleWorker: A worker ready for Run or ProcessDue.
//   - error: A validation error when db is missing.
//
// Example: worker, err := planning.NewLifecycleWorker(db, logger).
func NewLifecycleWorker(db *sql.DB, logger *slog.Logger) (*LifecycleWorker, error) {
	if db == nil {
		return nil, errors.New("create planning lifecycle worker: database is required")
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &LifecycleWorker{
		db: db, logger: logger, now: func() time.Time { return time.Now().UTC() },
		pollInterval: defaultLifecyclePollInterval, batchSize: defaultLifecycleBatchSize,
	}, nil
}

// Run processes due lifecycle transitions immediately and once per polling
// interval until ctx is cancelled. A failed poll is logged and retried.
//
// ctx controls the worker lifetime; cancellation is a clean shutdown. Run
// returns a configuration error for a nil context or incomplete worker and nil
// after context cancellation.
//
// Example: go worker.Run(ctx).
func (w *LifecycleWorker) Run(ctx context.Context) error {
	if ctx == nil {
		return errors.New("run planning lifecycle worker: context is required")
	}
	if w == nil || w.db == nil || w.now == nil || w.pollInterval <= 0 || w.batchSize < 1 {
		return errors.New("run planning lifecycle worker: worker is not fully configured")
	}
	process := func() {
		if _, err := w.ProcessDue(ctx, w.now()); err != nil && ctx.Err() == nil {
			w.logger.Error("planning lifecycle processing failed", "error", err)
		}
	}
	process()
	ticker := time.NewTicker(w.pollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			process()
		}
	}
}

// ProcessDue closes response-based events and completes elapsed events in
// bounded batches at now. It is restart-safe and may be called concurrently
// because each state change is guarded by persisted predicates.
//
// ctx bounds database work and now is normalized to UTC. The method returns the
// number of committed event transitions and a configuration or storage error.
//
// Example: changed, err := worker.ProcessDue(ctx, time.Now()).
func (w *LifecycleWorker) ProcessDue(ctx context.Context, now time.Time) (int, error) {
	if w == nil || w.db == nil || w.batchSize < 1 {
		return 0, errors.New("process planning lifecycle: worker is not fully configured")
	}
	if now.IsZero() {
		return 0, errors.New("process planning lifecycle: current time is required")
	}
	now = now.UTC()
	closed, err := w.processEventIDs(ctx, now, `SELECT event.id FROM planning_events event
		JOIN group_planning_settings settings ON settings.group_id=event.group_id AND settings.enabled=1
		JOIN groups group_row ON group_row.id=event.group_id AND group_row.status='ACTIVE'
		WHERE event.status='PUBLISHED' AND event.event_type!='APPOINTMENT'
		  AND event.response_deadline_us IS NOT NULL AND event.response_deadline_us<=?
		ORDER BY event.response_deadline_us,event.id LIMIT ?`, w.closeEventTx)
	if err != nil {
		return closed, err
	}
	completed, err := w.processEventIDs(ctx, now, `SELECT event.id FROM planning_events event
		JOIN group_planning_settings settings ON settings.group_id=event.group_id AND settings.enabled=1
		JOIN groups group_row ON group_row.id=event.group_id AND group_row.status='ACTIVE'
		WHERE event.status IN ('PUBLISHED','CLOSED') AND coalesce(event.ends_at_us,event.starts_at_us)<=?
		ORDER BY coalesce(event.ends_at_us,event.starts_at_us),event.id LIMIT ?`, w.completeEventTx)
	return closed + completed, err
}

type lifecycleTransition func(context.Context, *sql.Tx, string, time.Time) (bool, error)

func (w *LifecycleWorker) processEventIDs(ctx context.Context, now time.Time, query string, transition lifecycleTransition) (int, error) {
	rows, err := w.db.QueryContext(ctx, query, now.UTC().UnixMicro(), w.batchSize)
	if err != nil {
		return 0, err
	}
	ids := make([]string, 0, w.batchSize)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return 0, err
		}
		ids = append(ids, id)
	}
	if err := rows.Close(); err != nil {
		return 0, err
	}
	changed := 0
	for _, id := range ids {
		transitioned := false
		if err := storage.WithTx(ctx, w.db, func(tx *sql.Tx) error {
			var err error
			transitioned, err = transition(ctx, tx, id, now)
			return err
		}); err != nil {
			return changed, fmt.Errorf("advance planning event %s: %w", id, err)
		}
		if transitioned {
			changed++
		}
	}
	return changed, nil
}

func (w *LifecycleWorker) closeEventTx(ctx context.Context, tx *sql.Tx, eventID string, now time.Time) (bool, error) {
	return closePublishedEventTx(ctx, tx, eventID, closeEventOptions{
		Now: now, RequireDue: true, AuditAction: "planning.event.closed.automatic",
	})
}

func (w *LifecycleWorker) completeEventTx(ctx context.Context, tx *sql.Tx, eventID string, now time.Time) (bool, error) {
	var groupID string
	var version int64
	err := tx.QueryRowContext(ctx, `SELECT event.group_id,event.version FROM planning_events event
		JOIN group_planning_settings settings ON settings.group_id=event.group_id AND settings.enabled=1
		JOIN groups group_row ON group_row.id=event.group_id AND group_row.status='ACTIVE'
		WHERE event.id=? AND event.status IN ('PUBLISHED','CLOSED')
		  AND coalesce(event.ends_at_us,event.starts_at_us)<=?`, eventID, now.UTC().UnixMicro()).Scan(&groupID, &version)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	result, err := tx.ExecContext(ctx, `UPDATE planning_events
		SET status='COMPLETED',completed_at=?,version=version+1,updated_at=?
		WHERE id=? AND status IN ('PUBLISHED','CLOSED') AND version=?`,
		platform.Timestamp(now), platform.Timestamp(now), eventID, version)
	if err != nil {
		return false, err
	}
	changed, _ := result.RowsAffected()
	if changed != 1 {
		return false, nil
	}
	if err := audit.Record(ctx, tx, groupID, "", "", "planning.event.completed.automatic", "planning_event", eventID, map[string]any{}); err != nil {
		return false, err
	}
	return true, nil
}

func insertLifecycleTask(ctx context.Context, tx *sql.Tx, groupID, eventID, membershipID string,
	eventType notifications.EventType, scheduledFor string, eventRevision int64,
) error {
	taskID, err := platform.NewID("pnt")
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT OR IGNORE INTO planning_notification_tasks(
		id,group_id,event_id,target_membership_id,event_type,scheduled_for,event_revision,created_at,updated_at
	) VALUES(?,?,?,?,?,?,?,?,?)`, taskID, groupID, eventID, membershipID, eventType,
		scheduledFor, eventRevision, scheduledFor, scheduledFor)
	return err
}
