package planning

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"reflect"
	"strings"
	"time"

	"github.com/DasLukas/TeamTaler/internal/audit"
	"github.com/DasLukas/TeamTaler/internal/authorization"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/idempotency"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

const (
	// SeriesScopeAll targets the complete eligible future range of a series.
	SeriesScopeAll SeriesMutationScope = "ALL"
	// SeriesScopeThisAndFollowing targets the selected occurrence and its future segment.
	SeriesScopeThisAndFollowing SeriesMutationScope = "THIS_AND_FOLLOWING"

	defaultSeriesPollInterval  = time.Hour
	maximumCalendarQueryWindow = 366 * 24 * time.Hour
	eligibleSeriesEventSQL     = `((event.all_day=1 AND event.ends_at_us>?) OR (event.all_day=0 AND event.starts_at_us>?))`
	eligibleSeriesRowSQL       = `((all_day=1 AND ends_at_us>?) OR (all_day=0 AND starts_at_us>?))`
)

// SeriesMutationScope selects which eligible future occurrences a series
// update or cancellation affects.
type SeriesMutationScope string

// SeriesCreateCommand contains the complete event defaults and structured
// recurrence for a new series. Creation publishes the series atomically.
type SeriesCreateCommand struct {
	EventInput
	Recurrence RecurrenceInput `json:"recurrence"`
}

// SeriesUpdateCommand replaces event defaults and recurrence for one future
// series segment. FromOriginalStartAt is required for THIS_AND_FOLLOWING and
// identifies the selected occurrence's stable original start.
type SeriesUpdateCommand struct {
	EventInput
	Recurrence          RecurrenceInput     `json:"recurrence"`
	Scope               SeriesMutationScope `json:"scope"`
	FromOriginalStartAt *string             `json:"fromOriginalStartAt"`
}

// Series is the permission-aware, versioned read model for a recurring planning
// definition. TimeZone is pinned at creation; target IDs are omitted for
// readers who cannot edit the series.
type Series struct {
	ID                            string          `json:"id"`
	Status                        string          `json:"status"`
	TimeZone                      string          `json:"timeZone"`
	EventType                     string          `json:"eventType"`
	Title                         string          `json:"title"`
	Description                   string          `json:"description"`
	Location                      string          `json:"location"`
	AllDay                        bool            `json:"allDay"`
	StartDate                     string          `json:"startDate,omitempty"`
	DurationDays                  int             `json:"durationDays,omitempty"`
	DurationMinutes               int             `json:"durationMinutes,omitempty"`
	ResponseDeadlineMinutesBefore *int            `json:"responseDeadlineMinutesBefore,omitempty"`
	Capacity                      *int            `json:"capacity,omitempty"`
	WaitlistEnabled               bool            `json:"waitlistEnabled"`
	AudienceType                  string          `json:"audienceType"`
	TargetRoleIDs                 []string        `json:"targetRoleIds"`
	TargetMembershipIDs           []string        `json:"targetMembershipIds"`
	Recurrence                    RecurrenceInput `json:"recurrence"`
	Version                       int64           `json:"version"`
	CreatedAt                     string          `json:"createdAt"`
	UpdatedAt                     string          `json:"updatedAt"`
	CanEdit                       bool            `json:"canEdit"`
	CanCancel                     bool            `json:"canCancel"`
	ownerMembershipID             string
	currentRevision               int64
	anchorStartsAt                string
}

// SeriesCreateResult contains the durable series definition and its first
// materialized occurrence. Idempotent create replays return the original
// snapshot of both values.
type SeriesCreateResult struct {
	Series          Series `json:"series"`
	FirstOccurrence Event  `json:"firstOccurrence"`
}

// SeriesMaterializationWorker keeps the bounded occurrence cache and dynamic
// future audiences synchronized across restarts and membership changes.
type SeriesMaterializationWorker struct {
	db           *sql.DB
	logger       *slog.Logger
	now          func() time.Time
	pollInterval time.Duration
}

