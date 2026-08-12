package email

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/DasLukas/TeamTaler/internal/notifications"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

// NotificationDispatcher delivers durable notification email jobs with a
// bounded worker pool, database leases, at most five attempts, and sanitized
// failure codes. Construct it with NewNotificationDispatcher and call Run from
// the server lifecycle.
type NotificationDispatcher struct {
	db            *sql.DB
	sender        Sender
	publicURL     string
	logger        *slog.Logger
	now           func() time.Time
	workerCount   int
	pollInterval  time.Duration
	leaseDuration time.Duration
}

// NewNotificationDispatcher validates db, sender, publicURL, and logger without
// performing network or database I/O. publicURL must be an absolute root HTTP(S)
// URL. A nil logger selects slog.Default. It returns a configured dispatcher or
// a validation error.
//
// Example:
//
//	dispatcher, err := email.NewNotificationDispatcher(db, sender, publicURL, logger)
func NewNotificationDispatcher(db *sql.DB, sender Sender, publicURL *url.URL, logger *slog.Logger) (*NotificationDispatcher, error) {
	if db == nil || sender == nil {
		return nil, errors.New("create notification email dispatcher: database and sender are required")
	}
	if publicURL == nil || publicURL.Host == "" || (publicURL.Scheme != "http" && publicURL.Scheme != "https") || publicURL.User != nil || publicURL.RawQuery != "" || publicURL.Fragment != "" || (publicURL.Path != "" && publicURL.Path != "/") {
		return nil, errors.New("create notification email dispatcher: public URL must be an absolute root HTTP(S) URL")
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &NotificationDispatcher{
		db: db, sender: sender, publicURL: strings.TrimSuffix(publicURL.String(), "/"), logger: logger,
		now: func() time.Time { return time.Now().UTC() }, workerCount: defaultWorkerCount,
		pollInterval: defaultPollInterval, leaseDuration: defaultLeaseDuration,
	}, nil
}

// Run processes notification email jobs until ctx is cancelled. ctx is required.
// Delivery failures are persisted and retried rather than returned. It returns
// a configuration error before starting, ErrUnavailable when SMTP is disabled,
// or nil after cancellation and worker shutdown.
func (d *NotificationDispatcher) Run(ctx context.Context) error {
	if ctx == nil {
		return errors.New("run notification email dispatcher: context is required")
	}
	if d == nil || d.db == nil || d.sender == nil || d.now == nil || d.workerCount < 1 || d.workerCount > defaultWorkerCount || d.pollInterval <= 0 || d.leaseDuration <= 0 {
		return errors.New("run notification email dispatcher: dispatcher is not fully configured")
	}
	if !d.sender.Available() {
		return fmt.Errorf("run notification email dispatcher: %w", ErrUnavailable)
	}
	var workers sync.WaitGroup
	workers.Add(d.workerCount)
	for index := 0; index < d.workerCount; index++ {
		go func() {
			defer workers.Done()
			d.runWorker(ctx)
		}()
	}
	workers.Wait()
	return nil
}

type claimedNotification struct {
	notificationID string
	leaseToken     string
	attemptCount   int
}

type notificationDelivery struct {
	toAddress string
	toName    string
	groupName string
	eventType string
	context   notifications.EventContext
}

func (d *NotificationDispatcher) runWorker(ctx context.Context) {
	for ctx.Err() == nil {
		processed, err := d.processOne(ctx)
		if err != nil {
			d.logger.Error("notification email outbox processing failed", "error", err)
		}
		if processed && err == nil {
			continue
		}
		timer := time.NewTimer(d.pollInterval)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
			return
		case <-timer.C:
		}
	}
}

func (d *NotificationDispatcher) processOne(ctx context.Context) (bool, error) {
	job, found, err := d.claimNext(ctx)
	if err != nil || !found {
		return found, err
	}
	if ctx.Err() != nil {
		d.releaseAfterCancellation(job)
		return true, nil
	}
	delivery, err := d.loadDelivery(ctx, job.notificationID)
	if err != nil {
		if ctx.Err() != nil {
			d.releaseAfterCancellation(job)
			return true, nil
		}
		if errors.Is(err, sql.ErrNoRows) {
			return true, withCompletionContext(func(completionContext context.Context) error {
				return d.markUndeliverable(completionContext, job)
			})
		}
		return true, withCompletionContext(func(completionContext context.Context) error {
			return d.recordFailure(completionContext, job, FailureCodeDeliveryFailed)
		})
	}
	title, body := renderNotificationCopy(delivery.eventType, delivery.context)
	message := NotificationMessage{
		ToAddress: delivery.toAddress, ToName: delivery.toName, GroupName: delivery.groupName,
		Title: title, Body: body, ActionURL: d.publicURL + "/notifications",
	}
	err = d.sender.SendNotification(ctx, message)
	if err == nil {
		return true, withCompletionContext(func(completionContext context.Context) error { return d.markSent(completionContext, job) })
	}
	if ctx.Err() != nil || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		d.releaseAfterCancellation(job)
		return true, nil
	}
	code := FailureCodeDeliveryFailed
	if errors.Is(err, ErrUnavailable) {
		code = FailureCodeEmailUnavailable
	}
	return true, withCompletionContext(func(completionContext context.Context) error { return d.recordFailure(completionContext, job, code) })
}

