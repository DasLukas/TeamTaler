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

const (
	maximumDeliveryAttempts = 5
	defaultWorkerCount      = 4
	defaultPollInterval     = 2 * time.Second
	defaultLeaseDuration    = 2 * time.Minute
	completionTimeout       = 5 * time.Second
)

var retryDelays = [...]time.Duration{
	time.Minute,
	5 * time.Minute,
	30 * time.Minute,
	2 * time.Hour,
}

// OutboxStatus identifies the durable delivery state of one invitation email.
type OutboxStatus string

const (
	// OutboxStatusPending identifies a job waiting for its next delivery attempt.
	OutboxStatusPending OutboxStatus = "PENDING"
	// OutboxStatusSending identifies a job held by one live dispatcher lease.
	OutboxStatusSending OutboxStatus = "SENDING"
	// OutboxStatusSent identifies a message accepted by the configured sender.
	OutboxStatusSent OutboxStatus = "SENT"
	// OutboxStatusFailed identifies a job that exhausted all delivery attempts.
	OutboxStatusFailed OutboxStatus = "FAILED"
	// OutboxStatusCancelled identifies an invitation that must no longer be sent.
	OutboxStatusCancelled OutboxStatus = "CANCELLED"
)

// FailureCode is a stable, non-sensitive reason stored for an unsuccessful or
// cancelled outbox job. Raw transport and token-opening errors are never stored.
type FailureCode string

const (
	// FailureCodeInvitationAccepted means the invitation was already consumed.
	FailureCodeInvitationAccepted FailureCode = "invitation_accepted"
	// FailureCodeInvitationRevoked means an administrator revoked the invitation.
	FailureCodeInvitationRevoked FailureCode = "invitation_revoked"
	// FailureCodeInvitationExpired means the invitation expired before delivery.
	FailureCodeInvitationExpired FailureCode = "invitation_expired"
	// FailureCodeInvitationInvalid means persisted invitation metadata is unusable.
	FailureCodeInvitationInvalid FailureCode = "invitation_invalid"
	// FailureCodeTokenOpenFailed means the encrypted invitation token could not be opened.
	FailureCodeTokenOpenFailed FailureCode = "token_open_failed"
	// FailureCodeEmailUnavailable means the configured sender became unavailable.
	FailureCodeEmailUnavailable FailureCode = "email_unavailable"
	// FailureCodeDeliveryFailed safely classifies every SMTP or sender failure.
	FailureCodeDeliveryFailed FailureCode = "delivery_failed"
	// FailureCodeRecipientUnavailable means a queued notification no longer has
	// an email-capable recipient.
	FailureCodeRecipientUnavailable FailureCode = "recipient_unavailable"
	// FailureCodeDeliveryInterrupted means the final worker lease expired before acknowledgement.
	FailureCodeDeliveryInterrupted FailureCode = "delivery_interrupted"
	// FailureCodePublicJoinInvalidated means link rotation, disabling, or a newer registration invalidated the job.
	FailureCodePublicJoinInvalidated FailureCode = "public_join_invalidated"
	// FailureCodePublicJoinExpired means the registration or parent join link expired before delivery.
	FailureCodePublicJoinExpired FailureCode = "public_join_expired"
)

// TokenOpener decrypts one persisted invitation-token ciphertext. Implementations
// must authenticate ciphertext before returning its plaintext and must never log
// either value. Open returns the plaintext token or a decryption error.
type TokenOpener interface {
	Open(string) (string, error)
}

// Dispatcher claims durable invitation email jobs, opens their tokens only in
// memory, sends them through Sender, and persists sanitized delivery outcomes.
// Construct a Dispatcher with NewDispatcher and call Run from the process
// lifecycle context. One Dispatcher starts at most four concurrent workers.
type Dispatcher struct {
	db            *sql.DB
	sender        Sender
	tokenOpener   TokenOpener
	publicURL     string
	logger        *slog.Logger
	now           func() time.Time
	workerCount   int
	pollInterval  time.Duration
	leaseDuration time.Duration
}