// NewSeriesMaterializationWorker constructs a restart-safe recurring-series
// worker. db is the migrated planning database and logger receives recoverable
// cycle failures; nil logger selects slog.Default. It returns a configured
// worker or a validation error when db is nil.
//
// Example: worker, err := NewSeriesMaterializationWorker(db, slog.Default()).
func NewSeriesMaterializationWorker(db *sql.DB, logger *slog.Logger) (*SeriesMaterializationWorker, error) {
	if db == nil {
		return nil, errors.New("create series materialization worker: database is required")
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &SeriesMaterializationWorker{db: db, logger: logger, now: func() time.Time { return time.Now().UTC() }, pollInterval: defaultSeriesPollInterval}, nil
}

// Run materializes twelve months ahead immediately and after each polling
// interval. ctx controls the worker lifetime; cancellation is a clean shutdown
// and returns nil. A configuration error is returned before processing starts,
// while recoverable cycle errors are logged and retried.
//
// Example: go worker.Run(ctx).
func (worker *SeriesMaterializationWorker) Run(ctx context.Context) error {
	if worker == nil || worker.db == nil || worker.now == nil || worker.pollInterval <= 0 {
		return errors.New("run series materialization worker: worker is not fully configured")
	}
	process := func() {
		now := worker.now()
		if _, err := worker.ProcessThrough(ctx, now.AddDate(1, 0, 0)); err != nil && ctx.Err() == nil {
			worker.logger.Error("planning series materialization failed", "error", err)
		}
	}
	process()
	ticker := time.NewTicker(worker.pollInterval)
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

// ProcessThrough materializes published series through horizon. ctx bounds the
// database work and horizon is capped to the service's rolling lookahead. It
// returns the number of newly inserted occurrences and a validation or storage
// error. The operation is idempotent and safe to call after startup.
//
// Example: created, err := worker.ProcessThrough(ctx, time.Now().AddDate(1, 0, 0)).
func (worker *SeriesMaterializationWorker) ProcessThrough(ctx context.Context, horizon time.Time) (int, error) {
	if worker == nil || worker.db == nil {
		return 0, errors.New("process series materialization: worker is not fully configured")
	}
	return (Service{DB: worker.db}).MaterializeSeries(ctx, horizon)
}

type seriesRevision struct {
	SeriesID                      string
	Revision                      int64
	EffectiveFromOriginalStartAt  string
	EffectiveFromSequence         int64
	Title                         string
	Description                   string
	Location                      string
	EventType                     string
	AudienceType                  string
	AllDay                        bool
	StartDate                     string
	DurationDays                  *int
	StartsAt                      string
	DurationMinutes               *int
	ResponseDeadlineMinutesBefore *int
	Capacity                      *int
	WaitlistEnabled               bool
	Recurrence                    RecurrenceInput
	TargetRoleIDs                 []string
	TargetMembershipIDs           []string
}

// CreateSeries validates and atomically creates a recurring series and its first
// occurrence. actor and membership define audit identity and tenant authority;
// idempotencyKey makes retries return the original immutable response snapshot;
// command supplies event defaults, recurrence, and audience; creation always
// publishes the series in the same transaction.
// It returns the committed series plus its first occurrence, or a validation,
// authorization, idempotency, or storage error.
//
// Example: result, err := service.CreateSeries(ctx, actor, membership, key, command).
func (s Service) CreateSeries(ctx context.Context, actor domain.Principal, membership domain.Membership, idempotencyKey string, command SeriesCreateCommand) (SeriesCreateResult, error) {
	if err := idempotency.ValidateKey(idempotencyKey); err != nil {
		return SeriesCreateResult{}, err
	}
	location, timezone, err := s.seriesLocation(ctx, membership.GroupID)
	if err != nil {
		return SeriesCreateResult{}, err
	}
	if err := normalizeSeriesCommand(&command.EventInput, &command.Recurrence, location); err != nil {
		return SeriesCreateResult{}, err
	}
	if !seriesEventInputEligible(command.EventInput, platform.Now()) {
		return SeriesCreateResult{}, domain.ValidationError{Field: seriesScheduleField(command.EventInput), Message: "must identify a current or future occurrence"}
	}
	requestHash, err := idempotency.Hash(command)
	if err != nil {
		return SeriesCreateResult{}, err
	}
	seriesID, err := platform.NewID("psr")
	if err != nil {
		return SeriesCreateResult{}, err
	}
	firstEventID := ""
	result := SeriesCreateResult{}
	err = storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		if err := enabled(ctx, tx, membership.GroupID); err != nil {
			return err
		}
		if err := require(ctx, tx, membership, domain.PermissionCreatePlanningEvents); err != nil {
			return err
		}
		found, err := idempotency.Load(ctx, tx, membership.GroupID, actor.UserID, idempotencyKey, requestHash, &result)
		if err != nil {
			return err
		}
		if found {
			return nil
		}
		now := platform.Timestamp(platform.Now())
		if _, err := tx.ExecContext(ctx, `INSERT INTO planning_series(id,group_id,status,timezone,current_revision,version,created_by_membership_id,updated_by_membership_id,published_at,created_at,updated_at) VALUES(?,?,'PUBLISHED',?,1,1,?,?,?,?,?)`, seriesID, membership.GroupID, timezone, membership.ID, membership.ID, now, now, now); err != nil {
			return err
		}
		revision, err := revisionFromInput(seriesID, 1, command.StartsAt, 1, command.EventInput, command.Recurrence)
		if err != nil {
			return err
		}
		if err := insertSeriesRevision(ctx, tx, membership, revision, now); err != nil {
			return err
		}
		horizon := platform.Now().AddDate(1, 0, 0)
		if start := mustTime(command.StartsAt); start.After(horizon) {
			horizon = start
		}
		ids, _, err := materializeRevisionTx(ctx, tx, membership.GroupID, timezone, "PUBLISHED", membership.ID, revision, horizon)
		if err != nil {
			return err
		}
		if len(ids) == 0 {
			return domain.ValidationError{Field: "recurrence", Message: "does not produce an occurrence"}
		}
		firstEventID = ids[0]
		var audienceCount int
		if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM planning_event_audience WHERE event_id=?`, firstEventID).Scan(&audienceCount); err != nil {
			return err
		}
		if audienceCount == 0 {
			return domain.ValidationError{Field: "audience", Message: "must contain at least one active member"}
		}
		if err := syncSeriesRecipientsAndTask(ctx, tx, membership.GroupID, seriesID, 1, "PLANNING_SERIES_PUBLISHED", now, seriesNotificationScope{}); err != nil {
			return err
		}
		if err := audit.Record(ctx, tx, membership.GroupID, actor.UserID, membership.ID, "planning.series.created", "planning_series", seriesID, map[string]any{"published": true}); err != nil {
			return err
		}
		result, err = seriesCreateResultTx(ctx, tx, membership, seriesID, firstEventID)
		if err != nil {
			return err
		}
		return idempotency.Store(ctx, tx, membership.GroupID, actor.UserID, idempotencyKey, requestHash, 201, result)
	})
	if err != nil {
		return SeriesCreateResult{}, err
	}
	return result, nil
}

func seriesCreateResultTx(ctx context.Context, tx *sql.Tx, membership domain.Membership, seriesID, eventID string) (SeriesCreateResult, error) {
	permissions, err := currentPlanningPermissions(ctx, tx, membership)
	if err != nil {
		return SeriesCreateResult{}, err
	}
	series, err := scanSeries(tx.QueryRowContext(ctx, seriesProjectionQuery+` WHERE series.group_id=? AND series.id=?`, membership.GroupID, seriesID))
	if err != nil {
		return SeriesCreateResult{}, err
	}
	series.CanEdit = (permissions.Manage || permissions.Create && series.ownerMembershipID == membership.ID) && series.Status == "PUBLISHED"
	series.CanCancel = series.CanEdit
	if series.CanEdit {
		if err := hydrateSeriesTargets(ctx, tx, &series); err != nil {
			return SeriesCreateResult{}, err
		}
	}
	projection, err := scanEventProjection(tx.QueryRowContext(ctx, `SELECT `+eventProjectionColumns+` FROM planning_events event WHERE event.group_id=? AND event.id=?`, membership.ID, membership.GroupID, eventID))
	if err != nil {
		return SeriesCreateResult{}, err
	}
	events, err := hydrateEventProjections(ctx, tx, membership, permissions, []eventProjection{projection})
	if err != nil {
		return SeriesCreateResult{}, err
	}
	return SeriesCreateResult{Series: series, FirstOccurrence: events[0]}, nil
}

// GetSeries returns the current definition of id when membership may see at
// least one occurrence. membership supplies the tenant and visibility subject;
// target selector IDs are included only for editors. It returns
// domain.ErrNotFound for invisible series and authorization,
// planning-disabled, or storage errors otherwise.
//
// Example: series, err := service.GetSeries(ctx, membership, seriesID).
func (s Service) GetSeries(ctx context.Context, membership domain.Membership, id string) (Series, error) {
	if err := enabled(ctx, s.DB, membership.GroupID); err != nil {
		return Series{}, err
	}
	if err := require(ctx, s.DB, membership, domain.PermissionUsePlanning); err != nil {
		return Series{}, err
	}
	permissions, err := currentPlanningPermissions(ctx, s.DB, membership)
	if err != nil {
		return Series{}, err
	}
	series, err := scanSeries(s.DB.QueryRowContext(ctx, seriesProjectionQuery+` WHERE series.group_id=? AND series.id=?`, membership.GroupID, id))
	if errors.Is(err, sql.ErrNoRows) {
		return Series{}, domain.ErrNotFound
	}
	if err != nil {
		return Series{}, err
	}
	var visibleOccurrence bool
	if err := s.DB.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM planning_events event JOIN planning_event_audience audience ON audience.event_id=event.id WHERE event.series_id=? AND audience.membership_id=?)`, id, membership.ID).Scan(&visibleOccurrence); err != nil {
		return Series{}, err
	}
	if !permissions.Manage && series.ownerMembershipID != membership.ID && !visibleOccurrence {
		return Series{}, domain.ErrNotFound
	}
	series.CanEdit = (permissions.Manage || permissions.Create && series.ownerMembershipID == membership.ID) && series.Status == "PUBLISHED"
	series.CanCancel = series.CanEdit
	if series.CanEdit {
		if err := hydrateSeriesTargets(ctx, s.DB, &series); err != nil {
			return Series{}, err
		}
	} else {
		series.TargetRoleIDs = nil
		series.TargetMembershipIDs = nil
	}
	return series, nil
}

// UpdateSeries creates a new optimistic-concurrency revision for ALL or
// THIS_AND_FOLLOWING. Content changes preserve manual exceptions; an unchanged
// recurrence in ALL scope rebases the selected wall-clock time onto the first
// future occurrence date. actor and membership identify the editor and tenant,
// id selects the series, command contains the replacement definition and
// boundary, and version must match the current series version. It returns the
// updated series or a validation, authorization, not-found, conflict,
// precondition, or storage error.
//
// Example: series, err := service.UpdateSeries(ctx, actor, membership, id, command, version).
func (s Service) UpdateSeries(ctx context.Context, actor domain.Principal, membership domain.Membership, id string, command SeriesUpdateCommand, version int64) (Series, error) {
	if command.Scope != SeriesScopeAll && command.Scope != SeriesScopeThisAndFollowing {
		return Series{}, domain.ValidationError{Field: "scope", Message: "must be ALL or THIS_AND_FOLLOWING"}
	}
	err := storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		if err := enabled(ctx, tx, membership.GroupID); err != nil {
			return err
		}
		var owner, status, timezone, previousType string
		var currentRevision, currentVersion int64
		if err := tx.QueryRowContext(ctx, `SELECT series.created_by_membership_id,series.status,series.timezone,series.current_revision,series.version,revision.event_type FROM planning_series series JOIN planning_series_revisions revision ON revision.series_id=series.id AND revision.revision=series.current_revision WHERE series.group_id=? AND series.id=?`, membership.GroupID, id).Scan(&owner, &status, &timezone, &currentRevision, &currentVersion, &previousType); err != nil {
			return domain.ErrNotFound
		}
		if currentVersion != version {
			return domain.ErrPrecondition
		}
		if err := requireEventMutation(ctx, tx, membership, owner); err != nil {
			return err
		}
		if status != "PUBLISHED" {
			return domain.ErrConflict
		}
		if command.EventType != previousType {
			return domain.ValidationError{Field: "eventType", Message: "is immutable after publication"}
		}
		if err := ensureSeriesAudienceResolves(ctx, tx, membership.GroupID, command.AudienceType, command.TargetRoleIDs, command.TargetMembershipIDs); err != nil {
			return err
		}
		location, err := time.LoadLocation(timezone)
		if err != nil {
			return err
		}
		if err := normalizeSeriesCommand(&command.EventInput, &command.Recurrence, location); err != nil {
			return err
		}
		if !seriesEventInputEligible(command.EventInput, platform.Now()) {
			return domain.ValidationError{Field: seriesScheduleField(command.EventInput), Message: "must identify a current or future occurrence for a series revision"}
		}
		previousRevision, err := loadSeriesRevision(ctx, tx, membership.GroupID, id, currentRevision)
		if err != nil {
			return err
		}
		boundary, err := seriesMutationBoundary(ctx, tx, id, command.Scope, command.FromOriginalStartAt)
		if err != nil {
			return err
		}
		if command.Scope == SeriesScopeAll && reflect.DeepEqual(command.Recurrence, previousRevision.Recurrence) {
			rebaseSeriesEventStart(&command.EventInput, boundary.startsAt, location)
			if err := normalizeRecurrence(&command.Recurrence, mustTime(command.StartsAt), location); err != nil {
				return err
			}
		}
		previousRecipients, err := affectedSeriesRecipientIDs(ctx, tx, id, boundary.sequence)
		if err != nil {
			return err
		}
		nextRevision := currentRevision + 1
		now := platform.Timestamp(platform.Now())
		revision, err := revisionFromInput(id, nextRevision, boundary.originalStartAt, boundary.sequence, command.EventInput, command.Recurrence)
		if err != nil {
			return err
		}
		if err := insertSeriesRevision(ctx, tx, membership, revision, now); err != nil {
			return err
		}
		result, err := tx.ExecContext(ctx, `UPDATE planning_series SET current_revision=?,version=version+1,materialized_through=NULL,updated_by_membership_id=?,updated_at=? WHERE group_id=? AND id=? AND version=?`, nextRevision, membership.ID, now, membership.GroupID, id, version)
		if err != nil {
			return err
		}
		if changed, _ := result.RowsAffected(); changed != 1 {
			return domain.ErrPrecondition
		}
		horizon := platform.Now().AddDate(1, 0, 0)
		if err := applySeriesRevisionTx(ctx, tx, membership.GroupID, timezone, status, membership.ID, revision, boundary, horizon); err != nil {
			return err
		}
		if status == "PUBLISHED" {
			notificationScope := seriesNotificationScope{FromSequence: &boundary.sequence, EventRevision: &nextRevision, IncludeMembershipIDs: previousRecipients}
			if err := syncSeriesRecipientsAndTask(ctx, tx, membership.GroupID, id, nextRevision, "PLANNING_SERIES_UPDATED", now, notificationScope); err != nil {
				return err
			}
		}
		return audit.Record(ctx, tx, membership.GroupID, actor.UserID, membership.ID, "planning.series.updated", "planning_series", id, map[string]any{"scope": command.Scope, "fromOriginalStartAt": boundary.originalStartAt, "fromSequence": boundary.sequence, "revision": nextRevision})
	})
	if err != nil {
		return Series{}, err
	}
	return s.GetSeries(ctx, membership, id)
}

