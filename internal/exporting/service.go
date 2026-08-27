package exporting

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/DasLukas/TeamTaler/internal/audit"
	"github.com/DasLukas/TeamTaler/internal/auth"
	"github.com/DasLukas/TeamTaler/internal/authorization"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/idempotency"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

const passwordVerificationFallbackHash = "$argon2id$v=19$m=65536,t=3,p=2$MDEyMzQ1Njc4OWFiY2RlZg$6UTqN+/Dfj2p9NJKYY8hPYP1es6mmNcBWTRdWDaFueM"

// Options configures bounded archive generation and lifecycle behavior.
type Options struct {
	Retention          time.Duration
	LeaseDuration      time.Duration
	GenerationTimeout  time.Duration
	MaxArtifactBytes   int64
	HourlyStarts       int
	PasswordVerifier   PasswordVerifier
	CompletionListener CompletionListener
}

// Service owns raw-data export authorization, durable jobs, and artifact access.
type Service struct {
	db                 *sql.DB
	artifacts          ArtifactStore
	retention          time.Duration
	leaseDuration      time.Duration
	generationTimeout  time.Duration
	maxArtifactBytes   int64
	hourlyStarts       int
	passwordVerifier   PasswordVerifier
	completionListener CompletionListener
	now                func() time.Time
}

// NewService constructs a raw-data export service with secure bounded defaults.
// db and artifacts are required. Zero option values select package defaults.
// It returns a configuration error without mutating external state.
func NewService(db *sql.DB, artifacts ArtifactStore, options Options) (*Service, error) {
	if db == nil {
		return nil, errors.New("export service requires a database")
	}
	if artifacts == nil {
		return nil, errors.New("export service requires an artifact store")
	}
	if options.Retention <= 0 {
		options.Retention = DefaultRetention
	}
	if options.LeaseDuration <= 0 {
		options.LeaseDuration = DefaultLeaseDuration
	}
	if options.GenerationTimeout <= 0 {
		options.GenerationTimeout = DefaultGenerationTimeout
	}
	if options.LeaseDuration <= options.GenerationTimeout {
		options.LeaseDuration = options.GenerationTimeout + time.Minute
	}
	if options.MaxArtifactBytes <= 0 {
		options.MaxArtifactBytes = DefaultMaxArtifactBytes
	}
	if options.HourlyStarts <= 0 {
		options.HourlyStarts = DefaultHourlyStarts
	}
	if options.PasswordVerifier == nil {
		options.PasswordVerifier = SQLPasswordVerifier{DB: db}
	}
	return &Service{
		db: db, artifacts: artifacts, retention: options.Retention,
		leaseDuration: options.LeaseDuration, generationTimeout: options.GenerationTimeout,
		maxArtifactBytes: options.MaxArtifactBytes, hourlyStarts: options.HourlyStarts,
		passwordVerifier: options.PasswordVerifier, completionListener: options.CompletionListener,
		now: platform.Now,
	}, nil
}

// SQLPasswordVerifier reauthenticates an active password-backed TeamTaler account.
type SQLPasswordVerifier struct {
	DB *sql.DB
}

// VerifyCurrentPassword performs one constant-work Argon2id comparison and returns
// ErrUnauthenticated for missing, inactive, managed, malformed, or mismatched accounts.
func (verifier SQLPasswordVerifier) VerifyCurrentPassword(ctx context.Context, userID, password string) error {
	if verifier.DB == nil || strings.TrimSpace(userID) == "" || len(password) < 1 || len(password) > 1024 {
		auth.VerifyPassword(passwordVerificationFallbackHash, password)
		return domain.ErrUnauthenticated
	}
	var encoded string
	err := verifier.DB.QueryRowContext(ctx, `SELECT password_hash FROM users
		WHERE id=? AND active=1 AND email IS NOT NULL AND password_hash IS NOT NULL`, userID).Scan(&encoded)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("read current export credential: %w", err)
	}
	if errors.Is(err, sql.ErrNoRows) {
		encoded = passwordVerificationFallbackHash
	}
	if !auth.VerifyPassword(encoded, password) || errors.Is(err, sql.ErrNoRows) {
		return domain.ErrUnauthenticated
	}
	return nil
}