func (d *NotificationDispatcher) claimNext(ctx context.Context) (claimedNotification, bool, error) {
	leaseToken, err := platform.NewSecret()
	if err != nil {
		return claimedNotification{}, false, err
	}
	now := d.now().UTC()
	nowText := platform.Timestamp(now)
	leaseUntil := platform.Timestamp(now.Add(d.leaseDuration))
	var job claimedNotification
	found := false
	err = storage.WithTx(ctx, d.db, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `UPDATE notification_email_outbox SET status='PENDING',lease_token=NULL,lease_until=NULL,next_attempt_at=?,updated_at=? WHERE status='SENDING' AND lease_until<=?`, nowText, nowText, nowText); err != nil {
			return err
		}
		err := tx.QueryRowContext(ctx, `SELECT notification_id,attempt_count FROM notification_email_outbox WHERE status='PENDING' AND next_attempt_at<=? ORDER BY next_attempt_at,created_at LIMIT 1`, nowText).Scan(&job.notificationID, &job.attemptCount)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		job.attemptCount++
		result, err := tx.ExecContext(ctx, `UPDATE notification_email_outbox SET status='SENDING',attempt_count=?,next_attempt_at=NULL,lease_token=?,lease_until=?,updated_at=? WHERE notification_id=? AND status='PENDING'`, job.attemptCount, leaseToken, leaseUntil, nowText, job.notificationID)
		if err != nil {
			return err
		}
		changed, _ := result.RowsAffected()
		found = changed == 1
		return nil
	})
	job.leaseToken = leaseToken
	return job, found, err
}

func (d *NotificationDispatcher) loadDelivery(ctx context.Context, notificationID string) (notificationDelivery, error) {
	var delivery notificationDelivery
	var contextJSON string
	err := d.db.QueryRowContext(ctx, `SELECT u.email,u.display_name,g.name,n.type,n.context_json
		FROM notifications n
		JOIN memberships m ON m.id=n.membership_id AND m.group_id=n.group_id
		JOIN users u ON u.id=m.user_id
		JOIN groups g ON g.id=n.group_id
		WHERE n.id=? AND u.email IS NOT NULL`, notificationID).Scan(&delivery.toAddress, &delivery.toName, &delivery.groupName, &delivery.eventType, &contextJSON)
	if err != nil {
		return notificationDelivery{}, err
	}
	if err := json.Unmarshal([]byte(contextJSON), &delivery.context); err != nil {
		return notificationDelivery{}, err
	}
	return delivery, nil
}

func (d *NotificationDispatcher) markSent(ctx context.Context, job claimedNotification) error {
	now := platform.Timestamp(d.now().UTC())
	result, err := d.db.ExecContext(ctx, `UPDATE notification_email_outbox SET status='SENT',sent_at=?,lease_token=NULL,lease_until=NULL,last_error_code=NULL,updated_at=? WHERE notification_id=? AND status='SENDING' AND lease_token=?`, now, now, job.notificationID, job.leaseToken)
	if err != nil {
		return err
	}
	changed, _ := result.RowsAffected()
	if changed != 1 {
		return errors.New("notification email lease was lost before completion")
	}
	return nil
}

func (d *NotificationDispatcher) markUndeliverable(ctx context.Context, job claimedNotification) error {
	now := platform.Timestamp(d.now().UTC())
	result, err := d.db.ExecContext(ctx, `UPDATE notification_email_outbox
		SET status='FAILED',next_attempt_at=NULL,lease_token=NULL,lease_until=NULL,last_error_code=?,updated_at=?
		WHERE notification_id=? AND status='SENDING' AND lease_token=?`, FailureCodeRecipientUnavailable, now, job.notificationID, job.leaseToken)
	if err != nil {
		return err
	}
	changed, _ := result.RowsAffected()
	if changed != 1 {
		return errors.New("notification email lease was lost before recipient failure recording")
	}
	return nil
}