// CancelSeries cancels future occurrences, including manually edited
// exceptions, in ALL or THIS_AND_FOLLOWING scope. Historical occurrences remain
// unchanged and a partial cancellation is persisted as a durable series range.
// actor and membership identify the editor and tenant, id selects the series,
// fromOriginalStartAt is required for THIS_AND_FOLLOWING, and version enforces
// optimistic concurrency. It returns a validation, authorization, not-found,
// conflict, precondition, or storage error.
//
// Example: err := service.CancelSeries(ctx, actor, membership, id, scope, boundary, version).
func (s Service) CancelSeries(ctx context.Context, actor domain.Principal, membership domain.Membership, id string, scope SeriesMutationScope, fromOriginalStartAt *string, version int64) error {
	if scope != SeriesScopeAll && scope != SeriesScopeThisAndFollowing {
		return domain.ValidationError{Field: "scope", Message: "must be ALL or THIS_AND_FOLLOWING"}
	}
	return storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		if err := enabled(ctx, tx, membership.GroupID); err != nil {
			return err
		}
		var owner, status string
		var revision, currentVersion int64
		if err := tx.QueryRowContext(ctx, `SELECT created_by_membership_id,status,current_revision,version FROM planning_series WHERE group_id=? AND id=?`, membership.GroupID, id).Scan(&owner, &status, &revision, &currentVersion); err != nil {
			return domain.ErrNotFound
		}
		if currentVersion != version {
			return domain.ErrPrecondition
		}
		if err := requireEventMutation(ctx, tx, membership, owner); err != nil {
			return err
		}
		if status != "PUBLISHED" {
			return domain.ErrConflict
		}
		boundary, err := seriesMutationBoundary(ctx, tx, id, scope, fromOriginalStartAt)
		if err != nil {
			return err
		}
		nowValue := platform.Now()
		now := platform.Timestamp(nowValue)
		nowMicros := nowValue.UnixMicro()
		current, err := loadSeriesRevision(ctx, tx, membership.GroupID, id, revision)
		if err != nil {
			return err
		}
		nextRevision := revision + 1
		current.Revision = nextRevision
		if err := insertSeriesRevision(ctx, tx, membership, current, now); err != nil {
			return err
		}
		if scope == SeriesScopeThisAndFollowing {
			if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO planning_series_cancelled_ranges(group_id,series_id,from_sequence,from_original_start_at,created_by_membership_id,created_at) VALUES(?,?,?,?,?,?)`, membership.GroupID, id, boundary.sequence, boundary.originalStartAt, membership.ID, now); err != nil {
				return err
			}
		}
		if _, err := tx.ExecContext(ctx, `UPDATE planning_notification_tasks SET status='CANCELLED',updated_at=? WHERE status='PENDING' AND event_id IN (SELECT event.id FROM planning_events event WHERE event.series_id=? AND event.series_sequence>=? AND `+eligibleSeriesEventSQL+`)`, now, id, boundary.sequence, nowMicros, nowMicros); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE planning_events SET series_revision=?,status='CANCELLED',cancelled_at=?,version=version+1,updated_at=? WHERE series_id=? AND series_sequence>=? AND `+eligibleSeriesRowSQL+` AND status='PUBLISHED'`, nextRevision, now, now, id, boundary.sequence, nowMicros, nowMicros); err != nil {
			return err
		}
		nextStatus := status
		if scope == SeriesScopeAll {
			nextStatus = "CANCELLED"
		}
		result, err := tx.ExecContext(ctx, `UPDATE planning_series SET status=?,current_revision=?,version=version+1,cancelled_at=CASE WHEN ?='CANCELLED' THEN ? ELSE cancelled_at END,updated_by_membership_id=?,updated_at=? WHERE group_id=? AND id=? AND version=?`, nextStatus, nextRevision, nextStatus, now, membership.ID, now, membership.GroupID, id, version)
		if err != nil {
			return err
		}
		if changed, _ := result.RowsAffected(); changed != 1 {
			return domain.ErrPrecondition
		}
		notificationScope := seriesNotificationScope{FromSequence: &boundary.sequence, EventRevision: &nextRevision, IncludeExceptions: true}
		if err := syncSeriesRecipientsAndTask(ctx, tx, membership.GroupID, id, nextRevision, "PLANNING_SERIES_CANCELLED", now, notificationScope); err != nil {
			return err
		}
		return audit.Record(ctx, tx, membership.GroupID, actor.UserID, membership.ID, "planning.series.cancelled", "planning_series", id, map[string]any{"scope": scope, "fromOriginalStartAt": boundary.originalStartAt, "fromSequence": boundary.sequence, "revision": nextRevision})
	})
}

// MaterializeSeries idempotently extends every enabled published series to a
// bounded horizon and refreshes only future, unmodified, unanswered audiences.
// ctx bounds database work and horizon is capped to roughly twelve months. It
// returns the number of newly inserted occurrences or a validation or storage
// error.
//
// Example: created, err := service.MaterializeSeries(ctx, time.Now().AddDate(1, 0, 0)).
func (s Service) MaterializeSeries(ctx context.Context, horizon time.Time) (int, error) {
	return s.materializeSeries(ctx, "", horizon)
}

func (s Service) materializeGroupSeries(ctx context.Context, groupID string, horizon time.Time) (int, error) {
	if strings.TrimSpace(groupID) == "" {
		return 0, domain.ValidationError{Field: "groupId", Message: "is required"}
	}
	return s.materializeSeries(ctx, groupID, horizon)
}

// materializeGroupSeriesWindow materializes the requesting tenant for one
// bounded calendar query. The range-specific implementation deliberately does
// not advance planning_series.materialized_through because a remote window is
// not proof of continuous coverage from the series anchor.
func (s Service) materializeGroupSeriesWindow(ctx context.Context, groupID string, from, to, fromDate, toDate time.Time) (int, error) {
	if strings.TrimSpace(groupID) == "" {
		return 0, domain.ValidationError{Field: "groupId", Message: "is required"}
	}
	if to.IsZero() && toDate.IsZero() {
		return 0, nil
	}
	// The range seeker below accepts instant and civil bounds separately. Until
	// it loads each series' pinned zone, retain the exact caller bounds here.
	return s.materializeSeriesRange(ctx, groupID, from, to, fromDate, toDate)
}