// Create reauthenticates input.UserID, authorizes the requested scope, and queues
// an idempotent background job. The password is verified before the write transaction
// and is neither stored nor included in the request fingerprint.
func (service *Service) Create(ctx context.Context, input CreateInput) (Job, error) {
	input.GroupID = strings.TrimSpace(input.GroupID)
	input.MembershipID = strings.TrimSpace(input.MembershipID)
	input.UserID = strings.TrimSpace(input.UserID)
	input.IdempotencyKey = strings.TrimSpace(input.IdempotencyKey)
	if input.GroupID == "" {
		return Job{}, domain.ValidationError{Field: "groupId", Message: "is required"}
	}
	if input.MembershipID == "" {
		return Job{}, domain.ValidationError{Field: "membershipId", Message: "is required"}
	}
	if input.UserID == "" {
		return Job{}, domain.ErrUnauthenticated
	}
	if !input.Scope.Valid() {
		return Job{}, domain.ValidationError{Field: "scope", Message: "must be GROUP or PERSONAL"}
	}
	if err := idempotency.ValidateKey(input.IdempotencyKey); err != nil {
		return Job{}, err
	}
	if err := service.passwordVerifier.VerifyCurrentPassword(ctx, input.UserID, input.CurrentPassword); err != nil {
		return Job{}, err
	}
	fingerprintBytes := sha256.Sum256([]byte("raw-export:v1\n" + input.GroupID + "\n" + input.UserID + "\n" + string(input.Scope)))
	fingerprint := hex.EncodeToString(fingerprintBytes[:])
	now := service.now().UTC()
	jobID, err := platform.NewID("exp")
	if err != nil {
		return Job{}, err
	}
	var result Job
	err = storage.WithTx(ctx, service.db, func(tx *sql.Tx) error {
		if err := authorizeScope(ctx, tx, input.GroupID, input.MembershipID, input.UserID, input.Scope); err != nil {
			return err
		}
		existing, existingHash, found, err := loadIdempotentJob(ctx, tx, input.GroupID, input.UserID, input.Scope, input.IdempotencyKey)
		if err != nil {
			return err
		}
		if found {
			if existingHash != fingerprint {
				return domain.ErrIdempotencyReuse
			}
			result = existing
			return nil
		}
		var active int
		if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM export_jobs
			WHERE group_id=? AND requested_by_user_id=? AND scope=? AND status IN ('QUEUED','RUNNING')`,
			input.GroupID, input.UserID, input.Scope).Scan(&active); err != nil {
			return fmt.Errorf("check active export job: %w", err)
		}
		if active != 0 {
			return domain.ErrConflict
		}
		var starts int
		if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM export_jobs
			WHERE requested_by_user_id=? AND scope=? AND requested_at>=?`, input.UserID, input.Scope,
			platform.Timestamp(now.Add(-time.Hour))).Scan(&starts); err != nil {
			return fmt.Errorf("count recent export starts: %w", err)
		}
		if starts >= service.hourlyStarts {
			return domain.ErrRateLimited
		}
		total := len(datasetsFor(input.Scope))
		timestamp := platform.Timestamp(now)
		_, err = tx.ExecContext(ctx, `INSERT INTO export_jobs(
			id,scope,group_id,requested_by_user_id,requested_by_membership_id,status,
			progress_completed,progress_total,idempotency_key,request_hash,requested_at,updated_at
		) VALUES(?,?,?,?,?,'QUEUED',0,?,?,?,?,?)`, jobID, input.Scope, input.GroupID, input.UserID,
			input.MembershipID, total, input.IdempotencyKey, fingerprint, timestamp, timestamp)
		if err != nil {
			if strings.Contains(strings.ToLower(err.Error()), "unique") {
				return domain.ErrConflict
			}
			return fmt.Errorf("queue export job: %w", err)
		}
		if err := audit.Record(ctx, tx, input.GroupID, input.UserID, input.MembershipID,
			"DATA_EXPORT_REQUESTED", "EXPORT_JOB", jobID, map[string]any{"scope": input.Scope}); err != nil {
			return err
		}
		result = Job{ID: jobID, Scope: input.Scope, Status: StatusQueued, RequestedAt: timestamp,
			Progress: &Progress{Completed: 0, Total: total}}
		return nil
	})
	return result, err
}

// List returns newest-first jobs owned by userID in groupID. It never exposes jobs
// requested by another actor, including to group administrators.
func (service *Service) List(ctx context.Context, userID, groupID string, limit int) ([]Job, error) {
	userID, groupID = strings.TrimSpace(userID), strings.TrimSpace(groupID)
	if userID == "" {
		return nil, domain.ErrUnauthenticated
	}
	if groupID == "" {
		return nil, domain.ValidationError{Field: "groupId", Message: "is required"}
	}
	if limit < 1 || limit > 100 {
		limit = 50
	}
	rows, err := service.db.QueryContext(ctx, selectJobSQL+`
		WHERE requested_by_user_id=? AND group_id=? ORDER BY requested_at DESC,id DESC LIMIT ?`, userID, groupID, limit)
	if err != nil {
		return nil, fmt.Errorf("list export jobs: %w", err)
	}
	defer rows.Close()
	jobs := make([]Job, 0)
	for rows.Next() {
		record, err := scanJob(rows)
		if err != nil {
			return nil, err
		}
		jobs = append(jobs, record.Job)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate export jobs: %w", err)
	}
	return jobs, nil
}

