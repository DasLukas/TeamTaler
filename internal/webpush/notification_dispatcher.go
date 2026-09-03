package webpush

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/DasLukas/TeamTaler/internal/notifications"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
	push "github.com/marknefedov/go-webpush/v2"
)

const (
	maximumPushAttempts = 10
	pushWorkerCount     = 4
	pushPollInterval    = 5 * time.Second
	pushLeaseDuration   = 2 * time.Minute
	pushDeliveryTTL     = 24 * time.Hour
)

var pushRetryDelays = [...]time.Duration{
	time.Minute, 5 * time.Minute, 15 * time.Minute, time.Hour,
	3 * time.Hour, 6 * time.Hour, 6 * time.Hour, 6 * time.Hour, 6 * time.Hour,
}

// RuntimeConfiguration contains the current trusted VAPID material required by
// one delivery attempt. PrivateKey must never be logged.
type RuntimeConfiguration struct {
	Enabled    bool
	Subject    string
	PrivateKey string
	KeyID      string
}

// RuntimeResolver loads one current Web Push configuration snapshot. Delivery
// workers call it again immediately before sending to honor disable/rotation.
type RuntimeResolver func(context.Context) (RuntimeConfiguration, error)

// NotificationSender is the delivery boundary implemented by Sender and test
// fakes. Implementations must honor ctx and must not log subscription material.
type NotificationSender interface {
	Send(context.Context, []byte, *push.Subscription, string, string, time.Duration, push.Urgency) error
}

// NotificationDispatcher leases and delivers durable PUSH jobs with bounded
// concurrency, expiration, retry, rotation, and subscription-revocation rules.
type NotificationDispatcher struct {
	db            *sql.DB
	subscriptions *SubscriptionService
	sender        NotificationSender
	resolve       RuntimeResolver
	logger        *slog.Logger
	now           func() time.Time
	workerCount   int
	pollInterval  time.Duration
	leaseDuration time.Duration
}

