package exporting

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/DasLukas/TeamTaler/internal/audit"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

// ProcessNext claims at most one queued or expired-lease job and generates its
// archive from one read transaction. It returns ErrNoPendingJob when idle.
// READY and FAILED callbacks run only after their durable state has committed.
func (service *Service) ProcessNext(ctx context.Context) (Job, error) {
	if exhausted, found, err := service.failExhaustedAttempt(ctx); err != nil {
		return Job{}, err
	} else if found {
		if err := service.notifyCompletion(ctx, exhausted); err != nil {
			return exhausted.Job, err
		}
		return exhausted.Job, nil
	}
	record, err := service.claimNext(ctx)
	if err != nil {
		return Job{}, err
	}
	if record.Status == StatusCancelled {
		return record.Job, nil
	}
	generationContext, cancel := context.WithTimeout(ctx, service.generationTimeout)
	defer cancel()
	temporary, err := service.artifacts.CreateTemporary(record.ID)
	if err != nil {
		return service.failClaim(ctx, record, "artifact_create_failed", err)
	}
	temporaryPath := temporary.Name()
	removeTemporary := true
	defer func() {
		temporary.Close()
		if removeTemporary {
			os.Remove(temporaryPath)
		}
	}()

	readTx, err := service.db.BeginTx(generationContext, &sql.TxOptions{ReadOnly: true})
	if err == nil {
		err = generateArchive(generationContext, readTx, temporary, record, service.now(), service.maxArtifactBytes, func(completed int) error {
			return service.updateProgress(generationContext, record, completed)
		})
	}
	if readTx != nil {
		if err == nil {
			err = readTx.Commit()
		} else {
			readTx.Rollback()
		}
	}
	if err == nil {
		err = temporary.Sync()
	}
	if err == nil {
		err = generationContext.Err()
	}
	if err == nil {
		err = temporary.Close()
	}
	if err != nil {
		if ctx.Err() != nil {
			return Job{}, ctx.Err()
		}
		return service.failClaim(ctx, record, generationErrorCode(err), err)
	}

	digest, size, err := hashArtifact(generationContext, temporaryPath)
	if err != nil {
		return service.failClaim(ctx, record, "artifact_verify_failed", err)
	}
	if err := generationContext.Err(); err != nil {
		return service.failClaim(ctx, record, generationErrorCode(err), err)
	}
	artifactName, err := service.artifacts.Publish(record.ID, record.LeaseToken, temporaryPath)
	if err != nil {
		return service.failClaim(ctx, record, "artifact_publish_failed", err)
	}
	removeTemporary = false
	record.ArtifactName = artifactName
	record.SHA256 = digest
	record.SizeBytes = size

	completed, err := service.completeClaim(ctx, record)
	if err != nil {
		_ = service.artifacts.Remove(artifactName)
		return Job{}, err
	}
	if completed.Status != StatusReady {
		_ = service.artifacts.Remove(artifactName)
		return completed.Job, nil
	}
	if err := service.notifyCompletion(ctx, completed); err != nil {
		return completed.Job, err
	}
	return completed.Job, nil
}

// Run continuously processes jobs until ctx is cancelled. idleDelay controls
// polling latency and defaults to one second when non-positive.
func (service *Service) Run(ctx context.Context, idleDelay time.Duration) error {
	if idleDelay <= 0 {
		idleDelay = time.Second
	}
	for {
		if _, err := service.DispatchPendingCompletions(ctx, 20); err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
		}
		job, err := service.ProcessNext(ctx)
		if err == nil {
			continue
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if !errors.Is(err, ErrNoPendingJob) && !job.Status.Terminal() {
			return err
		}
		if err := waitForExportWorker(ctx, idleDelay); err != nil {
			return err
		}
	}
}

