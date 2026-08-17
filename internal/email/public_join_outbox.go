package email

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

// JoinVerificationSender is the delivery boundary required by the public-join
// dispatcher. SMTP implements it without widening the older invitation Sender
// interface used by existing test doubles.
type JoinVerificationSender interface {
	Available() bool
	SendJoinVerification(context.Context, JoinVerificationMessage) error
}

// PublicJoinDispatcher delivers durable mailbox-verification jobs for public
// join-link registrations. It uses bounded workers, database leases, at most
// five attempts, authenticated token opening, and sanitized failure codes.
type PublicJoinDispatcher struct {
	db            *sql.DB
	sender        JoinVerificationSender
	tokenOpener   TokenOpener
	publicURL     string
	logger        *slog.Logger
	now           func() time.Time
	workerCount   int
	pollInterval  time.Duration
	leaseDuration time.Duration
}

// NewPublicJoinDispatcher validates the dependencies used for verified public
// registration email delivery. It performs no network or database I/O and
// returns a configured dispatcher or a validation error.
func NewPublicJoinDispatcher(db *sql.DB, sender JoinVerificationSender, tokenOpener TokenOpener, publicURL *url.URL, logger *slog.Logger) (*PublicJoinDispatcher, error) {
	if db == nil || sender == nil || tokenOpener == nil {
		return nil, errors.New("create public join dispatcher: database, sender, and token opener are required")
	}
	if publicURL == nil || publicURL.Host == "" || (publicURL.Scheme != "http" && publicURL.Scheme != "https") || publicURL.User != nil || publicURL.RawQuery != "" || publicURL.Fragment != "" || (publicURL.Path != "" && publicURL.Path != "/") {
		return nil, errors.New("create public join dispatcher: public URL must be an absolute root HTTP(S) URL")
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &PublicJoinDispatcher{
		db: db, sender: sender, tokenOpener: tokenOpener, publicURL: strings.TrimSuffix(publicURL.String(), "/"), logger: logger,
		now: func() time.Time { return time.Now().UTC() }, workerCount: defaultWorkerCount,
		pollInterval: defaultPollInterval, leaseDuration: defaultLeaseDuration,
	}, nil
}

// Run processes public-join verification jobs until ctx is cancelled. Sender
// failures are retried durably and do not terminate workers. It pauses without
// claiming jobs while delivery is disabled and returns nil after cancellation.
func (d *PublicJoinDispatcher) Run(ctx context.Context) error {
	if ctx == nil {
		return errors.New("run public join dispatcher: context is required")
	}
	if d == nil || d.db == nil || d.sender == nil || d.tokenOpener == nil || d.now == nil || d.workerCount < 1 || d.workerCount > defaultWorkerCount || d.pollInterval <= 0 || d.leaseDuration <= 0 {
		return errors.New("run public join dispatcher: dispatcher is not fully configured")
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

type claimedPublicJoin struct {
	registrationID  string
	leaseToken      string
	attemptCount    int
	tokenCiphertext string
}

type publicJoinDelivery struct {
	toAddress string
	toName    string
	groupName string
	expiresAt time.Time
}

func (d *PublicJoinDispatcher) runWorker(ctx context.Context) {
	for ctx.Err() == nil {
		processed, err := d.processOne(ctx)
		if err != nil {
			d.logger.Error("public join email outbox processing failed", "error", err)
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

func (d *PublicJoinDispatcher) processOne(ctx context.Context) (bool, error) {
	if !d.sender.Available() {
		return false, nil
	}
	job, found, err := d.claimNext(ctx)
	if err != nil || !found {
		return found, err
	}
	if ctx.Err() != nil {
		d.releaseAfterCancellation(job)
		return true, nil
	}
	delivery, cancellation, err := d.loadDelivery(ctx, job.registrationID)
	if err != nil {
		if ctx.Err() != nil {
			d.releaseAfterCancellation(job)
			return true, nil
		}
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
	message := JoinVerificationMessage{
		ToAddress: delivery.toAddress,
		ToName:    delivery.toName,
		GroupName: delivery.groupName,
		VerifyURL: d.publicURL + "/join/verify#token=" + url.QueryEscape(token),
		ExpiresAt: delivery.expiresAt,
	}
	token = ""
	err = d.sender.SendJoinVerification(ctx, message)
	message.VerifyURL = ""
	if err == nil {
		return true, withCompletionContext(func(completionContext context.Context) error { return d.markSent(completionContext, job) })
	}
	if ctx.Err() != nil || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		d.releaseAfterCancellation(job)
		return true, nil
	}
	if errors.Is(err, ErrUnavailable) {
		d.releaseAfterCancellation(job)
		return true, nil
	}
	return true, withCompletionContext(func(completionContext context.Context) error {
		return d.recordFailure(completionContext, job, FailureCodeDeliveryFailed)
	})
}

func (d *PublicJoinDispatcher) claimNext(ctx context.Context) (claimedPublicJoin, bool, error) {
	leaseToken, err := platform.NewSecret()
	if err != nil {
		return claimedPublicJoin{}, false, err
	}
	now := d.now().UTC()
	nowText := platform.Timestamp(now)
	leaseUntil := platform.Timestamp(now.Add(d.leaseDuration))
	var job claimedPublicJoin
	found := false
	err = storage.WithTx(ctx, d.db, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `UPDATE public_join_email_outbox SET status='PENDING',lease_token=NULL,lease_until=NULL,next_attempt_at=?,updated_at=? WHERE status='SENDING' AND lease_until<=?`, nowText, nowText, nowText); err != nil {
			return err
		}
		err := tx.QueryRowContext(ctx, `SELECT registration_id,attempt_count,token_ciphertext FROM public_join_email_outbox WHERE status='PENDING' AND next_attempt_at<=? ORDER BY next_attempt_at,created_at LIMIT 1`, nowText).Scan(&job.registrationID, &job.attemptCount, &job.tokenCiphertext)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		job.attemptCount++
		result, err := tx.ExecContext(ctx, `UPDATE public_join_email_outbox SET status='SENDING',attempt_count=?,next_attempt_at=NULL,lease_token=?,lease_until=?,updated_at=? WHERE registration_id=? AND status='PENDING'`, job.attemptCount, leaseToken, leaseUntil, nowText, job.registrationID)
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

func (d *PublicJoinDispatcher) loadDelivery(ctx context.Context, registrationID string) (publicJoinDelivery, FailureCode, error) {
	var delivery publicJoinDelivery
	var registrationExpires string
	var linkExpires sql.NullString
	var consumedAt, invalidatedAt sql.NullString
	var linkEnabled bool
	var registrationVersion, linkVersion int64
	err := d.db.QueryRowContext(ctx, `SELECT r.email,r.display_name,g.name,r.expires_at,r.consumed_at,r.invalidated_at,r.join_link_version,l.version,l.enabled,l.expires_at FROM public_join_registrations r JOIN groups g ON g.id=r.group_id JOIN public_join_links l ON l.group_id=r.group_id WHERE r.id=?`, registrationID).
		Scan(&delivery.toAddress, &delivery.toName, &delivery.groupName, &registrationExpires, &consumedAt, &invalidatedAt, &registrationVersion, &linkVersion, &linkEnabled, &linkExpires)
	if errors.Is(err, sql.ErrNoRows) {
		return publicJoinDelivery{}, FailureCodePublicJoinInvalidated, nil
	}
	if err != nil {
		return publicJoinDelivery{}, "", err
	}
	if consumedAt.Valid || invalidatedAt.Valid || !linkEnabled || registrationVersion != linkVersion {
		return publicJoinDelivery{}, FailureCodePublicJoinInvalidated, nil
	}
	expires, err := time.Parse(time.RFC3339Nano, registrationExpires)
	if err != nil {
		return publicJoinDelivery{}, FailureCodePublicJoinInvalidated, nil
	}
	now := d.now().UTC()
	if !expires.After(now) {
		return publicJoinDelivery{}, FailureCodePublicJoinExpired, nil
	}
	if linkExpires.Valid {
		linkExpiry, err := time.Parse(time.RFC3339Nano, linkExpires.String)
		if err != nil || !linkExpiry.After(now) {
			return publicJoinDelivery{}, FailureCodePublicJoinExpired, nil
		}
		if linkExpiry.Before(expires) {
			expires = linkExpiry
		}
	}
	delivery.expiresAt = expires
	return delivery, "", nil
}

func (d *PublicJoinDispatcher) markSent(ctx context.Context, job claimedPublicJoin) error {
	now := platform.Timestamp(d.now().UTC())
	result, err := d.db.ExecContext(ctx, `UPDATE public_join_email_outbox SET status='SENT',sent_at=?,token_ciphertext=NULL,lease_token=NULL,lease_until=NULL,last_error_code=NULL,updated_at=? WHERE registration_id=? AND status='SENDING' AND lease_token=?`, now, now, job.registrationID, job.leaseToken)
	if err != nil {
		return err
	}
	changed, _ := result.RowsAffected()
	if changed != 1 {
		return errors.New("public join email lease was lost before completion")
	}
	return nil
}

func (d *PublicJoinDispatcher) recordFailure(ctx context.Context, job claimedPublicJoin, code FailureCode) error {
	now := d.now().UTC()
	status := string(OutboxStatusFailed)
	var nextAttempt any
	if job.attemptCount < maximumDeliveryAttempts {
		status = string(OutboxStatusPending)
		nextAttempt = platform.Timestamp(now.Add(retryDelay(job.attemptCount)))
	}
	result, err := d.db.ExecContext(ctx, `UPDATE public_join_email_outbox SET status=?,next_attempt_at=?,lease_token=NULL,lease_until=NULL,last_error_code=?,updated_at=? WHERE registration_id=? AND status='SENDING' AND lease_token=?`, status, nextAttempt, code, platform.Timestamp(now), job.registrationID, job.leaseToken)
	if err != nil {
		return err
	}
	changed, _ := result.RowsAffected()
	if changed != 1 {
		return errors.New("public join email lease was lost before failure recording")
	}
	return nil
}

func (d *PublicJoinDispatcher) cancelClaim(ctx context.Context, job claimedPublicJoin, code FailureCode) error {
	now := platform.Timestamp(d.now().UTC())
	result, err := d.db.ExecContext(ctx, `UPDATE public_join_email_outbox SET status='CANCELLED',token_ciphertext=NULL,next_attempt_at=NULL,lease_token=NULL,lease_until=NULL,last_error_code=?,updated_at=? WHERE registration_id=? AND status='SENDING' AND lease_token=?`, code, now, job.registrationID, job.leaseToken)
	if err != nil {
		return err
	}
	changed, _ := result.RowsAffected()
	if changed != 1 {
		return errors.New("public join email lease was lost before cancellation")
	}
	return nil
}

func (d *PublicJoinDispatcher) releaseAfterCancellation(job claimedPublicJoin) {
	_ = withCompletionContext(func(ctx context.Context) error {
		now := platform.Timestamp(d.now().UTC())
		_, err := d.db.ExecContext(ctx, `UPDATE public_join_email_outbox SET status='PENDING',attempt_count=max(attempt_count-1,0),next_attempt_at=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE registration_id=? AND status='SENDING' AND lease_token=?`, now, now, job.registrationID, job.leaseToken)
		return err
	})
}