// NewNotificationDispatcher validates dependencies without database or network
// I/O. logger may be nil to use slog.Default. The returned dispatcher is started
// with Run.
func NewNotificationDispatcher(db *sql.DB, subscriptions *SubscriptionService, sender NotificationSender, resolve RuntimeResolver, logger *slog.Logger) (*NotificationDispatcher, error) {
	if db == nil || subscriptions == nil || sender == nil || resolve == nil {
		return nil, fmt.Errorf("create Web Push dispatcher: database, subscriptions, sender, and resolver are required")
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &NotificationDispatcher{
		db: db, subscriptions: subscriptions, sender: sender, resolve: resolve, logger: logger,
		now: func() time.Time { return time.Now().UTC() }, workerCount: pushWorkerCount,
		pollInterval: pushPollInterval, leaseDuration: pushLeaseDuration,
	}, nil
}

// Run processes PUSH delivery jobs until ctx is cancelled. Delivery failures
// are persisted and retried rather than terminating the worker pool.
func (d *NotificationDispatcher) Run(ctx context.Context) error {
	if ctx == nil {
		return fmt.Errorf("run Web Push dispatcher: context is required")
	}
	if d == nil || d.db == nil || d.subscriptions == nil || d.sender == nil || d.resolve == nil ||
		d.now == nil || d.workerCount < 1 || d.workerCount > pushWorkerCount || d.pollInterval <= 0 || d.leaseDuration <= 0 {
		return fmt.Errorf("run Web Push dispatcher: dispatcher is not fully configured")
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

type claimedPushJob struct {
	id             string
	notificationID string
	subscriptionID string
	leaseToken     string
	attemptCount   int
	expiresAt      time.Time
}

type pushDelivery struct {
	groupName string
	eventType notifications.EventType
}

func (d *NotificationDispatcher) runWorker(ctx context.Context) {
	for ctx.Err() == nil {
		processed, err := d.processOne(ctx)
		if err != nil {
			d.logger.Error("Web Push outbox processing failed", "error", err)
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
	configuration, err := d.resolve(ctx)
	if err != nil || !runtimeConfigurationUsable(configuration) {
		return false, err
	}
	job, found, err := d.claimNext(ctx)
	if err != nil || !found {
		return found, err
	}
	if ctx.Err() != nil {
		d.releaseAfterCancellation(job)
		return true, nil
	}
	policyCode, err := notifications.CheckDeliveryPolicy(ctx, d.db, job.id, notifications.ChannelPush)
	if err != nil {
		d.releaseWithoutAttempt(job)
		return true, err
	}
	if policyCode != "" {
		return true, withPushCompletionContext(func(completionContext context.Context) error {
			return d.markTerminal(completionContext, job, "FAILED", policyCode)
		})
	}
	delivery, err := d.loadDelivery(ctx, job, configuration.KeyID)
	if err != nil {
		if ctx.Err() != nil {
			d.releaseAfterCancellation(job)
			return true, nil
		}
		return true, withPushCompletionContext(func(completionContext context.Context) error {
			return d.markTerminal(completionContext, job, "FAILED", "recipient_or_subscription_unavailable")
		})
	}
	definition, found := notifications.Definition(delivery.eventType)
	if !found {
		return true, withPushCompletionContext(func(completionContext context.Context) error {
			return d.markTerminal(completionContext, job, "FAILED", "unsupported_event")
		})
	}
	stored, err := d.subscriptions.LoadActive(ctx, job.subscriptionID, configuration.KeyID)
	if err != nil {
		return true, withPushCompletionContext(func(completionContext context.Context) error {
			return d.markTerminal(completionContext, job, "FAILED", "subscription_unavailable")
		})
	}
	// Re-resolve configuration and identity immediately before external I/O. A
	// rotation, disable, account reassignment, or membership change loses this
	// attempt without leaking the prior recipient's event.
	configuration, err = d.resolve(ctx)
	if err != nil {
		d.releaseWithoutAttempt(job)
		return true, nil
	}
	if !runtimeConfigurationUsable(configuration) || configuration.KeyID != stored.VAPIDKeyID {
		d.releaseWithoutAttempt(job)
		return true, nil
	}
	if valid, err := d.identityStillValid(ctx, job, stored.UserID, configuration.KeyID); err != nil || !valid {
		if err != nil {
			d.releaseWithoutAttempt(job)
			return true, nil
		}
		return true, withPushCompletionContext(func(completionContext context.Context) error {
			return d.markTerminal(completionContext, job, "FAILED", "recipient_or_subscription_unavailable")
		})
	}
	policyCode, err = notifications.CheckDeliveryPolicy(ctx, d.db, job.id, notifications.ChannelPush)
	if err != nil {
		d.releaseWithoutAttempt(job)
		return true, err
	}
	if policyCode != "" {
		return true, withPushCompletionContext(func(completionContext context.Context) error {
			return d.markTerminal(completionContext, job, "FAILED", policyCode)
		})
	}
	payload, err := json.Marshal(map[string]string{
		"notificationId": job.notificationID,
		"groupName":      delivery.groupName,
		"eventLabel":     definition.PushBody,
		"route":          definition.Route,
	})
	if err != nil {
		return true, err
	}
	ttl := time.Duration(definition.PushTTLSeconds) * time.Second
	if ttl <= 0 || ttl > pushDeliveryTTL {
		ttl = pushDeliveryTTL
	}
	urgency := push.Urgency(definition.PushUrgency)
	switch urgency {
	case push.UrgencyVeryLow, push.UrgencyLow, push.UrgencyNormal, push.UrgencyHigh:
	default:
		urgency = push.UrgencyNormal
	}
	err = d.sender.Send(ctx, payload, stored.Subscription, configuration.Subject, configuration.PrivateKey, ttl, urgency)
	if err == nil {
		return true, withPushCompletionContext(func(completionContext context.Context) error {
			if err := d.markSent(completionContext, job); err != nil {
				return err
			}
			if err := d.subscriptions.MarkUsed(completionContext, job.subscriptionID); err != nil {
				d.logger.Warn("record Web Push subscription activity", "error", err)
			}
			return nil
		})
	}
	if ctx.Err() != nil || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		d.releaseAfterCancellation(job)
		return true, nil
	}
	var deliveryErr DeliveryError
	if errors.As(err, &deliveryErr) && deliveryErr.Revoke {
		return true, withPushCompletionContext(func(completionContext context.Context) error {
			if err := d.subscriptions.RevokeExpired(completionContext, job.subscriptionID); err != nil {
				return err
			}
			return d.markTerminal(completionContext, job, "FAILED", "subscription_expired")
		})
	}
	return true, withPushCompletionContext(func(completionContext context.Context) error {
		return d.recordFailure(completionContext, job, deliveryErr)
	})
}

func runtimeConfigurationUsable(configuration RuntimeConfiguration) bool {
	return configuration.Enabled && strings.TrimSpace(configuration.Subject) != "" &&
		strings.TrimSpace(configuration.PrivateKey) != "" && strings.TrimSpace(configuration.KeyID) != ""
}

func (d *NotificationDispatcher) claimNext(ctx context.Context) (claimedPushJob, bool, error) {
	leaseToken, err := platform.NewSecret()
	if err != nil {
		return claimedPushJob{}, false, err
	}
	now := d.now().UTC()
	nowText := platform.Timestamp(now)
	leaseUntil := platform.Timestamp(now.Add(d.leaseDuration))
	var job claimedPushJob
	var expiresAtText string
	found := false
	err = storage.WithTx(ctx, d.db, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `UPDATE notification_delivery_jobs SET status='EXPIRED',next_attempt_at=NULL,
			lease_token=NULL,lease_until=NULL,last_error_code='expired',updated_at=?
			WHERE channel='PUSH' AND status IN ('PENDING','SENDING') AND expires_at<=?`, nowText, nowText); err != nil {
			return fmt.Errorf("expire Web Push jobs: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `UPDATE notification_delivery_jobs SET status='PENDING',next_attempt_at=?,
			lease_token=NULL,lease_until=NULL,last_error_code='lease_expired',updated_at=?
			WHERE channel='PUSH' AND status='SENDING' AND lease_until<=? AND expires_at>?`, nowText, nowText, nowText, nowText); err != nil {
			return fmt.Errorf("recover Web Push leases: %w", err)
		}
		err := tx.QueryRowContext(ctx, `SELECT id,notification_id,push_subscription_id,attempt_count,expires_at
			FROM notification_delivery_jobs WHERE channel='PUSH' AND status='PENDING'
			AND next_attempt_at<=? AND expires_at>? AND attempt_count<?
			ORDER BY next_attempt_at,created_at,id LIMIT 1`, nowText, nowText, maximumPushAttempts).
			Scan(&job.id, &job.notificationID, &job.subscriptionID, &job.attemptCount, &expiresAtText)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("select Web Push job: %w", err)
		}
		job.expiresAt, err = time.Parse(time.RFC3339Nano, expiresAtText)
		if err != nil {
			return fmt.Errorf("parse Web Push job expiration: %w", err)
		}
		job.attemptCount++
		result, err := tx.ExecContext(ctx, `UPDATE notification_delivery_jobs SET status='SENDING',attempt_count=?,
			next_attempt_at=NULL,lease_token=?,lease_until=?,last_error_code=NULL,updated_at=?
			WHERE id=? AND channel='PUSH' AND status='PENDING'`, job.attemptCount, leaseToken, leaseUntil, nowText, job.id)
		if err != nil {
			return fmt.Errorf("claim Web Push job: %w", err)
		}
		changed, err := result.RowsAffected()
		if err != nil {
			return fmt.Errorf("count claimed Web Push job: %w", err)
		}
		found = changed == 1
		return nil
	})
	job.leaseToken = leaseToken
	return job, found, err
}

func (d *NotificationDispatcher) loadDelivery(ctx context.Context, job claimedPushJob, keyID string) (pushDelivery, error) {
	var delivery pushDelivery
	err := d.db.QueryRowContext(ctx, `SELECT team.name,notification.type
		FROM notification_delivery_jobs job
		JOIN notifications notification ON notification.id=job.notification_id AND notification.group_id=job.group_id
		JOIN memberships membership ON membership.id=notification.membership_id AND membership.group_id=job.group_id
		JOIN users recipient ON recipient.id=membership.user_id
		JOIN web_push_subscriptions subscription ON subscription.id=job.push_subscription_id AND subscription.user_id=recipient.id
		JOIN groups team ON team.id=job.group_id
		WHERE job.id=? AND job.channel='PUSH' AND job.status='SENDING' AND job.lease_token=?
		  AND membership.status='ACTIVE' AND membership.deleted_at IS NULL AND recipient.active=1
		  AND subscription.revoked_at IS NULL AND subscription.vapid_key_id=? AND team.status='ACTIVE'`,
		job.id, job.leaseToken, keyID).Scan(&delivery.groupName, &delivery.eventType)
	return delivery, err
}

func (d *NotificationDispatcher) identityStillValid(ctx context.Context, job claimedPushJob, userID, keyID string) (bool, error) {
	var valid bool
	err := d.db.QueryRowContext(ctx, `SELECT EXISTS(
		SELECT 1 FROM notification_delivery_jobs job
		JOIN notifications notification ON notification.id=job.notification_id AND notification.group_id=job.group_id
		JOIN memberships membership ON membership.id=notification.membership_id AND membership.group_id=job.group_id
		JOIN web_push_subscriptions subscription ON subscription.id=job.push_subscription_id
		WHERE job.id=? AND job.status='SENDING' AND job.lease_token=? AND membership.user_id=?
		  AND membership.status='ACTIVE' AND membership.deleted_at IS NULL
		  AND subscription.user_id=membership.user_id AND subscription.revoked_at IS NULL
		  AND subscription.vapid_key_id=?
	)`, job.id, job.leaseToken, userID, keyID).Scan(&valid)
	return valid, err
}

func (d *NotificationDispatcher) markSent(ctx context.Context, job claimedPushJob) error {
	now := platform.Timestamp(d.now().UTC())
	return d.completeLease(ctx, job, `UPDATE notification_delivery_jobs SET status='SENT',delivered_at=?,
		lease_token=NULL,lease_until=NULL,last_error_code=NULL,updated_at=?
		WHERE id=? AND channel='PUSH' AND status='SENDING' AND lease_token=?`, now, now, job.id, job.leaseToken)
}

func (d *NotificationDispatcher) markTerminal(ctx context.Context, job claimedPushJob, status, code string) error {
	now := platform.Timestamp(d.now().UTC())
	return d.completeLease(ctx, job, `UPDATE notification_delivery_jobs SET status=?,next_attempt_at=NULL,
		lease_token=NULL,lease_until=NULL,delivered_at=NULL,last_error_code=?,updated_at=?
		WHERE id=? AND channel='PUSH' AND status='SENDING' AND lease_token=?`, status, code, now, job.id, job.leaseToken)
}

func (d *NotificationDispatcher) recordFailure(ctx context.Context, job claimedPushJob, deliveryErr DeliveryError) error {
	now := d.now().UTC()
	code := deliveryErr.Code
	if code == "" || len(code) > 64 || strings.IndexFunc(code, func(character rune) bool {
		validLetter := character >= 'a' && character <= 'z'
		validDigit := character >= '0' && character <= '9'
		return !validLetter && !validDigit && character != '_'
	}) >= 0 {
		code = "delivery_failed"
	}
	next := now.Add(pushRetryDelay(job.attemptCount))
	if !deliveryErr.RetryAfter.IsZero() && deliveryErr.RetryAfter.After(next) {
		next = deliveryErr.RetryAfter
	}
	maximumRetry := now.Add(6 * time.Hour)
	if next.After(maximumRetry) {
		next = maximumRetry
	}
	if job.attemptCount >= maximumPushAttempts {
		return d.markTerminal(ctx, job, "FAILED", code)
	}
	if !next.Before(job.expiresAt) {
		return d.markTerminal(ctx, job, "EXPIRED", "expired")
	}
	nowText := platform.Timestamp(now)
	return d.completeLease(ctx, job, `UPDATE notification_delivery_jobs SET status='PENDING',next_attempt_at=?,
		lease_token=NULL,lease_until=NULL,last_error_code=?,updated_at=?
		WHERE id=? AND channel='PUSH' AND status='SENDING' AND lease_token=?`,
		platform.Timestamp(next), code, nowText, job.id, job.leaseToken)
}

func (d *NotificationDispatcher) completeLease(ctx context.Context, job claimedPushJob, query string, arguments ...any) error {
	result, err := d.db.ExecContext(ctx, query, arguments...)
	if err != nil {
		return err
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if changed != 1 {
		return fmt.Errorf("Web Push delivery lease was lost before completion")
	}
	return nil
}

func (d *NotificationDispatcher) releaseAfterCancellation(job claimedPushJob) {
	d.release(job, true)
}

func (d *NotificationDispatcher) releaseWithoutAttempt(job claimedPushJob) {
	d.release(job, true)
}

func (d *NotificationDispatcher) release(job claimedPushJob, decrementAttempt bool) {
	_ = withPushCompletionContext(func(ctx context.Context) error {
		now := platform.Timestamp(d.now().UTC())
		attemptExpression := "attempt_count"
		if decrementAttempt {
			attemptExpression = "max(attempt_count-1,0)"
		}
		query := `UPDATE notification_delivery_jobs SET status='PENDING',attempt_count=` + attemptExpression + `,
			next_attempt_at=?,lease_token=NULL,lease_until=NULL,updated_at=?
			WHERE id=? AND channel='PUSH' AND status='SENDING' AND lease_token=?`
		_, err := d.db.ExecContext(ctx, query, now, now, job.id, job.leaseToken)
		return err
	})
}

func pushRetryDelay(attempt int) time.Duration {
	if attempt < 1 {
		return pushRetryDelays[0]
	}
	index := attempt - 1
	if index >= len(pushRetryDelays) {
		return pushRetryDelays[len(pushRetryDelays)-1]
	}
	return pushRetryDelays[index]
}

func withPushCompletionContext(update func(context.Context) error) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return update(ctx)
}