// Get returns one actor-owned job or ErrNotFound without revealing cross-actor jobs.
func (service *Service) Get(ctx context.Context, userID, jobID string) (Job, error) {
	record, err := service.getRecord(ctx, userID, jobID)
	return record.Job, err
}

// OpenDownload rechecks current scope authorization, records the download start,
// and opens a complete READY archive. The caller must close Download.Reader.
func (service *Service) OpenDownload(ctx context.Context, userID, jobID string) (Download, error) {
	userID, jobID = strings.TrimSpace(userID), strings.TrimSpace(jobID)
	var record jobRecord
	err := storage.WithTx(ctx, service.db, func(tx *sql.Tx) error {
		loaded, err := getRecordQuery(ctx, tx, userID, jobID)
		if err != nil {
			return err
		}
		record = loaded
		if err := authorizeScope(ctx, tx, record.GroupID, record.MembershipID, userID, record.Scope); err != nil {
			return err
		}
		if record.Status != StatusReady || record.ArtifactName == "" {
			return domain.ErrPrecondition
		}
		expires, err := time.Parse(time.RFC3339Nano, record.ExpiresAt)
		if err != nil || !expires.After(service.now()) {
			return domain.ErrPrecondition
		}
		return audit.Record(ctx, tx, record.GroupID, userID, record.MembershipID,
			"DATA_EXPORT_DOWNLOAD_STARTED", "EXPORT_JOB", record.ID, map[string]any{"scope": record.Scope})
	})
	if err != nil {
		return Download{}, err
	}
	file, err := service.artifacts.Open(record.ArtifactName)
	if err != nil {
		return Download{}, err
	}
	info, err := file.Stat()
	if err != nil {
		file.Close()
		return Download{}, fmt.Errorf("stat export artifact: %w", err)
	}
	if info.Size() != record.SizeBytes {
		file.Close()
		return Download{}, ErrArtifactUnavailable
	}
	return Download{Reader: file, SizeBytes: record.SizeBytes, SHA256: record.SHA256,
		Filename: "teamtaler-" + strings.ToLower(string(record.Scope)) + "-export.zip", LastModified: info.ModTime()}, nil
}

// Remove cancels one actor-owned active job or permanently deletes a terminal
// job and its published artifact. Artifact deletion completes before the
// terminal database record is removed so a failed filesystem operation remains
// visible and retryable.
func (service *Service) Remove(ctx context.Context, userID, jobID string) error {
	userID, jobID = strings.TrimSpace(userID), strings.TrimSpace(jobID)
	return storage.WithTx(ctx, service.db, func(tx *sql.Tx) error {
		record, err := getRecordQuery(ctx, tx, userID, jobID)
		if err != nil {
			return err
		}
		if err := authorizeScope(ctx, tx, record.GroupID, record.MembershipID, userID, record.Scope); err != nil {
			return err
		}
		if record.Status.Terminal() {
			if record.ArtifactName != "" {
				if err := service.artifacts.Remove(record.ArtifactName); err != nil {
					return fmt.Errorf("remove export artifact: %w", err)
				}
			}
			if err := audit.Record(ctx, tx, record.GroupID, userID, record.MembershipID,
				"DATA_EXPORT_DELETED", "EXPORT_JOB", record.ID, map[string]any{"scope": record.Scope}); err != nil {
				return err
			}
			result, err := tx.ExecContext(ctx, `DELETE FROM export_jobs WHERE id=? AND requested_by_user_id=?`, jobID, userID)
			if err != nil {
				return fmt.Errorf("delete export job: %w", err)
			}
			affected, err := result.RowsAffected()
			if err != nil {
				return fmt.Errorf("read deleted export job count: %w", err)
			}
			if affected != 1 {
				return fmt.Errorf("delete export job: affected=%d", affected)
			}
			return nil
		}
		now := platform.Timestamp(service.now())
		_, err = tx.ExecContext(ctx, `UPDATE export_jobs SET status='CANCELLED',completed_at=coalesce(completed_at,?),
			lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=?`, now, now, jobID)
		if err != nil {
			return fmt.Errorf("cancel export job: %w", err)
		}
		return audit.Record(ctx, tx, record.GroupID, userID, record.MembershipID,
			"DATA_EXPORT_CANCELLED", "EXPORT_JOB", record.ID, map[string]any{"scope": record.Scope})
	})
}