func (s Service) materializeSeriesRange(ctx context.Context, groupID string, from, to, fromDate, toDate time.Time) (int, error) {
	if s.DB == nil {
		return 0, errors.New("materialize planning series range: database is required")
	}
	// Preserve the legacy one-sided instant query without attempting an
	// unbounded remote backfill. Calendar clients send a complete bounded pair.
	if (from.IsZero() != to.IsZero()) && fromDate.IsZero() {
		return s.materializeGroupSeries(ctx, groupID, to)
	}
	rows, err := s.DB.QueryContext(ctx, `SELECT series.id FROM planning_series series
		JOIN group_planning_settings settings ON settings.group_id=series.group_id AND settings.enabled=1
		JOIN groups group_row ON group_row.id=series.group_id AND group_row.status='ACTIVE'
		WHERE series.group_id=? AND series.status='PUBLISHED' ORDER BY series.id`, groupID)
	if err != nil {
		return 0, err
	}
	seriesIDs := []string{}
	for rows.Next() {
		var seriesID string
		if err := rows.Scan(&seriesID); err != nil {
			rows.Close()
			return 0, err
		}
		seriesIDs = append(seriesIDs, seriesID)
	}
	if err := closeRows(rows); err != nil {
		return 0, err
	}
	created := 0
	for _, seriesID := range seriesIDs {
		err := storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
			var timezone, owner string
			var revisionNumber int64
			if err := tx.QueryRowContext(ctx, `SELECT timezone,created_by_membership_id,current_revision FROM planning_series WHERE group_id=? AND id=? AND status='PUBLISHED'`, groupID, seriesID).Scan(&timezone, &owner, &revisionNumber); errors.Is(err, sql.ErrNoRows) {
				return nil
			} else if err != nil {
				return err
			}
			revision, err := loadSeriesRevision(ctx, tx, groupID, seriesID, revisionNumber)
			if err != nil {
				return err
			}
			location, err := time.LoadLocation(timezone)
			if err != nil {
				return err
			}
			occurrences, err := seriesRevisionOccurrencesWindow(revision, location, from, to, fromDate, toDate)
			if err != nil {
				return err
			}
			ids, inserted, err := materializeOccurrenceSchedulesTx(ctx, tx, groupID, timezone, "PUBLISHED", owner, revision, occurrences)
			if err != nil {
				return err
			}
			created += inserted
			for _, eventID := range ids {
				var status string
				var exception bool
				if err := tx.QueryRowContext(ctx, `SELECT status,is_series_exception FROM planning_events WHERE id=?`, eventID).Scan(&status, &exception); err != nil {
					return err
				}
				if status == "PUBLISHED" && !exception {
					if err := syncUnansweredOccurrenceAudience(ctx, tx, groupID, eventID, revision); err != nil {
						return err
					}
				}
			}
			return syncSeriesRecipientsAndTask(ctx, tx, groupID, seriesID, revisionNumber, "PLANNING_SERIES_PUBLISHED", platform.Timestamp(platform.Now()), seriesNotificationScope{})
		})
		if err != nil {
			return created, err
		}
	}
	return created, nil
}

func (s Service) materializeSeries(ctx context.Context, groupID string, horizon time.Time) (int, error) {
	if s.DB == nil {
		return 0, errors.New("materialize planning series: database is required")
	}
	if horizon.IsZero() {
		return 0, domain.ValidationError{Field: "horizon", Message: "is required"}
	}
	horizon = horizon.UTC()
	maximum := platform.Now().AddDate(1, 0, 1)
	if horizon.After(maximum) {
		horizon = maximum
	}
	query := `SELECT series.id FROM planning_series series JOIN group_planning_settings settings ON settings.group_id=series.group_id AND settings.enabled=1 JOIN groups group_row ON group_row.id=series.group_id AND group_row.status='ACTIVE' WHERE series.status='PUBLISHED'`
	args := []any{}
	if groupID != "" {
		query += ` AND series.group_id=?`
		args = append(args, groupID)
	}
	query += ` ORDER BY series.id`
	rows, err := s.DB.QueryContext(ctx, query, args...)
	if err != nil {
		return 0, err
	}
	seriesIDs := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return 0, err
		}
		seriesIDs = append(seriesIDs, id)
	}
	if err := closeRows(rows); err != nil {
		return 0, err
	}
	created := 0
	for _, seriesID := range seriesIDs {
		err := storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
			var groupID, timezone, owner string
			var revisionNumber int64
			if err := tx.QueryRowContext(ctx, `SELECT group_id,timezone,created_by_membership_id,current_revision FROM planning_series WHERE id=? AND status='PUBLISHED'`, seriesID).Scan(&groupID, &timezone, &owner, &revisionNumber); errors.Is(err, sql.ErrNoRows) {
				return nil
			} else if err != nil {
				return err
			}
			revision, err := loadSeriesRevision(ctx, tx, groupID, seriesID, revisionNumber)
			if err != nil {
				return err
			}
			_, inserted, err := materializeRevisionTx(ctx, tx, groupID, timezone, "PUBLISHED", owner, revision, horizon)
			if err != nil {
				return err
			}
			created += inserted
			if err := syncFutureSeriesAudiences(ctx, tx, groupID, seriesID, horizon); err != nil {
				return err
			}
			now := platform.Timestamp(platform.Now())
			if _, err := tx.ExecContext(ctx, `UPDATE planning_series SET materialized_through=CASE WHEN materialized_through IS NULL OR materialized_through<? THEN ? ELSE materialized_through END WHERE id=?`, platform.Timestamp(horizon), platform.Timestamp(horizon), seriesID); err != nil {
				return err
			}
			return syncSeriesRecipientsAndTask(ctx, tx, groupID, seriesID, revisionNumber, "PLANNING_SERIES_PUBLISHED", now, seriesNotificationScope{})
		})
		if err != nil {
			return created, err
		}
	}
	return created, nil
}

func syncFutureSeriesAudiences(ctx context.Context, tx *sql.Tx, groupID, seriesID string, horizon time.Time) error {
	nowMicros := platform.Now().UnixMicro()
	rows, err := tx.QueryContext(ctx, `SELECT event.id,event.series_revision,event.version FROM planning_events event WHERE event.series_id=? AND event.status='PUBLISHED' AND `+eligibleSeriesEventSQL+` AND event.starts_at_us<=? AND event.is_series_exception=0 AND NOT EXISTS(SELECT 1 FROM planning_participations participation WHERE participation.event_id=event.id) ORDER BY event.starts_at_us,event.id`, seriesID, nowMicros, nowMicros, horizon.UTC().UnixMicro())
	if err != nil {
		return err
	}
	type item struct {
		eventID           string
		revision, version int64
	}
	items := []item{}
	for rows.Next() {
		var value item
		if err := rows.Scan(&value.eventID, &value.revision, &value.version); err != nil {
			rows.Close()
			return err
		}
		items = append(items, value)
	}
	if err := closeRows(rows); err != nil {
		return err
	}
	revisions := map[int64]seriesRevision{}
	for _, item := range items {
		revision, ok := revisions[item.revision]
		if !ok {
			loaded, err := loadSeriesRevision(ctx, tx, groupID, seriesID, item.revision)
			if err != nil {
				return err
			}
			revision, revisions[item.revision] = loaded, loaded
		}
		if err := syncUnansweredOccurrenceAudience(ctx, tx, groupID, item.eventID, revision); err != nil {
			return err
		}
	}
	return nil
}

func normalizeSeriesCommand(event *EventInput, recurrence *RecurrenceInput, location *time.Location) error {
	requested := strings.TrimSpace(event.TimeZone)
	if !event.AllDay && requested != "" {
		return domain.ValidationError{Field: "timeZone", Message: "must be omitted for a timed event"}
	}
	if event.AllDay && requested != "" && requested != location.String() {
		return domain.ValidationError{Field: "timeZone", Message: "must match the group time zone"}
	}
	event.TimeZone = location.String()
	if err := normalizeSeriesEvent(event); err != nil {
		return err
	}
	return normalizeRecurrence(recurrence, mustTime(event.StartsAt), location)
}

func normalizeSeriesEvent(event *EventInput) error {
	if err := normalizeEvent(event); err != nil {
		return err
	}
	if event.AllDay {
		startDate, err := parseCalendarDate("startDate", event.StartDate)
		if err != nil {
			return err
		}
		endDate, err := parseCalendarDate("endDateExclusive", event.EndDateExclusive)
		if err != nil {
			return err
		}
		durationDays := civilDayIndex(endDate) - civilDayIndex(startDate)
		if durationDays < 1 || durationDays > 7 {
			return domain.ValidationError{Field: "endDateExclusive", Message: "must be 1 to 7 calendar days after startDate for a recurring series"}
		}
		return nil
	}
	if event.EndsAt == nil {
		return domain.ValidationError{Field: "endsAt", Message: "is required for a recurring series"}
	}
	duration := mustTime(*event.EndsAt).Sub(mustTime(event.StartsAt))
	if duration < time.Minute || duration > 7*24*time.Hour || duration%time.Minute != 0 {
		return domain.ValidationError{Field: "endsAt", Message: "must define a whole-minute duration between 1 and 10080 minutes"}
	}
	return nil
}

func seriesEventInputEligible(event EventInput, now time.Time) bool {
	if event.AllDay {
		return event.EndsAt != nil && mustTime(*event.EndsAt).After(now)
	}
	return mustTime(event.StartsAt).After(now)
}

func seriesScheduleField(event EventInput) string {
	if event.AllDay {
		return "endDateExclusive"
	}
	return "startsAt"
}