func waitForExportWorker(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// DispatchPendingCompletions retries durable READY and FAILED callbacks that were
// not acknowledged before a previous worker stopped. Listener implementations must
// remain idempotent because competing workers can both observe an unacknowledged row.
func (service *Service) DispatchPendingCompletions(ctx context.Context, limit int) (int, error) {
	if service.completionListener == nil {
		return 0, nil
	}
	if limit < 1 || limit > 100 {
		limit = 20
	}
	rows, err := service.db.QueryContext(ctx, selectJobSQL+`
		WHERE status IN ('READY','FAILED') AND completion_notified_at IS NULL ORDER BY completed_at,id LIMIT ?`, limit)
	if err != nil {
		return 0, fmt.Errorf("list pending export completion callbacks: %w", err)
	}
	records := make([]jobRecord, 0)
	for rows.Next() {
		record, scanErr := scanJob(rows)
		if scanErr != nil {
			rows.Close()
			return 0, scanErr
		}
		records = append(records, record)
	}
	if err := rows.Close(); err != nil {
		return 0, err
	}
	for index, record := range records {
		if err := service.notifyCompletion(ctx, record); err != nil {
			return index, err
		}
	}
	return len(records), nil
}

// Cleanup expires retained artifacts and cancels READY jobs whose current scope
// authorization has been revoked. It processes at most limit jobs and removes
// artifacts only after the database transaction commits.
func (service *Service) Cleanup(ctx context.Context, limit int) (int, error) {
	if limit < 1 || limit > 500 {
		limit = 100
	}
	now := service.now().UTC()
	rows, err := service.db.QueryContext(ctx, selectJobSQL+`
		WHERE status='READY' ORDER BY expires_at,id LIMIT ?`, limit)
	if err != nil {
		return 0, fmt.Errorf("list retained export artifacts: %w", err)
	}
	records := make([]jobRecord, 0)
	for rows.Next() {
		record, scanErr := scanJob(rows)
		if scanErr != nil {
			rows.Close()
			return 0, scanErr
		}
		records = append(records, record)
	}
	if err := rows.Close(); err != nil {
		return 0, err
	}
	removed := 0
	var combined error
	for _, record := range records {
		expires, parseErr := time.Parse(time.RFC3339Nano, record.ExpiresAt)
		expired := parseErr != nil || !expires.After(now)
		authorized := true
		if !expired {
			authorizeErr := authorizeScope(ctx, service.db, record.GroupID, record.MembershipID, record.UserID, record.Scope)
			authorized = authorizeErr == nil
			if authorizeErr != nil && !errors.Is(authorizeErr, domain.ErrForbidden) {
				combined = errors.Join(combined, authorizeErr)
				continue
			}
		}
		if !expired && authorized {
			continue
		}
		status := StatusCancelled
		action := "DATA_EXPORT_CANCELLED"
		if expired {
			status = StatusExpired
			action = "DATA_EXPORT_EXPIRED"
		}
		err := storage.WithTx(ctx, service.db, func(tx *sql.Tx) error {
			result, err := tx.ExecContext(ctx, `UPDATE export_jobs SET status=?,updated_at=?
				WHERE id=? AND status='READY'`, status, platform.Timestamp(now), record.ID)
			if err != nil {
				return err
			}
			changed, err := result.RowsAffected()
			if err != nil || changed == 0 {
				return err
			}
			return audit.Record(ctx, tx, record.GroupID, record.UserID, record.MembershipID,
				action, "EXPORT_JOB", record.ID, map[string]any{"scope": record.Scope})
		})
		if err != nil {
			combined = errors.Join(combined, err)
			continue
		}
		if err := service.artifacts.Remove(record.ArtifactName); err != nil {
			combined = errors.Join(combined, err)
			continue
		}
		if _, err := service.db.ExecContext(ctx, `UPDATE export_jobs SET artifact_name=NULL,updated_at=? WHERE id=? AND artifact_name=?`,
			platform.Timestamp(now), record.ID, record.ArtifactName); err != nil {
			combined = errors.Join(combined, err)
		}
		removed++
	}
	retained, retainErr := service.retainedArtifactNames(ctx)
	if retainErr != nil {
		combined = errors.Join(combined, retainErr)
	} else {
		reconciled, reconcileErr := service.artifacts.Reconcile(retained, now.Add(-service.leaseDuration))
		removed += reconciled
		combined = errors.Join(combined, reconcileErr)
	}
	return removed, combined
}

func (service *Service) claimNext(ctx context.Context) (jobRecord, error) {
	now := service.now().UTC()
	leaseToken, err := platform.NewSecret()
	if err != nil {
		return jobRecord{}, err
	}
	var claimed jobRecord
	err = storage.WithTx(ctx, service.db, func(tx *sql.Tx) error {
		row := tx.QueryRowContext(ctx, selectJobSQL+`WHERE attempt_count<10 AND (
			status='QUEUED' OR (status='RUNNING' AND lease_until<=?)) ORDER BY requested_at,id LIMIT 1`, platform.Timestamp(now))
		record, err := scanJob(row)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNoPendingJob
		}
		if err != nil {
			return err
		}
		if err := authorizeScope(ctx, tx, record.GroupID, record.MembershipID, record.UserID, record.Scope); err != nil {
			if !errors.Is(err, domain.ErrForbidden) {
				return err
			}
			timestamp := platform.Timestamp(now)
			_, updateErr := tx.ExecContext(ctx, `UPDATE export_jobs SET status='CANCELLED',completed_at=?,lease_token=NULL,
				lease_until=NULL,error_code=NULL,updated_at=? WHERE id=?`, timestamp, timestamp, record.ID)
			if updateErr != nil {
				return updateErr
			}
			record.Status = StatusCancelled
			record.CompletedAt = timestamp
			claimed = record
			return audit.Record(ctx, tx, record.GroupID, record.UserID, record.MembershipID,
				"DATA_EXPORT_CANCELLED", "EXPORT_JOB", record.ID, map[string]any{"reason": "authorization_revoked", "scope": record.Scope})
		}
		startedAt := record.StartedAt
		if startedAt == "" {
			startedAt = platform.Timestamp(now)
		}
		leaseUntil := platform.Timestamp(now.Add(service.leaseDuration))
		result, err := tx.ExecContext(ctx, `UPDATE export_jobs SET status='RUNNING',started_at=?,lease_token=?,lease_until=?,
			attempt_count=attempt_count+1,error_code=NULL,updated_at=? WHERE id=? AND (
			status='QUEUED' OR (status='RUNNING' AND lease_until<=?))`, startedAt, leaseToken, leaseUntil,
			platform.Timestamp(now), record.ID, platform.Timestamp(now))
		if err != nil {
			return fmt.Errorf("claim export job: %w", err)
		}
		changed, err := result.RowsAffected()
		if err != nil || changed != 1 {
			return ErrNoPendingJob
		}
		record.Status = StatusRunning
		record.StartedAt = startedAt
		record.LeaseToken = leaseToken
		record.LeaseUntil = leaseUntil
		record.AttemptCount++
		claimed = record
		return nil
	})
	return claimed, err
}

