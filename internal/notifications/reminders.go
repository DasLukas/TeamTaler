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

const defaultReminderPollInterval = time.Minute

// ReminderWorker creates durable settlement reminder notifications from local
// calendar schedules. It is safe to run in a single process; database uniqueness
// and serialized transactions also prevent duplicate work after restarts.
type ReminderWorker struct {
	db            *sql.DB
	notifications Service
	logger        *slog.Logger
	now           func() time.Time
	pollInterval  time.Duration
}

// NewReminderWorker constructs a settlement reminder worker.
//
// Parameters:
//   - db: Migrated TeamTaler database.
//   - service: Notification service used for canonical in-app and external jobs.
//   - logger: Optional structured logger; nil selects slog.Default.
//
// Returns:
//   - *ReminderWorker: A configured worker ready for Run or ProcessDue.
//   - error: A validation error when db or service database is missing.
//
// Example: worker, err := notifications.NewReminderWorker(db, service, logger).
func NewReminderWorker(db *sql.DB, service Service, logger *slog.Logger) (*ReminderWorker, error) {
	if db == nil || service.DB == nil {
		return nil, errors.New("create settlement reminder worker: database and notification service are required")
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &ReminderWorker{db: db, notifications: service, logger: logger, now: func() time.Time { return time.Now().UTC() }, pollInterval: defaultReminderPollInterval}, nil
}

// Run evaluates reminders immediately and then at the configured interval until
// ctx is cancelled. Individual processing failures are logged without stopping
// later retries; invalid worker state is returned before any work starts.
func (w *ReminderWorker) Run(ctx context.Context) error {
	if ctx == nil {
		return errors.New("run settlement reminder worker: context is required")
	}
	if w == nil || w.db == nil || w.notifications.DB == nil || w.now == nil || w.pollInterval <= 0 {
		return errors.New("run settlement reminder worker: worker is not fully configured")
	}
	process := func() {
		if _, err := w.ProcessDue(ctx, w.now()); err != nil && ctx.Err() == nil {
			w.logger.Error("settlement reminder processing failed", "error", err)
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

// ProcessDue creates at most one catch-up reminder per outstanding statement at
// now. It uses each group's IANA time zone and 09:00 local schedule, re-checks
// current outstanding amounts transactionally, and returns the created count.
// Invalid persisted dates or time zones and database failures are returned.
func (w *ReminderWorker) ProcessDue(ctx context.Context, now time.Time) (int, error) {
	if w == nil || w.db == nil || w.notifications.DB == nil {
		return 0, errors.New("process settlement reminders: worker is not fully configured")
	}
	if now.IsZero() {
		return 0, errors.New("process settlement reminders: current time is required")
	}
	horizon := now.UTC().AddDate(0, 0, 31).Format("2006-01-02")
	rows, err := w.db.QueryContext(ctx, `SELECT statement.id
		FROM period_statements statement
		JOIN periods period ON period.id=statement.period_id AND period.group_id=statement.group_id
		JOIN memberships membership ON membership.id=statement.membership_id AND membership.group_id=statement.group_id
		JOIN users user ON user.id=membership.user_id
		JOIN groups group_row ON group_row.id=statement.group_id
		WHERE period.due_at IS NOT NULL AND period.due_at<=?
		  AND membership.status='ACTIVE' AND membership.deleted_at IS NULL
		  AND user.active=1 AND group_row.status='ACTIVE'
		  AND EXISTS(SELECT 1 FROM group_notification_events event
		      WHERE event.group_id=statement.group_id
		        AND event.event_type IN ('SETTLEMENT_DUE_SOON','SETTLEMENT_OVERDUE'))
		ORDER BY period.due_at,statement.id`, horizon)
	if err != nil {
		return 0, err
	}
	statementIDs := make([]string, 0)
	for rows.Next() {
		var statementID string
		if err := rows.Scan(&statementID); err != nil {
			rows.Close()
			return 0, err
		}
		statementIDs = append(statementIDs, statementID)
	}
	if err := rows.Close(); err != nil {
		return 0, err
	}
	created := 0
	for _, statementID := range statementIDs {
		createdOne := false
		err := storage.WithTx(ctx, w.db, func(tx *sql.Tx) error {
			var err error
			createdOne, err = w.processStatementTx(ctx, tx, statementID, now)
			return err
		})
		if err != nil {
			return created, fmt.Errorf("process settlement reminder: %w", err)
		}
		if createdOne {
			created++
		}
	}
	return created, nil
}

type reminderStatement struct {
	id, groupID, membershipID string
	periodLabel, dueAt        string
	currency, timezone        string
	dueSoonDays, repeatDays   int
	amountDue                 int64
	dueSoonEnabled            bool
	overdueEnabled            bool
}

func (w *ReminderWorker) processStatementTx(ctx context.Context, tx *sql.Tx, statementID string, now time.Time) (bool, error) {
	item, err := loadReminderStatement(ctx, tx, statementID)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if item.amountDue <= 0 {
		return false, nil
	}
	location, err := time.LoadLocation(item.timezone)
	if err != nil {
		return false, fmt.Errorf("load group time zone: %w", err)
	}
	dueDate, err := time.ParseInLocation("2006-01-02", item.dueAt, location)
	if err != nil {
		return false, fmt.Errorf("parse settlement due date: %w", err)
	}
	eventType, occurrenceDate, scheduled := reminderOccurrence(now.In(location), dueDate, item.dueSoonDays, item.repeatDays, item.dueSoonEnabled, item.overdueEnabled)
	if !scheduled {
		return false, nil
	}
	var alreadyCreated bool
	dedupeQuery := `SELECT EXISTS(SELECT 1 FROM notification_reminder_runs WHERE statement_id=? AND event_type=? AND occurrence_date=?)`
	if eventType == TypeSettlementDueSoon {
		dedupeQuery = `SELECT EXISTS(SELECT 1 FROM notification_reminder_runs WHERE statement_id=? AND event_type=? AND occurrence_date IS NOT NULL)`
	}
	dedupeArgs := []any{item.id, eventType, occurrenceDate}
	if eventType == TypeSettlementDueSoon {
		dedupeArgs = []any{item.id, eventType}
	}
	if err := tx.QueryRowContext(ctx, dedupeQuery, dedupeArgs...).Scan(&alreadyCreated); err != nil {
		return false, err
	}
	if alreadyCreated {
		return false, nil
	}
	createdAt := platform.Timestamp(now.UTC())
	title := "Settlement due soon"
	body := "An open settlement is due soon."
	if eventType == TypeSettlementOverdue {
		title = "Settlement overdue"
		body = "A settlement remains overdue."
	}
	notification, err := w.notifications.CreateTx(ctx, tx, CreateInput{
		GroupID: item.groupID, MembershipID: item.membershipID, Type: eventType,
		Title: title, Body: body, ResourceType: "statement", ResourceID: item.id, CreatedAt: createdAt,
		Context: EventContext{AmountMinor: item.amountDue, Currency: item.currency, PeriodLabel: item.periodLabel, DueAt: item.dueAt},
	})
	if err != nil {
		return false, err
	}
	if notification.ID == "" {
		return false, nil
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO notification_reminder_runs(group_id,statement_id,event_type,occurrence_date,notification_id,created_at)
		VALUES(?,?,?,?,?,?)`, item.groupID, item.id, eventType, occurrenceDate, notification.ID, createdAt)
	if err != nil {
		return false, err
	}
	return true, nil
}

func loadReminderStatement(ctx context.Context, tx *sql.Tx, statementID string) (reminderStatement, error) {
	var item reminderStatement
	err := tx.QueryRowContext(ctx, `SELECT statement.id,statement.group_id,statement.membership_id,period.label,period.due_at,
		group_row.currency,settings.timezone,settings.settlement_due_soon_days,settings.settlement_overdue_repeat_days,
		statement.charges_minor
		  + coalesce((SELECT sum(adjustment.amount_minor) FROM period_adjustment_allocations adjustment WHERE adjustment.source_period_id=statement.period_id AND adjustment.membership_id=statement.membership_id),0)
		  - coalesce((SELECT sum(allocation.amount_minor) FROM payment_allocations allocation JOIN payments payment ON payment.id=allocation.payment_id WHERE allocation.period_id=statement.period_id AND payment.membership_id=statement.membership_id AND payment.reversed_at IS NULL),0)
		  - coalesce((SELECT sum(adjustment.amount_minor) FROM period_adjustment_allocations adjustment WHERE adjustment.target_period_id=statement.period_id AND adjustment.membership_id=statement.membership_id),0),
		EXISTS(SELECT 1 FROM group_notification_events event WHERE event.group_id=statement.group_id AND event.event_type='SETTLEMENT_DUE_SOON'),
		EXISTS(SELECT 1 FROM group_notification_events event WHERE event.group_id=statement.group_id AND event.event_type='SETTLEMENT_OVERDUE')
		FROM period_statements statement
		JOIN periods period ON period.id=statement.period_id AND period.group_id=statement.group_id
		JOIN groups group_row ON group_row.id=statement.group_id AND group_row.status='ACTIVE'
		JOIN group_notification_settings settings ON settings.group_id=statement.group_id
		JOIN memberships membership ON membership.id=statement.membership_id AND membership.group_id=statement.group_id
		JOIN users user ON user.id=membership.user_id
		WHERE statement.id=? AND period.due_at IS NOT NULL AND membership.status='ACTIVE'
		  AND membership.deleted_at IS NULL AND user.active=1`, statementID).
		Scan(&item.id, &item.groupID, &item.membershipID, &item.periodLabel, &item.dueAt, &item.currency, &item.timezone,
			&item.dueSoonDays, &item.repeatDays, &item.amountDue, &item.dueSoonEnabled, &item.overdueEnabled)
	return item, err
}

func reminderOccurrence(now, dueDate time.Time, dueSoonDays, repeatDays int, dueSoonEnabled, overdueEnabled bool) (EventType, string, bool) {
	today := dateOnly(now)
	due := dateOnly(dueDate)
	firstOverdue := due.AddDate(0, 0, 1)
	if overdueEnabled && !today.Before(firstOverdue) {
		occurrence := firstOverdue
		if repeatDays > 0 {
			elapsed := calendarDaysBetween(firstOverdue, today)
			occurrence = firstOverdue.AddDate(0, 0, (elapsed/repeatDays)*repeatDays)
		}
		if !now.Before(atNineLocal(occurrence)) {
			return TypeSettlementOverdue, occurrence.Format("2006-01-02"), true
		}
		if repeatDays > 0 {
			previous := occurrence.AddDate(0, 0, -repeatDays)
			if !previous.Before(firstOverdue) {
				return TypeSettlementOverdue, previous.Format("2006-01-02"), true
			}
		}
	}
	dueSoon := due.AddDate(0, 0, -dueSoonDays)
	if dueSoonEnabled && !today.Before(dueSoon) && !today.After(due) && !now.Before(atNineLocal(dueSoon)) {
		return TypeSettlementDueSoon, dueSoon.Format("2006-01-02"), true
	}
	return "", "", false
}

func dateOnly(value time.Time) time.Time {
	year, month, day := value.Date()
	return time.Date(year, month, day, 0, 0, 0, 0, value.Location())
}

func atNineLocal(date time.Time) time.Time {
	year, month, day := date.Date()
	return time.Date(year, month, day, 9, 0, 0, 0, date.Location())
}

func calendarDaysBetween(from, to time.Time) int {
	fromYear, fromMonth, fromDay := from.Date()
	toYear, toMonth, toDay := to.Date()
	fromUTC := time.Date(fromYear, fromMonth, fromDay, 0, 0, 0, 0, time.UTC)
	toUTC := time.Date(toYear, toMonth, toDay, 0, 0, 0, 0, time.UTC)
	return int(toUTC.Sub(fromUTC) / (24 * time.Hour))
}