func rebaseSeriesEventStart(event *EventInput, boundaryStart string, location *time.Location) {
	if event.AllDay {
		startDate, startErr := parseCalendarDate("startDate", event.StartDate)
		endDate, endErr := parseCalendarDate("endDateExclusive", event.EndDateExclusive)
		if startErr != nil || endErr != nil {
			return
		}
		durationDays := civilDayIndex(endDate) - civilDayIndex(startDate)
		boundaryLocal := mustTime(boundaryStart).In(location)
		rebasedDate := time.Date(boundaryLocal.Year(), boundaryLocal.Month(), boundaryLocal.Day(), 0, 0, 0, 0, time.UTC)
		event.StartDate = rebasedDate.Format(time.DateOnly)
		event.EndDateExclusive = rebasedDate.AddDate(0, 0, durationDays).Format(time.DateOnly)
		event.StartsAt = ""
		event.EndsAt = nil
		_ = normalizeEventSchedule(event)
		return
	}
	selectedStart := mustTime(event.StartsAt)
	duration := mustTime(*event.EndsAt).Sub(selectedStart)
	selectedLocal := selectedStart.In(location)
	boundaryLocal := mustTime(boundaryStart).In(location)
	rebased := resolveLocalTime(location, boundaryLocal.Year(), boundaryLocal.Month(), boundaryLocal.Day(), selectedLocal.Hour(), selectedLocal.Minute(), selectedLocal.Second(), selectedLocal.Nanosecond())
	event.StartsAt = platform.Timestamp(rebased)
	end := platform.Timestamp(rebased.Add(duration))
	event.EndsAt = &end
}

func revisionFromInput(seriesID string, revision int64, effectiveFrom string, effectiveFromSequence int64, event EventInput, recurrence RecurrenceInput) (seriesRevision, error) {
	var durationMinutes, durationDays *int
	if event.AllDay {
		startDate, err := parseCalendarDate("startDate", event.StartDate)
		if err != nil {
			return seriesRevision{}, err
		}
		endDate, err := parseCalendarDate("endDateExclusive", event.EndDateExclusive)
		if err != nil {
			return seriesRevision{}, err
		}
		value := civilDayIndex(endDate) - civilDayIndex(startDate)
		durationDays = &value
	} else {
		value := int(mustTime(*event.EndsAt).Sub(mustTime(event.StartsAt)) / time.Minute)
		durationMinutes = &value
	}
	return seriesRevision{
		SeriesID: seriesID, Revision: revision, EffectiveFromOriginalStartAt: effectiveFrom, EffectiveFromSequence: effectiveFromSequence,
		Title: event.Title, Description: event.Description, Location: event.Location, EventType: event.EventType,
		AudienceType: event.AudienceType, AllDay: event.AllDay, StartDate: event.StartDate, DurationDays: durationDays, StartsAt: event.StartsAt, DurationMinutes: durationMinutes,
		ResponseDeadlineMinutesBefore: event.ResponseDeadlineMinutesBefore, Capacity: event.Capacity,
		WaitlistEnabled: event.WaitlistEnabled,
		Recurrence:      recurrence, TargetRoleIDs: event.TargetRoleIDs, TargetMembershipIDs: event.TargetMembershipIDs,
	}, nil
}

func insertSeriesRevision(ctx context.Context, tx *sql.Tx, membership domain.Membership, revision seriesRevision, now string) error {
	weekdays, err := json.Marshal(revision.Recurrence.Weekdays)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO planning_series_revisions(group_id,series_id,revision,effective_from_original_start_at,effective_from_sequence,title,description,location,event_type,audience_type,all_day,start_date,duration_days,starts_at,duration_minutes,response_deadline_minutes_before,capacity,waitlist_enabled,frequency,interval_value,weekdays_json,monthly_mode,range_type,occurrence_count,until_at,created_by_membership_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, membership.GroupID, revision.SeriesID, revision.Revision, revision.EffectiveFromOriginalStartAt, revision.EffectiveFromSequence, revision.Title, revision.Description, revision.Location, revision.EventType, revision.AudienceType, revision.AllDay, nullableString(revision.StartDate), revision.DurationDays, revision.StartsAt, revision.DurationMinutes, revision.ResponseDeadlineMinutesBefore, revision.Capacity, revision.WaitlistEnabled, revision.Recurrence.Frequency, revision.Recurrence.Interval, string(weekdays), nullableString(revision.Recurrence.MonthlyMode), revision.Recurrence.Range.Type, revision.Recurrence.Range.Count, revision.Recurrence.Range.Until, membership.ID, now)
	if err != nil {
		return err
	}
	return replaceSeriesTargets(ctx, tx, membership.GroupID, revision.SeriesID, revision.Revision, revision.AudienceType, revision.TargetRoleIDs, revision.TargetMembershipIDs)
}

func loadSeriesRevision(ctx context.Context, tx *sql.Tx, groupID, seriesID string, revisionNumber int64) (seriesRevision, error) {
	var revision seriesRevision
	var weekdaysJSON string
	var monthlyMode sql.NullString
	var count sql.NullInt64
	var until sql.NullString
	err := tx.QueryRowContext(ctx, `SELECT series_id,revision,effective_from_original_start_at,effective_from_sequence,title,description,location,event_type,audience_type,all_day,coalesce(start_date,''),duration_days,starts_at,duration_minutes,response_deadline_minutes_before,capacity,waitlist_enabled,frequency,interval_value,weekdays_json,monthly_mode,range_type,occurrence_count,until_at FROM planning_series_revisions WHERE group_id=? AND series_id=? AND revision=?`, groupID, seriesID, revisionNumber).Scan(&revision.SeriesID, &revision.Revision, &revision.EffectiveFromOriginalStartAt, &revision.EffectiveFromSequence, &revision.Title, &revision.Description, &revision.Location, &revision.EventType, &revision.AudienceType, &revision.AllDay, &revision.StartDate, &revision.DurationDays, &revision.StartsAt, &revision.DurationMinutes, &revision.ResponseDeadlineMinutesBefore, &revision.Capacity, &revision.WaitlistEnabled, &revision.Recurrence.Frequency, &revision.Recurrence.Interval, &weekdaysJSON, &monthlyMode, &revision.Recurrence.Range.Type, &count, &until)
	if err != nil {
		return seriesRevision{}, err
	}
	if err := json.Unmarshal([]byte(weekdaysJSON), &revision.Recurrence.Weekdays); err != nil {
		return seriesRevision{}, err
	}
	if monthlyMode.Valid {
		revision.Recurrence.MonthlyMode = monthlyMode.String
	}
	if count.Valid {
		value := int(count.Int64)
		revision.Recurrence.Range.Count = &value
	}
	if until.Valid {
		revision.Recurrence.Range.Until = &until.String
	}
	revision.TargetRoleIDs, err = stringsFor(tx.QueryContext(ctx, `SELECT role_id FROM planning_series_target_roles WHERE series_id=? AND revision=? ORDER BY role_id`, seriesID, revisionNumber))
	if err != nil {
		return seriesRevision{}, err
	}
	revision.TargetMembershipIDs, err = stringsFor(tx.QueryContext(ctx, `SELECT membership_id FROM planning_series_target_memberships WHERE series_id=? AND revision=? ORDER BY membership_id`, seriesID, revisionNumber))
	return revision, err
}

func replaceSeriesTargets(ctx context.Context, tx *sql.Tx, groupID, seriesID string, revision int64, audienceType string, roleIDs, membershipIDs []string) error {
	if audienceType == AudienceSelectedTargets && len(roleIDs)+len(membershipIDs) == 0 {
		return domain.ValidationError{Field: "audience", Message: "must include at least one role or membership"}
	}
	if audienceType == AudienceSelectedRoles && len(roleIDs) == 0 {
		return domain.ValidationError{Field: "targetRoleIds", Message: "must not be empty"}
	}
	if audienceType == AudienceSelectedMembers && len(membershipIDs) == 0 {
		return domain.ValidationError{Field: "targetMembershipIds", Message: "must not be empty"}
	}
	if audienceType == AudienceSelectedRoles || audienceType == AudienceSelectedTargets {
		for _, roleID := range roleIDs {
			if _, err := tx.ExecContext(ctx, `INSERT INTO planning_series_target_roles(group_id,series_id,revision,role_id) VALUES(?,?,?,?)`, groupID, seriesID, revision, roleID); err != nil {
				return domain.ValidationError{Field: "targetRoleIds", Message: "contains an invalid role"}
			}
		}
	}
	if audienceType == AudienceSelectedMembers || audienceType == AudienceSelectedTargets {
		for _, membershipID := range membershipIDs {
			if _, err := tx.ExecContext(ctx, `INSERT INTO planning_series_target_memberships(group_id,series_id,revision,membership_id) VALUES(?,?,?,?)`, groupID, seriesID, revision, membershipID); err != nil {
				return domain.ValidationError{Field: "targetMembershipIds", Message: "contains an invalid membership"}
			}
		}
	}
	return nil
}