func authorizeScope(ctx context.Context, queryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}, groupID, membershipID, userID string, scope Scope) error {
	var exists int
	err := queryer.QueryRowContext(ctx, `SELECT count(*) FROM memberships membership
		JOIN groups tenant ON tenant.id=membership.group_id AND tenant.status='ACTIVE'
		JOIN users actor ON actor.id=membership.user_id AND actor.active=1
		WHERE membership.group_id=? AND membership.id=? AND membership.user_id=? AND membership.status='ACTIVE'`,
		groupID, membershipID, userID).Scan(&exists)
	if err != nil {
		return fmt.Errorf("authorize export membership: %w", err)
	}
	if exists != 1 {
		return domain.ErrForbidden
	}
	if scope == ScopeGroup {
		return authorization.Require(ctx, queryer, groupID, membershipID,
			domain.PermissionGroupAdministration, authorization.GroupResource(groupID))
	}
	return nil
}

const jobColumns = `id,scope,status,requested_at,coalesce(started_at,''),coalesce(completed_at,''),
	coalesce(expires_at,''),coalesce(size_bytes,0),coalesce(sha256,''),progress_completed,progress_total,
	coalesce(error_code,''),group_id,requested_by_user_id,requested_by_membership_id,
	coalesce(artifact_name,''),coalesce(lease_token,''),coalesce(lease_until,''),attempt_count`

const selectJobSQL = `SELECT ` + jobColumns + ` FROM export_jobs `

type rowScanner interface{ Scan(...any) error }

type jobRecord struct {
	Job
	GroupID, UserID, MembershipID        string
	ArtifactName, LeaseToken, LeaseUntil string
	SizeBytes                            int64
	AttemptCount                         int
}

func scanJob(scanner rowScanner) (jobRecord, error) { return scanJobWithProgress(scanner) }

func scanJobWithProgress(scanner rowScanner) (jobRecord, error) {
	var record jobRecord
	var size int64
	var completed, total int
	err := scanner.Scan(&record.ID, &record.Scope, &record.Status, &record.RequestedAt, &record.StartedAt,
		&record.CompletedAt, &record.ExpiresAt, &size, &record.SHA256, &completed, &total, &record.ErrorCode,
		&record.GroupID, &record.UserID, &record.MembershipID, &record.ArtifactName, &record.LeaseToken,
		&record.LeaseUntil, &record.AttemptCount)
	if err != nil {
		return jobRecord{}, fmt.Errorf("scan export job: %w", err)
	}
	record.SizeBytes = size
	if size > 0 {
		record.Job.SizeBytes = strconv.FormatInt(size, 10)
	}
	record.Progress = &Progress{Completed: completed, Total: total}
	return record, nil
}

func (service *Service) getRecord(ctx context.Context, userID, jobID string) (jobRecord, error) {
	return getRecordQuery(ctx, service.db, strings.TrimSpace(userID), strings.TrimSpace(jobID))
}

func getRecordQuery(ctx context.Context, queryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, userID, jobID string) (jobRecord, error) {
	if userID == "" {
		return jobRecord{}, domain.ErrUnauthenticated
	}
	record, err := scanJobWithProgress(queryer.QueryRowContext(ctx, selectJobSQL+`WHERE id=? AND requested_by_user_id=?`, jobID, userID))
	if errors.Is(err, sql.ErrNoRows) {
		return jobRecord{}, domain.ErrNotFound
	}
	return record, err
}

func loadIdempotentJob(ctx context.Context, tx *sql.Tx, groupID, userID string, scope Scope, key string) (Job, string, bool, error) {
	row := tx.QueryRowContext(ctx, `SELECT `+jobColumns+`,request_hash FROM export_jobs
		WHERE group_id=? AND requested_by_user_id=? AND scope=? AND idempotency_key=?`, groupID, userID, scope, key)
	var record jobRecord
	var size int64
	var completed, total int
	var hash string
	err := row.Scan(&record.ID, &record.Scope, &record.Status, &record.RequestedAt, &record.StartedAt,
		&record.CompletedAt, &record.ExpiresAt, &size, &record.SHA256, &completed, &total, &record.ErrorCode,
		&record.GroupID, &record.UserID, &record.MembershipID, &record.ArtifactName, &record.LeaseToken,
		&record.LeaseUntil, &record.AttemptCount, &hash)
	if errors.Is(err, sql.ErrNoRows) {
		return Job{}, "", false, nil
	}
	if err != nil {
		return Job{}, "", false, fmt.Errorf("load idempotent export job: %w", err)
	}
	record.SizeBytes = size
	if size > 0 {
		record.Job.SizeBytes = strconv.FormatInt(size, 10)
	}
	record.Progress = &Progress{Completed: completed, Total: total}
	return record.Job, hash, true, nil
}