// NewDispatcher validates and stores the dependencies required for invitation
// delivery. db must be a migrated TeamTaler database, sender and tokenOpener must
// be non-nil, and publicURL must be an absolute root HTTP(S) URL without secrets,
// a query, or a fragment. A nil logger selects slog.Default. The function performs
// no database or network I/O and returns a configured Dispatcher or a validation
// error.
func NewDispatcher(db *sql.DB, sender Sender, tokenOpener TokenOpener, publicURL *url.URL, logger *slog.Logger) (*Dispatcher, error) {
	if db == nil {
		return nil, errors.New("create email dispatcher: database is required")
	}
	if sender == nil {
		return nil, errors.New("create email dispatcher: sender is required")
	}
	if tokenOpener == nil {
		return nil, errors.New("create email dispatcher: token opener is required")
	}
	if publicURL == nil || publicURL.Host == "" || (publicURL.Scheme != "http" && publicURL.Scheme != "https") || publicURL.User != nil || publicURL.RawQuery != "" || publicURL.Fragment != "" || (publicURL.Path != "" && publicURL.Path != "/") {
		return nil, errors.New("create email dispatcher: public URL must be an absolute root HTTP(S) URL without credentials, query, or fragment")
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &Dispatcher{
		db:            db,
		sender:        sender,
		tokenOpener:   tokenOpener,
		publicURL:     strings.TrimSuffix(publicURL.String(), "/"),
		logger:        logger,
		now:           func() time.Time { return time.Now().UTC() },
		workerCount:   defaultWorkerCount,
		pollInterval:  defaultPollInterval,
		leaseDuration: defaultLeaseDuration,
	}, nil
}

// Run processes due invitation emails until ctx is cancelled. It starts at most
// four workers, polls when no job is ready, and waits for every worker before
// returning. Sender failures are converted into durable retry state and are not
// returned. Processing errors are logged and retried on the next poll. Run
// returns ErrUnavailable when delivery is disabled, a configuration error for an
// incomplete Dispatcher, and nil for orderly context cancellation.
func (d *Dispatcher) Run(ctx context.Context) error {
	if ctx == nil {
		return errors.New("run email dispatcher: context is required")
	}
	if d == nil || d.db == nil || d.sender == nil || d.tokenOpener == nil || d.now == nil || d.workerCount < 1 || d.workerCount > defaultWorkerCount || d.pollInterval <= 0 || d.leaseDuration <= 0 {
		return errors.New("run email dispatcher: dispatcher is not fully configured")
	}
	if !d.sender.Available() {
		return fmt.Errorf("run email dispatcher: %w", ErrUnavailable)
	}
	if ctx.Err() != nil {
		return nil
	}

	var workers sync.WaitGroup
	workers.Add(d.workerCount)
	for worker := 0; worker < d.workerCount; worker++ {
		go func() {
			defer workers.Done()
			d.runWorker(ctx)
		}()
	}
	workers.Wait()
	return nil
}

type claimedInvitation struct {
	invitationID    string
	groupID         string
	tokenCiphertext string
	leaseToken      string
	attemptCount    int
}

type invitationDelivery struct {
	toAddress string
	toName    string
	groupName string
	expiresAt time.Time
}

func (d *Dispatcher) runWorker(ctx context.Context) {
	for {
		if ctx.Err() != nil {
			return
		}
		processed, err := d.processOne(ctx)
		if err != nil {
			d.logger.Error("invitation email outbox processing failed", "error", err)
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

func (d *Dispatcher) processOne(ctx context.Context) (bool, error) {
	job, found, err := d.claimNext(ctx)
	if err != nil || !found {
		return found, err
	}
	if ctx.Err() != nil {
		d.releaseAfterCancellation(job)
		return true, nil
	}

	delivery, cancellationCode, err := d.loadInvitation(ctx, job)
	if err != nil {
		if ctx.Err() != nil {
			d.releaseAfterCancellation(job)
			return true, nil
		}
		return true, fmt.Errorf("load claimed invitation email: %w", err)
	}
	if cancellationCode != "" {
		if err := withCompletionContext(func(completionContext context.Context) error {
			return d.cancelClaim(completionContext, job, cancellationCode)
		}); err != nil {
			return true, err
		}
		return true, nil
	}
	if !d.sender.Available() {
		return true, withCompletionContext(func(completionContext context.Context) error {
			return d.recordFailure(completionContext, job, FailureCodeEmailUnavailable)
		})
	}

	token, err := d.tokenOpener.Open(job.tokenCiphertext)
	if err != nil || strings.TrimSpace(token) == "" {
		token = ""
		return true, withCompletionContext(func(completionContext context.Context) error {
			return d.recordFailure(completionContext, job, FailureCodeTokenOpenFailed)
		})
	}
	acceptURL := d.publicURL + "/invite#token=" + url.QueryEscape(token)
	message := InvitationMessage{
		ToAddress: delivery.toAddress,
		ToName:    delivery.toName,
		GroupName: delivery.groupName,
		AcceptURL: acceptURL,
		ExpiresAt: delivery.expiresAt,
	}
	token = ""

	err = d.sender.SendInvitation(ctx, message)
	message.AcceptURL = ""
	acceptURL = ""
	if err == nil {
		return true, withCompletionContext(func(completionContext context.Context) error {
			return d.markSent(completionContext, job)
		})
	}
	if ctx.Err() != nil || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		d.releaseAfterCancellation(job)
		return true, nil
	}
	if errors.Is(err, ErrUnavailable) {
		return true, withCompletionContext(func(completionContext context.Context) error {
			return d.recordFailure(completionContext, job, FailureCodeEmailUnavailable)
		})
	}
	return true, withCompletionContext(func(completionContext context.Context) error {
		return d.recordFailure(completionContext, job, FailureCodeDeliveryFailed)
	})
}

func (d *Dispatcher) claimNext(ctx context.Context) (claimedInvitation, bool, error) {
	leaseToken, err := platform.NewSecret()
	if err != nil {
		return claimedInvitation{}, false, fmt.Errorf("create invitation email lease: %w", err)
	}
	now := d.now().UTC()
	nowText := platform.Timestamp(now)
	leaseUntil := platform.Timestamp(now.Add(d.leaseDuration))
	var job claimedInvitation
	found := false
	err = storage.WithTx(ctx, d.db, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `UPDATE invitation_email_outbox
			SET status='FAILED', next_attempt_at=NULL, lease_token=NULL, lease_until=NULL,
				last_error_code=?, updated_at=?
			WHERE attempt_count>=? AND (
				status='PENDING' OR
				(status='SENDING' AND lease_until IS NOT NULL AND julianday(lease_until)<=julianday(?))
			)`, FailureCodeDeliveryInterrupted, nowText, maximumDeliveryAttempts, nowText); err != nil {
			return fmt.Errorf("finalize exhausted invitation email leases: %w", err)
		}

		row := tx.QueryRowContext(ctx, `UPDATE invitation_email_outbox
			SET status='SENDING', attempt_count=attempt_count+1, next_attempt_at=NULL,
				lease_token=?, lease_until=?, last_error_code=NULL, updated_at=?
			WHERE invitation_id=(
				SELECT invitation_id FROM invitation_email_outbox
				WHERE attempt_count<? AND (
					(status='PENDING' AND next_attempt_at IS NOT NULL AND julianday(next_attempt_at)<=julianday(?)) OR
					(status='SENDING' AND lease_until IS NOT NULL AND julianday(lease_until)<=julianday(?))
				)
				ORDER BY julianday(CASE WHEN status='SENDING' THEN lease_until ELSE next_attempt_at END), julianday(created_at)
				LIMIT 1
			)
			RETURNING invitation_id,group_id,token_ciphertext,attempt_count`,
			leaseToken, leaseUntil, nowText, maximumDeliveryAttempts, nowText, nowText)
		if err := row.Scan(&job.invitationID, &job.groupID, &job.tokenCiphertext, &job.attemptCount); errors.Is(err, sql.ErrNoRows) {
			return nil
		} else if err != nil {
			return fmt.Errorf("claim invitation email: %w", err)
		}
		job.leaseToken = leaseToken
		found = true
		return nil
	})
	if err != nil {
		return claimedInvitation{}, false, err
	}
	return job, found, nil
}

func (d *Dispatcher) loadInvitation(ctx context.Context, job claimedInvitation) (invitationDelivery, FailureCode, error) {
	var delivery invitationDelivery
	var expiresAt string
	var acceptedAt, revokedAt sql.NullString
	err := d.db.QueryRowContext(ctx, `SELECT i.email,coalesce(i.display_name,''),g.name,i.expires_at,i.accepted_at,i.revoked_at
		FROM invitations i JOIN groups g ON g.id=i.group_id
		WHERE i.id=? AND i.group_id=?`, job.invitationID, job.groupID).
		Scan(&delivery.toAddress, &delivery.toName, &delivery.groupName, &expiresAt, &acceptedAt, &revokedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return invitationDelivery{}, FailureCodeInvitationInvalid, nil
	}
	if err != nil {
		return invitationDelivery{}, "", err
	}
	if acceptedAt.Valid {
		return invitationDelivery{}, FailureCodeInvitationAccepted, nil
	}
	if revokedAt.Valid {
		return invitationDelivery{}, FailureCodeInvitationRevoked, nil
	}
	delivery.expiresAt, err = time.Parse(time.RFC3339Nano, expiresAt)
	if err != nil {
		return invitationDelivery{}, FailureCodeInvitationInvalid, nil
	}
	if !delivery.expiresAt.After(d.now()) {
		return invitationDelivery{}, FailureCodeInvitationExpired, nil
	}
	return delivery, "", nil
}

func (d *Dispatcher) markSent(ctx context.Context, job claimedInvitation) error {
	now := platform.Timestamp(d.now())
	result, err := d.db.ExecContext(ctx, `UPDATE invitation_email_outbox
		SET status='SENT', token_ciphertext=NULL, next_attempt_at=NULL, lease_token=NULL,
			lease_until=NULL, sent_at=?, last_error_code=NULL, updated_at=?
		WHERE invitation_id=? AND group_id=? AND status='SENDING' AND lease_token=?`,
		now, now, job.invitationID, job.groupID, job.leaseToken)
	return checkedLeaseUpdate(result, err, "mark invitation email sent")
}

func (d *Dispatcher) cancelClaim(ctx context.Context, job claimedInvitation, code FailureCode) error {
	now := platform.Timestamp(d.now())
	result, err := d.db.ExecContext(ctx, `UPDATE invitation_email_outbox
		SET status='CANCELLED', token_ciphertext=NULL,
			attempt_count=CASE WHEN attempt_count>0 THEN attempt_count-1 ELSE 0 END,
			next_attempt_at=NULL, lease_token=NULL,
			lease_until=NULL, sent_at=NULL, last_error_code=?, updated_at=?
		WHERE invitation_id=? AND group_id=? AND status='SENDING' AND lease_token=?`,
		code, now, job.invitationID, job.groupID, job.leaseToken)
	return checkedLeaseUpdate(result, err, "cancel invitation email")
}

func (d *Dispatcher) recordFailure(ctx context.Context, job claimedInvitation, code FailureCode) error {
	now := d.now().UTC()
	status := OutboxStatusPending
	var nextAttempt any = platform.Timestamp(now.Add(retryDelay(job.attemptCount)))
	if job.attemptCount >= maximumDeliveryAttempts {
		status = OutboxStatusFailed
		nextAttempt = nil
	}
	result, err := d.db.ExecContext(ctx, `UPDATE invitation_email_outbox
		SET status=?, next_attempt_at=?, lease_token=NULL, lease_until=NULL,
			last_error_code=?, updated_at=?
		WHERE invitation_id=? AND group_id=? AND status='SENDING' AND lease_token=?`,
		status, nextAttempt, code, platform.Timestamp(now), job.invitationID, job.groupID, job.leaseToken)
	return checkedLeaseUpdate(result, err, "record invitation email failure")
}

func (d *Dispatcher) releaseAfterCancellation(job claimedInvitation) {
	err := withCompletionContext(func(releaseContext context.Context) error {
		now := platform.Timestamp(d.now())
		result, err := d.db.ExecContext(releaseContext, `UPDATE invitation_email_outbox
			SET status='PENDING', attempt_count=CASE WHEN attempt_count>0 THEN attempt_count-1 ELSE 0 END,
				next_attempt_at=?, lease_token=NULL, lease_until=NULL, last_error_code=NULL, updated_at=?
			WHERE invitation_id=? AND group_id=? AND status='SENDING' AND lease_token=?`,
			now, now, job.invitationID, job.groupID, job.leaseToken)
		return checkedLeaseUpdate(result, err, "release cancelled invitation email lease")
	})
	if err != nil {
		d.logger.Error("invitation email lease release failed", "invitation_id", job.invitationID, "error", err)
	}
}

func withCompletionContext(update func(context.Context) error) error {
	completionContext, cancel := context.WithTimeout(context.Background(), completionTimeout)
	defer cancel()
	return update(completionContext)
}

func checkedLeaseUpdate(result sql.Result, err error, operation string) error {
	if err != nil {
		return fmt.Errorf("%s: %w", operation, err)
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("%s: read affected rows: %w", operation, err)
	}
	if changed != 1 {
		return fmt.Errorf("%s: delivery lease was lost", operation)
	}
	return nil
}

func retryDelay(attempt int) time.Duration {
	if attempt < 1 {
		return retryDelays[0]
	}
	index := attempt - 1
	if index >= len(retryDelays) {
		return retryDelays[len(retryDelays)-1]
	}
	return retryDelays[index]
}