func ensureSeriesAudienceResolves(ctx context.Context, tx *sql.Tx, groupID, audienceType string, roleIDs, membershipIDs []string) error {
	if audienceType == AudienceSelectedRoles && len(roleIDs) == 0 {
		return domain.ValidationError{Field: "targetRoleIds", Message: "must not be empty"}
	}
	if audienceType == AudienceSelectedMembers && len(membershipIDs) == 0 {
		return domain.ValidationError{Field: "targetMembershipIds", Message: "must not be empty"}
	}
	if audienceType == AudienceSelectedTargets && len(roleIDs)+len(membershipIDs) == 0 {
		return domain.ValidationError{Field: "audience", Message: "must include at least one role or membership"}
	}
	filter, args := audienceCandidateFilter(groupID, audienceType, roleIDs, membershipIDs)
	var count int
	if err := tx.QueryRowContext(ctx, `SELECT count(*)`+filter, args...).Scan(&count); err != nil {
		return err
	}
	if count == 0 {
		return domain.ValidationError{Field: "audience", Message: "must contain at least one active member"}
	}
	return nil
}

func materializeRevisionTx(ctx context.Context, tx *sql.Tx, groupID, timezone, status, ownerMembershipID string, revision seriesRevision, horizon time.Time) ([]string, int, error) {
	location, err := time.LoadLocation(timezone)
	if err != nil {
		return nil, 0, err
	}
	occurrences, err := seriesRevisionOccurrences(revision, location, horizon)
	if err != nil {
		return nil, 0, err
	}
	return materializeOccurrenceSchedulesTx(ctx, tx, groupID, timezone, status, ownerMembershipID, revision, occurrences)
}

func materializeOccurrenceSchedulesTx(ctx context.Context, tx *sql.Tx, groupID, timezone, status, ownerMembershipID string, revision seriesRevision, occurrences []seriesOccurrenceSchedule) ([]string, int, error) {
	ids := []string{}
	inserted := 0
	for _, occurrence := range occurrences {
		sequence := revision.EffectiveFromSequence + occurrence.recurrenceIndex
		var cancelledRange bool
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM planning_series_cancelled_ranges WHERE series_id=? AND from_sequence<=?)`, revision.SeriesID, sequence).Scan(&cancelledRange); err != nil {
			return nil, inserted, err
		}
		if cancelledRange {
			continue
		}
		var id string
		err := tx.QueryRowContext(ctx, `SELECT id FROM planning_events WHERE series_id=? AND series_sequence=? LIMIT 1`, revision.SeriesID, sequence).Scan(&id)
		if err == nil {
			ids = append(ids, id)
			continue
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return nil, inserted, err
		}
		id, err = insertSeriesOccurrenceTx(ctx, tx, groupID, status, ownerMembershipID, timezone, revision, sequence, occurrence)
		if err != nil {
			return nil, inserted, err
		}
		inserted++
		ids = append(ids, id)
	}
	return ids, inserted, nil
}

type seriesOccurrenceSchedule struct {
	start            time.Time
	end              time.Time
	startDate        string
	endDateExclusive string
	recurrenceIndex  int64
}

func seriesRevisionOccurrences(revision seriesRevision, location *time.Location, horizon time.Time) ([]seriesOccurrenceSchedule, error) {
	if !revision.AllDay {
		if revision.DurationMinutes == nil {
			return nil, errors.New("materialize timed planning series: duration is missing")
		}
		anchor := mustTime(revision.StartsAt)
		localAnchor := anchor.In(location)
		lastLocal := horizon.In(location)
		dates := recurrenceOccurrenceDatesBetween(anchor, location, revision.Recurrence,
			civilDate(localAnchor, location), civilDate(lastLocal, location))
		result := make([]seriesOccurrenceSchedule, 0, len(dates))
		for _, occurrence := range dates {
			start := resolveLocalTime(location, occurrence.date.Year(), occurrence.date.Month(), occurrence.date.Day(), localAnchor.Hour(), localAnchor.Minute(), localAnchor.Second(), localAnchor.Nanosecond())
			if start.Before(anchor) || start.After(horizon) {
				continue
			}
			result = append(result, seriesOccurrenceSchedule{start: start, end: start.Add(time.Duration(*revision.DurationMinutes) * time.Minute), recurrenceIndex: occurrence.index})
		}
		return result, nil
	}
	if revision.DurationDays == nil {
		return nil, errors.New("materialize all-day planning series: duration is missing")
	}
	anchorDate, err := parseCalendarDate("startDate", revision.StartDate)
	if err != nil {
		return nil, err
	}
	anchor, err := calendarDateBoundary("startDate", anchorDate, location)
	if err != nil {
		return nil, err
	}
	lastLocal := horizon.In(location)
	dates := recurrenceOccurrenceDatesBetween(anchor, location, revision.Recurrence,
		civilDate(anchor.In(location), location), civilDate(lastLocal, location))
	result := make([]seriesOccurrenceSchedule, 0, len(dates))
	for _, occurrence := range dates {
		localDate := occurrence.date
		startDate := time.Date(localDate.Year(), localDate.Month(), localDate.Day(), 0, 0, 0, 0, time.UTC)
		endDate := startDate.AddDate(0, 0, *revision.DurationDays)
		start, err := calendarDateBoundary("startDate", startDate, location)
		if err != nil {
			return nil, err
		}
		end, err := calendarDateBoundary("endDateExclusive", endDate, location)
		if err != nil {
			return nil, err
		}
		result = append(result, seriesOccurrenceSchedule{
			start: start, end: end, startDate: startDate.Format(time.DateOnly), endDateExclusive: endDate.Format(time.DateOnly), recurrenceIndex: occurrence.index,
		})
	}
	return result, nil
}

func seriesRevisionOccurrencesWindow(revision seriesRevision, location *time.Location, from, to, fromDate, toDate time.Time) ([]seriesOccurrenceSchedule, error) {
	if !revision.AllDay {
		if from.IsZero() || to.IsZero() {
			return nil, nil
		}
		if revision.DurationMinutes == nil {
			return nil, errors.New("materialize timed planning series: duration is missing")
		}
		anchor := mustTime(revision.StartsAt)
		localAnchor := anchor.In(location)
		duration := time.Duration(*revision.DurationMinutes) * time.Minute
		firstLocal := from.Add(-duration).In(location)
		lastLocal := to.In(location)
		dates := recurrenceOccurrenceDatesBetween(anchor, location, revision.Recurrence,
			civilDate(firstLocal, location), civilDate(lastLocal, location))
		result := make([]seriesOccurrenceSchedule, 0, len(dates))
		for _, occurrence := range dates {
			start := resolveLocalTime(location, occurrence.date.Year(), occurrence.date.Month(), occurrence.date.Day(), localAnchor.Hour(), localAnchor.Minute(), localAnchor.Second(), localAnchor.Nanosecond())
			end := start.Add(duration)
			if end.After(from) && start.Before(to) {
				result = append(result, seriesOccurrenceSchedule{start: start, end: end, recurrenceIndex: occurrence.index})
			}
		}
		return result, nil
	}
	if revision.DurationDays == nil {
		return nil, errors.New("materialize all-day planning series: duration is missing")
	}
	anchorDate, err := parseCalendarDate("startDate", revision.StartDate)
	if err != nil {
		return nil, err
	}
	anchor, err := calendarDateBoundary("startDate", anchorDate, location)
	if err != nil {
		return nil, err
	}
	var firstCivil, lastCivil time.Time
	useCivil := !fromDate.IsZero() && !toDate.IsZero()
	if useCivil {
		firstCivil = fromDate.AddDate(0, 0, 1-*revision.DurationDays)
		lastCivil = toDate.AddDate(0, 0, -1)
	} else {
		if from.IsZero() || to.IsZero() {
			return nil, nil
		}
		first := from.In(location).AddDate(0, 0, 1-*revision.DurationDays)
		last := to.In(location)
		firstCivil = time.Date(first.Year(), first.Month(), first.Day(), 0, 0, 0, 0, time.UTC)
		lastCivil = time.Date(last.Year(), last.Month(), last.Day(), 0, 0, 0, 0, time.UTC)
	}
	dates := recurrenceOccurrenceDatesBetween(anchor, location, revision.Recurrence, firstCivil, lastCivil)
	result := make([]seriesOccurrenceSchedule, 0, len(dates))
	for _, occurrence := range dates {
		startDate := time.Date(occurrence.date.Year(), occurrence.date.Month(), occurrence.date.Day(), 0, 0, 0, 0, time.UTC)
		endDate := startDate.AddDate(0, 0, *revision.DurationDays)
		if useCivil && !(civilDayIndex(endDate) > civilDayIndex(fromDate) && civilDayIndex(startDate) < civilDayIndex(toDate)) {
			continue
		}
		start, err := calendarDateBoundary("startDate", startDate, location)
		if err != nil {
			return nil, err
		}
		end, err := calendarDateBoundary("endDateExclusive", endDate, location)
		if err != nil {
			return nil, err
		}
		if !useCivil && !(end.After(from) && start.Before(to)) {
			continue
		}
		result = append(result, seriesOccurrenceSchedule{
			start: start, end: end, startDate: startDate.Format(time.DateOnly), endDateExclusive: endDate.Format(time.DateOnly), recurrenceIndex: occurrence.index,
		})
	}
	return result, nil
}

func insertSeriesOccurrenceTx(ctx context.Context, tx *sql.Tx, groupID, status, ownerMembershipID, timezone string, revision seriesRevision, sequence int64, occurrence seriesOccurrenceSchedule) (string, error) {
	id, err := platform.NewID("pev")
	if err != nil {
		return "", err
	}
	start := platform.Timestamp(occurrence.start)
	endValue := platform.Timestamp(occurrence.end)
	end := &endValue
	deadline := responseDeadline(start, revision.ResponseDeadlineMinutesBefore)
	now := platform.Timestamp(platform.Now())
	version := int64(1)
	publishedAt := any(nil)
	if status == "PUBLISHED" {
		publishedAt = now
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO planning_events(id,group_id,series_id,series_revision,series_sequence,original_start_at,original_start_date,title,description,location,event_type,status,audience_type,all_day,timezone,start_date,end_date_exclusive,starts_at,ends_at,response_deadline,response_deadline_minutes_before,capacity,waitlist_enabled,version,created_by_membership_id,updated_by_membership_id,published_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, groupID, revision.SeriesID, revision.Revision, sequence, start, nullableString(occurrence.startDate), revision.Title, revision.Description, revision.Location, revision.EventType, status, revision.AudienceType, revision.AllDay, timezone, nullableString(occurrence.startDate), nullableString(occurrence.endDateExclusive), start, end, deadline, revision.ResponseDeadlineMinutesBefore, revision.Capacity, revision.WaitlistEnabled, version, ownerMembershipID, ownerMembershipID, publishedAt, now, now)
	if err != nil {
		return "", err
	}
	if err := replaceEventTargets(ctx, tx, groupID, id, revision.AudienceType, revision.TargetRoleIDs, revision.TargetMembershipIDs); err != nil {
		return "", err
	}
	if status == "PUBLISHED" {
		if err := addAudienceWithNotification(ctx, tx, groupID, id, revision.AudienceType, revision.TargetRoleIDs, revision.TargetMembershipIDs, version, false); err != nil {
			return "", err
		}
	}
	return id, nil
}

func applySeriesRevisionTx(ctx context.Context, tx *sql.Tx, groupID, timezone, seriesStatus, ownerMembershipID string, revision seriesRevision, boundary seriesBoundary, horizon time.Time) error {
	location, err := time.LoadLocation(timezone)
	if err != nil {
		return err
	}
	occurrences, err := seriesRevisionOccurrences(revision, location, horizon)
	if err != nil {
		return err
	}
	desired := map[int64]seriesOccurrenceSchedule{}
	for _, occurrence := range occurrences {
		if seriesOccurrenceEligible(occurrence, revision.AllDay, platform.Now()) {
			sequence := boundary.sequence + occurrence.recurrenceIndex
			var cancelledRange bool
			if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM planning_series_cancelled_ranges WHERE series_id=? AND from_sequence<=?)`, revision.SeriesID, sequence).Scan(&cancelledRange); err != nil {
				return err
			}
			if !cancelledRange {
				desired[sequence] = occurrence
			}
		}
	}
	nowValue := platform.Now()
	rows, err := tx.QueryContext(ctx, `SELECT id,series_sequence,original_start_at,status,starts_at,version,is_series_exception,all_day,coalesce(start_date,''),coalesce(end_date_exclusive,'') FROM planning_events WHERE series_id=? AND series_sequence>=? AND (is_series_exception=1 OR (((all_day=1 AND ends_at_us>?) OR (all_day=0 AND starts_at_us>?)) AND status='PUBLISHED')) ORDER BY series_sequence`, revision.SeriesID, boundary.sequence, nowValue.UnixMicro(), nowValue.UnixMicro())
	if err != nil {
		return err
	}
	type existingOccurrence struct {
		id, original, status, starts, startDate, endDateExclusive string
		sequence, version                                         int64
		exception, allDay                                         bool
	}
	existing := map[int64]existingOccurrence{}
	for rows.Next() {
		var item existingOccurrence
		if err := rows.Scan(&item.id, &item.sequence, &item.original, &item.status, &item.starts, &item.version, &item.exception, &item.allDay, &item.startDate, &item.endDateExclusive); err != nil {
			rows.Close()
			return err
		}
		existing[item.sequence] = item
	}
	if err := closeRows(rows); err != nil {
		return err
	}
	now := platform.Timestamp(nowValue)
	for sequence, occurrence := range desired {
		item, exists := existing[sequence]
		if !exists {
			if _, err := insertSeriesOccurrenceTx(ctx, tx, groupID, seriesStatus, ownerMembershipID, timezone, revision, sequence, occurrence); err != nil {
				return err
			}
			continue
		}
		delete(existing, sequence)
		if item.exception {
			continue
		}
		if err := validateRegistrationStateChange(ctx, tx, item.id, revision.Capacity, revision.WaitlistEnabled); err != nil {
			return err
		}
		start := platform.Timestamp(occurrence.start)
		end := platform.Timestamp(occurrence.end)
		deadline := responseDeadline(start, revision.ResponseDeadlineMinutesBefore)
		_, err := tx.ExecContext(ctx, `UPDATE planning_events SET series_revision=?,title=?,description=?,location=?,event_type=?,audience_type=?,all_day=?,timezone=?,start_date=?,end_date_exclusive=?,original_start_date=CASE WHEN ?=1 THEN coalesce(original_start_date,?) ELSE NULL END,starts_at=?,ends_at=?,response_deadline=?,response_deadline_minutes_before=?,capacity=?,waitlist_enabled=?,version=version+1,updated_by_membership_id=?,updated_at=? WHERE id=? AND version=?`, revision.Revision, revision.Title, revision.Description, revision.Location, revision.EventType, revision.AudienceType, revision.AllDay, timezone, nullableString(occurrence.startDate), nullableString(occurrence.endDateExclusive), revision.AllDay, occurrence.startDate, start, end, deadline, revision.ResponseDeadlineMinutesBefore, revision.Capacity, revision.WaitlistEnabled, ownerMembershipID, now, item.id, item.version)
		if err != nil {
			return err
		}
		if err := replaceEventTargets(ctx, tx, groupID, item.id, revision.AudienceType, revision.TargetRoleIDs, revision.TargetMembershipIDs); err != nil {
			return err
		}
		if item.status == "PUBLISHED" {
			if err := syncUnansweredOccurrenceAudience(ctx, tx, groupID, item.id, revision); err != nil {
				return err
			}
		}
	}
	for _, item := range existing {
		if item.exception {
			continue
		}
		if _, err := tx.ExecContext(ctx, `UPDATE planning_events SET series_revision=?,status='CANCELLED',cancelled_at=?,version=version+1,updated_at=? WHERE id=? AND version=?`, revision.Revision, now, now, item.id, item.version); err != nil {
			return err
		}
	}
	return nil
}