func (service *Service) updateProgress(ctx context.Context, record jobRecord, completed int) error {
	if completed < 0 || record.Progress == nil || completed > record.Progress.Total {
		return errors.New("invalid export progress update")
	}
	now := service.now().UTC()
	result, err := service.db.ExecContext(ctx, `UPDATE export_jobs SET progress_completed=?,lease_until=?,updated_at=?
		WHERE id=? AND status='RUNNING' AND lease_token=?`, completed, platform.Timestamp(now.Add(service.leaseDuration)),
		platform.Timestamp(now), record.ID, record.LeaseToken)
	if err != nil {
		return fmt.Errorf("update export progress: %w", err)
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("read export progress update: %w", err)
	}
	if changed != 1 {
		return domain.ErrConflict
	}
	return nil
}

func (service *Service) failExhaustedAttempt(ctx context.Context) (jobRecord, bool, error) {
	now := service.now().UTC()
	var exhausted jobRecord
	found := false
	err := storage.WithTx(ctx, service.db, func(tx *sql.Tx) error {
		record, err := scanJob(tx.QueryRowContext(ctx, selectJobSQL+`
			WHERE status='RUNNING' AND attempt_count>=10 AND lease_until<=? ORDER BY requested_at,id LIMIT 1`, platform.Timestamp(now)))
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		timestamp := platform.Timestamp(now)
		result, err := tx.ExecContext(ctx, `UPDATE export_jobs SET status='FAILED',completed_at=?,error_code='attempts_exhausted',
			lease_token=NULL,lease_until=NULL,artifact_name=NULL,updated_at=?
			WHERE id=? AND status='RUNNING' AND lease_token=? AND attempt_count>=10`, timestamp, timestamp, record.ID, record.LeaseToken)
		if err != nil {
			return fmt.Errorf("fail exhausted export job: %w", err)
		}
		changed, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if changed != 1 {
			return nil
		}
		record.Status = StatusFailed
		record.CompletedAt = timestamp
		record.ErrorCode = "attempts_exhausted"
		record.LeaseToken = ""
		record.LeaseUntil = ""
		exhausted, found = record, true
		return audit.Record(ctx, tx, record.GroupID, record.UserID, record.MembershipID,
			"DATA_EXPORT_FAILED", "EXPORT_JOB", record.ID, map[string]any{"scope": record.Scope, "errorCode": record.ErrorCode})
	})
	return exhausted, found, err
}

