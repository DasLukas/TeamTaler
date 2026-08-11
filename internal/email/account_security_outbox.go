package email

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

// AccountSecuritySender is the delivery boundary used for password-reset and
// email-change verification messages.
type AccountSecuritySender interface {
	Available() bool
	SendPasswordReset(context.Context, AccountSecurityMessage) error
	SendEmailChangeVerification(context.Context, AccountSecurityMessage) error
}

var _ AccountSecuritySender = (*SMTP)(nil)

// AccountSecurityDispatcher delivers durable account-security messages using
// bounded workers, expiring database leases, five attempts, and authenticated
// token opening.
type AccountSecurityDispatcher struct {
	db            *sql.DB
	sender        AccountSecuritySender
	tokenOpener   TokenOpener
	publicURL     string
	logger        *slog.Logger
	now           func() time.Time
	workerCount   int
	pollInterval  time.Duration
	leaseDuration time.Duration
}

// NewAccountSecurityDispatcher validates its dependencies and returns a ready
// dispatcher without performing database or network I/O.
func NewAccountSecurityDispatcher(db *sql.DB, sender AccountSecuritySender, tokenOpener TokenOpener, publicURL *url.URL, logger *slog.Logger) (*AccountSecurityDispatcher, error) {
	if db == nil || sender == nil || tokenOpener == nil {
		return nil, errors.New("create account security dispatcher: database, sender, and token opener are required")
	}
	if publicURL == nil || publicURL.Host == "" || (publicURL.Scheme != "http" && publicURL.Scheme != "https") || publicURL.User != nil || publicURL.RawQuery != "" || publicURL.Fragment != "" || (publicURL.Path != "" && publicURL.Path != "/") {
		return nil, errors.New("create account security dispatcher: public URL must be an absolute root HTTP(S) URL")
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &AccountSecurityDispatcher{
		db: db, sender: sender, tokenOpener: tokenOpener,
		publicURL: strings.TrimSuffix(publicURL.String(), "/"), logger: logger,
		now: func() time.Time { return time.Now().UTC() }, workerCount: defaultWorkerCount,
		pollInterval: defaultPollInterval, leaseDuration: defaultLeaseDuration,
	}, nil
}

// Run processes due account-security messages until ctx is cancelled. Delivery
// failures are persisted for retry; invalid configuration is returned.
func (d *AccountSecurityDispatcher) Run(ctx context.Context) error {
	if ctx == nil {
		return errors.New("run account security dispatcher: context is required")
	}
	if d == nil || d.db == nil || d.sender == nil || d.tokenOpener == nil || d.now == nil || d.workerCount < 1 || d.workerCount > defaultWorkerCount || d.pollInterval <= 0 || d.leaseDuration <= 0 {
		return errors.New("run account security dispatcher: dispatcher is not fully configured")
	}
	if !d.sender.Available() {
		return fmt.Errorf("run account security dispatcher: %w", ErrUnavailable)
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

type claimedAccountSecurity struct {
	actionID        string
	leaseToken      string
	attemptCount    int
	tokenCiphertext string
}

type accountSecurityDelivery struct {
	kind      string
	toAddress string
	toName    string
	expiresAt time.Time
}

func (d *AccountSecurityDispatcher) runWorker(ctx context.Context) {
	for ctx.Err() == nil {
		processed, err := d.processOne(ctx)
		if err != nil {
			d.logger.Error("account security email outbox processing failed", "error", err)
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

func (d *AccountSecurityDispatcher) processOne(ctx context.Context) (bool, error) {
	job, found, err := d.claimNext(ctx)
	if err != nil || !found {
		return found, err
	}
	if ctx.Err() != nil {
		d.releaseAfterCancellation(job)
		return true, nil
	}
	delivery, cancellation, err := d.loadDelivery(ctx, job.actionID)
	if err != nil {
		return true, err
	}
	if cancellation != "" {
		return true, withCompletionContext(func(completionContext context.Context) error {
			return d.cancelClaim(completionContext, job, cancellation)
		})
	}
	token, err := d.tokenOpener.Open(job.tokenCiphertext)
	if err != nil || strings.TrimSpace(token) == "" {
		return true, withCompletionContext(func(completionContext context.Context) error {
			return d.recordFailure(completionContext, job, FailureCodeTokenOpenFailed)
		})
	}
	message := AccountSecurityMessage{ToAddress: delivery.toAddress, ToName: delivery.toName, ExpiresAt: delivery.expiresAt}
	switch delivery.kind {
	case "PASSWORD_RESET":
		message.ActionURL = d.publicURL + "/reset-password#token=" + url.QueryEscape(token)
		err = d.sender.SendPasswordReset(ctx, message)
	case "EMAIL_CHANGE":
		message.ActionURL = d.publicURL + "/email-change/confirm#token=" + url.QueryEscape(token)
		err = d.sender.SendEmailChangeVerification(ctx, message)
	default:
		return true, withCompletionContext(func(completionContext context.Context) error {
			return d.cancelClaim(completionContext, job, FailureCodeAccountActionInvalid)
		})
	}
	token = ""
	message.ActionURL = ""
	if err == nil {
		return true, withCompletionContext(func(completionContext context.Context) error {
			return d.markSent(completionContext, job)
		})
	}
	if ctx.Err() != nil || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		d.releaseAfterCancellation(job)
		return true, nil
	}
	code := FailureCodeDeliveryFailed
	if errors.Is(err, ErrUnavailable) {
		code = FailureCodeEmailUnavailable
	}
	return true, withCompletionContext(func(completionContext context.Context) error {
		return d.recordFailure(completionContext, job, code)
	})
}

func (d *AccountSecurityDispatcher) claimNext(ctx context.Context) (claimedAccountSecurity, bool, error) {
	leaseToken, err := platform.NewSecret()
	if err != nil {
		return claimedAccountSecurity{}, false, err
	}
	now := d.now().UTC()
	nowText := platform.Timestamp(now)
	leaseUntil := platform.Timestamp(now.Add(d.leaseDuration))
	var job claimedAccountSecurity
	found := false
	err = storage.WithTx(ctx, d.db, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `UPDATE account_security_actions SET invalidated_at=?
			WHERE expires_at<=? AND consumed_at IS NULL AND invalidated_at IS NULL`, nowText, nowText); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE account_security_email_outbox SET
			status='CANCELLED',token_ciphertext=NULL,next_attempt_at=NULL,lease_token=NULL,lease_until=NULL,
			last_error_code='account_action_expired',updated_at=?
			WHERE action_id IN (SELECT id FROM account_security_actions WHERE expires_at<=? AND invalidated_at IS NOT NULL)
			AND status IN ('PENDING','SENDING','FAILED')`, nowText, nowText); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE account_security_email_outbox SET
			status='FAILED',next_attempt_at=NULL,lease_token=NULL,lease_until=NULL,
			last_error_code='delivery_failed',updated_at=?
			WHERE status='SENDING' AND attempt_count>=? AND lease_until<=?`,
			nowText, maximumDeliveryAttempts, nowText); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE account_security_email_outbox SET
			status='PENDING',lease_token=NULL,lease_until=NULL,next_attempt_at=?,updated_at=?
			WHERE status='SENDING' AND attempt_count<? AND lease_until<=?`,
			nowText, nowText, maximumDeliveryAttempts, nowText); err != nil {
			return err
		}
		err := tx.QueryRowContext(ctx, `SELECT action_id,attempt_count,token_ciphertext
			FROM account_security_email_outbox WHERE status='PENDING' AND attempt_count<? AND next_attempt_at<=?
			ORDER BY next_attempt_at,created_at LIMIT 1`, maximumDeliveryAttempts, nowText).
			Scan(&job.actionID, &job.attemptCount, &job.tokenCiphertext)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		job.attemptCount++
		result, err := tx.ExecContext(ctx, `UPDATE account_security_email_outbox SET
			status='SENDING',attempt_count=?,next_attempt_at=NULL,lease_token=?,lease_until=?,updated_at=?
			WHERE action_id=? AND status='PENDING'`, job.attemptCount, leaseToken, leaseUntil, nowText, job.actionID)
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

func (d *AccountSecurityDispatcher) loadDelivery(ctx context.Context, actionID string) (accountSecurityDelivery, FailureCode, error) {
	var delivery accountSecurityDelivery
	var sourceEmail string
	var targetEmail sql.NullString
	var expiresAt string
	var consumedAt, invalidatedAt sql.NullString
	err := d.db.QueryRowContext(ctx, `SELECT a.kind,a.source_email,a.target_email,a.expires_at,
		a.consumed_at,a.invalidated_at,u.email,u.display_name
		FROM account_security_actions a JOIN users u ON u.id=a.user_id
		WHERE a.id=? AND u.active=1 AND u.email IS NOT NULL AND u.password_hash IS NOT NULL`, actionID).
		Scan(&delivery.kind, &sourceEmail, &targetEmail, &expiresAt, &consumedAt, &invalidatedAt, &delivery.toAddress, &delivery.toName)
	if errors.Is(err, sql.ErrNoRows) {
		return accountSecurityDelivery{}, FailureCodeAccountActionInvalidated, nil
	}
	if err != nil {
		return accountSecurityDelivery{}, "", err
	}
	if consumedAt.Valid || invalidatedAt.Valid || !strings.EqualFold(sourceEmail, delivery.toAddress) {
		return accountSecurityDelivery{}, FailureCodeAccountActionInvalidated, nil
	}
	if _, err := platform.NormalizeEmail(delivery.toAddress); err != nil {
		return accountSecurityDelivery{}, FailureCodeAccountActionInvalid, nil
	}
	expires, err := time.Parse(time.RFC3339Nano, expiresAt)
	if err != nil {
		return accountSecurityDelivery{}, FailureCodeAccountActionInvalid, nil
	}
	if !expires.After(d.now().UTC()) {
		return accountSecurityDelivery{}, FailureCodeAccountActionExpired, nil
	}
	if delivery.kind == "EMAIL_CHANGE" {
		if !targetEmail.Valid || strings.TrimSpace(targetEmail.String) == "" {
			return accountSecurityDelivery{}, FailureCodeAccountActionInvalid, nil
		}
		normalizedTarget, err := platform.NormalizeEmail(targetEmail.String)
		if err != nil {
			return accountSecurityDelivery{}, FailureCodeAccountActionInvalid, nil
		}
		delivery.toAddress = normalizedTarget
	} else if delivery.kind != "PASSWORD_RESET" {
		return accountSecurityDelivery{}, FailureCodeAccountActionInvalid, nil
	}
	delivery.expiresAt = expires
	return delivery, "", nil
}

func (d *AccountSecurityDispatcher) markSent(ctx context.Context, job claimedAccountSecurity) error {
	now := platform.Timestamp(d.now().UTC())
	result, err := d.db.ExecContext(ctx, `UPDATE account_security_email_outbox SET
		status='SENT',sent_at=?,token_ciphertext=NULL,lease_token=NULL,lease_until=NULL,last_error_code=NULL,updated_at=?
		WHERE action_id=? AND status='SENDING' AND lease_token=?`, now, now, job.actionID, job.leaseToken)
	return requireAccountSecurityLease(result, err, "completion")
}

func (d *AccountSecurityDispatcher) recordFailure(ctx context.Context, job claimedAccountSecurity, code FailureCode) error {
	now := d.now().UTC()
	status := string(OutboxStatusFailed)
	var nextAttempt any
	if job.attemptCount < maximumDeliveryAttempts {
		status = string(OutboxStatusPending)
		nextAttempt = platform.Timestamp(now.Add(retryDelay(job.attemptCount)))
	}
	result, err := d.db.ExecContext(ctx, `UPDATE account_security_email_outbox SET
		status=?,next_attempt_at=?,lease_token=NULL,lease_until=NULL,last_error_code=?,updated_at=?
		WHERE action_id=? AND status='SENDING' AND lease_token=?`, status, nextAttempt, code, platform.Timestamp(now), job.actionID, job.leaseToken)
	return requireAccountSecurityLease(result, err, "failure recording")
}

func (d *AccountSecurityDispatcher) cancelClaim(ctx context.Context, job claimedAccountSecurity, code FailureCode) error {
	now := platform.Timestamp(d.now().UTC())
	return storage.WithTx(ctx, d.db, func(tx *sql.Tx) error {
		if code == FailureCodeAccountActionExpired || code == FailureCodeAccountActionInvalid || code == FailureCodeAccountActionInvalidated {
			if _, err := tx.ExecContext(ctx, `UPDATE account_security_actions SET invalidated_at=?
				WHERE id=? AND consumed_at IS NULL AND invalidated_at IS NULL`, now, job.actionID); err != nil {
				return err
			}
		}
		result, err := tx.ExecContext(ctx, `UPDATE account_security_email_outbox SET
			status='CANCELLED',token_ciphertext=NULL,next_attempt_at=NULL,lease_token=NULL,lease_until=NULL,last_error_code=?,updated_at=?
			WHERE action_id=? AND status='SENDING' AND lease_token=?`, code, now, job.actionID, job.leaseToken)
		return requireAccountSecurityLease(result, err, "cancellation")
	})
}

func (d *AccountSecurityDispatcher) releaseAfterCancellation(job claimedAccountSecurity) {
	_ = withCompletionContext(func(ctx context.Context) error {
		now := platform.Timestamp(d.now().UTC())
		_, err := d.db.ExecContext(ctx, `UPDATE account_security_email_outbox SET
			status='PENDING',attempt_count=max(attempt_count-1,0),next_attempt_at=?,lease_token=NULL,lease_until=NULL,updated_at=?
			WHERE action_id=? AND status='SENDING' AND lease_token=?`, now, now, job.actionID, job.leaseToken)
		return err
	})
}

func requireAccountSecurityLease(result sql.Result, err error, operation string) error {
	if err != nil {
		return err
	}
	changed, _ := result.RowsAffected()
	if changed != 1 {
		return fmt.Errorf("account security email lease was lost before %s", operation)
	}
	return nil
}