func seriesOccurrenceEligible(occurrence seriesOccurrenceSchedule, allDay bool, now time.Time) bool {
	if allDay {
		return occurrence.end.After(now)
	}
	return occurrence.start.After(now)
}

func syncUnansweredOccurrenceAudience(ctx context.Context, tx *sql.Tx, groupID, eventID string, revision seriesRevision) error {
	var hasParticipation bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM planning_participations WHERE event_id=?)`, eventID).Scan(&hasParticipation); err != nil {
		return err
	}
	if hasParticipation {
		return nil
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM planning_event_audience WHERE event_id=?`, eventID); err != nil {
		return err
	}
	return addAudienceWithNotification(ctx, tx, groupID, eventID, revision.AudienceType, revision.TargetRoleIDs, revision.TargetMembershipIDs, 1, false)
}

type seriesNotificationScope struct {
	FromSequence         *int64
	EventRevision        *int64
	IncludeMembershipIDs []string
	IncludeExceptions    bool
}

func affectedSeriesRecipientIDs(ctx context.Context, tx *sql.Tx, seriesID string, fromSequence int64) ([]string, error) {
	nowMicros := platform.Now().UnixMicro()
	return stringsFor(tx.QueryContext(ctx, `SELECT DISTINCT audience.membership_id FROM planning_event_audience audience JOIN planning_events event ON event.id=audience.event_id WHERE event.series_id=? AND event.series_sequence>=? AND `+eligibleSeriesEventSQL+` AND event.is_series_exception=0 AND event.status='PUBLISHED' ORDER BY audience.membership_id`, seriesID, fromSequence, nowMicros, nowMicros))
}