func (service *Service) completeClaim(ctx context.Context, record jobRecord) (jobRecord, error) {
	now := service.now().UTC()
	err := storage.WithTx(ctx, service.db, func(tx *sql.Tx) error {
		if err := authorizeScope(ctx, tx, record.GroupID, record.MembershipID, record.UserID, record.Scope); err != nil {
			if !errors.Is(err, domain.ErrForbidden) {
				return err
			}
			result, updateErr := tx.ExecContext(ctx, `UPDATE export_jobs SET status='CANCELLED',completed_at=?,lease_token=NULL,
				lease_until=NULL,artifact_name=NULL,updated_at=? WHERE id=? AND status='RUNNING' AND lease_token=?`,
				platform.Timestamp(now), platform.Timestamp(now), record.ID, record.LeaseToken)
			if updateErr != nil {
				return updateErr
			}
			changed, updateErr := result.RowsAffected()
			if updateErr != nil {
				return updateErr
			}
			if changed != 1 {
				current, loadErr := getRecordQuery(ctx, tx, record.UserID, record.ID)
				if loadErr != nil {
					return loadErr
				}
				record = current
				return nil
			}
			record.Status = StatusCancelled
			record.CompletedAt = platform.Timestamp(now)
			return audit.Record(ctx, tx, record.GroupID, record.UserID, record.MembershipID,
				"DATA_EXPORT_CANCELLED", "EXPORT_JOB", record.ID, map[string]any{"reason": "authorization_revoked", "scope": record.Scope})
		}
		expires := now.Add(service.retention)
		result, err := tx.ExecContext(ctx, `UPDATE export_jobs SET status='READY',progress_completed=progress_total,
			completed_at=?,expires_at=?,size_bytes=?,sha256=?,artifact_name=?,lease_token=NULL,lease_until=NULL,
			error_code=NULL,updated_at=? WHERE id=? AND status='RUNNING' AND lease_token=?`, platform.Timestamp(now),
			platform.Timestamp(expires), record.SizeBytes, record.SHA256, record.ArtifactName, platform.Timestamp(now),
			record.ID, record.LeaseToken)
		if err != nil {
			return fmt.Errorf("complete export job: %w", err)
		}
		changed, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if changed != 1 {
			current, loadErr := getRecordQuery(ctx, tx, record.UserID, record.ID)
			if loadErr != nil {
				return loadErr
			}
			record = current
			return nil
		}
		record.Status = StatusReady
		record.CompletedAt = platform.Timestamp(now)
		record.ExpiresAt = platform.Timestamp(expires)
		record.Job.SizeBytes = fmt.Sprintf("%d", record.SizeBytes)
		record.Progress = &Progress{Completed: record.Progress.Total, Total: record.Progress.Total}
		return audit.Record(ctx, tx, record.GroupID, record.UserID, record.MembershipID,
			"DATA_EXPORT_READY", "EXPORT_JOB", record.ID, map[string]any{"scope": record.Scope, "sizeBytes": record.SizeBytes, "sha256": record.SHA256})
	})
	return record, err
}