func (d *NotificationDispatcher) recordFailure(ctx context.Context, job claimedNotification, code FailureCode) error {
	now := d.now().UTC()
	status := string(OutboxStatusFailed)
	var nextAttempt any
	if job.attemptCount < maximumDeliveryAttempts {
		status = string(OutboxStatusPending)
		nextAttempt = platform.Timestamp(now.Add(retryDelay(job.attemptCount)))
	}
	result, err := d.db.ExecContext(ctx, `UPDATE notification_email_outbox SET status=?,next_attempt_at=?,lease_token=NULL,lease_until=NULL,last_error_code=?,updated_at=? WHERE notification_id=? AND status='SENDING' AND lease_token=?`, status, nextAttempt, code, platform.Timestamp(now), job.notificationID, job.leaseToken)
	if err != nil {
		return err
	}
	changed, _ := result.RowsAffected()
	if changed != 1 {
		return errors.New("notification email lease was lost before failure recording")
	}
	return nil
}

func (d *NotificationDispatcher) releaseAfterCancellation(job claimedNotification) {
	_ = withCompletionContext(func(ctx context.Context) error {
		now := platform.Timestamp(d.now().UTC())
		_, err := d.db.ExecContext(ctx, `UPDATE notification_email_outbox SET status='PENDING',attempt_count=max(attempt_count-1,0),next_attempt_at=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE notification_id=? AND status='SENDING' AND lease_token=?`, now, now, job.notificationID, job.leaseToken)
		return err
	})
}

func renderNotificationCopy(eventType string, context notifications.EventContext) (string, string) {
	actor := safeInline(context.ActorName)
	item := safeInline(context.ItemName)
	amount := formatEmailMoney(context.AmountMinor, context.Currency)
	switch eventType {
	case notifications.TypeBookingAssigned:
		return "Neue Buchung", fmt.Sprintf("%s hat dir %d × „%s“ über %s zugewiesen.", actor, context.Quantity, item, amount)
	case notifications.TypeBookingReversed:
		return "Buchung storniert", fmt.Sprintf("%s hat %d × „%s“ über %s auf deinem Konto storniert.", actor, context.Quantity, item, amount)
	case notifications.TypePaymentRecorded:
		return "Zahlung erfasst", fmt.Sprintf("%s hat eine Zahlung über %s für dich erfasst.", actor, amount)
	case notifications.TypePaymentReversed:
		return "Zahlung storniert", fmt.Sprintf("%s hat eine Zahlung über %s auf deinem Konto storniert.", actor, amount)
	case notifications.TypeSettlementCreated:
		label := safeInline(context.PeriodLabel)
		if context.AmountMinor > 0 {
			return "Neue Abrechnung", fmt.Sprintf("Die Abrechnung „%s“ ist bereit. Offen sind %s, fällig am %s.", label, amount, safeInline(context.DueAt))
		}
		if context.AmountMinor < 0 {
			return "Neue Abrechnung", fmt.Sprintf("Die Abrechnung „%s“ ist bereit und weist ein Guthaben über %s aus.", label, formatEmailMoney(-context.AmountMinor, context.Currency))
		}
		return "Neue Abrechnung", fmt.Sprintf("Die Abrechnung „%s“ ist bereit. Es ist keine Zahlung offen.", label)
	default:
		return "Neue Benachrichtigung", "In deiner TeamTaler-Gruppe gibt es eine neue Aktivität."
	}
}

func safeInline(value string) string {
	return strings.Join(strings.Fields(value), " ")
}

func formatEmailMoney(amount int64, currency string) string {
	digits := 2
	switch strings.ToUpper(currency) {
	case "BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF":
		digits = 0
	case "BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND":
		digits = 3
	case "CLF":
		digits = 4
	}
	sign := ""
	if amount < 0 {
		sign = "−"
		amount = -amount
	}
	if digits == 0 {
		return sign + strconv.FormatInt(amount, 10) + " " + strings.ToUpper(currency)
	}
	factor := int64(1)
	for index := 0; index < digits; index++ {
		factor *= 10
	}
	whole, fraction := amount/factor, amount%factor
	return fmt.Sprintf("%s%d,%0*d %s", sign, whole, digits, fraction, strings.ToUpper(currency))
}
