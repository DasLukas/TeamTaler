package notifications

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

const (
	defaultPlanningPollInterval = time.Minute
	defaultPlanningBatchSize    = 200
)

// PlanningWorker converts durable member-targeted planning tasks into the
// canonical in-app notification and optional external delivery jobs.
type PlanningWorker struct {
	db            *sql.DB
	notifications Service
	logger        *slog.Logger
	now           func() time.Time
	pollInterval  time.Duration
	batchSize     int
}

// NewPlanningWorker constructs a planning notification worker.
//
// Parameters:
//   - db: Migrated TeamTaler database.
//   - service: Notification service used for canonical and external delivery.
//   - logger: Optional structured logger; nil selects slog.Default.
//
// Returns:
//   - *PlanningWorker: A worker ready for Run or ProcessDue.
//   - error: A validation error for missing dependencies.
//
// Example: worker, err := notifications.NewPlanningWorker(db, service, logger).
func NewPlanningWorker(db *sql.DB, service Service, logger *slog.Logger) (*PlanningWorker, error) {
	if db == nil || service.DB == nil {
		return nil, errors.New("create planning notification worker: database and notification service are required")
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &PlanningWorker{
		db: db, notifications: service, logger: logger, now: func() time.Time { return time.Now().UTC() },
		pollInterval: defaultPlanningPollInterval, batchSize: defaultPlanningBatchSize,
	}, nil
}

// Run processes planning tasks immediately and at a bounded polling interval
// until ctx is cancelled. Individual poll failures are logged and retried.
func (w *PlanningWorker) Run(ctx context.Context) error {
	if ctx == nil {
		return errors.New("run planning notification worker: context is required")
	}
	if w == nil || w.db == nil || w.notifications.DB == nil || w.now == nil || w.pollInterval <= 0 || w.batchSize < 1 {
		return errors.New("run planning notification worker: worker is not fully configured")
	}
	process := func() {
		if _, err := w.ProcessDue(ctx, w.now()); err != nil && ctx.Err() == nil {
			w.logger.Error("planning notification processing failed", "error", err)
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

// ProcessDue processes one bounded batch of due tasks. Each target task commits
// independently so a malformed task cannot duplicate or roll back other work.
func (w *PlanningWorker) ProcessDue(ctx context.Context, now time.Time) (int, error) {
	if w == nil || w.db == nil || w.notifications.DB == nil || w.batchSize < 1 {
		return 0, errors.New("process planning notifications: worker is not fully configured")
	}
	if now.IsZero() {
		return 0, errors.New("process planning notifications: current time is required")
	}
	rows, err := w.db.QueryContext(ctx, `SELECT id,task_kind FROM (
		SELECT id,'EVENT' AS task_kind,scheduled_for FROM planning_notification_tasks
		WHERE status='PENDING' AND scheduled_for<=?
		UNION ALL
		SELECT id,'SERIES' AS task_kind,scheduled_for FROM planning_series_notification_tasks
		WHERE status='PENDING' AND scheduled_for<=?
	) ORDER BY scheduled_for,id LIMIT ?`, platform.Timestamp(now.UTC()), platform.Timestamp(now.UTC()), w.batchSize)
	if err != nil {
		return 0, err
	}
	tasks := make([]planningTaskReference, 0, w.batchSize)
	for rows.Next() {
		var task planningTaskReference
		if err := rows.Scan(&task.id, &task.kind); err != nil {
			rows.Close()
			return 0, err
		}
		tasks = append(tasks, task)
	}
	if err := rows.Close(); err != nil {
		return 0, err
	}
	processed := 0
	for _, task := range tasks {
		changed := false
		if err := storage.WithTx(ctx, w.db, func(tx *sql.Tx) error {
			var err error
			if task.kind == "SERIES" {
				changed, err = w.processSeriesTaskTx(ctx, tx, task.id, now.UTC())
			} else {
				changed, err = w.processTaskTx(ctx, tx, task.id, now.UTC())
			}
			return err
		}); err != nil {
			return processed, fmt.Errorf("process planning notification task %s: %w", task.id, err)
		}
		if changed {
			processed++
		}
	}
	return processed, nil
}

type planningTaskReference struct {
	id   string
	kind string
}

type planningTask struct {
	id, groupID, eventID, membershipID string
	eventType                          EventType
	eventRevision, currentRevision     int64
	title, planningType, eventStatus   string
	startsAt                           string
	participationStatus                sql.NullString
	moduleEnabled                      bool
	recipientActive                    bool
}

func (w *PlanningWorker) processTaskTx(ctx context.Context, tx *sql.Tx, taskID string, now time.Time) (bool, error) {
	task, err := loadPlanningTask(ctx, tx, taskID)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !task.moduleEnabled || !task.recipientActive || task.eventRevision != task.currentRevision || !planningTaskEligible(task) {
		result, err := tx.ExecContext(ctx, `UPDATE planning_notification_tasks SET status='CANCELLED',updated_at=?
			WHERE id=? AND status='PENDING'`, platform.Timestamp(now), task.id)
		if err != nil {
			return false, err
		}
		changed, _ := result.RowsAffected()
		return changed == 1, nil
	}
	title, body := planningNotificationCopy(task.eventType, task.title)
	notification, err := w.notifications.CreateTx(ctx, tx, CreateInput{
		GroupID: task.groupID, MembershipID: task.membershipID, Type: task.eventType,
		Title: title, Body: body, ResourceType: "planning_event", ResourceID: task.eventID,
		Context: EventContext{
			PlanningEventID: task.eventID, PlanningEventTitle: task.title, PlanningStartsAt: task.startsAt,
			PlanningStatus: task.participationStatus.String,
		},
		CreatedAt: platform.Timestamp(now),
	})
	if err != nil {
		return false, err
	}
	runID, err := platform.NewID("pnr")
	if err != nil {
		return false, err
	}
	var notificationID any
	if notification.ID != "" {
		notificationID = notification.ID
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO planning_notification_runs(
		id,task_id,group_id,event_id,target_membership_id,event_type,notification_id,processed_at
	) VALUES(?,?,?,?,?,?,?,?)`, runID, task.id, task.groupID, task.eventID, task.membershipID, task.eventType, notificationID, platform.Timestamp(now)); err != nil {
		return false, err
	}
	result, err := tx.ExecContext(ctx, `UPDATE planning_notification_tasks SET status='PROCESSED',updated_at=?
		WHERE id=? AND status='PENDING'`, platform.Timestamp(now), task.id)
	if err != nil {
		return false, err
	}
	changed, _ := result.RowsAffected()
	if changed != 1 {
		return false, errors.New("planning notification task changed before completion")
	}
	return true, nil
}

func loadPlanningTask(ctx context.Context, tx *sql.Tx, taskID string) (planningTask, error) {
	var task planningTask
	err := tx.QueryRowContext(ctx, `SELECT task.id,task.group_id,task.event_id,task.target_membership_id,task.event_type,
		task.event_revision,event.version,event.title,event.event_type,event.status,event.starts_at,
		participation.status,settings.enabled,
		membership.status='ACTIVE' AND membership.deleted_at IS NULL AND recipient.active=1 AND group_row.status='ACTIVE'
		FROM planning_notification_tasks task
		JOIN planning_events event ON event.id=task.event_id AND event.group_id=task.group_id
		JOIN planning_event_audience audience ON audience.event_id=task.event_id AND audience.group_id=task.group_id
			AND audience.membership_id=task.target_membership_id
		JOIN memberships membership ON membership.id=task.target_membership_id AND membership.group_id=task.group_id
		JOIN users recipient ON recipient.id=membership.user_id
		JOIN groups group_row ON group_row.id=task.group_id
		JOIN group_planning_settings settings ON settings.group_id=task.group_id
		LEFT JOIN planning_participations participation ON participation.event_id=task.event_id
			AND participation.group_id=task.group_id AND participation.membership_id=task.target_membership_id
		WHERE task.id=? AND task.status='PENDING'`, taskID).
		Scan(&task.id, &task.groupID, &task.eventID, &task.membershipID, &task.eventType,
			&task.eventRevision, &task.currentRevision, &task.title, &task.planningType, &task.eventStatus,
			&task.startsAt, &task.participationStatus, &task.moduleEnabled, &task.recipientActive)
	return task, err
}

func planningTaskEligible(task planningTask) bool {
	switch task.eventType {
	case TypePlanningEventPublished, TypePlanningEventUpdated:
		if task.eventStatus != "PUBLISHED" {
			return false
		}
		return task.planningType != "APPOINTMENT_REGISTRATION" || task.eventType == TypePlanningEventPublished ||
			statusIs(task.participationStatus, "REGISTERED", "WAITLISTED")
	case TypePlanningEventCancelled:
		return task.eventStatus == "CANCELLED" && (task.planningType != "APPOINTMENT_REGISTRATION" ||
			statusIs(task.participationStatus, "REGISTERED", "WAITLISTED"))
	case TypePlanningWaitlistPromoted:
		return (task.eventStatus == "PUBLISHED" || task.eventStatus == "CLOSED") && task.planningType == "APPOINTMENT_REGISTRATION" &&
			statusIs(task.participationStatus, "REGISTERED")
	default:
		return false
	}
}

func statusIs(status sql.NullString, allowed ...string) bool {
	if !status.Valid {
		return false
	}
	for _, candidate := range allowed {
		if status.String == candidate {
			return true
		}
	}
	return false
}

func planningNotificationCopy(eventType EventType, eventTitle string) (string, string) {
	switch eventType {
	case TypePlanningEventPublished:
		return "Neuer Termin", fmt.Sprintf("„%s“ wurde veröffentlicht.", eventTitle)
	case TypePlanningEventUpdated:
		return "Termin geändert", fmt.Sprintf("„%s“ wurde geändert.", eventTitle)
	case TypePlanningEventCancelled:
		return "Termin abgesagt", fmt.Sprintf("„%s“ wurde abgesagt.", eventTitle)
	case TypePlanningWaitlistPromoted:
		return "Platz verfügbar", fmt.Sprintf("Du bist bei „%s“ von der Warteliste nachgerückt.", eventTitle)
	default:
		return "Neue Planung", "In deiner Gruppe gibt es eine neue Planung."
	}
}

type planningSeriesTask struct {
	id, groupID, seriesID, membershipID string
	eventType                           EventType
	seriesRevision, currentRevision     int64
	title, seriesStatus                 string
	moduleEnabled                       bool
	recipientActive                     bool
}

func (w *PlanningWorker) processSeriesTaskTx(ctx context.Context, tx *sql.Tx, taskID string, now time.Time) (bool, error) {
	task, err := loadPlanningSeriesTask(ctx, tx, taskID)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !task.moduleEnabled || !task.recipientActive || !planningSeriesTaskEligible(task) {
		result, err := tx.ExecContext(ctx, `UPDATE planning_series_notification_tasks SET status='CANCELLED',updated_at=?
			WHERE id=? AND status='PENDING'`, platform.Timestamp(now), task.id)
		if err != nil {
			return false, err
		}
		changed, _ := result.RowsAffected()
		return changed == 1, nil
	}
	title, body := planningSeriesNotificationCopy(task.eventType, task.title)
	if _, err := w.notifications.CreateTx(ctx, tx, CreateInput{
		GroupID: task.groupID, MembershipID: task.membershipID, Type: task.eventType,
		Title: title, Body: body, ResourceType: "planning_series", ResourceID: task.seriesID,
		Context:   EventContext{PlanningSeriesID: task.seriesID, PlanningSeriesTitle: task.title},
		CreatedAt: platform.Timestamp(now),
	}); err != nil {
		return false, err
	}
	result, err := tx.ExecContext(ctx, `UPDATE planning_series_notification_tasks SET status='PROCESSED',updated_at=?
		WHERE id=? AND status='PENDING'`, platform.Timestamp(now), task.id)
	if err != nil {
		return false, err
	}
	changed, _ := result.RowsAffected()
	if changed != 1 {
		return false, errors.New("planning series notification task changed before completion")
	}
	return true, nil
}

func loadPlanningSeriesTask(ctx context.Context, tx *sql.Tx, taskID string) (planningSeriesTask, error) {
	var task planningSeriesTask
	err := tx.QueryRowContext(ctx, `SELECT task.id,task.group_id,task.series_id,task.target_membership_id,task.event_type,
		task.series_revision,series.current_revision,revision.title,series.status,settings.enabled,
		membership.status='ACTIVE' AND membership.deleted_at IS NULL AND recipient.active=1 AND group_row.status='ACTIVE'
		FROM planning_series_notification_tasks task
		JOIN planning_series series ON series.id=task.series_id AND series.group_id=task.group_id
		JOIN planning_series_revisions revision ON revision.series_id=task.series_id AND revision.group_id=task.group_id
			AND revision.revision=task.series_revision
		JOIN planning_series_recipients series_recipient ON series_recipient.series_id=task.series_id
			AND series_recipient.group_id=task.group_id AND series_recipient.membership_id=task.target_membership_id
		JOIN memberships membership ON membership.id=task.target_membership_id AND membership.group_id=task.group_id
		JOIN users recipient ON recipient.id=membership.user_id
		JOIN groups group_row ON group_row.id=task.group_id
		JOIN group_planning_settings settings ON settings.group_id=task.group_id
		WHERE task.id=? AND task.status='PENDING'`, taskID).
		Scan(&task.id, &task.groupID, &task.seriesID, &task.membershipID, &task.eventType,
			&task.seriesRevision, &task.currentRevision, &task.title, &task.seriesStatus,
			&task.moduleEnabled, &task.recipientActive)
	return task, err
}

func planningSeriesTaskEligible(task planningSeriesTask) bool {
	if task.seriesRevision != task.currentRevision {
		return false
	}
	switch task.eventType {
	case TypePlanningSeriesPublished, TypePlanningSeriesUpdated:
		return task.seriesStatus == "PUBLISHED"
	case TypePlanningSeriesCancelled:
		return task.seriesStatus == "PUBLISHED" || task.seriesStatus == "CANCELLED"
	default:
		return false
	}
}

func planningSeriesNotificationCopy(eventType EventType, seriesTitle string) (string, string) {
	switch eventType {
	case TypePlanningSeriesPublished:
		return "Neue Terminserie", fmt.Sprintf("„%s“ wurde als Terminserie veröffentlicht.", seriesTitle)
	case TypePlanningSeriesUpdated:
		return "Terminserie geändert", fmt.Sprintf("„%s“ wurde als Terminserie geändert.", seriesTitle)
	case TypePlanningSeriesCancelled:
		return "Terminserie abgesagt", fmt.Sprintf("„%s“ wurde als Terminserie abgesagt.", seriesTitle)
	default:
		return "Terminserie", "In deiner Gruppe gibt es eine Änderung an einer Terminserie."
	}
}