func (service *Service) failClaim(ctx context.Context, record jobRecord, code string, cause error) (Job, error) {
	if ctx.Err() != nil {
		return Job{}, ctx.Err()
	}
	now := service.now().UTC()
	err := storage.WithTx(ctx, service.db, func(tx *sql.Tx) error {
		result, err := tx.ExecContext(ctx, `UPDATE export_jobs SET status='FAILED',completed_at=?,error_code=?,
			lease_token=NULL,lease_until=NULL,artifact_name=NULL,updated_at=?
			WHERE id=? AND status='RUNNING' AND lease_token=?`, platform.Timestamp(now), code,
			platform.Timestamp(now), record.ID, record.LeaseToken)
		if err != nil {
			return fmt.Errorf("fail export job: %w", err)
		}
		changed, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if changed != 1 {
			current, loadErr := getRecordQuery(ctx, tx, record.UserID, record.ID)
			if loadErr != nil {
				return loadErr
			}
			record = current
			return nil
		}
		record.Status = StatusFailed
		record.CompletedAt = platform.Timestamp(now)
		record.ErrorCode = code
		return audit.Record(ctx, tx, record.GroupID, record.UserID, record.MembershipID,
			"DATA_EXPORT_FAILED", "EXPORT_JOB", record.ID, map[string]any{"scope": record.Scope, "errorCode": code})
	})
	if err != nil {
		return Job{}, errors.Join(cause, err)
	}
	if record.Status != StatusFailed {
		return record.Job, nil
	}
	if listenerErr := service.notifyCompletion(ctx, record); listenerErr != nil {
		return record.Job, errors.Join(cause, listenerErr)
	}
	return record.Job, cause
}

func (service *Service) notifyCompletion(ctx context.Context, record jobRecord) error {
	if service.completionListener == nil {
		return nil
	}
	if err := service.completionListener.ExportCompleted(ctx, completionFrom(record)); err != nil {
		return fmt.Errorf("notify export completion: %w", err)
	}
	_, err := service.db.ExecContext(ctx, `UPDATE export_jobs SET completion_notified_at=?,updated_at=?
		WHERE id=? AND status=? AND completion_notified_at IS NULL`, platform.Timestamp(service.now()),
		platform.Timestamp(service.now()), record.ID, record.Status)
	if err != nil {
		return fmt.Errorf("acknowledge export completion callback: %w", err)
	}
	return nil
}

func completionFrom(record jobRecord) Completion {
	return Completion{JobID: record.ID, GroupID: record.GroupID, MembershipID: record.MembershipID,
		UserID: record.UserID, Scope: record.Scope, Status: record.Status, ErrorCode: record.ErrorCode}
}

func generationErrorCode(err error) string {
	switch {
	case errors.Is(err, ErrArtifactLimit):
		return "artifact_limit_exceeded"
	case errors.Is(err, context.DeadlineExceeded):
		return "generation_timeout"
	default:
		return "generation_failed"
	}
}

func hashArtifact(ctx context.Context, path string) (string, int64, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", 0, fmt.Errorf("open generated export artifact: %w", err)
	}
	defer file.Close()
	digest := sha256.New()
	buffer := make([]byte, 128<<10)
	var size int64
	for {
		if err := ctx.Err(); err != nil {
			return "", 0, err
		}
		read, readErr := file.Read(buffer)
		if read > 0 {
			written, writeErr := digest.Write(buffer[:read])
			size += int64(written)
			if writeErr != nil {
				return "", 0, fmt.Errorf("hash generated export artifact: %w", writeErr)
			}
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return "", 0, fmt.Errorf("read generated export artifact: %w", readErr)
		}
	}
	return hex.EncodeToString(digest.Sum(nil)), size, nil
}

func (service *Service) retainedArtifactNames(ctx context.Context) (map[string]struct{}, error) {
	rows, err := service.db.QueryContext(ctx, `SELECT artifact_name FROM export_jobs WHERE status='READY' AND artifact_name IS NOT NULL`)
	if err != nil {
		return nil, fmt.Errorf("list retained export artifact names: %w", err)
	}
	defer rows.Close()
	retained := make(map[string]struct{})
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		retained[name] = struct{}{}
	}
	return retained, rows.Err()
}