func syncSeriesRecipientsAndTask(ctx context.Context, tx *sql.Tx, groupID, seriesID string, revision int64, eventType, now string, scope seriesNotificationScope) error {
	query := `SELECT DISTINCT audience.membership_id FROM planning_event_audience audience JOIN planning_events event ON event.id=audience.event_id WHERE event.series_id=? AND event.status IN ('PUBLISHED','CLOSED','CANCELLED')`
	args := []any{seriesID}
	if scope.FromSequence != nil {
		query += ` AND event.series_sequence>=? AND ` + eligibleSeriesEventSQL
		nowMicros := platform.Now().UnixMicro()
		args = append(args, *scope.FromSequence, nowMicros, nowMicros)
		if !scope.IncludeExceptions {
			query += ` AND event.is_series_exception=0`
		}
	}
	if scope.EventRevision != nil {
		query += ` AND event.series_revision=?`
		args = append(args, *scope.EventRevision)
	}
	query += ` ORDER BY audience.membership_id`
	currentRecipients, err := stringsFor(tx.QueryContext(ctx, query, args...))
	if err != nil {
		return err
	}
	seen := make(map[string]struct{}, len(currentRecipients)+len(scope.IncludeMembershipIDs))
	mergedRecipients := make([]string, 0, len(currentRecipients)+len(scope.IncludeMembershipIDs))
	for _, membershipID := range append(currentRecipients, scope.IncludeMembershipIDs...) {
		if _, exists := seen[membershipID]; exists {
			continue
		}
		seen[membershipID] = struct{}{}
		mergedRecipients = append(mergedRecipients, membershipID)
	}
	currentRecipients = mergedRecipients
	newRecipients := make([]string, 0, len(currentRecipients))
	for _, membershipID := range currentRecipients {
		result, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO planning_series_recipients(group_id,series_id,membership_id,first_notified_at,last_synced_at) VALUES(?,?,?,?,?)`, groupID, seriesID, membershipID, now, now)
		if err != nil {
			return err
		}
		inserted, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if inserted == 1 {
			newRecipients = append(newRecipients, membershipID)
			continue
		}
		if _, err := tx.ExecContext(ctx, `UPDATE planning_series_recipients SET last_synced_at=? WHERE group_id=? AND series_id=? AND membership_id=?`, now, groupID, seriesID, membershipID); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, `UPDATE planning_series_notification_tasks SET status='CANCELLED',updated_at=? WHERE series_id=? AND status='PENDING' AND series_revision<?`, now, seriesID, revision); err != nil {
		return err
	}
	recipients := currentRecipients
	if eventType == "PLANNING_SERIES_PUBLISHED" {
		recipients = newRecipients
	}
	for _, membershipID := range recipients {
		taskID, err := platform.NewID("pst")
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO planning_series_notification_tasks(id,group_id,series_id,target_membership_id,event_type,series_revision,status,scheduled_for,created_at,updated_at) VALUES(?,?,?,?,?,?,'PENDING',?,?,?)`, taskID, groupID, seriesID, membershipID, eventType, revision, now, now, now); err != nil {
			return err
		}
	}
	return nil
}

type seriesBoundary struct {
	originalStartAt string
	startsAt        string
	startDate       string
	sequence        int64
}

func seriesMutationBoundary(ctx context.Context, tx *sql.Tx, seriesID string, scope SeriesMutationScope, requested *string) (seriesBoundary, error) {
	if scope == SeriesScopeThisAndFollowing {
		if requested == nil {
			return seriesBoundary{}, domain.ValidationError{Field: "fromOriginalStartAt", Message: "is required"}
		}
		parsed, err := time.Parse(time.RFC3339, *requested)
		if err != nil {
			return seriesBoundary{}, domain.ValidationError{Field: "fromOriginalStartAt", Message: "must be RFC 3339"}
		}
		boundary := platform.Timestamp(parsed)
		var sequence int64
		var startsAt, endAt, startDate string
		var allDay bool
		if err := tx.QueryRowContext(ctx, `SELECT series_sequence,starts_at,ends_at,all_day,coalesce(start_date,'') FROM planning_events WHERE series_id=? AND original_start_at=?`, seriesID, boundary).Scan(&sequence, &startsAt, &endAt, &allDay, &startDate); errors.Is(err, sql.ErrNoRows) {
			return seriesBoundary{}, domain.ValidationError{Field: "fromOriginalStartAt", Message: "does not identify an occurrence in this series"}
		} else if err != nil {
			return seriesBoundary{}, err
		}
		if (!allDay && !mustTime(startsAt).After(platform.Now())) || (allDay && !mustTime(endAt).After(platform.Now())) {
			return seriesBoundary{}, domain.ValidationError{Field: "fromOriginalStartAt", Message: "must identify a current or future occurrence"}
		}
		return seriesBoundary{originalStartAt: boundary, startsAt: startsAt, startDate: startDate, sequence: sequence}, nil
	}
	var boundary seriesBoundary
	nowMicros := platform.Now().UnixMicro()
	if err := tx.QueryRowContext(ctx, `SELECT event.original_start_at,event.starts_at,coalesce(event.start_date,''),event.series_sequence FROM planning_events event WHERE event.series_id=? AND `+eligibleSeriesEventSQL+` AND event.is_series_exception=0 AND event.status='PUBLISHED' ORDER BY event.series_sequence LIMIT 1`, seriesID, nowMicros, nowMicros).Scan(&boundary.originalStartAt, &boundary.startsAt, &boundary.startDate, &boundary.sequence); errors.Is(err, sql.ErrNoRows) {
		return seriesBoundary{}, domain.ErrConflict
	} else if err != nil {
		return seriesBoundary{}, err
	}
	return boundary, nil
}

func (s Service) seriesLocation(ctx context.Context, groupID string) (*time.Location, string, error) {
	var timezone string
	if err := s.DB.QueryRowContext(ctx, `SELECT timezone FROM group_notification_settings WHERE group_id=?`, groupID).Scan(&timezone); err != nil {
		return nil, "", err
	}
	location, err := time.LoadLocation(timezone)
	if err != nil {
		return nil, "", domain.ValidationError{Field: "timeZone", Message: "is unsupported"}
	}
	return location, timezone, nil
}

const seriesProjectionQuery = `SELECT series.id,series.status,series.timezone,revision.event_type,revision.title,revision.description,revision.location,revision.all_day,coalesce(revision.start_date,''),coalesce(revision.duration_days,0),coalesce(revision.duration_minutes,0),revision.response_deadline_minutes_before,revision.capacity,revision.waitlist_enabled,revision.audience_type,revision.frequency,revision.interval_value,revision.weekdays_json,coalesce(revision.monthly_mode,''),revision.range_type,revision.occurrence_count,revision.until_at,series.version,series.created_at,series.updated_at,series.created_by_membership_id,series.current_revision,revision.starts_at FROM planning_series series JOIN planning_series_revisions revision ON revision.series_id=series.id AND revision.revision=series.current_revision`

func scanSeries(scanner rowScanner) (Series, error) {
	var series Series
	var weekdaysJSON string
	var count sql.NullInt64
	var until sql.NullString
	err := scanner.Scan(&series.ID, &series.Status, &series.TimeZone, &series.EventType, &series.Title, &series.Description, &series.Location, &series.AllDay, &series.StartDate, &series.DurationDays, &series.DurationMinutes, &series.ResponseDeadlineMinutesBefore, &series.Capacity, &series.WaitlistEnabled, &series.AudienceType, &series.Recurrence.Frequency, &series.Recurrence.Interval, &weekdaysJSON, &series.Recurrence.MonthlyMode, &series.Recurrence.Range.Type, &count, &until, &series.Version, &series.CreatedAt, &series.UpdatedAt, &series.ownerMembershipID, &series.currentRevision, &series.anchorStartsAt)
	if err != nil {
		return Series{}, err
	}
	if err := json.Unmarshal([]byte(weekdaysJSON), &series.Recurrence.Weekdays); err != nil {
		return Series{}, err
	}
	if count.Valid {
		value := int(count.Int64)
		series.Recurrence.Range.Count = &value
	}
	if until.Valid {
		series.Recurrence.Range.Until = &until.String
	}
	return series, nil
}

func hydrateSeriesTargets(ctx context.Context, db authorization.Queryer, series *Series) error {
	series.TargetRoleIDs = []string{}
	series.TargetMembershipIDs = []string{}
	roles, err := stringsFor(db.QueryContext(ctx, `SELECT role_id FROM planning_series_target_roles WHERE series_id=? AND revision=? ORDER BY role_id`, series.ID, series.currentRevision))
	if err != nil {
		return err
	}
	members, err := stringsFor(db.QueryContext(ctx, `SELECT membership_id FROM planning_series_target_memberships WHERE series_id=? AND revision=? ORDER BY membership_id`, series.ID, series.currentRevision))
	if err != nil {
		return err
	}
	series.TargetRoleIDs, series.TargetMembershipIDs = roles, members
	return nil
}

func nullableString(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return value
}
